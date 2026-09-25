export function canStartTimerForCard(role: string, hasOperatorCard: boolean) {
  return role !== "worker" || hasOperatorCard;
}

export function timerExecutionBlockReason(input: {
  listName: string;
  hasActiveWaitingReason: boolean;
  actionability: string | null;
  hasManagerIntervention: boolean;
}) {
  if (input.hasManagerIntervention) return "APTLSS requires verification before work can continue on this card";
  if (input.hasActiveWaitingReason || /ON[\s_-]?HOLD|WAIT|BLOCK/i.test(input.listName)
    || /^(waiting|blocked)$/i.test(input.actionability ?? "")) {
    return "This card is waiting or blocked; review the reason before starting work";
  }
  return null;
}

export function managerIntervenesOnCard(snapshotJson: string, cardId: string) {
  const snapshot = JSON.parse(snapshotJson) as { interventions?: Array<{ cardId?: string }> };
  if (!Array.isArray(snapshot.interventions)) throw new Error("Manager interventions are unavailable");
  return snapshot.interventions.some(item => item.cardId === cardId);
}

export function canRecordWaitingReasonForCard(hasOperatorCard: boolean) {
  return hasOperatorCard;
}
