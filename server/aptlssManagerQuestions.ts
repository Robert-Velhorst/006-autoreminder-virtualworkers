import type { ManagerInput, ManagerIntervention, ManagerResult } from "../shared/aptlssManager";
import { compareManagerWork } from "../shared/aptlssManagerEvidence";
import { gmailContentScope } from "../shared/gmailContentScope";

type ManagerFact = NonNullable<ManagerResult["assessments"][number]["facts"]>[number];

function issueSupportsFactComparison(issue: ManagerIntervention) {
  if (issue.issueKind) return issue.issueKind === "conflicting_claims" || issue.issueKind === "reported_difference";
  return /\b(?:conflict|disagree)\b|which\b.{0,80}\b(?:fact|claim|deadline|status|payment|authoritative|applies)\b/i.test(`${issue.title} ${issue.question}`);
}

function isNotificationOnlySource(evidence: ManagerInput["evidence"][number]) {
  return evidence.source === "gmail" && evidence.kind === "source" &&
    (evidence.metadata?.contentScope === "portal_notice" || gmailContentScope("", evidence.text) === "portal_notice");
}

function hasExplicitConflict(facts: ManagerFact[]) {
  return facts.some(fact => facts.some(other => other.evidenceId !== fact.evidenceId && other.topic === fact.topic && other.value !== fact.value));
}

function citedExplicitFacts(issue: ManagerIntervention, result: ManagerResult, evidenceById: Map<string, ManagerInput["evidence"][number]>) {
  const assessment = result.assessments.find(item => item.cardId === issue.cardId);
  return (assessment?.facts ?? []).filter(fact => {
    const evidence = evidenceById.get(fact.evidenceId);
    return fact.subject === issue.cardId && issue.evidenceIds.includes(fact.evidenceId) && evidence?.text.includes(fact.quote) === true &&
      !isNotificationOnlySource(evidence) && fact.support === "explicit" && fact.topic !== "context" && fact.truthClass !== "model_proposal";
  });
}

const humanFactTopics: Record<string, string> = {
  deadline: "deadline",
  paid: "payment status",
  approved: "approval",
  completed: "completion status",
  status: "status",
};

function normalizedText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function supportedFactValue(fact: ManagerFact, evidence: ManagerInput["evidence"][number]) {
  const value = fact.value.trim();
  const quote = fact.quote.trim();
  if (!value || value.length > 120 || /[\r\n]/.test(value) || !evidence.text.includes(fact.quote)) return null;
  if (!normalizedText(quote).includes(normalizedText(value))) return null;
  if (/(?:^|\s)(?:action|step|card|dependency|ref|id)\s*[:#_-]\s*[a-z0-9_-]+|^[a-f0-9-]{24,}$/i.test(value)) return null;
  return value;
}

function supportedCitedFacts(issue: ManagerIntervention, result: ManagerResult, evidenceById: Map<string, ManagerInput["evidence"][number]>) {
  return citedExplicitFacts(issue, result, evidenceById).filter(fact => {
    const evidence = evidenceById.get(fact.evidenceId);
    return evidence !== undefined && supportedFactValue(fact, evidence) !== null;
  });
}

function factSourceLabel(fact: ManagerFact, evidence: ManagerInput["evidence"][number]) {
  if (fact.truthClass === "worker_report" || evidence.kind === "worker") return "worker report";
  const labels: Record<string, string> = { gmail: "Gmail", trello: "Trello", google_drive: "Google Drive" };
  return labels[evidence.source] ?? "cited source";
}

function safeSourceDetail(value: string | null | undefined) {
  const detail = value?.trim().replace(/\s+/g, " ");
  if (!detail || detail.length > 80 || /(?:^|\s)(?:action|step|card|dependency|ref|id)\s*[:#_-]\s*[a-z0-9_-]+|^[a-f0-9-]{24,}$/i.test(detail)) return null;
  return detail;
}

function hasReadableSource(issue: ManagerIntervention, evidenceById: Map<string, ManagerInput["evidence"][number]>) {
  return issue.evidenceIds.some(id => {
    const evidence = evidenceById.get(id);
    return evidence?.kind === "source" && !isNotificationOnlySource(evidence);
  });
}

function conflictFor(issue: ManagerIntervention, facts: ManagerFact[], evidenceById: Map<string, ManagerInput["evidence"][number]>) {
  if (!issueSupportsFactComparison(issue)) return null;
  for (const fact of facts) {
    const topic = humanFactTopics[fact.topic];
    if (!topic) continue;
    const conflicting = facts.filter(other => other.topic === fact.topic && other.evidenceId !== fact.evidenceId && other.value !== fact.value);
    if (conflicting.length) {
      const alternatives = [...new Map([fact, ...conflicting].map(candidate => {
        const evidence = evidenceById.get(candidate.evidenceId);
        const value = evidence ? supportedFactValue(candidate, evidence) : null;
        if (!evidence || !value) return null;
        const source = factSourceLabel(candidate, evidence);
        const sender = safeSourceDetail(evidence.metadata?.sender ?? candidate.sender);
        const detail = [source, sender].filter(Boolean).join(", ");
        return [value, `${value}${detail ? ` (${detail})` : ""}`] as const;
      }).filter((item): item is readonly [string, string] => item !== null)).values()];
      if (alternatives.length > 1) return { topic, alternatives };
    }
  }
  return null;
}

function normalizeNotificationOnlyConflict(issue: ManagerIntervention, facts: ManagerFact[], evidenceById: Map<string, ManagerInput["evidence"][number]>) {
  const citesNotificationOnlySource = issue.evidenceIds.some(id => {
    const evidence = evidenceById.get(id);
    return evidence !== undefined && isNotificationOnlySource(evidence);
  });
  if (issue.issueKind !== "conflicting_claims" || !citesNotificationOnlySource || hasExplicitConflict(facts)) return issue;
  return {
    ...issue,
    issueKind: "source_check" as const,
    severity: "attention" as const,
    title: "Check the original source before continuing",
    explanation: "The linked email is only a notification; the underlying correspondence has not been checked.",
    safeAction: "Open the original email or linked source and record its requested action and any deadline.",
  };
}

function normalizeLegacyDependencyKind(issue: ManagerIntervention) {
  return !issue.issueKind && /\bmissing dependency\b/i.test(issue.title)
    ? { ...issue, issueKind: "missing_dependency" as const }
    : issue;
}

function workerGuidance(issue: ManagerIntervention, facts: ManagerFact[], evidenceById: Map<string, ManagerInput["evidence"][number]>, assessment?: ManagerResult["assessments"][number]) {
  const conflict = conflictFor(issue, facts, evidenceById);
  if (conflict) {
    return {
      title: `Different ${conflict.topic} values are recorded`,
      explanation: `The cited passages record different ${conflict.topic} values. Confirm which source is authoritative before continuing.`,
      question: `Which ${conflict.topic} is authoritative: ${conflict.alternatives.join(" or ")}?`,
      safeAction: "Compare the cited passages and record which source is authoritative and when its value applies. Keep dependent work on hold until confirmed.",
    };
  }

  const issueKind = issue.issueKind ?? (/\bmissing dependency\b/i.test(issue.title) ? "missing_dependency" : undefined);
  const missingFact = assessment?.uncertainties.find(reason => reason.startsWith("Missing source-supported fact required for this task:"))?.split(":").pop()?.trim();
  if (!issueKind && missingFact === "paid") {
    return {
      title: "Verify the current payment status",
      explanation: "The current record does not establish whether payment has been made.",
      question: "What payment status does the current dated source record show?",
      safeAction: "Check the current dated payment record. Do not make another payment until the status is verified.",
    };
  }
  if (!issueKind && missingFact === "approved") {
    return {
      title: "Verify the approval",
      explanation: "The approval record needed for the next step has not been identified.",
      question: "What does the approval record authorize?",
      safeAction: "Check the approval record and proceed only within its stated scope. Ask your supervisor if no authoritative record is available.",
    };
  }
  if (!issueKind && assessment?.reliability?.freshness === "stale") {
    return {
      title: "Check whether the agreement is current",
      explanation: "The cited agreement may no longer reflect the current arrangement.",
      question: "Which current source confirms whether this agreement is still valid?",
      safeAction: "Find a current dated source before acting. Keep dependent work on hold if the agreement cannot be confirmed.",
    };
  }

  switch (issueKind) {
    case "source_check": {
      const hasSourceRecord = issue.evidenceIds.some(id => evidenceById.get(id)?.kind === "source");
      const noticeOnly = issue.evidenceIds.some(id => {
        const evidence = evidenceById.get(id);
        return evidence !== undefined && isNotificationOnlySource(evidence);
      });
      return {
        title: "Check the original source before continuing",
        explanation: noticeOnly
          ? "The email only announces a message; its underlying correspondence has not been reviewed."
          : "The cited source must be checked before its requested action or deadline can be established.",
        question: hasSourceRecord
          ? "What does the original email or linked source say, or what access issue prevents you from opening it?"
          : "Which original source supports this task, or what access issue prevents you from opening it?",
        safeAction: noticeOnly
          ? "Open the original email and follow its link to the full correspondence. Record any requested action and deadline; do not act on the notice alone."
          : hasSourceRecord
            ? "Open the cited source and record its requested action and any deadline. Do not send or submit anything until it has been checked."
            : "Find and link the original source. If you cannot access it, ask your supervisor and keep the task on hold.",
      };
    }
    case "reported_difference": {
      const hasSource = hasReadableSource(issue, evidenceById);
      return {
        title: "Verify the reported change",
        explanation: "A reported change needs confirmation from a current source before dependent work can continue.",
        question: "What source confirms the change you reported?",
        safeAction: hasSource
          ? "Compare the report with the cited source and record only what is confirmed. Keep dependent work on hold until verified."
          : "Find a current authoritative source for the reported change. Keep dependent work on hold until the source confirms it.",
      };
    }
    case "missing_dependency":
      return {
        title: "Waiting for a required earlier step",
        explanation: "A required earlier step is not identified in the available task list.",
        question: "Which earlier task must be completed first, or who can confirm the prerequisite?",
        safeAction: "Check the related task list for the prerequisite. If it is unclear, ask your supervisor; keep this task on hold.",
      };
    case "dependency_cycle":
      return {
        title: "Check the order of required steps",
        explanation: "The task list contains a loop in its prerequisites, so the safe order is unclear.",
        question: "Which prerequisite must be completed first, according to the task record or your supervisor?",
        safeAction: "Ask your supervisor to confirm the correct order. Do not start or mark a blocked step complete to break the loop.",
      };
    case "completion_report_pending":
      return {
        title: "Verify the reported completion",
        explanation: "The linked source has not yet confirmed the reported completion.",
        question: "Does the linked source show this step as complete?",
        safeAction: hasReadableSource(issue, evidenceById)
          ? "Check the linked source. Leave the step open until verified, and continue with unrelated work."
          : "Find the linked source and check its status. Leave the step open until verified, and continue with unrelated work.",
      };
    case "conflicting_claims": {
      const hasSource = hasReadableSource(issue, evidenceById);
      return {
        title: "Confirm the current fact before continuing",
        explanation: "The assessment has not verified which fact the next step depends on.",
        question: hasSource
          ? "What current fact does the cited source confirm for this task?"
          : "Which original source can confirm the current fact needed for this task?",
        safeAction: hasSource
          ? "Open the cited source and record only the fact it explicitly states. If it does not answer this, keep dependent work on hold and ask your supervisor."
          : "Find an authoritative source for the current fact. Keep dependent work on hold and ask your supervisor if it cannot be confirmed.",
      };
    }
    default: {
      const hasSource = hasReadableSource(issue, evidenceById);
      return {
        title: "Check the cited information before continuing",
        explanation: "The next step has not been verified against a cited source.",
        question: hasSource
          ? "What current fact does the cited source confirm for this task?"
          : "Which original source supports this task, or what access issue prevents you from opening it?",
        safeAction: "Open the cited source and record only what it explicitly confirms. If it does not establish the next step, keep the work on hold and ask your supervisor.",
      };
    }
  }
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
      .map(issue => normalizeNotificationOnlyConflict(issue, supportedCitedFacts(issue, result, scoped), scoped))
      .map(normalizeLegacyDependencyKind)
      .sort((a, b) => Number(b.severity === "urgent") - Number(a.severity === "urgent"));
    const primary = issues[0];
    const evidenceIds = [...new Set(issues.flatMap(i => i.evidenceIds))];
    const guidanceById = new Map(issues.map(issue => [issue.id, workerGuidance(
      issue,
      supportedCitedFacts(issue, result, scoped),
      scoped,
      result.assessments.find(assessment => assessment.cardId === issue.cardId),
    )]));
    const facts = result.assessments.find(a => a.cardId === cardId)?.facts ?? [];
    const passages = evidenceIds.flatMap(evidenceId => {
      const evidence = scoped.get(evidenceId)!;
      // Exact retained passages, never model paraphrases masquerading as quotes.
      const quotes = [...new Set(facts.filter(f => f.evidenceId === evidenceId && evidence.text.includes(f.quote)).map(f => f.quote))];
      return (quotes.length ? quotes : [evidence.text]).map(quote => ({ evidenceId, source: evidence.source, kind: evidence.kind, quote, sender: evidence.metadata?.sender ?? null, sourceDate: evidence.metadata?.sourceDate ?? null, sourceRevision: evidence.metadata?.sourceRevision ?? null, sourceRecordId: evidence.metadata?.sourceRecordId ?? null, observedAt: evidence.observedAt, effectiveFrom: evidence.metadata?.effectiveFrom ?? null }));
    });
    const conflictFacts = primary && issueSupportsFactComparison(primary)
      ? supportedCitedFacts(primary, result, scoped).filter(f => evidenceIds.includes(f.evidenceId))
      : [];
    const comparisons: NonNullable<NonNullable<ManagerIntervention["verification"]>["comparisons"]> = [];
    const compared = new Set<string>();
    for (let leftIndex = 0; leftIndex < conflictFacts.length && comparisons.length < 12; leftIndex++) {
      const leftFact = conflictFacts[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < conflictFacts.length && comparisons.length < 12; rightIndex++) {
        const rightFact = conflictFacts[rightIndex];
        if (leftFact.evidenceId === rightFact.evidenceId || leftFact.subject !== rightFact.subject || leftFact.topic !== rightFact.topic || leftFact.value === rightFact.value) continue;
        const key = JSON.stringify([leftFact.subject, leftFact.topic, ...[leftFact.evidenceId, rightFact.evidenceId].sort()]);
        if (compared.has(key)) continue;
        compared.add(key);
        const side = (fact: typeof leftFact) => {
          const source = scoped.get(fact.evidenceId)!;
          return { evidenceId: fact.evidenceId, value: fact.value, quote: fact.quote, source: source.source, kind: source.kind,
            sender: source.metadata?.sender ?? null, sourceDate: source.metadata?.sourceDate ?? null,
            url: source.url && /^https?:\/\//i.test(source.url) ? source.url : null };
        };
        comparisons.push({ subject: leftFact.subject, topic: leftFact.topic, left: side(leftFact), right: side(rightFact) });
      }
    }
    return { ...primary, ...guidanceById.get(primary.id), evidenceIds, verification: {
      issues: issues.map(({ id, severity, evidenceIds }) => {
        const guidance = guidanceById.get(id)!;
        return { id, severity, title: guidance.title, explanation: guidance.explanation, question: guidance.question, evidenceIds };
      }), passages, comparisons,
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
