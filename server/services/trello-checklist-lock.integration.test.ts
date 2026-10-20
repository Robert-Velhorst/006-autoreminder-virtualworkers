import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../drizzle/schema.postgres";
import { requireIsolatedPostgresTestDatabase } from "../../shared/isolatedPostgresTestDatabase.mjs";

const controls = vi.hoisted(() => ({ db: undefined as NodePgDatabase<typeof schema> | undefined, fetch: vi.fn() }));
vi.mock("../db", () => ({ getDb: async () => controls.db }));
vi.mock("../utils/retry", () => ({ fetchWithRetry: controls.fetch }));
import { TrelloChecklistSyncService } from "./trello-checklist-sync";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("Trello checklist PostgreSQL transaction locks", () => {
  let pool: Pool;
  const applicationName = `checklist-lock-test-${randomUUID()}`;
  const gates: Array<() => void> = [];
  beforeAll(async () => {
    const connectionString = requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production");
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, application_name: applicationName });
    controls.db = drizzle(pool, { schema });
  });
  afterEach(() => { for (const release of gates.splice(0)) release(); vi.unstubAllEnvs(); controls.fetch.mockReset(); });
  afterAll(async () => { if (pool) await pool.end(); });

  it.each([false, true])("serializes independent services and releases the lock after provider failure=%s", async failFirst => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "");
    const cardId = `pg-lock-synthetic-${randomUUID()}`;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; gates.push(resolve); });
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const events: string[] = [];
    controls.fetch.mockImplementation(async () => {
      const index = events.filter(event => event.startsWith("enter-")).length;
      events.push(`enter-${index}`);
      if (index === 0) {
        entered(); await held;
        if (failFirst) { events.push("first-error"); throw new Error("synthetic provider failure"); }
      }
      events.push(`exit-${index}`);
      return { ok: true, json: async () => ({ id: `synthetic-checklist-${index}`, name: "Synthetic" }) };
    });
    const firstService = new TrelloChecklistSyncService({ apiKey: "synthetic", token: "synthetic" });
    const secondService = new TrelloChecklistSyncService({ apiKey: "synthetic", token: "synthetic" });
    const first = firstService.createChecklist(cardId, "Synthetic first");
    // Observe rejection immediately to avoid an unhandled rejection while the
    // second transaction waits for the real PostgreSQL lock.
    const settledFirst = first.then(value => ({ value }), error => ({ error }));
    await firstEntered;
    const second = secondService.createChecklist(cardId, "Synthetic second")
      .then(value => ({ value }), error => ({ error }));
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND application_name = $1 AND query LIKE '%pg_advisory_xact_lock%') AS blocked`, [applicationName]);
        if (result.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(events).toEqual(["enter-0"]);
    } finally { release(); }
    const outcome = await settledFirst;
    expect(await second).toMatchObject({ value: { id: "synthetic-checklist-1" } });
    if (failFirst) expect(outcome).toMatchObject({ error: { message: "synthetic provider failure" } });
    else expect(outcome).toMatchObject({ value: { id: "synthetic-checklist-0" } });
    expect(events).toEqual(failFirst
      ? ["enter-0", "first-error", "enter-1", "exit-1"]
      : ["enter-0", "exit-0", "enter-1", "exit-1"]);
  }, 15000);
});
