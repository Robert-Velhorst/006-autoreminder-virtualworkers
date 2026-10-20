import { dateKeyInTimeZone, dayOfWeekInTimeZone } from "../shared/workerTime";

export type TrialObservation = {
  proposalHash: string;
  createdAt: Date;
  urgent: boolean;
  review: { verdict: "correct" | "incorrect" | "insufficient"; critical: boolean } | null;
};

/** This is acceptance of a measured sample, never a probability of future correctness. */
export function evaluateManagerGate(input: {
  observations: TrialObservation[];
  timezone: string;
  workingDays: number[];
  safetyVerified: boolean;
}) {
  const unique = new Map<string, TrialObservation>();
  for (const item of [...input.observations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const previous = unique.get(item.proposalHash);
    if (!previous) unique.set(item.proposalHash, item);
    else {
      const reviewedOccurrence = previous.review?.critical ? previous : item.review?.critical ? item : previous.review ? previous : item.review ? item : previous;
      unique.set(item.proposalHash, {
      ...reviewedOccurrence,
      urgent: previous.urgent || item.urgent,
      // An unreviewed repeat must not hide an earlier verdict, especially a critical one.
      review: reviewedOccurrence.review,
    });
    }
  }
  const observations = [...unique.values()].sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime());
  const reviewed = observations.filter(item => item.review);
  const sample = reviewed.slice(0, 100);
  const correct = sample.filter(item => item.review?.verdict === "correct").length;
  const critical = input.observations.filter(item => item.review?.critical).length;
  const unreviewedUrgent = observations.filter(item => item.urgent && !item.review).length;
  const workingDays = new Set(reviewed.filter(item => input.workingDays.includes(dayOfWeekInTimeZone(item.createdAt, input.timezone))).map(item => dateKeyInTimeZone(item.createdAt, input.timezone))).size;
  const reasons: string[] = [];
  if (!input.safetyVerified) reasons.push("The safety suite has not passed for this exact implementation.");
  if (workingDays < 5) reasons.push(`${workingDays}/5 working days reviewed.`);
  if (sample.length < 100) reasons.push(`${sample.length}/100 distinct proposals reviewed.`);
  if (sample.length === 100 && correct < 98) reasons.push(`${correct}/100 proposals were correct and sufficiently supported; at least 98 are required.`);
  if (critical) reasons.push(`${critical} critical errors require a new shadow trial after correction.`);
  if (unreviewedUrgent) reasons.push(`${unreviewedUrgent} urgent proposals still need founder review.`);
  return { eligible: reasons.length === 0, reasons, reviewed: sample.length, correct, workingDays, unreviewedUrgent, critical, safetyVerified: input.safetyVerified };
}
