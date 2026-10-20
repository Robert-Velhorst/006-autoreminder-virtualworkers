import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import * as schema from "../drizzle/schema.postgres";
const controls = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("./db", () => ({ getDb: async () => controls.db }));
import { ATIS_JOB_KEYS, getActiveAtisOperations, getAtisOperation, startAtisOperation } from "./atisOperations";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("ATIS operations native PostgreSQL", { timeout: 20_000 }, () => {
  let pool: Pool;
  let admin: Pool;
  let created = false;
  const namespace = `atis_test_${randomUUID().replaceAll("-", "")}`;
  const gates: Array<() => void> = [];
  beforeAll(async () => {
    requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production");
    admin = new Pool({ connectionString: url!, connectionTimeoutMillis: 3000 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    created = true;
    for (const table of ["scheduled_job_runs", "scheduled_job_leases"]) {
      await admin.query(`CREATE TABLE "${namespace}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    pool = new Pool({ connectionString: url!, options: `-c search_path=${namespace}`, max: 6 });
    controls.db = drizzle(pool, { schema });
  });
  afterEach(async () => {
    for (const release of gates.splice(0)) release();
    await waitFor(async () => !(await getActiveAtisOperations()).some(op => op.state === "running")
      && Number((await pool.query('SELECT count(*) FROM scheduled_job_leases')).rows[0].count) === 0);
    await pool.query("TRUNCATE scheduled_job_runs, scheduled_job_leases RESTART IDENTITY");
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      try { if (created) await admin.query(`DROP SCHEMA "${namespace}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(accept => { resolve = accept; });
    gates.push(resolve);
    return { promise, resolve };
  }
  async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Operation did not settle");
  }
  const start = (work: Parameters<typeof startAtisOperation>[1], extra = {}) => startAtisOperation({ kind: "sync", ownerUserId: 2, ...extra }, work);

  it("durably records start before returning, and concurrent global duplicates invoke work once", async () => {
    const hold = gate();
    const work = vi.fn(async () => { await hold.promise; return { success: true, newCards: 1 }; });
    const operations = await Promise.all([start(work), start(work, { ownerUserId: 3 })]);
    expect(operations[0].id).toBe(operations[1].id);
    expect(await getAtisOperation(operations[0].id)).toMatchObject({ state: "running" });
    const { rows } = await pool.query("SELECT detail FROM scheduled_job_runs");
    expect(JSON.parse(rows[0].detail).ownerUserId).toBeGreaterThan(0);
    hold.resolve();
    await waitFor(async () => (await getAtisOperation(operations[0].id))?.state === "completed");
    expect(work).toHaveBeenCalledTimes(1);
    expect((await getAtisOperation(operations[0].id))?.result).toEqual({ success: true, newCards: 1 });
  });

  it("exposes interruption without replay, requires exact acknowledgement, and fences the old writer", async () => {
    const hold = gate(), entered = gate();
    const lateWrite = vi.fn();
    const operation = await start(async context => {
      entered.resolve(); await hold.promise;
      await controls.db.transaction(async (tx: any) => { await context.assertOwnership(tx); lateWrite(); });
      return { success: true };
    });
    await entered.promise;
    await pool.query("UPDATE scheduled_job_leases SET \"leaseExpiresAt\" = clock_timestamp() - interval '1 second'");
    expect(await getActiveAtisOperations()).toMatchObject([{ id: operation.id, state: "interrupted" }]);
    const replacement = vi.fn(async () => ({ success: true }));
    await expect(start(replacement)).rejects.toMatchObject({ operation: { id: operation.id } });
    await expect(start(replacement, { acknowledgeInterruptedOperationId: operation.id + 1 })).rejects.toThrow();
    expect(replacement).not.toHaveBeenCalled();
    const next = await start(replacement, { acknowledgeInterruptedOperationId: operation.id });
    expect(next.id).not.toBe(operation.id);
    hold.resolve();
    await waitFor(async () => (await getAtisOperation(next.id))?.state === "completed");
    expect((await getAtisOperation(operation.id))?.state).toBe("interrupted");
    expect(lateWrite).not.toHaveBeenCalled();
  });

  it("status database failures do not mark work failed or enqueue another run", async () => {
    const hold = gate();
    const operation = await start(async () => { await hold.promise; return { success: true }; });
    const realDb = controls.db;
    controls.db = undefined;
    await expect(getAtisOperation(operation.id)).rejects.toThrow("status unavailable");
    controls.db = realDb;
    expect((await getAtisOperation(operation.id))?.state).toBe("running");
    expect((await pool.query("SELECT id FROM scheduled_job_runs")).rows).toHaveLength(1);
    hold.resolve();
  });

  it("sanitizes execution failure and allows an explicit new POST, not a status read", async () => {
    const operation = await start(async () => { throw new Error("private provider token"); });
    await waitFor(async () => (await getAtisOperation(operation.id))?.state === "failed");
    expect(JSON.stringify(await getAtisOperation(operation.id))).not.toContain("private");
    expect((await pool.query("SELECT \"errorMessage\" FROM scheduled_job_runs")).rows[0].errorMessage).toBe("ATIS operation failed");
    expect(await getAtisOperation(operation.id + 1)).toBeNull();
    const next = await start(async () => ({ success: true }));
    expect(next.id).not.toBe(operation.id);
  });

  it("scopes status to ATIS keys and supports separate kinds", async () => {
    await pool.query("INSERT INTO scheduled_job_runs (\"jobKey\", trigger, status, \"startedAt\") VALUES ('unrelated', 'manual', 'running', clock_timestamp())");
    expect(await getAtisOperation(1)).toBeNull();
    const hold = gate();
    await start(async () => { await hold.promise; return { success: true }; });
    await startAtisOperation({ kind: "understanding", ownerUserId: 2 }, async () => { await hold.promise; return { processed: 1, failed: 0 }; });
    expect((await getActiveAtisOperations()).map(op => op.kind).sort()).toEqual(["sync", "understanding"]);
    expect(Object.values(ATIS_JOB_KEYS)).toHaveLength(2);
    hold.resolve();
  });

  it("coalesces only identical normalized requests and refuses different card or batch work", async () => {
    const hold = gate();
    const work = vi.fn(async () => { await hold.promise; return { success: true, cardId: 2 }; });
    const operation = await startAtisOperation({ kind: "understanding", ownerUserId: 2, request: { cardId: 2 } }, work);
    expect((await startAtisOperation({ kind: "understanding", ownerUserId: 3, request: { cardId: 2 } }, work)).id).toBe(operation.id);
    for (const request of [{ cardId: 3 }, { limit: 100 }, { limit: 50 }]) {
      await expect(startAtisOperation({ kind: "understanding", ownerUserId: 2, request }, work))
        .rejects.toMatchObject({ operation: { id: operation.id }, name: "Error" });
    }
    await expect(startAtisOperation({ kind: "understanding", ownerUserId: 2, request: { cardId: -1 } }, work)).rejects.toThrow("Invalid card ID");
    expect((await pool.query("SELECT id FROM scheduled_job_runs")).rows).toHaveLength(1);
    hold.resolve();
    await waitFor(async () => (await getAtisOperation(operation.id))?.state === "completed");
    expect(work).toHaveBeenCalledTimes(1);
  });
});
