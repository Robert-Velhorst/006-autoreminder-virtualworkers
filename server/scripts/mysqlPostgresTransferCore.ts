import { createHash } from "node:crypto";

export type ColumnShape = {
  name: string;
  dataType: string;
  columnType?: string;
  generated?: boolean;
  nullable?: boolean;
};

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
  targetOnlyTables: Set<string>
): string[] {
  const errors: string[] = [];
  const sourceNames = new Set(source.keys());
  const targetNames = new Set(target.keys());

  for (const table of sourceNames) {
    if (!targetNames.has(table))
      errors.push(`PostgreSQL is missing table ${table}`);
  }
  for (const table of targetNames) {
    if (!sourceNames.has(table) && !targetOnlyTables.has(table)) {
      errors.push(`PostgreSQL has unexpected table ${table}`);
    }
  }
  for (const table of targetOnlyTables) {
    if (sourceNames.has(table))
      errors.push(`Table ${table} must be copied from MySQL, not skipped`);
    if (!targetNames.has(table))
      errors.push(`PostgreSQL is missing expected new table ${table}`);
  }

  for (const table of sourceNames) {
    const sourceColumns = source.get(table);
    const targetColumns = target.get(table);
    if (!sourceColumns || !targetColumns) continue;
    const sourceSet = new Set(sourceColumns.map(column => column.name));
    const targetSet = new Set(targetColumns.map(column => column.name));
    for (const column of sourceSet) {
      if (!targetSet.has(column))
        errors.push(`PostgreSQL is missing ${table}.${column}`);
    }
    for (const column of targetSet) {
      const reviewOnlyTimerColumn = table === 'time_entries' && ['trackedUserId', 'trackedProfileId'].includes(column)
        && targetColumns.find(item => item.name === column)?.nullable === true
        && targetColumns.find(item => item.name === column)?.dataType === 'integer';
      if (!sourceSet.has(column) && !reviewOnlyTimerColumn)
        errors.push(`PostgreSQL has unexpected column ${table}.${column}`);
    }
    for (const column of sourceColumns) {
      if (column.generated) {
        errors.push(
          `MySQL generated column ${table}.${column.name} cannot be copied`
        );
      }
    }
    for (const column of targetColumns) {
      if (column.generated) {
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
