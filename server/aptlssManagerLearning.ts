import type { ManagerAction, ManagerInput, ManagerResult } from "../shared/aptlssManager";
import { unsafeManagerText } from "./aptlssManagerFacts";
import { compareManagerWork, validManagerTimestamp } from "../shared/aptlssManagerEvidence";
import { managerExternalAction } from "./aptlssManagerEngine";

export function safeManagerReviewedStep(step: { title: string; completionCriteria: string }): boolean {
  const text = `${step.title} ${step.completionCriteria}`;
  return !unsafeManagerText.test(text) && !managerExternalAction(text) && !/\bmark\b.{0,40}\bcomplete\b/i.test(text);
}

/** Reviewed handling guidance is not a new source fact and cannot grant execution rights. */
export function applyManagerLearning(input: ManagerInput, original: ManagerResult): ManagerResult {
  if (!input.learning) return original;
  const result = structuredClone(original);
  const blocked = new Map<string, { topics: Set<string>; evidenceIds: Set<string> }>();
  for (const action of result.actions) {
    const withheld = input.learning.withheld.filter(w => w.cardId === action.cardId && w.actionKind === action.kind && (!w.actionId || w.actionId === action.id));
    const candidates = input.learning.guidance.filter(g => g.cardId === action.cardId && g.actionKind === action.kind && (!g.nextStep || g.nextStep.actionId === action.id) && validManagerTimestamp(g.validUntil) && Date.parse(g.validUntil) > Date.parse(input.now));
    const valid = candidates.filter(g => !unsafeManagerText.test(g.correction) && (!g.nextStep || safeManagerReviewedStep(g.nextStep)) && g.evidenceIds.length > 0 && g.evidenceIds.every(id => input.evidence.some(e => e.id === id && (g.scope === "worker" || e.cardId === action.cardId) && e.kind !== "worker")));
    const invalid = candidates.filter(g => !valid.includes(g));
    const amendments = valid.filter(g => g.nextStep);
    const conflictingAmendments = new Set(amendments.map(g => JSON.stringify(g.nextStep))).size > 1;
    if (valid.length && !conflictingAmendments) {
      action.reviewedGuidance = valid;
      action.reason += valid.map(g => ` Reviewed guidance (${g.topic}): ${g.correction}`).join("");
      action.evidenceIds = [...new Set([...action.evidenceIds, ...valid.flatMap(g => g.evidenceIds)])];
      if (amendments[0]?.nextStep) {
        action.title = amendments[0].nextStep.title;
        action.completionCriteria = amendments[0].nextStep.completionCriteria;
      }
    }
    if (withheld.length || invalid.length || conflictingAmendments) {
      action.blocked = true;
      const item = blocked.get(action.cardId) ?? { topics: new Set<string>(), evidenceIds: new Set<string>() };
      for (const w of [...withheld, ...invalid, ...(conflictingAmendments ? amendments : [])]) item.topics.add(w.topic);
      for (const id of [...invalid, ...(conflictingAmendments ? amendments : [])].flatMap(g => g.evidenceIds)) if (input.evidence.some(e => e.id === id && e.cardId === action.cardId)) item.evidenceIds.add(id);
      blocked.set(action.cardId, item);
    }
  }
  for (const [cardId, issue] of blocked) {
    const topics = [...issue.topics].sort().join(", ");
    const id = `learning-verify:${cardId}`;
    const question = `Which reviewed guidance applies to ${topics}? Ask the founder to correct or withdraw the conflicting or unsupported guidance.`;
    const evidenceIds = [...issue.evidenceIds];
    result.interventions.push({ id, cardId, severity: "urgent", title: "Verify reviewed guidance", question,
      explanation: "Reviewed handling guidance is conflicting, unsafe or missing its supporting source. It has not been used to authorize work.",
      safeAction: "Keep the affected step paused; verify the guidance with the founder.", evidenceIds });
    const verification: ManagerAction = { id, cardId, title: question, where: "Founder review", kind: "verify", stepIds: [], dependsOn: [],
      minutes: { low: 5, likely: 10, high: 20, samples: 0, basis: "Initial verification estimate" }, reason: "Reviewed guidance requires clarification",
      completionCriteria: "Founder corrects or revokes the guidance with supporting source evidence.", evidenceIds, notBefore: null, blocked: false, priority: 1000, draft: null };
    result.actions.push(verification);
  }
  const cards = new Map(input.cards.map(card => [card.id, card]));
  const urgentCards = new Set(result.interventions.filter(i => i.severity === "urgent").map(i => i.cardId));
  // New verification work is urgent; stable sorting preserves each card's existing
  // step topology while using the same work-state/deadline order as the planner.
  result.actions.sort((a, b) => {
    const urgent = Number(b.kind === "verify" && urgentCards.has(b.cardId)) - Number(a.kind === "verify" && urgentCards.has(a.cardId));
    const left = cards.get(a.cardId), right = cards.get(b.cardId);
    return urgent || (left && right ? compareManagerWork(left, right, input.now) : 0);
  });
  for (const assessment of result.assessments) {
    assessment.actions = result.actions.filter(a => a.cardId === assessment.cardId);
    assessment.evidenceIds = [...new Set([...assessment.evidenceIds, ...assessment.actions.flatMap(a => a.reviewedGuidance?.flatMap(g => g.evidenceIds) ?? [])])];
    if (blocked.has(assessment.cardId)) {
      assessment.state = "NEEDS_VERIFICATION";
      assessment.uncertainties.push("Reviewed guidance needs founder verification.");
      if (assessment.reliability) {
        assessment.reliability.support = "unknown";
        assessment.reliability.reasons.push("Reviewed guidance needs founder verification.");
      }
    }
  }
  return result;
}
