import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ManagerPlanImpact from "../client/src/components/ManagerPlanImpact";
import type { ManagerPlanImpact as Impact } from "../shared/aptlssManagerPlanImpact";

function fixture(): Impact {
  const buffer = {
    unallocatedMinutes: 60,
    largestWindowMinutes: 30,
    additionalHighEstimateMinutes: null,
    afterHighEstimatesMinutes: null,
    minimumKnownDeficitMinutes: 0,
    unknownEstimateBlockIds: ["legacy"],
  };
  return {
    version: 1,
    assessedAt: "2026-09-04T08:00:00Z",
    dateKey: "2026-09-04",
    timezone: "Europe/Amsterdam",
    baseline: "same_day_plan",
    scheduleChanged: true,
    requiresReview: false,
    planChanges: [
      { kind: "moved", blockId: "future", cardName: "Current case", before: { startTime: "10:00", endTime: "10:30" }, after: { startTime: "11:00", endTime: "11:30" }, reason: "A new source needs review first.", assumptionIds: ["card:future"] },
    ],
    availabilityChanged: false,
    assumptions: [
      {
        id: "card:future",
        inputPath: "cards[0].dueAt",
        value: "2026-10-04T10:00:00Z",
        limitation: "Current deadline only.",
      },
    ],
    deadlines: [
      {
        cardId: "future",
        dueAt: "2026-10-04T10:00:00Z",
        movement: "unknown",
        assumptionIds: ["card:future"],
        before: {
          blockIds: [],
          unscheduledActionIds: ["next"],
          latestScheduledEndAt: null,
          slackMinutes: null,
          status: "unscheduled",
        },
        after: {
          blockIds: [],
          unscheduledActionIds: ["next"],
          latestScheduledEndAt: null,
          slackMinutes: null,
          status: "unscheduled",
        },
      },
    ],
    dependencies: [],
    buffer: {
      before: buffer,
      after: buffer,
      unallocatedDeltaMinutes: 0,
      reservations: [],
      assumptionIds: [],
    },
    protectedBlocks: [
      {
        blockId: "legacy",
        reasons: ["active_timer"],
        preservedExactly: true,
        assumptionIds: [],
      },
    ],
    alternative: {
      kind: "keep_current_plan",
      available: true,
      blockIds: ["legacy"],
      deadlineRiskCardIds: ["future"],
      dependencyRiskActionIds: [],
      buffer,
      limitation: "Not verified safe.",
    },
    risks: [
      {
        code: "deadline_unscheduled",
        subjectId: "future",
        detail: "Deferred future work.",
        assumptionIds: ["card:future"],
        requiresReview: false,
      },
    ],
    limitations: ["Slots are not completion forecasts."],
  };
}

describe("ManagerPlanImpact disclosure", () => {
  it("states absence for retained proposals without preflight data", () => {
    expect(
      renderToStaticMarkup(createElement(ManagerPlanImpact, {}))
    ).toContain("Planning impact unavailable");
  });

  it("shows diagnostics as notices without claiming authorization or calibrated confidence", () => {
    const html = renderToStaticMarkup(
      createElement(ManagerPlanImpact, { impact: fixture() })
    );
    for (const text of [
      "Planning impact",
      "Changes from active plan",
      "Moved: Current case",
      "A new source needs review first.",
      "shadow proposal",
      "Working-time buffer",
      "Unknown",
      "Preserved exactly",
      "Alternative: keep current plan",
      "Source assumptions",
      "cards[0].dueAt",
      "2026-10-04T10:00:00Z",
      "Notice",
      "Slots are not completion forecasts.",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Review required");
    expect(html).not.toMatch(/\d+%|safe to apply|approved/i);
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("distinguishes a material risk and a negative buffer from unknown capacity", () => {
    const impact = fixture();
    impact.requiresReview = true;
    impact.risks[0].requiresReview = true;
    impact.buffer.after = {
      ...impact.buffer.after,
      afterHighEstimatesMinutes: -15,
    };
    const html = renderToStaticMarkup(
      createElement(ManagerPlanImpact, { impact })
    );
    expect(html).toContain("Review required");
    expect(html).toContain("-15 min");
  });

  it("escapes exact input values instead of treating source text as markup", () => {
    const impact = fixture();
    impact.assumptions[0].value = "<script>untrusted()</script>";
    const html = renderToStaticMarkup(
      createElement(ManagerPlanImpact, { impact })
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("labels a legacy impact without block comparison as unknown rather than unchanged", () => {
    const impact = fixture();
    delete impact.planChanges;
    const html = renderToStaticMarkup(createElement(ManagerPlanImpact, { impact }));
    expect(html).toContain("Block comparison unavailable");
    expect(html).toContain("comparison was not recorded");
    expect(html).not.toContain("No changes to scheduled blocks");
  });
});
