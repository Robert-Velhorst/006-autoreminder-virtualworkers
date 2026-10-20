export function indexWorkQueueSteps<T extends { cardId: string }>(steps: readonly T[]) {
  const byCardId = new Map<string, T[]>();
  for (const step of steps) {
    const cardSteps = byCardId.get(step.cardId);
    if (cardSteps) {
      cardSteps.push(step);
    } else {
      byCardId.set(step.cardId, [step]);
    }
  }
  return byCardId;
}
