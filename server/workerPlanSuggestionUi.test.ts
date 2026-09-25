import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WorkerPlanSuggestion, { workerPlanSuggestionIsCurrent } from "../client/src/components/WorkerPlanSuggestion";
import type { ManagerPlanImpact } from "../shared/aptlssManagerPlanImpact";

function impact(): ManagerPlanImpact {
  return {
    version: 1,
    assessedAt: "2026-09-23T08:00:00Z",
    dateKey: "2026-09-23",
    timezone: "Europe/Amsterdam",
    baseline: "same_day_plan",
    scheduleChanged: true,
    requiresReview: true,
    planChanges: [
      { kind: "moved", blockId: "a", cardName: "Verify delivery", before: { startTime: "09:00", endTime: "09:20" }, after: { startTime: "10:00", endTime: "10:20" }, reason: "Source verification takes priority.", assumptionIds: ["source-a"] },
      { kind: "removed", blockId: "b", cardName: "Prepare reply", before: { startTime: "11:00", endTime: "11:30" }, after: null, reason: "The source has not been checked.", assumptionIds: ["source-b"] },
    ],
    protectedBlocks: [{ blockId: "active", reasons: ["active_timer"], preservedExactly: true, assumptionIds: [] }],
  } as ManagerPlanImpact;
}

function render(overrides: Partial<Parameters<typeof WorkerPlanSuggestion>[0]> = {}) {
  return renderToStaticMarkup(createElement(WorkerPlanSuggestion, {
    impact: impact(), expectedPlanVersion: "v1", currentPlanVersion: "v1",
    currentDateKey: "2026-09-23", hasSavedPlan: true, applied: false,
    ...overrides,
  }));
}

describe("worker plan suggestion", () => {
  it("shows a plain-language comparison while keeping the saved agenda authoritative", () => {
    const html = render();
    expect(html).toContain("Suggested changes to your day");
    expect(html).toContain("Not applied");
    expect(html).toContain("agenda below is still the plan to follow");
    expect(html).toContain("Verify delivery");
    expect(html).toContain("09:00-09:20");
    expect(html).toContain("10:00-10:20");
    expect(html).toContain("Not in the suggestion");
    expect(html).toContain("protected block stays unchanged");
    expect(html).not.toMatch(/assumptionIds|source-a|AI:|Luna|inputHash/);
  });

  it("does not present an outdated or applied suggestion as work to follow", () => {
    const stale = render({ currentPlanVersion: "v2" });
    expect(stale).toContain("no longer matches");
    expect(stale).not.toContain("Verify delivery");
    const applied = render({ applied: true });
    expect(applied).toContain("Check saved plan");
    expect(applied).not.toContain("Not applied");
    expect(applied).not.toContain("Verify delivery");
    expect(workerPlanSuggestionIsCurrent({ impact: impact(), expectedPlanVersion: "v1", currentPlanVersion: "v2", currentDateKey: "2026-09-23", hasSavedPlan: true })).toBe(false);
  });

  it("shows new-day proposals only when no saved plan exists", () => {
    const newDay = impact();
    newDay.baseline = "no_plan";
    expect(render({ impact: newDay, hasSavedPlan: false, currentPlanVersion: null })).toContain("No agenda is saved for today");
    expect(render({ impact: newDay, hasSavedPlan: true })).toContain("no longer matches");
    expect(render({ impact: newDay, currentDateKey: "2026-09-24" })).toBe("");
  });

  it("does not claim block-level knowledge for an older snapshot", () => {
    const older = impact();
    delete older.planChanges;
    expect(render({ impact: older })).toContain("block-by-block comparison was not recorded");
    expect(render({ impact: older })).not.toContain("No individual work block is proposed to change");
  });

  it("escapes source-derived task and reason text", () => {
    const unsafe = impact();
    unsafe.planChanges![0].cardName = "<script>bad()</script>";
    const html = render({ impact: unsafe });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
