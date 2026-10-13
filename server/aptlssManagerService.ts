import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  aptlssManagerRuns, aptlssManagerChecks, aptlssManagerState, aptlssManagerUpdates, aptlssManagerCorrections, aptlssPlans, aptlssSteps,
  aptlssWaitingReasons, cardStates, communicationEvidence, dailyPlans, decisionOutcomes,
  emailTasks, priorityScores, timeEntries, trelloCachedCards, users, workspaceEvidenceItems,
  workspaceEvidenceLinks, aptlssEvidenceSubjectLinks, aptlssEvidenceRevisions, aptlssEvidenceConflicts, timeEntryEvents,
} from "../drizzle/schema";
import type { ManagerAction, ManagerCard, ManagerEvidence, ManagerInput, ManagerPolicy, ManagerSnapshot, ManagerSchedulerStatus } from "../shared/aptlssManager";
import { dateKeyInTimeZone } from "../shared/workerTime";
import { gmailContentScope } from "../shared/gmailContentScope";
import { getDb } from "./db";
import { assessManagerContext } from "./aptlssManagerEngine";
import { normalizeManagerDependencies } from "./aptlssManagerDependencies";
import { enrichManagerResult, reuseManagerSemanticReview } from "./aptlssManagerModel";
import { managerSemanticProvider } from "./aptlssManagerCodex";
import { focusManagerQuestions } from "./aptlssManagerQuestions";
import { applyManagerLearning } from "./aptlssManagerLearning";
import { reconcileManagerPlan } from "./aptlssManagerPlan";
import type { OperatorDailyPlanPayload } from "./operatorDailyPlan";
import { resolveWorkerOperatorContextById } from "./workerOperatorContext";
import { recordWorkerEvidenceAssertion } from "./aptlssEvidenceGraphDb";
import { assertManagerUpdateSource, managerUpdateEvidenceText, normalizeManagerUpdateFields, type ManagerUpdateFields, type ManagerWorkerOutcome } from "./aptlssManagerUpdates";
import { assertManagerExecutionAllowed, ManagerExecutionPausedError, managerPlanVersion, managerReviewProposalIdentity, selectApplicableManagerCorrections } from "./aptlssManagerReviewService";
import { managerSafetyDigest } from "./aptlssManagerSafety";
import { websocketService } from "./services/websocket";
import { assertManagerQueueLease, createManagerQueueRunner, enqueueManagerTask, managerQueueEventHash, ManagerQueueLeaseLostError, type ManagerQueueLease } from "./aptlssManagerQueue";
import { aptlssManagerQueue } from "../drizzle/aptlssManagerQueueSchema";
import { aptlssManagerQueueEvents } from "../drizzle/aptlssManagerQueueSchema";
import { finishManagerSemanticReview, reserveManagerSemanticReview, managerSemanticRetryReady } from "./aptlssManagerSemanticRuntime";
import { assertManagerPilotWorker, assertManagerPlanMutationAllowed, managerPilotEnabled } from "./aptlssManagerPilot";
import { aggregateManagerTimeSamples, managerTimingPredictions } from "./aptlssManagerTiming";
import { assessManagerAssignmentCoverage, readManagerAssignmentState } from "./aptlssManagerAssignments";
import { managerHistoryHash, managerHistoryPatch } from "./aptlssManagerHistory";
import { readCurrentManagerHistory } from "./aptlssManagerHistoryDb";
export { loadManagerHistoryCheck } from "./aptlssManagerHistoryDb";

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

export async function loadManagerTimingHistory(db: Db, vaId: number) {
  const history = await db.select({
    actionsJson: sql<unknown>`CASE WHEN JSON_VALID(${aptlssManagerRuns.snapshotJson}) THEN JSON_EXTRACT(${aptlssManagerRuns.snapshotJson}, '$.actions') ELSE NULL END`,
    createdAt: aptlssManagerRuns.createdAt,
  }).from(aptlssManagerRuns).where(eq(aptlssManagerRuns.vaId, vaId))
    .orderBy(desc(aptlssManagerRuns.id)).limit(100);
  return history.map(row => ({ createdAt: row.createdAt, actions: managerTimingPredictions(row.actionsJson) }));
}

/** Only explicit source links are joined. Text similarity alone never grants data access. */
export async function collectManagerInput(db: Db, vaId: number, now: Date): Promise<ManagerInput> {
  assertManagerPilotWorker(vaId);
  const [assignmentState, plans, states, scores, steps, waiting, times, mails, updates, outcomes, cached] = await Promise.all([
    readManagerAssignmentState(db, vaId),
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
  const assignmentCoverage = assessManagerAssignmentCoverage(assignmentState, plans, steps);
  if (!assignmentState.profile) gaps.push("The worker assignment source is unavailable or ambiguous. Restore one active worker profile before trusting full coverage.");
  if (assignmentState.truncated) gaps.push("The active assignment list exceeds this cycle's safe capacity; not all assigned work was checked.");
  if (assignmentCoverage.missingPlanCount) gaps.push(`${assignmentCoverage.missingPlanCount} active assignment(s) do not have a matching APTLSS work plan.`);
  if (assignmentCoverage.missingStepCount) gaps.push(`${assignmentCoverage.missingStepCount} active checklist assignment(s) do not have a matching APTLSS step.`);
  if (plans.length > LIMIT || states.length > LIMIT || scores.length > LIMIT || steps.length > 5000 || waiting.length > LIMIT || times.length > 5000 || mails.length > 500 || updates.length > 500 || outcomes.length > 500 || cached.length > 1000) {
    gaps.push("Work context exceeds this cycle's bounded capacity; some records are not assessed. Narrow assignments before trusting full coverage.");
  }
  const relevantStepIds = steps.slice(0, 5000).map(step => step.id);
  const rejectedStepIds = new Set(relevantStepIds.length
    ? (await db.select({ stepId: decisionOutcomes.stepId }).from(decisionOutcomes)
      .where(and(eq(decisionOutcomes.vaId, vaId), eq(decisionOutcomes.disposition, "rejected"), inArray(decisionOutcomes.stepId, relevantStepIds))))
      .map(outcome => outcome.stepId)
    : []);
  const ids = plans.slice(0, LIMIT).map(p => p.cardId);
  const [linked, graph, messages] = ids.length ? await Promise.all([
    db.select({ cardId: workspaceEvidenceLinks.cardId, item: workspaceEvidenceItems }).from(workspaceEvidenceLinks)
      .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, workspaceEvidenceLinks.evidenceId))
      .where(and(eq(workspaceEvidenceItems.vaId, vaId), inArray(workspaceEvidenceLinks.cardId, ids), eq(workspaceEvidenceItems.active, true)))
      .orderBy(desc(workspaceEvidenceItems.observedAt), desc(workspaceEvidenceItems.id)).limit(EVIDENCE_LIMIT + 1),
    db.select({ cardId: aptlssEvidenceSubjectLinks.subjectId, item: workspaceEvidenceItems }).from(aptlssEvidenceSubjectLinks)
      .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, aptlssEvidenceSubjectLinks.evidenceId))
      .where(and(eq(workspaceEvidenceItems.vaId, vaId), eq(aptlssEvidenceSubjectLinks.vaId, vaId), eq(aptlssEvidenceSubjectLinks.subjectType, "card"), inArray(aptlssEvidenceSubjectLinks.subjectId, ids), eq(workspaceEvidenceItems.active, true)))
      .orderBy(desc(workspaceEvidenceItems.observedAt), desc(workspaceEvidenceItems.id)).limit(EVIDENCE_LIMIT + 1),
    db.select().from(communicationEvidence).where(and(eq(communicationEvidence.vaId, vaId), inArray(communicationEvidence.linkedCardId, ids)))
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
      state: assignmentCoverage.blockedCardIds.has(p.cardId) ? "BLOCKED" : state?.state ?? "NEW_UNTRIAGED",
      stateReason: assignmentCoverage.blockedCardIds.has(p.cardId)
        ? "This assigned task is marked blocked. Confirm its current status before continuing."
        : managerSafeText(state?.stateReason),
      dueAt: iso(typeof context.due === "string" ? context.due : typeof plan.due === "string" ? plan.due : null),
      overdue: state?.isOverdue ?? false, priority: scoreMap.get(p.cardId)?.score ?? 0,
      updatedAt: iso(typeof context.dateLastActivity === "string" ? context.dateLastActivity : p.updatedAt)!,
      steps: steps.filter(s => s.cardId === p.cardId).map(s => {
        const blocked = assignmentCoverage.blockedStepIds.has(s.id);
        return { id: s.id, title: managerSafeText(s.title, 1024), category: s.category, minutes: s.estimatedMinutes,
          complete: s.status === "complete", requiresDecision: s.requiresRobert, decisionRejected: rejectedStepIds.has(s.id),
          blocked, ...(blocked ? { blockReason: "This assigned checklist step is marked blocked. Resolve or update the assignment before continuing." } : {}),
          dependsOn: normalizeManagerDependencies(p.cardId, [...json<string[]>(s.dependsOnCards, []).filter(x => typeof x === "string"), ...(s.blockedBy ? [s.blockedBy] : [])], steps),
          completionCriteria: s.completionCriteria ? managerSafeText(s.completionCriteria) : null };
      }),
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
    const sourceContent = revision?.content ?? revision?.summary ?? item.content ?? item.summary ?? "";
    // Only the scoped, proof-validated resolution path may establish a human decision.
    const verifiedDecision = item.kind === "verified_conflict_resolution" && metadata.origin === "verified_conflict_resolution"
      && revision?.truthClass === "source_record" && graph.some(g => g.cardId === cardId && g.item.id === item.id);
    evidence.push({ id: `evidence:${item.id}:${cardId}`, cardId, source: item.source, text: managerSafeText(`${item.title}\n${sourceContent}`, 6000), observedAt: iso(revision?.observedAt ?? item.modifiedAt ?? item.observedAt)!, url: safeUrl(item.sourceUrl), kind: verifiedDecision ? "decision" : item.kind === "worker_assertion" ? "worker" : "source", metadata: {
      sender: typeof metadata.sender === "string" ? managerSafeText(metadata.sender,512) : null,
      sourceDate: verifiedDecision && typeof metadata.sourceDate === "string" ? metadata.sourceDate : iso(item.modifiedAt),
      sourceRevision: revision?.contentHash ?? item.contentHash,
      sourceRecordId: item.sourceId,
      ...(item.source === "gmail" ? { contentScope: gmailContentScope(item.title, sourceContent) } : {}),
      truthClass: verifiedDecision ? "human_decision" : revision?.truthClass === "worker_assertion" || item.kind === "worker_assertion" ? "worker_report" : revision?.truthClass === "system_inference" ? "model_proposal" : "source_record",
      ...(verifiedDecision ? { authority: "authoritative" as const, effectiveFrom: typeof metadata.effectiveFrom === "string" ? metadata.effectiveFrom : null,
        supersedesEvidenceIds: Array.isArray(metadata.supersedesEvidenceIds) ? metadata.supersedesEvidenceIds.filter((id): id is string => typeof id === "string") : [] } : {}),
    } });
  }
  for (const mail of mails.slice(0, 500)) {
    const cardId = mail.trelloCardId && ids.includes(mail.trelloCardId) ? mail.trelloCardId : `email:${mail.id}`;
    const contentScope = gmailContentScope(mail.subject, mail.snippet ?? "");
    const portalNotice = contentScope === "portal_notice";
    if (cardId.startsWith("email:") && mail.status === "pending") cards.push({ id: cardId, name: managerSafeText(mail.subject, 512), url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.gmailThreadId)}`, board: "Email inbox", list: "TO DO", state: "READY_TO_START", stateReason: portalNotice ? "A portal notice needs the underlying correspondence checked." : "Incoming email needs review and processing.", dueAt: portalNotice ? null : iso(mail.deadlineAt), overdue: !portalNotice && !!mail.deadlineAt && mail.deadlineAt < now, priority: mail.category === "financial" ? 60 : 40, updatedAt: iso(mail.updatedAt)!, steps: [{ id: -mail.id, title: managerSafeText(portalNotice ? "Read the linked portal correspondence and record its request and deadline" : mail.suggestedNextAction || `Review email: ${mail.subject}`), category: "communication", minutes: 15, complete: false, requiresDecision: false, dependsOn: [], completionCriteria: portalNotice ? "The underlying correspondence was opened and its request, any deadline and source were recorded; the notice alone is insufficient." : "Review the message, prepare any reply, and verify processing in the source inbox." }], waiting: null });
    if (cards.some(c => c.id === cardId)) evidence.push({ id: `email:${mail.id}`, cardId, source: "gmail", kind: "source", text: managerSafeText(`From: ${mail.fromAddress}\nStatus: ${mail.status}\n${mail.subject}\n${mail.snippet ?? ""}`), observedAt: iso(mail.receivedAt)!, url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.gmailThreadId)}`, metadata: { sender: mail.fromAddress, sourceDate: iso(mail.receivedAt), truthClass: "source_record", contentScope } });
  }
  for (const message of messages.slice(0, EVIDENCE_LIMIT)) {
    // Outbound messages are observations, never instructions to send another message.
    evidence.push({ id: `message:${message.id}`, cardId: message.linkedCardId!, source: message.channel, kind: "source", text: managerSafeText(`${message.direction}: ${message.subject ?? ""}\n${message.summary ?? ""}\nResponse required: ${message.responseRequired}; responded: ${iso(message.respondedAt) ?? "not verified"}`), observedAt: iso(message.occurredAt)! });
  }
  for (const update of updates.slice(0, 500)) if (cards.some(c => c.id === update.cardId) && (update.reportKind === "completion" || !evidence.some(e => e.cardId === update.cardId && e.kind === "worker" && e.text.includes(update.detail)))) {
    const updateText = managerUpdateEvidenceText(update.detail, {
      outcome: (update.outcome ?? "Update") as ManagerWorkerOutcome,
      deadlineDate: update.deadlineDate,
      sourceEvidenceId: update.sourceEvidenceId,
      sourceDescription: update.sourceDescription,
    });
    const completionContext = update.reportKind === "completion"
      ? `Worker-reported completion, not independently verified. Action ${update.actionId ?? "unknown"}; assessment ${update.assessmentRunId ?? "unknown"}. `
      : "";
    evidence.push({ id: `update:${update.id}`, cardId: update.cardId, source: "worker_update", kind: "worker", text: managerSafeText(`${completionContext}${updateText}`, 8000), observedAt: iso(update.createdAt)!, metadata: { truthClass: "worker_report", sender: String(vaId), outcome: update.outcome, deadlineDate: update.deadlineDate, reportDetail: update.reportKind === "completion" ? update.detail : undefined, sourceEvidenceId: update.sourceEvidenceId, sourceDescription: update.sourceDescription, reportKind: update.reportKind === "completion" ? "completion" : "update", actionId: update.actionId, assessmentRunId: update.assessmentRunId } });
  }
  for (const outcome of outcomes.slice(0, 500)) if (ids.includes(outcome.cardId)) evidence.push({
    id: `decision:${outcome.id}`, cardId: outcome.cardId, source: "decision_outcome", kind: "decision",
    text: managerSafeText(outcome.disposition === "approved" ? "Founder decision: approved"
      : outcome.disposition === "rejected" ? "Founder decision: rejected" : outcome.outcome),
    observedAt: iso(outcome.resolvedAt)!,
    metadata: { truthClass: "human_decision", authority: "authoritative", sender: outcome.resolvedBy,
      sourceDate: iso(outcome.resolvedAt) },
  });
  for (const source of ["trello", "gmail", "google_drive"]) if (!evidence.some(e => e.source === source)) gaps.push(`No linked ${source} evidence is available in this worker scope; source completeness is unknown.`);
  if (!cards.length) gaps.push("No assigned APTLSS plans or pending emails are available. Synchronize assigned work first.");
  const entryIds = times.slice(0,5000).map(t => t.id);
  const events = entryIds.length ? await db.select().from(timeEntryEvents).where(inArray(timeEntryEvents.timeEntryId, entryIds)).orderBy(desc(timeEntryEvents.id)).limit(10001) : [];
  // Build one event index so history size cannot multiply scan work per timer row.
  const timing = aggregateManagerTimeSamples(times.slice(0, 5000), steps, events);
  if (events.length > 10000 || times.length > 5000) {
    timing.samples.length = 0;
    gaps.push("Time history was truncated; incomplete execution samples are excluded from personal estimates and accuracy measurement.");
  }
  const graphConflicts = [...new Map(openConflictLinks.map(({conflict:c,cardId}) => [`${c.id}:${cardId}`, { id: `graph:${c.id}`, cardId, evidenceIds: [`evidence:${c.sourceEvidenceId}:${cardId}`, `evidence:${c.assertedEvidenceId}:${cardId}`], status: c.status, severity: "urgent", explanation: c.resolution ?? "Source and worker statements disagree; review the retained evidence." }])).values()];
  if (openConflictLinks.length > 1500) for (const cardId of ids) graphConflicts.push({ id: `conflict-capacity:${cardId}`, cardId, evidenceIds: [], status: "needs_verification", severity: "urgent", explanation: "Open conflict coverage is incomplete. Verify this task's unresolved source conflicts before continuing." });
  const executionCoverageComplete = cards.length > 0 && assignmentCoverage.complete && plans.length <= LIMIT && states.length <= LIMIT && scores.length <= LIMIT
    && steps.length <= 5000 && waiting.length <= LIMIT && mails.length <= 500 && updates.length <= 500
    && outcomes.length <= 500 && cached.length <= 1000 && linked.length <= EVIDENCE_LIMIT && graph.length <= EVIDENCE_LIMIT
    && messages.length <= EVIDENCE_LIMIT && revisions.length <= 5000 && conflicts.length <= 1500 && openConflictLinks.length <= 1500;
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
      ...(correction.nextStep ? { nextStep: correction.nextStep } : {}),
    });
    for (const target of selected.withheldTargets) withheld.push({ cardId: card.id, ...target, actionKind });
  }
  return { now: now.toISOString(), cards, evidence, timeSamples: timing.samples, sourceGaps: gaps, graphConflicts, timeSummary: timing.timeSummary, executionCoverageComplete,
    assignmentFingerprint: assignmentState.fingerprint,
    learning: { stateHash: hash(learningHashes), guidance, withheld } };
}

async function stateAndSnapshot(db: Db, vaId: number) {
  const { state, run, snapshot } = await readCurrentManagerHistory(db, vaId);
  const policy: ManagerPolicy = state ? { enabled: state.enabled, intervalMinutes: state.intervalMinutes, mode: "shadow" } : DEFAULT_MANAGER_POLICY;
  if (snapshot) {
    snapshot.runId = run.id;
    snapshot.policy = policy;
    snapshot.nextCheckAt = policy.enabled ? snapshot.nextCheckAt : null;
  }
  return { state, snapshot, run, policy, error: state?.lastError ?? undefined };
}

export async function getManagerStatus(vaId: number) {
  assertManagerPilotWorker(vaId);
  const db = await requireDb();
  const { state, snapshot, policy, error } = await stateAndSnapshot(db, vaId);
  const [queue] = await db.select({ state: aptlssManagerQueue.state, requestedAt: aptlssManagerQueue.requestedAt,
    availableAt: aptlssManagerQueue.availableAt, attempts: aptlssManagerQueue.attempts,
    lastError: aptlssManagerQueue.lastError, completedAt: aptlssManagerQueue.completedAt,
  }).from(aptlssManagerQueue).where(eq(aptlssManagerQueue.vaId, vaId)).limit(1);
  // Acceptance history belongs to the review inbox, not the worker's polling path.
  return { snapshot, policy, error, queue: queue ?? null, scheduler: getManagerSchedulerStatus(), checkedAt: state?.checkedAt ?? null, lastSuccessfulAt: state?.lastSuccessfulAt ?? null };
}

export async function updateManagerPolicy(vaId: number, policy: Pick<ManagerPolicy, "enabled" | "intervalMinutes">) {
  assertManagerPilotWorker(vaId);
  if (!Number.isInteger(policy.intervalMinutes) || policy.intervalMinutes < 1 || policy.intervalMinutes > 60) throw new Error("Choose an interval between 1 and 60 minutes.");
  const db = await requireDb();
  return db.transaction(async tx => {
    await tx.select().from(users).where(eq(users.id, vaId)).for("update");
    await assertManagerExecutionAllowed(tx as unknown as Db, vaId, true);
    const values = { enabled: policy.enabled, intervalMinutes: policy.intervalMinutes };
    await tx.insert(aptlssManagerState).values({ vaId, ...values }).onDuplicateKeyUpdate({ set: { ...values, inputHash: null, policyRevision: sql`${aptlssManagerState.policyRevision} + 1` } });
    return (await stateAndSnapshot(tx as unknown as Db, vaId)).policy;
  });
}

type ManagerUpdateSubmissionFields = ManagerUpdateFields & { expectedRunId?: number; requestKey?: string };

export type ManagerUpdateSubmissionResult = {
  reportId: number;
  alreadyRecorded: boolean;
  applied: boolean;
  assessment?: ManagerSnapshot;
};

export class ManagerUpdateSubmissionError extends Error {
  constructor(public readonly code: "BAD_REQUEST" | "CONFLICT", message: string) {
    super(message);
  }
}

const managerUpdateRequestKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const managerUpdateRequestNamespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");

function workerUpdateRequestKey(vaId: number, payload: unknown, requestKey?: string) {
  if (requestKey !== undefined) {
    if (typeof requestKey !== "string" || !managerUpdateRequestKeyPattern.test(requestKey)) {
      throw new ManagerUpdateSubmissionError("BAD_REQUEST", "Refresh the update form and try again.");
    }
    return requestKey.toLowerCase();
  }

  // Older dashboard clients omit a key; a stable content key keeps their exact retry idempotent.
  const digest = createHash("sha1").update(managerUpdateRequestNamespace).update(JSON.stringify({ vaId, payload })).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isDuplicateManagerUpdateKeyError(error: unknown) {
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) return true;
    current = candidate.cause;
  }
  return false;
}

function resolveWorkerUpdateReplay(
  row: typeof aptlssManagerUpdates.$inferSelect,
  payload: { cardId: string; detail: string; interventionId: string | null; outcome: ManagerWorkerOutcome; deadlineDate: string | null; sourceEvidenceId: string | null; sourceDescription: string | null },
): ManagerUpdateSubmissionResult {
  if (row.reportKind !== "update" || row.cardId !== payload.cardId || row.detail !== payload.detail
    || row.interventionId !== payload.interventionId || row.outcome !== payload.outcome
    || row.deadlineDate !== payload.deadlineDate || row.sourceEvidenceId !== payload.sourceEvidenceId
    || row.sourceDescription !== payload.sourceDescription) {
    throw new ManagerUpdateSubmissionError("CONFLICT", "This update key was already used for different information. Refresh the form and submit the changed update again.");
  }
  return { reportId: row.id, alreadyRecorded: true, applied: false };
}

async function workerAssertionQueueReceiptExists(tx: Db, vaId: number, cardId: string, detail: string) {
  const title = "Worker reality update";
  const contentHash = createHash("sha256").update(`${title}\n${detail.trim()}`).digest("hex");
  const sourceId = `worker-assertion:${vaId}:${contentHash}`;
  const [evidence] = await tx.select({ id: workspaceEvidenceItems.id }).from(workspaceEvidenceItems)
    .where(and(eq(workspaceEvidenceItems.vaId, vaId), eq(workspaceEvidenceItems.sourceId, sourceId))).limit(1);
  if (!evidence) return false;
  const eventKey = JSON.stringify(["evidence", evidence.id, contentHash, cardId, "worker_assertion"]);
  const eventHash = managerQueueEventHash(vaId, "source_ingested", eventKey);
  const [receipt] = await tx.select({ eventHash: aptlssManagerQueueEvents.eventHash })
    .from(aptlssManagerQueueEvents).where(eq(aptlssManagerQueueEvents.eventHash, eventHash)).limit(1);
  return !!receipt;
}

async function assertWorkerUpdateAssessmentCurrent(tx: Db, vaId: number, expectedRunId: number) {
  const [state] = await tx.select({ inputHash: aptlssManagerState.inputHash }).from(aptlssManagerState)
    .where(eq(aptlssManagerState.vaId, vaId)).limit(1).for("update");
  const [latestRun] = await tx.select({ id: aptlssManagerRuns.id }).from(aptlssManagerRuns)
    .where(eq(aptlssManagerRuns.vaId, vaId)).orderBy(desc(aptlssManagerRuns.id)).limit(1).for("update");
  if (state?.inputHash === null || !latestRun || latestRun.id !== expectedRunId) {
    throw new ManagerUpdateSubmissionError("CONFLICT", "Work guidance changed before your update was saved. Refresh the current instruction and submit again.");
  }
}

export async function submitManagerUpdate(vaId: number, cardId: string, detail: string, interventionId?: string, fields: ManagerUpdateSubmissionFields = {}): Promise<ManagerUpdateSubmissionResult> {
  assertManagerPilotWorker(vaId);
  if (!Number.isSafeInteger(fields.expectedRunId) || fields.expectedRunId! < 1 || fields.expectedRunId! > 2_147_483_647) {
    throw new ManagerUpdateSubmissionError("BAD_REQUEST", "Refresh the current work guidance before submitting your update.");
  }
  const text = managerSafeText(detail.trim(), 8000);
  if (text.length < 3 || detail.length > 8000) throw new Error("Provide an update between 3 and 8000 characters.");
  const normalized = normalizeManagerUpdateFields(fields);
  if (normalized.sourceDescription) normalized.sourceDescription = managerSafeText(normalized.sourceDescription, 512);
  const payload = {
    cardId, detail: text, interventionId: interventionId ?? null,
    outcome: normalized.outcome, deadlineDate: normalized.deadlineDate,
    sourceEvidenceId: normalized.sourceEvidenceId, sourceDescription: normalized.sourceDescription,
  };
  const requestKey = workerUpdateRequestKey(vaId, payload, fields.requestKey);
  const db = await requireDb();
  await assertManagerExecutionAllowed(db, vaId);
  let persisted: ManagerUpdateSubmissionResult;
  try {
    persisted = await db.transaction(async tx => {
      await tx.select().from(users).where(eq(users.id, vaId)).for("update");
      await assertManagerExecutionAllowed(tx as unknown as Db, vaId);
      const [duplicate] = await tx.select().from(aptlssManagerUpdates).where(and(
        eq(aptlssManagerUpdates.vaId, vaId), eq(aptlssManagerUpdates.requestKey, requestKey),
      )).limit(1);
      if (duplicate) return resolveWorkerUpdateReplay(duplicate, payload);
      const freshInput = await collectManagerInput(tx as unknown as Db, vaId, new Date());
      if (!freshInput.cards.some(c => c.id === cardId)) throw new Error("This work item is outside your assigned scope.");
      await assertWorkerUpdateAssessmentCurrent(tx as unknown as Db, vaId, fields.expectedRunId!);
      assertManagerUpdateSource(freshInput.evidence, cardId, normalized.sourceEvidenceId);
      if (interventionId) {
        const current = await stateAndSnapshot(tx as unknown as Db, vaId);
        if (!current.snapshot?.interventions.some(i => i.id === interventionId && i.cardId === cardId)) throw new Error("This question has changed. Refresh and review the current context.");
      }
      const evidenceText = managerSafeText(managerUpdateEvidenceText(text, normalized), 8000);
      const isEmailUpdate = cardId.startsWith("email:");
      const assertionReceiptExists = !isEmailUpdate && await workerAssertionQueueReceiptExists(tx as unknown as Db, vaId, cardId, evidenceText);
      if (!isEmailUpdate) await recordWorkerEvidenceAssertion({ vaId, cardId, title: "Worker reality update", detail: evidenceText, recordedBy: String(vaId), database: tx as unknown as Db });
      const [update] = await tx.insert(aptlssManagerUpdates).values({ vaId, cardId, detail: text, interventionId: interventionId ?? null, requestKey, ...normalized }).$returningId();
      // The evidence graph already queues newly recorded assertions. Queue a worker-update
      // receipt only when that assertion event is an old receipt, or for email updates
      // which do not create a graph assertion.
      if (isEmailUpdate || assertionReceiptExists) {
        await enqueueManagerTask(tx, { vaId, eventKey: `worker-update:${update.id}`, trigger: "worker_update", urgent: !!interventionId });
      }
      return { reportId: update.id, alreadyRecorded: false, applied: false };
    });
  } catch (error) {
    if (!isDuplicateManagerUpdateKeyError(error)) throw error;
    const [raced] = await db.select().from(aptlssManagerUpdates).where(and(
      eq(aptlssManagerUpdates.vaId, vaId), eq(aptlssManagerUpdates.requestKey, requestKey),
    )).limit(1);
    if (!raced) throw error;
    persisted = resolveWorkerUpdateReplay(raced, payload);
  }
  if (persisted.alreadyRecorded) return persisted;
  const assessment = await runManager(vaId, "worker_update");
  return { ...persisted, applied: assessment.applied === true, assessment };
}

export type ManagerCompletionReport = {
  cardId: string;
  actionId: string;
  detail: string;
  requestKey: string;
  sourceEvidenceId?: string;
  sourceDescription?: string;
};

export class ManagerCompletionReportError extends Error {
  constructor(public readonly code: "BAD_REQUEST" | "CONFLICT" | "PRECONDITION_FAILED", message: string) {
    super(message);
  }
}

function completionRequestMatches(row: typeof aptlssManagerUpdates.$inferSelect, input: ManagerCompletionReport, detail: string, sourceDescription: string | null) {
  return row.reportKind === "completion" && row.cardId === input.cardId && row.actionId === input.actionId
    && row.requestKey === input.requestKey.toLowerCase()
    && row.detail === detail && row.sourceEvidenceId === (input.sourceEvidenceId?.trim() || null)
    && row.sourceDescription === sourceDescription;
}

export async function reportManagerActionCompletion(vaId: number, input: ManagerCompletionReport) {
  assertManagerPilotWorker(vaId);
  const db = await requireDb();
  await assertManagerExecutionAllowed(db, vaId);
  const detail = managerSafeText(input.detail.trim(), 8000);
  if (detail.length < 3 || input.detail.length > 8000) throw new ManagerCompletionReportError("BAD_REQUEST", "Describe what you completed in 3 to 8000 characters.");
  if (!input.cardId.trim() || input.cardId.length > 64 || !input.actionId.trim() || input.actionId.length > 256) throw new ManagerCompletionReportError("BAD_REQUEST", "Refresh the work guidance and select the current step again.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestKey)) throw new ManagerCompletionReportError("BAD_REQUEST", "Refresh the completion form and try again.");
  let normalized: ReturnType<typeof normalizeManagerUpdateFields>;
  try {
    normalized = normalizeManagerUpdateFields({
      sourceEvidenceId: input.sourceEvidenceId,
      sourceDescription: input.sourceDescription,
    });
  } catch (error) {
    throw new ManagerCompletionReportError("BAD_REQUEST", error instanceof Error ? error.message : "Choose a valid source.");
  }
  if (normalized.sourceDescription) normalized.sourceDescription = managerSafeText(normalized.sourceDescription, 512);
  if (!normalized.sourceEvidenceId && !normalized.sourceDescription) throw new ManagerCompletionReportError("BAD_REQUEST", "Identify the source or location where this completion can be checked.");
  const requestKey = input.requestKey.toLowerCase();
  const matchingReport = (row: typeof aptlssManagerUpdates.$inferSelect) => {
    if (!completionRequestMatches(row, input, detail, normalized.sourceDescription)) throw new ManagerCompletionReportError("CONFLICT", "This completion form was already used for different information. Start a new report.");
    return { reportId: row.id, alreadyRecorded: true as const, reassessed: false, applied: false as const };
  };
  const reassessReport = async (report: { reportId: number; alreadyRecorded: boolean }) => {
    try {
      const reassessed = await runManager(vaId, "worker_update");
      return { ...report, reassessed: true as const, assessmentRunId: reassessed.runId, applied: reassessed.applied };
    } catch {
      return { ...report, reassessed: false as const, assessmentRunId: null, applied: false as const };
    }
  };
  const [prior] = await db.select().from(aptlssManagerUpdates).where(and(
    eq(aptlssManagerUpdates.vaId, vaId), eq(aptlssManagerUpdates.requestKey, requestKey),
  )).limit(1);
  if (prior) return reassessReport(matchingReport(prior));

  const assessed = await runManager(vaId, "worker_update");
  if (assessed.applied) throw new ManagerCompletionReportError("PRECONDITION_FAILED", "The active plan changed unexpectedly. Stop and contact your supervisor before reporting completion.");
  const persisted = await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, vaId)).for("update");
    await assertManagerExecutionAllowed(tx as unknown as Db, vaId);
    const [duplicate] = await tx.select().from(aptlssManagerUpdates).where(and(
      eq(aptlssManagerUpdates.vaId, vaId), eq(aptlssManagerUpdates.requestKey, requestKey),
    )).limit(1);
    if (duplicate) return matchingReport(duplicate);

    const now = new Date();
    const scope = await executionScope(tx as unknown as Db, vaId, now);
    const freshInput = await collectManagerInput(tx as unknown as Db, vaId, now);
    const fingerprint = managerInputFingerprint(freshInput, scope.fingerprintScope);
    const current = scope.state;
    const snapshot = current.snapshot;
    if (!snapshot || snapshot.runId !== assessed.runId || current.state?.inputHash !== fingerprint.inputHash
      || current.state?.sourceHash !== fingerprint.sourceHash || snapshot.planVersion !== scope.fingerprintScope.planVersion
      || snapshot.assignmentFingerprint !== freshInput.assignmentFingerprint) {
      throw new ManagerCompletionReportError("CONFLICT", "The task changed while this report was being prepared. Refresh the work guidance and try again.");
    }
    if (freshInput.executionCoverageComplete !== true || snapshot.executionCoverageComplete !== true) {
      throw new ManagerCompletionReportError("PRECONDITION_FAILED", "Work coverage is incomplete. Ask your supervisor to restore the missing work information before reporting completion.");
    }
    const action = snapshot.actions.find(item => item.id === input.actionId && item.cardId === input.cardId);
    if (!action || action.kind !== "work" || action.blocked || action.stepIds.length !== 1) {
      throw new ManagerCompletionReportError("CONFLICT", "This step is no longer available for completion reporting. Refresh the work guidance.");
    }
    const card = freshInput.cards.find(item => item.id === input.cardId);
    const step = card?.steps.find(item => item.id === action.stepIds[0]);
    if (!card || !step || step.complete || step.blocked || step.requiresDecision) {
      throw new ManagerCompletionReportError("PRECONDITION_FAILED", "This step is complete, blocked, or needs a decision. Refresh the work guidance before continuing.");
    }
    try {
      assertManagerUpdateSource(freshInput.evidence, input.cardId, normalized.sourceEvidenceId);
    } catch (error) {
      throw new ManagerCompletionReportError("BAD_REQUEST", error instanceof Error ? error.message : "Choose a source linked to this task.");
    }
    const selectedSource = normalized.sourceEvidenceId
      ? freshInput.evidence.find(item => item.id === normalized.sourceEvidenceId)
      : undefined;
    if (selectedSource?.metadata?.contentScope === "portal_notice" || selectedSource?.metadata?.contentScope === "message_preview") {
      throw new ManagerCompletionReportError("BAD_REQUEST", "A message preview is not completion evidence. Open the full source and describe where the completed result can be checked.");
    }
    const evidenceText = managerSafeText(`Worker-reported completion, not independently verified. Action ${action.id}; assessment ${snapshot.runId}. ${managerUpdateEvidenceText(detail, normalized)}`, 8000);
    if (!input.cardId.startsWith("email:")) {
      await recordWorkerEvidenceAssertion({ vaId, cardId: input.cardId, title: "Worker completion report (unverified)", detail: evidenceText, recordedBy: String(vaId), database: tx as unknown as Db });
    }
    const [created] = await tx.insert(aptlssManagerUpdates).values({
      vaId, cardId: input.cardId, detail, reportKind: "completion", actionId: action.id,
      assessmentRunId: snapshot.runId, requestKey, outcome: "Update", deadlineDate: null,
      sourceEvidenceId: normalized.sourceEvidenceId, sourceDescription: normalized.sourceDescription,
    }).$returningId();
    await enqueueManagerTask(tx, { vaId, eventKey: `worker-completion-report:${created.id}`, trigger: "worker_update" });
    return { reportId: created.id, alreadyRecorded: false as const };
  });
  return reassessReport(persisted);
}

export function managerInputFingerprint(input: ManagerInput, scope: unknown) {
  const now = new Date(input.now).getTime();
  const timeSignals = input.cards.map(c => ({ id: c.id, due: c.dueAt ? Math.floor((new Date(c.dueAt).getTime() - now) / 3_600_000) : null, followUpDue: !!c.waiting?.followUpAt && new Date(c.waiting.followUpAt).getTime() <= now, stale: now - new Date(c.updatedAt).getTime() > 24 * 3_600_000 }));
  const context = scope as Record<string, unknown>;
  const sourceHash = hash({ ...input, now: undefined, scope: context && typeof context === "object" ? { worker: context.worker, implementationDigest: context.implementationDigest } : context });
  return { sourceHash, inputHash: hash({ sourceHash, timeSignals, scope }) };
}

export function managerCoverageMatchesSnapshot(snapshot: Pick<ManagerSnapshot, "executionCoverageComplete"> | null | undefined, coverage: boolean | undefined) {
  return !!snapshot && snapshot.executionCoverageComplete === coverage;
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

type ManagerFailureStateVersion = string | null;

async function persistManagerFailureIfCurrent(db: Db, vaId: number, expectedVersion: ManagerFailureStateVersion, message: string) {
  await db.transaction(async tx => {
    // Successful assessment writes take this same lock before updating state.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, vaId)).for("update");
    const [latest] = await tx.select().from(aptlssManagerState).where(eq(aptlssManagerState.vaId, vaId)).limit(1).for("update");
    if ((latest ? hash(latest) : null) !== expectedVersion) return;
    await tx.insert(aptlssManagerState).values({ vaId, lastError: message, checkedAt: new Date() })
      .onDuplicateKeyUpdate({ set: { lastError: message, checkedAt: new Date() } });
  });
}

async function executeManager(vaId: number, trigger: string, lease?: ManagerQueueLease, onAssessmentStart?: (state: typeof aptlssManagerState.$inferSelect | undefined) => void): Promise<ManagerSnapshot> {
  assertManagerPilotWorker(vaId);
  if (lease && lease.vaId !== vaId) throw new ManagerQueueLeaseLostError();
  const db = await requireDb();
  await assertManagerExecutionAllowed(db, vaId);
  let now = new Date();
  let scope = await executionScope(db, vaId, now);
  const { worker, dateKey, timer, state: current } = scope;
  onAssessmentStart?.(current.state);
  let input = await collectManagerInput(db, vaId, now);
  let fingerprint = managerInputFingerprint(input, scope.fingerprintScope);
  let semanticReview = current.snapshot?.semanticReview;
  const manualRefresh = trigger === "manual" || trigger === "founder_review";
  const semanticDue = !semanticReview || (semanticReview.provider ?? "openai-api") !== managerSemanticProvider() || (managerSemanticRetryReady(semanticReview, manualRefresh, now.getTime())
    && (!semanticReview.success || manualRefresh || semanticReview.sourceHash !== fingerprint.sourceHash));
  const needsFullHistory = (state: typeof aptlssManagerState.$inferSelect | undefined) =>
    process.env.APTLSS_MANAGER_COMPACT_HISTORY === "false" && state?.currentCheckId != null;
  // Disabling compact history must also leave the identical-input fast path.
  // Reassess locally; do not refresh evidence or semantic-review timestamps.
  if (!needsFullHistory(current.state) && managerCoverageMatchesSnapshot(current.snapshot, input.executionCoverageComplete) && current.state?.inputHash === fingerprint.inputHash && !semanticDue) {
    await db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, vaId)).for("update");
      await assertManagerExecutionAllowed(tx as unknown as Db, vaId);
      if (lease) await assertManagerQueueLease(tx, lease);
      await tx.update(aptlssManagerState).set({ checkedAt: now, lastError: null }).where(and(eq(aptlssManagerState.vaId, vaId), eq(aptlssManagerState.inputHash, fingerprint.inputHash)));
    });
    return (await stateAndSnapshot(db, vaId)).snapshot!;
  }
  let result = assessManagerContext(input);
  let semanticAttempt: { runtime: Awaited<ReturnType<typeof reserveManagerSemanticReview>>["runtime"]; success: boolean; failureKind?: "quota"; attempts?: import("./aptlssManagerCodex").CodexManagerAttempt[] } | undefined;
  // Shadow mode retains validated semantic assessment, but can never apply its proposal.
  // Retry failed unchanged sources, but every trigger shares the same durable rate cap.
  if (current.state?.sourceHash !== fingerprint.sourceHash || semanticDue) {
    const reservation = await reserveManagerSemanticReview(db, vaId, fingerprint.sourceHash, manualRefresh);
    semanticReview = { ...reservation.runtime, success: reservation.runtime.success && reservation.runtime.sourceHash === fingerprint.sourceHash };
    if (reservation.reserved) {
      semanticAttempt = { runtime: reservation.runtime, success: false };
      result = await enrichManagerResult(input, result, (outcome, failureKind, attempts) => { semanticAttempt!.success = outcome; semanticAttempt!.failureKind = failureKind; semanticAttempt!.attempts = attempts; });
    } else if (current.snapshot && current.state?.sourceHash === fingerprint.sourceHash) {
      result = reuseManagerSemanticReview(input, result, current.snapshot);
    } else {
      result.sourceGaps.push("Semantic review is waiting for its bounded retry window; changed source context has not been semantically reviewed.");
    }
  } else if (current.snapshot) result = reuseManagerSemanticReview(input, result, current.snapshot);
  result = applyManagerLearning(input, result);
  result = focusManagerQuestions(input, result);

  const snapshot = await db.transaction(async tx => {
    assertManagerPilotWorker(vaId);
    // Serialize schedule writes across processes using the worker's durable identity row.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, vaId)).for("update");
    await assertManagerExecutionAllowed(tx as unknown as Db, vaId);
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
    // An actual retry outcome must replace the cached failure. A concurrent caller
    // without a reservation must not overwrite a completed semantic assessment.
    if (!needsFullHistory(latestState.state) && latestState.state?.inputHash === fingerprint.inputHash && managerCoverageMatchesSnapshot(latestState.snapshot, input.executionCoverageComplete) && !semanticAttempt) return latestState.snapshot!;
    if (semanticAttempt) semanticReview = await finishManagerSemanticReview(tx as unknown as Db, vaId, semanticAttempt.runtime, semanticAttempt.success, semanticAttempt.failureKind, semanticAttempt.attempts);
    const [latestPlan] = await tx.select().from(dailyPlans).where(and(eq(dailyPlans.vaId, vaId), eq(dailyPlans.dateKey, dateKey))).for("update");
    if (managerPlanVersion(latestPlan?.scheduleJson) !== scope.fingerprintScope.planVersion) throw new Error("Source context changed during assessment. A fresh cycle is required.");
    const existing = json<OperatorDailyPlanPayload | null>(latestPlan?.scheduleJson, null);
    const reconciled = input.executionCoverageComplete === false ? null : reconcileManagerPlan({ result, cards: input.cards, existing: existing?.version === 2 ? existing : null, worker, now, activeTimer: timer ? { cardId: timer.cardId, planBlockId: timer.planBlockId } : null });
    const activeAllowed = false;
    const policy: ManagerPolicy = { ...latestState.policy, mode: activeAllowed ? "active" : "shadow" };
    const snapshot: ManagerSnapshot = { ...result, semanticReview, runId: 0, trigger, cards: input.cards.map(({ id, name, url, board, list }) => ({ id, name, url, board, list })), evidence: input.evidence, changes: reconciled?.changes ?? [], policy, nextCheckAt: policy.enabled ? new Date(now.getTime() + policy.intervalMinutes * 60_000).toISOString() : null,
      proposal: reconciled?.plan, planVersion: scope.fingerprintScope.planVersion, assignmentFingerprint: input.assignmentFingerprint,
      applied: activeAllowed && !!reconciled && (reconciled.changes.length > 0 || !latestPlan), implementationDigest: scope.fingerprintScope.implementationDigest };
    snapshot.proposalHash = managerReviewProposalIdentity(snapshot);
    const completedSamples = input.timeSamples.filter(s => s.completed && !s.interrupted && s.startedAt);
    // No timing observations means there is nothing to calibrate. Avoid loading
    // hundreds of megabytes of historical source dossiers on every idle poll.
    const predictions = completedSamples.length ? await loadManagerTimingHistory(tx as unknown as Db, vaId) : [];
    const errors: number[] = []; let withinRange = 0;
    for (const sample of completedSamples) {
      const prior = predictions.filter(h => h.createdAt < new Date(sample.startedAt!)).flatMap(h => h.actions).find(a => a.cardId === sample.cardId && a.stepIds.includes(sample.stepId!));
      if (!prior) continue;
      errors.push(Math.abs(sample.minutes - prior.minutes.likely));
      if (sample.minutes >= prior.minutes.low && sample.minutes <= prior.minutes.high) withinRange++;
    }
    snapshot.timing = { samples: errors.length, withinRange, meanAbsoluteErrorMinutes: errors.length ? errors.reduce((a,b) => a+b,0)/errors.length : null, waitingMinutes: input.timeSummary?.waitingMinutes ?? 0, interruptedMinutes: input.timeSummary?.interruptedMinutes ?? 0 };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 4 * 1024 * 1024) throw new Error("The manager context exceeds safe storage capacity. Narrow assigned work.");
    if (lease) await assertManagerQueueLease(tx, lease);
    const appliedPlan = snapshot.applied ? reconciled?.plan : undefined;
    const { minute: _historyMinute, ...historyScope } = scope.fingerprintScope;
    const historyScopeHash = managerHistoryHash({ version: 1, scope: historyScope });
    const patch = process.env.APTLSS_MANAGER_COMPACT_HISTORY !== "false" && latestState.snapshot && latestState.run
      && latestState.state?.inputHash !== null
      && latestState.state?.sourceHash === fingerprint.sourceHash
      && latestState.state?.historyScopeHash === historyScopeHash
      ? managerHistoryPatch(latestState.snapshot, snapshot) : null;
    let currentCheckId: number | null = null;
    if (patch && latestState.run) {
      snapshot.runId = latestState.run.id;
      const [check] = await tx.insert(aptlssManagerChecks).values({ vaId, runId: snapshot.runId,
        ...fingerprint, baseSnapshotHash: managerHistoryHash(JSON.parse(latestState.run.snapshotJson)),
        snapshotHash: managerHistoryHash(snapshot), snapshotPatchJson: patch, createdAt: now }).$returningId();
      currentCheckId = check.id;
    } else {
      const [created] = await tx.insert(aptlssManagerRuns).values({ vaId, inputHash: fingerprint.inputHash, trigger, snapshotJson: JSON.stringify(snapshot), createdAt: now, mode: policy.mode, proposalHash: snapshot.proposalHash, previousPlanJson: snapshot.applied ? latestPlan?.scheduleJson ?? null : null, appliedPlanHash: appliedPlan ? managerPlanVersion(JSON.stringify(appliedPlan)) : null }).$returningId();
      snapshot.runId = created.id;
    }
    if (snapshot.applied && appliedPlan) {
      assertManagerPlanMutationAllowed(vaId);
      const planToApply = appliedPlan!;
      const values = { vaId, dateKey, scheduleJson: JSON.stringify(planToApply), dailySummary: reconciled!.changes.join(" ").slice(0, 4000), topPriority: planToApply.blocks[0]?.cardName ?? null, totalScheduledMinutes: planToApply.planHealth.scheduledMinutes, robertItemsCount: planToApply.robertItems.length, autoGenerated: true, generatedAt: now };
      await tx.insert(dailyPlans).values(values).onDuplicateKeyUpdate({ set: values });
    }
    await tx.insert(aptlssManagerState).values({ vaId, ...policy, ...fingerprint, currentCheckId, historyScopeHash, checkedAt: now, lastSuccessfulAt: now, lastError: null }).onDuplicateKeyUpdate({ set: { ...fingerprint, currentCheckId, historyScopeHash, mode: policy.mode, checkedAt: now, lastSuccessfulAt: now, lastError: null } });
    return snapshot;
  }, { isolationLevel: "serializable" });
  const [user] = await db.select({ openId: users.openId }).from(users).where(eq(users.id,vaId)).limit(1);
  if (user) websocketService.emitToUser(user.openId, "aptlss:manager-updated", { runId: snapshot.runId, assessedAt: snapshot.assessedAt, urgent: snapshot.interventions.some(i => i.severity === "urgent") });
  return snapshot;
}

export function runManager(vaId: number, trigger = "manual", lease?: ManagerQueueLease): Promise<ManagerSnapshot> {
  try { assertManagerPilotWorker(vaId); } catch (error) { return Promise.reject(error); }
  const pending = inflight.get(vaId);
  if (pending) return lease || trigger === "worker_update" ? pending.catch(() => null).then(() => runManager(vaId, trigger, lease)) : pending;
  let failureStateVersion: ManagerFailureStateVersion | undefined;
  const captureAssessmentStart = (state: typeof aptlssManagerState.$inferSelect | undefined) => { failureStateVersion = state ? hash(state) : null; };
  const task = executeManager(vaId, trigger, lease, captureAssessmentStart).catch(error => {
    if (error instanceof Error && error.message.startsWith("Source context changed")) return executeManager(vaId, trigger, lease, captureAssessmentStart);
    throw error;
  }).catch(async error => {
    // A leased failure belongs to the durable queue; a stale owner must not
    // overwrite worker state even when collection/model execution failed early.
    if (lease || error instanceof ManagerQueueLeaseLostError || error instanceof ManagerExecutionPausedError) throw error;
    const message = error instanceof Error && /Source context changed|safe storage capacity/.test(error.message) ? error.message : "Project manager assessment failed. Check database migrations and integration health; the previous plan remains available.";
    const db = await getDb();
    if (db && failureStateVersion !== undefined) await persistManagerFailureIfCurrent(db, vaId, failureStateVersion, message).catch(() => undefined);
    throw new Error(message);
  }).finally(() => inflight.delete(vaId));
  inflight.set(vaId, task);
  return task;
}

let interval: ReturnType<typeof setInterval> | null = null;
let runner: ReturnType<typeof createManagerQueueRunner> | null = null;
let starting: Promise<ReturnType<typeof createManagerQueueRunner>> | null = null;
let initializationFailed = false;
export function getManagerSchedulerStatus(): ManagerSchedulerStatus {
  const scope = "current_process" as const;
  if (!interval) return { scope, state: "stopped" };
  if (!runner) return { scope, state: initializationFailed ? "unavailable" : "checking" };
  const status = runner.getStatus();
  if (!status.started) return { scope, state: "checking" };
  return { scope, state: status.healthy ? "responding" : status.failed || (status.observed && !status.busy) ? "unavailable" : "checking" };
}
async function managerQueueRunner() {
  if (runner) return runner;
  if (starting) return starting;
  starting = requireDb().then(db => runner ??= createManagerQueueRunner({ db, execute: runManager,
    onError: error => console.warn("[APTLSS manager]", error.message),
  })).finally(() => { starting = null; });
  return starting;
}
export async function tickManagerScheduler() {
  if (!managerPilotEnabled()) return;
  const current = await managerQueueRunner();
  await current.pollFallback();
  await current.drain();
}
export function startManagerScheduler() {
  if (interval || !managerPilotEnabled() || process.env.APTLSS_MANAGER_SCHEDULER === "false") return;
  initializationFailed = false;
  const start = () => { void managerQueueRunner().then(current => { initializationFailed = false; if (interval) current.start(); }).catch(() => { initializationFailed = true; console.warn("[APTLSS manager] Queue unavailable; initialization will retry."); }); };
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
