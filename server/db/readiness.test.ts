import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { scheduledJobs } from "../../drizzle/schema.postgres";
import {
  hasRequiredPostgresSchema,
  READINESS_QUERY_TIMEOUT_MS,
  REQUIRED_POSTGRES_MIGRATION,
  type ReadinessPool,
} from "./readiness";

function poolReturning(requiredMigrationApplied: boolean): ReadinessPool {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [{ required_migration_applied: requiredMigrationApplied }],
    }),
  };
}

describe("PostgreSQL readiness probe", () => {
  it('adds nullable approval evidence with explicit all-null or all-present guards and no historical row rewrite', async () => {
    const migration = await readFile(new URL('../../drizzle-postgres-v1/0012_scheduled_generation_approval.sql', import.meta.url), 'utf8');
    expect(migration).not.toContain('\r');
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|DROP|DEFAULT|REFERENCES)\b/i);
    expect(migration.match(/ALTER TABLE/g)).toHaveLength(5);
    for (const [name, type] of Object.entries({ approvedByUserId: 'integer', approvedSessionEpoch: 'bigint',
      approvedAt: 'timestamp', approvalHash: 'varchar(64)' })) {
      expect(migration).toContain(`ALTER TABLE "scheduled_jobs" ADD COLUMN "${name}" ${type};`);
      expect(migration).toContain(`"scheduled_jobs"."${name}" IS NULL`);
      expect(migration).toContain(`"scheduled_jobs"."${name}" IS NOT NULL`);
    }
    expect(migration).toContain('ADD CONSTRAINT "scheduled_jobs_approval_complete" CHECK');
    expect(migration).toContain(') OR (');
    expect(migration).toContain('"approvedByUserId" > 0');
    expect(migration).toContain('"approvedSessionEpoch" >= 0');
    expect(migration).toContain("\"approvalHash\" ~ '^[0-9a-fA-F]{64}$'");
  });

  it('changes only scheduled approval metadata relative to the previous snapshot and retains the historical migration hash', async () => {
    const previous = JSON.parse(await readFile(new URL('../../drizzle-postgres-v1/meta/0011_snapshot.json', import.meta.url), 'utf8'));
    const next = JSON.parse(await readFile(new URL('../../drizzle-postgres-v1/meta/0012_snapshot.json', import.meta.url), 'utf8'));
    expect(next.prevId).toBe(previous.id);
    expect(Object.keys(next.tables)).toEqual(Object.keys(previous.tables));
    for (const [name, table] of Object.entries(previous.tables)) {
      if (name !== 'public.scheduled_jobs') expect(next.tables[name]).toEqual(table);
    }
    const scheduled = structuredClone(next.tables['public.scheduled_jobs']);
    for (const [name, type] of Object.entries({ approvedByUserId: 'integer', approvedSessionEpoch: 'bigint',
      approvedAt: 'timestamp', approvalHash: 'varchar(64)' })) {
      expect(scheduled.columns[name]).toMatchObject({ type, notNull: false });
      expect(scheduled.columns[name].default).toBeUndefined();
      delete scheduled.columns[name];
    }
    expect(scheduled.checkConstraints.scheduled_jobs_approval_complete).toBeDefined();
    delete scheduled.checkConstraints.scheduled_jobs_approval_complete;
    expect(scheduled).toEqual(previous.tables['public.scheduled_jobs']);
    const previousSql = await readFile(new URL('../../drizzle-postgres-v1/0011_generation_status_width.sql', import.meta.url), 'utf8');
    expect(createHash('sha256').update(previousSql.replace(/\r\n/g, '\n')).digest('hex'))
      .toBe('e2afb582f3efee81a95f5fffadbe6a4929a94aa176d90f24d9bee0b373a64a1e');
  });

  it('reuses exact string bigint epoch encoding without JavaScript number rounding', () => {
    const epoch = scheduledJobs.approvedSessionEpoch;
    for (const value of ['0', '9007199254740993', '9223372036854775807']) {
      expect(epoch.mapToDriverValue(value)).toBe(value);
      expect(epoch.mapFromDriverValue(value)).toBe(value);
    }
    for (const value of ['-1', '01', '1.5', '9223372036854775808']) {
      expect(() => epoch.mapToDriverValue(value)).toThrow('Invalid session epoch');
    }
    expect(epoch.notNull).toBe(false);
  });

  it('widens generation terminal status columns additively without rewriting history', async () => {
    const migration = await readFile(new URL('../../drizzle-postgres-v1/0011_generation_status_width.sql', import.meta.url), 'utf8');
    for (const table of ['generation_jobs', 'scheduled_jobs']) {
      expect(migration).toContain(`ALTER TABLE "${table}" ALTER COLUMN "status" SET DATA TYPE varchar(32)`);
    }
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|DROP)\b/i);
    expect('completed_with_errors'.length).toBeGreaterThan(20);
  });
  it('requires exact financial uniqueness and fails closed on legacy duplicate identity', async () => {
    const pool = poolReturning(true);
    await hasRequiredPostgresSchema(pool);
    const query = vi.mocked(pool.query).mock.calls[0][0].text;
    expect(query).toContain('payment_cycles_founder_dates_unique');
    expect(query).toContain('weekly_pay_log_founder_worker_week_unique');
    expect(query).toContain('financial_ledger_events_founder_key_unique');
    expect(query).toContain('payment_cycles_predecessor_unique');
    expect(query).toContain('atis_analysis_owner_request_key_unique');
    expect(query).toContain('atis_analysis_request_card_unique');
    expect(query).toContain('GROUP BY "founderId", "vaId", "weekStart" HAVING count(*) > 1');
  });
  it('preflights financial duplicates under a writer lock without rewriting historic rows', async () => {
    const migration = await readFile(new URL('../../drizzle-postgres-v1/0009_financial_ledger_authority.sql', import.meta.url), 'utf8');
    expect(migration.indexOf('LOCK TABLE')).toBeLessThan(migration.indexOf('IF EXISTS'));
    expect(migration.indexOf('RAISE EXCEPTION')).toBeLessThan(migration.indexOf('CREATE TABLE'));
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\s+"?(?:payment_cycles|weekly_pay_log)\b/i);
  });
  it("requires the latest checked-in migration version", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL(
          "../../drizzle-postgres-v1/meta/_journal.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    const latestMigration = journal.entries.at(-1);

    expect(latestMigration).toMatchObject({
      tag: REQUIRED_POSTGRES_MIGRATION.tag,
      when: Number(REQUIRED_POSTGRES_MIGRATION.createdAt),
    });

    const migrationSql = (
      await readFile(
        new URL(
          `../../drizzle-postgres-v1/${REQUIRED_POSTGRES_MIGRATION.tag}.sql`,
          import.meta.url
        ),
        "utf8"
      )
    ).replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      REQUIRED_POSTGRES_MIGRATION.hash
    );
  });

  it("accepts the exact required migration", async () => {
    expect(await hasRequiredPostgresSchema(poolReturning(true))).toBe(true);
  });

  it("rejects a missing required migration even if another migration is newer", async () => {
    expect(await hasRequiredPostgresSchema(poolReturning(false))).toBe(false);
  });

  it("fails closed when the probe times out or the migrations table is absent", async () => {
    expect(
      await hasRequiredPostgresSchema({
        query: vi.fn().mockRejectedValue(new Error("Query read timeout")),
      })
    ).toBe(false);
    expect(
      await hasRequiredPostgresSchema({
        query: vi.fn().mockRejectedValue(new Error("relation does not exist")),
      })
    ).toBe(false);
  });

  it("bounds the database query time", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ required_migration_applied: true }],
    });

    await hasRequiredPostgresSchema({ query });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_timeout: READINESS_QUERY_TIMEOUT_MS,
        values: [
          REQUIRED_POSTGRES_MIGRATION.createdAt.toString(),
          REQUIRED_POSTGRES_MIGRATION.hash,
        ],
      })
    );
  });

  it("checks the full assignment unique constraint and duplicate guard without dropping timer checks", async () => {
    const pool = poolReturning(true);
    await hasRequiredPostgresSchema(pool);
    const query = vi.mocked(pool.query).mock.calls[0][0].text;
    expect(query).toContain('GROUP BY "founderId", "taskId" HAVING count(*) > 1');
    expect(query).toContain("co.conname='task_assignments_founder_task_unique'");
    expect(query).toContain("co.contype='u' AND co.convalidated AND NOT co.condeferrable");
    expect(query).toContain('i.indpred IS NULL AND i.indexprs IS NULL');
    expect(query).toContain("ARRAY['founderId', 'taskId']::text[]");
    expect(query).toContain('time_entries_one_active_account_idx');
    expect(query).toContain('"trackedUserId" IS NULL AND "endTime" IS NULL');
  });

  it("preflights duplicates under a writer lock before additive DDL, without rewriting history", async () => {
    const migration = await readFile(new URL('../../drizzle-postgres-v1/0008_assignment_identity.sql', import.meta.url), 'utf8');
    expect(migration.indexOf('LOCK TABLE')).toBeLessThan(migration.indexOf('IF EXISTS'));
    expect(migration.indexOf('RAISE EXCEPTION')).toBeLessThan(migration.indexOf('CREATE TABLE'));
    expect(migration).toContain('UNIQUE("founderId","taskId")');
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\s+"?(?:task_assignments|task_schedule_history)\b/i);
  });

  it('stores assignment audit instants with timezone in both migration and snapshot', async () => {
    const migration = await readFile(new URL('../../drizzle-postgres-v1/0008_assignment_identity.sql', import.meta.url), 'utf8');
    const snapshot = JSON.parse(await readFile(new URL('../../drizzle-postgres-v1/meta/0008_snapshot.json', import.meta.url), 'utf8'));
    expect(migration).toContain('"createdAt" timestamp with time zone DEFAULT now() NOT NULL');
    expect(snapshot.tables['public.assignment_events'].columns.createdAt).toMatchObject({
      type: 'timestamp with time zone', default: 'now()', notNull: true,
    });
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "recognizes the migrated CI PostgreSQL database",
    async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 3_000,
      });
      try {
        expect(await hasRequiredPostgresSchema(pool)).toBe(true);
      } finally {
        await pool.end();
      }
    }
  );
});
