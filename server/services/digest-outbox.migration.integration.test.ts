import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool, escapeIdentifier } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { requireIsolatedPostgresTestDatabase } from "../../shared/isolatedPostgresTestDatabase.mjs";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("digest outbox additive migration", () => {
  it("preserves legacy jobs and notifications without inventing delivery membership", async () => {
    const base = new URL(requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production"));
    const name = `digest_migration_${randomUUID().replaceAll("-", "")}`;
    const assertOwnedName = () => {
      if (!/^digest_migration_[a-f0-9]{32}$/.test(name) || name === base.pathname.slice(1)) throw new Error("Unsafe migration fixture database name");
    };
    assertOwnedName();
    const admin = new Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
    let pool: Pool | undefined;
    let created = false;
    let directory: string | undefined;
    try {
      await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
      created = true;
      const connection = new URL(base.href);
      connection.pathname = `/${name}`;
      pool = new Pool({ connectionString: connection.href, max: 2, connectionTimeoutMillis: 5000 });
      const db = drizzle(pool);
      const canonical = path.resolve(import.meta.dirname, "../../drizzle-postgres-v1");
      const journal = JSON.parse(await readFile(path.join(canonical, "meta/_journal.json"), "utf8"));
      const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0005_durable_digest_outbox");
      expect(index).toBeGreaterThan(0);
      directory = await mkdtemp(path.join(tmpdir(), "digest-migration-baseline-"));
      await mkdir(path.join(directory, "meta"));
      await writeFile(path.join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }));
      for (const entry of journal.entries.slice(0, index)) {
        await copyFile(path.join(canonical, `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
      }
      await migrate(db, { migrationsFolder: directory });
      await pool.query(`INSERT INTO digest_jobs ("userOpenId", "scheduledFor", status, "notificationCount", error)
        VALUES ('legacy-recipient', '2026-10-20 09:00:00', 'completed', 2, NULL),
               ('legacy-recipient', '2026-10-21 09:00:00', 'processing', 1, 'Retained legacy outcome')`);
      await pool.query(`INSERT INTO notification_history ("userId", "userOpenId", title, content, "notificationType", channel, "deliveryStatus")
        VALUES (21, 'legacy-recipient', 'Unsent backlog', 'Retained notification', 'general', 'email', 'queued_for_digest'),
               (21, 'legacy-recipient', 'Earlier notice', 'Retained accepted notification', 'general', 'email', 'sent')`);
      const oldColumns = 'id, "userOpenId", "scheduledFor", status, "notificationCount", error, "completedAt", "createdAt"';
      const beforeJobs = (await pool.query(`SELECT ${oldColumns} FROM digest_jobs ORDER BY id`)).rows;
      const beforeNotifications = (await pool.query("SELECT * FROM notification_history ORDER BY id")).rows;
      await migrate(db, { migrationsFolder: canonical });
      expect((await pool.query(`SELECT ${oldColumns} FROM digest_jobs ORDER BY id`)).rows).toEqual(beforeJobs);
      expect((await pool.query("SELECT * FROM notification_history ORDER BY id")).rows).toEqual(beforeNotifications);
      expect((await pool.query('SELECT "windowKey", "deliveryPhase", "attemptCount" FROM digest_jobs ORDER BY id')).rows)
        .toEqual([{ windowKey: null, deliveryPhase: null, attemptCount: 0 }, { windowKey: null, deliveryPhase: null, attemptCount: 0 }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM digest_job_items")).rows[0].count).toBe(0);
      const constraints = await pool.query(`SELECT count(*)::int AS count FROM pg_constraint
        WHERE conrelid = 'digest_job_items'::regclass AND contype = 'f'`);
      expect(constraints.rows[0].count).toBe(2);
      await migrate(db, { migrationsFolder: canonical });
      expect((await pool.query(`SELECT ${oldColumns} FROM digest_jobs ORDER BY id`)).rows).toEqual(beforeJobs);
      expect((await pool.query("SELECT count(*)::int AS count FROM digest_job_items")).rows[0].count).toBe(0);
    } finally {
      try {
        if (pool) await pool.end();
        if (created) {
          assertOwnedName();
          await admin.query(`DROP DATABASE ${escapeIdentifier(name)}`);
        }
      } finally {
        await admin.end();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
