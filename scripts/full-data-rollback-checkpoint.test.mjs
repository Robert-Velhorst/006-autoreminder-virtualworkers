import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { assertFullDataUnchanged, captureFullDataCheckpoint, fingerprintAllColumns, fullRecordDigestQuery } from "./full-data-rollback-checkpoint.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const options = { database: "aptlss_pilot_rehearsal", port: 33317, dataDirectory: "/owned/mysql/", eventScheduler: "DISABLED" };
function fixture(overrides = {}) {
  let transaction = false, schemaReads = 0;
  const db = {
    query: vi.fn(async sql => {
      if (sql.startsWith("SELECT DATABASE()")) return [[{ name: options.database, port: options.port, directory: options.dataDirectory, scheduler: options.eventScheduler, ...overrides.identity }]];
      if (sql === "DO 0") return [{ serverStatus: transaction ? (overrides.transactionStatus ?? 8193) : (overrides.borrowed ? 1 : 2) }];
      if (sql.startsWith("START TRANSACTION")) { transaction = true; return [{}]; }
      if (sql.startsWith("SET ")) return [{}];
      if (sql.startsWith("SELECT COUNT(*)")) return [[{ total: overrides.countMismatch ? 2 : 1 }]];
      if (sql.includes("information_schema.tables")) {
        schemaReads++;
        return [[{ name: overrides.missingLedger ? "other" : "__drizzle_migrations", type: "BASE TABLE", engine: overrides.engine ?? "InnoDB" },
          ...(overrides.view ? [{ name: "history_view", type: "VIEW", engine: null }] : [])]];
      }
      if (sql.startsWith("SHOW CREATE TABLE")) return [[{ "Create Table": overrides.missingDefinition ? null : "ledger definition" + (overrides.schemaDrift && schemaReads > 1 ? " changed" : "") }]];
      if (sql.startsWith("SHOW CREATE VIEW")) return [[{ "Create View": "SELECT history" }]];
      if (sql.includes("information_schema.triggers")) return [[...(overrides.trigger ? [{ name: "audit" }] : [])]];
      if (sql.includes("information_schema.routines")) return [[...(overrides.routine ? [{ name: "retained", type: "FUNCTION" }] : [])]];
      if (sql.includes("information_schema.events")) return [[...(overrides.event ? [{ name: "writer" }] : [])]];
      if (sql.startsWith("SHOW CREATE TRIGGER")) return [[{ "SQL Original Statement": "retained trigger", sql_mode: overrides.sqlMode ?? "STRICT_TRANS_TABLES" }]];
      if (sql.startsWith("SHOW CREATE FUNCTION")) return [[{ "Create Function": overrides.hiddenRoutine ? null : "retained function" }]];
      throw new Error("Unexpected fixture query");
    }),
    execute: vi.fn(async () => [[...(overrides.noColumns ? [] : [{ name: "id" }, { name: "hash" }])]]),
    rollback: vi.fn(async () => { transaction = false; }),
  };
  const connection = {
    promise: () => db,
    query: vi.fn(sql => ({ stream: vi.fn(() => {
      if (overrides.brokenStream) return Readable.from((async function* () { yield { rowDigest: hash("first") }; throw new Error("Fixture interruption"); })());
      return Readable.from([{ rowDigest: hash("ledger-row") }]);
    }) })),
  };
  return { connection, db };
}

describe("full-data rollback checkpoints", () => {
  it("hashes every selected column in SQL with distinct null markers and quoted names", () => {
    expect(fullRecordDigestQuery("history`table", ["id", "extra`column"])).toBe(
      "SELECT SHA2(CONCAT(CASE WHEN `id` IS NULL THEN 'N' ELSE CONCAT('V',SHA2(CAST(`id` AS BINARY),256)) END,CASE WHEN `extra``column` IS NULL THEN 'N' ELSE CONCAT('V',SHA2(CAST(`extra``column` AS BINARY),256)) END),256) AS rowDigest FROM `history``table`"
    );
  });
  it.each([[], ["id", "id"], [""], ["bad\0"]])("rejects invalid columns before issuing SQL: %j", async columns => {
    const connection = { query: vi.fn() };
    await expect(fingerprintAllColumns(connection, "history", columns)).rejects.toThrow();
    expect(connection.query).not.toHaveBeenCalled();
  });
  it("preserves duplicate multiplicity without preserving payloads", async () => {
    const first = hash("first"), second = hash("second");
    const connection = { query: () => ({ stream: () => Readable.from([{ rowDigest: second }, { rowDigest: first }, { rowDigest: first }]) }) };
    expect(await fingerprintAllColumns(connection, "records", ["id"])).toEqual({ count: 3, hash: hash([first, first, second].sort().join("\n")) });
  });
  it.each([null, "", "not-a-hash"])("rejects unavailable SQL digests: %j", async rowDigest => {
    const connection = { query: () => ({ stream: () => Readable.from([{ rowDigest }]) }) };
    await expect(fingerprintAllColumns(connection, "records", ["id"])).rejects.toThrow(/complete row digest/);
  });
  it("captures ledger, all columns, views, routines and triggers without release clearance", async () => {
    const { connection, db } = fixture({ view: true, routine: true, trigger: true });
    const result = await captureFullDataCheckpoint(connection, options);
    expect(result.baseTables).toBe(1); expect(result.views).toBe(1);
    expect(result.records).toBe(1); expect(result.objects).toHaveLength(2);
    expect(result.tables[0].columns).toEqual(["id", "hash"]);
    expect(result.readOnly).toBe(true); expect(result.releaseReady).toBe(false);
    expect(result.applicationRollbackVerified).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ledger definition");
    expect(JSON.stringify(result)).not.toContain("retained function");
    expect(db.rollback).toHaveBeenCalledTimes(1);
    expect(() => assertFullDataUnchanged(result, structuredClone(result))).not.toThrow();
    expect(db.query.mock.calls.every(([sql]) => !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COMMIT)\b/i.test(sql))).toBe(true);
  });
  it.each([
    { identity: { name: "production" } }, { identity: { port: 3306 } },
    { identity: { directory: "/production/" } }, { identity: { scheduler: "ON" } },
    { borrowed: true },
  ])("rejects an unexpected server or borrowed transaction before a snapshot: %j", async override => {
    const { connection, db } = fixture(override);
    await expect(captureFullDataCheckpoint(connection, options)).rejects.toThrow();
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("START TRANSACTION"))).toBe(false);
    expect(connection.query).not.toHaveBeenCalled();
    expect(db.rollback).not.toHaveBeenCalled();
  });
  it.each([
    { transactionStatus: 1 }, { transactionStatus: 0 }, { engine: "MyISAM" },
    { missingDefinition: true }, { noColumns: true }, { event: true },
    { schemaDrift: true }, { brokenStream: true }, { routine: true, hiddenRoutine: true },
    { missingLedger: true }, { countMismatch: true },
  ])("does not return partial proof and rolls back on failure: %j", async override => {
    const { connection, db } = fixture(override);
    await expect(captureFullDataCheckpoint(connection, options)).rejects.toThrow();
    expect(db.rollback).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { ...options, eventScheduler: "ON" }, { ...options, port: 0 }, { ...options, database: "bad\0" }])("rejects incomplete identity options before database access: %j", async expected => {
    const { connection, db } = fixture();
    await expect(captureFullDataCheckpoint(connection, expected)).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
  });
  it("rejects altered records, ledger, schema, columns, counts and forged clearance", async () => {
    const original = await captureFullDataCheckpoint(fixture().connection, options);
    for (const change of [
      value => { value.tables[0].records.hash = hash("altered ledger"); },
      value => { value.tables[0].definitionHash = hash("new column"); },
      value => { value.tables[0].columns.pop(); },
      value => { value.records++; },
      value => { value.releaseReady = true; },
      value => { value.applicationRollbackVerified = true; },
      value => { value.tables = []; },
    ]) {
      const altered = structuredClone(original); change(altered);
      expect(() => assertFullDataUnchanged(original, altered)).toThrow();
    }
  });
  it("detects internally valid but different receipts", async () => {
    const before = await captureFullDataCheckpoint(fixture().connection, options);
    const after = await captureFullDataCheckpoint(fixture({ view: true }).connection, options);
    expect(() => assertFullDataUnchanged(before, after)).toThrow(/changed/);
  });
  it("reports only progress totals and aborts cleanly if the observer fails", async () => {
    const { connection, db } = fixture();
    const onProgress = vi.fn(async () => { throw new Error("Observer stopped"); });
    await expect(captureFullDataCheckpoint(connection, { ...options, onProgress })).rejects.toThrow("Observer stopped");
    expect(onProgress).toHaveBeenCalledWith({ completedTables: 1, totalTables: 1, records: 1 });
    expect(db.rollback).toHaveBeenCalledTimes(1);
  });
  it("detects changed creation SQL mode even when the trigger body is identical", async () => {
    const before = await captureFullDataCheckpoint(fixture({ trigger: true }).connection, options);
    const after = await captureFullDataCheckpoint(fixture({ trigger: true, sqlMode: "ANSI" }).connection, options);
    expect(before.objects[0].definitionHash).not.toBe(after.objects[0].definitionHash);
    expect(() => assertFullDataUnchanged(before, after)).toThrow();
  });
});
