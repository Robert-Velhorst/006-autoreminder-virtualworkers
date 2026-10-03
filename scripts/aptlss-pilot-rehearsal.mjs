import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import mysql from "mysql2";
import { fingerprintTable } from "./operational-record-fingerprint.mjs";
import { freeDiskBytes } from "./pilot-database-backup.mjs";
import {
  openVerifiedBackup,
  assertEventDisabledServer,
  restoreClientArguments,
  restoreClientEnvironment,
  importVerifiedBackup,
} from "./pilot-backup-restore.mjs";

const mode = process.argv[2];
const url = new URL(process.env.APTLSS_REHEARSAL_DATABASE_URL || "");
if (
  url.protocol !== "mysql:" ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "33317" ||
  url.pathname !== "/aptlss_pilot_rehearsal" ||
  url.search ||
  url.hash
) {
  throw new Error(
    "Only the isolated native aptlss_pilot_rehearsal database on loopback port 33317 is permitted"
  );
}
const name = url.pathname.slice(1);
const root = path.resolve(".local/pilot");
fs.mkdirSync(root, { recursive: true });
const options = {
  host: url.hostname,
  port: Number(url.port),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  connectTimeout: 10000,
  dateStrings: true,
};
const escape = value => "`" + value.replace(/`/g, "``") + "`";
const emptyRecordHash = createHash("sha256").update("").digest("hex");
const comparisonScope = {
  scope: "legacy-original-columns",
  fullDataPreservationVerified: false,
  applicationRollbackVerified: false,
};

function validateCheckpoint(checkpoint) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const validIdentifier = value => typeof value === "string" && value.length > 0 && !value.includes("\0");
  if (!object(checkpoint) || Object.keys(checkpoint).length === 0)
    throw new Error("Original-column checkpoint must be a nonempty table manifest");
  for (const [table, record] of Object.entries(checkpoint)) {
    if (!validIdentifier(table) || table === "__drizzle_migrations" || !object(record)
      || Object.keys(record).length !== 3
      || !Object.hasOwn(record, "columns") || !Object.hasOwn(record, "count") || !Object.hasOwn(record, "hash")
      || !Array.isArray(record.columns) || record.columns.length === 0
      || !record.columns.every(validIdentifier)
      || new Set(record.columns).size !== record.columns.length
      || !Number.isSafeInteger(record.count) || record.count < 0
      || typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash)
      || (record.count === 0) !== (record.hash === emptyRecordHash))
      throw new Error("Original-column checkpoint contains a malformed or inconsistent table fingerprint");
  }
  return checkpoint;
}

function checkpointTypeCast(field, next) {
  if (field.type !== "LONGLONG") return next();
  const value = field.string();
  if (value === null) return null;
  const number = Number(value);
  // Preserve legacy numeric hashes only where integer conversion is lossless.
  return Number.isSafeInteger(number) ? number : value;
}

if (mode === "restore") {
  const started = Date.now();
  const manifestPath = path.resolve(process.argv[3] || "");
  const backup = await openVerifiedBackup(root, manifestPath);
  const db = mysql.createConnection(options).promise();
  try {
    const reserve = 12n * 1024n ** 3n;
    if (freeDiskBytes(root) < BigInt(backup.manifest.bytes) + reserve)
      throw new Error(
        "Insufficient disk space for the full restore plus its 12 GiB reserve; database not created"
      );
    const executable = path.resolve(
      "../joyce-work-schedule-aptlss/artifacts/native-mysql-20260905/runtime/mysql-8.4.11-winx64/bin/mysql.exe"
    );
    if (!fs.statSync(executable).isFile())
      throw new Error("Native restore client is missing");
    await assertEventDisabledServer(db, Number(url.port));
    await db.query({
      sql: `CREATE DATABASE ${escape(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      timeout: 10000,
    });
    await importVerifiedBackup(
      backup,
      executable,
      restoreClientArguments(options.user, name, options.port),
      restoreClientEnvironment(options.password),
      {
        checkResources: () => {
          if (freeDiskBytes(root) <= reserve)
            throw new Error(
              "Restore disk reserve reached; isolated database retained"
            );
        },
      }
    );
    // Let MySQL interpret executable comments and SQL modes. Events may never
    // execute here, and any retained event definition prevents acceptance.
    await assertEventDisabledServer(db, Number(url.port));
    console.log(
      JSON.stringify({
        restored: true,
        database: name,
        sourceHash: backup.manifest.sha256,
        bytes: backup.manifest.bytes,
        eventScheduler: "DISABLED",
        elapsedMs: Date.now() - started,
      })
    );
  } finally {
    try {
      await db.end();
    } finally {
      await backup.close();
    }
  }
} else if (["capture", "verify"].includes(mode)) {
  const file = path.resolve(
    process.argv[3] || path.join(root, "rehearsal-before.json")
  );
  if (path.dirname(file) !== root || !file.endsWith(".json"))
    throw new Error(
      "Rehearsal checkpoint must be a JSON file directly under .local/pilot"
    );
  const previous = mode === "verify"
    ? validateCheckpoint(JSON.parse(fs.readFileSync(file, "utf8")))
    : null;
  const connection = mysql.createConnection({
    ...options, database: name,
    supportBigNumbers: true, bigNumberStrings: true,
    typeCast: checkpointTypeCast,
  });
  const db = connection.promise();
  try {
    await db.query("SET SESSION TRANSACTION READ ONLY");
    await db.beginTransaction();
    const [tables] = await db.query(
      "SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
    );
    const manifest = Object.create(null);
    const availableTables = new Set(tables.map(row => row.name));
    for (const table of previous
      ? Object.keys(previous)
      : tables.map(row => row.name)) {
      if (table === "__drizzle_migrations") continue;
      if (!availableTables.has(table))
        throw new Error("Original checkpoint table missing from the current database");
      const [columns] = await db.query(`SHOW COLUMNS FROM ${escape(table)}`);
      const selected =
        previous?.[table].columns || columns.map(row => row.Field);
      if (selected.some(column => !columns.some(row => row.Field === column)))
        throw new Error(`Original column missing in ${table}`);
      manifest[table] = await fingerprintTable(connection, table, selected);
    }
    validateCheckpoint(manifest);
    if (previous) {
      const changed = Object.keys(previous).filter(
        table =>
          previous[table].count !== manifest[table]?.count ||
          previous[table].hash !== manifest[table]?.hash
      );
      if (changed.length)
        throw new Error(`Original records changed: ${changed.join(", ")}`);
      const stamp = new Date().toISOString().replaceAll(":", "-");
      const proof = path.join(
        root,
        `${path.basename(file, ".json")}-preservation-${stamp}.json`
      );
      fs.writeFileSync(
        proof,
        JSON.stringify(
          {
            passed: true,
            ...comparisonScope,
            originalTables: Object.keys(previous).length,
            checkpoint: path.basename(file),
            verifiedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        { flag: "wx" }
      );
      console.log(
        JSON.stringify({
          preserved: true,
          ...comparisonScope,
          originalTables: Object.keys(previous).length,
        })
      );
    } else {
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { flag: "wx" });
      console.log(
        JSON.stringify({ captured: true, ...comparisonScope, tables: Object.keys(manifest).length })
      );
    }
  } finally {
    try {
      await db.rollback();
    } finally {
      await db.end();
    }
  }
} else
  throw new Error(
    "Use restore <backup manifest>, capture [checkpoint], or verify [checkpoint]"
  );
