export function canStartTimerForCard(role: string, hasOperatorCard: boolean) {
  return role !== "worker" || hasOperatorCard;
}

export function canRecordWaitingReasonForCard(hasOperatorCard: boolean) {
  return hasOperatorCard;
}
