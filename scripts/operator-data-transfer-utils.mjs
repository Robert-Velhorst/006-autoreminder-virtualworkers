import { createHash } from "node:crypto";
import pg from "pg";

export const TRANSFER_EXPORT_FORMAT = "joyce-operator-export-v2";
const CREDENTIAL_REASON = "credential-setting-private-restoration-required";

// These operational tables use users.id, not va_profiles.id. Historical mixed
// profile-ID rows require a separately reviewed migration, not implicit remapping.
const USER_SCOPED_TABLES = new Set([
  "app_settings", "aptlss_plans", "aptlss_steps", "card_states", "priority_scores", "daily_plans",
  "aptlss_audit_log", "daily_compliance_snapshots", "time_entries", "aptlss_assessments",
  "aptlss_assessment_feedback", "aptlss_waiting_reasons", "decision_outcomes", "workspace_evidence_items",
  "communication_evidence", "compliance_card_evidence", "compliance_communication_evidence",
  "compliance_clarification_requests", "browser_tab_states", "browser_tab_daily_evidence",
]);

const SENSITIVE_SETTING_NAMES = new Set([
  "key",
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "authorization",
  "private",
]);

function containsSensitiveSettingName(key) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return words.some(word => SENSITIVE_SETTING_NAMES.has(word));
}

function credentialSetting(row) {
  if (typeof row.key !== "string" || !row.key) throw new Error("Invalid setting key");
  if (containsSensitiveSettingName(row.key) || /^googleEvidenceOAuthState(?::|$)/.test(row.key)) return true;
  const embeddedCredential = value => value && typeof value === "object"
    && Object.entries(value).some(([key, item]) => containsSensitiveSettingName(key) || embeddedCredential(item));
  try { return Boolean(embeddedCredential(JSON.parse(row.value))); } catch { return false; }
}

export function redactSensitiveSettings(rows) {
  const result = { rows: [], credentialOmissions: [] };
  for (const row of rows) {
    if (credentialSetting(row)) {
      result.credentialOmissions.push({ table: "app_settings", id: positiveId(row.id),
        vaId: row.vaId === null ? null : positiveId(row.vaId), key: row.key, reason: CREDENTIAL_REASON });
    } else result.rows.push({ ...row });
  }
  return result;
}

export function quoteIdentifier(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Invalid SQL identifier");
  return pg.escapeIdentifier(value);
}

function positiveId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Worker/founder/record identity must be a positive safe integer");
  }
  return Number(value);
}

export function transferIdentity(workerUserId, founderUserId, workerProfileId) {
  return { workerUserId: positiveId(workerUserId), founderUserId: positiveId(founderUserId), workerProfileId: positiveId(workerProfileId) };
}

function fingerprint(value) {
  if (typeof value !== "string" || !value) throw new Error("Missing principal identity");
  return createHash("sha256").update(value).digest("hex");
}

export function sourceIdentity(row) {
  return {
    ...transferIdentity(row.workerUserId, row.founderUserId, row.workerProfileId),
    workerPrincipal: fingerprint(row.workerOpenId),
    founderPrincipal: fingerprint(row.founderOpenId),
    trelloPrincipal: row.trelloMemberId == null ? null : fingerprint(row.trelloMemberId),
  };
}

export function validateTransferPayload(payload, definitions, identity) {
  transferIdentity(identity.workerUserId, identity.founderUserId, identity.workerProfileId);
  if (payload.format !== TRANSFER_EXPORT_FORMAT || !payload.tables || !payload.counts
    || !Array.isArray(payload.skipped) || payload.skipped.length) throw new Error("Incomplete export or skipped source tables");
  if (!Array.isArray(payload.credentialOmissions)) throw new Error("Missing credential omission manifest");
  const settingKeys = new Set();
  const settingIds = new Set();
  for (const omission of payload.credentialOmissions) {
    if (!omission || omission.table !== "app_settings" || omission.reason !== CREDENTIAL_REASON
      || typeof omission.key !== "string" || !omission.key
      || Object.keys(omission).sort().join(",") !== "id,key,reason,table,vaId"
      || (omission.vaId !== null && positiveId(omission.vaId) !== identity.workerUserId)) {
      throw new Error("Unrecognized credential omission or ownership");
    }
    const id = positiveId(omission.id);
    if (settingIds.has(id) || settingKeys.has(omission.key)) throw new Error("Duplicate credential omission key/ID");
    settingIds.add(id);
    settingKeys.add(omission.key);
  }
  if (payload.credentialOmissions.length && !definitions.some(table => table.name === "app_settings")) throw new Error("Omissions require canonical app_settings");
  for (const row of payload.tables.app_settings || []) {
    if (credentialSetting(row)) throw new Error("Credential setting must be omitted, never exported as data");
    const id = positiveId(row.id);
    if (settingIds.has(id) || settingKeys.has(row.key)) throw new Error("Setting data/omission key or ID collision");
    settingIds.add(id);
    settingKeys.add(row.key);
  }
  const names = new Set(definitions.map(table => table.name));
  if (Object.keys(payload.tables).some(name => !names.has(name))
    || Object.keys(payload.counts).some(name => !names.has(name))) throw new Error("Unsupported source tables");
  for (const { name } of definitions) {
    const omitted = name === "app_settings" ? payload.credentialOmissions.length : 0;
    if (!Array.isArray(payload.tables[name]) || payload.counts[name] !== payload.tables[name].length + omitted) {
      throw new Error(`Missing or inconsistent source rows/counts: ${name}`);
    }
  }
  // Numeric IDs alone cannot distinguish independently initialized accounts.
  // Unscoped legacy tables make multi-worker exports unsafe to remap implicitly.
  const source = payload.identities?.[0];
  if (!Array.isArray(payload.identities) || payload.identities.length !== 1 || !source
    || source.workerUserId !== identity.workerUserId || source.founderUserId !== identity.founderUserId
    || source.workerProfileId !== identity.workerProfileId
    || ![source.workerPrincipal, source.founderPrincipal].every(value => /^[a-f0-9]{64}$/.test(value))
    || !(source.trelloPrincipal === null || /^[a-f0-9]{64}$/.test(source.trelloPrincipal))) {
    throw new Error("Require a source-bound single-worker export and matching worker/founder IDs; re-export legacy data to a new private path");
  }
  return source;
}

export function validateTargetIdentity(source, targetRows, identity) {
  if (targetRows.length !== 1) throw new Error("Target worker/founder identity missing or ambiguous");
  const target = targetRows[0];
  if (Number(target.workerUserId) !== identity.workerUserId || Number(target.founderUserId) !== identity.founderUserId
    || Number(target.workerProfileId) !== identity.workerProfileId
    || target.workerRole !== "worker" || target.founderRole !== "admin" || target.workerStatus !== "active"
    || source.workerPrincipal !== fingerprint(target.workerOpenId)
    || source.founderPrincipal !== fingerprint(target.founderOpenId)
    || source.trelloPrincipal !== (target.trelloMemberId == null ? null : fingerprint(target.trelloMemberId))) {
    throw new Error("Target worker/founder principal or ownership mismatch");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  if (value === undefined || (typeof value === "number" && (!Number.isFinite(value)
    || (Number.isInteger(value) && !Number.isSafeInteger(value))))) throw new Error("Unrepresentable JSON value");
  return JSON.stringify(value);
}

export function canonicalColumnValue(value, column) {
  if (value === null) return null;
  if (value === undefined) throw new Error(`Missing column value: ${column.column_name}`);
  const type = column.data_type;
  if (["json", "jsonb"].includes(type)) return canonicalJson(typeof value === "string" ? JSON.parse(value) : value);
  if (["smallint", "integer", "bigint", "numeric", "decimal", "real", "double precision"].includes(type)) {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value));
    if (!match || (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))) throw new Error("Unsafe numeric value");
    const whole = BigInt(match[2]).toString();
    const fraction = (match[3] || "").replace(/0+$/, "");
    if (["smallint", "integer", "bigint"].includes(type) && fraction) throw new Error("Noninteger key/identity");
    return `${match[1] === "-" && (whole !== "0" || fraction) ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
  }
  if (type === "boolean") {
    if ([true, 1, "1", "true"].includes(value)) return true;
    if ([false, 0, "0", "false"].includes(value)) return false;
    throw new Error("Invalid boolean value");
  }
  if (type === "timestamp without time zone" || type === "date") {
    const match = typeof value === "string" && (type === "date"
      ? /^(\d{4}-\d{2}-\d{2})$/
      : /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/).exec(value);
    if (!match || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]
      || (match[2] && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(match[2]))) throw new Error("Invalid date/time value");
    return type === "date" ? match[1] : `${match[1]} ${match[2]}.${(match[3] || "").padEnd(6, "0")}`;
  }
  if (["text", "character varying", "character", "USER-DEFINED", "uuid"].includes(type) && typeof value === "string") return value;
  throw new Error(`Unsupported column type/value: ${column.column_name}`);
}

export function prepareTransferRow(source, columns, identity, table) {
  if (!source || Array.isArray(source) || typeof source !== "object") throw new Error(`Invalid source row: ${table}`);
  const metadata = new Map(columns.map(column => [column.column_name, column]));
  if (Object.keys(source).some(key => !metadata.has(key))) throw new Error(`Unmapped source columns: ${table}`);
  for (const [column, id] of [["vaId", identity.workerUserId], ["founderId", identity.founderUserId]]) {
    if (!metadata.has(column)) continue;
    if (column === "vaId") {
      if (!USER_SCOPED_TABLES.has(table)) throw new Error(`Unreviewed vaId semantics: ${table}`);
      if (table === "app_settings" && source.vaId === null && metadata.get(column).is_nullable === "YES") continue;
    }
    if (positiveId(source[column]) !== id) throw new Error(`Source ownership mismatch: ${table}.${column}`);
  }
  const row = { ...source };
  for (const column of columns) {
    const name = column.column_name;
    if (!Object.hasOwn(row, name) && column.is_nullable === "NO" && !column.column_default && column.is_identity !== "YES") {
      throw new Error(`Required source column missing: ${table}.${name}`);
    }
  }
  for (const [name, value] of Object.entries(row)) {
    const column = metadata.get(name);
    canonicalColumnValue(value, column);
    if (value === null && column.is_nullable === "NO") throw new Error(`Null required source column: ${table}.${name}`);
    if (["json", "jsonb"].includes(column.data_type) && value !== null && typeof value !== "string") row[name] = JSON.stringify(value);
  }
  return row;
}

export function sameTransferRecord(expected, actual, columns) {
  return Object.keys(expected).every(name => Object.hasOwn(actual, name)
    && canonicalColumnValue(expected[name], columns.find(column => column.column_name === name))
      === canonicalColumnValue(actual[name], columns.find(column => column.column_name === name)));
}

export function sequenceRestartValue(maximum, lastValue, isCalled) {
  const next = BigInt(lastValue) + (isCalled ? 1n : 0n);
  const afterRows = maximum == null ? 1n : BigInt(maximum) + 1n;
  return (next > afterRows ? next : afterRows).toString();
}

export async function advanceTransferSequences(connection, table, columns) {
  for (const column of columns.filter(item => item.is_identity === "YES" || /^nextval\(/.test(item.column_default || ""))) {
    const { rows } = await connection.query(`
      SELECT n.nspname AS schema, c.relname AS name, s.seqincrement::text AS increment,
             s.seqcache::text AS cache, s.seqcycle AS cycle, s.seqmax::text AS maximum
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_sequence s ON s.seqrelid = c.oid
      WHERE c.oid = pg_get_serial_sequence(format('%I.%I', current_schema(), $1::text), $2::text)::regclass`, [table, column.column_name]);
    if (rows.length !== 1 || rows[0].increment !== "1" || rows[0].cache !== "1" || rows[0].cycle) {
      throw new Error(`Unsupported identity sequence: ${table}.${column.column_name}`);
    }
    const sequence = `${quoteIdentifier(rows[0].schema)}.${quoteIdentifier(rows[0].name)}`;
    // Acquire the sequence DDL lock before reading its high-water mark; CACHE is unchanged.
    await connection.query(`ALTER SEQUENCE ${sequence} CACHE 1`);
    const state = await connection.query(`SELECT last_value::text, is_called FROM ${sequence}`);
    const maximum = await connection.query(`SELECT MAX(${quoteIdentifier(column.column_name)})::text AS maximum FROM ${quoteIdentifier(table)}`);
    const next = sequenceRestartValue(maximum.rows[0].maximum, state.rows[0].last_value, state.rows[0].is_called);
    if (!/^[1-9][0-9]*$/.test(next)) throw new Error(`Invalid identity sequence restart: ${table}.${column.column_name}`);
    if (BigInt(next) > BigInt(rows[0].maximum)) throw new Error(`Identity sequence exhausted: ${table}.${column.column_name}`);
    // RESTART is transactional; setval would survive a later rollback.
    await connection.query(`ALTER SEQUENCE ${sequence} RESTART WITH ${next}`);
  }
}

export async function transferOperatorRecords(connection, payload, definitions, { identity, execute = false, reconcile = false, acknowledgeCredentialOmissions = false }) {
  const sourceIdentity = validateTransferPayload(payload, definitions, identity);
  if (execute && !reconcile && payload.credentialOmissions.length && !acknowledgeCredentialOmissions) {
    throw new Error("Acknowledge credential omissions before data-only import; restore credentials separately in private");
  }
  const report = { success: false, applied: false, dataCheckPassed: false,
    completion: payload.credentialOmissions.length ? "private-credential-restoration-required" : "complete",
    credentialOmissions: structuredClone(payload.credentialOmissions),
    credentialPolicy: acknowledgeCredentialOmissions ? "acknowledged-private-restoration" : "unacknowledged",
    mode: reconcile ? "reconcile" : execute ? "import" : "dry-run", identity, tables: {} };
  await connection.query(execute && !reconcile ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await connection.query("SET LOCAL lock_timeout = '10s'");
    await connection.query("SET LOCAL statement_timeout = '30s'");
    if (execute && !reconcile) {
      const tables = [...new Set(["users", "va_profiles", ...definitions.map(item => item.name)])].sort();
      await connection.query(`LOCK TABLE ${tables.map(quoteIdentifier).join(", ")} IN ACCESS EXCLUSIVE MODE`);
    }
    const target = await connection.query(`
      SELECT p.id AS "workerProfileId", p."userId" AS "workerUserId", p."founderId" AS "founderUserId", p.status AS "workerStatus", u.role AS "workerRole",
             p."trelloMemberId" AS "trelloMemberId", u."openId" AS "workerOpenId",
             f."openId" AS "founderOpenId", f.role AS "founderRole"
      FROM va_profiles p JOIN users u ON u.id = p."userId" JOIN users f ON f.id = p."founderId"
      WHERE p."userId" = $1 AND p."founderId" = $2`, [identity.workerUserId, identity.founderUserId]);
    validateTargetIdentity(sourceIdentity, target.rows, identity);
    const sequences = [];
    for (const { name, keys } of definitions) {
      const { rows: columns } = await connection.query(`
        SELECT column_name, data_type, is_nullable, column_default, is_identity
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'NEVER'`, [name]);
      if (!columns.length) throw new Error(`Target table missing: ${name}`);
      const seen = new Set();
      const ids = new Set();
      const counts = report.tables[name] = { source: payload.counts[name],
        credentialOmissions: name === "app_settings" ? payload.credentialOmissions.length : 0,
        inserted: 0, identical: 0, wouldInsert: 0 };
      for (const source of payload.tables[name]) {
        const row = prepareTransferRow(source, columns, identity, name);
        if (!keys.every(key => row[key] != null)) throw new Error(`Source natural key missing: ${name}`);
        if (columns.some(column => column.column_name === "id") && row.id == null) throw new Error(`Source record ID missing: ${name}`);
        const signature = JSON.stringify(keys.map(key => canonicalColumnValue(row[key], columns.find(column => column.column_name === key))));
        const id = row.id == null ? null : canonicalColumnValue(row.id, columns.find(column => column.column_name === "id"));
        if (seen.has(signature) || (id !== null && ids.has(id))) throw new Error(`Duplicate source key/ID: ${name}`);
        seen.add(signature);
        if (id !== null) ids.add(id);
        const values = keys.map(key => row[key]);
        let predicate = `(${keys.map((key, index) => `${quoteIdentifier(key)} = $${index + 1}`).join(" AND ")})`;
        if (row.id != null && !keys.includes("id")) {
          values.push(row.id);
          predicate += ` OR "id" = $${values.length}`;
        }
        const existing = await connection.query(`SELECT * FROM ${quoteIdentifier(name)} WHERE ${predicate}`, values);
        if (existing.rows.length) {
          if (existing.rows.length !== 1 || !sameTransferRecord(row, existing.rows[0], columns)) throw new Error(`Target key/content/ownership collision: ${name}`);
          counts.identical++;
        } else {
          if (reconcile) throw new Error(`Source record missing from target: ${name}`);
          if (execute) {
            const names = Object.keys(row);
            const inserted = await connection.query(`INSERT INTO ${quoteIdentifier(name)} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`, names.map(key => row[key]));
            if (inserted.rows.length !== 1 || !sameTransferRecord(row, inserted.rows[0], columns)) throw new Error(`Inserted content does not match source: ${name}`);
            counts.inserted++;
          } else counts.wouldInsert++;
        }
      }
      // Also repair verified rows left by an earlier import with stale sequences.
      if (execute && !reconcile && payload.tables[name].length) sequences.push({ name, columns });
    }
    for (const { name, columns } of sequences) await advanceTransferSequences(connection, name, columns);
    await connection.query(execute && !reconcile ? "COMMIT" : "ROLLBACK");
    report.success = payload.credentialOmissions.length === 0;
    report.dataCheckPassed = true;
    report.applied = execute && !reconcile;
    return report;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}
