import { randomUUID, createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import * as schema from "../drizzle/schema";
import type { ManagerInput, ManagerResult, ManagerSnapshot } from "../shared/aptlssManager";
import type { CodexManagerAttempt } from "./aptlssManagerCodex";
import type { OperatorDailyPlanPayload } from "./operatorDailyPlan";
import type { TrpcContext } from "./_core/context";
import { aptlssManagerQueue as queueJobs, aptlssManagerQueueEvents as queueEvents, aptlssManagerQueueSlots as queueSlots } from "../drizzle/aptlssManagerQueueSchema";
import { claimManagerTask, enqueueManagerTask, type ManagerQueueLease } from "./aptlssManagerQueue";
import { assessManagerContext } from "./aptlssManagerEngine";

// Opt-in only. Never import db.ts (it may read .env) or fall back to DATABASE_URL.
const controls = vi.hoisted(() => ({
  url: process.env.APTLSS_TEST_DATABASE_URL,
  db: undefined as MySql2Database<typeof schema> | undefined,
  safety: true,
  digest: "aptlss-mysql-integration-controlled-digest",
  model: vi.fn<(input: ManagerInput, base: ManagerResult, outcome?: (success: boolean, failureKind?: "quota", attempts?: CodexManagerAttempt[]) => void) => Promise<ManagerResult>>(),
  emit: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: async () => controls.db }));
vi.mock("./aptlssManagerModel", () => ({
  enrichManagerResult: controls.model,
  reuseManagerSemanticReview: (_input: ManagerInput, base: ManagerResult) => base,
}));
vi.mock("./aptlssManagerSafety", () => ({
  managerSafetyVerified: () => controls.safety,
  managerSafetyDigest: () => controls.digest,
}));
vi.mock("./services/websocket", () => ({ websocketService: { emitToUser: controls.emit } }));

const NOW = new Date("2026-09-04T10:00:15.000Z");
const DATE_KEY = "2026-09-04";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Worker = { id: number; openId: string; cardId: string; stepId: number };
type Service = typeof import("./aptlssManagerService");
type Reviews = typeof import("./aptlssManagerReviewService");

describe.skipIf(!controls.url)("APTLSS manager real MySQL reliability", { timeout: 30_000, hookTimeout: 30_000 }, () => {
  let pool: Pool;
  let lockConnection: PoolConnection | undefined;
  let db: MySql2Database<typeof schema>;
  let service: Service;
  let reviews: Reviews;
  let adminId: number;
  let worker: Worker;
  let ownedUsers: number[] = [];
  let pilotWorkers: number[] = [];
  let ownedEvidenceIds: number[] = [];
  let createdControl = false;

  beforeAll(async () => {
    const url = new URL(controls.url!);
    if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !["/aptlss_test", "/recovery_test"].includes(url.pathname) || url.search || url.hash) {
      throw new Error("Integration tests require an explicit loopback MySQL URL naming aptlss_test or recovery_test.");
    }
    vi.stubEnv("DATABASE_URL", controls.url!);
    vi.stubEnv("APTLSS_MANAGER_SCHEDULER", "false");
    pool = createPool({ uri: controls.url!, connectionLimit: 8, connectTimeout: 10_000, timezone: "Z" });
    db = drizzle(pool, { schema, mode: "default" });
    controls.db = db;
    let identity: RowDataPacket[] = [];
    // Docker Desktop can transiently accept TCP without completing a MySQL handshake.
    // Retry readiness only; never retry a test, transaction or assertion.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        [identity] = await pool.query<RowDataPacket[]>("SELECT DATABASE() AS name, VERSION() AS version");
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt === 3 || !["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "PROTOCOL_CONNECTION_LOST"].includes(code ?? "")) throw error;
        console.warn(`[APTLSS integration] MySQL readiness attempt ${attempt}/3 failed (${code}); retrying connection only.`);
      }
    }
    expect(identity[0].name).toBe(url.pathname.slice(1));
    expect(identity[0].version).toMatch(/^8\./);
    lockConnection = await pool.getConnection();
    const [lock] = await lockConnection.query<RowDataPacket[]>("SELECT GET_LOCK('aptlss-manager-integration-fixtures', 30) AS acquired");
    expect(lock[0].acquired).toBe(1);
    if ((await db.select().from(queueJobs).where(inArray(queueJobs.state,["pending","leased"])).limit(1)).length
      || (await db.select().from(queueSlots).where(sql`${queueSlots.vaId} IS NOT NULL`).limit(1)).length) {
      throw new Error("Unowned queue work exists; refusing to alter integration fixtures.");
    }
    const [control] = await db.select().from(schema.aptlssManagerControl).where(eq(schema.aptlssManagerControl.id, 1));
    if (control?.activeVaId) throw new Error("The dedicated test database already has a pilot lease; refusing to alter another fixture.");
    if (!control) {
      await db.insert(schema.aptlssManagerControl).values({ id: 1 });
      createdControl = true;
    }
    service = await import("./aptlssManagerService");
    reviews = await import("./aptlssManagerReviewService");
  }, 60_000);

  async function insertUser(role: "worker" | "admin") {
    const openId = `manager-it-${randomUUID()}`;
    const [row] = await db.insert(schema.users).values({ openId, name: `Integration ${role}`, role }).$returningId();
    ownedUsers.push(row.id);
    return { id: row.id, openId };
  }

  async function insertWorker(): Promise<Worker> {
    const user = await insertUser("worker");
    pilotWorkers.push(user.id);
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", pilotWorkers.join(","));
    const cardId = `manager-it-${randomUUID()}`;
    await db.insert(schema.userWorkingHours).values({ userId: user.id, userOpenId: user.openId,
      timezone: "UTC", workStartHour: 9, workEndHour: 18, enableBreaks: 0, workingDays: "1,2,3,4,5" });
    await db.insert(schema.aptlssPlans).values({ vaId: user.id, cardId, cardName: "Review local requirements",
      cardUrl: `https://trello.com/c/${cardId}`, boardName: "Integration fixture", listName: "TO DO", planJson: "{}", generatedAt: NOW });
    const [step] = await db.insert(schema.aptlssSteps).values({ vaId: user.id, cardId, stepNumber: 1,
      title: "Compare local requirements", estimatedMinutes: 20, completionCriteria: "Comparison is recorded locally" }).$returningId();
    await db.insert(schema.trelloCachedCards).values({ userId: user.id, userOpenId: user.openId, boardId: "integration",
      cardId, cardData: JSON.stringify({ id: cardId, name: "Review local requirements", desc: "Compare the local requirements document.",
        dateLastActivity: NOW.toISOString(), due: null }), cachedAt: NOW, expiresAt: new Date("2026-09-05T10:00:00Z") });
    await db.insert(schema.aptlssManagerState).values({ vaId: user.id, mode: "shadow", shadowStartedAt: new Date("2026-08-01T00:00:00Z") });
    return { ...user, cardId, stepId: step.id };
  }

  it.each([
    { dependsOnCards: '["1"]', blockedBy: null },
    { dependsOnCards: '[]', blockedBy: "Step 1" },
  ])("resolves stored step ordinals without losing prerequisite completion gates: %j", async (dependency) => {
    const [dependent] = await db.insert(schema.aptlssSteps).values({
      vaId: worker.id, cardId: worker.cardId, stepNumber: 2,
      title: "Prepare local implementation", ...dependency,
    }).$returningId();
    const input = await service.collectManagerInput(db, worker.id, NOW);
    const refs = input.cards[0].steps.find(s => s.id === dependent.id)!.dependsOn;
    expect(refs).toEqual([`${worker.cardId}:${worker.stepId}`]);
    const before = assessManagerContext(input);
    expect(before.interventions.some(i => i.title === "Missing dependency")).toBe(false);
    expect(before.actions.find(a => a.stepIds.includes(dependent.id))!.blocked).toBe(true);
    await db.update(schema.aptlssSteps).set({ status: "complete" }).where(eq(schema.aptlssSteps.id, worker.stepId));
    const after = assessManagerContext(await service.collectManagerInput(db, worker.id, NOW));
    expect(after.interventions.some(i => i.title === "Missing dependency")).toBe(false);
    expect(after.actions.find(a => a.stepIds.includes(dependent.id))!.blocked).toBe(false);
  });

  beforeEach(async () => {
    pilotWorkers = [];
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("APTLSS_MANAGER_MODEL", "");
    vi.stubEnv("APTLSS_MANAGER_PROVIDER", "openai-api");
    controls.db = db;
    controls.safety = true;
    controls.digest = "aptlss-mysql-integration-controlled-digest";
    controls.model.mockReset().mockImplementation(async (_input, base, outcome) => { outcome?.(true); return base; });
    controls.emit.mockReset();
    // Only Date is faked: MySQL connection timers and interleavings remain real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    adminId = (await insertUser("admin")).id;
    worker = await insertWorker();
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    controls.db = db;
    if (!db || !ownedUsers.length) return;
    // Only identities allocated by this test and their newly created dependent rows.
    const evidence = await db.select({ id: schema.workspaceEvidenceItems.id }).from(schema.workspaceEvidenceItems)
      .where(or(...ownedUsers.flatMap(id => [
        like(schema.workspaceEvidenceItems.sourceId, `worker-assertion:${id}:%`),
        like(schema.workspaceEvidenceItems.sourceId, `verified-conflict-resolution:${id}:%`),
      ])));
    const evidenceIds = [...new Set([...ownedEvidenceIds, ...evidence.map(row => row.id)])];
    await db.transaction(async tx => {
      await tx.update(queueSlots).set({vaId:null,token:null,leaseUntil:null}).where(inArray(queueSlots.vaId,ownedUsers));
      await tx.delete(queueEvents).where(inArray(queueEvents.vaId,ownedUsers));
      await tx.delete(queueJobs).where(inArray(queueJobs.vaId,ownedUsers));
      await tx.update(schema.aptlssManagerControl).set({ activeVaId: null }).where(inArray(schema.aptlssManagerControl.activeVaId, ownedUsers));
      await tx.delete(schema.aptlssManagerCorrections).where(inArray(schema.aptlssManagerCorrections.vaId, ownedUsers));
      await tx.delete(schema.aptlssManagerTrialEvents).where(inArray(schema.aptlssManagerTrialEvents.vaId, ownedUsers));
      await tx.delete(schema.aptlssManagerReviews).where(inArray(schema.aptlssManagerReviews.vaId, ownedUsers));
      await tx.delete(schema.aptlssManagerRuns).where(inArray(schema.aptlssManagerRuns.vaId, ownedUsers));
      await tx.delete(schema.aptlssManagerUpdates).where(inArray(schema.aptlssManagerUpdates.vaId, ownedUsers));
      await tx.delete(schema.aptlssManagerState).where(inArray(schema.aptlssManagerState.vaId, ownedUsers));
      await tx.delete(schema.appSettings).where(and(inArray(schema.appSettings.vaId, ownedUsers), like(schema.appSettings.key, "aptlss_manager_semantic:%")));
      await tx.delete(schema.aptlssVerificationFollowups).where(inArray(schema.aptlssVerificationFollowups.vaId, ownedUsers));
      await tx.delete(schema.aptlssEvidenceConflicts).where(inArray(schema.aptlssEvidenceConflicts.vaId, ownedUsers));
      await tx.delete(schema.aptlssEvidenceSubjectLinks).where(inArray(schema.aptlssEvidenceSubjectLinks.vaId, ownedUsers));
      if (evidenceIds.length) {
        await tx.delete(schema.workspaceEvidenceLinks).where(inArray(schema.workspaceEvidenceLinks.evidenceId, evidenceIds));
        await tx.delete(schema.aptlssEvidenceRevisions).where(inArray(schema.aptlssEvidenceRevisions.evidenceId, evidenceIds));
        await tx.delete(schema.workspaceEvidenceItems).where(inArray(schema.workspaceEvidenceItems.id, evidenceIds));
      }
      await tx.delete(schema.dailyPlans).where(inArray(schema.dailyPlans.vaId, ownedUsers));
      await tx.delete(schema.timeEntries).where(inArray(schema.timeEntries.vaId, ownedUsers));
      await tx.delete(schema.aptlssSteps).where(inArray(schema.aptlssSteps.vaId, ownedUsers));
      await tx.delete(schema.aptlssPlans).where(inArray(schema.aptlssPlans.vaId, ownedUsers));
      await tx.delete(schema.trelloCachedCards).where(inArray(schema.trelloCachedCards.userId, ownedUsers));
      await tx.delete(schema.userWorkingHours).where(inArray(schema.userWorkingHours.userId, ownedUsers));
      await tx.delete(schema.users).where(inArray(schema.users.id, ownedUsers));
    });
    ownedUsers = [];
    ownedEvidenceIds = [];
  }, 30_000);

  afterAll(async () => {
    try {
      if (createdControl) await db.delete(schema.aptlssManagerControl).where(and(eq(schema.aptlssManagerControl.id, 1), sql`${schema.aptlssManagerControl.activeVaId} IS NULL`));
      if (lockConnection) {
        await lockConnection.query("SELECT RELEASE_LOCK('aptlss-manager-integration-fixtures')");
        lockConnection.release();
      }
    } finally {
      if (pool) await pool.end();
      controls.db = undefined;
      vi.unstubAllEnvs();
    }
  }, 30_000);

  const plans = (id = worker.id) => db.select().from(schema.dailyPlans).where(eq(schema.dailyPlans.vaId, id));
  const runs = (id = worker.id) => db.select().from(schema.aptlssManagerRuns).where(eq(schema.aptlssManagerRuns.vaId, id));
  const state = async (id = worker.id) => (await db.select().from(schema.aptlssManagerState).where(eq(schema.aptlssManagerState.vaId, id)))[0];
  const lease = async () => (await db.select().from(schema.aptlssManagerControl).where(eq(schema.aptlssManagerControl.id, 1)))[0];

  describe("durable queue service integration",()=>{
    async function queuedLease() {
      await db.transaction(tx=>enqueueManagerTask(tx,{vaId:worker.id,trigger:"manual",eventKey:randomUUID()}));
      const claimed=await claimManagerTask(db,{leaseMs:60000});
      expect(claimed?.vaId).toBe(worker.id);
      return claimed!;
    }
    async function expireQueueLease(claimed:ManagerQueueLease) {
      await db.transaction(async tx=>{
        const expired=new Date("2000-01-01T00:00:00Z");
        await tx.update(queueSlots).set({leaseUntil:expired}).where(eq(queueSlots.id,claimed.slotId));
        await tx.update(queueJobs).set({leaseUntil:expired}).where(eq(queueJobs.vaId,claimed.vaId));
      });
    }
    it.each(["expired","disabled"] as const)("real service rejects %s lease without run, plan or state writes",async reason=>{
      const claimed=await queuedLease();
      if(reason==="expired")await expireQueueLease(claimed);
      else await db.update(schema.aptlssManagerState).set({enabled:false}).where(eq(schema.aptlssManagerState.vaId,worker.id));
      const before=await state();
      await expect(service.runManager(worker.id,claimed.trigger,claimed)).rejects.toThrow(/lease|disabled/i);
      expect(await runs()).toEqual([]);expect(await plans()).toEqual([]);expect(await state()).toEqual(before);
      expect(controls.emit).not.toHaveBeenCalled();
    });
    it("unchanged-input service fastpath cannot update checkedAt under an expired lease",async()=>{
      await service.runManager(worker.id);
      const claimed=await queuedLease();await expireQueueLease(claimed);
      const before={state:await state(),runs:await runs(),plans:await plans()};
      await expect(service.runManager(worker.id,claimed.trigger,claimed)).rejects.toThrow(/lease/i);
      expect({state:await state(),runs:await runs(),plans:await plans()}).toEqual(before);
    });
    it("an expired queued model failure cannot overwrite manager state in the error handler",async()=>{
      const claimed=await queuedLease();
      controls.model.mockImplementationOnce(async()=>{await expireQueueLease(claimed);throw new Error("model fixture failed");});
      const before=await state();
      await expect(service.runManager(worker.id,claimed.trigger,claimed)).rejects.toThrow();
      expect(await runs()).toEqual([]);expect(await plans()).toEqual([]);expect(await state()).toEqual(before);
    });
    it("a queued lease waits for an in-flight manual run and then enforces its own ownership",async()=>{
      const claimed=await queuedLease(),paused=pauseModel();
      const manual=service.runManager(worker.id);await paused.ready;
      const queued=service.runManager(worker.id,claimed.trigger,claimed);
      expect(queued).not.toBe(manual);
      const rejection=expect(queued).rejects.toThrow(/lease/i);
      try{await expireQueueLease(claimed);}finally{paused.resume();}
      await manual;await rejection;
      expect(await runs()).toHaveLength(1);expect((await state()).lastError).toBeNull();
    });
    it("queue status is scoped to the worker and omits tokens and receipt identities",async()=>{
      const other=await insertWorker();
      const claimed=await queuedLease();
      await db.transaction(tx=>enqueueManagerTask(tx,{vaId:other.id,trigger:"conflict",eventKey:"other-secret",urgent:true}));
      const own=(await service.getManagerStatus(worker.id)).queue;
      const theirs=(await service.getManagerStatus(other.id)).queue;
      expect(own?.state).toBe("leased");expect(theirs?.state).toBe("pending");
      expect(Object.keys(own!).sort()).toEqual(["state","requestedAt","availableAt","attempts","lastError","completedAt"].sort());
      expect(JSON.stringify(own)).not.toContain(claimed.token);expect(JSON.stringify(theirs)).not.toContain("other-secret");
    });
    it("real evidence ingestion atomically queues and deduplicates a scoped source revision",async()=>{
      const graph=await import("./aptlssEvidenceGraphDb");
      const draft={source:"communication" as const,sourceId:`queue-source:${randomUUID()}`,kind:"message",title:"Source fixture",content:"Local review is required.",observedAt:NOW.toISOString(),contentHash:hash("source fixture")};
      const evidence=await graph.recordAptlssEvidence({vaId:worker.id,cardId:worker.cardId,draft,truthClass:"source_record",database:db});
      ownedEvidenceIds.push(evidence.evidenceId);
      await graph.recordAptlssEvidence({vaId:worker.id,cardId:worker.cardId,draft,truthClass:"source_record",database:db});
      expect((await db.select().from(queueJobs).where(eq(queueJobs.vaId,worker.id)))[0]).toMatchObject({state:"pending",generation:1});
      expect(await db.select().from(queueEvents).where(eq(queueEvents.vaId,worker.id))).toHaveLength(1);
      const rollbackDraft={...draft,sourceId:`queue-rollback:${randomUUID()}`};
      await expect(db.transaction(async tx=>{
        await graph.recordAptlssEvidence({vaId:worker.id,cardId:worker.cardId,draft:rollbackDraft,truthClass:"source_record",database:tx as unknown as typeof db});
        throw new Error("rollback fixture");
      })).rejects.toThrow("rollback fixture");
      expect(await db.select().from(schema.workspaceEvidenceItems).where(eq(schema.workspaceEvidenceItems.sourceId,rollbackDraft.sourceId))).toEqual([]);
      expect((await db.select().from(queueJobs).where(eq(queueJobs.vaId,worker.id)))[0].generation).toBe(1);
    });
    it("a queue write failure rolls back actual source storage rather than losing its wakeup",async()=>{
      const graph=await import("./aptlssEvidenceGraphDb");
      const queue=await import("./aptlssManagerQueue");
      const sourceId=`queue-failed-write:${randomUUID()}`;
      vi.spyOn(queue,"enqueueManagerTask").mockRejectedValueOnce(new Error("queue fixture unavailable"));
      await expect(graph.recordAptlssEvidence({vaId:worker.id,cardId:worker.cardId,truthClass:"source_record",database:db,
        draft:{source:"communication",sourceId,kind:"message",title:"Source fixture",content:"Local review is required.",contentHash:hash("Local review is required."),observedAt:NOW.toISOString()}})).rejects.toThrow("queue fixture unavailable");
      expect(await db.select().from(schema.workspaceEvidenceItems).where(eq(schema.workspaceEvidenceItems.sourceId,sourceId))).toEqual([]);
      expect(await db.select().from(queueJobs).where(eq(queueJobs.vaId,worker.id))).toEqual([]);
    });
    it("actual conflict and verified resolution events preserve urgent queue precedence",async()=>{
      const graph=await import("./aptlssEvidenceGraphDb");
      const fixture=await seedGraphConflict();
      await graph.createEvidenceConflict({vaId:worker.id,cardId:worker.cardId,sourceEvidenceId:fixture.input.sourceEvidenceId,
        assertedEvidenceId:fixture.assertedEvidenceId,question:"Verify the source",createdBy:String(adminId)});
      expect((await db.select().from(queueJobs).where(eq(queueJobs.vaId,worker.id)))[0]).toMatchObject({state:"pending",priority:100,trigger:"conflict"});
      await graph.resolveVerificationFollowup(fixture.input);
      expect((await db.select().from(queueJobs).where(eq(queueJobs.vaId,worker.id)))[0]).toMatchObject({state:"pending",priority:100,trigger:"conflict_resolved"});
      expect((await graphRows()).conflicts[0].status).toBe("resolved");
    });
  });
  const reviewInput = (runId: number, vaId = worker.id) => ({ vaId, runId, verdict: "correct" as const, critical: false, correction: "", source: "Local fixture requirements" });

  function emptyPlan(): OperatorDailyPlanPayload {
    return { version: 2, dateKey: DATE_KEY, generatedAt: NOW.toISOString(), blocks: [], robertItems: [], unscheduledCards: [],
      planHealth: { confidence: 0, scheduledMinutes: 0, availableMinutes: 540, overlaps: 0, gaps: 540 },
      constraints: { startTime: "09:00", endTime: "18:00", breaks: [] }, auditTrail: [] };
  }
  async function seedPlan(plan = emptyPlan(), id = worker.id) {
    await db.insert(schema.dailyPlans).values({ vaId: id, dateKey: DATE_KEY, scheduleJson: JSON.stringify(plan),
      generatedAt: NOW, dailySummary: "Original fixture", totalScheduledMinutes: plan.planHealth.scheduledMinutes });
    return plan;
  }

  // Historical acceptance fixtures, not claims of 100 real-world reviewed proposals.
  async function seedTrial(target = worker, count = 100, days = 5, distinct = count) {
    const base = await service.runManager(target.id);
    const rows = Array.from({ length: count }, (_, index) => {
      const createdAt = new Date(`2026-08-${24 + index % days}T10:00:00Z`);
      const proposalHash = hash(`${target.cardId}:trial:${index % distinct}`);
      const snapshot: ManagerSnapshot = { ...base, implementationDigest: controls.digest, proposalHash,
        assessedAt: createdAt.toISOString(), interventions: [], applied: false };
      return { vaId: target.id, inputHash: hash(`${proposalHash}:${index}`),
        trigger: "integration_history", mode: "shadow" as const, proposalHash, snapshotJson: JSON.stringify(snapshot), createdAt };
    });
    await db.insert(schema.aptlssManagerRuns).values(rows);
    const inserted = await db.select().from(schema.aptlssManagerRuns).where(and(eq(schema.aptlssManagerRuns.vaId, target.id),
      eq(schema.aptlssManagerRuns.trigger, "integration_history")));
    expect(inserted).toHaveLength(count);
    await db.insert(schema.aptlssManagerReviews).values(inserted.map(run => ({
      ...reviewInput(run.id, target.id), proposalHash: run.proposalHash!, reviewerId: adminId, reviewedAt: run.createdAt,
    })));
    return base;
  }
  // Replaces historical active-success setup with a real policy rejection.
  // These tests provide shadow-pilot coverage, not active-write acceptance.
  async function rejectActivation(target = worker) {
    await seedTrial(target);
    await expect(reviews.setManagerMode(adminId, target.id, "active")).rejects.toThrow(/shadow-only/i);
    expect((await lease()).activeVaId).toBeNull();
    // Start a fresh shadow assessment after inserting synthetic historical samples.
    await reviews.setManagerMode(adminId, target.id, "shadow");
  }

  function pauseModel() {
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    controls.model.mockImplementationOnce(async (_input, base, outcome) => { entered(); await released; outcome?.(true); return base; });
    return { ready, resume };
  }

  it("refreshes clock-only planning after a long model response without repeating that model call", async () => {
    controls.model.mockImplementation(async (_input, base, outcome) => {
      vi.setSystemTime(new Date(Date.now() + 61_000));
      outcome?.(true);
      return base;
    });
    const result = await service.runManager(worker.id);
    expect(controls.model).toHaveBeenCalledTimes(1);
    expect(result.assessedAt).toBe(new Date(NOW.getTime() + 61_000).toISOString());
    expect(result.proposal?.generatedAt).toBe(result.assessedAt);
    expect(await runs()).toHaveLength(1);
    expect(await plans()).toHaveLength(0);
  });

  describe("reviewed learning and trial lifecycle", () => {
    async function retainCorrection() {
      const snapshot = await service.runManager(worker.id);
      const action = snapshot.actions.find(a => a.kind === "work")!;
      expect(action).toBeDefined();
      const recorded = await reviews.recordManagerReview(adminId, {
        ...reviewInput(snapshot.runId), correction: "Compare the local requirements before preparing the result.",
        correctionKnowledge: { scope: "card", cardId: worker.cardId, topic: "requirements",
          evidenceIds: [`card:${worker.cardId}`], conditions: { actionKind: "work" },
          validUntil: "2026-09-05T10:00:00Z" },
      });
      expect(recorded.correctionId).toBeGreaterThan(0);
      return { snapshot, recorded };
    }

    it("reuses a scoped source-pinned correction, then withholds it after the source changes", async () => {
      const { snapshot, recorded } = await retainCorrection();
      const learned = await service.runManager(worker.id);
      expect(learned.runId).not.toBe(snapshot.runId);
      expect(learned.actions.find(a => a.kind === "work")?.reviewedGuidance).toEqual([
        expect.objectContaining({ id: recorded.correctionId, cardId: worker.cardId }),
      ]);
      expect(await plans()).toHaveLength(0);
      const other = await insertWorker();
      expect((await service.runManager(other.id)).actions.every(a => !a.reviewedGuidance?.length)).toBe(true);
      await db.update(schema.trelloCachedCards).set({ cardData: JSON.stringify({ id: worker.cardId,
        name: "Updated requirements", desc: "Compare the revised requirements.", dateLastActivity: NOW.toISOString() }) })
        .where(eq(schema.trelloCachedCards.userId, worker.id));
      const changed = await service.runManager(worker.id);
      expect(changed.runId).not.toBe(learned.runId);
      expect(changed.actions.every(a => !a.reviewedGuidance?.length)).toBe(true);
      expect(await db.select().from(schema.aptlssManagerCorrections).where(eq(schema.aptlssManagerCorrections.vaId, worker.id))).toHaveLength(1);
    });

    it("revokes guidance without removing the reviewed history and rejects worker revocation", async () => {
      const { recorded } = await retainCorrection();
      expect((await service.runManager(worker.id)).actions.some(a => a.reviewedGuidance?.length)).toBe(true);
      const input = { vaId: worker.id, correctionId: recorded.correctionId!, reason: "The handling guidance needs a new review." };
      await expect(reviews.revokeManagerCorrection(worker.id, input)).rejects.toThrow(/admin/i);
      await expect(reviews.revokeManagerCorrection(adminId, input)).resolves.toMatchObject({ revoked: true });
      expect((await service.runManager(worker.id)).actions.every(a => !a.reviewedGuidance?.length)).toBe(true);
      const [row] = await db.select().from(schema.aptlssManagerCorrections).where(eq(schema.aptlssManagerCorrections.id, input.correctionId));
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(await db.select().from(schema.aptlssManagerReviews).where(eq(schema.aptlssManagerReviews.id, row.reviewId))).toHaveLength(1);
    });

    it("rolls back a review and knowledge record together when its source is not retained", async () => {
      const snapshot = await service.runManager(worker.id);
      await expect(reviews.recordManagerReview(adminId, { ...reviewInput(snapshot.runId), correction: "Unverified guidance is not usable.",
        correctionKnowledge: { scope: "card", cardId: worker.cardId, topic: "requirements", evidenceIds: ["missing-source"],
          conditions: {}, validUntil: "2026-09-05T10:00:00Z" } })).rejects.toThrow(/retained source/i);
      expect(await db.select().from(schema.aptlssManagerReviews).where(eq(schema.aptlssManagerReviews.vaId, worker.id))).toHaveLength(0);
      expect(await db.select().from(schema.aptlssManagerCorrections).where(eq(schema.aptlssManagerCorrections.vaId, worker.id))).toHaveLength(0);
    });

    it("deduplicates repeated runs and preserves their review through close and restart", async () => {
      const snapshot = await service.runManager(worker.id);
      const [source] = await db.select().from(schema.aptlssManagerRuns).where(eq(schema.aptlssManagerRuns.id, snapshot.runId));
      const { id: _id, ...duplicate } = source;
      await db.insert(schema.aptlssManagerRuns).values(duplicate);
      const inbox = await reviews.getManagerReviewInbox(adminId, worker.id);
      expect(inbox.entries).toHaveLength(1);
      await reviews.recordManagerReview(adminId, reviewInput(snapshot.runId));
      const historyBefore = await db.select().from(schema.aptlssManagerRuns).where(eq(schema.aptlssManagerRuns.vaId, worker.id));
      const request = { vaId: worker.id, reason: "Close the rehearsal without deleting any evidence." };
      await expect(reviews.closeManagerTrial(worker.id, request)).rejects.toThrow(/admin/i);
      await reviews.closeManagerTrial(adminId, request);
      expect((await reviews.getManagerGate(worker.id, db)).reasons.join(" ")).toMatch(/closed/i);
      await reviews.restartManagerTrial(adminId, { ...request, reason: "Start a distinct trial after reviewing the earlier results." });
      expect(await db.select().from(schema.aptlssManagerRuns).where(eq(schema.aptlssManagerRuns.vaId, worker.id))).toEqual(historyBefore);
      expect(await db.select().from(schema.aptlssManagerReviews).where(eq(schema.aptlssManagerReviews.vaId, worker.id))).toHaveLength(1);
      expect(await reviews.getManagerGate(worker.id, db)).toMatchObject({ reviewed: 0, eligible: false });
      expect((await reviews.getManagerReviewInbox(adminId, worker.id)).entries).toHaveLength(0);
      const fresh = await service.runManager(worker.id);
      expect(fresh.runId).toBeGreaterThan(Math.max(...historyBefore.map(r => r.id)));
      await expect(reviews.recordManagerReview(adminId, reviewInput(snapshot.runId))).rejects.toThrow(/current implementation|open trial/i);
    });
  });

  async function seedGraphConflict(target = worker) {
    const observedAt = new Date("2026-09-01T10:00:00Z");
    const conflictAt = new Date("2026-09-02T10:00:00Z");
    const sourceQuote = "Invoice A-12 is unpaid.";
    const retained: Array<{ evidenceId: number; revisionId: number }> = [];
    for (const [content, truthClass] of [[sourceQuote, "source_record"], ["Invoice A-12 is paid.", "worker_assertion"]] as const) {
      const metadataJson = JSON.stringify({ sourceDate: observedAt.toISOString() });
      const [item] = await db.insert(schema.workspaceEvidenceItems).values({ vaId: target.id, source: "trello",
        sourceId: `manager-it-source:${randomUUID()}`, sourceUrl: "https://example.test/retained-invoice",
        kind: truthClass === "worker_assertion" ? "worker_assertion" : "record", title: "Retained invoice status",
        content, contentHash: hash(content), observedAt, modifiedAt: observedAt, createdAt: observedAt, metadataJson }).$returningId();
      ownedEvidenceIds.push(item.id);
      const [revision] = await db.insert(schema.aptlssEvidenceRevisions).values({ evidenceId: item.id, truthClass,
        content, contentHash: hash(content), observedAt, createdAt: observedAt, metadataJson }).$returningId();
      await db.insert(schema.aptlssEvidenceSubjectLinks).values({ evidenceId: item.id, vaId: target.id,
        subjectType: "card", subjectId: target.cardId, relevanceScore: 100, linkMethod: "confirmed", matchReason: "Explicit fixture source" });
      await db.insert(schema.workspaceEvidenceLinks).values({ evidenceId: item.id, cardId: target.cardId,
        relevanceScore: 100, linkMethod: "manual", matchReason: "Explicit fixture source" });
      retained.push({ evidenceId: item.id, revisionId: revision.id });
    }
    const [conflict] = await db.insert(schema.aptlssEvidenceConflicts).values({ vaId: target.id,
      sourceEvidenceId: retained[0].evidenceId, assertedEvidenceId: retained[1].evidenceId,
      status: "needs_verification", createdAt: conflictAt }).$returningId();
    const [followup] = await db.insert(schema.aptlssVerificationFollowups).values({ vaId: target.id, cardId: target.cardId,
      conflictId: conflict.id, title: "Verify invoice status", question: "Which retained source establishes the invoice status?",
      status: "open", createdAt: conflictAt }).$returningId();
    return { conflictId: conflict.id, sourceRevisionId: retained[0].revisionId, assertedEvidenceId: retained[1].evidenceId,
      input: { vaId: target.id, followupId: followup.id, resolution: "Verified against the retained invoice source.",
        resolvedBy: String(adminId), sourceEvidenceId: retained[0].evidenceId, sourceQuote } };
  }

  async function graphRows(target = worker) {
    const links = await db.select().from(schema.aptlssEvidenceSubjectLinks)
      .where(eq(schema.aptlssEvidenceSubjectLinks.vaId, target.id)).orderBy(schema.aptlssEvidenceSubjectLinks.id);
    const ids = links.map(link => link.evidenceId);
    return {
      conflicts: await db.select().from(schema.aptlssEvidenceConflicts).where(eq(schema.aptlssEvidenceConflicts.vaId, target.id)).orderBy(schema.aptlssEvidenceConflicts.id),
      followups: await db.select().from(schema.aptlssVerificationFollowups).where(eq(schema.aptlssVerificationFollowups.vaId, target.id)).orderBy(schema.aptlssVerificationFollowups.id),
      links,
      items: ids.length ? await db.select().from(schema.workspaceEvidenceItems).where(inArray(schema.workspaceEvidenceItems.id, ids)).orderBy(schema.workspaceEvidenceItems.id) : [],
      revisions: ids.length ? await db.select().from(schema.aptlssEvidenceRevisions).where(inArray(schema.aptlssEvidenceRevisions.evidenceId, ids)).orderBy(schema.aptlssEvidenceRevisions.id) : [],
      legacyLinks: ids.length ? await db.select().from(schema.workspaceEvidenceLinks).where(inArray(schema.workspaceEvidenceLinks.evidenceId, ids)).orderBy(schema.workspaceEvidenceLinks.id) : [],
      decisions: await db.select().from(schema.workspaceEvidenceItems)
        .where(like(schema.workspaceEvidenceItems.sourceId, `verified-conflict-resolution:${target.id}:%`)).orderBy(schema.workspaceEvidenceItems.id),
    };
  }

  it("persists a shadow proposal without inserting a daily plan", async () => {
    const result = await service.runManager(worker.id);
    expect(result.policy.mode).toBe("shadow");
    expect(result.applied).toBe(false);
    expect(result.proposal?.blocks.length).toBeGreaterThan(0);
    expect(await plans()).toEqual([]);
    const [row] = await runs();
    expect(JSON.parse(row.snapshotJson)).toMatchObject({ proposal: result.proposal, applied: false, implementationDigest: controls.digest });
    expect(row.proposalHash).toBe(result.proposalHash);
    expect(row.appliedPlanHash).toBeNull();
  });

  it("never updates an existing daily plan in shadow mode", async () => {
    await seedPlan();
    const before = await plans();
    const result = await service.runManager(worker.id);
    expect(result.proposal?.blocks.length).toBeGreaterThan(0);
    expect(result.applied).toBe(false);
    expect(await plans()).toEqual(before);
  });
  it("persists subscription reasoning levels and reasons in worker-scoped history", async () => {
    vi.stubEnv("APTLSS_MANAGER_PROVIDER", "codex-subscription");
    const attempts: CodexManagerAttempt[] = [
      { effort: "low", outcome: "context_review", reason: "chronology", durationMs: 10, inputTokens: 100, outputTokens: 20 },
      { effort: "medium", outcome: "accepted", durationMs: 20, inputTokens: 100, outputTokens: 30 },
    ];
    controls.model.mockImplementation(async (_input, base, outcome) => { outcome?.(true, undefined, attempts); return base; });
    const result = await service.runManager(worker.id);
    expect(result.semanticReview).toMatchObject({ provider: "codex-subscription", success: true, attempts });
    const [row] = await runs();
    expect(JSON.parse(row.snapshotJson).semanticReview.attempts).toEqual(attempts);
    const [runtime] = await db.select().from(schema.appSettings).where(and(eq(schema.appSettings.vaId, worker.id), eq(schema.appSettings.key, `aptlss_manager_semantic:${worker.id}:codex`)));
    expect(JSON.parse(runtime.value).attempts).toEqual(attempts);
    expect(await plans()).toEqual([]);
    expect(row.appliedPlanHash).toBeNull();
  });

  it("persists explicit worker updates, graph links and revisions before reassessment", async () => {
    const previous = await service.runManager(worker.id);
    vi.setSystemTime(new Date(Date.parse(previous.semanticReview!.retryAfter) + 1));
    const detail = "The local requirements document was verified today; comparison can continue.";
    const result = await service.submitManagerUpdate(worker.id, worker.cardId, detail);
    expect(result.runId).not.toBe(previous.runId);
    expect(result.trigger).toBe("worker_update");
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ cardId: worker.cardId, kind: "worker", text: expect.stringContaining(detail) })]));
    const [update] = await db.select().from(schema.aptlssManagerUpdates).where(eq(schema.aptlssManagerUpdates.vaId, worker.id));
    expect(update.detail).toBe(detail);
    const links = await db.select().from(schema.aptlssEvidenceSubjectLinks).where(eq(schema.aptlssEvidenceSubjectLinks.vaId, worker.id));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ subjectType: "card", subjectId: worker.cardId, linkMethod: "confirmed" });
    const [revision] = await db.select().from(schema.aptlssEvidenceRevisions).where(eq(schema.aptlssEvidenceRevisions.evidenceId, links[0].evidenceId));
    expect(revision).toMatchObject({ truthClass: "worker_assertion", content: detail, recordedBy: String(worker.id) });
    expect(controls.model).toHaveBeenCalledTimes(2);
    expect(await plans()).toEqual([]);
  });

  it("is idempotent for identical input and coalesces same-process concurrent requests", async () => {
    const pending = service.runManager(worker.id);
    const concurrent = service.runManager(worker.id);
    expect(concurrent).toBe(pending);
    const first = await pending;
    const repeated = await service.runManager(worker.id);
    expect(repeated.runId).toBe(first.runId);
    expect(await runs()).toHaveLength(1);
    expect(controls.model).toHaveBeenCalledTimes(1);
    expect(await plans()).toEqual([]);
  });

  it("rolls back run and state writes on SQL failure without touching the canonical plan", async () => {
    await rejectActivation();
    await seedPlan();
    const beforePlans = await plans(), beforeRuns = await runs(), beforeState = await state();
    const transaction = db.transaction.bind(db);
    let writesSeen = false;
    vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(async tx => {
      const result = await callback(tx);
      const rows = await tx.select().from(schema.aptlssManagerRuns).where(eq(schema.aptlssManagerRuns.vaId, worker.id));
      writesSeen = rows.length > beforeRuns.length;
      const plansInTransaction = await tx.select().from(schema.dailyPlans).where(eq(schema.dailyPlans.vaId, worker.id));
      expect(plansInTransaction).toEqual(beforePlans);
      // MySQL raises the error inside the real transaction, after the service's SQL.
      await tx.execute(sql`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'integration forced rollback'`);
      return result;
    }));
    await expect(service.runManager(worker.id)).rejects.toThrow(/assessment failed/i);
    expect(writesSeen).toBe(true);
    expect(await plans()).toEqual(beforePlans);
    expect(await runs()).toEqual(beforeRuns);
    expect((await state()).inputHash).toBe(beforeState.inputHash);
    expect((await state()).lastError).toMatch(/assessment failed/i);
  });

  it("rolls back worker evidence and its nested savepoint when the update transaction fails", async () => {
    const transaction = db.transaction.bind(db);
    let evidenceWritten = false;
    vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(async tx => {
      const result = await callback(tx);
      evidenceWritten = (await tx.select().from(schema.aptlssEvidenceSubjectLinks).where(eq(schema.aptlssEvidenceSubjectLinks.vaId, worker.id))).length === 1;
      await tx.execute(sql`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'integration update rollback'`);
      return result;
    }));
    await expect(service.submitManagerUpdate(worker.id, worker.cardId, "Verified local requirements.")).rejects.toThrow();
    expect(evidenceWritten).toBe(true);
    expect(await db.select().from(schema.aptlssManagerUpdates).where(eq(schema.aptlssManagerUpdates.vaId, worker.id))).toEqual([]);
    expect(await db.select().from(schema.aptlssEvidenceSubjectLinks).where(eq(schema.aptlssEvidenceSubjectLinks.vaId, worker.id))).toEqual([]);
    expect(await db.select().from(schema.workspaceEvidenceItems).where(like(schema.workspaceEvidenceItems.sourceId, `worker-assertion:${worker.id}:%`))).toEqual([]);
    expect(await runs()).toEqual([]);
    expect(controls.model).not.toHaveBeenCalled();
  });

  it.each(["timer", "plan", "hours", "policy"] as const)("rejects a changed %s during model assessment and retries from fresh SQL context", async kind => {
    const paused = pauseModel();
    const pending = service.runManager(worker.id);
    try {
      await paused.ready;
      expect(await runs()).toEqual([]);
      if (kind === "timer") await db.insert(schema.timeEntries).values({ vaId: worker.id, founderId: adminId,
        taskId: worker.cardId, cardId: worker.cardId, startTime: NOW, aptlssStepId: worker.stepId });
      if (kind === "plan") await seedPlan();
      if (kind === "hours") await db.update(schema.userWorkingHours).set({ workEndHour: 12 }).where(eq(schema.userWorkingHours.userId, worker.id));
      if (kind === "policy") await service.updateManagerPolicy(worker.id, { enabled: true, intervalMinutes: 17 });
    } finally { paused.resume(); }
    const result = await pending;
    expect(controls.model).toHaveBeenCalledTimes(1);
    expect(result.sourceGaps.join(" ")).toMatch(/bounded retry window/);
    expect(result.semanticReview?.success).toBe(false);
    expect(await runs()).toHaveLength(1);
    if (kind === "hours") expect(result.proposal?.constraints.endTime).toBe("12:00");
    if (kind === "policy") expect(result.policy.intervalMinutes).toBe(17);
    if (kind === "plan") expect(result.planVersion).toBe(reviews.managerPlanVersion((await plans())[0].scheduleJson));
    expect(result.applied).toBe(false);
    expect((await state()).lastError).toBeNull();
  });

  it("fails closed when input changes again on the single retry", async () => {
    const transaction = db.transaction.bind(db);
    // Mutate context immediately before each proposal transaction, including the
    // provider-free retry. Reservation transactions only lock the identity row.
    vi.spyOn(db, "transaction").mockImplementation((callback, config) => transaction(async tx => {
      if (config?.isolationLevel === "serializable") {
        await tx.update(schema.userWorkingHours).set({ workEndHour: sql`${schema.userWorkingHours.workEndHour} - 1` })
          .where(eq(schema.userWorkingHours.userId, worker.id));
      }
      return callback(tx);
    }, config));
    await expect(service.runManager(worker.id)).rejects.toThrow(/Source context changed/);
    expect(controls.model).toHaveBeenCalledTimes(1);
    expect(await runs()).toEqual([]);
    expect(await plans()).toEqual([]);
    expect((await state()).lastError).toMatch(/Source context changed/);
  });

  it("rejects another worker's run, card update, and review access without writes", async () => {
    const other = await insertWorker();
    const run = await service.runManager(other.id);
    await expect(reviews.recordManagerReview(adminId, reviewInput(run.runId))).rejects.toThrow(/worker-scoped/);
    await expect(reviews.getManagerReviewInbox(worker.id, other.id)).rejects.toThrow(/admin/i);
    await expect(reviews.recordManagerReview(worker.id, reviewInput(run.runId, other.id))).rejects.toThrow(/admin/i);
    await expect(reviews.setManagerMode(worker.id, other.id, "active")).rejects.toThrow(/shadow-only/i);
    await expect(reviews.restoreManagerPlan(worker.id, other.id, run.runId)).rejects.toThrow(/shadow-only/i);
    await expect(service.submitManagerUpdate(worker.id, other.cardId, "Unrelated worker update")).rejects.toThrow(/scope/);
    expect(await db.select().from(schema.aptlssManagerReviews).where(eq(schema.aptlssManagerReviews.runId, run.runId))).toEqual([]);
    expect(await db.select().from(schema.aptlssManagerUpdates).where(eq(schema.aptlssManagerUpdates.vaId, worker.id))).toEqual([]);
    const inbox = await reviews.getManagerReviewInbox(adminId, other.id);
    expect(inbox.entries.map(entry => entry.vaId)).toEqual([other.id]);
  });

  it.each([
    { count: 99, days: 5, distinct: 99, reason: /99\/100/ },
    { count: 100, days: 4, distinct: 100, reason: /4\/5/ },
    { count: 100, days: 5, distinct: 10, reason: /10\/100/ },
  ])("denies activation for $count reviews / $days days / $distinct distinct proposals", async fixture => {
    await seedTrial(worker, fixture.count, fixture.days, fixture.distinct);
    expect((await reviews.getManagerGate(worker.id, db)).reasons.join(" ")).toMatch(fixture.reason);
    await expect(reviews.setManagerMode(adminId, worker.id, "active")).rejects.toThrow(/shadow-only/i);
    expect((await state()).mode).toBe("shadow");
    expect((await lease()).activeVaId).toBeNull();
    expect(await plans()).toEqual([]);
  });

  it("requires verified safety for the exact implementation even after a complete trial", async () => {
    await seedTrial();
    controls.safety = false;
    expect((await reviews.getManagerGate(worker.id, db)).reasons.join(" ")).toMatch(/safety suite/i);
    await expect(reviews.setManagerMode(adminId, worker.id, "active")).rejects.toThrow(/shadow-only/i);
    controls.safety = true;
    controls.digest = "changed-implementation";
    expect((await reviews.getManagerGate(worker.id, db)).reasons.join(" ")).toMatch(/0\/100/);
    await expect(reviews.setManagerMode(adminId, worker.id, "active")).rejects.toThrow(/shadow-only/i);
    expect((await state()).mode).toBe("shadow");
    expect((await lease()).activeVaId).toBeNull();
  });

  it("rejects activation after a complete trial and keeps a changed implementation in shadow", async () => {
    await rejectActivation();
    expect(await reviews.getManagerGate(worker.id, db)).toMatchObject({ eligible: false, reviewed: 100, workingDays: 5 });
    const applied = await service.runManager(worker.id);
    expect(applied.applied).toBe(false);
    expect((await state()).mode).toBe("shadow");
    const before = await plans();

    controls.digest = "new-implementation-without-a-reviewed-trial";
    expect(controls.safety).toBe(true);
    const next = await service.runManager(worker.id, "scheduled");

    expect(next.runId).not.toBe(applied.runId);
    expect(next).toMatchObject({ policy: { mode: "shadow" }, applied: false, implementationDigest: controls.digest });
    expect((await state()).mode).toBe("shadow");
    expect(await plans()).toEqual(before);
    const persisted = (await runs()).find(run => run.id === next.runId)!;
    expect(persisted.mode).toBe("shadow");
    expect(persisted.appliedPlanHash).toBeNull();
    expect(JSON.parse(persisted.snapshotJson)).toMatchObject({ applied: false, implementationDigest: controls.digest });
    expect(await reviews.getManagerGate(worker.id, db)).toMatchObject({ eligible: false, reviewed: 0, safetyVerified: true });
  });

  it("critical review retains shadow mode and activation remains prohibited", async () => {
    await rejectActivation();
    const applied = await service.runManager(worker.id);
    expect(applied.applied).toBe(false);
    const before = await plans();
    await expect(reviews.recordManagerReview(adminId, { ...reviewInput(applied.runId), verdict: "incorrect", critical: true,
      correction: "The evidence was wrong; keep the worker in shadow." })).resolves.toMatchObject({ revertedToShadow: true });
    expect((await state()).mode).toBe("shadow");
    expect((await lease()).activeVaId).toBeNull();
    await db.update(schema.aptlssSteps).set({ title: "Different local requirement", estimatedMinutes: 40 }).where(eq(schema.aptlssSteps.id, worker.stepId));
    const next = await service.runManager(worker.id, "scheduled");
    expect(next.applied).toBe(false);
    expect(next.policy.mode).toBe("shadow");
    expect(await plans()).toEqual(before);
    const [recorded] = await db.select().from(schema.aptlssManagerReviews).where(eq(schema.aptlssManagerReviews.runId, applied.runId));
    expect(recorded).toMatchObject({ critical: true, verdict: "incorrect", reviewerId: adminId });
    await expect(reviews.recordManagerReview(adminId, reviewInput(applied.runId))).rejects.toThrow(/immutable|already/);
    expect((await reviews.getManagerGate(worker.id, db)).reasons.join(" ")).toMatch(/critical/i);
    await expect(reviews.setManagerMode(adminId, worker.id, "active")).rejects.toThrow(/shadow-only/i);
  });

  it("honors a critical review committed while a shadow assessment is paused", async () => {
    await rejectActivation();
    const applied = await service.runManager(worker.id);
    const before = await plans();
    await db.update(schema.aptlssSteps).set({ title: "Revised local requirements" }).where(eq(schema.aptlssSteps.id, worker.stepId));
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const paused = pauseModel();
    const pending = service.runManager(worker.id, "scheduled");
    try {
      await paused.ready;
      await reviews.recordManagerReview(adminId, { ...reviewInput(applied.runId), verdict: "incorrect", critical: true,
        correction: "Pause automation pending correction of the source." });
    } finally { paused.resume(); }
    const result = await pending;
    expect(result.policy.mode).toBe("shadow");
    expect(result.applied).toBe(false);
    expect(await plans()).toEqual(before);
    expect((await lease()).activeVaId).toBeNull();
  });

  it("serializes provider reservations across independent service instances without losing the completed assessment", async () => {
    vi.resetModules();
    const otherInstance = await import("./aptlssManagerService");
    const first = pauseModel();
    const pendingA = service.runManager(worker.id);
    await first.ready;
    try {
      const pendingB = otherInstance.runManager(worker.id);
      expect(pendingA).not.toBe(pendingB);
      expect((await pendingB).semanticReview?.success).toBe(false);
    } finally { first.resume(); }
    const a = await pendingA;
    expect(a.semanticReview?.success).toBe(true);
    expect((await otherInstance.runManager(worker.id)).runId).toBe(a.runId);
    expect(controls.model).toHaveBeenCalledTimes(1);
    expect(await runs()).toHaveLength(2);
    expect(await plans()).toEqual([]);
  });

  it("rejects simultaneous activation requests without taking a durable pilot lease", async () => {
    const other = await insertWorker();
    await seedTrial();
    await seedTrial(other);
    const results = await Promise.allSettled([
      reviews.setManagerMode(adminId, worker.id, "active"),
      reviews.setManagerMode(adminId, other.id, "active"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(0);
    for (const rejected of results as PromiseRejectedResult[]) expect(rejected.reason.message).toMatch(/shadow-only/i);
    const active = [await state(), await state(other.id)].filter(row => row.mode === "active");
    expect(active).toHaveLength(0);
    expect((await lease()).activeVaId).toBeNull();
    expect(await plans()).toEqual([]);
    expect(await plans(other.id)).toEqual([]);
  });

  it("retains one daily plan without duplicate writes after a service restart", async () => {
    await rejectActivation();
    await seedPlan();
    const applied = await service.runManager(worker.id);
    expect(applied.applied).toBe(false);
    const before = await plans();
    const beforeRuns = await runs();
    const calls = controls.model.mock.calls.length;
    vi.resetModules();
    const restarted = await import("./aptlssManagerService");
    const recovered = await restarted.runManager(worker.id, "scheduled");
    expect(await plans()).toEqual(before);
    expect(await plans()).toHaveLength(1);
    expect((await runs()).filter(run => run.appliedPlanHash)).toEqual(beforeRuns.filter(run => run.appliedPlanHash));
    const repeated = await restarted.runManager(worker.id, "scheduled");
    expect(repeated.runId).toBe(recovered.runId);
    expect(controls.model).toHaveBeenCalledTimes(calls);
  });

  it("rejects restoration and leaves the recorded plan and pilot lease unchanged", async () => {
    await rejectActivation();
    const prior = await seedPlan();
    const applied = await service.runManager(worker.id);
    expect(applied.applied).toBe(false);
    await expect(reviews.restoreManagerPlan(adminId, worker.id, applied.runId)).rejects.toThrow(/shadow-only/i);
    expect(JSON.parse((await plans())[0].scheduleJson)).toEqual(prior);
    expect((await state()).mode).toBe("shadow");
    expect((await lease()).activeVaId).toBeNull();
  });

  it("refuses rollback over a newer daily plan or a different worker's run", async () => {
    await rejectActivation();
    await seedPlan();
    const applied = await service.runManager(worker.id);
    const newer = { ...emptyPlan(), auditTrail: [{ at: NOW.toISOString(), action: "Worker correction", detail: "Newer protected plan" }] };
    await db.update(schema.dailyPlans).set({ scheduleJson: JSON.stringify(newer) }).where(eq(schema.dailyPlans.vaId, worker.id));
    await expect(reviews.restoreManagerPlan(adminId, worker.id, applied.runId)).rejects.toThrow(/shadow-only/i);
    const other = await insertWorker();
    await expect(reviews.restoreManagerPlan(adminId, other.id, applied.runId)).rejects.toThrow(/shadow-only/i);
    expect(JSON.parse((await plans())[0].scheduleJson)).toEqual(newer);
    expect(await plans(other.id)).toEqual([]);
  });

  it("rejects restoring a previous plan while a real active timer exists", async () => {
    await rejectActivation();
    await seedPlan();
    const applied = await service.runManager(worker.id);
    expect(applied.applied).toBe(false);
    expect(applied.proposal?.blocks.every(block => block.startTime > "10:00")).toBe(true);
    await db.insert(schema.timeEntries).values({ vaId: worker.id, founderId: adminId, taskId: worker.cardId,
      cardId: worker.cardId, startTime: NOW, planDateKey: DATE_KEY, planBlockId: applied.proposal!.blocks[0].id,
      aptlssStepId: worker.stepId });
    const before = await plans(), beforeState = await state(), beforeLease = await lease();
    const beforeTimers = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.vaId, worker.id));
    await expect(reviews.restoreManagerPlan(adminId, worker.id, applied.runId)).rejects.toThrow(/shadow-only/i);
    expect(await plans()).toEqual(before);
    expect(await state()).toEqual(beforeState);
    expect(await lease()).toEqual(beforeLease);
    expect(await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.vaId, worker.id))).toEqual(beforeTimers);
  });

  it("does not erase an executing plan when assigned planning input disappears", async () => {
    await rejectActivation();
    const prior = await seedPlan();
    await db.delete(schema.aptlssPlans).where(eq(schema.aptlssPlans.vaId, worker.id));
    const result = await service.runManager(worker.id);
    expect(result.applied).toBe(false);
    expect(result.policy.mode).toBe("shadow");
    expect(JSON.parse((await plans())[0].scheduleJson)).toEqual(prior);
    expect(result.sourceGaps).toContain("Automatic plan changes are paused because execution context coverage is incomplete.");
  });

  it("reports database unavailability without falling back to another database", async () => {
    const disconnectedPool = createPool({ uri: controls.url!, connectionLimit: 1, timezone: "Z" });
    await disconnectedPool.query("SELECT 1");
    const disconnected = drizzle(disconnectedPool, { schema, mode: "default" });
    await disconnectedPool.end();
    controls.db = disconnected;
    try {
      await expect(service.runManager(worker.id)).rejects.toThrow(/assessment failed/i);
      await expect(service.getManagerStatus(worker.id)).rejects.toThrow();
      controls.db = undefined;
      await expect(service.getManagerStatus(worker.id)).rejects.toThrow(/Database unavailable/);
      await expect(reviews.getManagerReviewInbox(adminId, worker.id)).rejects.toThrow(/Database unavailable/);
    } finally { controls.db = db; }
    expect(await runs()).toEqual([]);
    expect(await plans()).toEqual([]);
    expect(controls.model).not.toHaveBeenCalled();
  });

  it("atomically persists a proof-backed canonical conflict, decision evidence and resolved follow-up", async () => {
    const { resolveVerificationFollowup } = await import("./aptlssEvidenceGraphDb");
    const fixture = await seedGraphConflict();
    const before = await graphRows();
    const transaction = db.transaction.bind(db);
    let allWritesSeen = false;
    vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(async tx => {
      const result = await callback(tx);
      const [conflict] = await tx.select().from(schema.aptlssEvidenceConflicts).where(eq(schema.aptlssEvidenceConflicts.id, fixture.conflictId));
      const [followup] = await tx.select().from(schema.aptlssVerificationFollowups).where(eq(schema.aptlssVerificationFollowups.id, fixture.input.followupId));
      const decisions = await tx.select().from(schema.workspaceEvidenceItems)
        .where(like(schema.workspaceEvidenceItems.sourceId, `verified-conflict-resolution:${worker.id}:%`));
      allWritesSeen = conflict.status === "resolved" && followup.status === "resolved" && decisions.length === 1;
      await tx.execute(sql`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'integration proof rollback'`);
      return result;
    }));
    await expect(resolveVerificationFollowup(fixture.input)).rejects.toThrow();
    expect(allWritesSeen).toBe(true);
    expect(await graphRows()).toEqual(before);

    const result = await resolveVerificationFollowup(fixture.input);
    expect(result).toMatchObject({ followupId: fixture.input.followupId, resolvedAt: NOW, requiresEvidence: false });
    expect(result).toHaveProperty("decisionEvidenceId", expect.any(Number));
    const after = await graphRows();
    expect(after.conflicts[0]).toMatchObject({ status: "resolved", resolvedBy: String(adminId), resolvedAt: NOW });
    expect(after.followups[0]).toMatchObject({ status: "resolved", resolvedBy: String(adminId), resolvedAt: NOW });
    expect(after.followups[0].resolution).toBe(after.conflicts[0].resolution);
    expect(after.decisions).toHaveLength(1);
    const decision = after.decisions[0];
    expect(decision).toMatchObject({ kind: "verified_conflict_resolution", content: fixture.input.sourceQuote });
    const proof = { sourceEvidenceId: fixture.input.sourceEvidenceId, sourceRevisionId: fixture.sourceRevisionId,
      sourceRevisionHash: hash(fixture.input.sourceQuote), sourceQuote: fixture.input.sourceQuote,
      originalSourceEvidenceId: fixture.input.sourceEvidenceId, assertedEvidenceId: fixture.assertedEvidenceId };
    expect(JSON.parse(after.conflicts[0].resolution!)).toMatchObject({ decisionEvidenceId: decision.id, proof });
    expect(JSON.parse(decision.metadataJson!)).toMatchObject({ truthClass: "human_decision", proof });
    expect(after.revisions.find(revision => revision.evidenceId === decision.id)).toMatchObject({ truthClass: "source_record", content: fixture.input.sourceQuote });
    expect(after.links.find(link => link.evidenceId === decision.id)).toMatchObject({ vaId: worker.id, subjectId: worker.cardId, linkMethod: "confirmed" });
    expect(after.legacyLinks.find(link => link.evidenceId === decision.id)).toMatchObject({ cardId: worker.cardId });
    expect(after.items.filter(item => item.id !== decision.id)).toEqual(before.items);
    expect(after.revisions.filter(revision => revision.evidenceId !== decision.id)).toEqual(before.revisions);
    await expect(resolveVerificationFollowup(fixture.input)).rejects.toThrow(/no longer open/);
    expect(await graphRows()).toEqual(after);
  });

  it("rejects invalid source proof without changing any retained conflict, evidence, decision or follow-up", async () => {
    const { resolveVerificationFollowup } = await import("./aptlssEvidenceGraphDb");
    const fixture = await seedGraphConflict();
    const before = await graphRows();
    for (const invalid of [
      { sourceEvidenceId: fixture.input.sourceEvidenceId, sourceQuote: "Invoice A-12 is paid." },
      { sourceEvidenceId: fixture.assertedEvidenceId, sourceQuote: "Invoice A-12 is paid." },
      { sourceEvidenceId: fixture.input.sourceEvidenceId, sourceQuote: "unpaid" },
    ]) {
      await expect(resolveVerificationFollowup({ ...fixture.input, ...invalid })).rejects.toThrow();
      expect(await graphRows()).toEqual(before);
    }
    expect(before.conflicts[0].status).toBe("needs_verification");
    expect(before.followups[0].status).toBe("open");
    expect(before.decisions).toEqual([]);
  });

  it("rejects another worker's follow-up and source proof without cross-worker graph writes", async () => {
    const { resolveVerificationFollowup } = await import("./aptlssEvidenceGraphDb");
    const fixture = await seedGraphConflict();
    const other = await insertWorker();
    const foreign = await seedGraphConflict(other);
    const before = await graphRows(), foreignBefore = await graphRows(other);
    await expect(resolveVerificationFollowup({ ...fixture.input, vaId: other.id })).rejects.toThrow(/no longer open/);
    await expect(resolveVerificationFollowup({ ...fixture.input, sourceEvidenceId: foreign.input.sourceEvidenceId })).rejects.toThrow(/same worker and card/);
    expect(await graphRows()).toEqual(before);
    expect(await graphRows(other)).toEqual(foreignBefore);
  });

  it("keeps an old source conflict blocking work after 1501 newer unrelated graph records fill the evidence window", async () => {
    await rejectActivation();
    const fixture = await seedGraphConflict();
    const prefix = `manager-it-source:${randomUUID()}:`;
    const observedAt = new Date("2026-09-03T10:00:00Z");
    const rows = Array.from({ length: 1501 }, (_, index) => ({ vaId: worker.id, source: "google_drive" as const,
      sourceId: `${prefix}${index}`, title: "Unrelated local context", kind: "note", content: "Unrelated local context.",
      contentHash: hash(`${prefix}${index}`), observedAt, modifiedAt: observedAt,
      metadataJson: JSON.stringify({ essential: false, sourceDate: observedAt.toISOString() }) }));
    await db.insert(schema.workspaceEvidenceItems).values(rows);
    const inserted = await db.select({ id: schema.workspaceEvidenceItems.id }).from(schema.workspaceEvidenceItems)
      .where(like(schema.workspaceEvidenceItems.sourceId, `${prefix}%`));
    ownedEvidenceIds.push(...inserted.map(item => item.id));
    expect(inserted).toHaveLength(1501);
    await db.insert(schema.aptlssEvidenceSubjectLinks).values(inserted.map(item => ({ evidenceId: item.id, vaId: worker.id,
      subjectType: "card" as const, subjectId: worker.cardId, relevanceScore: 10, linkMethod: "confirmed" as const,
      matchReason: "Unrelated fixture context" })));
    // Fill both retention windows so the legacy join cannot accidentally rescue the old source.
    await db.insert(schema.workspaceEvidenceLinks).values(inserted.map(item => ({ evidenceId: item.id, cardId: worker.cardId,
      relevanceScore: 10, linkMethod: "manual" as const, matchReason: "Unrelated fixture context" })));

    const input = await service.collectManagerInput(db, worker.id, NOW);
    expect(input.executionCoverageComplete).toBe(false);
    const oldEvidenceIds = [`evidence:${fixture.input.sourceEvidenceId}:${worker.cardId}`, `evidence:${fixture.assertedEvidenceId}:${worker.cardId}`];
    expect(input.evidence.some(item => oldEvidenceIds.includes(item.id))).toBe(false);
    expect(input.graphConflicts).toEqual(expect.arrayContaining([expect.objectContaining({
      id: `graph:${fixture.conflictId}`, cardId: worker.cardId, evidenceIds: oldEvidenceIds,
      status: "needs_verification", severity: "urgent",
    })]));
    const result = await service.runManager(worker.id);
    expect(result.applied).toBe(false);
    expect(result.policy.mode).toBe("shadow");
    expect(result.assessments.find(item => item.cardId === worker.cardId)).toMatchObject({
      state: "NEEDS_VERIFICATION", reliability: { conflicts: "unresolved" },
    });
    const work = result.actions.filter(action => action.cardId === worker.cardId && action.kind === "work");
    expect(work.length).toBeGreaterThan(0);
    expect(work.every(action => action.blocked)).toBe(true);
    expect(result.interventions).toEqual(expect.arrayContaining([expect.objectContaining({ cardId: worker.cardId, severity: "urgent" })]));
    const stored = (await runs()).find(run => run.id === result.runId)!;
    expect(JSON.parse(stored.snapshotJson).assessments[0].reliability.conflicts).toBe("unresolved");
    expect(await plans()).toEqual([]);
  });

  it("enforces router authorization against real users before reaching manager mutations", async () => {
    const { operatorRouter } = await import("./operatorRouter");
    const user = (await db.select().from(schema.users).where(eq(schema.users.id, worker.id)))[0];
    const admin = (await db.select().from(schema.users).where(eq(schema.users.id, adminId)))[0];
    const context = (actor: schema.User | null) => ({ user: actor, req: {}, res: {} }) as TrpcContext;
    const anonymous = operatorRouter.createCaller(context(null));
    const workerCaller = operatorRouter.createCaller(context(user));
    const adminCaller = operatorRouter.createCaller(context(admin));
    await expect(anonymous.getManagerStatus()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(workerCaller.getManagerReviewInbox({ vaId: worker.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(workerCaller.setManagerMode({ vaId: worker.id, mode: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(workerCaller.recordManagerReview(reviewInput(1))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(workerCaller.restoreManagerPlan({ vaId: worker.id, runId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminCaller.runManager()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const status = await workerCaller.getManagerStatus();
    expect(status.policy.mode).toBe("shadow");
    const inbox = await adminCaller.getManagerReviewInbox({ vaId: worker.id });
    expect(inbox.workerId).toBe(worker.id);
    await expect(adminCaller.setManagerMode({ vaId: worker.id, mode: "active" })).rejects.toThrow(/shadow-only/i);
    expect(await runs()).toEqual([]);
    expect(await plans()).toEqual([]);
    expect((await state()).mode).toBe("shadow");
  });
});
