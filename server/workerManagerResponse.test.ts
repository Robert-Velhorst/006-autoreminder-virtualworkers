import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagerSnapshot } from "../shared/aptlssManager";
import { ManagerVerificationDetails } from "../client/src/components/ManagerVerificationDetails";
import { toWorkerManagerSnapshot, toWorkerManagerStatus } from "./workerManagerResponse";

function snapshot(overrides: Partial<ManagerSnapshot> = {}): ManagerSnapshot {
  return {
    version: 1,
    assessedAt: "2026-09-25T09:00:00.000Z",
    executionCoverageComplete: true,
    assessments: [],
    actions: [],
    interventions: [],
    sourceGaps: [],
    runId: 12,
    trigger: "manual",
    cards: [{ id: "c1", name: "Assigned case", url: "https://trello.com/c/abc", board: "Assigned board", list: "Doing" }],
    evidence: [],
    changes: [],
    policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
    nextCheckAt: null,
    ...overrides,
  };
}

describe("worker manager response", () => {
  it("projects only worker-actionable guidance and card-scoped evidence", () => {
    const input = snapshot({
      assessments: [{
        cardId: "c1", state: "NEEDS_VERIFICATION", explanation: "SENTINEL_ASSESSMENT_THOUGHT", confidence: 0,
        uncertainties: ["SENTINEL_UNCERTAINTY"], evidenceIds: ["e1"], actions: [],
      }],
      actions: [{
        id: "a1", cardId: "c1", title: "Read the source", where: "Gmail", kind: "verify", stepIds: [1],
        dependsOn: ["SENTINEL_DEPENDENCY"], minutes: { low: 5, likely: 10, high: 20, samples: 0, basis: "SENTINEL_ESTIMATE_DIAGNOSTIC" },
        reason: "SENTINEL_ACTION_REASON", completionCriteria: "Record what the source asks for.", evidenceIds: ["e1"],
        notBefore: null, blocked: false, priority: 7, draft: "SENTINEL_UNSENT_DRAFT",
        reviewedGuidance: [{ correction: "SENTINEL_FOUNDER_REVIEW" }],
      }],
      interventions: [{
        id: "i1", cardId: "c1", issueKind: "conflicting_claims", severity: "urgent",
        title: "SENTINEL_INTERVENTION_TITLE", explanation: "SENTINEL_INTERVENTION_EXPLANATION",
        question: "SENTINEL_INTERVENTION_QUESTION", safeAction: "SENTINEL_INTERVENTION_ACTION", evidenceIds: ["e1", "foreign-evidence"],
        verification: {
          issues: [{ id: "i1", severity: "urgent", title: "SENTINEL_RAW_ISSUE_TITLE", question: "SENTINEL_RAW_ISSUE_QUESTION", explanation: "SENTINEL_RAW_ISSUE_ANALYSIS", evidenceIds: ["e1"] }],
          passages: [{ evidenceId: "e1", source: "gmail", kind: "source", quote: "SENTINEL_RAW_VERIFICATION_PASSAGE", sender: "SENTINEL_RAW_SENDER", sourceDate: null, sourceRevision: "SENTINEL_REVISION", sourceRecordId: "SENTINEL_SOURCE_ID", effectiveFrom: null }],
          comparisons: [{ subject: "SENTINEL_COMPARISON_SUBJECT", topic: "SENTINEL_COMPARISON_TOPIC", left: { evidenceId: "e1", value: "SENTINEL_COMPARISON_VALUE", quote: "SENTINEL_COMPARISON_QUOTE", source: "gmail", kind: "source", sender: null, sourceDate: null, url: null }, right: { evidenceId: "e2", value: "other", quote: "other", source: "gmail", kind: "source", sender: null, sourceDate: null, url: null } }],
        },
      }],
      evidence: [
        { id: "e1", cardId: "c1", source: "gmail", kind: "source", text: "Source message preview", observedAt: "2026-09-25T08:00:00.000Z", url: "https://mail.google.com/message/1", metadata: { sender: "caseworker@example.test", sourceDate: "2026-09-25", contentScope: "message_preview", sourceRecordId: "gmail-message-1", assessmentRunId: 71, truthClass: "source_record", reportDetail: "SENTINEL_SOURCE_PRIVATE_METADATA" } },
        { id: "e2", cardId: "c2", source: "gmail", kind: "source", text: "SENTINEL_OTHER_CARD_EVIDENCE", observedAt: "2026-09-25T08:00:00.000Z" },
        { id: "e3", cardId: "c1", source: "decision_outcome", kind: "decision", text: "SENTINEL_PRIVATE_FOUNDER_DECISION", observedAt: "2026-09-25T08:00:00.000Z" },
        { id: "e4", cardId: "c1", source: "model", kind: "source", text: "SENTINEL_MODEL_PROPOSAL_EVIDENCE", observedAt: "2026-09-25T08:00:00.000Z", metadata: { truthClass: "model_proposal" } },
        { id: "e5", cardId: "c1", source: "worker_update", kind: "worker", text: "Completion was reported.", observedAt: "2026-09-25T08:30:00.000Z", metadata: { reportKind: "completion", reportDetail: "Worker's own completion note", sourceDescription: "The linked checklist", sourceEvidenceId: "e1", actionId: "SENTINEL_ACTION_ID", assessmentRunId: 72 } },
      ],
      semanticReview: {
        success: false, sourceHash: "SENTINEL_SOURCE_HASH", attemptedAt: "2026-09-25T09:00:00.000Z", retryAfter: "2026-09-25T09:05:00.000Z", failures: 2,
        provider: "codex-subscription", attempts: [{ effort: "high", outcome: "rejected", reason: "SENTINEL_PROVIDER_DIAGNOSTIC", durationMs: 30, inputTokens: 9, outputTokens: 11 }],
      },
      proposal: {
        blocks: [{ id: "private-block-1", cardId: "c1" }] as any,
        robertItems: [], unscheduledCards: [], planHealth: { confidence: 0 }, constraints: { startTime: "09:00", endTime: "17:00", breaks: [] },
        auditTrail: [{ detail: "SENTINEL_PLAN_REASONING" }],
        planningImpact: {
          dateKey: "2026-09-25", baseline: "same_day_plan", scheduleChanged: true, requiresReview: false,
          planChanges: [
            { kind: "moved", blockId: "private-block-1", cardName: "Assigned case", before: { startTime: "09:00", endTime: "09:20" }, after: { startTime: "10:00", endTime: "10:20" }, reason: "SENTINEL_PLAN_CHANGE_REASON", assumptionIds: ["SENTINEL_ASSUMPTION_ID"] },
            { kind: "removed", blockId: "private-block-2", cardName: "Unassigned founder task", before: null, after: null, reason: "SENTINEL_UNASSIGNED_PLAN_REASON", assumptionIds: [] },
          ],
          protectedBlocks: [{ blockId: "SENTINEL_PRIVATE_BLOCK_ID", reasons: ["active_timer"], preservedExactly: true, assumptionIds: ["SENTINEL_PRIVATE_ASSUMPTION"] }],
          assumptions: [{ id: "SENTINEL_ASSUMPTION_ID", inputPath: "private", value: "SENTINEL_ASSUMPTION_VALUE", limitation: "SENTINEL_ASSUMPTION_LIMIT" }],
          deadlines: [{ cardId: "c2", before: { blockIds: ["private-block-2"] }, after: { blockIds: [] } }],
        } as any,
      },
      applied: false,
      prompt: "SENTINEL_PROMPT",
      debug: "SENTINEL_DEBUG_METADATA",
      rawPrompt: "SENTINEL_RAW_PROMPT",
      rawOutput: "SENTINEL_RAW_OUTPUT",
      founderDecisionRationale: "SENTINEL_FOUNDER_PRIVATE_RATIONALE",
    } as any);

    const result = toWorkerManagerSnapshot(input);
    const serialized = JSON.stringify(result);

    expect(result).not.toHaveProperty("semanticReview");
    expect(result).not.toHaveProperty("policy");
    expect(serialized).not.toMatch(/"(?:inputTokens|outputTokens|rawPrompt|rawOutput|founderDecisionRationale)"/);
    expect(result).toMatchObject({
      executionReady: true,
      applied: false,
      actions: [{ id: "a1", cardId: "c1", title: "Read the source", stepIds: [1], reason: "Check the cited source before continuing.", minutes: { low: 5, likely: 10, high: 20 } }],
      interventions: [{
        id: "i1", issueKind: "conflicting_claims", severity: "urgent", title: "Compare the cited sources",
        question: "Which source is authoritative, and from what date does that information apply?",
        explanation: "The cited sources disagree about information needed for this task.", evidenceIds: ["e1"],
        safeAction: "Compare the cited sources and record which information applies and from when.",
        verification: { issues: [], passages: [{ evidenceId: "e1", quote: "Source message preview", sourceRecordId: "gmail-message-1" }] },
      }],
      cards: [{ id: "c1", name: "Assigned case", url: "https://trello.com/c/abc", board: "Assigned board", list: "Doing" }],
      evidence: [
        { id: "e1", cardId: "c1", text: "Source message preview", metadata: { sender: "caseworker@example.test", contentScope: "message_preview", sourceRecordId: "gmail-message-1" } },
        { id: "e5", cardId: "c1", metadata: { reportKind: "completion", reportDetail: "Worker's own completion note", sourceEvidenceId: "e1" } },
      ],
      proposal: { planningImpact: { planChanges: [{ kind: "moved", cardName: "Assigned case", reason: "The proposed time for this task is different." }] } },
    });
    expect(result.actions[0]).not.toHaveProperty("dependsOn");
    expect(result.actions[0]).not.toHaveProperty("evidenceIds");
    expect(result.interventions[0]).not.toHaveProperty("verification.comparisons");
    expect(result.evidence.map(item => item.id)).toEqual(["e1", "e5"]);
    for (const sentinel of [
      "SENTINEL_ASSESSMENT_THOUGHT", "SENTINEL_UNCERTAINTY", "SENTINEL_DEPENDENCY", "SENTINEL_ESTIMATE_DIAGNOSTIC",
      "SENTINEL_ACTION_REASON", "SENTINEL_UNSENT_DRAFT", "SENTINEL_FOUNDER_REVIEW", "SENTINEL_INTERVENTION_EXPLANATION",
      "SENTINEL_INTERVENTION_ACTION", "SENTINEL_RAW_ISSUE_TITLE", "SENTINEL_RAW_ISSUE_QUESTION", "SENTINEL_RAW_ISSUE_ANALYSIS",
      "SENTINEL_RAW_VERIFICATION_PASSAGE", "SENTINEL_RAW_SENDER", "SENTINEL_REVISION", "SENTINEL_SOURCE_ID",
      "SENTINEL_COMPARISON_SUBJECT", "SENTINEL_COMPARISON_TOPIC", "SENTINEL_COMPARISON_VALUE", "SENTINEL_COMPARISON_QUOTE",
      "SENTINEL_SOURCE_PRIVATE_METADATA", "SENTINEL_OTHER_CARD_EVIDENCE", "SENTINEL_PRIVATE_FOUNDER_DECISION",
      "SENTINEL_MODEL_PROPOSAL_EVIDENCE", "SENTINEL_ACTION_ID", "SENTINEL_SOURCE_HASH", "SENTINEL_PROVIDER_DIAGNOSTIC",
      "SENTINEL_PLAN_REASONING", "SENTINEL_PLAN_CHANGE_REASON", "SENTINEL_ASSUMPTION_ID", "SENTINEL_UNASSIGNED_PLAN_REASON",
      "SENTINEL_PRIVATE_BLOCK_ID", "SENTINEL_PRIVATE_ASSUMPTION", "SENTINEL_ASSUMPTION_VALUE", "SENTINEL_ASSUMPTION_LIMIT",
      "SENTINEL_PROMPT", "SENTINEL_DEBUG_METADATA", "SENTINEL_RAW_PROMPT", "SENTINEL_RAW_OUTPUT", "SENTINEL_FOUNDER_PRIVATE_RATIONALE",
    ]) expect(serialized).not.toContain(sentinel);
  });

  it("shows only explicit conflicting values rebuilt from their cited source records", () => {
    const input = snapshot({
      interventions: [{
        id: "conflict-1", cardId: "c1", issueKind: "conflicting_claims", severity: "urgent",
        title: "SENTINEL_FORBIDDEN_AI_TITLE", explanation: "SENTINEL_FORBIDDEN_AI_REASONING",
        question: "SENTINEL_FORBIDDEN_AI_QUESTION", safeAction: "Compare the dated sources.", evidenceIds: ["gmail-1", "trello-1"],
        verification: {
          issues: [],
          passages: [],
          comparisons: [{
            subject: "c1", topic: "deadline",
            left: { evidenceId: "gmail-1", value: "2026-09-06", quote: "Deadline: 2026-09-06", source: "untrusted-model-label", kind: "source", sender: "SENTINEL_RAW_SENDER", sourceDate: null, url: null },
            right: { evidenceId: "trello-1", value: "2026-09-08", quote: "Deadline: 2026-09-08", source: "untrusted-model-label", kind: "source", sender: null, sourceDate: null, url: null },
            reasoning: "SENTINEL_FORBIDDEN_AI_REASONING",
          } as any, {
            subject: "c1", topic: "deadline",
            left: { evidenceId: "gmail-1", value: "2026-09-30", quote: "Deadline: 2026-09-06", source: "gmail", kind: "source", sender: null, sourceDate: null, url: null },
            right: { evidenceId: "trello-1", value: "2026-09-08", quote: "Deadline: 2026-09-08", source: "trello", kind: "source", sender: null, sourceDate: null, url: null },
          }],
        },
      }],
      evidence: [
        { id: "gmail-1", cardId: "c1", source: "gmail", kind: "source", text: "Deadline: 2026-09-06", observedAt: "2026-09-05T08:00:00.000Z", url: "https://mail.google.com/mail/u/0/#all/1", metadata: { sender: "caseworker@example.test", sourceDate: "2026-09-05" } },
        { id: "trello-1", cardId: "c1", source: "trello", kind: "source", text: "Deadline: 2026-09-08", observedAt: "2026-09-05T09:00:00.000Z", url: "https://trello.com/c/card1", metadata: { sender: "Robert", sourceDate: "2026-09-05" } },
      ],
    });

    const result = toWorkerManagerSnapshot(input);
    const comparison = result.interventions[0].verification?.comparisons?.[0];
    expect(result.interventions[0].verification?.comparisons).toHaveLength(1);
    expect(comparison).toEqual({
      topic: "deadline",
      left: {
        evidenceId: "gmail-1", value: "2026-09-06", quote: "Deadline: 2026-09-06", source: "gmail", kind: "source",
        sender: "caseworker@example.test", sourceDate: "2026-09-05", url: "https://mail.google.com/mail/u/0/#all/1",
      },
      right: {
        evidenceId: "trello-1", value: "2026-09-08", quote: "Deadline: 2026-09-08", source: "trello", kind: "source",
        sender: "Robert", sourceDate: "2026-09-05", url: "https://trello.com/c/card1",
      },
    });
    expect(result.interventions[0].verification?.passages).toMatchObject([
      { evidenceId: "gmail-1", quote: "Deadline: 2026-09-06" },
      { evidenceId: "trello-1", quote: "Deadline: 2026-09-08" },
    ]);
    expect(JSON.stringify(result)).not.toContain("SENTINEL_FORBIDDEN_AI_REASONING");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_FORBIDDEN_AI_TITLE");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_FORBIDDEN_AI_QUESTION");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_RAW_SENDER");
    expect(JSON.stringify(result)).not.toContain("untrusted-model-label");

    vi.stubGlobal("React", React);
    let markup: string;
    try {
      markup = renderToStaticMarkup(createElement(ManagerVerificationDetails, { intervention: result.interventions[0] }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(markup).toContain("What differs");
    expect(markup).toContain("Cited source: Gmail");
    expect(markup).toContain("Cited source: Trello");
    expect(markup).toContain("From caseworker@example.test");
    expect(markup).toContain("2026-09-06");
    expect(markup).toContain("2026-09-08");
    expect(markup).toContain("Open cited source");
    expect(markup).not.toContain("SENTINEL_FORBIDDEN_AI_REASONING");
  });

  it("does not expose an off-scope plan change when another card has the same name", () => {
    const result = toWorkerManagerSnapshot(snapshot({
      proposal: {
        blocks: [{ id: "foreign-block", cardId: "c2" }] as any,
        robertItems: [], unscheduledCards: [], planHealth: { confidence: 0 },
        constraints: { startTime: "09:00", endTime: "17:00", breaks: [] }, auditTrail: [],
        planningImpact: {
          dateKey: "2026-09-25", baseline: "same_day_plan", scheduleChanged: true, requiresReview: false,
          planChanges: [{ kind: "moved", blockId: "foreign-block", cardName: "Assigned case", before: { startTime: "09:00", endTime: "09:30" }, after: { startTime: "10:00", endTime: "10:30" }, reason: "Private schedule detail", assumptionIds: [] }],
          protectedBlocks: [], assumptions: [], deadlines: [], dependencies: [], buffer: { before: null, after: { unallocatedMinutes: null, largestWindowMinutes: null, additionalHighEstimateMinutes: null, afterHighEstimatesMinutes: null, minimumKnownDeficitMinutes: null, unknownEstimateBlockIds: [] }, unallocatedDeltaMinutes: null, reservations: [], assumptionIds: [] },
          alternative: { kind: "keep_current_plan", available: false, blockIds: [], deadlineRiskCardIds: [], dependencyRiskActionIds: [], buffer: null, limitation: "" }, risks: [], limitations: [],
        } as any,
      },
    }));

    expect(result.proposal?.planningImpact?.planChanges).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Private schedule detail");
  });

  it("keeps worker answers visibly separate from source evidence and uses fixed worker-facing guidance", () => {
    const input = snapshot({
      interventions: [{
        id: "source-check", cardId: "c1", issueKind: "source_check", severity: "urgent",
        title: "SENTINEL_MODEL_TITLE", explanation: "SENTINEL_MODEL_ANALYSIS", question: "SENTINEL_MODEL_QUESTION",
        safeAction: "SENTINEL_MODEL_ACTION", evidenceIds: ["worker-answer"], verification: { issues: [], passages: [] },
      }],
      evidence: [{
        id: "worker-answer", cardId: "c1", source: "worker_update", kind: "worker",
        text: "I think the deadline changed to tomorrow.", observedAt: "2026-09-25T09:01:00.000Z",
        metadata: { truthClass: "worker_report", reportKind: "update" },
      }],
      applied: false,
    });

    const result = toWorkerManagerSnapshot(input);
    const serialized = JSON.stringify(result);

    expect(result.applied).toBe(false);
    expect(result.evidence).toEqual([expect.objectContaining({
      id: "worker-answer", kind: "worker", source: "worker_update", text: "I think the deadline changed to tomorrow.",
    })]);
    expect(result.evidence[0].kind).toBe("worker");
    expect(result.interventions[0]).toMatchObject({
      title: "Check the original message",
      explanation: "The original source has not yet been checked for the request and any deadline.",
      question: "What does the message ask you to do, and does it include a deadline?",
      safeAction: "Open the cited source and record what it asks for and any deadline.",
    });
    for (const sentinel of ["SENTINEL_MODEL_TITLE", "SENTINEL_MODEL_ANALYSIS", "SENTINEL_MODEL_QUESTION", "SENTINEL_MODEL_ACTION"]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("keeps worker assertions labeled as worker evidence when the stored kind disagrees", () => {
    const result = toWorkerManagerSnapshot(snapshot({
      interventions: [{
        id: "source-check", cardId: "c1", issueKind: "source_check", severity: "urgent",
        title: "Check source", explanation: "Check the source.", question: "What does it say?",
        safeAction: "Open the source.", evidenceIds: ["worker-evidence", "unknown-evidence"],
        verification: { issues: [], passages: [] },
      }],
      evidence: [
        {
          id: "worker-evidence", cardId: "c1", source: "communication", kind: "source",
          text: "The worker says the deadline changed.", observedAt: "2026-09-25T08:00:00.000Z",
          url: "https://example.test/claimed-source",
          metadata: {
            truthClass: "worker_report", sender: "Worker", sourceDate: "2026-09-24",
            sourceRecordId: "unverified-record-id",
          },
        },
        {
          id: "unknown-evidence", cardId: "c1", source: "communication", kind: "source",
          text: "Unclassified evidence.", observedAt: "2026-09-25T08:00:00.000Z",
          metadata: { truthClass: "unknown" },
        },
      ],
    }));

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ id: "worker-evidence", kind: "worker", url: null });
    expect(result.evidence[0].metadata).toBeUndefined();
    expect(result.interventions[0].evidenceIds).toEqual(["worker-evidence"]);
    expect(result.interventions[0].verification?.passages).toMatchObject([
      { evidenceId: "worker-evidence", kind: "worker", quote: "The worker says the deadline changed." },
    ]);
  });

  it("does not promote a worker-update record to source evidence when its truth class is missing", () => {
    const result = toWorkerManagerSnapshot(snapshot({
      interventions: [{
        id: "source-check", cardId: "c1", issueKind: "source_check", severity: "urgent",
        title: "Check source", explanation: "Check the source.", question: "What does it say?",
        safeAction: "Open the source.", evidenceIds: ["worker-update"], verification: { issues: [], passages: [] },
      }],
      evidence: [{
        id: "worker-update", cardId: "c1", source: "worker_update", kind: "source",
        text: "I believe the deadline changed.", observedAt: "2026-09-25T08:00:00.000Z",
        url: "https://example.test/claimed-source",
      }],
    }));

    expect(result.evidence).toEqual([expect.objectContaining({
      id: "worker-update", cardId: "c1", source: "worker_update", kind: "worker",
      text: "I believe the deadline changed.", url: null,
    })]);
    expect(result.interventions[0].verification?.passages).toMatchObject([
      { evidenceId: "worker-update", kind: "worker", quote: "I believe the deadline changed." },
    ]);
  });

  it.each(["decision_outcome", "model", "model_proposal", "semantic_review", "codex-subscription"])(
    "omits internal evidence source %s even if it is mislabeled as worker-readable source data",
    source => {
      const result = toWorkerManagerSnapshot(snapshot({
        evidence: [{
          id: "internal-record", cardId: "c1", source, kind: "source",
          text: "FOUNDER_ONLY_DECISION_OR_MODEL_REASONING", observedAt: "2026-09-25T08:00:00.000Z",
        }],
      }));

      expect(result.evidence).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("FOUNDER_ONLY_DECISION_OR_MODEL_REASONING");
    },
  );

  it.each(["stopped", "checking", "responding", "unavailable"] as const)("projects only the safe process scheduler state %s", state => {
    const result = toWorkerManagerStatus({ snapshot: null,
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
      scheduler: { scope: "current_process", state, secret: "PRIVATE_RUNTIME_CONFIG" } as any,
    });
    expect(result.scheduler).toEqual({ scope: "current_process", state });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RUNTIME_CONFIG");
  });
  it.each([
    { scope: "cluster", state: "responding" },
    { scope: "current_process", state: "PRIVATE_RUNTIME_ERROR" },
  ])("rejects unknown scheduler scope or status", scheduler => {
    const result = toWorkerManagerStatus({ snapshot: null,
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" }, scheduler: scheduler as any,
    });
    expect(result.scheduler).toEqual({ scope: "current_process", state: "unavailable" });
  });
  it("does not return queue, internal errors, or unknown status fields", () => {
    const result = toWorkerManagerStatus({
      snapshot: null,
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" as const },
      queue: { state: "failed", attempts: 3, lastError: "SENTINEL_QUEUE_DIAGNOSTIC" },
      error: "SENTINEL_DATABASE_ERROR",
      checkedAt: "2026-09-25T09:00:00.000Z",
      lastSuccessfulAt: null,
      provider: "SENTINEL_PROVIDER",
      prompt: "SENTINEL_STATUS_PROMPT",
    });
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      snapshot: null,
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
      error: "Work guidance could not be refreshed. Try again shortly, and contact your supervisor if it continues.",
      checkedAt: "2026-09-25T09:00:00.000Z",
      lastSuccessfulAt: null,
      scheduler: { scope: "current_process", state: "unavailable" },
    });
    expect(serialized).not.toContain("SENTINEL_QUEUE_DIAGNOSTIC");
    expect(serialized).not.toContain("SENTINEL_DATABASE_ERROR");
    expect(serialized).not.toContain("SENTINEL_PROVIDER");
    expect(serialized).not.toContain("SENTINEL_STATUS_PROMPT");
  });
});
