import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { initializeApprovedWeeklySource, prepareApprovedWeeklySource, archiveApprovedWeeklySource, sourceReadTable, type WeeklyReconciliationPlan } from "../server/scripts/approvedWeeklyReconciliation";
import mysql from "mysql2";
import { Client, types as pgTypes } from "pg";
import { requirePostgresDatabaseUrl } from "../server/db/databaseUrl";
import { encodeManagerSnapshotStorage, decodeManagerSnapshotStorage } from "../server/db/managerSnapshotStorage";
import {
  canonicalizeCell,
  destinationColumnName,
  getTransferPairs,
  OPTIONAL_FEATURE_TABLES,
  INSERT_BATCH_MAX_BYTES,
  insertRowBytes,
  QUEUE_BOOTSTRAP_TABLE,
  inspectQueueBootstrap,
  removeQueueBootstrap,
  createRowDigest,
  getSequenceReset,
  getSchemaDifferences,
  isStringDatabaseType,
  orderTablesByDependencies,
  isNullLegacyUpgradeSelfReference,
  foldIdenticalLegacyReplyAliases,
  quoteMySqlIdentifier,
  quotePostgresIdentifier,
  transformSourceValue,
  type ColumnShape,
} from "../server/scripts/mysqlPostgresTransferCore";

const TARGET_ONLY_TABLES = new Set([
  "atis_chatbot_conversations",
  "atis_checklist_completion",
  "atis_checklist_sync",
]);
const MIGRATION_TABLE = "__drizzle_migrations";
const BATCH_SIZE = 250;
const SYSTEM_TABLES = new Set([MIGRATION_TABLE]);
const LEGACY_IDENTITY_KEYS = [
  { table: "task_assignments", columns: ["founderId", "fullTaskId"] },
  { table: "payment_cycles", columns: ["founderId", "cycleStart", "cycleEnd"] },
  { table: "weekly_pay_log", columns: ["founderId", "vaId", "weekStart"] },
];

type SourceColumn = ColumnShape & { ordinalPosition: number; autoIncrement: boolean };
type TargetColumn = ColumnShape & {
  udtName: string;
  identity: boolean;
  columnDefault: string | null;
};
type SourceTable = { name: string; engine: string | null; autoIncrement: string | null };
type KeyRow = {
  tableName: string;
  columnName: string;
  ordinalPosition: number;
};
type Row = Record<string, unknown>;

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sourceOrderExpression(column: SourceColumn): string {
  const identifier = quoteMySqlIdentifier(column.name);
  return isStringDatabaseType(column.dataType)
    ? `BINARY ${identifier}`
    : identifier;
}

function targetOrderExpression(column: TargetColumn): string {
  const identifier = quotePostgresIdentifier(column.name);
  return isStringDatabaseType(column.dataType)
    ? `${identifier} COLLATE "C"`
    : identifier;
}

function normalizeBooleanForInsert(
  value: unknown,
  column: TargetColumn,
  table: string
): unknown {
  return transformSourceValue(
    value,
    column.dataType,
    `${table}.${column.name}`
  );
}

function hashRow(
  digest: ReturnType<typeof createRowDigest>,
  values: unknown[],
  columns: Array<{ source: ColumnShape; target: TargetColumn }>,
  table: string
) {
  digest.add(
    values.map((value, index) =>
      canonicalizeCell(
        value,
        columns[index]!.source.dataType,
        columns[index]!.target.dataType,
        `${table}.${columns[index]!.target.name}`
      )
    )
  );
}

async function queryRows<T extends Record<string, unknown>>(
  client: Client,
  sql: string,
  parameters: unknown[] = []
): Promise<T[]> {
  const result = await client.query<T>(sql, parameters);
  return result.rows;
}

async function getSourceTables(
  connection: mysql.Connection
): Promise<SourceTable[]> {
  const [rows] = await connection
    .promise()
    .query<
      Array<{ tableName: string; engine: string | null; autoIncrement: string | null } & mysql.RowDataPacket>
    >(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine, CAST(AUTO_INCREMENT AS CHAR) AS autoIncrement
     FROM information_schema.tables
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`
    );
  return rows
    .filter(row => !SYSTEM_TABLES.has(row.tableName))
    .map(row => ({ name: row.tableName, engine: row.engine, autoIncrement: row.autoIncrement ?? null }));
}

async function getSourceColumns(
  connection: mysql.Connection
): Promise<Map<string, SourceColumn[]>> {
  const [rows] = await connection.promise().query<
    Array<
      {
        tableName: string;
        columnName: string;
        dataType: string;
        columnType: string;
        extra: string;
        generationExpression: string | null;
        ordinalPosition: number;
      } & mysql.RowDataPacket
    >
  >(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType,
            COLUMN_TYPE AS columnType, EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression,
            ORDINAL_POSITION AS ordinalPosition
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = DATABASE()
     ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  const columns = new Map<string, SourceColumn[]>();
  for (const row of rows) {
    if (SYSTEM_TABLES.has(row.tableName)) continue;
    const tableColumns = columns.get(row.tableName) ?? [];
    tableColumns.push({
      name: row.columnName,
      dataType: row.dataType,
      columnType: row.columnType,
      // DEFAULT_GENERATED describes a default expression, not a computed column.
      generated: Boolean(row.generationExpression) || /generated/i.test(row.extra.replace(/\bDEFAULT_GENERATED\b/gi, "")),
      generationExpression: row.generationExpression,
      ordinalPosition: row.ordinalPosition,
      autoIncrement: /\bauto_increment\b/i.test(row.extra),
    });
    columns.set(row.tableName, tableColumns);
  }
  return columns;
}

async function getTargetColumns(
  client: Client
): Promise<Map<string, TargetColumn[]>> {
  const rows = await queryRows<{
    tableName: string;
    columnName: string;
    dataType: string;
    udtName: string;
    generated: string;
    generationExpression: string | null;
    identity: string;
    nullable: string;
    columnDefault: string | null;
    characterMaximumLength: number | null;
  }>(
    client,
    `SELECT table_name AS "tableName", column_name AS "columnName", data_type AS "dataType",
            udt_name AS "udtName", is_generated AS "generated", is_identity AS "identity", column_default AS "columnDefault",
            generation_expression AS "generationExpression",
            character_maximum_length AS "characterMaximumLength",
            ordinal_position AS "ordinalPosition", is_nullable AS nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
     ORDER BY table_name, ordinal_position`
  );
  const columns = new Map<string, TargetColumn[]>();
  for (const row of rows) {
    if (SYSTEM_TABLES.has(row.tableName)) continue;
    const tableColumns = columns.get(row.tableName) ?? [];
    tableColumns.push({
      name: row.columnName,
      dataType: row.dataType,
      columnType: row.dataType === "character varying"
        ? `varchar(${row.characterMaximumLength})` : row.dataType,
      udtName: row.udtName,
      generated: row.generated === "ALWAYS",
      generationExpression: row.generationExpression,
      identity: row.identity === "YES",
      nullable: row.nullable === 'YES',
      columnDefault: row.columnDefault,
    });
    columns.set(row.tableName, tableColumns);
  }
  return columns;
}

async function getSourcePrimaryKeys(
  connection: mysql.Connection
): Promise<Map<string, string[]>> {
  const [rows] = await connection
    .promise()
    .query<Array<KeyRow & mysql.RowDataPacket>>(
      `SELECT kcu.TABLE_NAME AS tableName, kcu.COLUMN_NAME AS columnName,
            kcu.ORDINAL_POSITION AS ordinalPosition
     FROM information_schema.TABLE_CONSTRAINTS tc
     JOIN information_schema.KEY_COLUMN_USAGE kcu
       ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
      AND kcu.TABLE_NAME = tc.TABLE_NAME
      AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
     WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
     ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION`
    );
  return groupKeys(rows);
}

async function getTargetPrimaryKeys(
  client: Client
): Promise<Map<string, string[]>> {
  const rows = await queryRows<KeyRow>(
    client,
    `SELECT kcu.table_name AS "tableName", kcu.column_name AS "columnName",
            kcu.ordinal_position AS "ordinalPosition"
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_catalog = tc.constraint_catalog
      AND kcu.constraint_schema = tc.constraint_schema
      AND kcu.constraint_name = tc.constraint_name
      AND kcu.table_name = tc.table_name
     WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position`
  );
  return groupKeys(rows);
}

function groupKeys(rows: KeyRow[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const keys = result.get(row.tableName) ?? [];
    keys.push(row.columnName);
    result.set(row.tableName, keys);
  }
  return result;
}

async function getTargetDependencies(
  client: Client
): Promise<Array<{ table: string; dependsOn: string; columns: string[] }>> {
  return queryRows(
    client,
    `SELECT tc.table_name AS "table", ccu.table_name AS "dependsOn",
       array_agg(DISTINCT kcu.column_name::text ORDER BY kcu.column_name::text) AS "columns"
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_catalog = tc.constraint_catalog
      AND kcu.constraint_schema = tc.constraint_schema
      AND kcu.constraint_name = tc.constraint_name
      AND kcu.table_name = tc.table_name
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_catalog = tc.constraint_catalog
      AND ccu.constraint_schema = tc.constraint_schema
      AND ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'
     GROUP BY tc.table_name, tc.constraint_name, ccu.table_name
     ORDER BY tc.table_name, ccu.table_name`
  );
}

async function getSourceRowCount(
  connection: mysql.Connection,
  table: string,
  approvedWeekly = false
): Promise<string> {
  const [rows] = await connection
    .promise()
    .query<
      Array<{ count: string } & mysql.RowDataPacket>
    >(`SELECT COUNT(*) AS count FROM ${sourceReadTable(table, approvedWeekly)}`);
  return String(rows[0]?.count ?? "0");
}

async function targetHasRows(client: Client, table: string): Promise<boolean> {
  const result = await client.query<{ hasRows: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "public".${quotePostgresIdentifier(table)} LIMIT 1) AS "hasRows"`
  );
  return result.rows[0]?.hasRows ?? false;
}

async function getPreflight(
  source: mysql.Connection,
  target: Client,
  approvedWeekly = false
): Promise<{
  sourceTables: SourceTable[];
  sourceColumns: Map<string, SourceColumn[]>;
  targetColumns: Map<string, TargetColumn[]>;
  sourceKeys: Map<string, string[]>;
  targetKeys: Map<string, string[]>;
  importOrder: string[];
  report: Record<string, unknown>;
}> {
  let sourceTables = (await getSourceTables(source)).filter(
    table => !SYSTEM_TABLES.has(table.name)
  );
  const aliasNormalization = await foldIdenticalLegacyReplyAliases(
    await getSourceColumns(source), async (oldName, currentName) => {
      const [rows] = await source.promise().query<Array<{ rows: string; different: string } & mysql.RowDataPacket>>(
        `SELECT CAST(COUNT(*) AS CHAR) AS \`rows\`,
           CAST(COALESCE(SUM(NOT(CAST(${quoteMySqlIdentifier(oldName)} AS BINARY)
             <=> CAST(${quoteMySqlIdentifier(currentName)} AS BINARY))),0) AS CHAR) AS different
         FROM \`reply_threads\``);
      if (rows.length !== 1) throw new Error("Incomplete legacy alias comparison");
      return rows[0]!;
    });
  const sourceColumns = aliasNormalization.columns;
  const targetColumns = await getTargetColumns(target);
  const sourceKeys = await getSourcePrimaryKeys(source);
  const targetKeys = await getTargetPrimaryKeys(target);
  const schemaErrors = getSchemaDifferences(
    sourceColumns,
    targetColumns,
    TARGET_ONLY_TABLES
  );
  const sourceNames = sourceTables.map(table => table.name);
  const targetNames = [...targetColumns.keys()];

  for (const table of sourceNames) {
    if (!sourceKeys.has(table))
      schemaErrors.push(`MySQL table ${table} has no primary key`);
    if (!targetKeys.has(table))
      schemaErrors.push(`PostgreSQL table ${table} has no primary key`);
    if (
      sourceKeys.has(table) &&
      targetKeys.has(table) &&
      JSON.stringify(sourceKeys.get(table)!.map(key => destinationColumnName(table, key))) !==
        JSON.stringify(targetKeys.get(table))
    ) {
      schemaErrors.push(`Primary key differs for ${table}`);
    }
  }

  for (const table of sourceTables) {
    if (table.engine?.toLowerCase() !== "innodb") {
      schemaErrors.push(
        `MySQL table ${table.name} uses ${table.engine ?? "an unknown engine"}; a consistent read snapshot requires InnoDB`
      );
    }
  }

  const legacyIdentityConflicts: Array<{ table: string; columns: string[]; groups: string }> = [];
  for (const identity of LEGACY_IDENTITY_KEYS) {
    const available = sourceColumns.get(identity.table);
    if (!available || !identity.columns.every(name => available.some(c => c.name === name))) continue;
    const group = identity.columns.map(name => sourceOrderExpression(available.find(c => c.name === name)!)).join(", ");
    const nonNull = identity.columns.map(name => `${quoteMySqlIdentifier(name)} IS NOT NULL`).join(" AND ");
    const [rows] = await source.promise().query<Array<{ duplicateGroups: string } & mysql.RowDataPacket>>(
      `SELECT CAST(COUNT(*) AS CHAR) AS duplicateGroups FROM (
         SELECT 1 FROM ${sourceReadTable(identity.table, approvedWeekly)} WHERE ${nonNull}
         GROUP BY ${group} HAVING COUNT(*) > 1
       ) AS conflicting_identities`);
    if (rows.length !== 1 || !/^\d+$/.test(rows[0]!.duplicateGroups)) throw new Error("Incomplete legacy identity check");
    if (BigInt(rows[0]!.duplicateGroups) > 0n) {
      legacyIdentityConflicts.push({ ...identity, groups: rows[0]!.duplicateGroups });
      schemaErrors.push(`Legacy identity conflicts in ${identity.table}; approved reconciliation is required before transfer`);
    }
  }

  const extraTargetTables = targetNames.filter(
    table => !sourceNames.includes(table) && !TARGET_ONLY_TABLES.has(table) && !OPTIONAL_FEATURE_TABLES.has(table)
  );
  const missingTargetTables = [...TARGET_ONLY_TABLES].filter(
    table => !targetNames.includes(table)
  );
  const emptyChecks = await Promise.all(
    targetNames.map(async table => ({
      table,
      state: table === QUEUE_BOOTSTRAP_TABLE
        ? await inspectQueueBootstrap(target, targetColumns.get(table)!, sourceNames.includes(table))
        : await targetHasRows(target, table) ? "nonempty" : "empty",
    }))
  );
  const nonEmptyTargetTables = emptyChecks
    .filter(item => item.state === "nonempty")
    .map(item => item.table);
  const bootstrapSeedTables = emptyChecks
    .filter(item => item.state === "bootstrap-seed").map(item => item.table);
  const countRows = await Promise.all(
    sourceNames.map(async table => ({
      table,
      rows: await getSourceRowCount(source, table, approvedWeekly),
    }))
  );

  // A freshly restored InnoDB table can report an uninitialized counter until
  // opened. Read again after the exact row counts have opened every table.
  const openedTables = await getSourceTables(source);
  if (JSON.stringify(openedTables.map(t => [t.name, t.engine])) !== JSON.stringify(sourceTables.map(t => [t.name, t.engine])))
    throw new Error("Source table identity changed during preflight");
  sourceTables = openedTables;
  for (const table of sourceTables) {
    const autoColumns = (sourceColumns.get(table.name) ?? []).filter(c => c.autoIncrement);
    if (table.autoIncrement !== null || autoColumns.length) {
      const mapped = autoColumns.length === 1
        ? targetColumns.get(table.name)?.find(c => c.name === destinationColumnName(table.name, autoColumns[0]!.name)) : undefined;
      if (table.autoIncrement === null || !/^[1-9]\d*$/.test(table.autoIncrement) || !mapped
        || (!mapped.identity && !mapped.columnDefault?.startsWith("nextval("))) {
        schemaErrors.push(`Unsupported auto-increment mapping for ${table.name}`);
      }
    }
  }

  const dependencies = await getTargetDependencies(target);
  // These exact new columns are inserted explicitly as NULL. Keep every real
  // source dependency and all database constraints; no row ordering is guessed.
  const nullUpgradeSelfReferences = dependencies.filter(edge =>
    isNullLegacyUpgradeSelfReference(edge, sourceColumns, targetColumns));
  const order = orderTablesByDependencies(sourceNames,
    dependencies.filter(edge => !nullUpgradeSelfReferences.includes(edge)));
  const report = {
    success: schemaErrors.length === 0 && nonEmptyTargetTables.length === 0,
    sourceTables: sourceNames.length,
    targetTables: targetNames.length,
    copiedTables: sourceNames.length,
    expectedTargetOnlyTables: [...TARGET_ONLY_TABLES].filter(table => !sourceNames.includes(table)).sort(),
    optionalTargetOnlyTables: targetNames.filter(table => !sourceNames.includes(table)
      && !TARGET_ONLY_TABLES.has(table) && OPTIONAL_FEATURE_TABLES.has(table)).sort(),
    optionalTargetTableAllowlist: [...OPTIONAL_FEATURE_TABLES].sort(),
    extraTargetTables,
    missingTargetTables,
    nonEmptyTargetTables,
    bootstrapSeedTables,
    sourceRowCounts: Object.fromEntries(
      countRows.map(item => [item.table, item.rows])
    ),
    importOrder: order,
    nullUpgradeSelfReferences,
    foldedIdenticalReplyAliases: aliasNormalization.folded,
    sourceAutoIncrement: Object.fromEntries(sourceTables.filter(t => t.autoIncrement !== null).map(t => [t.name, t.autoIncrement])),
    legacyIdentityConflicts,
    errors: schemaErrors.sort(),
  };

  return {
    sourceTables,
    sourceColumns,
    targetColumns,
    sourceKeys,
    targetKeys,
    importOrder: order,
    report,
  };
}

function sourceOrderBy(columns: SourceColumn[], keys: string[]): string {
  return keys
    .map(key => {
      const column = columns.find(item => item.name === key);
      if (!column) throw new Error(`Missing source primary-key column ${key}`);
      return sourceOrderExpression(column);
    })
    .join(", ");
}

function targetOrderBy(columns: TargetColumn[], keys: string[]): string {
  return keys
    .map(key => {
      const column = columns.find(item => item.name === key);
      if (!column) throw new Error(`Missing target primary-key column ${key}`);
      return targetOrderExpression(column);
    })
    .join(", ");
}

function targetCursorWhere(
  columns: TargetColumn[],
  keys: string[],
  parameterOffset: number
): string {
  const left = keys.map(key => {
    const column = columns.find(item => item.name === key);
    if (!column) throw new Error(`Missing target primary-key column ${key}`);
    return targetOrderExpression(column);
  });
  const right = keys.map((key, index) => {
    const column = columns.find(item => item.name === key)!;
    const parameter = `$${parameterOffset + index}`;
    return isStringDatabaseType(column.dataType)
      ? `(${parameter} COLLATE "C")`
      : parameter;
  });
  return `WHERE (${left.join(", ")}) > (${right.join(", ")})`;
}

async function insertBatch(
  target: Client,
  table: string,
  columns: TargetColumn[],
  rows: unknown[][]
): Promise<void> {
  if (!rows.length) return;
  const names = columns
    .map(column => quotePostgresIdentifier(column.name))
    .join(", ");
  const values: unknown[] = [];
  const tuples = rows.map(row => {
    const placeholders = row.map(value => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await target.query(
    `INSERT INTO "public".${quotePostgresIdentifier(table)} (${names}) VALUES ${tuples.join(", ")}`,
    values
  );
}

async function importTable(
  source: mysql.Connection,
  target: Client,
  table: string,
  sourceColumns: SourceColumn[],
  targetColumns: TargetColumn[],
  keys: string[],
  approvedWeekly = false
): Promise<{ count: number; digest: string }> {
  const columns = [...sourceColumns].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const pairs = getTransferPairs(table, sourceColumns, targetColumns);
  const select = columns
    .map(column => quoteMySqlIdentifier(column.name))
    .join(", ");
  const sql = `SELECT ${select} FROM ${sourceReadTable(table, approvedWeekly)} ORDER BY ${sourceOrderBy(columns, keys)}`;
  const stream = source
    .query(sql)
    .stream({ highWaterMark: 2 }) as AsyncIterable<Row>;
  const digest = createRowDigest();
  const insertPairs = pairs.filter(pair => !pair.target.generated);
  let batch: unknown[][] = [];
  let batchBytes = 0;
  let count = 0;

  for await (const sourceRow of stream) {
    const values = pairs.map(
      pair => {
        const { source: sourceColumn, target: targetColumn } = pair;
        if (!("defaultValue" in pair) && !Object.hasOwn(sourceRow, sourceColumn.name)) {
          throw new Error(`Missing source row column ${table}.${sourceColumn.name}`);
        }
        const value = "defaultValue" in pair ? pair.defaultValue : sourceRow[sourceColumn.name];
        const transformed = normalizeBooleanForInsert(
          value,
          targetColumn,
          table
        );
        if (
          transformed !== null &&
          typeof transformed === "string" &&
          /^0000-00-00/.test(transformed) &&
          (targetColumn.dataType === "date" ||
            targetColumn.dataType.startsWith("timestamp"))
        ) {
          throw new Error(
            `${table}.${targetColumn.name} contains a MySQL zero date; resolve it explicitly before migration`
          );
        }
        return transformed;
      }
    );
    hashRow(digest, values, pairs, table);
    // Hash the uncompressed source, including generated values; only storage
    // parameters bypassing Drizzle's customType need encoding.
    const insertValues = values.filter((_, index) => !pairs[index]!.target.generated);
    const rowBytes = insertRowBytes(insertValues);
    if (batch.length && batchBytes + rowBytes > INSERT_BATCH_MAX_BYTES) {
      await insertBatch(target, table, insertPairs.map(pair => pair.target), batch);
      batch = [];
      batchBytes = 0;
    }
    const snapshotIndex = insertPairs.findIndex(pair => table === "aptlss_manager_runs" && pair.target.name === "snapshotJson");
    if (snapshotIndex >= 0 && insertValues[snapshotIndex] !== null) {
      insertValues[snapshotIndex] = encodeManagerSnapshotStorage(insertValues[snapshotIndex] as string);
    }
    batch.push(insertValues);
    batchBytes += rowBytes;
    count += 1;
    if (batch.length >= BATCH_SIZE || batchBytes >= INSERT_BATCH_MAX_BYTES) {
      await insertBatch(
        target,
        table,
        insertPairs.map(pair => pair.target),
        batch
      );
      batch = [];
      batchBytes = 0;
    }
  }
  await insertBatch(
    target,
    table,
    insertPairs.map(pair => pair.target),
    batch
  );

  return { count, digest: digest.digest() };
}

async function verifyTargetTable(
  target: Client,
  table: string,
  sourceColumns: SourceColumn[],
  targetColumns: TargetColumn[],
  keys: string[]
): Promise<{ count: number; digest: string }> {
  const pairs = getTransferPairs(table, sourceColumns, targetColumns);
  const targetByName = new Map(
    targetColumns.map(column => [column.name, column])
  );
  const select = pairs
    .map(pair => quotePostgresIdentifier(pair.target.name))
    .join(", ");
  const keyColumns = new Set(keys);
  for (const key of keys) {
    const column = targetByName.get(key);
    if (!column)
      throw new Error(`Missing destination primary-key column ${table}.${key}`);
    if (
      isStringDatabaseType(column.dataType) &&
      !["text", "character varying", "character"].includes(column.dataType)
    ) {
      throw new Error(
        `String primary key ${table}.${key} needs an explicit stable sort rule before migration`
      );
    }
  }
  if (keyColumns.size !== keys.length)
    throw new Error(`Duplicate primary-key columns in ${table}`);

  const digest = createRowDigest();
  let cursor: unknown[] | undefined;
  let count = 0;
  const pageSize = table === "aptlss_manager_runs" ? 4 : BATCH_SIZE;
  while (true) {
    const where = cursor ? targetCursorWhere(targetColumns, keys, 1) : "";
    const values = cursor ?? [];
    const result = await target.query<Row>(
      `SELECT ${select} FROM "public".${quotePostgresIdentifier(table)} ${where}
       ORDER BY ${targetOrderBy(targetColumns, keys)} LIMIT ${pageSize}`,
      values
    );
    if (!result.rows.length) break;
    for (const row of result.rows) {
      const values = pairs.map(({ target: column }) => {
        if (!Object.hasOwn(row, column.name)) throw new Error(`Missing target row column ${table}.${column.name}`);
        const value = row[column.name];
        return table === "aptlss_manager_runs" && column.name === "snapshotJson" && value !== null
          ? decodeManagerSnapshotStorage(value as string) : value;
      });
      hashRow(digest, values, pairs, table);
      cursor = keys.map(key => row[key]);
      count += 1;
    }
    if (result.rows.length < pageSize) break;
  }
  return { count, digest: digest.digest() };
}

async function syncSequences(
  target: Client,
  table: string,
  columns: TargetColumn[],
  sourceColumns: SourceColumn[],
  sourceNext: string | null
): Promise<void> {
  for (const column of columns) {
    if (!column.identity && !column.columnDefault?.startsWith("nextval("))
      continue;
    const sequenceResult = await target.query<{ sequenceName: string | null }>(
      'SELECT pg_get_serial_sequence($1, $2) AS "sequenceName"',
      [`public.${table}`, column.name]
    );
    const sequence = sequenceResult.rows[0]?.sequenceName;
    if (!sequence) throw new Error(`Missing target sequence for ${table}.${column.name}`);
    const maximum = await target.query<{
      maxValue: string | null;
      hasRows: boolean;
    }>(
      `SELECT MAX(${quotePostgresIdentifier(column.name)})::text AS \"maxValue\",
              COUNT(*) > 0 AS \"hasRows\"
       FROM "public".${quotePostgresIdentifier(table)}`
    );
    const reset = getSequenceReset(
      maximum.rows[0]?.maxValue ?? null,
      maximum.rows[0]?.hasRows ?? false,
      sourceColumns.some(c => c.autoIncrement && destinationColumnName(table, c.name) === column.name) ? sourceNext : null
    );
    await target.query("SELECT setval($1::regclass, $2::bigint, $3::boolean)", [
      sequence,
      reset.value,
      reset.isCalled,
    ]);
  }
}

export async function runMysqlPostgresMigration(args: string[], env: Record<string, string | undefined>) {
  const mode = args[0] ?? "preflight";
  if (mode !== "preflight" && mode !== "copy") {
    throw new Error(
      "Usage: pnpm db:migrate:mysql-to-postgres [preflight|copy --execute]"
    );
  }
  if (mode === "copy" && !args.includes("--execute")) {
    throw new Error(
      "Refusing to write: copy requires the explicit --execute flag"
    );
  }

  const sourceUrl = env.LEGACY_MYSQL_DATABASE_URL;
  const targetUrl = env.DATABASE_URL;
  if (!sourceUrl?.startsWith("mysql://"))
    throw new Error("LEGACY_MYSQL_DATABASE_URL must be a MySQL connection URL");
  const verifiedTargetUrl = requirePostgresDatabaseUrl(targetUrl, {
    requireVerifiedTls: true,
  });

  const source = mysql.createConnection({
    uri: sourceUrl,
    dateStrings: true,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  });
  pgTypes.setTypeParser(1082, value => value);
  pgTypes.setTypeParser(1114, value => value);
  pgTypes.setTypeParser(1184, value => value);
  const target = new Client({ connectionString: verifiedTargetUrl });
  let targetTransaction = false;
  let sourceTransaction = false;

  try {
    await target.connect();
    await source.promise().query("SET SESSION time_zone = '+00:00'");
    await source.promise().query("SET SESSION information_schema_stats_expiry = 0");
    const weeklyPlan = env.LEGACY_WEEKLY_RECONCILIATION_FILE
      ? JSON.parse(await readFile(env.LEGACY_WEEKLY_RECONCILIATION_FILE, 'utf8')) as WeeklyReconciliationPlan
      : undefined;
    if (weeklyPlan) await initializeApprovedWeeklySource(source, weeklyPlan);
    await source
      .promise()
      .query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    sourceTransaction = true;
    const approvedWeekly = weeklyPlan
      ? await prepareApprovedWeeklySource(source, weeklyPlan)
      : undefined;
    const schemaName = await target.query<{ schema: string }>(
      "SELECT current_schema() AS schema"
    );
    if (schemaName.rows[0]?.schema !== "public") {
      throw new Error(
        "PostgreSQL current_schema() must be public for this migration"
      );
    }

    const initialTargetColumns = await getTargetColumns(target);
    if (mode === "copy") {
      const targetTables = [...initialTargetColumns.keys()].sort();
      if (!targetTables.length)
        throw new Error(
          "PostgreSQL schema is empty; apply Drizzle migrations before copying data"
        );
      await target.query("BEGIN");
      targetTransaction = true;
      await target.query("SELECT set_config('aptlss.legacy_timer_import', txid_current()::text, true)");
      await target.query("SET LOCAL lock_timeout = '5s'");
      const lockList = targetTables
        .map(table => `"public".${quotePostgresIdentifier(table)}`)
        .join(", ");
      await target.query(`LOCK TABLE ${lockList} IN ACCESS EXCLUSIVE MODE`);
    }

    const preflight = await getPreflight(source, target, !!approvedWeekly);
    const report = preflight.report as {
      success: boolean;
      errors: string[];
      nonEmptyTargetTables: string[];
      sourceRowCounts: Record<string, string>;
      bootstrapSeedTables: string[];
    };
    if (!report.success) {
      throw new Error(
        `Preflight failed: ${JSON.stringify({ errors: report.errors, nonEmptyTargetTables: report.nonEmptyTargetTables })}`
      );
    }

    if (mode === "preflight") {
      await source.promise().query("COMMIT");
      sourceTransaction = false;
      console.log(
        JSON.stringify(
          { mode, ...preflight.report, writesPerformed: false,
            approvedWeeklyReconciliation: approvedWeekly ? {
              planSha256: approvedWeekly.planSha256,
              originalRowsReviewed: approvedWeekly.originals.length,
              sourcePermanentRowsChanged: false,
              archivePersisted: false,
            } : undefined },
          null,
          2
        )
      );
      return;
    }

    const sourceColumnMap = preflight.sourceColumns;
    const targetColumnMap = preflight.targetColumns;
    const sourceKeyMap = preflight.sourceKeys;
    const targetKeyMap = preflight.targetKeys;
    if (report.bootstrapSeedTables.includes(QUEUE_BOOTSTRAP_TABLE)) {
      await removeQueueBootstrap(target, targetColumnMap.get(QUEUE_BOOTSTRAP_TABLE)!,
        preflight.sourceTables.some(table => table.name === QUEUE_BOOTSTRAP_TABLE));
    }
    const results: Record<
      string,
      { sourceRows: number; targetRows: number; sha256: string }
    > = {};
    for (const table of preflight.importOrder) {
      const expectedRows = BigInt(report.sourceRowCounts[table] ?? "0");
      const copied = await importTable(
        source,
        target,
        table,
        sourceColumnMap.get(table)!,
        targetColumnMap.get(table)!,
        sourceKeyMap.get(table)!,
        !!approvedWeekly
      );
      const reconciled = await verifyTargetTable(
        target,
        table,
        sourceColumnMap.get(table)!,
        targetColumnMap.get(table)!,
        targetKeyMap.get(table)!
      );
      if (
        BigInt(copied.count) !== expectedRows ||
        copied.count !== reconciled.count ||
        copied.digest !== reconciled.digest
      ) {
        throw new Error(
          `Row reconciliation failed for ${table}: source=${copied.count}/${copied.digest}, target=${reconciled.count}/${reconciled.digest}`
        );
      }
      await syncSequences(target, table, targetColumnMap.get(table)!, sourceColumnMap.get(table)!, preflight.sourceTables.find(t => t.name === table)!.autoIncrement);
      results[table] = {
        sourceRows: copied.count,
        targetRows: reconciled.count,
        sha256: copied.digest,
      };
      console.log(`Verified ${table}: ${copied.count} rows`);
    }

    await source.promise().query("COMMIT");
    sourceTransaction = false;
    if (approvedWeekly) await archiveApprovedWeeklySource(target, approvedWeekly);
    await target.query("COMMIT");
    targetTransaction = false;
    console.log(
      JSON.stringify(
        {
          mode,
          success: true,
          sourceTables: Object.keys(results).length,
          targetOnlyTables: [...targetColumnMap.keys()].filter(table => !sourceColumnMap.has(table)).sort(),
          expectedTargetOnlyTables: preflight.report.expectedTargetOnlyTables,
          optionalTargetOnlyTables: preflight.report.optionalTargetOnlyTables,
          foldedIdenticalReplyAliases: preflight.report.foldedIdenticalReplyAliases,
          nullUpgradeSelfReferences: preflight.report.nullUpgradeSelfReferences,
          sourceAutoIncrement: preflight.report.sourceAutoIncrement,
          approvedWeeklyReconciliation: approvedWeekly ? {
            planSha256: approvedWeekly.planSha256,
            originalRowsPreserved: approvedWeekly.originals.length,
            canonicalRows: 1,
            sourcePermanentRowsChanged: false,
            archive: 'migration_audit.approved_weekly_reconciliations',
          } : undefined,
          rowLevelReconciliation:
            "SHA-256 per table; source/target row values normalized by destination type",
          tables: results,
        },
        null,
        2
      )
    );
  } catch (error) {
    if (targetTransaction)
      await target.query("ROLLBACK").catch(() => undefined);
    if (sourceTransaction)
      await source
        .promise()
        .query("ROLLBACK")
        .catch(() => undefined);
    throw error;
  } finally {
    await Promise.allSettled([target.end(), source.promise().end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import("dotenv/config");
  runMysqlPostgresMigration(process.argv.slice(2), process.env).catch(error => {
    console.error(
      `MySQL to PostgreSQL migration failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
    process.exitCode = 1;
  });
}
