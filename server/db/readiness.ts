export const REQUIRED_POSTGRES_MIGRATION = {
  tag: "0001_add_atis_postgres_tables",
  createdAt: 1791977937806n,
} as const;

export const READINESS_QUERY_TIMEOUT_MS = 2_000;

export interface ReadinessPool {
  query(config: { text: string; query_timeout: number }): Promise<{
    rows: Array<{ applied_schema_version: string | number | bigint }>;
  }>;
}

export async function hasRequiredPostgresSchema(
  pool: ReadinessPool
): Promise<boolean> {
  try {
    const result = await pool.query({
      text: `
        SELECT COALESCE(MAX(created_at), 0)::text AS applied_schema_version
        FROM "drizzle"."__drizzle_migrations"
      `,
      query_timeout: READINESS_QUERY_TIMEOUT_MS,
    });
    const appliedVersion = result.rows[0]?.applied_schema_version;
    return (
      appliedVersion !== undefined &&
      BigInt(appliedVersion) >= REQUIRED_POSTGRES_MIGRATION.createdAt
    );
  } catch {
    return false;
  }
}
