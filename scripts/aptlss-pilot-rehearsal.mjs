import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

const mode = process.argv[2];
const url = new URL(process.env.APTLSS_REHEARSAL_DATABASE_URL || "");
if (url.protocol !== "mysql:" || url.hostname !== "127.0.0.1" || url.port !== "33317"
  || url.pathname !== "/aptlss_pilot_rehearsal" || url.search || url.hash) {
  throw new Error("Only the isolated native aptlss_pilot_rehearsal database on loopback port 33317 is permitted");
}
const name = url.pathname.slice(1);
const root = path.resolve(".local/pilot");
fs.mkdirSync(root, { recursive: true });
const options = { host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password), connectTimeout: 10000, dateStrings: true };
const escape = value => "`" + value.replace(/`/g, "``") + "`";

if (mode === "restore") {
  const manifestPath = path.resolve(process.argv[3] || "");
  if (!manifestPath.startsWith(root + path.sep)) throw new Error("Backup manifest must be under .local/pilot");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const backup = path.resolve(root, manifest.sqlFile);
  if (path.dirname(backup) !== root) throw new Error("Invalid backup path");
  const bytes = fs.readFileSync(backup);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("Backup hash mismatch");
  // Never activate restored scheduled database events on a shared test instance.
  if (/CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?EVENT\b/i.test(bytes.toString("utf8"))) throw new Error("Backup contains database events; isolated event-disabled restore requires separate review");
  const db = await mysql.createConnection(options);
  try { await db.query(`CREATE DATABASE ${escape(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
  finally { await db.end(); }
  const executable = path.resolve("../joyce-work-schedule-aptlss/artifacts/native-mysql-20260905/runtime/mysql-8.4.11-winx64/bin/mysql.exe");
  const child = spawn(executable, ["--no-defaults", "--protocol=TCP", "--host=127.0.0.1", "--port=33317", `--user=${options.user}`, `--database=${name}`],
    { env: { ...process.env, MYSQL_PWD: options.password }, stdio: ["pipe", "ignore", "pipe"] });
  let stderrBytes = 0;
  child.stderr.on("data", bytes => { stderrBytes += bytes.length; });
  const exit = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(`Restore failed (${code}); diagnostic bytes: ${stderrBytes}`))); });
  await Promise.all([pipeline(fs.createReadStream(backup), child.stdin), exit]);
  console.log(JSON.stringify({ restored: true, database: name, sourceHash: manifest.sha256 }));
} else if (["capture", "verify"].includes(mode)) {
  const db = await mysql.createConnection({ ...options, database: name });
  try {
    const file = path.join(root, "rehearsal-before.json");
    const previous = mode === "verify" ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const [tables] = await db.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    const manifest = {};
    for (const table of previous ? Object.keys(previous) : tables.map(row => row.name)) {
      if (table === "__drizzle_migrations") continue;
      const [columns] = await db.query(`SHOW COLUMNS FROM ${escape(table)}`);
      const selected = previous?.[table].columns || columns.map(row => row.Field);
      if (selected.some(column => !columns.some(row => row.Field === column))) throw new Error(`Original column missing in ${table}`);
      const [rows] = await db.query(`SELECT ${selected.map(escape).join(",")} FROM ${escape(table)}`);
      const hashes = rows.map(row => createHash("sha256").update(JSON.stringify(selected.map(column => row[column]))).digest("hex")).sort();
      manifest[table] = { columns: selected, count: rows.length, hash: createHash("sha256").update(hashes.join("\n")).digest("hex") };
    }
    if (previous) {
      const changed = Object.keys(previous).filter(table => previous[table].count !== manifest[table]?.count || previous[table].hash !== manifest[table]?.hash);
      if (changed.length) throw new Error(`Original records changed: ${changed.join(", ")}`);
      fs.writeFileSync(path.join(root, "rehearsal-preservation.json"), JSON.stringify({ passed: true, originalTables: Object.keys(previous).length, verifiedAt: new Date().toISOString() }, null, 2));
      console.log(JSON.stringify({ preserved: true, originalTables: Object.keys(previous).length }));
    } else {
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { flag: "wx" });
      console.log(JSON.stringify({ captured: true, tables: Object.keys(manifest).length }));
    }
  } finally { await db.end(); }
} else throw new Error("Use restore <backup manifest>, capture, or verify");
