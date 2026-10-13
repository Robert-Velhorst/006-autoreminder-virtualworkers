import { describe, expect, it } from "vitest";
import { describeWeeklyTimeEvidence } from "../shared/weeklyProgressEvidence";

describe("describeWeeklyTimeEvidence", () => {
  it("does not claim accuracy when no scheduled comparison exists", () => {
    expect(describeWeeklyTimeEvidence(2.5, null)).toEqual({
      label: "2.5h tracked",
      detail: "No scheduled-hours comparison is available for this week.",
      tone: "neutral",
    });
  });

  it("reports tracked time against a real scheduled comparison", () => {
    expect(describeWeeklyTimeEvidence(3, 6)).toEqual({
      label: "3h tracked of 6h scheduled",
      detail: "50% of scheduled time has tracked evidence.",
      tone: "neutral",
    });
  });

  it("flags tracked time that exceeds the available schedule", () => {
    expect(describeWeeklyTimeEvidence(7, 6)).toEqual({
      label: "7h tracked of 6h scheduled",
      detail: "Tracked time is 1h above the available schedule.",
      tone: "attention",
    });
  });
});
