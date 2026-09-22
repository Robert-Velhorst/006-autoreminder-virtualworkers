import { describe, expect, it } from "vitest";
import { canRecordWaitingReasonForCard, canStartTimerForCard } from "./timerAccess";

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
});
