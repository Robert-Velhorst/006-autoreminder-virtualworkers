import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { parse } from "dotenv";

const root = path.resolve(".local/pilot");
fs.mkdirSync(root, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(root, `operational-${timestamp}.sql`);
const native = process.argv.includes("--native");
const app = process.env.PILOT_PREVIOUS_IMAGE ? { Image: process.env.PILOT_PREVIOUS_IMAGE, Name: "/joyce-work-schedule-app-1" }
  : JSON.parse(execFileSync("docker", ["inspect", "joyce-work-schedule-app-1"], { encoding: "utf8", timeout: 30000 }))[0];
if (!/^sha256:[a-f0-9]{64}$/.test(app.Image || "")) throw new Error("Verified rollback image identity required");
const config = native ? parse(fs.readFileSync(path.resolve("../joyce-work-schedule/.env.db.local"))) : {};
const executable = native ? path.resolve("../joyce-work-schedule-aptlss/artifacts/native-mysql-20260905/runtime/mysql-8.4.11-winx64/bin/mysqldump.exe") : "docker";
const args = native ? ["--no-defaults", "--protocol=TCP", "--host=127.0.0.1", `--port=${config.MYSQL_PORT || 3307}`, "--user=root", "--single-transaction", "--quick", "--routines", "--triggers", "--events", "--hex-blob", "--no-tablespaces", "--set-gtid-purged=OFF", config.MYSQL_DATABASE] : ["exec", "joyce-work-schedule-mysql-1", "sh", "-c",
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --quick --routines --triggers --events --hex-blob --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE"',
];
const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env: native ? { ...process.env, MYSQL_PWD: config.MYSQL_ROOT_PASSWORD } : process.env });
const timeout = setTimeout(() => child.kill(), 600000);
let errorBytes = 0;
child.stderr.on("data", chunk => { errorBytes += chunk.length; });
const exit = new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Database backup failed (${code}); stderr bytes: ${errorBytes}`)));
});
const digest = createHash("sha256");
let bytes = 0, tail = "";
const verify = new Transform({ transform(chunk, _encoding, done) {
  bytes += chunk.length; digest.update(chunk);
  tail = (tail + chunk.toString("utf8")).slice(-8192);
  done(null, chunk);
} });
try { await Promise.all([pipeline(child.stdout, verify, fs.createWriteStream(file, { flags: "wx" })), exit]); }
finally { clearTimeout(timeout); }
if (bytes < 1000 || !tail.includes("Dump completed")) throw new Error("Incomplete SQL backup; do not proceed");
const manifest = { timestamp, sqlFile: path.basename(file), bytes,
  sha256: digest.digest("hex"), previousImage: app.Image,
  previousContainer: app.Name, pilotWorkerId: 2, deploymentPerformed: false };
fs.writeFileSync(path.join(root, `backup-${timestamp}.json`), JSON.stringify(manifest, null, 2), { flag: "wx" });
console.log(JSON.stringify(manifest));
