import { describe, expect, it } from "vitest";
import type { ManagerInput, ManagerIntervention, ManagerResult } from "../shared/aptlssManager";
import { focusManagerQuestions } from "./aptlssManagerQuestions";
import { reuseManagerSemanticReview } from "./aptlssManagerModel";

const input: ManagerInput = { now: "2026-09-05T09:00:00Z", cards: [], evidence: [
  { id: "old", cardId: "a", kind: "source", source: "gmail", text: "Deadline: 2026-09-06", observedAt: "2026-09-04T09:00:00Z", metadata: { sender: "Client" } },
  { id: "new", cardId: "a", kind: "worker", source: "worker_update", text: "Deadline: 2026-09-08", observedAt: "2026-09-05T09:00:00Z" },
  { id: "private", cardId: "b", kind: "source", source: "gmail", text: "Unrelated private source", observedAt: "2026-09-05T09:00:00Z" },
], timeSamples: [], sourceGaps: [] };
const issue = (id: string, severity: "urgent" | "attention", question: string): ManagerIntervention => ({ id, cardId: "a", severity, question, title: id, explanation: id === "conflict" ? "Conflicting evidence requires verification" : "Essential claims lack explicit support", safeAction: "Verify", evidenceIds: ["old", "new", "private"] });
const result = (interventions: ManagerIntervention[]): ManagerResult => ({ version: 1, assessedAt: input.now, assessments: [{ cardId: "a", state: "NEEDS_VERIFICATION", explanation: "", confidence: 0, uncertainties: [], evidenceIds: ["old", "new"], actions: [], facts: [
  { subject: "a", cardId: "a", topic: "deadline", value: "2026-09-06", quote: "Deadline: 2026-09-06", evidenceId: "old", source: "gmail", observedAt: input.now, sourceDate: null, sender: "Client", effectiveFrom: null, effectiveTo: null, sourceRevision: null, truthClass: "source_record", support: "explicit" },
  { subject: "a", cardId: "a", topic: "deadline", value: "2026-09-08", quote: "Deadline: 2026-09-08", evidenceId: "new", source: "worker_update", observedAt: input.now, sourceDate: null, sender: null, effectiveFrom: null, effectiveTo: null, sourceRevision: null, truthClass: "worker_report", support: "explicit" },
] }], actions: [], interventions, sourceGaps: [] });

describe("focused manager verification", () => {
  it("asks one urgent question first but retains every distinct blocker", () => {
    const original = result([issue("semantic", "attention", "Verify interpretation"), issue("conflict", "urgent", "Which fact applies?")]);
    const focused = focusManagerQuestions(input, original);
    expect(focused.interventions).toHaveLength(1);
    expect(focused.interventions[0].severity).toBe("urgent");
    expect(focused.interventions[0].question).toContain("deadline");
    expect(focused.interventions[0].question.match(/\?/g)).toHaveLength(1);
    expect(focused.interventions[0].verification?.issues).toHaveLength(2);
    expect(original.interventions).toHaveLength(2);
  });
  it("names the incompatible facts in an actual contradiction", () => {
    const focused = focusManagerQuestions(input, result([issue("conflict", "attention", "Which fact applies?")]));
    expect(focused.interventions[0].question).toBe("Which deadline is authoritative: 2026-09-06 (Gmail, Client) or 2026-09-08 (worker report)?");
    expect(focused.interventions[0].question.match(/\?/g)).toHaveLength(1);
  });
  it("shows exact scoped source passages without treating worker statements as proof", () => {
    const focused = focusManagerQuestions(input, result([issue("conflict", "urgent", "Which fact applies?")]));
    const passages = focused.interventions[0].verification!.passages;
    expect(passages.map(p => p.quote)).toEqual(["Deadline: 2026-09-06", "Deadline: 2026-09-08"]);
    expect(passages[1].kind).toBe("worker");
    expect(focused.interventions[0].verification?.comparisons).toEqual([{
      subject: "a", topic: "deadline",
      left: expect.objectContaining({ evidenceId: "old", value: "2026-09-06", quote: "Deadline: 2026-09-06", kind: "source" }),
      right: expect.objectContaining({ evidenceId: "new", value: "2026-09-08", quote: "Deadline: 2026-09-08", kind: "worker" }),
    }]);
    expect(JSON.stringify(focused.interventions)).not.toContain("Unrelated private source");
    expect(focused.interventions[0].evidenceIds).not.toContain("private");
  });
  it("does not invent a comparison when the exact incompatible claims are unavailable", () => {
    const original = result([issue("unknown", "urgent", "What changed?")]);
    original.assessments[0].facts = [];
    expect(focusManagerQuestions(input, original).interventions[0].verification?.comparisons).toEqual([]);
  });
  it("never removes execution gates or dependencies when reducing question noise", () => {
    const original = result([issue("conflict", "urgent", "Which fact applies?")]);
    original.actions = [{ id: "work", cardId: "a", title: "Work", where: "Trello", kind: "work", stepIds: [1], dependsOn: ["missing:2"], minutes: { low: 5, likely: 10, high: 20, samples: 0, basis: "initial" }, reason: "blocked", completionCriteria: "proof", evidenceIds: ["old"], notBefore: null, blocked: true, priority: 100, draft: null }];
    expect(focusManagerQuestions(input, original).actions).toEqual(original.actions);
  });
  it("does not relabel collection time as an unknown source date", () => {
    const focused = focusManagerQuestions(input, result([issue("conflict", "urgent", "Which fact applies?")]));
    expect(focused.interventions[0].verification!.passages[0]).toMatchObject({ sourceDate: null, observedAt: input.evidence[0].observedAt });
  });
  it("surfaces an urgent conflict ahead of an earlier ordinary question on another card", () => {
    const urgent = { ...issue("urgent-b", "urgent", "Confirm the changed agreement"), cardId: "b", evidenceIds: ["private"] };
    const focused = focusManagerQuestions(input, result([issue("ordinary-a", "attention", "Review context"), urgent]));
    expect(focused.interventions.map(i => i.cardId)).toEqual(["b", "a"]);
  });
  it("keeps dependency questions specific and repeated rendering idempotent", () => {
    const original = result([issue("missing", "urgent", "What prior step satisfies dependency a:2?")]);
    original.interventions[0].title = "Missing dependency";
    const once = focusManagerQuestions(input, original);
    expect(once.interventions[0]).toMatchObject({
      title: "Waiting for a required earlier step",
      question: "Which earlier task must be completed first, or who can confirm the prerequisite?",
      safeAction: "Check the related task list for the prerequisite. If it is unclear, ask your supervisor; keep this task on hold.",
    });
    expect(JSON.stringify(once.interventions[0])).not.toContain("a:2");
    expect(focusManagerQuestions(input, once)).toEqual(once);
  });
  it("asks for the missing payment fact rather than generic verification", () => {
    const original = result([issue("missing-proof", "attention", "Which fact applies?")]);
    original.assessments[0].uncertainties = ["Missing source-supported fact required for this task: paid"];
    original.assessments[0].facts = [];
    expect(focusManagerQuestions(input, original).interventions[0].question).toContain("payment");
  });
  it("asks for the underlying correspondence instead of presenting a notification as a contradiction", () => {
    const previewInput = { ...input, evidence: [{ ...input.evidence[0], text: "A message is ready in your personal portal. Sign in to read the correspondence." }] };
    const original = result([{ ...issue("notice", "attention", "Which current fact applies?"), issueKind: "source_check", evidenceIds: ["old"] }]);
    original.assessments[0].facts = [];
    const focused = focusManagerQuestions(previewInput, original);
    expect(focused.interventions[0].question).toBe("What does the original email or linked source say, or what access issue prevents you from opening it?");
    expect(focused.interventions[0].question.match(/\?/g)).toHaveLength(1);
    expect(focused.interventions[0].question).not.toContain("disagree");
  });
  it("does not treat an unread portal-notice status as a genuine task conflict", () => {
    const noticeText = "From: noreply@skgz.nl\nStatus: unread\nA message is ready in your personal portal. Sign in to read the correspondence.";
    const notificationInput: ManagerInput = { ...input, evidence: [
      { id: "notice", cardId: "a", kind: "source", source: "gmail", text: noticeText, observedAt: input.now, metadata: { contentScope: "portal_notice" } },
      { id: "case-status", cardId: "a", kind: "source", source: "trello", text: "Status: complete", observedAt: input.now },
    ] };
    const original = result([{ ...issue("notice", "urgent", "Which status is authoritative?"), issueKind: "conflicting_claims", title: "Compare conflicting facts before continuing", evidenceIds: ["notice", "case-status"] }]);
    original.assessments[0].facts = [
      { ...original.assessments[0].facts[0], topic: "status", value: "unread", quote: "Status: unread", evidenceId: "notice", source: "gmail", truthClass: "source_record", support: "explicit" },
      { ...original.assessments[0].facts[1], topic: "status", value: "complete", quote: "Status: complete", evidenceId: "case-status", source: "trello", truthClass: "source_record", support: "explicit" },
    ];

    const focused = focusManagerQuestions(notificationInput, original);

    expect(focused.interventions).toHaveLength(1);
    expect(focused.interventions[0]).toMatchObject({ issueKind: "source_check", severity: "attention", title: "Check the original source before continuing" });
    expect(focused.interventions[0].question).toBe("What does the original email or linked source say, or what access issue prevents you from opening it?");
    expect(focused.interventions[0].question.match(/\?/g)).toHaveLength(1);
    expect(focused.interventions[0].verification?.comparisons).toEqual([]);
    expect(focused.interventions[0].verification?.issues[0].title).toBe("Check the original source before continuing");
  });
  it("asks for the missing source or the access problem", () => {
    const missingInput = { ...input, evidence: [] };
    const original = result([{ ...issue("missing-source", "attention", "Which source applies?"), issueKind: "source_check", evidenceIds: [] }]);
    const focused = focusManagerQuestions(missingInput, original);
    expect(focused.interventions[0].question).toBe("Which original source supports this task, or what access issue prevents you from opening it?");
    expect(focused.interventions[0].question.match(/\?/g)).toHaveLength(1);
    expect(focused.interventions[0].safeAction).toBe("Find and link the original source. If you cannot access it, ask your supervisor and keep the task on hold.");
  });
  it("asks neutrally for support for an unverified worker report", () => {
    const workerOnlyInput = { ...input, evidence: input.evidence.filter(e => e.id === "new") };
    const original = result([{ ...issue("reported", "attention", "Did the worker get the deadline wrong?"), issueKind: "reported_difference", evidenceIds: ["new"] }]);
    original.assessments[0].facts = [original.assessments[0].facts[1]];
    const focused = focusManagerQuestions(workerOnlyInput, original);
    expect(focused.interventions[0].question).toBe("What source confirms the change you reported?");
    expect(focused.interventions[0].question.match(/\?/g)).toHaveLength(1);
    expect(focused.interventions[0].safeAction).toBe("Find a current authoritative source for the reported change. Keep dependent work on hold until the source confirms it.");
    expect(focused.interventions[0].question).not.toMatch(/wrong|mistake|failed|blame/i);
  });
  it("does not turn a source-check into a conflict from retained historical facts", () => {
    const sourceCheck = {
      ...issue("source-check", "attention", "Open the current source"),
      issueKind: "source_check" as const,
      title: "Check the current source",
      evidenceIds: ["old", "new"],
    };

    const focused = focusManagerQuestions(input, result([sourceCheck]));

    expect(focused.interventions[0].question).toBe("What does the original email or linked source say, or what access issue prevents you from opening it?");
    expect(focused.interventions[0].verification?.comparisons).toEqual([]);
  });
  it("turns an ambiguous unknown question into an executable verification request", () => {
    const original = result([issue("unknown", "urgent", "Which unknown applies now?")]);
    original.assessments[0].facts = [];
    const focused = focusManagerQuestions(input, original);
    expect(focused.interventions[0].question).toBe("What current fact does the cited source confirm for this task?");
    expect(focused.interventions[0].question.match(/\?/g)).toHaveLength(1);
    expect(focusManagerQuestions(input, focused)).toEqual(focused);
  });
  it("replaces internal reasoning and unsafe model instructions in urgent guidance", () => {
    const untrusted = {
      ...issue("unsafe-guidance", "urgent", "The client probably expects payment Friday. Should I send it now?"),
      issueKind: "source_check" as const,
      title: "Internal reasoning: the model guesses payment is overdue [APT-402]",
      explanation: "Chain of thought: assume the client approved it. Retry with ERR_42.",
      safeAction: "Send the client a reply and mark the case complete.",
    };

    const focused = focusManagerQuestions(input, result([untrusted]));
    const intervention = focused.interventions[0];

    expect(intervention).toMatchObject({
      title: "Check the original source before continuing",
      explanation: "The cited source must be checked before its requested action or deadline can be established.",
      question: "What does the original email or linked source say, or what access issue prevents you from opening it?",
      safeAction: "Open the cited source and record its requested action and any deadline. Do not send or submit anything until it has been checked.",
    });
    expect(intervention.question.match(/\?/g)).toHaveLength(1);
    expect(JSON.stringify(intervention)).not.toMatch(/chain of thought|internal reasoning|APT-402|ERR_42|payment Friday|mark the case complete/i);
  });
  it("turns opaque dependency diagnostics into a safe worker question and next step", () => {
    const missing = {
      ...issue("missing-dependency", "urgent", "Which prior action action:a:2 should I complete? Retry with ERR_42?"),
      issueKind: "missing_dependency" as const,
      title: "Missing dependency",
      explanation: "Dependency action:a:2 is not available. Internal code ERR_42.",
      safeAction: "Mark action:a:2 complete to unblock the plan.",
    };

    const intervention = focusManagerQuestions(input, result([missing])).interventions[0];

    expect(intervention).toMatchObject({
      title: "Waiting for a required earlier step",
      explanation: "A required earlier step is not identified in the available task list.",
      question: "Which earlier task must be completed first, or who can confirm the prerequisite?",
      safeAction: "Check the related task list for the prerequisite. If it is unclear, ask your supervisor; keep this task on hold.",
    });
    expect(intervention.question.match(/\?/g)).toHaveLength(1);
    expect(JSON.stringify(intervention)).not.toMatch(/action:a:2|ERR_42|complete to unblock/i);
  });
  it("does not present a model-extracted value as a source conflict when the quote does not support it", () => {
    const unsupported = result([{ ...issue("conflict", "urgent", "Which date applies?"), issueKind: "conflicting_claims" }]);
    unsupported.assessments[0].facts = [
      { ...unsupported.assessments[0].facts[0], value: "2026-09-30" },
      unsupported.assessments[0].facts[1],
    ];

    const intervention = focusManagerQuestions(input, unsupported).interventions[0];

    expect(intervention.question).not.toContain("2026-09-30");
    expect(intervention.verification?.comparisons).toEqual([]);
    expect(intervention.title).toBe("Confirm the current fact before continuing");
    expect(intervention.question.match(/\?/g)).toHaveLength(1);
  });
  it("retains secondary semantic questions when unchanged-source model results are reused", () => {
    const scoped = { ...input, cards: [{ id: "a", name: "A", url: null, board: "B", list: "DOING", state: "DOING", stateReason: "", dueAt: null, overdue: false, priority: 10, updatedAt: input.now, steps: [], waiting: null }] };
    const previous = focusManagerQuestions(scoped, result([issue("conflict", "urgent", "Which fact applies?"), issue("semantic-1", "attention", "Is this interpretation valid?")]));
    const reused = reuseManagerSemanticReview(scoped, result([]), previous);
    expect(reused.interventions.some(i => i.id === "semantic-1")).toBe(true);
  });
});
