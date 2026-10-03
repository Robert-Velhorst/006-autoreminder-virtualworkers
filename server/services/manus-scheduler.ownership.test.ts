import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { dailyComplianceSnapshots, timeEntries, users, vaProfiles } from "../../drizzle/schema";
import type { ScheduledJobContext } from "../scheduledJobRuntime";

const controls = vi.hoisted(() => ({
  getDb: vi.fn(), run: vi.fn(), notify: vi.fn(), cards: vi.fn(), comments: vi.fn(),
  operator: vi.fn(), target: vi.fn(),
}));
vi.mock("../db", () => ({ getDb: controls.getDb }));
vi.mock("../scheduledJobRuntime", async importOriginal => ({
  ...await importOriginal<typeof import("../scheduledJobRuntime")>(),
  runScheduledJob: controls.run,
}));
vi.mock("../_core/notification", () => ({ notifyOwner: controls.notify }));
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
  return { id, taskId: `task-${id}`, vaId: worker.userId, founderId: worker.founderId,
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
  const query = new MySqlDialect().sqlToQuery(condition);
  let parameter = 0;
  const driverValue = (value: unknown) => value instanceof Date
    ? value.toISOString().slice(0, 23).replace("T", " ")
    : typeof value === "boolean" ? Number(value) : value;
  const predicates = [...query.sql.matchAll(/`time_entries`\.`([^`]+)` (= (?:BINARY )?\?|is null)/g)];
  if (!predicates.length) throw new Error(`Unexpected predicate: ${query.sql}`);
  const outcomes = predicates.map(([, key, operator]) => operator === "is null"
    ? row[key] === null
    : driverValue(row[key]) === driverValue(query.params[parameter++]));
  expect(parameter).toBe(query.params.length);
  return outcomes.every(Boolean);
}

function database(entries = [timer()]) {
  const state = { entries, conditions: [] as SQL[], afterRead: () => {}, beforeUpdate: () => {}, afterUpdate: () => {},
    founderRead: () => {}, updateResult: null as unknown, snapshot: null as Record<string, unknown> | null };
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
    return state.updateResult ?? [{ affectedRows }];
  } }) }));
  const insert = vi.fn(() => ({ values: (values: Record<string, unknown>) => ({
    onDuplicateKeyUpdate: async () => { state.snapshot = values; },
  }) }));
  const db = { update, insert, select: () => ({ from: (table: unknown) => ({ where: (condition: SQL) => {
    const rows = table === vaProfiles ? [worker]
      : table === timeEntries ? state.entries.filter(entry => matches(condition, entry)).map(entry => ({ ...entry }))
      : table === users ? [{ id: worker.founderId }]
      : table === dailyComplianceSnapshots ? (state.snapshot ? [state.snapshot] : []) : [];
    if (table === timeEntries) state.afterRead();
    if (table === users) state.founderRead();
    return Object.assign(Promise.resolve(rows), { limit: async () => rows });
  } }) }) };
  controls.getDb.mockResolvedValue(db);
  return { state, db, update, insert };
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
  });
  afterEach(() => {
    stopManusScheduler();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stops only running, non-voided worker-account timers in this founder scope", async () => {
    const { state } = database([timer(), timer(2, { vaId: worker.id }), timer(3, { founderId: 88 }),
      timer(4, { isVoided: true }), timer(5, { endTime: new Date("2026-09-30T23:30:00Z") })]);
    const lease = ownership();
    await expect(scheduledWork(lease.context)).resolves.toMatchObject({ recordsProcessed: 1 });
    expect(state.entries[0]).toMatchObject({ endTime: new Date(), durationSeconds: 3600, durationMinutes: 60 });
    expect(state.entries.slice(1, 4).map(entry => entry.endTime)).toEqual([null, null, null]);
    expect(controls.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Auto-stopped 1 timer(s) for Synthetic worker" }));
    expect(lease.assertOwnership.mock.invocationCallOrder.at(-1)).toBeLessThan(controls.notify.mock.invocationCallOrder[0]);
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

  it("rechecks the lease after founder lookup and suppresses external notification", async () => {
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
    expect(new MySqlDialect().sqlToQuery(state.conditions[0]).sql)
      .toContain("BINARY `time_entries`.`notes` = BINARY ?");
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
    state.updateResult = { affectedRows: 1 };
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
