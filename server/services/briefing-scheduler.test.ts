import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaProfiles, users, timeEntries, taskAssignments } from "../../drizzle/schema.postgres";
import { timerTestDatabase } from "../test/timerDatabase";
import { ScheduledJobLeaseLostError } from "../scheduledJobRuntime";

const controls = vi.hoisted(() => ({ getDb: vi.fn(), settings: vi.fn(), ownership: vi.fn(),
  run: vi.fn(), morning: vi.fn(), eod: vi.fn(), consent: vi.fn(), worker: vi.fn(), due: vi.fn(), contexts: [] as unknown[] }));
vi.mock("../db", () => ({ getDb: controls.getDb }));
vi.mock("../briefingSettings", () => ({ getBriefingSettings: controls.settings, shouldRunBriefingAt: controls.due }));
vi.mock("../scheduledJobRuntime", async importOriginal => {
  const actual = await importOriginal<typeof import("../scheduledJobRuntime")>();
  return { ScheduledJobLeaseLostError: actual.ScheduledJobLeaseLostError, runScheduledJob: controls.run };
});
vi.mock("./email", () => ({ sendMorningBriefing: controls.morning, sendEODReport: controls.eod }));
vi.mock("./recipientEmailConsent", () => ({ getConsentingRecipientEmail: controls.consent }));
vi.mock("../workerOperatorContext", () => ({ resolveWorkerOperatorContextById: controls.worker }));
import { processScheduledBriefings } from "./briefing-scheduler";

function assignmentFixture(assignments: Array<Record<string, unknown>>) {
  const store = timerTestDatabase(new Map<unknown, any[]>([
    [vaProfiles, [{ id: 1, userId: 2, founderId: 3, timezone: "UTC", status: "active", name: "Synthetic worker" }]],
    [users, [{ id: 3, role: "admin" }]], [taskAssignments, assignments], [timeEntries, []],
  ]));
  controls.getDb.mockResolvedValue(store.db);
  return store;
}
function scheduledAssignment(id: number, changes: Record<string, unknown> = {}) {
  return { id, taskId: `card:checklist:item-${id}`, founderId: 3, vaId: 1, status: "assigned",
    notes: `Title ${id}`, startTime: null, endTime: null, ...changes };
}

describe("scheduled briefing ownership at the email boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    controls.due.mockReturnValue(true);
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    controls.worker.mockResolvedValue({ userId: 2, profileId: 1, founderId: 3 });
    controls.settings.mockResolvedValue({ morningBriefingEnabled: true, eodReportEnabled: true });
    controls.ownership.mockResolvedValue(undefined);
    controls.consent.mockImplementation(async id => id === 2 ? "worker-preference@example.invalid" : "founder-preference@example.invalid");
    controls.morning.mockResolvedValue(true); controls.eod.mockResolvedValue(true);
    controls.contexts.length = 0;
    controls.run.mockImplementation(async (_input, work) => {
      const context = { signal: new AbortController().signal, assertOwnership: controls.ownership };
      controls.contexts.push(context);
      return work(context);
    });
    controls.getDb.mockResolvedValue({ select: () => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === vaProfiles ? [{ id: 1, userId: 2, founderId: 3, timezone: "UTC",
        status: "active", name: "Synthetic worker", email: "worker@example.invalid" }]
        : table === users ? [{ id: 3, email: "founder@example.invalid" }] : [];
      return Object.assign(Promise.resolve(rows), { limit: async () => rows });
    } }) }) });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("keeps both workers due when the first awaited delivery crosses the scheduled minute", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T08:00:50Z'));
    const actual = await vi.importActual<typeof import('../briefingSettings')>('../briefingSettings');
    controls.due.mockImplementation(actual.shouldRunBriefingAt);
    controls.settings.mockResolvedValue({ morningBriefingEnabled: true, morningBriefingTime: '08:00', eodReportEnabled: false, eodReportTime: '18:00' });
    const store = assignmentFixture([]);
    store.rows.get(vaProfiles)!.push({ id: 4, userId: 5, founderId: 3, timezone: 'UTC', status: 'active', name: 'Second worker' });
    controls.morning.mockImplementation(async () => {
      await Promise.resolve();
      vi.setSystemTime(new Date('2026-10-22T08:01:10Z'));
      return true;
    });
    await processScheduledBriefings();
    expect(controls.morning).toHaveBeenCalledTimes(2);
    expect(controls.run.mock.calls.map(call => call[0].jobKey)).toEqual(['briefing:2:2026-10-22', 'briefing:5:2026-10-22']);
    expect(controls.ownership).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['2026-10-22T07:59:59Z', '08:00', 0],
    ['2026-10-22T08:14:59Z', '08:00', 1],
    ['2026-10-22T08:15:00Z', '08:00', 0],
    ['2026-10-23T00:03:00Z', '23:55', 0],
  ] as const)('bounds same-day catch-up at %s for %s', async (now, time, calls) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
    const actual = await vi.importActual<typeof import('../briefingSettings')>('../briefingSettings');
    controls.due.mockImplementation(actual.shouldRunBriefingAt);
    controls.settings.mockResolvedValue({ morningBriefingEnabled: true, morningBriefingTime: time, eodReportEnabled: false, eodReportTime: '18:00' });
    assignmentFixture([]);
    await processScheduledBriefings();
    expect(controls.morning).toHaveBeenCalledTimes(calls);
    expect(controls.run).toHaveBeenCalledTimes(calls);
  });

  it.each([{ vaId: 9, status: "completed" }, { vaId: 1, status: "blocked" }])(
    "rejects full-key ambiguity before either provider or job: %j", async duplicate => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      assignmentFixture([scheduledAssignment(1), scheduledAssignment(2, { taskId: "card:checklist:item-1", ...duplicate })]);
      await processScheduledBriefings();
      expect(controls.run).not.toHaveBeenCalled();
      expect(controls.morning).not.toHaveBeenCalled(); expect(controls.eod).not.toHaveBeenCalled();
    });

  it("does not truncate canonical batches and keeps checklist items and founders independent", async () => {
    for (const sender of [controls.morning, controls.eod]) {
      sender.mockImplementation(async (_to, _data, _context, beforeDispatch) => beforeDispatch());
    }
    assignmentFixture([...Array.from({ length: 102 }, (_, i) => scheduledAssignment(i + 1,
      { status: i === 0 ? "completed" : i === 101 ? "blocked" : "assigned" })),
      scheduledAssignment(999, { founderId: 8, taskId: "card:checklist:item-1", notes: "Other founder" })]);
    await processScheduledBriefings();
    const morning = controls.morning.mock.calls[0][1];
    const eod = controls.eod.mock.calls[0][1];
    expect(morning.tasks).toHaveLength(102);
    expect(morning.tasks.map((task: any) => task.title)).toContain("Title 102");
    expect(morning.tasks.map((task: any) => task.title)).not.toContain("Other founder");
    expect(eod.completedTasks.map((task: any) => task.title)).toEqual(["Title 1"]);
    expect(eod.blockedTasks.map((task: any) => task.title)).toEqual(["Title 102"]);
    expect(eod.incompleteTasks).toHaveLength(100);
    expect(await controls.morning.mock.results[0].value).toBe(true);
    expect(await controls.eod.mock.results[0].value).toBe(true);
  });

  it("checks the final partial canonical batch again before dispatch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controls.settings.mockResolvedValue({ morningBriefingEnabled: true, eodReportEnabled: false });
    const store = assignmentFixture(Array.from({ length: 102 }, (_, i) => scheduledAssignment(i + 1)));
    controls.morning.mockImplementation(async (_to, _data, _context, beforeDispatch) => {
      store.rows.get(taskAssignments)!.push(scheduledAssignment(999, { taskId: "card:checklist:item-99", vaId: 9 }));
      return beforeDispatch();
    });
    await processScheduledBriefings();
    expect(await controls.morning.mock.results[0].value).toBe(false);
  });

  it.each(["morning", "eod"] as const)("blocks %s dispatch when a duplicate appears during provider readiness", async kind => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controls.settings.mockResolvedValue({ morningBriefingEnabled: kind === "morning", eodReportEnabled: kind === "eod" });
    const store = assignmentFixture([scheduledAssignment(1)]);
    const dispatch = vi.fn();
    (kind === "morning" ? controls.morning : controls.eod).mockImplementation(async (_to, _data, _context, beforeDispatch) => {
      await Promise.resolve();
      store.rows.get(taskAssignments)!.push(scheduledAssignment(2, { taskId: "card:checklist:item-1", vaId: 9, status: "completed" }));
      const allowed = await beforeDispatch();
      if (allowed) dispatch();
      return allowed;
    });
    await processScheduledBriefings();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["morning", "eod"] as const)("rechecks %s recipient consent and exact address after awaited provider readiness", async kind => {
    for (const change of ["revoked", "address", "offboarded", "reassigned", "identity missing", "unavailable", "global"] as const) {
      controls.settings.mockResolvedValue({ morningBriefingEnabled: kind === "morning", eodReportEnabled: kind === "eod" });
      controls.consent.mockImplementation(async id => id === 2 ? "worker-preference@example.invalid" : "founder-preference@example.invalid");
      controls.worker.mockResolvedValue({ userId: 2, profileId: 1, founderId: 3 });
      vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      const dispatch = vi.fn();
      const sender = kind === "morning" ? controls.morning : controls.eod;
      sender.mockClear().mockImplementation(async (_to, _data, _context, beforeDispatch) => {
        await ready;
        const allowed = await beforeDispatch();
        if (allowed) dispatch();
        return allowed;
      });
      const pending = processScheduledBriefings();
      await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
      if (change === "revoked" || change === "identity missing") controls.consent.mockResolvedValue(null);
      if (change === "address") controls.consent.mockResolvedValue("different@example.invalid");
      if (change === "offboarded") controls.worker.mockResolvedValue({ userId: 2, profileId: null, founderId: null });
      if (change === "reassigned") controls.worker.mockResolvedValue({ userId: 2, profileId: 1, founderId: 99 });
      if (change === "unavailable") controls.consent.mockRejectedValue(new Error("Synthetic read unavailable"));
      if (change === "global") vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
      release();
      await pending;
      expect(dispatch, change).not.toHaveBeenCalled();
      expect(typeof sender.mock.calls[0][3]).toBe("function");
    }
  });

  it.each(["morning", "eod"] as const)("allows unchanged %s consent through the final guard", async kind => {
    controls.settings.mockResolvedValue({ morningBriefingEnabled: kind === "morning", eodReportEnabled: kind === "eod" });
    const dispatch = vi.fn();
    (kind === "morning" ? controls.morning : controls.eod).mockImplementation(async (_to, _data, _context, beforeDispatch) => {
      await Promise.resolve();
      if (!await beforeDispatch()) return false;
      dispatch(); return true;
    });
    await processScheduledBriefings();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(controls.worker).toHaveBeenCalledWith(2);
  });
  it.each([2, 3])("honors recipient %s opt-out independently", async userId => {
    controls.consent.mockImplementation(async id => id === userId ? null : "consenting@example.invalid");
    await processScheduledBriefings();
    expect(controls.morning).toHaveBeenCalledTimes(userId === 2 ? 0 : 1);
    expect(controls.eod).toHaveBeenCalledTimes(userId === 3 ? 0 : 1);
  });
  it("does not create jobs when neither recipient has persisted consent", async () => {
    controls.consent.mockResolvedValue(null);
    await processScheduledBriefings();
    expect(controls.run).not.toHaveBeenCalled();
    expect(controls.morning).not.toHaveBeenCalled();
    expect(controls.eod).not.toHaveBeenCalled();
  });
  it.each([2, 3])("rechecks recipient %s consent at delivery", async userId => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reads = new Map<number, number>();
    controls.consent.mockImplementation(async id => {
      const count = (reads.get(id) ?? 0) + 1;
      reads.set(id, count);
      return id === userId && count > 1 ? null : "consenting@example.invalid";
    });
    await processScheduledBriefings();
    expect(userId === 2 ? controls.morning : controls.eod).not.toHaveBeenCalled();
  });
  it("checks ownership immediately before each provider call", async () => {
    await processScheduledBriefings();
    expect(controls.morning).toHaveBeenCalledTimes(1); expect(controls.eod).toHaveBeenCalledTimes(1);
    expect(controls.ownership).toHaveBeenCalledTimes(2);
    expect(controls.ownership.mock.invocationCallOrder[0]).toBeLessThan(controls.morning.mock.invocationCallOrder[0]);
    expect(controls.ownership.mock.invocationCallOrder[1]).toBeLessThan(controls.eod.mock.invocationCallOrder[0]);
    expect(controls.morning.mock.calls[0][2]).toBe(controls.contexts[0]);
    expect(controls.eod.mock.calls[0][2]).toBe(controls.contexts[1]);
    expect(controls.morning.mock.calls[0][0]).toBe("worker-preference@example.invalid");
    expect(controls.eod.mock.calls[0][0]).toBe("founder-preference@example.invalid");
    expect(controls.consent).toHaveBeenCalledWith(2, "daily_digest");
    expect(controls.consent).toHaveBeenCalledWith(3, "daily_digest");
  });
  it("does not send a morning email after ownership loss", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controls.ownership.mockRejectedValue(new Error("Synthetic lease loss"));
    await processScheduledBriefings();
    expect(controls.morning).not.toHaveBeenCalled(); expect(controls.eod).not.toHaveBeenCalled();
  });
  it.each(["morning", "eod"])("propagates a %s email lease error instead of swallowing it", async kind => {
    const error = new ScheduledJobLeaseLostError();
    (kind === "morning" ? controls.morning : controls.eod).mockRejectedValue(error);
    await expect(processScheduledBriefings()).rejects.toBe(error);
    if (kind === "morning") expect(controls.eod).not.toHaveBeenCalled();
  });
  it("rechecks ownership after collecting end-of-day records", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    controls.settings.mockResolvedValue({ morningBriefingEnabled: false, eodReportEnabled: true });
    const database = await controls.getDb();
    const from = database.select().from;
    database.select = () => ({ from: (table: unknown) => {
      if (table === timeEntries) controls.ownership.mockRejectedValue(new Error("Synthetic lease lost during report read"));
      return from(table);
    } });
    await processScheduledBriefings();
    expect(controls.ownership).toHaveBeenCalledTimes(1);
    expect(controls.eod).not.toHaveBeenCalled();
  });
});
