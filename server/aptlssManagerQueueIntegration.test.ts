import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import * as schema from "../drizzle/schema";
import {
  aptlssManagerQueue as jobs,
  aptlssManagerQueueEvents as events,
  aptlssManagerQueueSlots as slots,
} from "../drizzle/aptlssManagerQueueSchema";
import {
  enqueueManagerTask,
  claimManagerTask,
  renewManagerQueueLease,
  finishManagerTask,
  failManagerTask,
  assertManagerQueueLease,
  enqueueManagerFallback,
  createManagerQueueRunner,
  type ManagerQueueLease,
} from "./aptlssManagerQueue";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "manager queue real MySQL",
  { timeout: 30000, hookTimeout: 125000 },
  () => {
    let pool: Pool;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let lock: PoolConnection;
    let owned: number[] = [];
    beforeAll(async () => {
      const parsed = new URL(url!);
      if (
        parsed.protocol !== "mysql:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
        !["/aptlss_test", "/recovery_test"].includes(parsed.pathname) ||
        parsed.search ||
        parsed.hash
      )
        throw new Error(
          "Queue tests require the explicit loopback aptlss_test or recovery_test database."
        );
      pool = createPool({
        uri: url!,
        connectionLimit: 12,
        timezone: "Z",
        connectTimeout: 10000,
      });
      db = drizzle(pool, { schema, mode: "default" });
      lock = await pool.getConnection();
      const [rows] = await lock.query<any[]>(
        "SELECT GET_LOCK('aptlss-manager-integration-fixtures',120) AS acquired"
      );
      expect(rows[0].acquired).toBe(1);
      const occupied = await db
        .select()
        .from(jobs)
        .where(inArray(jobs.state, ["pending", "leased"]))
        .limit(1);
      const held = await db
        .select()
        .from(slots)
        .where(sql`${slots.vaId} IS NOT NULL`)
        .limit(1);
      if (occupied.length || held.length)
        throw new Error(
          "Queue fixtures require no unowned pending jobs or occupied slots; refusing to alter existing work."
        );
      expect(await db.select().from(slots)).toHaveLength(4);
      if (
        (
          await db
            .select()
            .from(schema.users)
            .where(eq(schema.users.role, "worker"))
            .limit(1)
        ).length
      )
        throw new Error(
          "Periodic queue fixtures require no unowned workers; refusing to enqueue unrelated work."
        );
    });
    async function worker(enabled = true) {
      const [row] = await db
        .insert(schema.users)
        .values({
          openId: `queue-test-${randomUUID()}`,
          name: "Queue test",
          role: "worker",
        })
        .$returningId();
      owned.push(row.id);
      vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", owned.join(","));
      await db
        .insert(schema.aptlssManagerState)
        .values({ vaId: row.id, enabled, mode: "shadow", intervalMinutes: 5 });
      return row.id;
    }
    beforeEach(() => {
      owned = [];
      vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
      vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("APTLSS_MANAGER_MODEL", "");
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      if (!owned.length) return;
      await db.transaction(async tx => {
        await tx
          .update(slots)
          .set({ vaId: null, token: null, leaseUntil: null })
          .where(inArray(slots.vaId, owned));
        await tx.delete(events).where(inArray(events.vaId, owned));
        await tx.delete(jobs).where(inArray(jobs.vaId, owned));
        await tx
          .delete(schema.aptlssManagerState)
          .where(inArray(schema.aptlssManagerState.vaId, owned));
        await tx
          .delete(schema.vaProfiles)
          .where(inArray(schema.vaProfiles.userId, owned));
        await tx.delete(schema.users).where(inArray(schema.users.id, owned));
      });
    });
    afterAll(async () => {
      if (lock) {
        await lock.query(
          "SELECT RELEASE_LOCK('aptlss-manager-integration-fixtures')"
        );
        lock.release();
      }
      if (pool) await pool.end();
    });
    const enqueue = (vaId: number, key: string, urgent = false) =>
      db.transaction(tx =>
        enqueueManagerTask(tx, {
          vaId,
          eventKey: key,
          trigger: urgent ? "conflict" : "source_ingested",
          urgent,
        })
      );
    const claim = (concurrency = 4) =>
      claimManagerTask(db, { concurrency, leaseMs: 60000 });
    const row = async (vaId: number) =>
      (await db.select().from(jobs).where(eq(jobs.vaId, vaId)))[0];
    async function expire(lease: ManagerQueueLease) {
      await db.transaction(async tx => {
        await tx
          .update(slots)
          .set({ leaseUntil: new Date("2000-01-01T00:00:00Z") })
          .where(eq(slots.id, lease.slotId));
        await tx
          .update(jobs)
          .set({ leaseUntil: new Date("2000-01-01T00:00:00Z") })
          .where(eq(jobs.vaId, lease.vaId));
      });
    }

    it("durably deduplicates identical events across completed jobs and coalesces distinct events", async () => {
      const id = await worker();
      expect(await enqueue(id, "a")).toEqual({ accepted: true });
      expect(await enqueue(id, "a")).toEqual({ accepted: false });
      await enqueue(id, "b");
      expect(await row(id)).toMatchObject({ generation: 2, state: "pending" });
      const lease = (await claim())!;
      await finishManagerTask(db, lease);
      expect(await enqueue(id, "a")).toEqual({ accepted: false });
      expect((await row(id)).state).toBe("idle");
    });
    it("rolls receipt and job back with the source transaction", async () => {
      const id = await worker();
      await expect(
        db.transaction(async tx => {
          await enqueueManagerTask(tx, {
            vaId: id,
            eventKey: "rollback",
            trigger: "worker_update",
          });
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");
      expect(await row(id)).toBeUndefined();
      expect(await enqueue(id, "rollback")).toEqual({ accepted: true });
    });
    it("coalesces concurrent duplicate receipts under default repeatable-read transactions",async()=>{
      const id=await worker();
      const results=await Promise.all(Array.from({length:8},()=>enqueue(id,"same-source-revision")));
      expect(results.filter(result=>result.accepted)).toHaveLength(1);
      expect((await row(id)).generation).toBe(1);
    });
    it("urgent work precedes normal backlog without preempting running work", async () => {
      const normal = await worker(),
        urgent = await worker();
      await enqueue(normal, "normal");
      await enqueue(urgent, "urgent", true);
      expect((await claim())!.vaId).toBe(urgent);
      expect((await claim())!.vaId).toBe(normal);
    });
    it("enforces global slots and per-worker exclusivity across competing claimers", async () => {
      const ids = await Promise.all(Array.from({ length: 6 }, () => worker()));
      for (const id of ids) await enqueue(id, "event");
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => claim(2))
      );
      const taken = claims.filter((l): l is ManagerQueueLease => !!l);
      expect(taken).toHaveLength(2);
      expect(new Set(taken.map(l => l.vaId)).size).toBe(2);
      await finishManagerTask(db, taken[0]);
      expect(await claim(2)).not.toBeNull();
    });
    it("coalesces burst events arriving during execution into a single follow-up", async () => {
      const id = await worker();
      await enqueue(id, "start");
      const first = (await claim())!;
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => enqueue(id, `dirty-${i}`, i === 9))
      );
      expect(await claim()).toBeNull();
      await finishManagerTask(db, first);
      expect(await row(id)).toMatchObject({
        state: "pending",
        generation: 11,
        priority: 100,
      });
      const next = (await claim())!;
      await finishManagerTask(db, next);
      expect(await claim()).toBeNull();
    });
    it("recovers expired leases after restart and fences obsolete owners", async () => {
      const id = await worker();
      await enqueue(id, "start");
      const first = (await claim())!;
      await expire(first);
      const next = (await claim())!;
      expect(next.token).not.toBe(first.token);
      await expect(
        db.transaction(tx => assertManagerQueueLease(tx, first))
      ).rejects.toThrow(/lease/i);
      expect(await finishManagerTask(db, first)).toBe(false);
      expect(await renewManagerQueueLease(db, first, 60000)).toBe(false);
      await db.transaction(tx => assertManagerQueueLease(tx, next));
    });
    it("checks enabled policy at claim and again when applying a leased result", async () => {
      const disabled = await worker(false);
      await enqueue(disabled, "disabled");
      expect(await claim()).toBeNull();
      await db
        .update(schema.aptlssManagerState)
        .set({ enabled: true })
        .where(eq(schema.aptlssManagerState.vaId, disabled));
      const lease = (await claim())!;
      await db
        .update(schema.aptlssManagerState)
        .set({ enabled: false })
        .where(eq(schema.aptlssManagerState.vaId, disabled));
      await expect(
        db.transaction(tx => assertManagerQueueLease(tx, lease))
      ).rejects.toThrow(/lease|enabled/i);
      expect(
        (
          await db
            .select()
            .from(schema.aptlssManagerState)
            .where(eq(schema.aptlssManagerState.vaId, disabled))
        )[0].mode
      ).toBe("shadow");
    });
    it("retries failed jobs with backoff, redacted errors and a durable retry ceiling", async () => {
      const id = await worker();
      await enqueue(id, "start");
      for (let n = 1; n <= 5; n++) {
        const lease = (await claim())!;
        expect(lease).toBeTruthy();
        await failManagerTask(db, lease);
        expect(JSON.stringify(await row(id))).not.toContain("secret");
        if (n < 5) {
          expect(await claim()).toBeNull();
          await db
            .update(jobs)
            .set({ availableAt: new Date("2000-01-01T00:00:00Z") })
            .where(eq(jobs.vaId, id));
        }
      }
      expect((await row(id)).state).toBe("failed");
      expect(await claim()).toBeNull();
      await enqueue(id, "new-input");
      expect(await claim()).not.toBeNull();
    });
    it("periodic fallback recovers due enabled workers but does not amplify pending jobs", async () => {
      const id = await worker(),
        disabled = await worker(false);
      expect(await enqueueManagerFallback(db)).toBe(1);
      expect(await enqueueManagerFallback(db)).toBe(0);
      expect((await row(id)).generation).toBe(1);
      expect(await row(disabled)).toBeUndefined();
    });
    it("dispatcher runs different workers concurrently within the configured bound", async () => {
      const ids = await Promise.all([worker(), worker(), worker()]);
      for (const id of ids) await enqueue(id, "run");
      let active = 0,
        max = 0,
        done = 0;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const runner = createManagerQueueRunner({
        db,
        concurrency: 2,
        execute: async () => {
          active++;
          max = Math.max(max, active);
          // Hold execution until both lanes start; SQL latency is not job duration.
          await gate;
          active--;
          done++;
        },
      });
      const draining = runner.drain();
      try {
        await expect.poll(() => active, { timeout: 5000 }).toBe(2);
        release();
        await draining;
        expect(max).toBe(2);
        expect(done).toBe(3);
        expect(
          (
            await db
              .select()
              .from(schema.aptlssManagerState)
              .where(inArray(schema.aptlssManagerState.vaId, ids))
          ).every(r => r.mode === "shadow")
        ).toBe(true);
      } finally {
        release();
        await draining;
        await runner.stop();
      }
    });
    it("a later poll fills a free lane while a slow worker remains active", async () => {
      const slow = await worker(),
        fast = await worker();
      await enqueue(slow, "slow");
      let release!: () => void;
      const gate = new Promise<void>(r => {
        release = r;
      });
      const started: number[] = [];
      const runner = createManagerQueueRunner({
        db,
        concurrency: 2,
        execute: async id => {
          started.push(id);
          if (id === slow) await gate;
        },
      });
      const first = runner.drain();
      try {
        await expect.poll(() => started.includes(slow)).toBe(true);
        await new Promise(r => setTimeout(r, 100));
        await enqueue(fast, "fast", true);
        void runner.drain();
        await expect
          .poll(() => started.includes(fast), { timeout: 2000 })
          .toBe(true);
      } finally {
        release();
        await first;
        await runner.stop();
      }
    });
    it("heartbeats keep a long-running job owned beyond its original expiry", async () => {
      const id = await worker();
      await enqueue(id, "heartbeat");
      let checked = false;
      const runner = createManagerQueueRunner({
        db,
        concurrency: 1,
        leaseMs: 1500,
        execute: async (_id, _trigger, lease) => {
          await new Promise(r => setTimeout(r, 2100));
          await db.transaction(tx => assertManagerQueueLease(tx, lease));
          expect(await claim(1)).toBeNull();
          checked = true;
        },
      });
      await runner.drain();
      await runner.stop();
      expect(checked).toBe(true);
      expect((await row(id)).state).toBe("idle");
    });
  }
);
