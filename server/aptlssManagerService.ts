import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  aptlssManagerRuns, aptlssManagerState, aptlssManagerUpdates, aptlssManagerCorrections, aptlssPlans, aptlssSteps,
  aptlssWaitingReasons, cardStates, communicationEvidence, dailyPlans, decisionOutcomes,
  emailTasks, priorityScores, timeEntries, trelloCachedCards, users, workspaceEvidenceItems,
  workspaceEvidenceLinks, aptlssEvidenceSubjectLinks, aptlssEvidenceRevisions, aptlssEvidenceConflicts, timeEntryEvents,
} from "../drizzle/schema";
import type { ManagerAction, ManagerCard, ManagerEvidence, ManagerInput, ManagerPolicy, ManagerSnapshot } from "../shared/aptlssManager";
import { dateKeyInTimeZone } from "../shared/workerTime";
import { getDb } from "./db";
import { assessManagerContext } from "./aptlssManagerEngine";
import { enrichManagerResult, reuseManagerSemanticReview } from "./aptlssManagerModel";
import { focusManagerQuestions } from "./aptlssManagerQuestions";
import { applyManagerLearning } from "./aptlssManagerLearning";
import { reconcileManagerPlan } from "./aptlssManagerPlan";
import type { OperatorDailyPlanPayload } from "./operatorDailyPlan";
import { resolveWorkerOperatorContextById } from "./workerOperatorContext";
import { recordWorkerEvidenceAssertion } from "./aptlssEvidenceGraphDb";
import { getManagerGate, managerPlanVersion, managerReviewProposalIdentity, selectApplicableManagerCorrections } from "./aptlssManagerReviewService";
import { managerSafetyDigest } from "./aptlssManagerSafety";
import { websocketService } from "./services/websocket";
import { assertManagerQueueLease, createManagerQueueRunner, enqueueManagerTask, ManagerQueueLeaseLostError, type ManagerQueueLease } from "./aptlssManagerQueue";
import { aptlssManagerQueue } from "../drizzle/aptlssManagerQueueSchema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export const DEFAULT_MANAGER_POLICY: ManagerPolicy = { enabled: true, intervalMinutes: 5, mode: "shadow" };
const LIMIT = 250;
const EVIDENCE_LIMIT = 1500;
const inflight = new Map<number, Promise<ManagerSnapshot>>();

function json<T>(value: string | null | undefined, fallback: T): T {
  try { return JSON.parse(value ?? "null") ?? fallback; } catch { return fallback; }
}
function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function managerSafeText(value: unknown, max = 4000) {
  return String(value ?? "").slice(0, max)
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[redacted]")
    .replace(/((?:password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}
function safeUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (/token|secret|key|signature/i.test(url.search)) return null;
    return url.href;
  } catch { return null; }
}
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable; the project manager cannot retain its decisions.");
  return db;
}

/** Only explicit source links are joined. Text similarity alone never grants data access. */
export async function collectManagerInput(db: Db, vaId: number, now: Date): Promise<ManagerInput> {
  const [plans, states, scores, steps, waiting, times, mails, updates, outcomes, cached] = await Promise.all([
    db.select().from(aptlssPlans).where(eq(aptlssPlans.vaId, vaId)).orderBy(aptlssPlans.cardId).limit(LIMIT + 1),
    db.select().from(cardStates).where(eq(cardStates.vaId, vaId)).orderBy(cardStates.cardId).limit(LIMIT + 1),
    db.select().from(priorityScores).where(eq(priorityScores.vaId, vaId)).orderBy(priorityScores.cardId).limit(LIMIT + 1),
    db.select().from(aptlssSteps).where(eq(aptlssSteps.vaId, vaId)).orderBy(aptlssSteps.cardId, aptlssSteps.stepNumber).limit(5001),
    db.select().from(aptlssWaitingReasons).where(and(eq(aptlssWaitingReasons.vaId, vaId), eq(aptlssWaitingReasons.status, "active"))).orderBy(desc(aptlssWaitingReasons.createdAt), desc(aptlssWaitingReasons.id)).limit(LIMIT + 1),
    db.select().from(timeEntries).where(and(eq(timeEntries.vaId, vaId), eq(timeEntries.isVoided, false))).orderBy(desc(timeEntries.id)).limit(5001),
    db.select().from(emailTasks).where(eq(emailTasks.vaId, vaId)).orderBy(desc(emailTasks.receivedAt), desc(emailTasks.id)).limit(501),
    db.select().from(aptlssManagerUpdates).where(eq(aptlssManagerUpdates.vaId, vaId)).orderBy(desc(aptlssManagerUpdates.id)).limit(501),
    db.select().from(decisionOutcomes).where(eq(decisionOutcomes.vaId, vaId)).orderBy(desc(decisionOutcomes.id)).limit(501),
    db.select().from(trelloCachedCards).where(eq(trelloCachedCards.userId, vaId)).orderBy(desc(trelloCachedCards.cachedAt)).limit(1001),
  ]);
  const gaps: string[] = [];
  if (plans.length > LIMIT || states.length > LIMIT || scores.length > LIMIT || steps.length > 5000 || waiting.length > LIMIT || times.length > 5000 || mails.length > 500 || updates.length > 500 || outcomes.length > 500 || cached.length > 1000) {
    gaps.push("Work context exceeds this cycle's bounded capacity; some records are not assessed. Narrow assignments before trusting full coverage.");
  }
  const ids = plans.slice(0, LIMIT).map(p => p.cardId);
  const [linked, graph, messages] = ids.length ? await Promise.all([
    db.select({ cardId: workspaceEvidenceLinks.cardId, item: workspaceEvidenceItems }).from(workspaceEvidenceLinks)
      .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, workspaceEvidenceLinks.evidenceId))
      .where(and(inArray(workspaceEvidenceLinks.cardId, ids), eq(workspaceEvidenceItems.active, true)))
      .orderBy(desc(workspaceEvidenceItems.observedAt), desc(workspaceEvidenceItems.id)).limit(EVIDENCE_LIMIT + 1),
    db.select({ cardId: aptlssEvidenceSubjectLinks.subjectId, item: workspaceEvidenceItems }).from(aptlssEvidenceSubjectLinks)
      .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, aptlssEvidenceSubjectLinks.evidenceId))
      .where(and(eq(aptlssEvidenceSubjectLinks.vaId, vaId), eq(aptlssEvidenceSubjectLinks.subjectType, "card"), inArray(aptlssEvidenceSubjectLinks.subjectId, ids), eq(workspaceEvidenceItems.active, true)))
      .orderBy(desc(workspaceEvidenceItems.observedAt), desc(workspaceEvidenceItems.id)).limit(EVIDENCE_LIMIT + 1),
    db.select().from(communicationEvidence).where(inArray(communicationEvidence.linkedCardId, ids))
      .orderBy(desc(communicationEvidence.occurredAt), desc(communicationEvidence.id)).limit(EVIDENCE_LIMIT + 1),
  ]) : [[], [], []];
  if (linked.length > EVIDENCE_LIMIT || graph.length > EVIDENCE_LIMIT || messages.length > EVIDENCE_LIMIT) gaps.push("Linked source history was truncated; older context may be missing.");
  const graphIds = [...new Set(graph.map(g => g.item.id))];
  const revisions = graphIds.length ? await db.select().from(aptlssEvidenceRevisions).where(inArray(aptlssEvidenceRevisions.evidenceId, graphIds)).orderBy(desc(aptlssEvidenceRevisions.observedAt), desc(aptlssEvidenceRevisions.id)).limit(5001) : [];
  const conflicts = await db.select().from(aptlssEvidenceConflicts).where(eq(aptlssEvidenceConflicts.vaId, vaId)).orderBy(desc(aptlssEvidenceConflicts.id)).limit(1501);
  // Open conflicts must not disappear when newer, unrelated evidence fills the history window.
  const openConflictLinks = ids.length ? await db.select({ conflict: aptlssEvidenceConflicts, cardId: aptlssEvidenceSubjectLinks.subjectId })
    .from(aptlssEvidenceConflicts).innerJoin(aptlssEvidenceSubjectLinks, and(
      or(eq(aptlssEvidenceSubjectLinks.evidenceId, aptlssEvidenceConflicts.sourceEvidenceId), eq(aptlssEvidenceSubjectLinks.evidenceId, aptlssEvidenceConflicts.assertedEvidenceId)),
      eq(aptlssEvidenceSubjectLinks.vaId, vaId), eq(aptlssEvidenceSubjectLinks.subjectType, "card")))
    .where(and(eq(aptlssEvidenceConflicts.vaId, vaId), eq(aptlssEvidenceConflicts.status, "needs_verification"), inArray(aptlssEvidenceSubjectLinks.subjectId, ids)))
    .orderBy(aptlssEvidenceConflicts.id).limit(1501) : [];
  if (revisions.length > 5000 || conflicts.length > 1500) gaps.push("Evidence revision or conflict history exceeds the assessment capacity.");
  const stateMap = new Map(states.map(s => [s.cardId, s]));
  const scoreMap = new Map(scores.map(s => [s.cardId, s]));
  const cards: ManagerCard[] = plans.slice(0, LIMIT).map(p => {
    const cachedCard = cached.find(c => c.cardId === p.cardId);
    const context = json<Record<string, unknown>>(cachedCard?.cardData ?? p.contextSnapshot, {});
    const plan = json<Record<string, unknown>>(p.planJson, {});
    const state = stateMap.get(p.cardId);
    const wait = waiting.find(w => w.cardId === p.cardId);
    return {
      id: p.cardId, name: managerSafeText(p.cardName, 512), url: safeUrl(p.cardUrl), board: managerSafeText(p.boardName, 256), list: managerSafeText(p.listName, 256),
      state: state?.state ?? "NEW_UNTRIAGED", stateReason: managerSafeText(state?.stateReason),
      dueAt: iso(typeof context.due === "string" ? context.due : typeof plan.due === "string" ? plan.due : null),
      overdue: state?.isOverdue ?? false, priority: scoreMap.get(p.cardId)?.score ?? 0,
      updatedAt: iso(typeof context.dateLastActivity === "string" ? context.dateLastActivity : p.updatedAt)!,
      steps: steps.filter(s => s.cardId === p.cardId).map(s => ({ id: s.id, title: managerSafeText(s.title, 1024), category: s.category, minutes: s.estimatedMinutes, complete: s.status === "complete", requiresDecision: s.requiresRobert, dependsOn: [...json<string[]>(s.dependsOnCards, []).filter(x => typeof x === "string"), ...(s.blockedBy ? [s.blockedBy] : [])].slice(0, 50), completionCriteria: s.completionCriteria ? managerSafeText(s.completionCriteria) : null })),
      waiting: wait ? { reason: managerSafeText(wait.rawReason), action: managerSafeText(wait.nextAction), followUpAt: iso(wait.followUpAt), category: wait.category, confidence: wait.confidenceScore } : null,
    };
  });
  const evidence: ManagerEvidence[] = [];
  for (const p of plans.slice(0, LIMIT)) {
    const source = cached.find(c => c.cardId === p.cardId);
    const raw = json<Record<string, unknown>>(source?.cardData ?? p.contextSnapshot, {});
    const sourceDate = typeof raw.dateLastActivity === "string" ? iso(raw.dateLastActivity) : null;
    if (source || p.contextSnapshot) evidence.push({ id: `card:${p.cardId}`, cardId: p.cardId, source: "trello", kind: "source", text: managerSafeText(source?.cardData ?? p.contextSnapshot, 8000), observedAt: sourceDate ?? iso(p.generatedAt)!, url: safeUrl(p.cardUrl), metadata: { sourceDate, essential: true, truthClass: "source_record" } });
  }
  const seen = new Set<string>();
  for (const { cardId, item } of [...graph.slice(0, EVIDENCE_LIMIT), ...linked.slice(0, EVIDENCE_LIMIT)]) {
    // Legacy links have no worker column; worker assertions require the scoped graph link.
    if (item.kind === "worker_assertion" && !graph.some(g => g.cardId === cardId && g.item.id === item.id)) continue;
    const key = `${cardId}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const revision = revisions.find(r => r.evidenceId === item.id);
    const metadata = json<Record<string, unknown>>(revision?.metadataJson ?? item.metadataJson, {});
    // Only the scoped, proof-validated resolution path may establish a human decision.
    const verifiedDecision = item.kind === "verified_conflict_resolution" && metadata.origin === "verified_conflict_resolution"
      && revision?.truthClass === "source_record" && graph.some(g => g.cardId === cardId && g.item.id === item.id);
    evidence.push({ id: `evidence:${item.id}:${cardId}`, cardId, source: item.source, text: managerSafeText(`${item.title}\n${revision?.content ?? revision?.summary ?? item.content ?? item.summary ?? ""}`, 6000), observedAt: iso(revision?.observedAt ?? item.modifiedAt ?? item.observedAt)!, url: safeUrl(item.sourceUrl), kind: verifiedDecision ? "decision" : item.kind === "worker_assertion" ? "worker" : "source", metadata: {
      sender: typeof metadata.sender === "string" ? managerSafeText(metadata.sender,512) : null,
      sourceDate: verifiedDecision && typeof metadata.sourceDate === "string" ? metadata.sourceDate : iso(item.modifiedAt),
      sourceRevision: revision?.contentHash ?? item.contentHash,
      truthClass: verifiedDecision ? "human_decision" : revision?.truthClass === "worker_assertion" || item.kind === "worker_assertion" ? "worker_report" : revision?.truthClass === "system_inference" ? "model_proposal" : "source_record",
      ...(verifiedDecision ? { authority: "authoritative" as const, effectiveFrom: typeof metadata.effectiveFrom === "string" ? metadata.effectiveFrom : null,
        supersedesEvidenceIds: Array.isArray(metadata.supersedesEvidenceIds) ? metadata.supersedesEvidenceIds.filter((id): id is string => typeof id === "string") : [] } : {}),
    } });
  }
  for (const mail of mails.slice(0, 500)) {
    const cardId = mail.trelloCardId && ids.includes(mail.trelloCardId) ? mail.trelloCardId : `email:${mail.id}`;
    if (cardId.startsWith("email:") && mail.status === "pending") cards.push({ id: cardId, name: managerSafeText(mail.subject, 512), url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.gmailThreadId)}`, board: "Email inbox", list: "TO DO", state: "READY_TO_START", stateReason: "Incoming email needs review and processing.", dueAt: iso(mail.deadlineAt), overdue: !!mail.deadlineAt && mail.deadlineAt < now, priority: mail.category === "financial" ? 60 : 40, updatedAt: iso(mail.updatedAt)!, steps: [{ id: -mail.id, title: managerSafeText(mail.suggestedNextAction || `Review email: ${mail.subject}`), category: "communication", minutes: 15, complete: false, requiresDecision: false, dependsOn: [], completionCriteria: "Review the message, prepare any reply, and verify processing in the source inbox." }], waiting: null });
    if (cards.some(c => c.id === cardId)) evidence.push({ id: `email:${mail.id}`, cardId, source: "gmail", kind: "source", text: managerSafeText(`From: ${mail.fromAddress}\nStatus: ${mail.status}\n${mail.subject}\n${mail.snippet ?? ""}`), observedAt: iso(mail.receivedAt)!, url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.gmailThreadId)}`, metadata: { sender: mail.fromAddress, sourceDate: iso(mail.receivedAt), truthClass: "source_record" } });
  }
  for (const message of messages.slice(0, EVIDENCE_LIMIT)) {
    // Outbound messages are observations, never instructions to send another message.
    evidence.push({ id: `message:${message.id}`, cardId: message.linkedCardId!, source: message.channel, kind: "source", text: managerSafeText(`${message.direction}: ${message.subject ?? ""}\n${message.summary ?? ""}\nResponse required: ${message.responseRequired}; responded: ${iso(message.respondedAt) ?? "not verified"}`), observedAt: iso(message.occurredAt)! });
  }
  for (const update of updates.slice(0, 500)) if (cards.some(c => c.id === update.cardId) && !evidence.some(e => e.cardId === update.cardId && e.kind === "worker" && e.text.includes(update.detail))) evidence.push({ id: `update:${update.id}`, cardId: update.cardId, source: "worker_update", kind: "worker", text: managerSafeText(update.detail), observedAt: iso(update.createdAt)!, metadata: { truthClass: "worker_report", sender: String(vaId) } });
  for (const outcome of outcomes.slice(0, 500)) if (ids.includes(outcome.cardId)) evidence.push({ id: `decision:${outcome.id}`, cardId: outcome.cardId, source: "decision_outcome", kind: "decision", text: managerSafeText(`${outcome.decisionPrompt}\nRecorded outcome: ${outcome.outcome}`), observedAt: iso(outcome.resolvedAt)! });
  for (const source of ["trello", "gmail", "google_drive"]) if (!evidence.some(e => e.source === source)) gaps.push(`No linked ${source} evidence is available in this worker scope; source completeness is unknown.`);
  if (!cards.length) gaps.push("No assigned APTLSS plans or pending emails are available. Synchronize assigned work first.");
  // Sum sessions only for a verified completed step. A stopped timer alone is not a completed task.
  const samples = new Map<number, ManagerInput["timeSamples"][number]>();
  const entryIds = times.slice(0,5000).map(t => t.id);
  const events = entryIds.length ? await db.select().from(timeEntryEvents).where(inArray(timeEntryEvents.timeEntryId, entryIds)).orderBy(desc(timeEntryEvents.id)).limit(10001) : [];
  const timeSummary = { waitingMinutes: 0, interruptedMinutes: 0 };
  for (const entry of times.slice(0, 5000)) {
    const step = steps.find(s => s.id === entry.aptlssStepId && s.cardId === entry.cardId && s.status === "complete");
    const seconds = entry.durationSeconds ?? (entry.durationMinutes ?? 0) * 60;
    if (entry.endTime && seconds > 0 && /wait|break/i.test(entry.category)) { timeSummary.waitingMinutes += seconds / 60; continue; }
    if (!step || !entry.endTime || seconds <= 0 || seconds > 12 * 3600) continue;
    const interrupted = events.some(e => e.timeEntryId === entry.id && /pause|interrupt|auto.stop/i.test(e.eventType));
    if (interrupted) timeSummary.interruptedMinutes += seconds / 60;
    const sample = samples.get(step.id) ?? { id: step.id, cardId: step.cardId, stepId: step.id, category: step.category, minutes: 0, completed: true, interrupted: false, startedAt: iso(entry.startTime)!, completedAt: iso(entry.endTime)! };
    sample.interrupted ||= interrupted;
    sample.startedAt = new Date(sample.startedAt!) < entry.startTime ? sample.startedAt : iso(entry.startTime)!;
    sample.completedAt = new Date(sample.completedAt!) > entry.endTime! ? sample.completedAt : iso(entry.endTime)!;
    sample.minutes += seconds / 60;
    samples.set(step.id, sample);
  }
  if (events.length > 10000 || times.length > 5000) {
    samples.clear();
    gaps.push("Time history was truncated; incomplete execution samples are excluded from personal estimates and accuracy measurement.");
  }
  const graphConflicts = [...new Map(openConflictLinks.map(({conflict:c,cardId}) => [`${c.id}:${cardId}`, { id: `graph:${c.id}`, cardId, evidenceIds: [`evidence:${c.sourceEvidenceId}:${cardId}`, `evidence:${c.assertedEvidenceId}:${cardId}`], status: c.status, severity: "urgent", explanation: c.resolution ?? "Source and worker statements disagree; review the retained evidence." }])).values()];
  if (openConflictLinks.length > 1500) for (const cardId of ids) graphConflicts.push({ id: `conflict-capacity:${cardId}`, cardId, evidenceIds: [], status: "needs_verification", severity: "urgent", explanation: "Open conflict coverage is incomplete. Verify this task's unresolved source conflicts before continuing." });
  const executionCoverageComplete = cards.length > 0 && plans.length <= LIMIT && states.length <= LIMIT && scores.length <= LIMIT
    && steps.length <= 5000 && waiting.length <= LIMIT && mails.length <= 500 && updates.length <= 500
    && outcomes.length <= 500 && linked.length <= EVIDENCE_LIMIT && graph.length <= EVIDENCE_LIMIT
    && messages.length <= EVIDENCE_LIMIT && revisions.length <= 5000 && openConflictLinks.length <= 1500;
  if (!executionCoverageComplete) gaps.push("Automatic plan changes are paused because execution context coverage is incomplete.");
  const correctionRows = await db.select().from(aptlssManagerCorrections).where(eq(aptlssManagerCorrections.vaId, vaId)).orderBy(aptlssManagerCorrections.id);
  const guidance: NonNullable<ManagerInput["learning"]>["guidance"] = [];
  const withheld: NonNullable<ManagerInput["learning"]>["withheld"] = [];
  const learningHashes: string[] = [];
  const kinds: ManagerAction["kind"][] = ["work", "verify", "draft", "decision", "follow_up"];
  for (const card of correctionRows.length ? cards : []) for (const actionKind of kinds) {
    const selected = selectApplicableManagerCorrections(correctionRows, { vaId, card, evidence, now, actionKind });
    learningHashes.push(selected.learningStateHash);
    for (const correction of selected.corrections) guidance.push({ id: correction.id, reviewId: correction.reviewId,
      cardId: card.id, scope: correction.scope, topic: correction.topic, correction: managerSafeText(correction.correction, 8000),
      evidenceIds: correction.evidence.map(pin => pin.id), validUntil: correction.validUntil, actionKind,
    });
    for (const topic of selected.withheldTopics) withheld.push({ cardId: card.id, topic, actionKind });
  }
  return { now: now.toISOString(), cards, evidence, timeSamples: [...samples.values()], sourceGaps: gaps, graphConflicts, timeSummary, executionCoverageComplete,
    learning: { stateHash: hash(learningHashes), guidance, withheld } };
}

async function stateAndSnapshot(db: Db, vaId: number) {
  const [state] = await db.select().from(aptlssManagerState).where(eq(aptlssManagerState.vaId, vaId)).limit(1);
  const [run] = await db.select().from(aptlssManagerRuns).where(eq(aptlssManagerRuns.vaId, vaId)).orderBy(desc(aptlssManagerRuns.id)).limit(1);
  const policy: ManagerPolicy = state ? { enabled: state.enabled, intervalMinutes: state.intervalMinutes, mode: state.mode } : DEFAULT_MANAGER_POLICY;
  const snapshot = json<ManagerSnapshot | null>(run?.snapshotJson, null);
  if (snapshot) {
    snapshot.runId = run.id;
    snapshot.policy = policy;
    snapshot.nextCheckAt = policy.enabled ? new Date((state?.checkedAt?.getTime() ?? Date.now()) + policy.intervalMinutes * 60_000).toISOString() : null;
  }
  return { state, snapshot, policy, error: state?.lastError ?? undefined };
}

export async function getManagerStatus(vaId: number) {
  const db = await requireDb();
  const { state, snapshot, policy, error } = await stateAndSnapshot(db, vaId);
  const [queue] = await db.select({ state: aptlssManagerQueue.state, requestedAt: aptlssManagerQueue.requestedAt,
    availableAt: aptlssManagerQueue.availableAt, attempts: aptlssManagerQueue.attempts,
    lastError: aptlssManagerQueue.lastError, completedAt: aptlssManagerQueue.completedAt,
  }).from(aptlssManagerQueue).where(eq(aptlssManagerQueue.vaId, vaId)).limit(1);
  return { snapshot, policy, error, queue: queue ?? null, checkedAt: state?.checkedAt ?? null, lastSuccessfulAt: state?.lastSuccessfulAt ?? null, gate: await getManagerGate(vaId, db) };
}

export async function updateManagerPolicy(vaId: number, policy: Pick<ManagerPolicy, "enabled" | "intervalMinutes">) {
  if (!Number.isInteger(policy.intervalMinutes) || policy.intervalMinutes < 1 || policy.intervalMinutes > 60) throw new Error("Choose an interval between 1 and 60 minutes.");
  const db = await requireDb();
  return db.transaction(async tx => {
    await tx.select().from(users).where(eq(users.id, vaId)).for("update");
    const values = { enabled: policy.enabled, intervalMinutes: policy.intervalMinutes };
    await tx.insert(aptlssManagerState).values({ vaId, ...values }).onDuplicateKeyUpdate({ set: { ...values, inputHash: null, policyRevision: sql`${aptlssManagerState.policyRevision} + 1` } });
    return (await stateAndSnapshot(tx as unknown as Db, vaId)).policy;
  });
}

export async function submitManagerUpdate(vaId: number, cardId: string, detail: string, interventionId?: string) {
  const db = await requireDb();
  const text = managerSafeText(detail.trim(), 8000);
  if (text.length < 3 || detail.length > 8000) throw new Error("Provide an update between 3 and 8000 characters.");
  const input = await collectManagerInput(db, vaId, new Date());
  if (!input.cards.some(c => c.id === cardId)) throw new Error("This work item is outside your assigned scope.");
  if (interventionId) {
    const current = await stateAndSnapshot(db, vaId);
    if (!current.snapshot?.interventions.some(i => i.id === interventionId && i.cardId === cardId)) throw new Error("This question has changed. Refresh and review the current context.");
  }
  await db.transaction(async tx => {
    await tx.select().from(users).where(eq(users.id, vaId)).for("update");
    if (!cardId.startsWith("email:")) await recordWorkerEvidenceAssertion({ vaId, cardId, title: "Worker reality update", detail: text, recordedBy: String(vaId), database: tx as unknown as Db });
    const [update] = await tx.insert(aptlssManagerUpdates).values({ vaId, cardId, detail: text, interventionId: interventionId ?? null }).$returningId();
    await enqueueManagerTask(tx, { vaId, eventKey: `worker-update:${update.id}`, trigger: "worker_update", urgent: !!interventionId });
  });
  return runManager(vaId, "worker_update");
}

export function managerInputFingerprint(input: ManagerInput, scope: unknown) {
  const now = new Date(input.now).getTime();
  const timeSignals = input.cards.map(c => ({ id: c.id, due: c.dueAt ? Math.floor((new Date(c.dueAt).getTime() - now) / 3_600_000) : null, followUpDue: !!c.waiting?.followUpAt && new Date(c.waiting.followUpAt).getTime() <= now, stale: now - new Date(c.updatedAt).getTime() > 24 * 3_600_000 }));
  const context = scope as Record<string, unknown>;
  const sourceHash = hash({ ...input, now: undefined, scope: context && typeof context === "object" ? { worker: context.worker, implementationDigest: context.implementationDigest } : context });
  return { sourceHash, inputHash: hash({ sourceHash, timeSignals, scope }) };
}

async function executionScope(db: Db, vaId: number, now: Date) {
  const worker = await resolveWorkerOperatorContextById(vaId, db);
  const dateKey = dateKeyInTimeZone(now, worker.timezone);
  const [timer] = await db.select().from(timeEntries).where(and(eq(timeEntries.vaId, vaId), eq(timeEntries.isVoided, false), isNull(timeEntries.endTime))).orderBy(timeEntries.startTime).limit(1);
  const [plan] = await db.select().from(dailyPlans).where(and(eq(dailyPlans.vaId, vaId), eq(dailyPlans.dateKey, dateKey))).limit(1);
  const state = await stateAndSnapshot(db, vaId);
  return { worker, dateKey, timer: timer ?? null, plan, state, fingerprintScope: {
    worker, dateKey, timer: timer ?? null, planVersion: managerPlanVersion(plan?.scheduleJson),
    policy: state.policy, policyRevision: state.state?.policyRevision ?? 0,
    minute: Math.floor(now.getTime() / 60_000), implementationDigest: managerSafetyDigest(),
  } };
}

async function executeManager(vaId: number, trigger: string, lease?: ManagerQueueLease): Promise<ManagerSnapshot> {
  if (lease && lease.vaId !== vaId) throw new ManagerQueueLeaseLostError();
  const db = await requireDb();
  let now = new Date();
  let scope = await executionScope(db, vaId, now);
  const { worker, dateKey, timer, state: current } = scope;
  let input = await collectManagerInput(db, vaId, now);
  let fingerprint = managerInputFingerprint(input, scope.fingerprintScope);
  if (current.snapshot && current.state?.inputHash === fingerprint.inputHash) {
    await db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, vaId)).for("update");
      if (lease) await assertManagerQueueLease(tx, lease);
      await tx.update(aptlssManagerState).set({ checkedAt: now, lastError: null }).where(and(eq(aptlssManagerState.vaId, vaId), eq(aptlssManagerState.inputHash, fingerprint.inputHash)));
    });
    return (await stateAndSnapshot(db, vaId)).snapshot!;
  }
  let result = assessManagerContext(input);
  // Model calls are driven by changed source content, never by a polling clock.
  if (current.state?.sourceHash !== fingerprint.sourceHash) result = await enrichManagerResult(input, result);
  else if (current.snapshot) result = reuseManagerSemanticReview(input, result, current.snapshot);
  result = applyManagerLearning(input, result);
  result = focusManagerQuestions(input, result);

  const snapshot = await db.transaction(async tx => {
    // Serialize schedule writes across processes using the worker's durable identity row.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, vaId)).for("update");
    const freshNow = new Date();
    const freshScope = await executionScope(tx as unknown as Db, vaId, freshNow);
    const freshInput = await collectManagerInput(tx as unknown as Db, vaId, freshNow);
    const freshFingerprint = managerInputFingerprint(freshInput, freshScope.fingerprintScope);
    const { minute: _oldMinute, ...oldExecution } = scope.fingerprintScope;
    const { minute: _freshMinute, ...freshExecution } = freshScope.fingerprintScope;
    if (freshFingerprint.sourceHash !== fingerprint.sourceHash || hash(oldExecution) !== hash(freshExecution)) throw new Error("Source context changed during assessment. A fresh cycle is required.");
    // Time may advance while the provider reasons. Re-evaluate deterministic
    // eligibility and slots now, without another provider call under this lock.
    // Changed sources, timer, schedule, policy, date or plan still require retry.
    if (freshInput.now !== input.now) {
      result = reuseManagerSemanticReview(freshInput, assessManagerContext(freshInput), result);
      result = focusManagerQuestions(freshInput, applyManagerLearning(freshInput, result));
    }
    now = freshNow;
    input = freshInput;
    scope = freshScope;
    fingerprint = freshFingerprint;
    const latestState = await stateAndSnapshot(tx as unknown as Db, vaId);
    if (latestState.state?.inputHash === fingerprint.inputHash && latestState.snapshot) return latestState.snapshot;
    const [latestPlan] = await tx.select().from(dailyPlans).where(and(eq(dailyPlans.vaId, vaId), eq(dailyPlans.dateKey, dateKey))).for("update");
    if (managerPlanVersion(latestPlan?.scheduleJson) !== scope.fingerprintScope.planVersion) throw new Error("Source context changed during assessment. A fresh cycle is required.");
    const existing = json<OperatorDailyPlanPayload | null>(latestPlan?.scheduleJson, null);
    const { plan, changes } = reconcileManagerPlan({ result, cards: input.cards, existing: existing?.version === 2 ? existing : null, worker, now, activeTimer: timer ? { cardId: timer.cardId, planBlockId: timer.planBlockId } : null });
    const activeAllowed = latestState.policy.mode === "active" && input.executionCoverageComplete !== false && !plan.planningImpact.requiresReview && (await getManagerGate(vaId, tx as unknown as Db)).eligible;
    const policy: ManagerPolicy = { ...latestState.policy, mode: activeAllowed ? "active" : "shadow" };
    const snapshot: ManagerSnapshot = { ...result, runId: 0, trigger, cards: input.cards.map(({ id, name, url, board, list }) => ({ id, name, url, board, list })), evidence: input.evidence, changes, policy, nextCheckAt: policy.enabled ? new Date(now.getTime() + policy.intervalMinutes * 60_000).toISOString() : null,
      proposal: plan, planVersion: scope.fingerprintScope.planVersion, applied: activeAllowed && (changes.length > 0 || !latestPlan), implementationDigest: scope.fingerprintScope.implementationDigest };
    snapshot.proposalHash = managerReviewProposalIdentity(snapshot);
    const history = await tx.select({ snapshotJson: aptlssManagerRuns.snapshotJson, createdAt: aptlssManagerRuns.createdAt }).from(aptlssManagerRuns).where(eq(aptlssManagerRuns.vaId, vaId)).orderBy(desc(aptlssManagerRuns.id)).limit(100);
    const errors: number[] = []; let withinRange = 0;
    for (const sample of input.timeSamples.filter(s => s.completed && !s.interrupted && s.startedAt)) {
      const prior = history.filter(h => h.createdAt < new Date(sample.startedAt!)).map(h => json<ManagerSnapshot | null>(h.snapshotJson,null)).flatMap(h => h?.actions ?? []).find(a => a.cardId === sample.cardId && a.stepIds.includes(sample.stepId!));
      if (!prior) continue;
      errors.push(Math.abs(sample.minutes - prior.minutes.likely));
      if (sample.minutes >= prior.minutes.low && sample.minutes <= prior.minutes.high) withinRange++;
    }
    snapshot.timing = { samples: errors.length, withinRange, meanAbsoluteErrorMinutes: errors.length ? errors.reduce((a,b) => a+b,0)/errors.length : null, waitingMinutes: input.timeSummary?.waitingMinutes ?? 0, interruptedMinutes: input.timeSummary?.interruptedMinutes ?? 0 };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) throw new Error("The manager context exceeds safe storage capacity. Narrow assigned work.");
    if (lease) await assertManagerQueueLease(tx, lease);
    const [created] = await tx.insert(aptlssManagerRuns).values({ vaId, inputHash: fingerprint.inputHash, trigger, snapshotJson: JSON.stringify(snapshot), createdAt: now, mode: policy.mode, proposalHash: snapshot.proposalHash, previousPlanJson: snapshot.applied ? latestPlan?.scheduleJson ?? null : null, appliedPlanHash: snapshot.applied ? managerPlanVersion(JSON.stringify(plan)) : null }).$returningId();
    snapshot.runId = created.id;
    if (snapshot.applied) {
      const values = { vaId, dateKey, scheduleJson: JSON.stringify(plan), dailySummary: changes.join(" ").slice(0, 4000), topPriority: plan.blocks[0]?.cardName ?? null, totalScheduledMinutes: plan.planHealth.scheduledMinutes, robertItemsCount: plan.robertItems.length, autoGenerated: true, generatedAt: now };
      await tx.insert(dailyPlans).values(values).onDuplicateKeyUpdate({ set: values });
    }
    await tx.insert(aptlssManagerState).values({ vaId, ...policy, ...fingerprint, checkedAt: now, lastSuccessfulAt: now, lastError: null }).onDuplicateKeyUpdate({ set: { ...fingerprint, mode: policy.mode, checkedAt: now, lastSuccessfulAt: now, lastError: null } });
    return snapshot;
  }, { isolationLevel: "serializable" });
  const [user] = await db.select({ openId: users.openId }).from(users).where(eq(users.id,vaId)).limit(1);
  if (user) websocketService.emitToUser(user.openId, "aptlss:manager-updated", { runId: snapshot.runId, assessedAt: snapshot.assessedAt, urgent: snapshot.interventions.some(i => i.severity === "urgent") });
  return snapshot;
}

export function runManager(vaId: number, trigger = "manual", lease?: ManagerQueueLease): Promise<ManagerSnapshot> {
  const pending = inflight.get(vaId);
  if (pending) return lease || trigger === "worker_update" ? pending.catch(() => null).then(() => runManager(vaId, trigger, lease)) : pending;
  const task = executeManager(vaId, trigger, lease).catch(error => {
    if (error instanceof Error && error.message.startsWith("Source context changed")) return executeManager(vaId, trigger, lease);
    throw error;
  }).catch(async error => {
    // A leased failure belongs to the durable queue; a stale owner must not
    // overwrite worker state even when collection/model execution failed early.
    if (lease || error instanceof ManagerQueueLeaseLostError) throw error;
    const message = error instanceof Error && /Source context changed|safe storage capacity/.test(error.message) ? error.message : "Project manager assessment failed. Check database migrations and integration health; the previous plan remains available.";
    const db = await getDb();
    if (db) await db.insert(aptlssManagerState).values({ vaId, lastError: message, checkedAt: new Date() }).onDuplicateKeyUpdate({ set: { lastError: message, checkedAt: new Date() } }).catch(() => undefined);
    throw new Error(message);
  }).finally(() => inflight.delete(vaId));
  inflight.set(vaId, task);
  return task;
}

let interval: ReturnType<typeof setInterval> | null = null;
let runner: ReturnType<typeof createManagerQueueRunner> | null = null;
let starting: Promise<ReturnType<typeof createManagerQueueRunner>> | null = null;
async function managerQueueRunner() {
  if (runner) return runner;
  if (starting) return starting;
  starting = requireDb().then(db => runner ??= createManagerQueueRunner({ db, execute: runManager,
    onError: error => console.warn("[APTLSS manager]", error.message),
  })).finally(() => { starting = null; });
  return starting;
}
export async function tickManagerScheduler() {
  const current = await managerQueueRunner();
  await current.pollFallback();
  await current.drain();
}
export function startManagerScheduler() {
  if (interval || process.env.APTLSS_MANAGER_SCHEDULER === "false") return;
  const start = () => { void managerQueueRunner().then(current => { if (interval) current.start(); }).catch(() => console.warn("[APTLSS manager] Queue unavailable; initialization will retry.")); };
  interval = setInterval(start, 30_000);
  interval.unref();
  start();
}
export async function stopManagerScheduler() {
  if (interval) clearInterval(interval);
  interval = null;
  if (starting) await starting.catch(() => undefined);
  const current = runner;
  runner = null;
  await current?.stop();
}
