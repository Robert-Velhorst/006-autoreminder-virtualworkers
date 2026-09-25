import { createHash } from "node:crypto";
import type {
  ManagerAction,
  ManagerAssessment,
  ManagerCard,
  ManagerInput,
  ManagerIntervention,
  ManagerResult,
} from "../shared/aptlssManager";
import {
  compareManagerWork,
  validManagerTimestamp as validIso,
} from "../shared/aptlssManagerEvidence";
import { assessManagerEvidence, unsafeManagerText } from "./aptlssManagerFacts";

function id(prefix: string, ...parts: unknown[]) {
  return `${prefix}-${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}
export function managerExternalAction(title: string) {
  return /\b(send|email|mail|submit|pay|publish|post|message|move|delete|purchase|transfer|invite|upload|approve|sign)\b|\b(verstuur|mail|betaal|publiceer|plaats|verzend|verwijder|koop|onderteken|dien in)\b/i.test(
    title
  );
}
function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * q,
    lo = Math.floor(i),
    hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function estimate(
  card: ManagerCard,
  category: string,
  initial: number,
  input: ManagerInput
) {
  const seen = new Set<number>();
  const samples = input.timeSamples
    .filter(
      s =>
        s.completed &&
        !s.interrupted &&
        s.stepId !== null &&
        s.category === category &&
        s.minutes > 0 &&
        s.minutes <= 1440 &&
        !seen.has(s.id) &&
        seen.add(s.id)
    )
    .map(s => s.minutes);
  if (samples.length < 3)
    return {
      low: Math.max(5, Math.round(initial * 0.65)),
      likely: initial,
      high: Math.max(initial + 5, Math.round(initial * 1.5)),
      samples: samples.length,
      basis: samples.length
        ? "Provisional personal history; initial estimate retained"
        : "Initial task estimate",
    };
  const median = quantile(samples, 0.5);
  const deviations = samples.map(v => Math.abs(v - median));
  const mad = quantile(deviations, 0.5) || 1;
  const robust = samples.filter(v => Math.abs(v - median) <= 4 * mad);
  const values = robust.length >= 3 ? robust : samples;
  return {
    low: Math.max(5, Math.round(quantile(values, 0.2))),
    likely: Math.max(5, Math.round(quantile(values, 0.5))),
    high: Math.max(10, Math.round(quantile(values, 0.8))),
    samples: samples.length,
    basis: "Completed personal tasks of the same type",
  };
}

export function assessManagerContext(input: ManagerInput): ManagerResult {
  if (!validIso(input.now))
    throw new Error(
      "Manager now must be a real ISO timestamp with a timezone."
    );
  const now = new Date(input.now);
  const cards = structuredClone(input.cards).sort((a, b) =>
    compareManagerWork(a, b, now)
  );
  const allActions: ManagerAction[] = [];
  const assessments: ManagerAssessment[] = [];
  const interventions: ManagerIntervention[] = [];
  const sourceGaps = [...input.sourceGaps];
  if (input.evidence.length > 1500)
    sourceGaps.push(
      "Evidence limit reached; source context was truncated for this assessment."
    );
  const evidence = input.evidence.slice(0, 1500);

  for (const card of cards) {
    const proof = assessManagerEvidence(
      card,
      evidence,
      input.graphConflicts ?? [],
      now.getTime(),
      input.evidence.slice(1500).some(e => e.cardId === card.id)
    );
    const ev = proof.evidence;
    if (
      card.steps.some(
        s =>
          !s.complete &&
          unsafeManagerText.test(`${s.title} ${s.completionCriteria ?? ""}`)
      )
    ) {
      proof.blocked = true;
      proof.reliability.coverage = "partial";
      proof.reliability.reasons.push(
        "Unsafe task instructions require verification"
      );
    }
    const unresolved = card.steps.filter(s => !s.complete);
    const actionByStep = new Map<number, ManagerAction>();

    for (const step of unresolved) {
      const kind: ManagerAction["kind"] = step.requiresDecision
        ? "decision"
        : managerExternalAction(step.title)
          ? "draft"
          : "work";
      const action: ManagerAction = {
        id: id("action", card.id, step.id),
        cardId: card.id,
        title:
          kind === "draft" ? `Prepare for review: ${step.title}` : step.title,
        where: card.url ?? `${card.board} / ${card.list}`,
        kind,
        stepIds: [step.id],
        dependsOn: [],
        minutes: estimate(
          card,
          step.category,
          Math.max(5, step.minutes || 30),
          input
        ),
        reason: card.stateReason || "This is the next open step.",
        completionCriteria:
          kind === "draft"
            ? `A worker has reviewed the draft and explicitly sends or submits it.`
            : step.completionCriteria ||
              "Completion evidence is recorded in the linked work item.",
        evidenceIds: ev.map(e => e.id),
        notBefore: null,
        blocked: false,
        priority: card.priority,
        draft:
          kind === "draft"
            ? `Draft for worker review only - not sent: ${step.title}`
            : null,
      };
      actionByStep.set(step.id, action);
      allActions.push(action);
    }
    for (let i = 0; i < unresolved.length; i++) {
      const step = unresolved[i],
        action = actionByStep.get(step.id)!;
      const explicit = step.dependsOn;
      for (const dep of explicit) {
        const [depCard, depStep] = dep.includes(":")
          ? dep.split(":")
          : [card.id, dep];
        const target = allActions.find(
          a => a.cardId === depCard && a.stepIds.includes(Number(depStep))
        );
        const dependencyCard = cards.find(c => c.id === depCard);
        const dependencyStep = dependencyCard?.steps.find(
          s => s.id === Number(depStep)
        );
        if (dependencyStep?.decisionRejected) {
          action.dependsOn.push(`rejected:${depCard}:${dependencyStep.id}`);
          action.reason = `The founder rejected prerequisite "${dependencyStep.title}". Ask the founder for a new direction before continuing.`;
        } else if (target) action.dependsOn.push(target.id);
        else if (dependencyStep && !dependencyStep.complete)
          action.dependsOn.push(id("action", depCard, dependencyStep.id));
        else if (!dependencyStep?.complete)
          action.dependsOn.push(`missing:${dep}`);
      }
      if (!explicit.length) {
        const currentIndex = card.steps.findIndex(s => s.id === step.id);
        const previousStep = currentIndex > 0 ? card.steps[currentIndex - 1] : null;
        if (previousStep?.decisionRejected) {
          action.dependsOn.push(`rejected:${card.id}:${previousStep.id}`);
          action.reason = `The founder rejected prerequisite "${previousStep.title}". Ask the founder for a new direction before continuing.`;
        } else if (i > 0) {
          action.dependsOn.push(actionByStep.get(unresolved[i - 1].id)!.id);
        }
      }
    }
    const cardBlocked = /WAIT|HOLD|BLOCK/.test(
      `${card.state} ${card.list}`.toUpperCase()
    );
    for (const action of actionByStep.values())
      action.blocked =
        action.dependsOn.length > 0 || cardBlocked || !!card.waiting;

    if (card.waiting) {
      const due =
        validIso(card.waiting.followUpAt) &&
        new Date(card.waiting.followUpAt!).getTime() <= now.getTime();
      const follow: ManagerAction = {
        id: id("follow", card.id, card.waiting.action),
        cardId: card.id,
        title: card.waiting.action,
        where: card.url ?? `${card.board} / ${card.list}`,
        kind: "follow_up",
        stepIds: [],
        dependsOn: [],
        minutes: {
          low: 5,
          likely: 10,
          high: 20,
          samples: 0,
          basis: "Initial follow-up estimate",
        },
        reason: card.waiting.reason,
        completionCriteria:
          "A worker reviews the prepared draft and explicitly sends it, then records the result.",
        evidenceIds: ev.map(e => e.id),
        notBefore: validIso(card.waiting.followUpAt)
          ? new Date(card.waiting.followUpAt!).toISOString()
          : card.waiting.followUpAt,
        blocked: !due,
        priority: card.priority + 10,
        draft: `Draft for worker review only - not sent: ${card.waiting.action}`,
      };
      allActions.push(follow);
    }
    if (proof.blocked) {
      const explicitDisagreement = proof.facts.some(fact =>
        proof.conflictIds.includes(fact.evidenceId) &&
        fact.support === "explicit" && fact.topic !== "context" &&
        proof.facts.some(other =>
          other.evidenceId !== fact.evidenceId && proof.conflictIds.includes(other.evidenceId) &&
          other.support === "explicit" && other.subject === fact.subject &&
          other.topic === fact.topic && other.value !== fact.value
        )
      );
      const issueKind = !proof.unresolved ? "source_check" : explicitDisagreement ? "conflicting_claims" : "reported_difference";
      const evidenceIds = proof.unresolved
        ? proof.conflictIds
        : ev.map(e => e.id);
      const verify: ManagerAction = {
        id: id("verify", card.id, ...evidenceIds),
        cardId: card.id,
        title: `${proof.unresolved ? "Resolve conflicting facts" : "Verify essential evidence"} for ${card.name}`,
        where: card.url ?? `${card.board} / ${card.list}`,
        kind: "verify",
        stepIds: [],
        dependsOn: [],
        minutes: {
          low: 5,
          likely: 10,
          high: 20,
          samples: 0,
          basis: "Verification estimate",
        },
        reason: proof.reliability.reasons.join(". "),
        completionCriteria:
          "The authoritative fact, source, sender, source date and effective date are recorded.",
        evidenceIds,
        notBefore: null,
        blocked: false,
        priority: 1000,
        draft: null,
      };
      allActions.push(verify);
      for (const a of allActions.filter(
        a => a.cardId === card.id && a.kind !== "verify"
      ))
        a.blocked = true;
      interventions.push({
        id: id("intervention", card.id, ...evidenceIds),
        cardId: card.id,
        issueKind,
        severity: proof.unresolved ? "urgent" : "attention",
        title: issueKind === "conflicting_claims" ? "Compare conflicting facts before continuing" : issueKind === "reported_difference" ? "Verify a reported difference before continuing" : "Check the original source before continuing",
        explanation: proof.reliability.reasons.join(". "),
        question: issueKind === "conflicting_claims"
          ? "Which of the two cited facts applies now? Identify the authoritative source and effective date."
          : issueKind === "reported_difference"
            ? "What does the original record say, and which reported update needs checking?"
            : "What does the original source ask you to do, and does it give a deadline?",
        safeAction: issueKind === "source_check"
          ? "Open the original source, read any referenced document, and report its request and deadline."
          : "Compare the cited records and report the verified fact before continuing.",
        evidenceIds,
      });
    }
    const cardActions = allActions.filter(a => a.cardId === card.id);
    assessments.push({
      cardId: card.id,
      state: proof.blocked ? "NEEDS_VERIFICATION" : card.state,
      explanation: proof.blocked
        ? "Essential evidence needs verification before execution."
        : card.stateReason || "Open work assessed from linked evidence.",
      confidence: 0,
      uncertainties: proof.reliability.reasons,
      evidenceIds: ev.map(e => e.id),
      actions: cardActions,
      reliability: proof.reliability,
      facts: proof.facts,
    });
  }

  const byId = new Map(allActions.map(a => [a.id, a]));
  const visiting = new Set<string>(),
    visited = new Set<string>(),
    ordered: ManagerAction[] = [];
  const visit = (a: ManagerAction) => {
    if (visited.has(a.id)) return;
    if (visiting.has(a.id)) {
      a.blocked = true;
      interventions.push({
        id: id("cycle", a.id),
        cardId: a.cardId,
        issueKind: "dependency_cycle",
        severity: "urgent",
        title: "Dependency cycle",
        explanation: "A dependency cycle prevents a safe chronological plan.",
        question:
          "Which step should be completed first to break this dependency cycle?",
        safeAction: "Clarify the dependency before work continues.",
        evidenceIds: a.evidenceIds,
      });
      return;
    }
    visiting.add(a.id);
    for (const dep of a.dependsOn) {
      const target = byId.get(dep);
      if (target) visit(target);
      else {
        a.blocked = true;
        interventions.push({
          id: id("missing", a.id, dep),
          cardId: a.cardId,
          issueKind: "missing_dependency",
          severity: "urgent",
          title: "Missing dependency",
          explanation: `Dependency ${dep} is not available.`,
          question: "What evidence or prior step satisfies this dependency?",
          safeAction: "Provide the missing dependency before execution.",
          evidenceIds: a.evidenceIds,
        });
      }
    }
    visiting.delete(a.id);
    visited.add(a.id);
    ordered.push(a);
  };
  for (const a of allActions) visit(a);
  // Topology orders steps within each card. Cross-card dependencies stay explicit
  // and blocked, but cannot silently override the shared urgent/work-state order.
  const cardById = new Map(cards.map(c => [c.id, c]));
  ordered.sort(
    (a, b) =>
      compareManagerWork(
        cardById.get(a.cardId)!,
        cardById.get(b.cardId)!,
        now
      ) || Number(b.kind === "verify") - Number(a.kind === "verify")
  );
  for (const assessment of assessments)
    assessment.actions = ordered.filter(a => a.cardId === assessment.cardId);
  const uniqueInterventions = [
    ...new Map(interventions.map(i => [i.id, i])).values(),
  ];
  return {
    version: 1,
    assessedAt: input.now,
    assessments,
    actions: ordered,
    interventions: uniqueInterventions,
    sourceGaps: [...new Set(sourceGaps)],
  };
}
