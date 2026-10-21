export const REQUIRED_POSTGRES_MIGRATION = {
  tag: "0008_assignment_identity",
  createdAt: 1792559997541n,
  hash: "5a7f67d77a91384a486ea618fa4df7a847da0b5f2a565c89598216d34c28a2be",
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
        ) AND NOT EXISTS (
          SELECT 1 FROM task_assignments
          GROUP BY "founderId", "taskId" HAVING count(*) > 1
        ) AND EXISTS (
          SELECT 1 FROM pg_constraint co
          JOIN pg_class t ON t.oid=co.conrelid
          JOIN pg_namespace n ON n.oid=t.relnamespace
          JOIN pg_index i ON i.indexrelid=co.conindid
          WHERE n.nspname='public' AND t.relname='task_assignments'
            AND co.conname='task_assignments_founder_task_unique'
            AND co.contype='u' AND co.convalidated AND NOT co.condeferrable
            AND i.indisvalid AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
            AND i.indnkeyatts=2
            AND ARRAY(
              SELECT a.attname::text FROM unnest(co.conkey) WITH ORDINALITY k(attnum, position)
              JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
              ORDER BY k.position
            ) = ARRAY['founderId', 'taskId']::text[]
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
