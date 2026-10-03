import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  buildReminderAuditScopeFilter,
  buildReminderScheduleScopeFilter,
  evaluateReminderPolicy,
  reminderActorCanAccessOccurrence,
  reminderProfileBelongsToWorkspace,
  scheduleTimeForRule,
  selectReminderWorkspaceProfile,
} from "./reminderOrchestration";

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
  it("limits worker audit history to their own activity and assigned reminder objects", () => {
    const scope = buildReminderAuditScopeFilter({ id: 42, role: "worker", openId: "worker-42", email: "worker@example.com" }, 7);
    const query = new MySqlDialect().sqlToQuery(scope!);

    expect(query.sql).toContain("workspaceOwnerId");
    expect(query.sql).toContain("actorUserId");
    expect(query.sql).toContain("assignedUserId");
    expect(query.sql).toContain("recipientUserId");
    expect(query.params).toContain(7);
    expect(query.params).toContain(42);
  });

  it("keeps the founder audit view scoped to their workspace", () => {
    const scope = buildReminderAuditScopeFilter({ id: 7, role: "admin", openId: "admin-7", email: "admin@example.com" }, 7);
    const query = new MySqlDialect().sqlToQuery(scope);

    expect(query.sql).toContain("workspaceOwnerId");
    expect(query.sql).not.toContain("actorUserId");
    expect(query.sql).not.toContain("assignedUserId");
    expect(query.sql).not.toContain("recipientUserId");
    expect(query.params).toEqual([7]);
  });

  it("scopes worker reminder rows to their current workspace, assignment, and recipient", () => {
    const scope = buildReminderScheduleScopeFilter({ id: 42, role: "worker", openId: "worker-42", email: "worker@example.com" }, 7);
    const query = new MySqlDialect().sqlToQuery(scope!);

    expect(query.sql).toContain("workspaceOwnerId");
    expect(query.sql).toContain("assignedUserId");
    expect(query.sql).toContain("recipientUserId");
    expect(query.params).toEqual([7, 42, 42]);
  });

  it("requires a worker's current workspace and assigned recipient identity for reminder actions", () => {
    const worker = { id: 42, role: "worker" as const };
    const occurrence = {
      workspaceOwnerId: 7,
      assignedUserId: 42,
      recipientUserId: 42,
      currentWorkspaceOwnerId: 7,
    };

    expect(reminderActorCanAccessOccurrence(worker, occurrence)).toBe(true);
    expect(reminderActorCanAccessOccurrence(worker, { ...occurrence, currentWorkspaceOwnerId: 9 })).toBe(false);
    expect(reminderActorCanAccessOccurrence(worker, { ...occurrence, assignedUserId: 99 })).toBe(false);
    expect(reminderActorCanAccessOccurrence({ id: 7, role: "worker" }, occurrence)).toBe(false);
    expect(reminderActorCanAccessOccurrence({ id: 8, role: "admin" }, occurrence)).toBe(false);
    expect(reminderActorCanAccessOccurrence({ id: 7, role: "admin" }, occurrence)).toBe(true);
  });

  it("selects the worker's sole active workspace instead of historical profiles", () => {
    expect(selectReminderWorkspaceProfile([
      { status: "inactive", founderId: 10 },
      { status: "active", founderId: 20 },
    ])).toEqual({ status: "active", founderId: 20 });
  });

  it("rejects ambiguous active profiles and inactive-only workspaces", () => {
    expect(selectReminderWorkspaceProfile([
      { status: "active", founderId: 10 },
      { status: "active", founderId: 20 },
    ])).toBeNull();
    expect(selectReminderWorkspaceProfile([
      { status: "inactive", founderId: 10 },
      { status: "inactive", founderId: 20 },
    ])).toBeNull();
  });

  it("does not resolve a workspace from a sole inactive profile", () => {
    expect(selectReminderWorkspaceProfile([{ status: "inactive", founderId: 10 }]))
      .toBeNull();
  });

  it("does not allow a worker profile selected for another founder workspace", () => {
    expect(reminderProfileBelongsToWorkspace({ founderId: 10 }, 10)).toBe(true);
    expect(reminderProfileBelongsToWorkspace({ founderId: 10 }, 20)).toBe(false);
    expect(reminderProfileBelongsToWorkspace(null, 10)).toBe(false);
  });

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
