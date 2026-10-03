import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import mysql from "mysql2";
import { assertSingleAptlssPilotWorkerId } from "./aptlss-pilot-validation.mjs";
import { fingerprintTable } from "./operational-record-fingerprint.mjs";

// Read-only verification. This utility never migrates or restores a database.
const mode = process.argv[2];
if (!["capture", "verify", "status"].includes(mode)) throw new Error("Use capture <manifest>, verify <manifest>, or status");
const root = path.resolve(".local/pilot");
const projectDirectory = path.resolve(process.env.PILOT_PROJECT_DIRECTORY || "../joyce-work-schedule");
const config = parse(fs.readFileSync(path.join(projectDirectory, ".env.db.local")));
if (config.MYSQL_DATABASE !== "joyce_work_schedule_consolidated" || String(config.MYSQL_PORT || 3307) !== "3307") {
  throw new Error("The previously verified operational database on loopback port 3307 is required");
}
const file = mode === "status" ? null : path.resolve(process.argv[3] || "");
if (file && (path.dirname(file) !== root || !/^operational-records-[\w-]+\.json$/.test(path.basename(file)))) {
  throw new Error("Manifest must be named operational-records-<checkpoint>.json under .local/pilot");
}
const escape = value => "`" + value.replace(/`/g, "``") + "`";
const connection = mysql.createConnection({ host: "127.0.0.1", port: 3307, user: "root",
  password: config.MYSQL_ROOT_PASSWORD, database: config.MYSQL_DATABASE, connectTimeout: 10000, dateStrings: true });
const db = connection.promise();
try {
  const workerId = assertSingleAptlssPilotWorkerId(process.env.APTLSS_MANAGER_PILOT_WORKER_IDS);
  await db.query("SET SESSION TRANSACTION READ ONLY");
  await db.beginTransaction();
  const [identity] = await db.execute("SELECT id, role FROM users WHERE id = ?", [workerId]);
  if (identity.length !== 1 || identity[0].role !== "worker") {
    throw new Error("The selected worker profile is missing or is not a worker; do not deploy");
  }
  if (mode === "status") {
    const [states] = await db.query("SELECT vaId, enabled, intervalMinutes, mode, checkedAt, lastError IS NOT NULL AS hasError FROM aptlss_manager_state");
    const [runs] = await db.query("SELECT id, vaId, `trigger` AS triggerName, mode, appliedPlanHash, proposalHash, snapshotJson, createdAt FROM aptlss_manager_runs ORDER BY id DESC LIMIT 10");
    const [ledger] = await db.query("SELECT COUNT(*) AS count FROM __drizzle_migrations");
    const checkpoint = path.join(root, "operational-records-cutover-20260906.json");
    let dailyPlansPreserved = null;
    if (fs.existsSync(checkpoint)) {
      const previous = JSON.parse(fs.readFileSync(checkpoint, "utf8")).daily_plans;
      const plans = await fingerprintTable(connection, "daily_plans", previous.columns);
      dailyPlansPreserved = previous.count === plans.count && previous.hash === plans.hash;
    }
    console.log(JSON.stringify({ states, migrationCount: ledger[0].count, dailyPlansPreserved, runs: runs.map(run => {
      const snapshot = typeof run.snapshotJson === "string" ? JSON.parse(run.snapshotJson) : run.snapshotJson;
      return { id: run.id, vaId: run.vaId, trigger: run.triggerName, createdAt: run.createdAt,
        mode: run.mode, applied: !!run.appliedPlanHash, proposal: !!run.proposalHash,
        semanticSuccess: snapshot?.semanticReview?.success, sourceGapCount: snapshot?.sourceGaps?.length,
        semanticDiagnostic: snapshot?.sourceGaps?.filter(gap => /^(Semantic|Unverified model)/i.test(gap)),
        actionCount: snapshot?.actions?.length, interventionCount: snapshot?.interventions?.length };
    }) }, null, 2));
  } else {
    const previous = mode === "verify" ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const [tables] = await db.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    const manifest = {};
    for (const table of previous ? Object.keys(previous) : tables.map(row => row.name)) {
      if (table === "__drizzle_migrations") continue;
      const [columns] = await db.query(`SHOW COLUMNS FROM ${escape(table)}`);
      const selected = previous?.[table].columns || columns.map(row => row.Field);
      if (selected.some(column => !columns.some(row => row.Field === column))) throw new Error(`Original column missing in ${table}`);
      manifest[table] = await fingerprintTable(connection, table, selected);
    }
    if (previous) {
      const changed = Object.keys(previous).filter(table => previous[table].count !== manifest[table]?.count || previous[table].hash !== manifest[table]?.hash);
      if (changed.length) throw new Error(`Original records changed: ${changed.join(", ")}`);
      console.log(JSON.stringify({ preserved: true, originalTables: Object.keys(previous).length,
        originalRows: Object.values(previous).reduce((sum, item) => sum + item.count, 0) }));
    } else {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { flag: "wx" });
      console.log(JSON.stringify({ captured: true, tables: Object.keys(manifest).length,
        rows: Object.values(manifest).reduce((sum, item) => sum + item.count, 0), manifest: path.basename(file) }));
    }
  }
  await db.rollback();
} finally { await db.end(); }
