export const REQUIRED_POSTGRES_MIGRATION = {
  tag: "0012_scheduled_generation_approval",
  createdAt: 1792574751125n,
  hash: "1d241f9e430a59672dc4053f11f4bf5c8f96a5212828eef402530c73630946a6",
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
        ) AND NOT EXISTS (
          SELECT 1 FROM payment_cycles GROUP BY "founderId", "cycleStart", "cycleEnd" HAVING count(*) > 1
        ) AND NOT EXISTS (
          SELECT 1 FROM weekly_pay_log GROUP BY "founderId", "vaId", "weekStart" HAVING count(*) > 1
        ) AND (
          SELECT count(*) = 6 FROM (VALUES
            ('payment_cycles', 'payment_cycles_founder_dates_unique', ARRAY['founderId','cycleStart','cycleEnd']::text[]),
            ('payment_cycles', 'payment_cycles_predecessor_unique', ARRAY['predecessorCycleId']::text[]),
            ('weekly_pay_log', 'weekly_pay_log_founder_worker_week_unique', ARRAY['founderId','vaId','weekStart']::text[]),
            ('financial_ledger_events', 'financial_ledger_events_founder_key_unique', ARRAY['founderId','eventKey']::text[]),
            ('atis_analysis_requests', 'atis_analysis_owner_request_key_unique', ARRAY['ownerUserId','requestKeyHash']::text[]),
            ('atis_analysis_items', 'atis_analysis_request_card_unique', ARRAY['requestId','cardId']::text[])
          ) expected(table_name, constraint_name, column_names)
          JOIN pg_class t ON t.relname=expected.table_name
          JOIN pg_namespace n ON n.oid=t.relnamespace AND n.nspname='public'
          JOIN pg_constraint co ON co.conrelid=t.oid AND co.conname=expected.constraint_name
          JOIN pg_index i ON i.indexrelid=co.conindid
          WHERE co.contype='u' AND co.convalidated AND NOT co.condeferrable
            AND i.indisvalid AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
            AND i.indnkeyatts=cardinality(expected.column_names)
            AND ARRAY(
              SELECT a.attname::text FROM unnest(co.conkey) WITH ORDINALITY k(attnum, position)
              JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum ORDER BY k.position
            ) = expected.column_names
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
