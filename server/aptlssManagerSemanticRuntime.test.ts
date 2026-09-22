import { describe, expect, it } from "vitest";
import { managerSemanticBackoff, managerSemanticRetryReady } from "./aptlssManagerSemanticRuntime";

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
});
