import { describe, expect, it } from "vitest";
import { normalizeGeneratedAptlssPlan } from "./aptlss-generation";

describe("APTLSS plan normalization", () => {
  it("does not allow a high confidence claim to exceed available evidence", () => {
    const plan = normalizeGeneratedAptlssPlan({
      summary: "Do the work",
      nextBestAction: "Start",
      stateReason: "New",
      urgencyLabel: "HIGH",
      confidenceScore: 100,
      missingInformation: [],
      steps: [{ title: "Start", estimatedMinutes: 20, category: "T", requiresFounder: false }],
    }, { id: "card-1", name: "Title only" });

    expect(plan.confidenceScore).toBe(65);
    expect(plan.needsReview).toBe(true);
  });

  it("deduplicates steps and clamps unsafe estimates", () => {
    const plan = normalizeGeneratedAptlssPlan({
      confidenceScore: 90,
      missingInformation: [],
      steps: [
        { title: " Verify evidence ", estimatedMinutes: 1, category: "quality", requiresFounder: false },
        { title: "Verify evidence", estimatedMinutes: 900, category: "quality", requiresFounder: false },
        { title: "Record outcome", estimatedMinutes: 900, category: "handoff", requiresFounder: true },
      ],
    }, { id: "card-2", name: "Evidence review", desc: "A".repeat(100) });

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].estimatedMinutes).toBe(5);
    expect(plan.steps[1].estimatedMinutes).toBe(480);
    expect(plan.steps.map((step) => step.stepNumber)).toEqual([1, 2]);
  });

  it("creates an explicit clarification step when the model returns no usable steps", () => {
    const plan = normalizeGeneratedAptlssPlan({}, { id: "card-3", name: "Unclear task" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].category).toBe("clarification");
    expect(plan.nextBestAction).toContain("Review requirements");
  });
});
