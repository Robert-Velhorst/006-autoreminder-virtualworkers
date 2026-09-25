import { WORKER_EXECUTION_HOLD_MESSAGE } from "../shared/aptlssManager";

export function canStartTimerForCard(role: string, hasOperatorCard: boolean) {
  return role !== "worker" || hasOperatorCard;
}

export function timerExecutionBlockReason(input: {
  listName: string;
  hasActiveWaitingReason: boolean;
  actionability: string | null;
  hasManagerIntervention: boolean;
  executionCoverageComplete?: boolean;
}) {
  if (input.executionCoverageComplete === false) return WORKER_EXECUTION_HOLD_MESSAGE;
  if (input.hasManagerIntervention) return "APTLSS requires verification before work can continue on this card";
  if (input.hasActiveWaitingReason || /ON[\s_-]?HOLD|WAIT|BLOCK/i.test(input.listName)
    || /^(waiting|blocked)$/i.test(input.actionability ?? "")) {
    return "This card is waiting or blocked; review the reason before starting work";
  }
  return null;
}

export function managerExecutionCoverageComplete(snapshotJson: string, assignmentFingerprint: string | null) {
  const snapshot = JSON.parse(snapshotJson) as { executionCoverageComplete?: unknown; assignmentFingerprint?: unknown };
  return snapshot.executionCoverageComplete === true
    && typeof assignmentFingerprint === "string"
    && snapshot.assignmentFingerprint === assignmentFingerprint;
}

export function managerIntervenesOnCard(snapshotJson: string, cardId: string) {
  const snapshot = JSON.parse(snapshotJson) as {
    interventions?: Array<{ cardId?: string }>;
    actions?: Array<{ cardId?: string; blocked?: unknown }>;
  };
  if (!Array.isArray(snapshot.interventions)) throw new Error("Manager interventions are unavailable");
  if (snapshot.interventions.some(item => item.cardId === cardId)) return true;
  if (!Array.isArray(snapshot.actions)) return false;
  const actions = snapshot.actions.filter(item => item.cardId === cardId);
  return actions.length > 0 && actions.every(item => item.blocked === true);
}

export function canRecordWaitingReasonForCard(hasOperatorCard: boolean) {
  return hasOperatorCard;
}
