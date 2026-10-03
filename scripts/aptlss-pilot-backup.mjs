import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "dotenv";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import {
  createSqlBackup,
  nativeBackupArguments,
} from "./pilot-database-backup.mjs";
import { restoreClientEnvironment } from "./pilot-backup-restore.mjs";

const root = path.resolve(".local/pilot");
fs.mkdirSync(root, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(root, `operational-${timestamp}.sql`);
if (process.argv.length !== 3 || process.argv[2] !== "--native")
  throw new Error(
    "Use --native: a Docker CLI timeout cannot reliably stop its remote dump process"
  );
const app = process.env.PILOT_PREVIOUS_IMAGE
  ? {
      Image: process.env.PILOT_PREVIOUS_IMAGE,
      Name: "/joyce-work-schedule-app-1",
    }
  : JSON.parse(
      execFileSync("docker", ["inspect", "joyce-work-schedule-app-1"], {
        encoding: "utf8",
        timeout: 30000,
      })
    )[0];
if (!/^sha256:[a-f0-9]{64}$/.test(app.Image || ""))
  throw new Error("Verified rollback image identity required");
const config = parse(
  fs.readFileSync(path.resolve("../joyce-work-schedule/.env.db.local"))
);
const executable = path.resolve(
  "../joyce-work-schedule-aptlss/artifacts/native-mysql-20260905/runtime/mysql-8.4.11-winx64/bin/mysqldump.exe"
);
const args = nativeBackupArguments(config);
if (!fs.statSync(executable).isFile())
  throw new Error("Native backup client is unavailable");
const db = await mysql.createConnection({
  host: "127.0.0.1",
  port: 3307,
  user: "root",
  password: config.MYSQL_ROOT_PASSWORD,
  database: config.MYSQL_DATABASE,
  connectTimeout: 10000,
});
const inspect = async () => {
  const [tables] = await db.query({
    sql: "SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME",
    timeout: 10000,
  });
  if (!tables.length || tables.some(table => table.engine !== "InnoDB"))
    throw new Error(
      "Consistent operational backup requires all source tables to be InnoDB"
    );
  const [ledger] = await db.query({
    sql: "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, id",
    timeout: 10000,
  });
  return {
    tableCount: tables.length,
    ledger,
    schemaLedgerHash: createHash("sha256")
      .update(JSON.stringify({ tables, ledger }))
      .digest("hex"),
  };
};
let result;
let before;
try {
  before = await inspect();
  result = await createSqlBackup(
    executable,
    args,
    restoreClientEnvironment(config.MYSQL_ROOT_PASSWORD),
    file,
    {
      onProgress: progress =>
        console.log(JSON.stringify({ backupProgress: progress })),
    }
  );
  const after = await inspect();
  if (before.schemaLedgerHash !== after.schemaLedgerHash)
    throw new Error(
      "Source table or migration inventory changed; backup not accepted, SQL retained"
    );
} finally {
  await db.end();
}
const manifest = {
  timestamp,
  sqlFile: path.basename(file),
  ...result,
  sourceDatabase: config.MYSQL_DATABASE,
  tableCount: before.tableCount,
  sourceMigrations: before.ledger,
  schemaLedgerHash: before.schemaLedgerHash,
  consistency:
    "mysqldump single-transaction; live writes continue; DDL must not run during backup",
  previousImage: app.Image,
  previousContainer: app.Name,
  pilotWorkerId: 2,
  deploymentPerformed: false,
};
fs.writeFileSync(
  path.join(root, `backup-${timestamp}.json`),
  JSON.stringify(manifest, null, 2),
  { flag: "wx", flush: true }
);
console.log(JSON.stringify(manifest));
