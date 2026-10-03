import { describe, expect, it } from "vitest";
import { canRecordWaitingReasonForCard, canStartTimerForCard, managerActionNeedsSourceVerification, managerActionSourceRequirements, managerExecutionCoverageComplete, managerIntervenesOnCard, timerExecutionBlockReason } from "./timerAccess";

describe("timer card access", () => {
  it("requires a worker-owned operator card but does not narrow administrator tracking", () => {
    expect(canStartTimerForCard("worker", true)).toBe(true);
    expect(canStartTimerForCard("worker", false)).toBe(false);
    expect(canStartTimerForCard("admin", false)).toBe(true);
  });

  it("accepts waiting evidence only for a card already in the worker queue", () => {
    expect(canRecordWaitingReasonForCard(true)).toBe(true);
    expect(canRecordWaitingReasonForCard(false)).toBe(false);
  });

  it("blocks execution on a held card, waiting reason, assessment or manager intervention", () => {
    const ready = { listName: "TO DO", hasActiveWaitingReason: false, actionability: "actionable", hasManagerIntervention: false };
    expect(timerExecutionBlockReason(ready)).toBeNull();
    expect(timerExecutionBlockReason({ ...ready, listName: "ON-HOLD" })).toMatch(/waiting or blocked/i);
    expect(timerExecutionBlockReason({ ...ready, hasActiveWaitingReason: true })).toMatch(/waiting or blocked/i);
    expect(timerExecutionBlockReason({ ...ready, actionability: "blocked" })).toMatch(/waiting or blocked/i);
    expect(timerExecutionBlockReason({ ...ready, hasManagerIntervention: true })).toMatch(/verification/i);
    expect(timerExecutionBlockReason({ ...ready, hasStaleRequiredSource: true })).toMatch(/source required by the next step/i);
    expect(timerExecutionBlockReason({ ...ready, executionCoverageComplete: false })).toMatch(/full work list has not been checked/i);
  });

  it("checks only cited sources for the next executable action on the requested card", () => {
    const snapshot = JSON.stringify({
      assessedAt: "2026-09-25T11:55:00Z",
      actions: [
        { cardId: "a", blocked: true, evidenceIds: ["stale-mail"] },
        { cardId: "b", blocked: false, evidenceIds: ["fresh-card-b"] },
        { cardId: "a", blocked: false, evidenceIds: ["fresh-card"] },
      ],
      evidence: [
        { id: "stale-mail", cardId: "a", source: "gmail", kind: "source" },
        { id: "fresh-card-b", cardId: "b", source: "trello", kind: "source" },
        { id: "fresh-card", cardId: "a", source: "trello", kind: "source" },
      ],
    });
    const requirements = managerActionSourceRequirements(snapshot, "a");
    expect(requirements).toEqual({
      sourceKeys: ["trello"],
      hasUnverifiedEvidence: false,
      assessedAt: Date.parse("2026-09-25T11:55:00Z"),
    });
    expect(managerActionNeedsSourceVerification(requirements, {
      trelloCache: { cachedAt: "2026-09-25T11:55:00Z", expiresAt: "2026-09-25T12:05:00Z" },
      gmail: { enabled: true, lastSyncedAt: "2026-09-25T10:00:00Z", intervalMinutes: 30 },
      drive: null,
      googleConnectionReady: true,
      now: Date.parse("2026-09-25T12:00:00Z"),
    })).toBe(false);
    expect(managerActionNeedsSourceVerification(managerActionSourceRequirements(snapshot, "b"), {
      trelloCache: { cachedAt: "2026-09-25T11:55:00Z", expiresAt: "2026-09-25T12:05:00Z" },
      gmail: { enabled: true, lastSyncedAt: "2026-09-25T10:00:00Z", intervalMinutes: 30 },
      drive: null,
      googleConnectionReady: true,
      now: Date.parse("2026-09-25T12:00:00Z"),
    })).toBe(false);
  });

  it("blocks when the next executable action cites a stale required source", () => {
    const snapshot = JSON.stringify({
      assessedAt: "2026-09-25T11:00:00Z",
      actions: [{ cardId: "a", blocked: false, evidenceIds: ["mail"] }],
      evidence: [{ id: "mail", cardId: "a", source: "gmail", kind: "source" }],
    });
    const requirements = managerActionSourceRequirements(snapshot, "a");
    expect(requirements.sourceKeys).toEqual(["gmail"]);
    expect(managerActionNeedsSourceVerification(requirements, {
      trelloCache: null,
      gmail: { enabled: true, lastSyncedAt: "2026-09-25T10:00:00Z", intervalMinutes: 30 },
      drive: null,
      googleConnectionReady: true,
      now: Date.parse("2026-09-25T12:00:00Z"),
    })).toBe(true);
  });

  it("requires reassessment when a cited source was synced after the manager review", () => {
    const requirements = managerActionSourceRequirements(JSON.stringify({
      assessedAt: "2026-09-25T11:55:00Z",
      actions: [{ cardId: "a", blocked: false, evidenceIds: ["mail"] }],
      evidence: [{ id: "mail", cardId: "a", source: "gmail", kind: "source" }],
    }), "a");

    expect(managerActionNeedsSourceVerification(requirements, {
      trelloCache: null,
      gmail: { enabled: true, lastSyncedAt: "2026-09-25T11:56:00Z", intervalMinutes: 30 },
      drive: null,
      googleConnectionReady: true,
      now: Date.parse("2026-09-25T12:00:00Z"),
    })).toBe(true);
  });

  it("does not block a current Gmail action because an unrelated Trello cache is missing", () => {
    const requirements = managerActionSourceRequirements(JSON.stringify({
      assessedAt: "2026-09-25T11:55:00Z",
      actions: [{ cardId: "a", blocked: false, evidenceIds: ["mail"] }],
      evidence: [{ id: "mail", cardId: "a", source: "gmail", kind: "source" }],
    }), "a");
    expect(managerActionNeedsSourceVerification(requirements, {
      trelloCache: null,
      gmail: { enabled: true, lastSyncedAt: "2026-09-25T11:55:00Z", intervalMinutes: 30 },
      drive: null,
      googleConnectionReady: true,
      now: Date.parse("2026-09-25T12:00:00Z"),
    })).toBe(false);
  });

  it("fails closed for cited evidence that is missing or explicitly unverified", () => {
    const missing = managerActionSourceRequirements(JSON.stringify({
      assessedAt: "2026-09-25T11:55:00Z",
      actions: [{ cardId: "a", blocked: false, evidenceIds: ["missing"] }], evidence: [],
    }), "a");
    const unverified = managerActionSourceRequirements(JSON.stringify({
      assessedAt: "2026-09-25T11:55:00Z",
      actions: [{ cardId: "a", blocked: false, evidenceIds: ["claim"] }],
      evidence: [{ id: "claim", cardId: "a", source: "gmail", kind: "worker", metadata: { truthClass: "worker_report" } }],
    }), "a");
    const absentEvidenceList = managerActionSourceRequirements(JSON.stringify({
      assessedAt: "2026-09-25T11:55:00Z",
      actions: [{ cardId: "a", blocked: false }], evidence: [],
    }), "a");
    const currentSources = { trelloCache: null, gmail: null, drive: null, googleConnectionReady: null, now: Date.now() };
    expect(managerActionNeedsSourceVerification(missing, currentSources)).toBe(true);
    expect(managerActionNeedsSourceVerification(unverified, currentSources)).toBe(true);
    expect(managerActionNeedsSourceVerification(absentEvidenceList, currentSources)).toBe(true);
  });

  it("requires complete coverage for the exact current assignment set", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    const snapshot = JSON.stringify({ executionCoverageComplete: true, assignmentFingerprint: "current",
      assessedAt: "2026-09-25T11:55:00Z", nextCheckAt: "2026-09-25T12:00:00Z",
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" } });
    expect(managerExecutionCoverageComplete(snapshot, "current", now - 1)).toBe(true);
    expect(managerExecutionCoverageComplete(snapshot, "current", now)).toBe(false);
    expect(managerExecutionCoverageComplete(snapshot, "changed", now - 1)).toBe(false);
    expect(managerExecutionCoverageComplete(snapshot, null, now - 1)).toBe(false);
    expect(managerExecutionCoverageComplete(JSON.stringify({ executionCoverageComplete: false, assignmentFingerprint: "current" }), "current", now - 1)).toBe(false);
    expect(managerExecutionCoverageComplete(JSON.stringify({ executionCoverageComplete: true }), "current", now - 1)).toBe(false);
    expect(() => managerExecutionCoverageComplete("invalid", "current", now - 1)).toThrow();
  });

  it("fails closed when the manager assessment is stale, incomplete, or has invalid timing", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    const valid = { executionCoverageComplete: true, assignmentFingerprint: "current",
      assessedAt: "2026-09-25T11:55:00Z", nextCheckAt: "2026-09-25T12:00:00Z",
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" } };
    const cases = [
      { ...valid, assessedAt: "2026-09-25T11:54:59Z", nextCheckAt: "2026-09-25T12:10:00Z" },
      { ...valid, assessedAt: "2026-09-25T12:00:01Z" },
      { ...valid, assessedAt: "not-a-date" },
      { ...valid, nextCheckAt: null },
      { ...valid, nextCheckAt: "2026-09-25T11:54:00Z" },
      { ...valid, policy: { enabled: false, intervalMinutes: 5, mode: "shadow" } },
      { ...valid, policy: { enabled: true, intervalMinutes: 0, mode: "shadow" } },
    ];
    for (const snapshot of cases) {
      expect(managerExecutionCoverageComplete(JSON.stringify(snapshot), "current", now)).toBe(false);
    }
  });

  it("fails closed on an unreadable manager snapshot", () => {
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [{ cardId: "a" }] }), "a")).toBe(true);
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [{ cardId: "a" }] }), "b")).toBe(false);
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [], actions: [{ cardId: "a", blocked: true }] }), "a")).toBe(true);
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [], actions: [{ cardId: "a", blocked: true }, { cardId: "a", blocked: false }] }), "a")).toBe(false);
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [], actions: [{ cardId: "a", kind: "decision", blocked: false }] }), "a")).toBe(true);
    expect(() => managerIntervenesOnCard("{}", "a")).toThrow(/unavailable/i);
  });
});
