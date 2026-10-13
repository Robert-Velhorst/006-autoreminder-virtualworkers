import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { appSettings, aptlssManagerRuns, aptlssManagerState, aptlssManagerTrialEvents, aptlssPlans, aptlssSteps, dailyPlans, taskAssignments, vaProfiles } from "../drizzle/schema";
import type { WorkerOperatorContext } from "./workerOperatorContext";

const dependencies = vi.hoisted(() => ({ getDb: vi.fn(), model: vi.fn(), worker: vi.fn(), emit: vi.fn() }));
vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./aptlssManagerModel", async original => ({
  ...(await original<typeof import("./aptlssManagerModel")>()), enrichManagerResult: dependencies.model,
}));
vi.mock("./workerOperatorContext", () => ({ resolveWorkerOperatorContextById: dependencies.worker }));
vi.mock("./aptlssManagerSafety", () => ({ managerSafetyDigest: () => "shadow-test", managerSafetyVerified: () => true }));
vi.mock("./services/websocket", () => ({ websocketService: { emitToUser: dependencies.emit } }));
import { runManager, updateManagerPolicy, tickManagerScheduler, startManagerScheduler, stopManagerScheduler } from "./aptlssManagerService";
import { claimManagerTask, enqueueManagerFallback } from "./aptlssManagerQueue";
import { managerSemanticBackoff } from "./aptlssManagerSemanticRuntime";

const now = new Date("2026-09-04T08:00:00Z");
const worker: WorkerOperatorContext = {
  userId: 2, profileId: 23, founderId: 1, trelloMemberId: null,
  displayName: "Joyce", founderName: "Robert", timezone: "Europe/Amsterdam",
  workStartTime: "09:00", workEndTime: "18:00", workingDays: [1, 2, 3, 4, 5], breaks: [],
};

// Exercise real collection and reconciliation with scripted storage, never a MySQL connection.
function storage() {
  const control = { enabled: true, closed: false };
  const state: any = { vaId: 2, enabled: true, mode: "active", intervalMinutes: 5, policyRevision: 0 };
  const retainedRuns: any[] = [];
  let runtime: any;
  const reads: Array<{ table: string; condition?: SQL; lock?: string }> = [];
  const writes: Array<{ table: string; values: any }> = [];
  const canonicalPlan = { dateKey: "2026-09-04", scheduleJson: JSON.stringify({ version: 2,
    dateKey: "2026-09-04", generatedAt: now.toISOString(), blocks: [], robertItems: [], unscheduledCards: [],
    planHealth: { confidence: 1, scheduledMinutes: 0, availableMinutes: 540, overlaps: 0, gaps: 0 },
    constraints: { startTime: "09:00", endTime: "18:00", breaks: [] }, auditTrail: [],
  }) };
  const db = {
    transaction: vi.fn(async (fn: (tx: any) => unknown) => fn(db)),
    select: () => {
      let table: any, condition: SQL | undefined, lock: string | undefined;
      const query: any = {
        from: (value: any) => { table = value; return query; },
        where: (value: SQL) => { condition = value; return query; },
        orderBy: () => query, limit: () => query, for: (value: string) => { lock = value; return query; }, innerJoin: () => query,
        then: (resolve: any, reject: any) => {
          reads.push({ table: getTableName(table), condition, lock });
          const rows = table === aptlssManagerTrialEvents ? (control.closed ? [{ event: "closed" }] : [])
            : table === aptlssManagerState ? [{ ...state, enabled: control.enabled }]
            : table === aptlssManagerRuns ? [...retainedRuns].reverse()
            : table === appSettings ? (runtime ? [runtime] : [])
            : table === dailyPlans ? [canonicalPlan]
            : table === aptlssPlans ? [{ vaId: 2, cardId: "owned-card", cardName: "Owned work", updatedAt: now, generatedAt: now }]
            : table === vaProfiles ? [{ id: 23, founderId: 1, status: "active" }]
            : table === taskAssignments || table === aptlssSteps ? []
            : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
    insert: (table: any) => ({ values: (values: any) => {
      writes.push({ table: getTableName(table), values });
      return { $returningId: async () => {
        const id = 42 + retainedRuns.length;
        if (table === aptlssManagerRuns) retainedRuns.push({ ...values, id });
        return [{ id }];
      }, onDuplicateKeyUpdate: async () => {
        if (table === appSettings) runtime = values;
        if (table === aptlssManagerState) Object.assign(state, values);
      } };
    } }),
    update: (table: any) => ({ set: (values: any) => ({ where: async () => {
      if (table === aptlssManagerState) Object.assign(state, values);
    } }) }),
  };
  return { db, reads, writes, canonicalPlan, control, state };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "2");
  vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
  vi.stubEnv("OPENAI_API_KEY", "configured-but-must-not-be-used");
  vi.stubEnv("APTLSS_MANAGER_MODEL", "configured-but-must-not-be-used");
  vi.clearAllMocks();
  dependencies.worker.mockResolvedValue(worker);
  dependencies.model.mockImplementation(async (_input, base, outcome) => { outcome(true); return base; });
});
afterEach(async () => { await stopManagerScheduler(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("manager shadow execution", () => {
  it("caps exponential semantic retry backoff at fifteen minutes", () => {
    expect([1, 2, 3, 4, 5, 10].map(managerSemanticBackoff)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
  it("retries failed unchanged sources after backoff, never via a rapid manual refresh", async () => {
    vi.setSystemTime(new Date(now.getTime() + 15_000));
    const { db } = storage();
    dependencies.getDb.mockResolvedValue(db);
    dependencies.model.mockImplementationOnce(async (_input, base, outcome) => {
      outcome(false);
      return { ...base, sourceGaps: [...base.sourceGaps, "Semantic review unavailable"] };
    }).mockImplementation(async (_input, base, outcome) => { outcome(true); return base; });
    const failed = await runManager(2);
    expect(failed.semanticReview?.success).toBe(false);
    // Refresh the deterministic cache in the retry minute, while the cooldown is still active.
    vi.setSystemTime(new Date(Date.parse(failed.semanticReview!.retryAfter) - 5_000));
    const cached = await runManager(2, "manual");
    expect(cached.semanticReview?.success).toBe(false);
    expect(dependencies.model).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.parse(failed.semanticReview!.retryAfter) + 1));
    const recovered = await runManager(2, "manual");
    expect(dependencies.model).toHaveBeenCalledTimes(2);
    expect(recovered.semanticReview?.success).toBe(true);
    expect(recovered.runId).not.toBe(cached.runId);
    expect((await runManager(2)).runId).toBe(recovered.runId);
    expect(dependencies.model).toHaveBeenCalledTimes(2);
    expect(recovered.sourceGaps).not.toContain("Semantic review unavailable");
    expect(recovered.applied).toBe(false);
  });
  it("does not let a late failure overwrite a newer successful assessment status", async () => {
    const { db, state, reads, writes } = storage();
    dependencies.getDb.mockResolvedValue(db);
    let signalModelStarted!: () => void;
    let rejectModel!: (error: Error) => void;
    const modelStarted = new Promise<void>(resolve => { signalModelStarted = resolve; });
    const pendingModel = new Promise<never>((_resolve, reject) => { rejectModel = reject; });
    dependencies.model.mockImplementationOnce(async () => {
      signalModelStarted();
      return pendingModel;
    });

    const olderAssessment = runManager(2);
    await modelStarted;
    const newerSuccessAt = new Date(now.getTime() + 60_000);
    Object.assign(state, {
      checkedAt: newerSuccessAt,
      lastSuccessfulAt: newerSuccessAt,
      lastError: null,
      inputHash: "newer-success-input",
      sourceHash: "newer-success-source",
      updatedAt: newerSuccessAt,
    });
    rejectModel(new Error("provider failed after the newer assessment completed"));

    await expect(olderAssessment).rejects.toThrow(/assessment failed/i);
    expect(reads.some(read => read.table === "aptlss_manager_state" && read.lock === "update")).toBe(true);
    expect(writes.filter(write => write.table === "aptlss_manager_state")).toEqual([]);
    expect(state).toMatchObject({
      checkedAt: newerSuccessAt,
      lastSuccessfulAt: newerSuccessAt,
      lastError: null,
      inputHash: "newer-success-input",
      sourceHash: "newer-success-source",
    });
  });
  it("requires founder restart after closure, even if stored enabled is true", async () => {
    const { db, control, writes } = storage();
    dependencies.getDb.mockResolvedValue(db);
    control.closed = true;
    await expect(runManager(2)).rejects.toThrow(/closed.*restart/i);
    await expect(updateManagerPolicy(2, { enabled: true, intervalMinutes: 5 })).rejects.toThrow(/closed.*restart/i);
    expect(dependencies.model).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it("rejects manual execution while disabled, without preventing ordinary re-enablement", async () => {
    const { db, control, writes } = storage();
    dependencies.getDb.mockResolvedValue(db);
    control.enabled = false;
    await expect(runManager(2)).rejects.toThrow(/disabled/i);
    expect(writes).toEqual([]);
    await expect(updateManagerPolicy(2, { enabled: true, intervalMinutes: 5 })).resolves.toBeDefined();
    expect(dependencies.model).not.toHaveBeenCalled();
  });
  it("discards an assessment when the founder closes the trial during provider work", async () => {
    const { db, control, writes } = storage();
    dependencies.getDb.mockResolvedValue(db);
    dependencies.model.mockImplementationOnce(async (_input, base) => { control.closed = true; return base; });
    await expect(runManager(2)).rejects.toThrow(/closed.*restart/i);
    expect(writes.every(w => w.table === "app_settings")).toBe(true);
    expect(dependencies.emit).not.toHaveBeenCalled();
  });
  it("rechecks closure under the lock even when returning an unchanged cached assessment", async () => {
    const { db, control, writes } = storage();
    dependencies.getDb.mockResolvedValue(db);
    await runManager(2);
    const written = writes.length;
    dependencies.emit.mockClear();
    db.transaction.mockImplementationOnce(async fn => { control.closed = true; return fn(db); });
    await expect(runManager(2)).rejects.toThrow(/closed.*restart/i);
    expect(writes).toHaveLength(written);
    expect(dependencies.model).toHaveBeenCalledTimes(1);
    expect(dependencies.emit).not.toHaveBeenCalled();
  });
  it("retains semantic assessment without plan writes despite stored active mode", async () => {
    const { db, writes, reads, canonicalPlan } = storage();
    const before = structuredClone(canonicalPlan);
    dependencies.getDb.mockResolvedValue(db);
    const result = await runManager(2);
    expect(result).toMatchObject({ applied: false, policy: { mode: "shadow" }, runId: 42 });
    expect(result.proposal?.version).toBe(2);
    expect(writes.filter(w => w.table !== "app_settings").map(w => w.table).sort()).toEqual(["aptlss_manager_runs", "aptlss_manager_state"]);
    expect(writes.find(w => w.table === "aptlss_manager_runs")!.values).toMatchObject({ mode: "shadow", previousPlanJson: null, appliedPlanHash: null });
    expect(canonicalPlan).toEqual(before);
    expect(dependencies.model).toHaveBeenCalledTimes(1);
    const dialect = new MySqlDialect();
    for (const table of ["workspace_evidence_links", "aptlss_evidence_subject_links", "communication_evidence"]) {
      const scoped = reads.filter(r => r.table === table);
      expect(scoped.length).toBeGreaterThan(0);
      for (const read of scoped) {
        const query = dialect.sqlToQuery(read.condition!);
        expect(query.sql).toContain("`vaId` = ?");
        expect(query.params).toContain(2);
      }
    }
  });
  it("does not initialize storage or a scheduler without the explicit pilot policy", async () => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
    startManagerScheduler();
    await tickManagerScheduler();
    expect(await claimManagerTask({} as never)).toBeNull();
    expect(await enqueueManagerFallback({} as never)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(dependencies.getDb).not.toHaveBeenCalled();
  });
});
