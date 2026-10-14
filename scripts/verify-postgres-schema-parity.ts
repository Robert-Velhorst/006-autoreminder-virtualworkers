import { Client } from "pg";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../drizzle/schema.postgres";
import { requirePostgresDatabaseUrl } from "../server/db/databaseUrl";

type SchemaTable = { name: string; columns: string[] };

function collectSchemaTables(): SchemaTable[] {
  const tables = new Map<string, SchemaTable>();
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    try {
      const config = getTableConfig(value as PgTable);
      if (!config.name || !config.columns.length) continue;
      tables.set(config.name, {
        name: config.name,
        columns: config.columns.map(column => column.name).sort(),
      });
    } catch {
      // Ignore enums and non-table schema exports.
    }
  }
  return [...tables.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

const connectionString = requirePostgresDatabaseUrl(process.env.DATABASE_URL, {
  requireVerifiedTls: true,
  allowInsecureLoopback: process.env.CI === "true",
});

const client = new Client({ connectionString });
await client.connect();
try {
  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
  }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
    ORDER BY table_name, ordinal_position
  `);
  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = actual.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actual.set(row.table_name, columns);
  }

  const missingTables: string[] = [];
  const missingColumns: Array<{ table: string; columns: string[] }> = [];
  const extraTables: string[] = [];
  const extraColumns: Array<{ table: string; columns: string[] }> = [];
  const expected = collectSchemaTables();
  const expectedByName = new Map(expected.map(table => [table.name, table]));

  for (const table of expected) {
    const actualColumns = actual.get(table.name);
    if (!actualColumns) {
      missingTables.push(table.name);
      continue;
    }
    const missing = table.columns.filter(column => !actualColumns.has(column));
    if (missing.length)
      missingColumns.push({ table: table.name, columns: missing });
    const expectedColumns = new Set(table.columns);
    const extra = [...actualColumns]
      .filter(column => !expectedColumns.has(column))
      .sort();
    if (extra.length) extraColumns.push({ table: table.name, columns: extra });
  }

  for (const tableName of actual.keys()) {
    if (
      tableName !== "__drizzle_migrations" &&
      !expectedByName.has(tableName)
    ) {
      extraTables.push(tableName);
    }
  }

  const result = {
    success:
      missingTables.length === 0 &&
      missingColumns.length === 0 &&
      extraTables.length === 0 &&
      extraColumns.length === 0,
    expectedTables: expected.length,
    actualTables: actual.size - (actual.has("__drizzle_migrations") ? 1 : 0),
    missingTables,
    missingColumns,
    extraTables: extraTables.sort(),
    extraColumns,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 2;
} finally {
  await client.end();
}
