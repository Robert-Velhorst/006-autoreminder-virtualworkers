import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
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
