import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import * as schema from "../drizzle/schema.postgres";

const controls = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("./db", () => ({ getDb: async () => controls.db }));
import { runScheduledJob } from "./scheduledJobRuntime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("scheduled job runtime real PostgreSQL ownership", { timeout: 30_000 }, () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const owned: string[] = [];
  const children: ChildProcess[] = [];
  const gates: Array<ReturnType<typeof deferred>> = [];
  const key = () => { const value = `job-runtime-test:${randomUUID()}`; owned.push(value); return value; };
  const gate = () => { const value = deferred(); gates.push(value); return value; };

  beforeAll(async () => {
    requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production");
    pool = new Pool({ connectionString: url!, max: 8, connectionTimeoutMillis: 10_000 });
    db = drizzle(pool, { schema });
    controls.db = db;
    const { rows: identity } = await pool.query("SELECT current_database() AS name, current_setting('server_version') AS version");
    expect(identity[0].name).toBe(new URL(url!).pathname.slice(1));
    expect(identity[0].version).toMatch(/^18\./);
    const { rows: tables } = await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('scheduled_job_leases', 'scheduled_job_runs')`);
    expect(tables).toHaveLength(2);
  });
  afterEach(async () => {
    vi.useRealTimers();
    controls.db = db;
    for (const wait of gates.splice(0)) wait.resolve();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill();
        await exited;
      }
    }
    if (owned.length) {
      await db.delete(schema.scheduledJobRuns).where(inArray(schema.scheduledJobRuns.jobKey, owned));
      await db.delete(schema.scheduledJobLeases).where(inArray(schema.scheduledJobLeases.jobKey, owned));
      owned.length = 0;
    }
  });
  afterAll(async () => { if (pool) await pool.end(); });

  async function history(jobKey: string) {
    return db.select().from(schema.scheduledJobRuns).where(eq(schema.scheduledJobRuns.jobKey, jobKey));
  }
  async function lease(jobKey: string) {
    return db.select().from(schema.scheduledJobLeases).where(eq(schema.scheduledJobLeases.jobKey, jobKey));
  }

  it("only invokes one callback while the same key is leased", async () => {
    const jobKey = key(), started = gate(), release = gate();
    const work = vi.fn(async () => { started.resolve(); await release.promise; return { recordsProcessed: 1 }; });
    const first = runScheduledJob({ jobKey }, work);
    try {
      await started.promise;
      expect(await runScheduledJob({ jobKey }, work)).toEqual({ state: "skipped", reason: "lease_held" });
    } finally { release.resolve(); await first; }
    expect(work).toHaveBeenCalledTimes(1);
    expect((await history(jobKey)).map(row => row.status)).toEqual(["success"]);
    expect(await lease(jobKey)).toHaveLength(0);
  });

  it("rechecks completed work after a stale preflight but before invoking its callback", async () => {
    const jobKey = key(), stale = gate(), release = gate();
    controls.db = new Proxy(db, { get(target, property) {
      if (property === "insert") return (...args: Parameters<typeof target.insert>) => {
        const operation = target.insert(...args);
        return new Proxy(operation, { get(insert, key) {
          if (key === "values") return (...values: unknown[]) => {
            const query = (insert.values as (...v: unknown[]) => any)(...values);
            return new Proxy(query, { get(builder, field) {
              if (field === "onConflictDoUpdate") return (configuration: unknown) => ({ then: async (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                stale.resolve(); await release.promise;
                return builder.onConflictDoUpdate(configuration).then(resolve, reject);
              } });
              const value = Reflect.get(builder, field); return typeof value === "function" ? value.bind(builder) : value;
            } });
          };
          const value = Reflect.get(insert, key); return typeof value === "function" ? value.bind(insert) : value;
        } });
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const work = vi.fn(async () => ({ recordsProcessed: 1 }));
    const lagging = runScheduledJob({ jobKey }, work);
    try {
      await stale.promise;
      controls.db = db;
      expect((await runScheduledJob({ jobKey }, work)).state).toBe("success");
    } finally { release.resolve(); }
    expect(await lagging).toEqual({ state: "skipped", reason: "already_succeeded" });
    expect(work).toHaveBeenCalledTimes(1);
    expect(await history(jobKey)).toHaveLength(1);
    expect(await lease(jobKey)).toHaveLength(0);
  });

  it("does not let a server with a fast application clock steal an unexpired lease", async () => {
    const jobKey = key(), started = gate(), release = gate();
    const first = runScheduledJob({ jobKey }, async () => { started.resolve(); await release.promise; });
    try {
      await started.promise;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const work = vi.fn(async () => undefined);
      expect(await runScheduledJob({ jobKey }, work)).toEqual({ state: "skipped", reason: "lease_held" });
      expect(work).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); release.resolve(); await first; }
  });

  it("allows takeover of an expired lease", async () => {
    const jobKey = key();
    await db.insert(schema.scheduledJobLeases).values({ jobKey, ownerToken: "expired-test-owner",
      acquiredAt: new Date("2000-01-01Z"), heartbeatAt: new Date("2000-01-01Z"), leaseExpiresAt: new Date("2000-01-01Z") });
    expect((await runScheduledJob({ jobKey }, async () => ({ recordsProcessed: 2 }))).state).toBe("success");
    expect(await lease(jobKey)).toHaveLength(0);
  });

  it.each(["stolen", "expired"])("refuses successful completion after its lease is %s", async change => {
    const jobKey = key();
    const result = runScheduledJob({ jobKey }, async () => {
      await db.update(schema.scheduledJobLeases).set(change === "stolen"
        ? { ownerToken: "replacement-test-owner" } : { leaseExpiresAt: new Date("2000-01-01Z") })
        .where(eq(schema.scheduledJobLeases.jobKey, jobKey));
      return { recordsProcessed: 99 };
    });
    await expect(result).rejects.toThrow(/lease/i);
    expect((await history(jobKey)).map(row => row.status)).toEqual(["error"]);
    if (change === "stolen") expect((await lease(jobKey))[0]?.ownerToken).toBe("replacement-test-owner");
    else expect(await lease(jobKey)).toHaveLength(0);
  });

  it("releases the acquired lease if creating its run record fails", async () => {
    const jobKey = key();
    controls.db = new Proxy(db, { get(target, property) {
      if (property === "transaction") return (work: (tx: unknown) => unknown) => target.transaction(async tx => work(
        new Proxy(tx, { get(target, property) {
          if (property === "insert") return () => ({ values: () => ({ returning: async () => { throw new Error("Synthetic run record failure"); } }) });
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        } }),
      ));
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const work = vi.fn(async () => undefined);
    await expect(runScheduledJob({ jobKey }, work)).rejects.toThrow("Synthetic run record failure");
    expect(work).not.toHaveBeenCalled();
    expect(await lease(jobKey)).toHaveLength(0);
    expect(await history(jobKey)).toHaveLength(0);
  });

  it("records failures and allows an explicit retry without erasing history", async () => {
    const jobKey = key();
    await expect(runScheduledJob({ jobKey }, async () => { throw new Error("Synthetic task failure"); }))
      .rejects.toThrow("Synthetic task failure");
    expect(await lease(jobKey)).toHaveLength(0);
    expect((await runScheduledJob({ jobKey }, async () => ({ recordsProcessed: 3 }))).state).toBe("success");
    expect((await history(jobKey)).map(row => row.status).sort()).toEqual(["error", "success"]);
  });

  it("can deliberately repeat successful maintenance while retaining per-run history", async () => {
    const jobKey = key(), work = vi.fn(async () => undefined);
    await runScheduledJob({ jobKey, skipIfSuccessful: false }, work);
    await runScheduledJob({ jobKey, skipIfSuccessful: false }, work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(await history(jobKey)).toHaveLength(2);
  });

  it("checks periodic eligibility under ownership before creating run history", async () => {
    const jobKey = key(), work = vi.fn(async () => undefined);
    const shouldRun = vi.fn(async context => {
      await context.assertOwnership();
      expect((await lease(jobKey))).toHaveLength(1);
      return false;
    });
    expect(await runScheduledJob({ jobKey, skipIfSuccessful: false, shouldRun }, work))
      .toEqual({ state: "skipped", reason: "not_due" });
    expect(shouldRun).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    expect(await history(jobKey)).toHaveLength(0);
    expect(await lease(jobKey)).toHaveLength(0);
  });

  it("rejects ownership lost during a periodic eligibility check before work", async () => {
    const jobKey = key(), work = vi.fn(async () => undefined);
    await expect(runScheduledJob({ jobKey, shouldRun: async (_context, tx) => {
      await tx.update(schema.scheduledJobLeases).set({ ownerToken: "replacement-test-owner" })
        .where(eq(schema.scheduledJobLeases.jobKey, jobKey));
      return true;
    } }, work)).rejects.toThrow(/lease/i);
    expect(work).not.toHaveBeenCalled();
    expect(await history(jobKey)).toHaveLength(0);
    expect(await lease(jobKey)).toHaveLength(0);
  });

  it("uses one pool connection for eligibility and transactional ownership checkpoints", async () => {
    const singlePool = new Pool({ connectionString: url!, max: 1, connectionTimeoutMillis: 5_000 });
    const singleDb = drizzle(singlePool, { schema });
    const jobKey = key();
    controls.db = singleDb;
    try {
      const result = await runScheduledJob({ jobKey, shouldRun: async context => {
        await context.assertOwnership();
        return true;
      } }, async context => {
        await singleDb.transaction(async tx => {
          await context.assertOwnership(tx);
          await tx.select().from(schema.scheduledJobRuns).where(eq(schema.scheduledJobRuns.jobKey, jobKey));
          await context.assertOwnership(tx);
        });
        return { recordsProcessed: 1 };
      });
      expect(result).toMatchObject({ state: "success", recordsProcessed: 1 });
      expect((await history(jobKey)).map(row => row.status)).toEqual(["success"]);
      expect(await lease(jobKey)).toHaveLength(0);
    } finally { controls.db = db; await singlePool.end(); }
  });

  it("rolls back a claimed periodic schedule when recording its run fails", async () => {
    const jobKey = key(), settingKey = `test-schedule:${randomUUID()}`;
    await db.insert(schema.appSettings).values({ key: settingKey, value: "not_started" });
    controls.db = new Proxy(db, { get(target, property) {
      if (property === "transaction") return (work: (tx: unknown) => unknown) => target.transaction(async tx => work(
        new Proxy(tx, { get(target, property) {
          if (property === "insert") return () => ({ values: () => ({ returning: async () => { throw new Error("Synthetic run record failure"); } }) });
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        } }),
      ));
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const work = vi.fn(async () => undefined);
    try {
      await expect(runScheduledJob({ jobKey, shouldRun: async (context, tx) => {
        await context.assertOwnership();
        await tx.update(schema.appSettings).set({ value: "started" }).where(eq(schema.appSettings.key, settingKey));
        return true;
      } }, work)).rejects.toThrow("Synthetic run record failure");
      expect(work).not.toHaveBeenCalled();
      expect((await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, settingKey)))[0].value).toBe("not_started");
      expect(await history(jobKey)).toHaveLength(0);
      expect(await lease(jobKey)).toHaveLength(0);
    } finally { controls.db = db; await db.delete(schema.appSettings).where(eq(schema.appSettings.key, settingKey)); }
  });

  it("retains ownership through a transaction commit against a competing owner", async () => {
    const jobKey = key();
    let competing: Promise<unknown> | undefined;
    let changed = false;
    await expect(runScheduledJob({ jobKey }, async context => {
      await db.transaction(async tx => {
        await context.assertOwnership(tx);
        competing = db.update(schema.scheduledJobLeases).set({ ownerToken: "replacement-test-owner" })
          .where(eq(schema.scheduledJobLeases.jobKey, jobKey)).then(result => { changed = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(changed).toBe(false);
        await context.assertOwnership(tx);
      });
      await competing;
      expect(changed).toBe(true);
      await context.assertOwnership();
    })).rejects.toThrow(/lease/i);
    if (competing) await competing;
    expect((await history(jobKey)).map(row => row.status)).toEqual(["error"]);
    expect((await lease(jobKey))[0]?.ownerToken).toBe("replacement-test-owner");
  });

  it("does not repeat a periodic job after a stale eligibility snapshot", async () => {
    const jobKey = key(), stale = gate(), release = gate();
    let due = true;
    controls.db = new Proxy(db, { get(target, property) {
      if (property === "insert") return (...args: Parameters<typeof target.insert>) => {
        const operation = target.insert(...args);
        return new Proxy(operation, { get(insert, key) {
          if (key === "values") return (...values: unknown[]) => {
            const query = (insert.values as (...v: unknown[]) => any)(...values);
            return new Proxy(query, { get(builder, field) {
              if (field === "onConflictDoUpdate") return (configuration: unknown) => ({ then: async (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                stale.resolve(); await release.promise;
                return builder.onConflictDoUpdate(configuration).then(resolve, reject);
              } });
              const value = Reflect.get(builder, field); return typeof value === "function" ? value.bind(builder) : value;
            } });
          };
          const value = Reflect.get(insert, key); return typeof value === "function" ? value.bind(insert) : value;
        } });
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const work = vi.fn(async () => { due = false; return { recordsProcessed: 1 }; });
    const input = { jobKey, skipIfSuccessful: false, shouldRun: async () => due };
    const lagging = runScheduledJob(input, work);
    try {
      await stale.promise;
      controls.db = db;
      expect((await runScheduledJob(input, work)).state).toBe("success");
    } finally { release.resolve(); }
    expect(await lagging).toEqual({ state: "skipped", reason: "not_due" });
    expect(work).toHaveBeenCalledTimes(1);
    expect(await history(jobKey)).toHaveLength(1);
    expect(await lease(jobKey)).toHaveLength(0);
  });

  it("renews a live lease using database time", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const jobKey = key();
    await runScheduledJob({ jobKey, leaseMs: 30_000 }, async context => {
      await db.update(schema.scheduledJobLeases).set({ heartbeatAt: new Date("2000-01-01Z") })
        .where(eq(schema.scheduledJobLeases.jobKey, jobKey));
      await vi.advanceTimersByTimeAsync(10_000);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await lease(jobKey))[0]?.heartbeatAt.getFullYear() !== 2000) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect((await lease(jobKey))[0]?.heartbeatAt.getFullYear()).not.toBe(2000);
      expect(context.signal.aborted).toBe(false);
      await context.assertOwnership();
    });
  });

  it("signals cancellation after a heartbeat discovers ownership was lost", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const jobKey = key(), sideEffect = vi.fn();
    await expect(runScheduledJob({ jobKey, leaseMs: 30_000 }, async context => {
      await db.update(schema.scheduledJobLeases).set({ ownerToken: "replacement-test-owner" })
        .where(eq(schema.scheduledJobLeases.jobKey, jobKey));
      await vi.advanceTimersByTimeAsync(10_000);
      for (let attempt = 0; attempt < 100 && !context.signal.aborted; attempt++)
        await new Promise(resolve => setTimeout(resolve, 10));
      expect(context.signal.aborted).toBe(true);
      await context.assertOwnership();
      sideEffect();
    })).rejects.toThrow(/lease/i);
    expect(sideEffect).not.toHaveBeenCalled();
    expect((await lease(jobKey))[0]?.ownerToken).toBe("replacement-test-owner");
  });

  it.each([NaN, Infinity, -Infinity])("rejects invalid lease durations without creating work", async leaseMs => {
    const jobKey = key(), work = vi.fn(async () => undefined);
    await expect(runScheduledJob({ jobKey, leaseMs }, work)).rejects.toThrow(/finite/);
    expect(work).not.toHaveBeenCalled();
    expect(await lease(jobKey)).toHaveLength(0);
    expect(await history(jobKey)).toHaveLength(0);
  });

  function processWorker(jobKey: string) {
    const child = fork(fileURLToPath(new URL("./fixtures/scheduled-job-process.ts", import.meta.url)), [jobKey], {
      execArgv: ["--import", "tsx"], silent: true,
      env: { ...process.env, DATABASE_URL: url, APTLSS_TEST_DATABASE_URL: url,
        NODE_ENV: "test", OPENAI_API_KEY: "", TRELLO_API_KEY: "", TRELLO_TOKEN: "", NOTIFICATIONS_ENABLED: "false" },
    });
    children.push(child);
    const messages: any[] = [];
    let wake: (() => void) | undefined;
    child.on("message", message => { messages.push(message); wake?.(); });
    const exited = new Promise<number | null>(resolve => child.once("exit", code => { resolve(code); wake?.(); }));
    child.once("error", () => wake?.());
    return { child, exited, async waitFor(type: string) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const message = messages.find(message => message.type === type);
        if (message) return message;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("Synthetic worker exited before its checkpoint");
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); wake = () => { clearTimeout(timer); resolve(); }; });
      }
      throw new Error(`Synthetic worker did not reach ${type}`);
    } };
  }

  it("shares ownership and completed-run deduplication between separate Node processes", async () => {
    const jobKey = key(), first = processWorker(jobKey);
    await first.waitFor("ready"); first.child.send("start"); await first.waitFor("work_started");
    const second = processWorker(jobKey);
    await second.waitFor("ready"); second.child.send("start");
    expect((await second.waitFor("result")).result).toEqual({ state: "skipped", reason: "lease_held" });
    expect(await second.exited).toBe(0);
    first.child.send("release");
    expect((await first.waitFor("result")).result.state).toBe("success");
    expect(await first.exited).toBe(0);
    const restarted = processWorker(jobKey);
    await restarted.waitFor("ready"); restarted.child.send("start");
    expect((await restarted.waitFor("result")).result).toEqual({ state: "skipped", reason: "already_succeeded" });
    expect(await restarted.exited).toBe(0);
    expect((await history(jobKey)).map(row => row.status)).toEqual(["success"]);
  });

  it("recovers an interrupted process only after lease expiry and preserves its abandoned run", async () => {
    const jobKey = key(), interrupted = processWorker(jobKey);
    await interrupted.waitFor("ready"); interrupted.child.send("start"); await interrupted.waitFor("work_started");
    interrupted.child.kill("SIGKILL"); await interrupted.exited;
    expect(await runScheduledJob({ jobKey }, async () => undefined)).toEqual({ state: "skipped", reason: "lease_held" });
    await db.update(schema.scheduledJobLeases).set({ leaseExpiresAt: new Date("2000-01-01Z") })
      .where(eq(schema.scheduledJobLeases.jobKey, jobKey));
    const restarted = processWorker(jobKey);
    await restarted.waitFor("ready"); restarted.child.send("start"); await restarted.waitFor("work_started");
    restarted.child.send("release");
    expect((await restarted.waitFor("result")).result.state).toBe("success");
    expect(await restarted.exited).toBe(0);
    expect((await history(jobKey)).map(row => row.status).sort()).toEqual(["abandoned", "success"]);
    expect(await lease(jobKey)).toHaveLength(0);
  });
});
