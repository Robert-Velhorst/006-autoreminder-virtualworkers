export const REQUIRED_POSTGRES_MIGRATION = {
  tag: "0007_canonical_timer_columns",
  createdAt: 1792551653166n,
  hash: "f8045e01e9ea4c0d596a061fb5f70d548fef47345f8807820250da7fb5b18037",
} as const;

export const READINESS_QUERY_TIMEOUT_MS = 2_000;

export interface ReadinessPool {
  query(config: {
    text: string;
    values: [string, string];
    query_timeout: number;
  }): Promise<{
    rows: Array<{ required_migration_applied: boolean }>;
  }>;
}

export async function hasRequiredPostgresSchema(
  pool: ReadinessPool
): Promise<boolean> {
  try {
    const result = await pool.query({
      text: `
        SELECT EXISTS (
          SELECT 1
          FROM "drizzle"."__drizzle_migrations"
          WHERE created_at = $1 AND hash = $2
        ) AND NOT EXISTS (
          SELECT 1 FROM time_entries
          WHERE "trackedUserId" IS NULL AND "endTime" IS NULL AND NOT "isVoided"
        ) AND NOT EXISTS (
          SELECT 1 FROM time_entries WHERE "endTime" IS NULL AND NOT "isVoided"
          GROUP BY "trackedUserId" HAVING count(*) > 1
        ) AND EXISTS (
          SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='time_entries_one_active_account_idx'
            AND i.indisvalid AND i.indisunique
        ) AS required_migration_applied
      `,
      values: [
        REQUIRED_POSTGRES_MIGRATION.createdAt.toString(),
        REQUIRED_POSTGRES_MIGRATION.hash,
      ],
      query_timeout: READINESS_QUERY_TIMEOUT_MS,
    });
    return result.rows[0]?.required_migration_applied === true;
  } catch {
    return false;
  }
}
