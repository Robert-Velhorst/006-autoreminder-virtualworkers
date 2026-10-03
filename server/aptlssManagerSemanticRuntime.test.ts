import { describe, expect, it, vi } from "vitest";
import { finishManagerSemanticReview, managerSemanticBackoff, managerSemanticRetryReady } from "./aptlssManagerSemanticRuntime";

vi.mock("./aptlssManagerReviewService", () => ({ assertManagerExecutionAllowed: vi.fn() }));

describe("semantic retry budget", () => {
  it("waits six hours on exhausted credit instead of retrying every cycle", () => {
    expect(managerSemanticBackoff(1, "quota")).toBe(6 * 60 * 60_000);
    expect(managerSemanticBackoff(10, "quota")).toBe(6 * 60 * 60_000);
  });
  it("keeps bounded exponential retry for transient failures", () => {
    expect(managerSemanticBackoff(1)).toBe(60_000);
    expect(managerSemanticBackoff(10)).toBe(15 * 60_000);
  });
  it("allows an explicit billing-recovery retry after one minute but not periodic bypass", () => {
    const state = { failureKind: "quota" as const, attemptedAt: "2026-09-13T12:00:00Z", retryAfter: "2026-09-13T18:00:00Z" };
    expect(managerSemanticRetryReady(state, true, Date.parse("2026-09-13T12:00:30Z"))).toBe(false);
    expect(managerSemanticRetryReady(state, true, Date.parse("2026-09-13T12:01:00Z"))).toBe(true);
    expect(managerSemanticRetryReady(state, false, Date.parse("2026-09-13T12:01:00Z"))).toBe(false);
  });

  it("rejects untrusted provider diagnostics before writing runtime state", async () => {
    const runtime = {
      attemptId: "attempt-1",
      sourceHash: "a".repeat(64),
      success: false,
      attemptedAt: "2026-09-13T12:00:00.000Z",
      retryAfter: "2026-09-13T12:01:00.000Z",
      failures: 1,
      provider: "openai-api" as const,
    };
    const row = { value: JSON.stringify(runtime) };
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([row]),
    };
    const insert = vi.fn();
    const db = {
      select: vi.fn(() => query),
      insert,
    } as never;
    const taintedAttempts = [{
      effort: "low",
      outcome: "invalid_output",
      reason: "validation",
      durationMs: 1,
      internalReasoning: "RAW_PROVIDER_DIAGNOSTIC_SENTINEL",
    }] as never;

    await expect(finishManagerSemanticReview(db, 7, runtime, false, undefined, taintedAttempts)).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
