import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const identifier = value => {
  if (typeof value !== "string" || !value.length || value.includes("\0"))
    throw new Error("Invalid checkpoint identifier");
  return "`" + value.replaceAll("`", "``") + "`";
};

export function fullRecordDigestQuery(table, columns) {
  identifier(table);
  if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length)
    throw new Error("Checkpoint columns must be nonempty and unique");
  const values = columns.map(column => {
    const quoted = identifier(column);
    // Hash values in MySQL, avoiding JS number rounding and transporting source
    // payloads. Fixed-width hashes with null markers preserve column boundaries.
    return `CASE WHEN ${quoted} IS NULL THEN 'N' ELSE CONCAT('V',SHA2(CAST(${quoted} AS BINARY),256)) END`;
  });
  return `SELECT SHA2(CONCAT(${values.join(",")}),256) AS rowDigest FROM ${identifier(table)}`;
}

export async function fingerprintAllColumns(connection, table, columns) {
  const stream = connection.query(fullRecordDigestQuery(table, columns)).stream({ highWaterMark: 1 });
  const records = [];
  for await (const row of stream) {
    if (!/^[a-f0-9]{64}$/i.test(row.rowDigest ?? ""))
      throw new Error("Database did not produce a complete row digest");
    records.push(row.rowDigest.toLowerCase());
  }
  records.sort();
  const digest = createHash("sha256");
  for (let index = 0; index < records.length; index++) {
    if (index) digest.update("\n");
    digest.update(records[index]);
  }
  return { count: records.length, hash: digest.digest("hex") };
}

async function definitions(db) {
  const [inventory] = await db.query(
    "SELECT TABLE_NAME name,TABLE_TYPE type,ENGINE engine FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME"
  );
  assert(inventory.some(table => table.name === "__drizzle_migrations"), "Migration ledger is required");
  const tables = [];
  for (const table of inventory) {
    assert(["BASE TABLE", "VIEW"].includes(table.type), "Unsupported schema object");
    if (table.type === "BASE TABLE") assert.equal(table.engine, "InnoDB", "A consistent checkpoint requires InnoDB");
    const [definition] = await db.query(`SHOW CREATE ${table.type === "VIEW" ? "VIEW" : "TABLE"} ${identifier(table.name)}`);
    const ddl = definition[0]?.[table.type === "VIEW" ? "Create View" : "Create Table"];
    assert(typeof ddl === "string" && ddl.length > 0, "Complete schema definition is required");
    const [columns] = await db.execute(
      "SELECT COLUMN_NAME name FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
      [table.name]
    );
    assert(columns.length > 0, "Complete column inventory is required");
    tables.push({ ...table, definitionHash: hash(table.type === "VIEW" ? JSON.stringify(definition[0]) : ddl), columns: columns.map(column => column.name) });
  }
  const objects = [];
  const [triggers] = await db.query("SELECT TRIGGER_NAME name FROM information_schema.triggers WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
  const [routines] = await db.query("SELECT ROUTINE_NAME name,ROUTINE_TYPE type FROM information_schema.routines WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_TYPE,ROUTINE_NAME");
  const [events] = await db.query("SELECT EVENT_NAME name FROM information_schema.events WHERE EVENT_SCHEMA=DATABASE() ORDER BY EVENT_NAME");
  assert.equal(events.length, 0, "Scheduled database events are not allowed in this rehearsal");
  for (const object of [...triggers.map(trigger => ({ ...trigger, type: "TRIGGER" })), ...routines]) {
    assert(["TRIGGER", "FUNCTION", "PROCEDURE"].includes(object.type));
    const [definition] = await db.query(`SHOW CREATE ${object.type} ${identifier(object.name)}`);
    const ddl = definition[0]?.[object.type === "TRIGGER" ? "SQL Original Statement" : `Create ${object.type === "FUNCTION" ? "Function" : "Procedure"}`];
    assert(typeof ddl === "string" && ddl.length > 0, "Complete routine/trigger definition is required");
    // Creation SQL mode and character-set metadata affect routine/trigger/view
    // semantics even if the displayed SQL body is unchanged.
    objects.push({ ...object, definitionHash: hash(JSON.stringify(definition[0])) });
  }
  return { tables, objects };
}

function validateIdentityOptions(options) {
  assert(options && typeof options.database === "string" && options.database.length > 0);
  identifier(options.database);
  assert(Number.isInteger(options.port) && options.port > 0 && options.port <= 65535);
  assert(typeof options.dataDirectory === "string" && options.dataDirectory.length > 0);
  assert(["DISABLED", "OFF"].includes(options.eventScheduler));
  assert(options.onProgress === undefined || typeof options.onProgress === "function");
}

async function identity(db, expected) {
  const [[actual]] = await db.query(
    "SELECT DATABASE() AS name,@@port AS port,@@datadir AS directory,@@event_scheduler AS scheduler"
  );
  assert.equal(actual.name, expected.database, "Unexpected checkpoint database");
  assert.equal(Number(actual.port), expected.port, "Unexpected checkpoint server port");
  assert.equal(actual.directory, expected.dataDirectory, "Unexpected checkpoint data directory");
  assert.equal(actual.scheduler, expected.eventScheduler, "Database scheduler isolation changed");
  return actual;
}

async function transactionStatus(db) {
  const [header] = await db.query("DO 0");
  assert(Number.isInteger(header.serverStatus), "Database transaction status is unavailable");
  return { active: !!(header.serverStatus & 1), readOnly: !!(header.serverStatus & 8192) };
}

// The caller must first prove ownership of the server/process and that no app
// writers are running. This function never seeds, migrates, cleans or launches it.
export async function captureFullDataCheckpoint(connection, options) {
  validateIdentityOptions(options);
  const db = connection.promise();
  await identity(db, options);
  assert.equal((await transactionStatus(db)).active, false, "Do not borrow an existing transaction");
  await db.query("SET SESSION time_zone='+00:00'");
  await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  let started = false;
  try {
    await db.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    started = true;
    assert.deepEqual(await transactionStatus(db), { active: true, readOnly: true }, "Read-only transaction is required");
    const schema = await definitions(db);
    const tables = [];
    for (const table of schema.tables) {
      const records = table.type === "BASE TABLE"
        ? await fingerprintAllColumns(connection, table.name, table.columns)
        : undefined;
      if (records) {
        const [[count]] = await db.query(`SELECT COUNT(*) AS total FROM ${identifier(table.name)}`);
        assert.equal(Number(count.total), records.count, "Row stream and consistent count disagree");
      }
      tables.push({ ...table, ...(records ? { records } : {}) });
      if (options.onProgress) await options.onProgress({ completedTables: tables.length, totalTables: schema.tables.length, records: records?.count ?? 0 });
    }
    assert.deepEqual(await definitions(db), schema, "Schema changed during checkpoint capture");
    await identity(db, options);
    assert.deepEqual(await transactionStatus(db), { active: true, readOnly: true }, "Consistent read-only transaction was lost");
    const inventory = { format: "full-data-rollback-checkpoint-v1", database: options.database, tables, objects: schema.objects };
    return { ...inventory, digest: hash(JSON.stringify(inventory)),
      records: tables.reduce((sum, table) => sum + (table.records?.count ?? 0), 0),
      baseTables: tables.filter(table => table.type === "BASE TABLE").length,
      views: tables.filter(table => table.type === "VIEW").length,
      readOnly: true, releaseReady: false, applicationRollbackVerified: false };
  } finally {
    if (started) await db.rollback();
  }
}

export function assertFullDataUnchanged(before, after) {
  for (const checkpoint of [before, after]) {
    assert.equal(checkpoint?.format, "full-data-rollback-checkpoint-v1");
    assert.equal(checkpoint.readOnly, true);
    assert.equal(checkpoint.releaseReady, false);
    assert.equal(checkpoint.applicationRollbackVerified, false);
    const { format, database, tables, objects } = checkpoint;
    assert(Array.isArray(tables) && tables.some(table => table.name === "__drizzle_migrations"));
    assert.equal(checkpoint.digest, hash(JSON.stringify({ format, database, tables, objects })), "Checkpoint receipt is inconsistent");
    assert.equal(checkpoint.records, tables.reduce((sum, table) => sum + (table.records?.count ?? 0), 0));
    assert.equal(checkpoint.baseTables, tables.filter(table => table.type === "BASE TABLE").length);
    assert.equal(checkpoint.views, tables.filter(table => table.type === "VIEW").length);
  }
  assert.deepEqual(after, before, "Full-data checkpoint changed; reconciliation is required");
}
