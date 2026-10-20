export const REQUIRED_POSTGRES_MIGRATION = {
  tag: "0004_browser_capture_sequence_range",
  createdAt: 1792485905541n,
  hash: "5c43c09b32218fd6cfd3bb0611fcf02d7b47921427743eb84ce8358e2d10b370",
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
