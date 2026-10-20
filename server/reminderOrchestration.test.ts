import { describe, expect, it } from "vitest";
import { evaluateReminderPolicy, scheduleTimeForRule } from "./reminderOrchestration";

const policy = {
  enabled: true,
  inAppEnabled: true,
  emailEnabled: true,
  maxPerDay: 3,
  minIntervalMinutes: 60,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  timezone: "UTC",
  allowWeekends: true,
};

describe("durable reminder policy", () => {
  it("calculates before and after due schedules deterministically", () => {
    const due = new Date("2026-08-10T12:00:00.000Z");
    expect(scheduleTimeForRule(due, "before_due", 90).toISOString()).toBe("2026-08-10T10:30:00.000Z");
    expect(scheduleTimeForRule(due, "after_due", 30).toISOString()).toBe("2026-08-10T12:30:00.000Z");
    expect(scheduleTimeForRule(due, "at_due", 999).toISOString()).toBe(due.toISOString());
  });

  it("fails closed when the recipient opted out of a channel", () => {
    const result = evaluateReminderPolicy({
      policy: { ...policy, emailEnabled: false },
      channel: "email",
      now: new Date("2026-08-10T12:00:00.000Z"),
      sentToday: 0,
      lastSentAt: null,
    });
    expect(result).toMatchObject({ allowed: false, permanent: true });
    expect(result.reason).toContain("disabled");
  });

  it("defers during quiet hours and never claims delivery", () => {
    const result = evaluateReminderPolicy({
      policy,
      channel: "in_app",
      now: new Date("2026-08-10T23:00:00.000Z"),
      sentToday: 0,
      lastSentAt: null,
    });
    expect(result).toMatchObject({ allowed: false, permanent: false });
    expect(result.retryAt).toBeInstanceOf(Date);
  });

  it("enforces daily caps and cooldowns", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    expect(evaluateReminderPolicy({ policy, channel: "in_app", now, sentToday: 3, lastSentAt: null }).allowed).toBe(false);
    const cooldown = evaluateReminderPolicy({ policy, channel: "in_app", now, sentToday: 0, lastSentAt: new Date("2026-08-10T11:30:00.000Z") });
    expect(cooldown.allowed).toBe(false);
    expect(cooldown.retryAt?.toISOString()).toBe("2026-08-10T12:30:00.000Z");
  });

  it("allows a reminder only after all controls pass", () => {
    expect(evaluateReminderPolicy({
      policy,
      channel: "email",
      now: new Date("2026-08-10T12:00:00.000Z"),
      sentToday: 1,
      lastSentAt: new Date("2026-08-10T10:00:00.000Z"),
    })).toMatchObject({ allowed: true, permanent: false, retryAt: null });
  });
});
