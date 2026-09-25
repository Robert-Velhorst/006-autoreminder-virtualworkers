import { describe, expect, it } from "vitest";
import { canRecordWaitingReasonForCard, canStartTimerForCard, managerExecutionCoverageComplete, managerIntervenesOnCard, timerExecutionBlockReason } from "./timerAccess";

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
    expect(timerExecutionBlockReason({ ...ready, executionCoverageComplete: false })).toMatch(/full work list has not been checked/i);
  });

  it("requires complete coverage for the exact current assignment set", () => {
    const snapshot = JSON.stringify({ executionCoverageComplete: true, assignmentFingerprint: "current" });
    expect(managerExecutionCoverageComplete(snapshot, "current")).toBe(true);
    expect(managerExecutionCoverageComplete(snapshot, "changed")).toBe(false);
    expect(managerExecutionCoverageComplete(snapshot, null)).toBe(false);
    expect(managerExecutionCoverageComplete(JSON.stringify({ executionCoverageComplete: false, assignmentFingerprint: "current" }), "current")).toBe(false);
    expect(managerExecutionCoverageComplete(JSON.stringify({ executionCoverageComplete: true }), "current")).toBe(false);
    expect(() => managerExecutionCoverageComplete("invalid", "current")).toThrow();
  });

  it("fails closed on an unreadable manager snapshot", () => {
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [{ cardId: "a" }] }), "a")).toBe(true);
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [{ cardId: "a" }] }), "b")).toBe(false);
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [], actions: [{ cardId: "a", blocked: true }] }), "a")).toBe(true);
    expect(managerIntervenesOnCard(JSON.stringify({ interventions: [], actions: [{ cardId: "a", blocked: true }, { cardId: "a", blocked: false }] }), "a")).toBe(false);
    expect(() => managerIntervenesOnCard("{}", "a")).toThrow(/unavailable/i);
  });
});
