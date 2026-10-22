import { createHash } from "node:crypto";

export type ColumnShape = {
  name: string;
  dataType: string;
  columnType?: string;
  generated?: boolean;
  generationExpression?: string | null;
  nullable?: boolean;
  columnDefault?: string | null;
  identity?: boolean;
};

export const OPTIONAL_FEATURE_TABLES = new Set([
  "aptlss_manager_checks", "assignment_events", "atis_analysis_items",
  "atis_analysis_requests", "atis_chatbot_conversations", "atis_checklist_sync",
  "digest_job_items", "financial_ledger_events", "revoked_sessions", "worker_lifecycle_audit",
]);

export const LEGACY_REPLY_ALIASES: Readonly<Record<string, string>> = {
  lastNonJoyceMsgAt: "lastNonWorkerMsgAt",
  lastNonJoyceAuthor: "lastNonWorkerAuthor",
  lastNonJoyceText: "lastNonWorkerText",
  lastJoyceReplyAt: "lastWorkerReplyAt",
};

export function destinationColumnName(table: string, name: string): string {
  return table === "reply_threads" && Object.hasOwn(LEGACY_REPLY_ALIASES, name) ? LEGACY_REPLY_ALIASES[name]! : name;
}

type UpgradeColumn = { table: string; name: string; type: string; defaultValue?: string | number };
// Exact post-migration shapes, not a blanket permission for nullable/defaulted fields.
export const LEGACY_UPGRADE_COLUMNS: readonly UpgradeColumn[] = [
  { table: "aptlss_manager_state", name: "currentCheckId", type: "integer" },
  { table: "aptlss_manager_state", name: "historyScopeHash", type: "varchar(64)" },
  { table: "aptlss_manager_updates", name: "reportKind", type: "varchar(24)", defaultValue: "update" },
  { table: "aptlss_manager_updates", name: "actionId", type: "varchar(256)" },
  { table: "aptlss_manager_updates", name: "assessmentRunId", type: "integer" },
  { table: "aptlss_manager_updates", name: "requestKey", type: "varchar(36)" },
  { table: "browser_tab_states", name: "captureSequence", type: "bigint", defaultValue: 0 },
  { table: "browser_tab_states", name: "sourceCapturedAt", type: "timestamp" },
  { table: "digest_jobs", name: "windowKey", type: "varchar(96)" },
  { table: "digest_jobs", name: "deliveryPhase", type: "varchar(24)" },
  { table: "digest_jobs", name: "recipientEmail", type: "text" },
  { table: "digest_jobs", name: "subject", type: "text" },
  { table: "digest_jobs", name: "html", type: "text" },
  { table: "digest_jobs", name: "payloadHash", type: "varchar(64)" },
  { table: "digest_jobs", name: "attemptId", type: "varchar(64)" },
  { table: "digest_jobs", name: "attemptCount", type: "integer", defaultValue: 0 },
  { table: "digest_jobs", name: "attemptedAt", type: "timestamp" },
  { table: "digest_jobs", name: "nextAttemptAt", type: "timestamp" },
  { table: "digest_jobs", name: "providerReceipt", type: "text" },
  { table: "digest_jobs", name: "reconciledAt", type: "timestamp" },
  { table: "digest_jobs", name: "reconciledBy", type: "integer" },
  { table: "digest_jobs", name: "reconciliationNote", type: "text" },
  { table: "payment_cycles", name: "predecessorCycleId", type: "integer" },
  { table: "scheduled_jobs", name: "approvedByUserId", type: "integer" },
  { table: "scheduled_jobs", name: "approvedSessionEpoch", type: "bigint" },
  { table: "scheduled_jobs", name: "approvedAt", type: "timestamp" },
  { table: "scheduled_jobs", name: "approvalHash", type: "varchar(64)" },
  { table: "time_entries", name: "trackedUserId", type: "integer" },
  { table: "time_entries", name: "trackedProfileId", type: "integer" },
  { table: "users", name: "sessionEpoch", type: "bigint", defaultValue: 1 },
];

function upgradeDefinition(table: string, column: ColumnShape): UpgradeColumn | undefined {
  const definition = LEGACY_UPGRADE_COLUMNS.find(c => c.table === table && c.name === column.name);
  if (!definition || column.generated || column.generationExpression || column.identity) return undefined;
  const type = column.dataType === "character varying" ? column.columnType
    : column.dataType === "timestamp without time zone" ? "timestamp" : column.dataType;
  const hasDefault = definition.defaultValue !== undefined;
  const expectedDefault = typeof definition.defaultValue === "string"
    ? `'${definition.defaultValue}'::character varying` : String(definition.defaultValue);
  return type === definition.type && column.nullable === !hasDefault
    && (hasDefault ? column.columnDefault === expectedDefault : column.columnDefault == null)
    ? definition : undefined;
}

export function getTransferPairs<S extends ColumnShape, T extends ColumnShape>(
  table: string, source: S[], target: T[]
): Array<{ source: ColumnShape; target: T; defaultValue?: string | number | null }> {
  const errors = getSchemaDifferences(new Map([[table, source]]), new Map([[table, target]]), new Set());
  if (errors.length) throw new Error(errors.join("; "));
  const pairs: Array<{ source: ColumnShape; target: T; defaultValue?: string | number | null }> =
    [...source].sort((a, b) => a.name.localeCompare(b.name)).map(column => ({
      source: column,
      target: target.find(t => t.name === destinationColumnName(table, column.name))!,
    }));
  for (const column of target) {
    if (pairs.some(pair => pair.target.name === column.name)) continue;
    const definition = upgradeDefinition(table, column)!;
    pairs.push({ source: column, target: column, defaultValue: definition.defaultValue ?? null });
  }
  return pairs;
}

export const QUEUE_BOOTSTRAP_TABLE = "aptlss_manager_queue_slots";

// Normalize syntax only, never literals or arbitrary casts/operators. These are
// the schema DDL and information_schema deparses, not a general SQL equivalence test.
function normalizeGeneration(expression: string, dialect: "mysql" | "postgres"): string {
  // Only these complete information_schema escape spellings are known equivalents.
  if (dialect === "mysql") {
    const escaped = [
      "json_unquote(json_extract(`snapshotJson`,_utf8mb4\\'$.implementationDigest\\'))",
      "coalesce(json_contains(json_extract(`snapshotJson`,_utf8mb4\\'$.interventions[*].severity\\'),_utf8mb4\\'\"urgent\"\\'),0)",
    ];
    if (escaped.includes(expression)) expression = expression.replaceAll("\\'", "'");
  }
  const tokens = expression.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\s+|[^\s'"`]+/g) ?? [];
  if (tokens.join("") !== expression) return "<invalid expression>";
  let normalized = tokens.map(token => {
    if (token.startsWith("'")) return token;
    if (token.startsWith('"') || token.startsWith('`')) {
      return dialect === "mysql" && token === '`snapshotJson`' ? "snapshotjson" : token;
    }
    const syntax = token.trim().toLowerCase();
    return dialect === "mysql" ? syntax.replace(/_utf8mb4$/, "") : syntax;
  }).join("");
  normalized = normalized.replace(/\("snapshotJson"\)/g, '"snapshotJson"');
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    // Check that the outer pair spans the entire expression, ignoring literals.
    let depth = 0;
    let outer = true;
    const syntax = normalized.replace(/'(?:''|[^'])*'/g, "''");
    for (let i = 0; i < syntax.length - 1; i++) {
      if (syntax[i] === "(") depth++;
      if (syntax[i] === ")") depth--;
      if (depth === 0) { outer = false; break; }
    }
    if (!outer) break;
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

export function isCanonicalManagerGeneratedColumn(
  table: string, column: ColumnShape, dialect: "mysql" | "postgres"
): boolean {
  if (table !== "aptlss_manager_runs" || !column.generated || !column.generationExpression) return false;
  const digest = column.name === "reviewDigest";
  if (!digest && column.name !== "reviewUrgent") return false;
  const types = dialect === "postgres"
    ? digest ? ["character varying"] : ["boolean"]
    : digest ? ["varchar"] : ["tinyint", "boolean", "bool"];
  if (!types.includes(column.dataType.toLowerCase())) return false;
  if (digest && column.columnType && column.columnType.toLowerCase() !== "varchar(64)") return false;
  const expected = dialect === "mysql"
    ? [digest
      ? "JSON_UNQUOTE(JSON_EXTRACT(snapshotJson, '$.implementationDigest'))"
      : `COALESCE(JSON_CONTAINS(JSON_EXTRACT(snapshotJson, '$.interventions[*].severity'), '"urgent"'), 0)`]
    : digest
      ? [`("snapshotJson"::jsonb ->> 'implementationDigest')`, `("snapshotJson"::jsonb ->> 'implementationDigest'::text)`]
      : [`("snapshotJson"::jsonb @> '{"interventions":[{"severity":"urgent"}]}'::jsonb)`,
        `("snapshotJson"::jsonb @> '{"interventions": [{"severity": "urgent"}]}'::jsonb)`];
  return expected.some(expression => normalizeGeneration(expression, dialect) === normalizeGeneration(column.generationExpression!, dialect));
}

export const INSERT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

export function insertRowBytes(values: unknown[]): number {
  // Include per-parameter protocol/placeholder overhead as well as UTF-8 payloads.
  return values.reduce<number>((total, value) => total + 16 +
    (value == null ? 0 : Buffer.isBuffer(value) ? value.length :
      Buffer.byteLength(typeof value === "object" ? JSON.stringify(value) : String(value), "utf8")), 0);
}

export function isCanonicalQueueBootstrap(
  rows: Record<string, unknown>[],
  columns: ColumnShape[]
): boolean {
  const expected = new Map([
    ["id", "integer"], ["vaId", "integer"],
    ["token", "character varying"], ["leaseUntil", "timestamp without time zone"],
  ]);
  if (columns.length !== expected.size || new Set(columns.map(c => c.name)).size !== expected.size
    || columns.some(c => expected.get(c.name) !== c.dataType || c.generated
      || c.nullable !== (c.name !== "id"))) return false;
  return rows.length === 4 && new Set(rows.map(row => row.id)).size === 4
    && rows.every(row => Object.keys(row).length === expected.size
      && Object.keys(row).every(key => expected.has(key))
      && typeof row.id === "number" && [1, 2, 3, 4].includes(row.id)
      && row.vaId === null && row.token === null && row.leaseUntil === null);
}

type BootstrapClient = {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
};

export async function inspectQueueBootstrap(
  client: BootstrapClient, columns: ColumnShape[], sourceHasTable: boolean
): Promise<"empty" | "bootstrap-seed" | "nonempty"> {
  const { rows } = await client.query('SELECT * FROM "public"."aptlss_manager_queue_slots" ORDER BY "id" LIMIT 5');
  if (!rows.length) return "empty";
  return sourceHasTable && isCanonicalQueueBootstrap(rows, columns) ? "bootstrap-seed" : "nonempty";
}

export async function removeQueueBootstrap(
  client: BootstrapClient, columns: ColumnShape[], sourceHasTable: boolean
): Promise<void> {
  if (!sourceHasTable) throw new Error("Queue bootstrap replacement requires the source table");
  // SAVEPOINT refuses autocommit use; the caller owns the full copy transaction.
  await client.query("SAVEPOINT queue_bootstrap_replacement");
  await client.query('LOCK TABLE "public"."aptlss_manager_queue_slots" IN ACCESS EXCLUSIVE MODE');
  if (await inspectQueueBootstrap(client, columns, sourceHasTable) !== "bootstrap-seed") {
    throw new Error("Queue bootstrap changed before replacement; refusing to remove rows");
  }
  const removed = await client.query(`DELETE FROM "public"."aptlss_manager_queue_slots"
    WHERE "id" IN (1,2,3,4) AND "vaId" IS NULL AND "token" IS NULL AND "leaseUntil" IS NULL
    RETURNING *`);
  if (!isCanonicalQueueBootstrap(removed.rows, columns)) {
    throw new Error("Queue bootstrap deletion did not match exact defaults; rollback required");
  }
  await client.query("RELEASE SAVEPOINT queue_bootstrap_replacement");
}

export function getSequenceReset(maxValue: string | null, hasRows: boolean) {
  if (!hasRows || maxValue === null) return { value: "1", isCalled: false };
  const maximum = BigInt(maxValue);
  if (maximum < 1n) return { value: "1", isCalled: false };
  return { value: maximum.toString(), isCalled: true };
}

export function quoteMySqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe MySQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function isStringDatabaseType(type: string): boolean {
  return [
    "char",
    "character",
    "varchar",
    "character varying",
    "text",
    "tinytext",
    "mediumtext",
    "longtext",
    "enum",
    "set",
  ].includes(type.toLowerCase());
}

export function getSchemaDifferences(
  source: Map<string, ColumnShape[]>,
  target: Map<string, ColumnShape[]>,
  targetOnlyTables: Set<string>,
  optionalTables: Set<string> = OPTIONAL_FEATURE_TABLES
): string[] {
  const errors: string[] = [];
  const sourceNames = new Set(source.keys());
  const targetNames = new Set(target.keys());

  for (const table of sourceNames) {
    if (!targetNames.has(table))
      errors.push(`PostgreSQL is missing table ${table}`);
  }
  for (const table of targetNames) {
    if (!sourceNames.has(table) && !targetOnlyTables.has(table) && !optionalTables.has(table)) {
      errors.push(`PostgreSQL has unexpected table ${table}`);
    }
  }
  for (const table of targetOnlyTables) {
    if (!targetNames.has(table))
      errors.push(`PostgreSQL is missing expected new table ${table}`);
  }

  for (const table of sourceNames) {
    const sourceColumns = source.get(table);
    const targetColumns = target.get(table);
    if (!sourceColumns || !targetColumns) continue;
    const sourceSet = new Set(sourceColumns.map(column => destinationColumnName(table, column.name)));
    if (sourceSet.size !== sourceColumns.length) errors.push(`MySQL alias collision in ${table}`);
    if (table === "reply_threads") {
      for (const [oldName, newName] of Object.entries(LEGACY_REPLY_ALIASES)) {
        if (targetColumns.some(c => c.name === oldName) && targetColumns.some(c => c.name === newName))
          errors.push(`PostgreSQL alias collision in ${table}.${oldName}/${newName}`);
      }
    }
    const targetSet = new Set(targetColumns.map(column => column.name));
    for (const column of sourceSet) {
      if (!targetSet.has(column))
        errors.push(`PostgreSQL is missing ${table}.${column}`);
    }
    for (const column of targetSet) {
      const upgrade = upgradeDefinition(table, targetColumns.find(item => item.name === column)!);
      if (!sourceSet.has(column) && !upgrade)
        errors.push(`PostgreSQL has unexpected column ${table}.${column}`);
    }
    for (const column of sourceColumns) {
      if (column.generated && !(isCanonicalManagerGeneratedColumn(table, column, "mysql")
        && targetColumns.some(targetColumn => targetColumn.name === column.name
          && isCanonicalManagerGeneratedColumn(table, targetColumn, "postgres")))) {
        errors.push(
          `MySQL generated column ${table}.${column.name} cannot be copied`
        );
      }
    }
  }
  for (const [table, targetColumns] of target) {
    for (const column of targetColumns) {
      if (column.generated && !isCanonicalManagerGeneratedColumn(table, column, "postgres")) {
        errors.push(
          `PostgreSQL generated column ${table}.${column.name} cannot be copied`
        );
      }
    }
  }
  return errors.sort();
}

export function orderTablesByDependencies(
  tableNames: string[],
  dependencies: Array<{ table: string; dependsOn: string }>
): string[] {
  const tables = new Set(tableNames);
  const incoming = new Map(tableNames.map(table => [table, new Set<string>()]));
  const dependents = new Map(
    tableNames.map(table => [table, new Set<string>()])
  );

  for (const edge of dependencies) {
    if (!tables.has(edge.table) || !tables.has(edge.dependsOn)) continue;
    incoming.get(edge.table)!.add(edge.dependsOn);
    dependents.get(edge.dependsOn)!.add(edge.table);
  }

  const ready = [...tableNames]
    .filter(table => incoming.get(table)!.size === 0)
    .sort();
  const ordered: string[] = [];
  while (ready.length) {
    const table = ready.shift()!;
    ordered.push(table);
    for (const dependent of dependents.get(table)!) {
      const pending = incoming.get(dependent)!;
      pending.delete(table);
      if (pending.size === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== tables.size) {
    const cyclic = [...tables].filter(table => !ordered.includes(table)).sort();
    throw new Error(
      `Foreign-key cycle prevents a safe import order: ${cyclic.join(", ")}`
    );
  }
  return ordered;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function transformSourceValue(
  value: unknown,
  targetType: string,
  location: string
): unknown {
  if (value == null) return null;
  const type = targetType.toLowerCase();
  if (type === "boolean" || type === "bool") {
    if (value === true || value === 1 || value === "1" || value === "true")
      return true;
    if (value === false || value === 0 || value === "0" || value === "false")
      return false;
    throw new Error(
      `${location} contains a value that cannot be converted to PostgreSQL boolean`
    );
  }
  if (
    (type === "date" || type.startsWith("timestamp")) &&
    typeof value === "string" &&
    /^0000-00-00/.test(value)
  ) {
    throw new Error(
      `${location} contains a MySQL zero date; resolve it explicitly before migration`
    );
  }
  return value;
}

function normalizeTemporal(value: string): string {
  return value
    .replace("T", " ")
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

export function canonicalizeCell(
  value: unknown,
  sourceType: string,
  targetType: string,
  location: string
): unknown {
  if (value == null) return null;
  const source = sourceType.toLowerCase();
  const target = targetType.toLowerCase();

  if (target === "boolean" || target === "bool") {
    return transformSourceValue(value, target, location);
  }
  if (source === "json" || target === "json" || target === "jsonb") {
    let parsed = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`${location} contains invalid JSON`);
      }
    }
    return stableJson(parsed);
  }
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (target === "date" || target.startsWith("timestamp")) {
    return normalizeTemporal(String(value));
  }
  if (
    [
      "smallint",
      "integer",
      "bigint",
      "numeric",
      "decimal",
      "real",
      "double precision",
    ].includes(target)
  ) {
    return String(value);
  }
  if (typeof value === "object") return stableJson(value);
  return String(value);
}

export function createRowDigest() {
  const hash = createHash("sha256");
  return {
    add(values: unknown[]) {
      hash.update(JSON.stringify(values));
      hash.update("\n");
    },
    digest() {
      return hash.digest("hex");
    },
  };
}
