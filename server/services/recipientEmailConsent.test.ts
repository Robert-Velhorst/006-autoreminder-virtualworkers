import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { notificationHistory, userNotificationPreferences, users } from "../../drizzle/schema.postgres";

const controls = vi.hoisted(() => ({ getDb: vi.fn(), send: vi.fn() }));
vi.mock("../db", () => ({ getDb: controls.getDb }));
vi.mock("./email", () => ({ sendEmail: controls.send }));
import { hasPersistedEmailConsent, hasRecipientEmailConsent } from "./recipientEmailConsent";
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
    const where = vi.fn((_condition: any) => ({ limit: async () => [{ emailEnabled: 1, notificationMode: "priority_only" }] }));
    const innerJoin = vi.fn((_table: unknown, _condition: unknown) => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    controls.getDb.mockResolvedValue({ select: () => ({ from }) });
    expect(await hasRecipientEmailConsent(19)).toBe(true);
    expect(from).toHaveBeenCalledWith(users);
    expect(innerJoin.mock.calls[0][0]).toBe(userNotificationPreferences);
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
});

describe("digest delivery uses actual recipient consent", () => {
  beforeEach(() => vi.resetAllMocks());
  function database(preferences: Array<Record<string, unknown> | undefined>) {
    const update = vi.fn();
    const insert = vi.fn();
    const historyRead = vi.fn();
    let index = 0;
    controls.getDb.mockResolvedValue({ update, insert, select: () => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === users ? [{ id: 19, openId: "recipient", name: "Recipient", email: "recipient@example.invalid" }]
        : table === userNotificationPreferences ? [preferences[index++]].filter(Boolean)
        : table === notificationHistory ? [{ id: 1, title: "Notice", content: "Task update", notificationType: "general", createdAt: new Date() }] : [];
      return { limit: async () => rows, orderBy: async () => { historyRead(); return rows; } };
    } }) }) });
    return { update, insert, historyRead };
  }
  it.each([undefined, { emailEnabled: 0, notificationMode: "daily_digest" },
    { emailEnabled: 1, notificationMode: "disabled" }])("never invokes delivery for %j", preference => {
    const fixture = database([preference]);
    return sendDigestToUser("recipient").then(result => {
      expect(result).toBe(false);
      expect(controls.send).not.toHaveBeenCalled();
      expect(fixture.historyRead).not.toHaveBeenCalled();
      expect(fixture.update).not.toHaveBeenCalled();
      expect(fixture.insert).not.toHaveBeenCalled();
    });
  });
  it("honors an opt-out recorded while digest content was being read", async () => {
    const fixture = database([{ emailEnabled: 1, notificationMode: "daily_digest" },
      { emailEnabled: 0, notificationMode: "daily_digest" }]);
    expect(await sendDigestToUser("recipient")).toBe(false);
    expect(fixture.historyRead).toHaveBeenCalledOnce();
    expect(controls.send).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
  });
  it("does not interpret provider rejection as a sent digest", async () => {
    const preference = { emailEnabled: 1, notificationMode: "daily_digest" };
    const fixture = database([preference, preference]);
    controls.send.mockResolvedValue(false);
    expect(await sendDigestToUser("recipient")).toBe(false);
    expect(controls.send).toHaveBeenCalledOnce();
    expect(fixture.update).not.toHaveBeenCalled();
  });
});
