import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { dailyComplianceSnapshots, notificationHistory, userNotificationPreferences, timeEntries, users, vaProfiles } from "../../drizzle/schema.postgres";
import type { ScheduledJobContext } from "../scheduledJobRuntime";

const controls = vi.hoisted(() => ({
  getDb: vi.fn(), run: vi.fn(), notify: vi.fn(), cards: vi.fn(), comments: vi.fn(),
  operator: vi.fn(), target: vi.fn(),
  ownerProvider: vi.fn(),
}));
vi.mock("../db", () => ({ getDb: controls.getDb }));
vi.mock("../scheduledJobRuntime", async importOriginal => ({
  ...await importOriginal<typeof import("../scheduledJobRuntime")>(),
  runScheduledJob: controls.run,
}));
vi.mock("../_core/notification", () => ({ notifyOwner: controls.ownerProvider }));
vi.mock("./trello-manus", () => ({
  getWorkerCards: controls.cards, getWorkerCommentedCardIdsToday: controls.comments,
  isDoingList: () => false, isOnHoldList: () => false,
}));
vi.mock("../workerOperatorContext", () => ({ resolveWorkerOperatorContextById: controls.operator }));
vi.mock("../complianceMetrics", () => ({ calculateScheduledTargetSeconds: controls.target }));

import { ScheduledJobLeaseLostError } from "../scheduledJobRuntime";
import { collectComplianceSnapshot, startManusScheduler, stopManusScheduler } from "./manus-scheduler";

const worker = { id: 7, userId: 41, founderId: 9, name: "Synthetic worker", timezone: "UTC",
  status: "active", trelloMemberId: "synthetic-member" } as typeof vaProfiles.$inferSelect;

function timer(id = 1, overrides: Partial<typeof timeEntries.$inferSelect> = {}): typeof timeEntries.$inferSelect {
  return { id, taskId: `task-${id}`, vaId: null, trackedUserId: worker.userId, trackedProfileId: worker.id, founderId: worker.founderId,
    cardId: `card-${id}`, cardName: `Card ${id}`, cardUrl: null, boardName: "Board", listName: "DOING",
    startTime: new Date("2026-09-30T23:00:00Z"), endTime: null, durationSeconds: null,
    durationMinutes: null, notes: null, source: "manus", category: "client_work",
    planDateKey: null, planBlockId: null, aptlssStepId: null, isVoided: false, voidedAt: null,
    voidReason: null, createdAt: new Date("2026-09-30T23:00:00Z"),
    updatedAt: new Date("2026-09-30T23:00:00Z"), ...overrides };
}

// Evaluate the emitted equality/null predicates against mutable rows. This
// makes stale-read tests depend on the real Drizzle update condition.
function matches(condition: SQL, row: Record<string, unknown>) {
  const query = new PgDialect().sqlToQuery(condition);
  let parameter = 0;
  const driverValue = (value: unknown) => value instanceof Date
    ? value.toISOString()
    : value;
  const predicates = [...query.sql.matchAll(/"time_entries"\."([^"]+)"(?: COLLATE "C")? (= \$[0-9]+(?:::text COLLATE "C")?|is null)/g)];
  if (!predicates.length) throw new Error(`Unexpected predicate: ${query.sql}`);
  const outcomes = predicates.map(([, key, operator]) => operator === "is null"
    ? row[key] === null
    : driverValue(row[key]) === driverValue(query.params[parameter++]));
  expect(parameter).toBe(query.params.length);
  return outcomes.every(Boolean);
}

function database(entries = [timer()]) {
  const state = { entries, conditions: [] as SQL[], afterRead: () => {}, beforeUpdate: () => {}, afterUpdate: () => {},
    founderRead: () => {}, afterNotificationInsert: () => {}, updateResult: null as unknown, snapshot: null as Record<string, unknown> | null,
    founders: [{ id: worker.founderId, openId: "synthetic-founder" }],
    preferences: [{ userId: worker.founderId, userOpenId: "synthetic-founder", inAppEnabled: 1, notificationMode: "priority_only", emailEnabled: 0 }],
    notifications: [] as Record<string, unknown>[],
    lockedTables: [] as unknown[],
  };
  const update = vi.fn(() => ({ set: (values: Record<string, unknown>) => ({ where: async (condition: SQL) => {
    state.conditions.push(condition);
    state.beforeUpdate();
    let affectedRows = 0;
    for (const entry of state.entries) {
      if (!matches(condition, entry)) continue;
      Object.assign(entry, values);
      affectedRows++;
    }
    state.afterUpdate();
    return state.updateResult ?? { rowCount: affectedRows };
  } }) }));
  const insert = vi.fn((table: unknown) => ({ values: (values: Record<string, unknown>) => {
    if (table === notificationHistory) return (async () => {
      await controls.notify(values);
      state.notifications.push(values);
      state.afterNotificationInsert();
    })();
    return { onConflictDoUpdate: async () => { state.snapshot = values; } };
  } }));
  const db = { update, insert, select: () => ({ from: (table: unknown) => ({ where: (condition: SQL) => {
    const rows = table === vaProfiles ? [worker]
      : table === timeEntries ? state.entries.filter(entry => matches(condition, entry)).map(entry => ({ ...entry }))
      : table === users ? state.founders.filter(row => row.id === new PgDialect().sqlToQuery(condition).params[0])
      : table === userNotificationPreferences ? state.preferences.filter(row => {
        const [id, openId] = new PgDialect().sqlToQuery(condition).params;
        return row.userId === id && row.userOpenId === openId;
      })
      : table === dailyComplianceSnapshots ? (state.snapshot ? [state.snapshot] : []) : [];
    if (table === timeEntries) state.afterRead();
    if (table === users) state.founderRead();
    const query = Object.assign(Promise.resolve(rows), { limit: () => query, for: () => { state.lockedTables.push(table); return query; } });
    return query;
  } }) }) };
  const transaction = vi.fn(async (work: (tx: typeof db) => Promise<unknown>) => {
    const previous = [...state.notifications];
    try { return await work(db); }
    catch (error) { state.notifications = previous; throw error; }
  });
  Object.assign(db, { transaction });
  controls.getDb.mockResolvedValue(db);
  return { state, db, update, insert, transaction };
}

function ownership() {
  const controller = new AbortController();
  const assertOwnership = vi.fn(async () => {
    if (controller.signal.aborted) throw new ScheduledJobLeaseLostError();
  });
  return { controller, assertOwnership, context: { signal: controller.signal, assertOwnership } };
}

async function scheduledWork(context: ScheduledJobContext) {
  let callback: ((context: ScheduledJobContext) => Promise<unknown>) | undefined;
  controls.run.mockImplementation(async (_input, work) => { callback = work; return { state: "skipped" }; });
  startManusScheduler();
  await vi.advanceTimersByTimeAsync(0);
  stopManusScheduler();
  expect(controls.run).toHaveBeenCalledWith({ jobKey: "auto-stop:41:2026-10-01" }, expect.any(Function));
  if (!callback) throw new Error("Scheduled callback was not registered");
  return callback(context);
}

describe("Manus automatic timer stop ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    controls.notify.mockResolvedValue(true);
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
  });
  afterEach(() => {
    expect(controls.ownerProvider).not.toHaveBeenCalled();
    stopManusScheduler();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, "false", "TRUE"])("still stops timers and reports counts when notifications are %j", async flag => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", flag);
    const { state, transaction } = database();
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(state.entries[0]).toMatchObject({ endTime: new Date(), durationSeconds: 3600 });
    expect(transaction).not.toHaveBeenCalled();
    expect(state.notifications).toEqual([]);
  });

  it("stores received in-app history for only the canonical founder, without email consent", async () => {
    const { state, db } = database();
    state.founders.push({ id: 88, openId: "other-founder" });
    state.preferences.push({ userId: 88, userOpenId: "other-founder", inAppEnabled: 1, notificationMode: "priority_only", emailEnabled: 1 });
    const lease = ownership();
    await expect(scheduledWork(lease.context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(state.notifications).toEqual([expect.objectContaining({
      userId: 9, userOpenId: "synthetic-founder", notificationType: "general", channel: "in_app",
      deliveryStatus: "sent", deliveredAt: new Date(),
    })]);
    expect(lease.assertOwnership).toHaveBeenCalledWith(db);
    expect(state.lockedTables).toContain(users);
    expect(state.lockedTables).toContain(userNotificationPreferences);
  });

  it.each(["missing founder", "missing preferences", "disabled mode", "disabled channel", "noncanonical channel", "wrong user id", "wrong open id"])(
    "suppresses %s without affecting completed timers", async scenario => {
      const { state } = database();
      if (scenario === "missing founder") state.founders = [];
      if (scenario === "missing preferences") state.preferences = [];
      if (scenario === "disabled mode") state.preferences[0].notificationMode = "disabled";
      if (scenario === "disabled channel") state.preferences[0].inAppEnabled = 0;
      if (scenario === "noncanonical channel") state.preferences[0].inAppEnabled = 2;
      if (scenario === "wrong user id") state.preferences[0].userId = 88;
      if (scenario === "wrong open id") state.preferences[0].userOpenId = "other-founder";
      await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 1 });
      expect(state.entries[0].endTime).not.toBeNull();
      expect(state.notifications).toEqual([]);
    },
  );

  it("keeps successful timer counts when notification persistence fails and logs no raw SQL error", async () => {
    const { state } = database();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    controls.notify.mockRejectedValue(new Error("PRIVATE SQL ERROR synthetic-secret"));
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(state.entries[0].endTime).not.toBeNull();
    expect(state.notifications).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-secret");
  });

  it("rolls back notification insertion when ownership is lost before transaction commit, retaining timer updates", async () => {
    const { state } = database();
    const lease = ownership();
    state.afterNotificationInsert = () => { lease.controller.abort(); };
    await expect(scheduledWork(lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.notifications).toEqual([]);
    expect(state.entries[0].endTime).not.toBeNull();
  });

  it("rechecks global notification policy inside the transaction", async () => {
    const { state } = database();
    state.founderRead = () => { vi.stubEnv("NOTIFICATIONS_ENABLED", "false"); };
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(state.notifications).toEqual([]);
  });

  it("stops only running, non-voided worker-account timers in this founder scope", async () => {
    const { state } = database([timer(), timer(2, { trackedUserId: worker.id }), timer(3, { founderId: 88 }),
      timer(4, { isVoided: true }), timer(5, { endTime: new Date("2026-09-30T23:30:00Z") })]);
    const lease = ownership();
    await expect(scheduledWork(lease.context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(state.entries[0]).toMatchObject({ endTime: new Date(), durationSeconds: 3600, durationMinutes: 60 });
    expect(state.entries.slice(1, 4).map(entry => entry.endTime)).toEqual([null, null, null]);
    expect(controls.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Auto-stopped 1 timer(s) for Synthetic worker" }));
    expect(lease.assertOwnership.mock.invocationCallOrder.at(-2)).toBeLessThan(controls.notify.mock.invocationCallOrder[0]);
    expect(lease.assertOwnership.mock.invocationCallOrder.at(-1)).toBeGreaterThan(controls.notify.mock.invocationCallOrder[0]);
  });

  it.each([
    ["manual stop", { endTime: new Date("2026-09-30T23:30:00Z"), durationSeconds: 1800, durationMinutes: 30 }],
    ["edited start", { startTime: new Date("2026-09-30T23:45:00Z") }],
    ["same-second notes edit", { notes: "Manual correction" }],
    ["same-second duration edit", { durationSeconds: 20, durationMinutes: 0 }],
    ["updated version", { updatedAt: new Date("2026-09-30T23:00:01Z") }],
    ["void", { isVoided: true }],
    ["worker reassignment", { vaId: 88 }],
    ["founder reassignment", { founderId: 88 }],
  ] as const)("preserves a concurrent %s and does not report it as auto-stopped", async (_label, edit) => {
    const { state } = database();
    state.beforeUpdate = () => { Object.assign(state.entries[0], edit); };
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 0 });
    expect(state.entries[0]).toMatchObject(edit);
    if (!("endTime" in edit)) expect(state.entries[0].endTime).toBeNull();
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("propagates lease loss during the timer read without writing or notifying", async () => {
    const { state, update } = database();
    const lease = ownership();
    state.afterRead = () => { lease.assertOwnership.mockRejectedValue(new ScheduledJobLeaseLostError()); };
    await expect(scheduledWork(lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(update).not.toHaveBeenCalled();
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("stops further mutations after lease loss between timers", async () => {
    const { state, update } = database([timer(), timer(2)]);
    const lease = ownership();
    state.afterUpdate = () => { lease.controller.abort(); };
    await expect(scheduledWork(lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(update).toHaveBeenCalledTimes(1);
    expect(state.entries[1].endTime).toBeNull();
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("rechecks the lease after founder lookup and suppresses in-app notification", async () => {
    const { state } = database();
    const lease = ownership();
    state.founderRead = () => { lease.assertOwnership.mockRejectedValue(new ScheduledJobLeaseLostError()); };
    await expect(scheduledWork(lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(state.entries[0].endTime).not.toBeNull();
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("fails closed for an aborted signal even when the ownership assertion resolves", async () => {
    const { update } = database();
    const lease = ownership();
    lease.controller.abort();
    lease.assertOwnership.mockResolvedValue(undefined);
    await expect(scheduledWork(lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(update).not.toHaveBeenCalled();
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("detects aborts during an otherwise successful ownership assertion", async () => {
    const { update } = database();
    const lease = ownership();
    lease.assertOwnership.mockImplementation(async () => { lease.controller.abort(); });
    await expect(scheduledWork(lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(update).not.toHaveBeenCalled();
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it.each(["reviewed", "Reviewed "])("compares string edits byte-for-byte, including %j", async notes => {
    const { state } = database([timer(1, { notes: "Reviewed" })]);
    state.beforeUpdate = () => { state.entries[0].notes = notes; };
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 0 });
    expect(state.entries[0].endTime).toBeNull();
    expect(new PgDialect().sqlToQuery(state.conditions[0]).sql)
      .toMatch(/"time_entries"\."notes" COLLATE "C" = \$\d+::text COLLATE "C"/);
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("counts and reports only the successful stop in a mixed stale/current batch", async () => {
    const { state } = database([timer(), timer(2)]);
    state.beforeUpdate = () => { state.entries[0].endTime = new Date("2026-09-30T23:30:00Z"); };
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(controls.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: "Auto-stopped 1 timer(s) for Synthetic worker",
      content: expect.stringContaining("- Card 2:"),
    }));
    expect(controls.notify.mock.calls[0][0].content).not.toContain("- Card 1:");
  });

  it("propagates a failed update without notifying", async () => {
    const { state } = database();
    const failure = new Error("Synthetic database write failure");
    state.beforeUpdate = () => { throw failure; };
    await expect(scheduledWork(ownership().context)).rejects.toBe(failure);
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("handles a bare update header and preserves the existing 12-hour cap", async () => {
    const { state } = database([timer(1, { startTime: new Date("2026-09-30T08:00:00Z") })]);
    state.updateResult = { rowCount: 1 };
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(state.entries[0].durationSeconds).toBe(12 * 3600);
    expect(controls.notify).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("(capped at 12h)") }));
  });

  it("does not count or notify updates whose affected-row outcome is unknown", async () => {
    const { state } = database();
    state.updateResult = [{}];
    await expect(scheduledWork(ownership().context)).rejects.toThrow("Automatic timer stop outcome could not be confirmed");
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it.each([new Date("2026-10-01T00:10:00Z"), new Date(NaN)])("does not create a negative or invalid timer duration", async startTime => {
    const { state, update } = database([timer(1, { startTime })]);
    await expect(scheduledWork(ownership().context)).resolves.toMatchObject({ recordsProcessed: 0 });
    expect(state.entries[0].endTime).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(controls.notify).not.toHaveBeenCalled();
  });

  it("checkpoints compliance ownership after collection, before the durable upsert", async () => {
    const { insert } = database([]);
    const lease = ownership();
    vi.stubEnv("TRELLO_API_KEY", "synthetic-key");
    vi.stubEnv("TRELLO_TOKEN", "synthetic-token");
    controls.cards.mockImplementation(async () => {
      lease.assertOwnership.mockRejectedValue(new ScheduledJobLeaseLostError());
      return [];
    });
    controls.comments.mockResolvedValue(new Set());
    controls.operator.mockResolvedValue({});
    controls.target.mockReturnValue(0);
    await expect(collectComplianceSnapshot(worker, "auto", lease.context)).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps manual compliance collection compatible without a lease context", async () => {
    const { insert } = database([]);
    vi.stubEnv("TRELLO_API_KEY", "synthetic-key");
    vi.stubEnv("TRELLO_TOKEN", "synthetic-token");
    controls.cards.mockResolvedValue([]);
    controls.comments.mockResolvedValue(new Set());
    controls.operator.mockResolvedValue({});
    controls.target.mockReturnValue(0);
    await expect(collectComplianceSnapshot(worker, "manual")).resolves.toMatchObject({ vaId: worker.userId, source: "manual" });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("allows an owned compliance upsert and checks immediately before it", async () => {
    const { insert } = database([]);
    const lease = ownership();
    vi.stubEnv("TRELLO_API_KEY", "synthetic-key");
    vi.stubEnv("TRELLO_TOKEN", "synthetic-token");
    controls.cards.mockResolvedValue([]);
    controls.comments.mockResolvedValue(new Set());
    controls.operator.mockResolvedValue({});
    controls.target.mockReturnValue(0);
    await expect(collectComplianceSnapshot(worker, "auto", lease.context)).resolves.toMatchObject({ vaId: worker.userId });
    expect(lease.assertOwnership).toHaveBeenCalledTimes(2);
    expect(lease.assertOwnership.mock.invocationCallOrder[1]).toBeLessThan(insert.mock.invocationCallOrder[0]);
  });
});
