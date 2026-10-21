import { describe, expect, it } from "vitest";
import { managerExecutionCoverageReady, managerStatusRetryRemaining, managerStatusQueryOptions, managerStatusPollingInterval } from "../client/src/lib/managerPilotAvailability";

const pilotDenied = {
  message: "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.",
  data: { code: "FORBIDDEN" },
};

describe("managerExecutionCoverageReady", () => {
  it("does not require APTLSS coverage for workers outside the pilot", () => {
    expect(managerExecutionCoverageReady(pilotDenied, undefined)).toBe(true);
  });

  it("requires explicit complete coverage for pilot workers", () => {
    expect(managerExecutionCoverageReady(undefined, true)).toBe(true);
    expect(managerExecutionCoverageReady(undefined, false)).toBe(false);
    expect(managerExecutionCoverageReady(undefined, undefined)).toBe(false);
  });

  it("does not treat unrelated authorization failures as non-pilot status", () => {
    expect(managerExecutionCoverageReady({ message: pilotDenied.message, data: { code: "UNAUTHORIZED" } }, undefined)).toBe(false);
    expect(managerExecutionCoverageReady({ message: "Other forbidden operation", data: { code: "FORBIDDEN" } }, undefined)).toBe(false);
  });
});

describe("manager status read recovery", () => {
  it("honors typed numeric retryAfter until its deadline without enabling mutation retries", () => {
    const error = { data: { code: "TOO_MANY_REQUESTS", retryAfter: 90 } };
    expect(managerStatusRetryRemaining(error, 1000, 1000)).toBe(90_000);
    expect(managerStatusRetryRemaining(error, 1000, 90_999)).toBe(1);
    expect(managerStatusRetryRemaining(error, 1000, 91_000)).toBe(0);
    expect(managerStatusQueryOptions.retry).toBe(false);
  });

  it("does not turn generic errors or malformed cooldowns into a permanent lock", () => {
    for (const error of [new Error("read failed"), null, { data: {} }, ...["90", NaN, Infinity, -1, 0].map(retryAfter => ({ data: { retryAfter } }))]) {
      expect(managerStatusRetryRemaining(error, 1000, 1000)).toBe(0);
    }
    expect(managerStatusRetryRemaining({ data: { retryAfter: 0.5 } }, 1000, 1001)).toBe(499);
  });

  it("keeps pilot denials disabled while generic errors remain recoverable", () => {
    const query = { state: { error: pilotDenied } };
    expect(managerStatusQueryOptions.enabled(query)).toBe(false);
    expect(managerStatusPollingInterval(query)).toBe(false);
    expect(managerStatusQueryOptions.refetchOnReconnect(query)).toBe(false);
    expect(managerStatusQueryOptions.refetchOnWindowFocus(query)).toBe(false);
    expect(managerStatusQueryOptions.enabled({ state: { error: new Error("read failed") } })).toBe(true);
  });

  it("defers polling and focus/reconnect reads during the same server cooldown", () => {
    const query = { state: { error: { data: { code: "TOO_MANY_REQUESTS", retryAfter: 90 } }, errorUpdatedAt: Date.now() } };
    expect(managerStatusPollingInterval(query)).toBeGreaterThan(89_000);
    expect(managerStatusQueryOptions.refetchOnWindowFocus(query)).toBe(false);
    expect(managerStatusQueryOptions.refetchOnReconnect(query)).toBe(false);
    query.state.errorUpdatedAt -= 90_001;
    expect(managerStatusPollingInterval(query)).toBe(60_000);
    expect(managerStatusQueryOptions.refetchOnWindowFocus(query)).toBe(true);
  });
});
