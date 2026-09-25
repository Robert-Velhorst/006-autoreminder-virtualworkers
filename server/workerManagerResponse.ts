import type { ManagerSnapshot } from "../shared/aptlssManager";
import type { WorkerManagerSnapshot, WorkerManagerPlanImpact } from "../shared/workerManagerView";
export type { WorkerManagerSnapshot } from "../shared/workerManagerView";

function toWorkerPlanImpact(impact: NonNullable<ManagerSnapshot["proposal"]>["planningImpact"]): WorkerManagerPlanImpact | undefined {
  if (!impact) return undefined;
  return {
    dateKey: impact.dateKey,
    baseline: impact.baseline,
    scheduleChanged: impact.scheduleChanged,
    requiresReview: impact.requiresReview,
    availabilityChanged: impact.availabilityChanged,
    planChanges: impact.planChanges?.map(({ kind, blockId, cardName, before, after, reason }) => ({ kind, blockId, cardName, before, after, reason })),
    protectedBlocks: impact.protectedBlocks.map(({ preservedExactly }) => ({ preservedExactly })),
  };
}

export function toWorkerManagerSnapshot(snapshot: ManagerSnapshot): WorkerManagerSnapshot {
  return {
    actions: snapshot.actions.map(({ id, cardId, title, where, kind, reason, blocked, minutes }) => ({
      id, cardId, title, where, kind, reason, blocked,
      minutes: { low: minutes.low, likely: minutes.likely, high: minutes.high },
    })),
    interventions: snapshot.interventions,
    cards: snapshot.cards,
    evidence: snapshot.evidence,
    applied: snapshot.applied,
    planVersion: snapshot.planVersion,
    proposal: snapshot.proposal ? { planningImpact: toWorkerPlanImpact(snapshot.proposal.planningImpact) } : undefined,
  };
}

export function toWorkerManagerStatus<T extends { snapshot: ManagerSnapshot | null; queue?: unknown; error?: string }>(status: T) {
  const { snapshot, queue: _queue, error, ...workerStatus } = status;
  return {
    ...workerStatus,
    snapshot: snapshot ? toWorkerManagerSnapshot(snapshot) : null,
    error: error ? "Work guidance could not be refreshed. Try again shortly, and contact your supervisor if it continues." : undefined,
  };
}
