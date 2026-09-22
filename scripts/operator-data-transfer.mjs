import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

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

function quote(identifier) {
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

async function tableExists(connection, table) {
  const [rows] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [table],
  );
  return Number(rows[0]?.count ?? 0) === 1;
}

async function exportData() {
  const sourceUrl = option("--source", process.env.DATABASE_URL);
  const output = path.resolve(option("--out", ".local/operator-export.json"));
  const connection = await connect(sourceUrl);
  try {
    const datasets = {};
    const skipped = [];
    for (const table of TABLES) {
      if (!(await tableExists(connection, table.name))) {
        skipped.push(table.name);
        continue;
      }
      const [rows] = await connection.query(`SELECT * FROM ${quote(table.name)}`);
      datasets[table.name] = rows;
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
  const connection = await connect(targetUrl);
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
    await connection.beginTransaction();
    for (const definition of TABLES) {
      const rows = payload.tables[definition.name] ?? [];
      if (!rows.length) continue;
      if (!(await tableExists(connection, definition.name))) {
        report.skipped.push({ table: definition.name, reason: "target table missing" });
        continue;
      }
      const [columnRows] = await connection.query(`SHOW COLUMNS FROM ${quote(definition.name)}`);
      const allowedColumns = new Set(columnRows.map((item) => item.Field));
      let processed = 0;
      for (const sourceRow of rows) {
        const row = { ...sourceRow };
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
        const updateColumns = columns.filter((column) => column !== "id" && !definition.keys.includes(column));
        const sql = `INSERT INTO ${quote(definition.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON DUPLICATE KEY UPDATE ${updateColumns.length ? updateColumns.map((column) => `${quote(column)}=VALUES(${quote(column)})`).join(",") : `${quote(definition.keys[0])}=VALUES(${quote(definition.keys[0])})`}`;
        await connection.execute(sql, columns.map((column) => row[column]));
        processed += 1;
      }
      report.insertedOrUpdated[definition.name] = processed;
    }
    await connection.commit();
    console.log(JSON.stringify({ success: true, input, ...report }, null, 2));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

async function reconcileData() {
  const { input, payload } = await loadExport();
  const targetUrl = option("--target", process.env.TARGET_DATABASE_URL);
  const connection = await connect(targetUrl);
  try {
    const counts = {};
    for (const definition of TABLES) {
      if (!(await tableExists(connection, definition.name))) {
        counts[definition.name] = { source: payload.counts[definition.name] ?? 0, target: null, status: "missing" };
        continue;
      }
      const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${quote(definition.name)}`);
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
