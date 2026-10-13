import { describe, expect, it } from "vitest";
import { decisionEscalation } from "./founderDecisionInbox";
import { founderDecisionAlertStage } from "./founderDecisionAlerts";

const NOW = Date.parse("2026-09-23T12:00:00Z");

describe("founder decision escalation", () => {
  it("treats a recorded task deadline as an escalation hint, not a fabricated decision deadline", () => {
    expect(decisionEscalation(null, "2026-09-23T11:59:00Z", "LOW", NOW)).toBe("task_overdue");
    expect(decisionEscalation(null, "2026-09-24T11:59:00Z", "MEDIUM", NOW)).toBe("task_due_soon");
    expect(decisionEscalation(null, "2026-09-25T12:00:00Z", "CRITICAL", NOW)).toBe("none");
  });

  it("surfaces high-priority work without inventing an absent deadline", () => {
    expect(decisionEscalation(null, null, "CRITICAL", NOW)).toBe("high_priority_no_deadline");
    expect(decisionEscalation(null, null, "MEDIUM", NOW)).toBe("none");
  });

  it("ranks a founder deadline separately from the task deadline", () => {
    expect(decisionEscalation("2026-09-23T11:59:00Z", null, "LOW", NOW)).toBe("decision_overdue");
    expect(decisionEscalation("2026-09-23T13:00:00Z", null, "LOW", NOW)).toBe("decision_due_soon");
    expect(decisionEscalation("2026-09-25T12:00:00Z", "2026-09-23T11:00:00Z", "LOW", NOW)).toBe("task_overdue");
  });
});

describe("founder decision alert timing", () => {
  it("does not invent a deadline or alert too early", () => {
    expect(founderDecisionAlertStage(null, new Date(NOW))).toBeNull();
    expect(founderDecisionAlertStage(new Date(NOW + 24 * 60 * 60_000 + 1), new Date(NOW))).toBeNull();
  });

  it("distinguishes a deadline within 24 hours from an overdue decision", () => {
    expect(founderDecisionAlertStage(new Date(NOW + 24 * 60 * 60_000), new Date(NOW))).toBe("due_soon");
    expect(founderDecisionAlertStage(new Date(NOW), new Date(NOW))).toBe("overdue");
  });
});
