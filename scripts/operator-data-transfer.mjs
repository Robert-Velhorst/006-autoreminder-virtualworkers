import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import pg from "pg";
import { classifyBrowserCollectorImport } from "./operator-data-transfer-ownership.mjs";
import { redactSensitiveSettings } from "./operator-data-transfer-utils.mjs";

const TABLES = [
  { name: "app_settings", keys: ["key"] },
  { name: "aptlss_plans", keys: ["vaId", "cardId"] },
  { name: "aptlss_steps", keys: ["id"] },
  { name: "card_states", keys: ["vaId", "cardId"] },
  { name: "priority_scores", keys: ["vaId", "cardId"] },
  { name: "daily_plans", keys: ["vaId", "dateKey"] },
  { name: "aptlss_audit_log", keys: ["id"] },
  { name: "daily_compliance_snapshots", keys: ["vaId", "snapshotDate"] },
  { name: "time_entries", keys: ["id"] },
  { name: "aptlss_assessments", keys: ["id"] },
  { name: "aptlss_assessment_feedback", keys: ["assessmentId"] },
  { name: "aptlss_waiting_reasons", keys: ["id"] },
  { name: "decision_outcomes", keys: ["stepId"] },
  { name: "workspace_evidence_items", keys: ["vaId", "source", "sourceId"] },
  { name: "workspace_evidence_links", keys: ["evidenceId", "cardId"] },
  { name: "communication_evidence", keys: ["vaId", "channel", "externalId"] },
  { name: "compliance_card_evidence", keys: ["vaId", "snapshotDate", "cardId"] },
  { name: "compliance_communication_evidence", keys: ["vaId", "snapshotDate", "evidenceKey"] },
  { name: "compliance_clarification_requests", keys: ["vaId", "snapshotDate", "evidenceKey"] },
  { name: "time_day_reviews", keys: ["dateKey"] },
  { name: "time_entry_events", keys: ["id"] },
  { name: "time_reconciliation_items", keys: ["fingerprint"] },
  { name: "scheduled_job_runs", keys: ["id"] },
  { name: "scheduled_job_leases", keys: ["jobKey"] },
  { name: "browser_tab_states", keys: ["collectorId"] },
  { name: "browser_tab_daily_evidence", keys: ["vaId", "snapshotDate"] },
];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function quoteMysql(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) throw new Error(`Unsafe identifier: ${identifier}`);
  return `\`${identifier}\``;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function connect(url) {
  if (!url?.startsWith("mysql://")) throw new Error("A MySQL connection URL is required");
  return mysql.createConnection({ uri: url, dateStrings: true, multipleStatements: false });
}

async function mysqlTableExists(connection, table) {
  const [rows] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [table],
  );
  return Number(rows[0]?.count ?? 0) === 1;
}

function quote(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) throw new Error(`Unsafe identifier: ${identifier}`);
  return `"${identifier}"`;
}

async function connectTarget(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL target connection URL is required");
  if (process.env.NODE_ENV === "production" && (url.searchParams.getAll("sslmode").length !== 1
    || url.searchParams.get("sslmode") !== "verify-full" || url.searchParams.has("ssl"))) {
    throw new Error("Production PostgreSQL targets require sslmode=verify-full with no ssl override");
  }
  const client = new pg.Client({ connectionString: value, connectionTimeoutMillis: 10000 });
  await client.connect();
  return client;
}

async function tableExists(connection, table) {
  const { rows } = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1", [table]);
  return Number(rows[0]?.count ?? 0) === 1;
}

async function exportData() {
  const sourceUrl = option("--source", process.env.LEGACY_MYSQL_DATABASE_URL);
  const output = path.resolve(option("--out", ".local/operator-export.json"));
  const connection = await connect(sourceUrl);
  try {
    const datasets = {};
    const skipped = [];
    for (const table of TABLES) {
      if (!(await mysqlTableExists(connection, table.name))) {
        skipped.push(table.name);
        continue;
      }
      const [rows] = await connection.query(`SELECT * FROM ${quoteMysql(table.name)}`);
      datasets[table.name] = table.name === "app_settings" ? redactSensitiveSettings(rows) : rows;
    }
    const payload = {
      format: "joyce-operator-export-v1",
      createdAt: new Date().toISOString(),
      tables: datasets,
      skipped,
      counts: Object.fromEntries(Object.entries(datasets).map(([name, rows]) => [name, rows.length])),
    };
    payload.digest = digest(payload);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ success: true, output, counts: payload.counts, skipped }, null, 2));
  } finally {
    await connection.end();
  }
}

async function loadExport() {
  const input = path.resolve(option("--in", ".local/operator-export.json"));
  const payload = JSON.parse(await readFile(input, "utf8"));
  if (payload.format !== "joyce-operator-export-v1") throw new Error("Unsupported export format");
  const suppliedDigest = payload.digest;
  delete payload.digest;
  if (suppliedDigest !== digest(payload)) throw new Error("Export digest verification failed");
  payload.digest = suppliedDigest;
  return { input, payload };
}

async function importData() {
  const { input, payload } = await loadExport();
  const targetUrl = option("--target", process.env.TARGET_DATABASE_URL);
  const workerId = Number(option("--worker-id", process.env.OPERATOR_IMPORT_WORKER_ID));
  const founderId = Number(option("--founder-id", process.env.OPERATOR_IMPORT_FOUNDER_ID));
  const connection = await connectTarget(targetUrl);
  const report = {
    insertedOrUpdated: {},
    skipped: [],
    conflicts: [],
    identityMapping: {
      workerId: Number.isInteger(workerId) && workerId > 0 ? workerId : null,
      founderId: Number.isInteger(founderId) && founderId > 0 ? founderId : null,
    },
  };
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '10s'");
    for (const definition of TABLES) {
      const rows = payload.tables[definition.name] ?? [];
      if (!rows.length) continue;
      if (!(await tableExists(connection, definition.name))) {
        report.skipped.push({ table: definition.name, reason: "target table missing" });
        continue;
      }
      const { rows: columnRows } = await connection.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'NEVER'", [definition.name]);
      const allowedColumns = new Set(columnRows.map((item) => item.column_name));
      if (definition.name === "browser_tab_states"
        && (!["captureSequence", "sourceCapturedAt"].every((column) => allowedColumns.has(column)))) {
        report.skipped.push({ table: definition.name, reason: "apply the PostgreSQL browser collector migrations before importing browser collector data" });
        continue;
      }
      await connection.query(`LOCK TABLE ${quote(definition.name)} IN SHARE ROW EXCLUSIVE MODE`);
      let processed = 0;
      for (const sourceRow of rows) {
        const row = { ...sourceRow };
        for (const column of columnRows) {
          if (["json", "jsonb"].includes(column.data_type) && row[column.column_name] != null
            && typeof row[column.column_name] === "object") {
            row[column.column_name] = JSON.stringify(row[column.column_name]);
          }
        }
        if (allowedColumns.has("vaId") && row.vaId == null) {
          if (!Number.isInteger(workerId) || workerId <= 0) {
            throw new Error(`${definition.name} requires --worker-id because the source row has no developer identity`);
          }
          row.vaId = workerId;
        }
        if (allowedColumns.has("founderId") && row.founderId == null) {
          if (!Number.isInteger(founderId) || founderId <= 0) {
            throw new Error(`${definition.name} requires --founder-id because the source row has no developer identity`);
          }
          row.founderId = founderId;
        }
        if (definition.name === "time_entries" && row.taskId == null && row.cardId != null) {
          row.taskId = row.cardId;
        }
        const columns = Object.keys(row).filter((column) => allowedColumns.has(column));
        if (!definition.keys.every((key) => columns.includes(key))) {
          report.conflicts.push({ table: definition.name, keys: definition.keys, reason: "natural key missing" });
          continue;
        }
        if (definition.name === "browser_tab_states") {
          const { rows: existingRows } = await connection.query(
            `SELECT * FROM ${quote(definition.name)} WHERE "collectorId" = $1 OR ("id" = $2) FOR UPDATE`,
            [row.collectorId, row.id ?? null],
          );
          const decision = classifyBrowserCollectorImport(existingRows, row);
          if (decision.action === "skip") {
            report.skipped.push({ table: definition.name, collectorId: row.collectorId, reason: decision.reason });
            continue;
          }
          if (decision.action === "conflict") {
            report.conflicts.push({ table: definition.name, collectorId: row.collectorId, reason: decision.reason });
            continue;
          }
          if (decision.action === "insert") {
            await connection.query(
              `INSERT INTO ${quote(definition.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
              columns.map((column) => row[column]),
            );
          } else {
            const updateColumns = columns.filter((column) => !["id", "vaId", "collectorId"].includes(column));
            const assignments = updateColumns.map((column, index) => `${quote(column)} = $${index + 1}`).join(", ");
            const result = await connection.query(
              `UPDATE ${quote(definition.name)} SET ${assignments} WHERE "id" = $${updateColumns.length + 1} AND "vaId" = $${updateColumns.length + 2} AND "collectorId" = $${updateColumns.length + 3} AND "captureSequence" < $${updateColumns.length + 4}`,
              [
                ...updateColumns.map((column) => row[column]),
                decision.existing.id,
                row.vaId,
                row.collectorId,
                Number(row.captureSequence ?? 0),
              ],
            );
            if (result.rowCount !== 1) throw new Error(`Browser collector changed during import: ${row.collectorId}`);
          }
          processed += 1;
          continue;
        }
        const updateColumns = columns.filter((column) => column !== "id" && !definition.keys.includes(column));
        const sql = `INSERT INTO ${quote(definition.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT (${definition.keys.map(quote).join(",")}) ${updateColumns.length ? `DO UPDATE SET ${updateColumns.map((column) => `${quote(column)}=EXCLUDED.${quote(column)}`).join(",")}` : "DO NOTHING"}`;
        await connection.query(sql, columns.map((column) => row[column]));
        processed += 1;
      }
      report.insertedOrUpdated[definition.name] = processed;
    }
    await connection.query("COMMIT");
    console.log(JSON.stringify({ success: true, input, ...report }, null, 2));
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    await connection.end();
  }
}

async function reconcileData() {
  const { input, payload } = await loadExport();
  const targetUrl = option("--target", process.env.TARGET_DATABASE_URL);
  const connection = await connectTarget(targetUrl);
  try {
    const counts = {};
    for (const definition of TABLES) {
      if (!(await tableExists(connection, definition.name))) {
        counts[definition.name] = { source: payload.counts[definition.name] ?? 0, target: null, status: "missing" };
        continue;
      }
      const { rows } = await connection.query(`SELECT COUNT(*) AS count FROM ${quote(definition.name)}`);
      const source = payload.counts[definition.name] ?? 0;
      const target = Number(rows[0]?.count ?? 0);
      counts[definition.name] = { source, target, status: target >= source ? "preserved" : "short" };
    }
    const success = Object.values(counts).every((row) => row.status === "preserved");
    console.log(JSON.stringify({ success, input, counts }, null, 2));
    if (!success) process.exitCode = 2;
  } finally {
    await connection.end();
  }
}

const command = process.argv[2];
if (command === "export") await exportData();
else if (command === "import") await importData();
else if (command === "reconcile") await reconcileData();
else throw new Error("Usage: operator-data-transfer.mjs <export|import|reconcile> [options]");
