import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceJobSettings, vaProfiles } from "../drizzle/schema";
import type { ScheduledJobContext } from "./scheduledJobRuntime";

const controls = vi.hoisted(() => ({ getDb: vi.fn(), run: vi.fn(), ownership: vi.fn(), google: vi.fn(),
  commitments: vi.fn(), replies: vi.fn(), compliance: vi.fn(), queue: vi.fn(), webhooks: vi.fn(),
  states: vi.fn(), plans: vi.fn(), weekly: vi.fn(), warm: vi.fn() }));
vi.mock("./db", () => ({ getDb: controls.getDb }));
vi.mock("./scheduledJobRuntime", () => ({ runScheduledJob: controls.run }));
vi.mock("./googleEvidence", () => ({ syncWorkerGoogleEvidence: controls.google }));
vi.mock("./sourceCommitments", () => ({ syncWorkerTrelloCommitments: controls.commitments }));
vi.mock("./services/trello-reply-evidence", () => ({ syncWorkerTrelloReplyEvidence: controls.replies }));
vi.mock("./services/manus-scheduler", () => ({ collectComplianceSnapshot: controls.compliance }));
vi.mock("./services/aptlss-scheduled-generation", () => ({ processDueAptlssGenerationJobs: controls.queue }));
vi.mock("./services/webhook-auto-register", () => ({ getWebhookCallbackUrl: () => "https://example.invalid/callback", syncWebhooks: controls.webhooks }));
vi.mock("./services/cache-warming", () => ({ warmUpCache: controls.warm }));
vi.mock("./aptlssStepsDb", () => ({ getAllCardStates: controls.states }));
vi.mock("./aptlssDb", () => ({ getAllAptlssPlans: controls.plans }));
vi.mock("./aptlssPoliciesDb", () => ({ upsertWeeklyAnalysis: controls.weekly }));
import { runMaintenanceJob, startMaintenanceCenter, stopMaintenanceCenter } from "./maintenanceCenter";

const workers = [{ userId: 1, founderId: 10, trelloMemberId: "one", name: "One" },
  { userId: 2, founderId: 10, trelloMemberId: "two", name: "Two" }];
let context: ScheduledJobContext;
let setting: { enabled: boolean; intervalMinutes: number; lastScheduledAt: Date | null } | undefined;
let writes: number;
let scheduleUpdates: number;

function database() {
  const db: any = {
    select: (projection?: unknown) => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === vaProfiles ? workers : table === maintenanceJobSettings && setting
        ? !projection || (setting.enabled && (!setting.lastScheduledAt
          || setting.lastScheduledAt.getTime() + setting.intervalMinutes * 60_000 <= Date.now())) ? [setting] : [] : [];
      const query: any = Object.assign(Promise.resolve(rows), {
        limit: () => Object.assign(Promise.resolve(rows), { for: async () => rows }),
        orderBy: () => query,
      });
      return query;
    } }) }),
    insert: () => ({ values: (values: any) => ({ onDuplicateKeyUpdate: async () => {
      writes++;
      setting ??= { ...values, lastScheduledAt: null };
    } }) }),
    update: () => ({ set: () => ({ where: async () => { writes++; scheduleUpdates++; setting!.lastScheduledAt = new Date(); } }) }),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  return db;
}

describe("maintenance ownership and schedule boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setting = undefined; writes = 0; scheduleUpdates = 0;
    context = { signal: new AbortController().signal, assertOwnership: controls.ownership };
    controls.ownership.mockResolvedValue(undefined);
    controls.getDb.mockResolvedValue(database());
    controls.run.mockImplementation(async (input, work) => {
      if (input.shouldRun && !await input.shouldRun(context, database())) return { state: "skipped", reason: "not_due" };
      const result = await work(context);
      return { state: "success", runId: 1, recordsProcessed: result.recordsProcessed };
    });
    controls.google.mockResolvedValue({ gmail: { imported: 1, state: "ready" }, drive: { imported: 0, state: "ready" } });
    controls.commitments.mockResolvedValue({ scanned: 1 });
    controls.replies.mockResolvedValue({ threads: 1 });
    controls.compliance.mockResolvedValue({});
    controls.queue.mockResolvedValue({ processed: 1 });
    controls.webhooks.mockResolvedValue({ registered: 1, removed: 0, errors: 0 });
    controls.warm.mockResolvedValue({ totalCards: 1, totalBoards: 1 });
    controls.states.mockResolvedValue([]); controls.plans.mockResolvedValue([]);
  });
  afterEach(() => { stopMaintenanceCenter(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("does not advance a schedule when a remote owner holds the lease", async () => {
    controls.run.mockResolvedValue({ state: "skipped", reason: "lease_held" });
    expect(await runMaintenanceJob("google_evidence", "cron")).toMatchObject({ state: "skipped" });
    expect(writes).toBe(0); expect(scheduleUpdates).toBe(0); expect(controls.google).not.toHaveBeenCalled();
  });

  it("rechecks a changed schedule under the shared lease", async () => {
    setting = { enabled: true, intervalMinutes: 5, lastScheduledAt: new Date() };
    expect(await runMaintenanceJob("google_evidence", "cron")).toMatchObject({ reason: "not_due" });
    expect(writes).toBe(1); expect(scheduleUpdates).toBe(0); expect(controls.google).not.toHaveBeenCalled();
  });

  it("respects an administrator disabling an already discovered cron job", async () => {
    setting = { enabled: false, intervalMinutes: 5, lastScheduledAt: null };
    expect(await runMaintenanceJob("google_evidence", "cron")).toMatchObject({ reason: "not_due" });
    expect(writes).toBe(1); expect(scheduleUpdates).toBe(0); expect(controls.google).not.toHaveBeenCalled();
  });

  it("keeps explicit manual runs available without enabling periodic execution", async () => {
    setting = { enabled: false, intervalMinutes: 5, lastScheduledAt: null };
    expect(await runMaintenanceJob("google_evidence")).toMatchObject({ state: "success", recordsProcessed: 2 });
    expect(writes).toBe(0); expect(setting.enabled).toBe(false);
  });

  it("records only the owner's started cron schedule and skips a subsequent stale contender", async () => {
    expect(await runMaintenanceJob("google_evidence", "cron")).toMatchObject({ state: "success" });
    expect(setting?.lastScheduledAt).toBeInstanceOf(Date);
    const before = writes;
    const lastScheduledAt = setting?.lastScheduledAt;
    expect(await runMaintenanceJob("google_evidence", "cron")).toMatchObject({ reason: "not_due" });
    expect(writes).toBe(before + 1); expect(scheduleUpdates).toBe(1);
    expect(setting?.lastScheduledAt).toBe(lastScheduledAt); expect(controls.google).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["google_evidence", controls.google], ["trello_commitments", controls.commitments],
    ["communication_evidence", controls.replies], ["eod_compliance", controls.compliance],
  ] as const)("passes ownership through %s and stops before the next worker", async (key, service) => {
    service.mockImplementationOnce(async () => {
      controls.ownership.mockRejectedValue(new Error("Synthetic ownership lost"));
      return key === "google_evidence" ? { gmail: { imported: 1 }, drive: { imported: 0 } }
        : key === "trello_commitments" ? { scanned: 1 } : key === "communication_evidence" ? { threads: 1 } : {};
    });
    await expect(runMaintenanceJob(key)).rejects.toThrow("Synthetic ownership lost");
    expect(service).toHaveBeenCalledTimes(1);
    if (key === "google_evidence") expect(service.mock.calls[0][1].context).toBe(context);
    else if (key === "eod_compliance") expect(service.mock.calls[0][2]).toBe(context);
    else expect(service.mock.calls[0][0].context).toBe(context);
  });

  it("does not save a weekly analysis after ownership disappears during reads", async () => {
    controls.states.mockImplementation(async () => {
      controls.ownership.mockRejectedValue(new Error("Synthetic ownership lost")); return [];
    });
    await expect(runMaintenanceJob("weekly_analysis")).rejects.toThrow("Synthetic ownership lost");
    expect(controls.weekly).not.toHaveBeenCalled();
  });

  it("passes parent ownership to the queue and webhook mutations", async () => {
    await runMaintenanceJob("aptlss_queue"); await runMaintenanceJob("webhook_sync");
    expect(controls.queue).toHaveBeenCalledWith(expect.any(Date), context);
    expect(controls.webhooks).toHaveBeenCalledWith(context);
  });

  it("cancels the initial scan as well as the interval on stop", async () => {
    vi.useFakeTimers();
    startMaintenanceCenter(); stopMaintenanceCenter();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(controls.getDb).not.toHaveBeenCalled();
    expect(controls.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears local progress when ownership fails, allowing a later explicit retry", async () => {
    controls.ownership.mockRejectedValueOnce(new Error("Synthetic ownership lost"));
    await expect(runMaintenanceJob("google_evidence")).rejects.toThrow("Synthetic ownership lost");
    expect(await runMaintenanceJob("google_evidence")).toMatchObject({ state: "success" });
  });
});
