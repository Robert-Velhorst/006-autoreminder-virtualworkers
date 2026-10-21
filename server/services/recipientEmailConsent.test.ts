import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { notificationHistory, userNotificationPreferences, users } from "../../drizzle/schema.postgres";

const controls = vi.hoisted(() => ({ getDb: vi.fn(), send: vi.fn(), deliver: vi.fn(), profile: vi.fn() }));
vi.mock("../db", () => ({ getDb: controls.getDb }));
vi.mock("../workerOperatorContext", () => ({ getActiveWorkerProfileId: controls.profile }));
vi.mock("./email", () => ({ sendEmail: controls.send }));
vi.mock("./digest-outbox", () => ({ deliverDigestForUser: controls.deliver,
  enqueueDigestNotification: vi.fn(), readQueuedDigestNotifications: vi.fn() }));
import { getConsentingRecipientEmail, hasPersistedEmailConsent, hasRecipientEmailConsent } from "./recipientEmailConsent";
import { sendDigestToUser } from "./digest-scheduler";

describe("persisted recipient email consent", () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([undefined, null, {}, { emailEnabled: 1 },
    { emailEnabled: 0, notificationMode: "daily_digest" },
    { emailEnabled: 1, notificationMode: "disabled" },
    { emailEnabled: 1, notificationMode: "unknown" }])("fails closed for %j", preferences => {
    expect(hasPersistedEmailConsent(preferences)).toBe(false);
  });
  it.each(["daily_digest", "priority_only"])("accepts explicit email consent in %s", notificationMode => {
    expect(hasPersistedEmailConsent({ emailEnabled: 1, notificationMode })).toBe(true);
  });
  it("binds the preference read to the recipient's persisted user identity", async () => {
    const where = vi.fn((_condition: any) => ({ limit: async () => [{ role: 'admin', emailEnabled: 1, notificationMode: "priority_only" }] }));
    const innerJoin = vi.fn((_table: unknown, _condition: unknown) => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    controls.getDb.mockResolvedValue({ select: () => ({ from }) });
    expect(await hasRecipientEmailConsent(19)).toBe(true);
    expect(from).toHaveBeenCalledWith(users);
    expect(innerJoin.mock.calls[0][0]).toBe(userNotificationPreferences);
    const join = new PgDialect().sqlToQuery(innerJoin.mock.calls[0][1] as SQL);
    expect(join.sql).toBe('("users"."openId" = "user_notification_preferences"."userOpenId" and "users"."id" = "user_notification_preferences"."userId")');
    expect(join.params).toEqual([]);
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params).toEqual([19]);
  });
  it("does not grant consent when storage or a preference is absent", async () => {
    controls.getDb.mockResolvedValue(null);
    expect(await hasRecipientEmailConsent(19)).toBe(false);
    controls.getDb.mockResolvedValue({ select: () => ({ from: () => ({ innerJoin: () => ({
      where: () => ({ limit: async () => [] }),
    }) }) }) });
    expect(await hasRecipientEmailConsent(19)).toBe(false);
  });
  it.each(['priority_only', 'daily_digest'] as const)('separates channel consent from routine digest consent in %s', async notificationMode => {
    controls.getDb.mockResolvedValue({ select: () => ({ from: () => ({ innerJoin: () => ({
      where: () => ({ limit: async () => [{ role: 'admin', emailEnabled: 1, notificationMode }] }),
    }) }) }) });
    expect(await hasRecipientEmailConsent(19)).toBe(true);
    expect(await hasRecipientEmailConsent(19, 'daily_digest')).toBe(notificationMode === 'daily_digest');
    expect(await hasRecipientEmailConsent(19, 'priority_only')).toBe(notificationMode === 'priority_only');
    expect(controls.send).not.toHaveBeenCalled();
  });
  it('requires canonical active-worker eligibility while exempting admins and rejecting pending users', async () => {
    let role = 'worker';
    const db = { select: () => ({ from: () => ({ innerJoin: () => ({
      where: () => ({ limit: async () => [{ role, emailEnabled: 1, notificationMode: 'daily_digest' }] }),
    }) }) }) };
    controls.getDb.mockResolvedValue(db);
    controls.profile.mockResolvedValue(null);
    expect(await hasRecipientEmailConsent(19, 'daily_digest')).toBe(false);
    expect(controls.profile).toHaveBeenCalledWith(19, db);
    controls.profile.mockResolvedValue(8);
    expect(await hasRecipientEmailConsent(19, 'daily_digest')).toBe(true);
    role = 'admin'; controls.profile.mockClear();
    expect(await hasRecipientEmailConsent(19, 'daily_digest')).toBe(true);
    expect(controls.profile).not.toHaveBeenCalled();
    role = 'user';
    expect(await hasRecipientEmailConsent(19, 'daily_digest')).toBe(false);
    expect(controls.send).not.toHaveBeenCalled();
  });
  it.each([
    { emailAddress: 'preference@example.invalid', userEmail: 'account@example.invalid', expected: 'preference@example.invalid' },
    { emailAddress: null, userEmail: 'account@example.invalid', expected: 'account@example.invalid' },
    { emailAddress: null, userEmail: null, expected: null },
  ])('projects the consenting recipient address: %j', async ({ emailAddress, userEmail, expected }) => {
    const select = vi.fn((_projection: unknown) => ({ from: () => ({ innerJoin: () => ({
      where: () => ({ limit: async () => [{ role: 'admin', emailEnabled: 1,
        notificationMode: 'daily_digest', emailAddress, userEmail }] }),
    }) }) }));
    controls.getDb.mockResolvedValue({ select });
    expect(await getConsentingRecipientEmail(19, 'daily_digest')).toBe(expected);
    expect(select.mock.calls[0][0]).toMatchObject({ emailAddress: userNotificationPreferences.emailAddress, userEmail: users.email });
    expect(controls.send).not.toHaveBeenCalled();
  });
});

describe("digest delivery uses actual recipient consent", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it.each(['not_sent', 'uncertain', 'empty', 'skipped'])("preserves the durable core's %s outcome without a second provider path", async state => {
    const previous = process.env.NOTIFICATIONS_ENABLED;
    process.env.NOTIFICATIONS_ENABLED = 'true';
    try {
      controls.deliver.mockResolvedValue({ state, count: 0 });
      expect(await sendDigestToUser('recipient')).toBe(false);
      expect(controls.deliver).toHaveBeenCalledWith('recipient', { trigger: 'manual' });
      expect(controls.send).not.toHaveBeenCalled();
      expect(controls.getDb).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.NOTIFICATIONS_ENABLED;
      else process.env.NOTIFICATIONS_ENABLED = previous;
    }
  });
});
