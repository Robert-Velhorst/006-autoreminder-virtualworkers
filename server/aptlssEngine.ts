/**
 * APTLSS Operational Engine
 *
 * Three deterministic engines that run on real card data:
 *   1. Card State Machine   — classifies each card into one of 14 states
 *   2. Priority Scoring     — calculates a 0–100 score with component breakdown
 *   3. Trello Checklist Writer — creates/updates the APTLSS Execution Checklist
 *
 * These engines are called from:
 *   - aptlss.generate tRPC procedure (on-demand)
 *   - /api/scheduled/aptlss-maintenance (daily silent job)
 *   - Trello webhook handler (on card move / checkItem update)
 */

import {
  upsertCardState,
  upsertPriorityScore,
  getOpenStepsForCard,
  getManualStepsForCard,
  countDependentCards,
} from "./aptlssStepsDb";
import { InsertCardState, InsertPriorityScore } from "../drizzle/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CardStateValue =
  | "NEW_UNTRIAGED"
  | "READY_TO_START"
  | "IN_PROGRESS"
  | "WAITING_FOR_WORKER"
  | "WAITING_FOR_ROBERT"
  | "WAITING_FOR_EXTERNAL_PARTY"
  | "BLOCKED_BY_OTHER_CARD"
  | "STALLED"
  | "OVERDUE"
  | "READY_FOR_REVIEW"
  | "READY_FOR_DONE"
  | "DONE_CONFIRMED"
  | "NEEDS_RESTRUCTURING"
  | "NEEDS_ARCHIVE";

export type PriorityTier = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "BLOCKED";

export interface TrelloCardContext {
  id: string;
  name: string;
  desc: string;
  url: string;
  shortUrl: string;
  due: string | null;
  dueComplete: boolean;
  labels: { name: string; color: string }[];
  listName: string;
  boardName: string;
  checklists: {
    id: string;
    name: string;
    checkItems: { id: string; name: string; state: "complete" | "incomplete" }[];
  }[];
  comments: { text: string; date: string; memberName: string }[];
  attachments: { name: string; url: string }[];
  /** Card members / assignees */
  members?: { username: string; fullName: string }[];
  /** Unix ms of last activity (card move, comment, checklist change) */
  lastActivityMs: number;
}

export interface AptlssStepInput {
  stepNumber: number;
  title: string;
  estimatedMinutes: number;
  category: string;
  requiresRobert: boolean;
  blockedBy?: string;
  dependsOnCards?: string[];
  completionCriteria?: string;
  riskIfSkipped?: string;
  recommendedDecision?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysSince(ms: number): number {
  return Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
}

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  return new Date(due).getTime() < Date.now();
}

function hasUnansweredQuestion(
  comments: TrelloCardContext["comments"]
): boolean {
  if (comments.length === 0) return false;
  const sorted = [...comments].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const latest = sorted[0];
  // If the latest comment ends with a question mark and is from the worker
  return (
    latest.text.trim().endsWith("?") &&
    (latest.memberName.toLowerCase().includes("the worker") ||
      latest.memberName.toLowerCase().includes("assistant"))
  );
}

function getChecklistProgress(ctx: TrelloCardContext): {
  total: number;
  completed: number;
  ratio: number;
} {
  const aptlssChecklist = ctx.checklists.find((c) =>
    c.name.toLowerCase().includes("aptlss")
  );
  if (!aptlssChecklist) return { total: 0, completed: 0, ratio: 0 };
  const total = aptlssChecklist.checkItems.length;
  const completed = aptlssChecklist.checkItems.filter(
    (i) => i.state === "complete"
  ).length;
  return { total, completed, ratio: total > 0 ? completed / total : 0 };
}

function hasRobertOpenStep(steps: Awaited<ReturnType<typeof getOpenStepsForCard>>): boolean {
  return steps.some((s) => s.requiresRobert && s.status === "open");
}

function hasExternalWaitingStep(steps: Awaited<ReturnType<typeof getOpenStepsForCard>>): boolean {
  return steps.some(
    (s) => s.category === "external_follow_up" && s.status === "open"
  );
}

function hasBlockedStep(steps: Awaited<ReturnType<typeof getOpenStepsForCard>>): boolean {
  return steps.some((s) => !!s.blockedBy && s.status === "open");
}

// ─── 1. Card State Machine ────────────────────────────────────────────────────

/**
 * Deterministically classify a card into one of 14 states.
 * Rules are evaluated in priority order — first match wins.
 */
export async function computeCardState(
  vaId: number,
  ctx: TrelloCardContext
): Promise<{ state: CardStateValue; reason: string }> {
  const steps = await getOpenStepsForCard(vaId, ctx.id);
  const { total, completed, ratio } = getChecklistProgress(ctx);
  const staleDays = daysSince(ctx.lastActivityMs);
  const overdue = isOverdue(ctx.due);
  const unansweredQ = hasUnansweredQuestion(ctx.comments);
  const inDoneList =
    ctx.listName.toLowerCase().includes("done") ||
    ctx.listName.toLowerCase().includes("complete") ||
    ctx.listName.toLowerCase().includes("archive");

  if (inDoneList && ctx.dueComplete) {
    return { state: "DONE_CONFIRMED", reason: "Card is in Done list and marked complete." };
  }

  if (inDoneList && !ctx.dueComplete) {
    return {
      state: "NEEDS_ARCHIVE",
      reason: "Card is in Done list but not marked complete — verify and archive.",
    };
  }

  if (total > 0 && ratio === 1 && !inDoneList) {
    return {
      state: "READY_FOR_DONE",
      reason: "All APTLSS checklist items are complete. Ready to move to Done.",
    };
  }

  if (hasRobertOpenStep(steps)) {
    return {
      state: "WAITING_FOR_ROBERT",
      reason: "One or more open steps require a Robert decision.",
    };
  }

  if (hasBlockedStep(steps)) {
    return {
      state: "BLOCKED_BY_OTHER_CARD",
      reason: "One or more open steps are blocked by another card.",
    };
  }

  if (hasExternalWaitingStep(steps)) {
    return {
      state: "WAITING_FOR_EXTERNAL_PARTY",
      reason: "One or more steps are waiting for an external party reply.",
    };
  }

  if (overdue) {
    return {
      state: "OVERDUE",
      reason: `Card is past its due date (${ctx.due}).`,
    };
  }

  if (staleDays >= 5 && completed > 0 && ratio < 1) {
    return {
      state: "STALLED",
      reason: `No checklist progress in ${staleDays} days despite having open items.`,
    };
  }

  if (unansweredQ) {
    return {
      state: "WAITING_FOR_WORKER",
      reason: "Latest comment contains an unanswered question from the worker.",
    };
  }

  // ── Enhanced NEEDS_RESTRUCTURING detection ────────────────────────────────
  // 1. Classic: no description, no checklist, no comments
  if (total === 0 && !ctx.desc && ctx.comments.length === 0) {
    return {
      state: "NEEDS_RESTRUCTURING",
      reason: "Card has no description, no checklist, and no comments — too vague to work on.",
    };
  }
  // 2. Too large: more than 15 checklist items across all checklists
  const allCheckItems = ctx.checklists.flatMap((cl) => cl.checkItems);
  if (allCheckItems.length > 15) {
    return {
      state: "NEEDS_RESTRUCTURING",
      reason: `Card has ${allCheckItems.length} checklist items — too large to manage. Split into smaller cards (max 15 items each).`,
    };
  }
  // 3. Missing due date on a non-trivial card (has checklist but no due date)
  if (total > 0 && !ctx.due) {
    return {
      state: "NEEDS_RESTRUCTURING",
      reason: "Card has a checklist but no due date. Add a due date so it can be prioritised correctly.",
    };
  }
  // 4. Missing owner: card has checklist items but no assigned member
  if (total > 0 && (!ctx.members || ctx.members.length === 0)) {
    return {
      state: "NEEDS_RESTRUCTURING",
      reason: "Card has a checklist but no assigned member. Assign a member so ownership is clear.",
    };
  }

  if (total === 0) {
    return {
      state: "NEW_UNTRIAGED",
      reason: "Card has no APTLSS checklist yet. Generate a plan to start.",
    };
  }

  if (
    ctx.listName.toLowerCase().includes("to do") ||
    ctx.listName.toLowerCase().includes("todo") ||
    ctx.listName.toLowerCase().includes("backlog")
  ) {
    return {
      state: "READY_TO_START",
      reason: "Card is in the To-Do list with a checklist ready.",
    };
  }

  if (completed > 0 && ratio < 1) {
    return {
      state: "IN_PROGRESS",
      reason: `${completed}/${total} checklist items complete. Actively in progress.`,
    };
  }

  return {
    state: "READY_TO_START",
    reason: "Card has a checklist and is ready to start.",
  };
}

/** Compute and persist card state to DB. */
export async function computeAndSaveCardState(
  vaId: number,
  ctx: TrelloCardContext
): Promise<CardStateValue> {
  const { state, reason } = await computeCardState(vaId, ctx);
  const { total, completed } = getChecklistProgress(ctx);
  const staleDays = daysSince(ctx.lastActivityMs);

  const row: InsertCardState = {
    vaId,
    cardId: ctx.id,
    cardName: ctx.name,
    boardName: ctx.boardName,
    listName: ctx.listName,
    state,
    stateReason: reason,
    daysSinceProgress: staleDays,
    hasUnansweredQuestion: hasUnansweredQuestion(ctx.comments),
    isOverdue: isOverdue(ctx.due),
    checklistComplete: total > 0 && completed === total,
    hasFinalSummary:
      ctx.comments.length > 0 &&
      ctx.comments.some(
        (c) =>
          c.text.toLowerCase().includes("final summary") ||
          c.text.toLowerCase().includes("completed") ||
          c.text.toLowerCase().includes("done —") ||
          c.text.toLowerCase().includes("done -")
      ),
    calculatedAt: new Date(),
  };

  await upsertCardState(row);
  return state;
}

// ─── 2. Priority Scoring Engine ───────────────────────────────────────────────

interface ScoreBreakdown {
  dueDatePressure: number;
  overduePenalty: number;
  stalledPenalty: number;
  labelUrgency: number;
  dependencyImpact: number;
  estimatedEffort: number;
  riskIfIgnored: number;
  waitingDiscount: number;
}

function labelUrgencyScore(labels: TrelloCardContext["labels"]): number {
  let score = 0;
  for (const l of labels) {
    const n = l.name.toLowerCase();
    if (n.includes("critical") || n.includes("urgent") || n.includes("asap")) score += 25;
    else if (n.includes("high") || n.includes("important")) score += 15;
    else if (n.includes("medium") || n.includes("normal")) score += 5;
    else if (n.includes("low") || n.includes("minor")) score -= 5;
    // Financial/legal/client labels get extra weight
    if (
      n.includes("financial") ||
      n.includes("legal") ||
      n.includes("client") ||
      n.includes("payment") ||
      n.includes("invoice")
    )
      score += 10;
  }
  return Math.min(score, 30);
}

function dueDatePressureScore(due: string | null): number {
  if (!due) return 0;
  const daysUntilDue =
    (new Date(due).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysUntilDue < 0) return 0; // handled by overdue penalty
  if (daysUntilDue <= 1) return 30;
  if (daysUntilDue <= 3) return 22;
  if (daysUntilDue <= 7) return 14;
  if (daysUntilDue <= 14) return 7;
  return 2;
}

export async function computePriorityScore(
  vaId: number,
  ctx: TrelloCardContext,
  state: CardStateValue,
  openStepCount: number,
  estimatedRemainingMinutes: number,
  dependentCardCount: number = 0,
  riskScore: number = 0
): Promise<{ score: number; tier: PriorityTier; breakdown: ScoreBreakdown }> {
  const staleDays = daysSince(ctx.lastActivityMs);
  const overdue = isOverdue(ctx.due);

  const breakdown: ScoreBreakdown = {
    dueDatePressure: dueDatePressureScore(ctx.due),
    overduePenalty: overdue ? 25 : 0,
    stalledPenalty: staleDays >= 7 ? 10 : staleDays >= 5 ? 5 : 0,
    labelUrgency: labelUrgencyScore(ctx.labels),
    // dependencyImpact: how many other cards are blocked by this one × 3 (capped at 15)
    dependencyImpact: Math.min(dependentCardCount * 3, 15),
    estimatedEffort: Math.min(Math.floor(estimatedRemainingMinutes / 30) * 2, 10),
    // riskIfIgnored: derived from the highest-severity riskIfSkipped text across all open steps
    riskIfIgnored: Math.min(riskScore, 15),
    waitingDiscount:
      state === "WAITING_FOR_EXTERNAL_PARTY" ||
      state === "WAITING_FOR_ROBERT"
        ? -10
        : 0,
  };

  // Blocked cards get a heavy discount — don't schedule active work
  if (
    state === "BLOCKED_BY_OTHER_CARD" ||
    state === "DONE_CONFIRMED" ||
    state === "NEEDS_ARCHIVE"
  ) {
    return { score: 5, tier: "BLOCKED", breakdown };
  }

  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, raw));

  let tier: PriorityTier;
  if (score >= 80) tier = "CRITICAL";
  else if (score >= 60) tier = "HIGH";
  else if (score >= 35) tier = "MEDIUM";
  else tier = "LOW";

  return { score, tier, breakdown };
}

/** Convert a riskIfSkipped text string to a numeric severity score (0–15). */
function riskTextToScore(text: string | null | undefined): number {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (t.includes("critical") || t.includes("contract") || t.includes("legal") || t.includes("payment") || t.includes("lose client")) return 15;
  if (t.includes("high") || t.includes("deadline") || t.includes("blocked") || t.includes("escalat") || t.includes("urgent")) return 10;
  if (t.includes("medium") || t.includes("delay") || t.includes("miss") || t.includes("slow")) return 5;
  if (t.includes("low") || t.includes("minor") || t.includes("cosmetic")) return 2;
  return 3;
}

/** Compute and persist priority score to DB. */
export async function computeAndSavePriorityScore(
  vaId: number,
  ctx: TrelloCardContext,
  state: CardStateValue
): Promise<{ score: number; tier: PriorityTier }> {
  const steps = await getOpenStepsForCard(vaId, ctx.id);
  const openSteps = steps.filter((s) => s.status === "open");
  const completedSteps = steps.filter((s) => s.status === "complete");
  const estimatedRemainingMinutes = openSteps.reduce(
    (sum, s) => sum + (s.estimatedMinutes ?? 15),
    0
  );

  // dependencyImpact: count how many other cards depend on this one
  const dependentCardCount = await countDependentCards(vaId, ctx.id);

  // riskIfIgnored: take the highest riskIfSkipped score across all open steps
  const riskScore = openSteps.reduce((max, s) => {
    const score = riskTextToScore(s.riskIfSkipped);
    return score > max ? score : max;
  }, 0);

  const { score, tier, breakdown } = await computePriorityScore(
    vaId,
    ctx,
    state,
    openSteps.length,
    estimatedRemainingMinutes,
    dependentCardCount,
    riskScore
  );

  const row: InsertPriorityScore = {
    vaId,
    cardId: ctx.id,
    cardName: ctx.name,
    score,
    breakdown: JSON.stringify(breakdown),
    tier,
    estimatedRemainingMinutes,
    openSteps: openSteps.length,
    completedSteps: completedSteps.length,
    calculatedAt: new Date(),
  };

  await upsertPriorityScore(row);
  return { score, tier };
}

// ─── 3. Trello Checklist Writer ───────────────────────────────────────────────

const CHECKLIST_NAME = "APTLSS Execution Checklist";
const TRELLO_API = "https://api.trello.com/1";
const TRELLO_REQUEST_TIMEOUT_MS = 15_000;

function trelloHeaders() {
  return { "Content-Type": "application/json" };
}

function trelloAuth() {
  const key = process.env.TrelloAPIKey || process.env.TRELLO_API_KEY || '';
  const token = process.env.TrelloAPIToken || process.env.TRELLO_TOKEN || '';
  return `key=${key}&token=${token}`;
}

function trelloRequest(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS),
  });
}

/** Fetch the current APTLSS checklist for a card (null if none). */
async function getAptlssChecklist(
  cardId: string,
  checklists: TrelloCardContext["checklists"]
) {
  return (
    checklists.find((c) => c.name === CHECKLIST_NAME) ?? null
  );
}

/** Create a new APTLSS checklist on a card and add all steps. Returns checklist ID. */
async function createChecklist(
  cardId: string,
  steps: AptlssStepInput[]
): Promise<string> {
  const res = await trelloRequest(
    `${TRELLO_API}/checklists?${trelloAuth()}`,
    {
      method: "POST",
      headers: trelloHeaders(),
      body: JSON.stringify({ idCard: cardId, name: CHECKLIST_NAME }),
    }
  );
  if (!res.ok) throw new Error(`Trello createChecklist failed: ${res.status}`);
  const checklist = await res.json();

  for (const step of steps) {
    const itemResponse = await trelloRequest(
      `${TRELLO_API}/checklists/${checklist.id}/checkItems?${trelloAuth()}`,
      {
        method: "POST",
        headers: trelloHeaders(),
        body: JSON.stringify({ name: step.title }),
      }
    );
    if (!itemResponse.ok) {
      throw new Error(`Trello createChecklist item failed: ${itemResponse.status}`);
    }
  }

  return checklist.id;
}

/** Add a new check item to an existing checklist. Returns check item ID. */
async function addCheckItem(
  checklistId: string,
  title: string
): Promise<string> {
  const res = await trelloRequest(
    `${TRELLO_API}/checklists/${checklistId}/checkItems?${trelloAuth()}`,
    {
      method: "POST",
      headers: trelloHeaders(),
      body: JSON.stringify({ name: title }),
    }
  );
  if (!res.ok) throw new Error(`Trello addCheckItem failed: ${res.status}`);
  const item = await res.json();
  return item.id;
}

/** Delete a check item from a checklist. */
async function deleteCheckItem(
  cardId: string,
  checklistId: string,
  checkItemId: string
): Promise<void> {
  const res = await trelloRequest(
    `${TRELLO_API}/cards/${cardId}/checkItem/${checkItemId}?${trelloAuth()}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Trello deleteCheckItem failed: ${res.status}`);
}

/** Rename a check item (used to mark as [REPLACED]). */
async function renameCheckItem(
  cardId: string,
  checkItemId: string,
  newName: string
): Promise<void> {
  const res = await trelloRequest(
    `${TRELLO_API}/cards/${cardId}/checkItem/${checkItemId}?${trelloAuth()}`,
    {
      method: "PUT",
      headers: trelloHeaders(),
      body: JSON.stringify({ name: newName }),
    }
  );
  if (!res.ok) throw new Error(`Trello renameCheckItem failed: ${res.status}`);
}

/**
 * Write the APTLSS Execution Checklist to a Trello card.
 * Returns a map of stepNumber → trelloCheckItemId.
 */
export async function writeChecklistToTrello(
  vaId: number,
  cardId: string,
  ctx: TrelloCardContext,
  newSteps: AptlssStepInput[]
): Promise<{ checklistId: string; stepCheckItemIds: Record<number, string> }> {
  const existing = await getAptlssChecklist(cardId, ctx.checklists);

  const stepCheckItemIds: Record<number, string> = {};

  if (!existing) {
    // No checklist yet — create fresh
    const checklistId = await createChecklist(cardId, newSteps);
    // Fetch the newly created checklist to get check item IDs
    const res = await trelloRequest(
      `${TRELLO_API}/checklists/${checklistId}/checkItems?${trelloAuth()}`
    );
    if (!res.ok) {
      throw new Error(`Trello fetchChecklistItems failed: ${res.status}`);
    }
    const items: { id: string; name: string }[] = await res.json();
    newSteps.forEach((step, idx) => {
      if (items[idx]) stepCheckItemIds[step.stepNumber] = items[idx].id;
    });
    return { checklistId, stepCheckItemIds };
  }

  // Checklist exists — smart merge
  const checklistId = existing.id;
  const existingItems = existing.checkItems;

  // Load manual (human-added) steps from DB so we never mark them as [REPLACED]
  const manualSteps = await getManualStepsForCard(vaId, cardId);
  const manualCheckItemIds = new Set(
    manualSteps.map((s) => s.trelloCheckItemId).filter(Boolean)
  );

  // Build sets for comparison
  const newTitles = new Set(newSteps.map((s) => s.title.trim()));
  const completedItems = existingItems.filter((i) => i.state === "complete");
  const completedTitles = new Set(completedItems.map((i) => i.name.trim()));

  // Mark obsolete AI items (not in newTitles, not completed, not manually added)
  for (const item of existingItems) {
    if (item.state === "complete") continue; // never touch completed
    if (newTitles.has(item.name.trim())) continue; // still relevant
    if (manualCheckItemIds.has(item.id)) continue; // human-added: preserve
    if (!item.name.startsWith("[REPLACED]")) {
      await renameCheckItem(cardId, item.id, `[REPLACED] ${item.name}`);
    }
  }

  // Add new steps that don't already exist
  for (const step of newSteps) {
    const alreadyExists = existingItems.find(
      (i) => i.name.trim() === step.title.trim()
    );
    if (alreadyExists) {
      stepCheckItemIds[step.stepNumber] = alreadyExists.id;
    } else if (!completedTitles.has(step.title.trim())) {
      const newId = await addCheckItem(checklistId, step.title);
      stepCheckItemIds[step.stepNumber] = newId;
    }
  }

  return { checklistId, stepCheckItemIds };
}
