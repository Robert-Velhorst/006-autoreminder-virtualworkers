type StoredStep = { id: number; cardId: string; stepNumber: number; status?: string };

/** Legacy plans mix local step numbers, database IDs and whole-card references. */
export function normalizeManagerDependencies(
  cardId: string,
  references: string[],
  steps: readonly StoredStep[]
): string[] {
  const currentSteps = steps.filter(step => step.status !== "obsolete");
  return [...new Set(references.flatMap(raw => {
    const ref = raw.trim();
    const ordinal = /^step\s+([1-9]\d*)$/i.exec(ref);
    if (ordinal) {
      const matches = currentSteps.filter(s => s.cardId === cardId && s.stepNumber === Number(ordinal[1]));
      return matches.length === 1 ? [`${cardId}:${matches[0].id}`] : [`unresolved:${ref}`];
    }
    // Qualified references already identify a database step, not an ordinal.
    const qualified = /^([^:]+):(\d+)$/.exec(ref);
    if (qualified) {
      const matches = steps.filter(s => s.cardId === qualified[1] && s.id === Number(qualified[2]));
      return matches.length === 1 && matches[0].status !== "obsolete"
        ? [`${matches[0].cardId}:${matches[0].id}`]
        : [`unresolved:${ref}`];
    }
    if (/^\d+$/.test(ref)) {
      const n = Number(ref);
      const matches = [...new Map([
        ...steps.filter(s => s.id === n),
        ...currentSteps.filter(s => s.cardId === cardId && s.stepNumber === n),
      ].map(step => [`${step.cardId}:${step.id}`, step])).values()];
      return matches.length === 1 && matches[0].status !== "obsolete"
        ? [`${matches[0].cardId}:${matches[0].id}`]
        : [`unresolved:${ref}`];
    }
    const cardSteps = currentSteps.filter(s => s.cardId === ref);
    return cardSteps.length ? cardSteps.map(s => `${s.cardId}:${s.id}`) : [`unresolved:${ref}`];
  }))];
}
