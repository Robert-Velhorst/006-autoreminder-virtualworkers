import type { ManagerAction, ManagerEvidence, ManagerIntervention, ManagerSnapshot } from "../shared/aptlssManager";
import type { WorkerManagerComparisonSide, WorkerManagerEvidence, WorkerManagerFactComparison, WorkerManagerIntervention, WorkerManagerSnapshot, WorkerManagerPlanImpact } from "../shared/workerManagerView";
import { extractManagerFacts } from "./aptlssManagerFacts";
export type { WorkerManagerSnapshot } from "../shared/workerManagerView";

const actionKinds: ManagerAction["kind"][] = ["work", "verify", "draft", "decision", "follow_up"];
const issueKinds: NonNullable<ManagerIntervention["issueKind"]>[] = [
  "source_check", "reported_difference", "conflicting_claims", "missing_dependency", "dependency_cycle", "completion_report_pending",
];
const workerComparisonTopics = ["deadline", "paid", "approved", "completed", "status"] as const;
const workerEvidenceTruthClasses = new Set([
  "source_record", "worker_assertion", "worker_report", "human_decision", "model_proposal", "unknown",
]);
const nonWorkerEvidenceSources = new Set([
  "decision_outcome", "model", "model_proposal", "semantic_review", "openai-api", "codex-subscription",
  "system_inference", "system-inference",
]);

function safeText(value: unknown, limit: number, fallback = "") {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) || fallback : fallback;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function safeSlot(slot: { startTime: string; endTime: string } | null | undefined) {
  if (!slot) return null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(slot.startTime) || !time.test(slot.endTime)) return null;
  return { startTime: slot.startTime, endTime: slot.endTime };
}

function actionReason(kind: ManagerAction["kind"], blocked: boolean) {
  if (blocked) return "This step stays paused until its required condition is confirmed.";
  switch (kind) {
    case "verify": return "Check the cited source before continuing.";
    case "draft": return "Prepare a draft for review; do not send it.";
    case "decision": return "Wait for the required decision before continuing.";
    case "follow_up": return "Complete the scheduled follow-up and record the result.";
    default: return "Complete the next recorded work step.";
  }
}

function interventionGuidance(issueKind: ManagerIntervention["issueKind"]) {
  switch (issueKind) {
    case "source_check": return {
      title: "Check the original message",
      explanation: "The original source has not yet been checked for the request and any deadline.",
      question: "What does the message ask you to do, and does it include a deadline?",
      safeAction: "Open the cited source and record what it asks for and any deadline.",
    };
    case "reported_difference": return {
      title: "Check the reported update",
      explanation: "A reported update needs to be checked against the cited source.",
      question: "What changed, and which cited source confirms the current information?",
      safeAction: "Compare the report with the cited source and record the confirmed information.",
    };
    case "conflicting_claims": return {
      title: "Compare the cited sources",
      explanation: "The cited sources disagree about information needed for this task.",
      question: "Which source is authoritative, and from what date does that information apply?",
      safeAction: "Compare the cited sources and record which information applies and from when.",
    };
    case "missing_dependency": return {
      title: "Confirm the required earlier step",
      explanation: "A required earlier step or piece of evidence is not confirmed.",
      question: "Which completed step or source record confirms this requirement?",
      safeAction: "Check the cited record or completed step that satisfies this requirement.",
    };
    case "dependency_cycle": return {
      title: "Clarify the task order",
      explanation: "The recorded task order needs clarification before work can continue.",
      question: "Which step must happen first? Ask your supervisor before proceeding.",
      safeAction: "Ask your supervisor to confirm the correct order before proceeding.",
    };
    case "completion_report_pending": return {
      title: "Verify the completion report",
      explanation: "Your completion report has not yet been confirmed by the assigned source.",
      question: "Where can the completed result be checked in the linked source?",
      safeAction: "Check the linked source and report what is still missing, if anything.",
    };
    default: return {
      title: "Check this task",
      explanation: "A task condition needs to be checked before the next step.",
      question: "What does the cited source confirm about this task?",
      safeAction: "Open the cited source and confirm the information needed to continue.",
    };
  }
}

function toWorkerEvidence(item: ManagerEvidence, cardIds: Set<string>): WorkerManagerEvidence | null {
  const metadata = item.metadata;
  const sourceName = safeText(item.source, 128).toLowerCase();
  const rawTruthClass: unknown = metadata?.truthClass;
  const truthClass = typeof rawTruthClass === "string" ? rawTruthClass.trim().toLowerCase() : undefined;
  if (!cardIds.has(item.cardId) || nonWorkerEvidenceSources.has(sourceName) || (item.kind !== "source" && item.kind !== "worker")
    || (rawTruthClass !== undefined && (typeof rawTruthClass !== "string" || !workerEvidenceTruthClasses.has(truthClass ?? "")))
    || truthClass === "human_decision" || truthClass === "model_proposal" || truthClass === "unknown") return null;
  const workerOrigin = /^worker(?:_|$)/i.test(sourceName);
  const kind: WorkerManagerEvidence["kind"] = item.kind === "worker" || workerOrigin || truthClass === "worker_assertion" || truthClass === "worker_report"
    ? "worker"
    : "source";
  const reportKind = kind === "worker" && metadata?.reportKind === "completion" ? "completion" : undefined;
  const projectedMetadata: NonNullable<WorkerManagerEvidence["metadata"]> = {
    ...(kind === "source" && metadata?.sender ? { sender: safeText(metadata.sender, 512) } : {}),
    ...(kind === "source" && typeof metadata?.sourceDate === "string" ? { sourceDate: safeText(metadata.sourceDate, 128) } : {}),
    ...(kind === "source" && typeof metadata?.effectiveFrom === "string" ? { effectiveFrom: safeText(metadata.effectiveFrom, 128) } : {}),
    ...(kind === "source" && typeof metadata?.sourceRecordId === "string" ? { sourceRecordId: safeText(metadata.sourceRecordId, 256) } : {}),
    ...(kind === "source" && (metadata?.contentScope === "portal_notice" || metadata?.contentScope === "message_preview") ? { contentScope: metadata.contentScope } : {}),
    ...(reportKind ? { reportKind } : {}),
    ...(reportKind && typeof metadata?.reportDetail === "string" ? { reportDetail: safeText(metadata.reportDetail, 8000) } : {}),
    ...(reportKind && typeof metadata?.sourceDescription === "string" ? { sourceDescription: safeText(metadata.sourceDescription, 512) } : {}),
    ...(reportKind && typeof metadata?.sourceEvidenceId === "string" ? { sourceEvidenceId: safeText(metadata.sourceEvidenceId, 256) } : {}),
  };
  return {
    id: safeText(item.id, 256),
    cardId: item.cardId,
    source: safeText(item.source, 128),
    text: safeText(item.text, 8000),
    observedAt: safeText(item.observedAt, 128),
    url: kind === "source" ? safeHttpUrl(item.url) : null,
    kind,
    ...(Object.keys(projectedMetadata).length ? { metadata: projectedMetadata } : {}),
  };
}

function toWorkerComparisonSide(
  side: NonNullable<NonNullable<ManagerIntervention["verification"]>["comparisons"]>[number]["left"],
  subject: string,
  topic: WorkerManagerFactComparison["topic"],
  cardId: string,
  citedIds: Set<string>,
  evidenceById: Map<string, ManagerEvidence[]>,
  projectedEvidenceById: Map<string, WorkerManagerEvidence[]>,
): WorkerManagerComparisonSide | null {
  if (!citedIds.has(side.evidenceId)) return null;
  const originals = evidenceById.get(side.evidenceId) ?? [];
  const projected = projectedEvidenceById.get(side.evidenceId) ?? [];
  if (originals.length !== 1 || projected.length !== 1) return null;
  const original = originals[0];
  const evidence = projected[0];
  if (original.cardId !== cardId || evidence.cardId !== cardId || (original.kind !== "source" && original.kind !== "worker")) return null;

  const supportedFact = extractManagerFacts(original).find(fact =>
    fact.subject === subject &&
    fact.topic === topic &&
    fact.value === side.value &&
    fact.quote === side.quote &&
    fact.support === "explicit" &&
    fact.truthClass !== "model_proposal" &&
    fact.truthClass !== "unknown"
  );
  if (!supportedFact) return null;

  return {
    evidenceId: evidence.id,
    value: safeText(supportedFact.value, 256),
    quote: safeText(supportedFact.quote, 1200),
    source: evidence.source,
    kind: evidence.kind,
    sender: evidence.kind === "source" ? evidence.metadata?.sender ?? null : null,
    sourceDate: evidence.metadata?.sourceDate ?? null,
    url: evidence.url ?? null,
  };
}

function toWorkerComparisons(
  comparisons: NonNullable<NonNullable<ManagerIntervention["verification"]>["comparisons"]> | undefined,
  cardId: string,
  citedIds: Set<string>,
  evidenceById: Map<string, ManagerEvidence[]>,
  projectedEvidenceById: Map<string, WorkerManagerEvidence[]>,
): WorkerManagerFactComparison[] {
  if (!comparisons) return [];
  const result: WorkerManagerFactComparison[] = [];
  for (const comparison of comparisons.slice(0, 24)) {
    if (!workerComparisonTopics.includes(comparison.topic as WorkerManagerFactComparison["topic"])) continue;
    const topic = comparison.topic as WorkerManagerFactComparison["topic"];
    const left = toWorkerComparisonSide(comparison.left, comparison.subject, topic, cardId, citedIds, evidenceById, projectedEvidenceById);
    const right = toWorkerComparisonSide(comparison.right, comparison.subject, topic, cardId, citedIds, evidenceById, projectedEvidenceById);
    if (!left || !right || left.value === right.value) continue;
    result.push({ topic, left, right });
    if (result.length >= 12) break;
  }
  return result;
}

function workerPlanBlockOwners(snapshot: ManagerSnapshot) {
  const owners = new Map<string, Set<string>>();
  const addOwner = (blockId: unknown, cardId: unknown) => {
    if (typeof blockId !== "string" || !blockId || typeof cardId !== "string" || !cardId) return;
    const cardIds = owners.get(blockId) ?? new Set<string>();
    cardIds.add(cardId);
    owners.set(blockId, cardIds);
  };

  for (const block of snapshot.proposal?.blocks ?? []) addOwner(block.id, block.cardId);
  for (const action of snapshot.actions) addOwner(action.id, action.cardId);
  for (const deadline of snapshot.proposal?.planningImpact?.deadlines ?? []) {
    for (const blockId of [...deadline.before.blockIds, ...deadline.after.blockIds]) addOwner(blockId, deadline.cardId);
  }
  return owners;
}

function toWorkerPlanImpact(
  impact: NonNullable<ManagerSnapshot["proposal"]>["planningImpact"],
  cardIds: Set<string>,
  blockOwners: Map<string, Set<string>>,
): WorkerManagerPlanImpact | undefined {
  if (!impact) return undefined;
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(impact.dateKey) ? impact.dateKey : "";
  const planChanges = impact.planChanges?.filter(change => {
    const owners = blockOwners.get(change.blockId);
    if (!owners || owners.size !== 1) return false;
    const [ownerCardId] = owners;
    return cardIds.has(ownerCardId);
  }).map((change, index) => ({
    kind: change.kind,
    blockId: `worker-plan-change-${index + 1}`,
    cardName: safeText(change.cardName, 512),
    before: safeSlot(change.before),
    after: safeSlot(change.after),
    reason: change.kind === "added" ? "A time block is proposed for this task."
      : change.kind === "moved" ? "The proposed time for this task is different."
        : change.kind === "removed" ? "This task is not included in the proposed schedule."
          : "The proposed work block has changed.",
  }));
  return {
    dateKey,
    baseline: ["same_day_plan", "different_day_plan", "no_plan"].includes(impact.baseline) ? impact.baseline : "no_plan",
    scheduleChanged: impact.scheduleChanged === true,
    requiresReview: impact.requiresReview === true,
    availabilityChanged: impact.availabilityChanged === true,
    ...(planChanges ? { planChanges } : {}),
    protectedBlocks: (impact.protectedBlocks ?? []).map(block => ({ preservedExactly: block.preservedExactly === true })),
  };
}

export function toWorkerManagerSnapshot(snapshot: ManagerSnapshot): WorkerManagerSnapshot {
  const cards = [...new Map(snapshot.cards.filter(card => safeText(card.id, 256)).map(card => [card.id, {
    id: safeText(card.id, 256),
    name: safeText(card.name, 512, "Untitled work item"),
    url: safeHttpUrl(card.url),
    board: safeText(card.board, 512),
    list: safeText(card.list, 512),
  }])).values()];
  const cardIds = new Set(cards.map(card => card.id));
  const planBlockOwners = workerPlanBlockOwners(snapshot);
  const projectedEvidence = snapshot.evidence.map(item => toWorkerEvidence(item, cardIds)).filter((item): item is WorkerManagerEvidence => !!item && !!item.id);
  const sourceEvidenceIdsByCard = new Map<string, Set<string>>();
  for (const item of projectedEvidence) if (item.kind === "source") {
    const ids = sourceEvidenceIdsByCard.get(item.cardId) ?? new Set<string>();
    ids.add(item.id);
    sourceEvidenceIdsByCard.set(item.cardId, ids);
  }
  const evidence = projectedEvidence.map(item => {
    const sourceEvidenceId = item.metadata?.sourceEvidenceId;
    if (!sourceEvidenceId || sourceEvidenceIdsByCard.get(item.cardId)?.has(sourceEvidenceId)) return item;
    const { sourceEvidenceId: _sourceEvidenceId, ...metadata } = item.metadata!;
    return { ...item, metadata };
  });
  const evidenceById = new Map<string, ManagerEvidence[]>();
  for (const item of snapshot.evidence) {
    const items = evidenceById.get(item.id) ?? [];
    items.push(item);
    evidenceById.set(item.id, items);
  }
  const projectedEvidenceById = new Map<string, WorkerManagerEvidence[]>();
  for (const item of evidence) {
    const items = projectedEvidenceById.get(item.id) ?? [];
    items.push(item);
    projectedEvidenceById.set(item.id, items);
  }
  const evidenceIdsByCard = new Map<string, Set<string>>();
  for (const item of evidence) {
    const ids = evidenceIdsByCard.get(item.cardId) ?? new Set<string>();
    ids.add(item.id);
    evidenceIdsByCard.set(item.cardId, ids);
  }
  const actions: WorkerManagerSnapshot["actions"] = snapshot.actions.flatMap(action => {
    if (!cardIds.has(action.cardId) || !actionKinds.includes(action.kind)) return [];
    const blocked = action.blocked === true;
    const minutes = [action.minutes.low, action.minutes.likely, action.minutes.high].map(value => Number.isFinite(value) && value >= 0 ? value : 0);
    return [{
      id: safeText(action.id, 256),
      cardId: action.cardId,
      title: safeText(action.title, 256, "Continue work"),
      where: safeText(action.where, 512),
      kind: action.kind,
      reason: actionReason(action.kind, blocked),
      blocked,
      completionCriteria: safeText(action.completionCriteria, 1000),
      stepIds: [...new Set(action.stepIds.filter(Number.isSafeInteger))].slice(0, 200),
      minutes: { low: minutes[0], likely: minutes[1], high: minutes[2] },
    }];
  }).filter(action => !!action.id);
  const interventions: WorkerManagerIntervention[] = snapshot.interventions.flatMap(intervention => {
    if (!cardIds.has(intervention.cardId)) return [];
    const issueKind = issueKinds.includes(intervention.issueKind as NonNullable<ManagerIntervention["issueKind"]>) ? intervention.issueKind : undefined;
    const citedIds = evidenceIdsByCard.get(intervention.cardId) ?? new Set<string>();
    const evidenceIds = [...new Set(intervention.evidenceIds.filter(id => citedIds.has(id)))];
    const passages = evidence.filter(item => item.cardId === intervention.cardId && evidenceIds.includes(item.id)).map(item => ({
      evidenceId: item.id,
      source: item.source,
      kind: item.kind,
      quote: item.text,
      sender: item.kind === "source" ? item.metadata?.sender ?? null : null,
      sourceDate: item.metadata?.sourceDate ?? null,
      sourceRecordId: item.metadata?.sourceRecordId ?? null,
      observedAt: item.observedAt,
      effectiveFrom: item.metadata?.effectiveFrom ?? null,
    }));
    const comparisons = intervention.issueKind === "conflicting_claims"
      ? toWorkerComparisons(intervention.verification?.comparisons, intervention.cardId, new Set(evidenceIds), evidenceById, projectedEvidenceById)
      : [];
    const verification = { issues: [] as [], passages, ...(comparisons.length ? { comparisons } : {}) };
    const guidance = interventionGuidance(issueKind);
    return [{
      id: safeText(intervention.id, 256),
      cardId: intervention.cardId,
      ...(issueKind ? { issueKind } : {}),
      severity: intervention.severity === "urgent" ? "urgent" as const : "attention" as const,
      title: guidance.title,
      explanation: guidance.explanation,
      question: guidance.question,
      safeAction: guidance.safeAction,
      evidenceIds,
      verification,
    }];
  }).filter(intervention => !!intervention.id);
  return {
    executionReady: snapshot.executionCoverageComplete === true,
    actions,
    interventions,
    cards,
    evidence,
    ...(typeof snapshot.applied === "boolean" ? { applied: snapshot.applied } : {}),
    ...(typeof snapshot.planVersion === "string" ? { planVersion: safeText(snapshot.planVersion, 128) } : {}),
    ...(snapshot.proposal ? { proposal: { planningImpact: toWorkerPlanImpact(snapshot.proposal.planningImpact, cardIds, planBlockOwners) } } : {}),
  };
}

export function toWorkerManagerStatus<TCheckedAt extends Date | string | null, TLastSuccessfulAt extends Date | string | null>(status: {
  snapshot: ManagerSnapshot | null;
  policy: { enabled: boolean; intervalMinutes: number; mode: "shadow" | "active" };
  checkedAt?: TCheckedAt;
  lastSuccessfulAt?: TLastSuccessfulAt;
  error?: string;
  queue?: unknown;
  scheduler?: import("../shared/aptlssManager").ManagerSchedulerStatus;
}) {
  return {
    snapshot: status.snapshot ? toWorkerManagerSnapshot(status.snapshot) : null,
    policy: {
      enabled: status.policy.enabled === true,
      intervalMinutes: Number.isInteger(status.policy.intervalMinutes) ? Math.min(60, Math.max(1, status.policy.intervalMinutes)) : 5,
      mode: status.policy.mode === "active" ? "active" as const : "shadow" as const,
    },
    error: status.error ? "Work guidance could not be refreshed. Try again shortly, and contact your supervisor if it continues." : undefined,
    checkedAt: status.checkedAt ?? null,
    lastSuccessfulAt: status.lastSuccessfulAt ?? null,
    scheduler: {
      scope: "current_process" as const,
      state: status.scheduler?.scope === "current_process"
        && ["stopped", "checking", "responding", "unavailable"].includes(status.scheduler.state)
        ? status.scheduler.state : "unavailable" as const,
    },
  };
}
