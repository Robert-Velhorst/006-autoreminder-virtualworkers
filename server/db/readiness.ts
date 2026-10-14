export const REQUIRED_POSTGRES_MIGRATION = {
  tag: "0001_add_atis_postgres_tables",
  createdAt: 1791977937806n,
  hash: "6954a9bd3c4c7c955b00210f2afd2c3c71157b5ec3083d91ceb7003f348f780d",
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
