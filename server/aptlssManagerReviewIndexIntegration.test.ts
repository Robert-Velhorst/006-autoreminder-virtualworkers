import { readFileSync } from "node:fs";
import { Client } from "pg";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import { describe, expect, it } from "vitest";

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)("manager review index on real PostgreSQL", () => {
  it("backfills retained snapshots with actual migration expressions and supports legacy writes", async () => {
    const connectionString = requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production");
    const db = new Client({ connectionString, connectionTimeoutMillis: 10000 });
    await db.connect();
    const table = "aptlss_review_index_fixture";
    try {
      await db.query(`CREATE TEMP TABLE "${table}" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "vaId" integer NOT NULL, "proposalHash" varchar(64), mode text, "createdAt" timestamp DEFAULT now(), "snapshotJson" text NOT NULL)`);
      const snapshot = JSON.stringify({ implementationDigest: 'a'.repeat(64), interventions: [{ severity: 'urgent' }], evidence: 'retained '.repeat(10000) });
      await db.query(`INSERT INTO "${table}" ("vaId", "proposalHash", mode, "snapshotJson") VALUES (2, 'proposal', 'shadow', $1)`, [snapshot]);
      const migration = readFileSync(new URL('../drizzle-postgres-v1/0002_aptlss_reminder_manager_features.sql', import.meta.url), 'utf8');
      const digestDefinition = `"reviewDigest" varchar(64) GENERATED ALWAYS AS (("snapshotJson"::jsonb ->> 'implementationDigest')) STORED`;
      const urgentDefinition = `"reviewUrgent" boolean GENERATED ALWAYS AS (("snapshotJson"::jsonb @> '{"interventions":[{"severity":"urgent"}]}'::jsonb)) STORED`;
      for (const [name, expected] of [["reviewDigest", digestDefinition], ["reviewUrgent", urgentDefinition]]) {
        const definition = migration.split("\n").find(line => line.trimStart().startsWith(`"${name}" `));
        expect(definition?.trim().replace(/,$/, "")).toBe(expected);
      }
      // Execute literal DDL only after proving it matches the checked-in migration expressions.
      await db.query(`ALTER TABLE aptlss_review_index_fixture ADD COLUMN "reviewDigest" varchar(64) GENERATED ALWAYS AS (("snapshotJson"::jsonb ->> 'implementationDigest')) STORED`);
      await db.query(`ALTER TABLE aptlss_review_index_fixture ADD COLUMN "reviewUrgent" boolean GENERATED ALWAYS AS (("snapshotJson"::jsonb @> '{"interventions":[{"severity":"urgent"}]}'::jsonb)) STORED`);
      const index = migration.split('--> statement-breakpoint').find(statement => statement.includes('CREATE INDEX "aptlss_manager_runs_review_idx"'));
      expect(index?.trim()).toBe('CREATE INDEX "aptlss_manager_runs_review_idx" ON "aptlss_manager_runs" USING btree ("vaId","reviewDigest","proposalHash","mode","createdAt","id","reviewUrgent");');
      await db.query('CREATE INDEX aptlss_review_index_fixture_review_idx ON aptlss_review_index_fixture USING btree ("vaId","reviewDigest","proposalHash","mode","createdAt","id","reviewUrgent")');
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
