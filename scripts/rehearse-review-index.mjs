import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";

const root = path.resolve('.local/pilot');
const manifestPath = path.resolve(process.argv[2] || '');
if (path.dirname(manifestPath) !== root) throw new Error('Local backup manifest required');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const backup = path.resolve(root, manifest.sqlFile);
if (path.dirname(backup) !== root) throw new Error('Invalid backup path');
const url = new URL(process.env.APTLSS_REVIEW_REHEARSAL_URL || '');
const name = url.pathname.slice(1);
if (url.hostname !== '127.0.0.1' || url.port !== '33317' || !/^aptlss_review_rehearsal_\d{14}$/.test(name)) throw new Error('Dedicated timestamped loopback rehearsal database required');
const digest = createHash('sha256'); let bytes = 0;
for await (const chunk of fs.createReadStream(backup)) { digest.update(chunk); bytes += chunk.length; }
if (digest.digest('hex') !== manifest.sha256 || bytes !== manifest.bytes) throw new Error('Backup verification failed');
const options = { host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), timezone: 'Z' };
const server = await mysql.createConnection(options);
try {
  const [eventStatus] = await server.query('SELECT @@GLOBAL.event_scheduler AS state');
  if (!['OFF', 'DISABLED'].includes(eventStatus[0].state)) {
    const [events] = await server.query('SELECT COUNT(*) AS n FROM information_schema.events');
    if (Number(events[0].n)) throw new Error('Existing test database events require separate review');
    await server.query('SET GLOBAL event_scheduler=OFF');
  }
  await server.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
} finally { await server.end(); }
const executable = path.resolve('../joyce-work-schedule-aptlss/artifacts/native-mysql-20260905/runtime/mysql-8.4.11-winx64/bin/mysql.exe');
const child = spawn(executable, ['--no-defaults', '--protocol=TCP', '--host=127.0.0.1', '--port=33317', '--user=' + options.user, '--database=' + name], { env: { ...process.env, MYSQL_PWD: options.password }, stdio: ['pipe', 'ignore', 'pipe'] });
let stderrBytes = 0; child.stderr.on('data', b => { stderrBytes += b.length; });
const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Restore failed; diagnostic bytes=' + stderrBytes))); });
await Promise.all([pipeline(fs.createReadStream(backup), child.stdin), exit]);
const db = await mysql.createConnection({ ...options, database: name });
async function fingerprint() {
  const [tables] = await db.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
  const counts = {};
  for (const { name: table } of tables) {
    if (table === '__drizzle_migrations') continue;
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM `' + table.replaceAll('`','``') + '`'); counts[table] = rows[0].n;
  }
  const hash = createHash('sha256'); let after = 0;
  while (true) {
    const [rows] = await db.query('SELECT id, SHA2(snapshotJson,256) AS h FROM aptlss_manager_runs WHERE id>? ORDER BY id LIMIT 100', [after]);
    if (!rows.length) break;
    for (const row of rows) { hash.update(row.id + ':' + row.h + '\n'); after = row.id; }
  }
  return { counts, snapshotHash: hash.digest('hex') };
}
try {
  const before = await fingerprint();
  await migrate(drizzle(db), { migrationsFolder: './drizzle' });
  const after = await fingerprint();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Record preservation failed');
  const [ledgerBefore] = await db.query('SELECT * FROM __drizzle_migrations ORDER BY id');
  await migrate(drizzle(db), { migrationsFolder: './drizzle' });
  const [ledgerAfter] = await db.query('SELECT * FROM __drizzle_migrations ORDER BY id');
  if (JSON.stringify(ledgerBefore) !== JSON.stringify(ledgerAfter)) throw new Error('Migration rerun changed ledger');
  const start = performance.now();
  await db.query('SELECT proposalHash,MAX(reviewUrgent) FROM aptlss_manager_runs WHERE vaId=2 AND reviewDigest=? GROUP BY proposalHash', ['absent-current-digest']);
  const proof = { restored: true, database: name, sourceHash: manifest.sha256, preserved: true, ...after, rerun: true, indexedQueryMs: Math.round(performance.now()-start), verifiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...proof, counts: Object.keys(proof.counts).length }));
} finally { await db.end(); }
