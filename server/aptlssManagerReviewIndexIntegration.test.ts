import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import { describe, expect, it } from "vitest";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("manager review index on real PostgreSQL", () => {
  it("backfills retained snapshots with actual migration expressions and supports legacy writes", async () => {
    const connectionString = requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production");
    const db = new Client({ connectionString, connectionTimeoutMillis: 10000 });
    await db.connect();
    const table = `review_index_test_${randomBytes(8).toString('hex')}`;
    try {
      await db.query(`CREATE TABLE "${table}" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "vaId" integer NOT NULL, "proposalHash" varchar(64), mode text, "createdAt" timestamp DEFAULT now(), "snapshotJson" text NOT NULL)`);
      const snapshot = JSON.stringify({ implementationDigest: 'a'.repeat(64), interventions: [{ severity: 'urgent' }], evidence: 'retained '.repeat(10000) });
      await db.query(`INSERT INTO "${table}" ("vaId", "proposalHash", mode, "snapshotJson") VALUES (2, 'proposal', 'shadow', $1)`, [snapshot]);
      const migration = readFileSync(new URL('../drizzle-postgres-v1/0002_aptlss_reminder_manager_features.sql', import.meta.url), 'utf8');
      for (const name of ['reviewDigest', 'reviewUrgent']) {
        const definition = migration.split('\n').find(line => line.trimStart().startsWith(`"${name}" `));
        expect(definition).toBeDefined();
        await db.query(`ALTER TABLE "${table}" ADD COLUMN ${definition!.trim().replace(/,$/, '')}`);
      }
      const index = migration.split('--> statement-breakpoint').find(statement => statement.includes('CREATE INDEX "aptlss_manager_runs_review_idx"'));
      expect(index).toBeDefined();
      await db.query(index!.replaceAll('aptlss_manager_runs', table));
      const { rows } = await db.query(`SELECT "snapshotJson", "reviewDigest", "reviewUrgent" FROM "${table}"`);
      expect(rows[0]).toEqual({ snapshotJson: snapshot, reviewDigest: 'a'.repeat(64), reviewUrgent: true });
      await db.query(`INSERT INTO "${table}" ("vaId", "proposalHash", mode, "snapshotJson") VALUES (3, 'proposal', 'shadow', $1)`, [JSON.stringify({ interventions: [] })]);
      const { rows: legacy } = await db.query(`SELECT "reviewDigest", "reviewUrgent" FROM "${table}" WHERE "vaId"=3`);
      expect(legacy[0]).toEqual({ reviewDigest: null, reviewUrgent: false });
      // This small fixture otherwise rationally chooses a sequential scan.
      await db.query('SET enable_seqscan = off');
      const { rows: plans } = await db.query(`EXPLAIN (FORMAT JSON) SELECT "proposalHash", bool_or("reviewUrgent") FROM "${table}" WHERE "vaId"=2 AND "reviewDigest"=$1 GROUP BY "proposalHash"`, ['a'.repeat(64)]);
      expect(JSON.stringify(plans)).toContain(`${table}_review_idx`);
    } finally {
      await db.query(`DROP TABLE IF EXISTS "${table}"`);
      await db.end();
    }
  }, 30000);
});
