import type { ManagerInput, ManagerIntervention, ManagerResult } from "../shared/aptlssManager";
import { compareManagerWork } from "../shared/aptlssManagerEvidence";

function focusedQuestion(input: ManagerInput, result: ManagerResult, issue: ManagerIntervention) {
  if (/dependency/i.test(issue.title)) return issue.question;
  const assessment = result.assessments.find(a => a.cardId === issue.cardId);
  const facts = (assessment?.facts ?? []).filter(f => f.subject === issue.cardId && issue.evidenceIds.includes(f.evidenceId));
  const conflictingTopic = facts.find(f => facts.some(other => other.topic === f.topic && other.value !== f.value))?.topic;
  if (conflictingTopic && issue.severity === "urgent")
    return `Which ${conflictingTopic} applies now? Identify the authoritative source and when the change takes effect; the retained sources disagree.`;
  const missing = assessment?.uncertainties.find(reason => reason.startsWith("Missing source-supported fact required for this task:"))?.split(":").pop()?.trim();
  if (missing === "paid") return "What is the current payment status, and which dated source confirms it? Do not make another payment until this is verified.";
  if (missing === "approved") return "Who approved this work, what exactly was approved, and which dated source records that approval?";
  if (assessment?.reliability?.freshness === "stale") return "Is the cited agreement still valid? Provide its current source or the dated replacement before continuing.";
  if (!input.evidence.some(e => e.cardId === issue.cardId)) return "Which source establishes this task's next step and prerequisites? Link the source before continuing.";
  return issue.question;
}

/** Presentation-only consolidation: all original blockers and execution gates remain. */
export function focusManagerQuestions(input: ManagerInput, result: ManagerResult): ManagerResult {
  const groups = new Map<string, ManagerIntervention[]>();
  for (const intervention of result.interventions) {
    const items = intervention.verification?.issues.map(issue => ({ ...intervention, ...issue, verification: undefined })) ?? [intervention];
    groups.set(intervention.cardId, [...(groups.get(intervention.cardId) ?? []), ...items]);
  }
  const interventions = [...groups].map(([cardId, original]) => {
    const scoped = new Map(input.evidence.filter(e => e.cardId === cardId).map(e => [e.id, e]));
    const issues = [...new Map(original.map(issue => [issue.id, { ...issue, evidenceIds: issue.evidenceIds.filter(id => scoped.has(id)) }])).values()]
      .sort((a, b) => Number(b.severity === "urgent") - Number(a.severity === "urgent"));
    const primary = issues[0];
    const evidenceIds = [...new Set(issues.flatMap(i => i.evidenceIds))];
    const facts = result.assessments.find(a => a.cardId === cardId)?.facts ?? [];
    const passages = evidenceIds.flatMap(evidenceId => {
      const evidence = scoped.get(evidenceId)!;
      // Exact retained passages, never model paraphrases masquerading as quotes.
      const quotes = [...new Set(facts.filter(f => f.evidenceId === evidenceId && evidence.text.includes(f.quote)).map(f => f.quote))];
      return (quotes.length ? quotes : [evidence.text]).map(quote => ({ evidenceId, source: evidence.source, kind: evidence.kind, quote, sender: evidence.metadata?.sender ?? null, sourceDate: evidence.metadata?.sourceDate ?? null, observedAt: evidence.observedAt, effectiveFrom: evidence.metadata?.effectiveFrom ?? null }));
    });
    return { ...primary, question: focusedQuestion(input, result, primary), evidenceIds, verification: {
      issues: issues.map(({ id, title, severity, explanation, question, evidenceIds }) => ({ id, title, severity, explanation, question, evidenceIds })), passages,
    } };
  });
  const cards = new Map(input.cards.map(card => [card.id, card]));
  interventions.sort((a, b) => {
    const urgency = Number(b.severity === "urgent") - Number(a.severity === "urgent");
    const left = cards.get(a.cardId), right = cards.get(b.cardId);
    return urgency || (left && right ? compareManagerWork(left, right, input.now) : 0);
  });
  return { ...result, interventions };
}
