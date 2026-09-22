import { describe, expect, it } from "vitest";
import { isProactiveFollowUpAutomationEnabled } from "./proactive-followup";

describe("isProactiveFollowUpAutomationEnabled", () => {
  it("keeps proactive follow-ups disabled unless notification delivery is explicitly enabled", () => {
    expect(isProactiveFollowUpAutomationEnabled({})).toBe(false);
    expect(isProactiveFollowUpAutomationEnabled({ NOTIFICATIONS_ENABLED: "false" })).toBe(false);
    expect(isProactiveFollowUpAutomationEnabled({ NOTIFICATIONS_ENABLED: "true" })).toBe(true);
  });
});
