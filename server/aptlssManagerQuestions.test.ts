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
    expect(focused.interventions[0].verification?.issues).toHaveLength(2);
    expect(original.interventions).toHaveLength(2);
  });
  it("shows exact scoped source passages without treating worker statements as proof", () => {
    const focused = focusManagerQuestions(input, result([issue("conflict", "urgent", "Which fact applies?")]));
    const passages = focused.interventions[0].verification!.passages;
    expect(passages.map(p => p.quote)).toEqual(["Deadline: 2026-09-06", "Deadline: 2026-09-08"]);
    expect(passages[1].kind).toBe("worker");
    expect(JSON.stringify(focused.interventions)).not.toContain("Unrelated private source");
    expect(focused.interventions[0].evidenceIds).not.toContain("private");
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
    expect(once.interventions[0].question).toBe(original.interventions[0].question);
    expect(focusManagerQuestions(input, once)).toEqual(once);
  });
  it("asks for the missing payment fact rather than generic verification", () => {
    const original = result([issue("missing-proof", "attention", "Which fact applies?")]);
    original.assessments[0].uncertainties = ["Missing source-supported fact required for this task: paid"];
    original.assessments[0].facts = [];
    expect(focusManagerQuestions(input, original).interventions[0].question).toContain("payment");
  });
  it("retains secondary semantic questions when unchanged-source model results are reused", () => {
    const scoped = { ...input, cards: [{ id: "a", name: "A", url: null, board: "B", list: "DOING", state: "DOING", stateReason: "", dueAt: null, overdue: false, priority: 10, updatedAt: input.now, steps: [], waiting: null }] };
    const previous = focusManagerQuestions(scoped, result([issue("conflict", "urgent", "Which fact applies?"), issue("semantic-1", "attention", "Is this interpretation valid?")]));
    const reused = reuseManagerSemanticReview(scoped, result([]), previous);
    expect(reused.interventions.some(i => i.id === "semantic-1")).toBe(true);
  });
});
