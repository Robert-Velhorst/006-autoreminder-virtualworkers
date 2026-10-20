import { and, desc, eq, inArray, like } from "drizzle-orm";
import { aptlssPlans, aptlssSteps, founderDecisionDeadlines, notificationHistory, priorityScores, trelloCachedCards, users } from "../drizzle/schema.postgres";
import { getDb } from "./db";
import { recordFounderDecisionAlertForStep } from "./founderDecisionAlerts";
import { enqueueManagerTask } from "./aptlssManagerQueue";

function recordedTaskDue(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const due = (JSON.parse(raw) as { due?: unknown }).due;
    if (typeof due !== "string") return null;
    const parsed = Date.parse(due);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  } catch {
    return null;
  }
}

export function decisionEscalation(decisionDueAt: string | null, taskDueAt: string | null, tier: string, now: number) {
  if (decisionDueAt && Date.parse(decisionDueAt) <= now) return "decision_overdue" as const;
  if (taskDueAt) {
    const due = Date.parse(taskDueAt);
    if (due <= now) return "task_overdue" as const;
  }
  if (decisionDueAt && Date.parse(decisionDueAt) - now <= 24 * 60 * 60_000) return "decision_due_soon" as const;
  if (taskDueAt && Date.parse(taskDueAt) - now <= 24 * 60 * 60_000) return "task_due_soon" as const;
  if (!decisionDueAt && !taskDueAt && (tier === "CRITICAL" || tier === "HIGH")) return "high_priority_no_deadline" as const;
  return "none" as const;
}

export async function getFounderDecisionInbox(now = new Date()) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const open = await db.select({
    stepId: aptlssSteps.id,
    vaId: aptlssSteps.vaId,
    cardId: aptlssSteps.cardId,
    stepTitle: aptlssSteps.title,
    recommendedDecision: aptlssSteps.recommendedDecision,
    completionCriteria: aptlssSteps.completionCriteria,
    riskIfSkipped: aptlssSteps.riskIfSkipped,
    createdAt: aptlssSteps.createdAt,
    workerName: users.name,
  }).from(aptlssSteps)
    .innerJoin(users, and(eq(users.id, aptlssSteps.vaId), eq(users.role, "worker")))
    .where(and(eq(aptlssSteps.requiresRobert, true), eq(aptlssSteps.status, "open")))
    .orderBy(desc(aptlssSteps.createdAt));
  if (!open.length) return { items: [] };

  const vaIds = [...new Set(open.map(item => item.vaId))];
  const cardIds = [...new Set(open.map(item => item.cardId))];
  const [plans, scores, cachedCards, revisions] = await Promise.all([
    db.select({ vaId: aptlssPlans.vaId, cardId: aptlssPlans.cardId, cardName: aptlssPlans.cardName, cardUrl: aptlssPlans.cardUrl, boardName: aptlssPlans.boardName, planJson: aptlssPlans.planJson })
      .from(aptlssPlans).where(and(inArray(aptlssPlans.vaId, vaIds), inArray(aptlssPlans.cardId, cardIds))),
    db.select({ vaId: priorityScores.vaId, cardId: priorityScores.cardId, tier: priorityScores.tier, score: priorityScores.score })
      .from(priorityScores).where(and(inArray(priorityScores.vaId, vaIds), inArray(priorityScores.cardId, cardIds))),
    db.select({ userId: trelloCachedCards.userId, cardId: trelloCachedCards.cardId, cardData: trelloCachedCards.cardData })
      .from(trelloCachedCards).where(and(inArray(trelloCachedCards.userId, vaIds), inArray(trelloCachedCards.cardId, cardIds)))
      .orderBy(desc(trelloCachedCards.cachedAt)),
    db.select().from(founderDecisionDeadlines).where(inArray(founderDecisionDeadlines.stepId, open.map(item => item.stepId)))
      .orderBy(desc(founderDecisionDeadlines.id)),
  ]);
  const key = (vaId: number, cardId: string) => `${vaId}:${cardId}`;
  const planMap = new Map(plans.map(item => [key(item.vaId, item.cardId), item]));
  const scoreMap = new Map(scores.map(item => [key(item.vaId, item.cardId), item]));
  const cacheMap = new Map<string, typeof cachedCards[number]>();
  for (const item of cachedCards) {
    const itemKey = key(item.userId, item.cardId);
    if (!cacheMap.has(itemKey)) cacheMap.set(itemKey, item);
  }
  const deadlineMap = new Map<number, typeof revisions[number]>();
  for (const revision of revisions) {
    if (!deadlineMap.has(revision.stepId)) deadlineMap.set(revision.stepId, revision);
  }
  const items = open.map(step => {
    const itemKey = key(step.vaId, step.cardId);
    const plan = planMap.get(itemKey);
    const score = scoreMap.get(itemKey);
    const tier = score?.tier ?? "MEDIUM";
    const taskDueAt = recordedTaskDue(cacheMap.get(itemKey)?.cardData) ?? recordedTaskDue(plan?.planJson);
    const deadline = deadlineMap.get(step.stepId);
    const decisionDueAt = deadline?.dueAt?.toISOString() ?? null;
    return {
      ...step,
      cardName: plan?.cardName ?? step.cardId,
      cardUrl: plan?.cardUrl ?? "",
      boardName: plan?.boardName ?? "",
      tier,
      taskDueAt,
      decisionDueAt,
      deadlineSource: deadline?.source ?? null,
      isDeferred: deadline?.source.startsWith("Deferred:") ?? false,
      deferralReason: deadline?.source.startsWith("Deferred:") ? deadline.source.slice("Deferred:".length).trim() : null,
      escalation: decisionEscalation(decisionDueAt, taskDueAt, tier, now.getTime()),
      owner: "founder" as const,
    };
  });
  const rank = { decision_overdue: 0, task_overdue: 1, decision_due_soon: 2, task_due_soon: 3, high_priority_no_deadline: 4, none: 5 };
  const tierRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, BLOCKED: 4 };
  items.sort((a, b) => rank[a.escalation] - rank[b.escalation]
    || (tierRank[a.tier] ?? 2) - (tierRank[b.tier] ?? 2)
    || (a.decisionDueAt ?? a.taskDueAt ?? "9999").localeCompare(b.decisionDueAt ?? b.taskDueAt ?? "9999")
    || a.createdAt.getTime() - b.createdAt.getTime());
  return { items };
}

export class FounderDecisionDeadlineError extends Error {}

export async function deferFounderDecisionDeadline(input: {
  vaId: number;
  stepId: number;
  dueAt: Date;
  source: string;
  recordedBy: string;
}) {
  if (!Number.isFinite(input.dueAt.getTime()) || input.dueAt.getTime() <= Date.now()) {
    throw new FounderDecisionDeadlineError("Choose a future review date to defer this decision.");
  }
  return setFounderDecisionDeadline({ ...input, source: `Deferred: ${input.source.trim()}` });
}

export async function setFounderDecisionDeadline(input: {
  vaId: number;
  stepId: number;
  dueAt: Date | null;
  source: string;
  recordedBy: string;
}) {
  const db = await getDb();
  if (!db) throw new FounderDecisionDeadlineError("Database unavailable");
  const source = input.source.trim();
  if (source.length < 3 || source.length > 1024 || (input.dueAt && !Number.isFinite(input.dueAt.getTime()))) {
    throw new FounderDecisionDeadlineError("A valid date and a source or reason are required.");
  }
  const result = await db.transaction(async tx => {
    const [step] = await tx.select({ id: aptlssSteps.id }).from(aptlssSteps)
      .where(and(eq(aptlssSteps.id, input.stepId), eq(aptlssSteps.vaId, input.vaId),
        eq(aptlssSteps.requiresRobert, true), eq(aptlssSteps.status, "open")))
      .limit(1).for("update");
    if (!step) throw new FounderDecisionDeadlineError("This decision is no longer open.");
    if (source.startsWith("Deferred:") && (!input.dueAt || input.dueAt.getTime() <= Date.now())) {
      throw new FounderDecisionDeadlineError("Choose a future review date to defer this decision.");
    }
    const [previous] = await tx.select().from(founderDecisionDeadlines)
      .where(eq(founderDecisionDeadlines.stepId, input.stepId))
      .orderBy(desc(founderDecisionDeadlines.id)).limit(1);
    if (previous?.source === source && (previous.dueAt?.getTime() ?? null) === (input.dueAt?.getTime() ?? null)) {
      return { revisionId: previous.id, changed: false };
    }
    if (previous?.dueAt && !input.dueAt && previous.source === source) {
      throw new FounderDecisionDeadlineError("Give a new reason for withdrawing the deadline.");
    }
    const [created] = await tx.insert(founderDecisionDeadlines).values({
      vaId: input.vaId, stepId: input.stepId, dueAt: input.dueAt, source, recordedBy: input.recordedBy,
    }).returning({ id: founderDecisionDeadlines.id });
    await enqueueManagerTask(tx, {
      vaId: input.vaId,
      trigger: "decision_deadline_changed",
      eventKey: `decision-deadline:${input.stepId}:${created.id}`,
    });
    await tx.update(notificationHistory).set({ isRead: 1, readAt: new Date() })
      .where(and(like(notificationHistory.taskId, `founder-decision:${input.stepId}:%`), eq(notificationHistory.isRead, 0)));
    return { revisionId: created.id, changed: true };
  });
  if (result.changed) {
    try { await recordFounderDecisionAlertForStep(input.stepId); }
    catch (error) { console.error("[FounderDecisionAlerts] Immediate alert failed; scheduler will retry:", error); }
  }
  return result;
}
