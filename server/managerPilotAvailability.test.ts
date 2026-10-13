import { describe, expect, it } from "vitest";
import { managerExecutionCoverageReady } from "../client/src/lib/managerPilotAvailability";

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
