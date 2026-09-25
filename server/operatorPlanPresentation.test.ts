import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("worker plan reliability presentation", () => {
  it("never presents an uncalibrated planning heuristic as a probability", () => {
    const source = readFileSync(new URL("../client/src/pages/worker/WorkerOperator.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("plan.planHealth.confidence}%");
    expect(source).not.toContain("Evidence-backed, capped below certainty");
    expect(source).not.toContain("card.confidenceScore}% confidence");
    expect(source).not.toContain("15 + elapsed * 8");
    expect(source).not.toContain("12 - elapsed");
    expect(source).toContain("completion estimate unavailable");
    expect(source).toContain("Plan could not be loaded");
    expect(source).toContain("Unscheduled details");
    expect(source).not.toContain("<InspectorLabel>Assessment</InspectorLabel>");
    expect(source).not.toContain("assessment checks");
    expect(source).not.toContain("confidenceReason");
    expect(source).not.toContain("Uncalibrated assessment");
    expect(source).toContain('"Protected day"');
  });
});
