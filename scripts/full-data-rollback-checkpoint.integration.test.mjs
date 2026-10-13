import { randomUUID } from "node:crypto";
import mysql from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertIntegrationDatabase } from "./run-mysql-integration.mjs";
import { assertFullDataUnchanged, captureFullDataCheckpoint, fingerprintAllColumns } from "./full-data-rollback-checkpoint.mjs";

const target = process.env.APTLSS_TEST_DATABASE_URL
  || (process.env.CI === "true" ? process.env.DATABASE_URL : undefined);
const required = process.env.CI === "true";
describe.skipIf(!target && !required)("full-data checkpoint real MySQL", { timeout: 60_000, hookTimeout: 60_000 }, () => {
  let reader, writer, db, options;
  const table = "rollback_checkpoint_" + randomUUID().replaceAll("-", "");
  const view = table + "_view", trigger = table + "_trigger";
  const columns = ["id", "numberValue", "binaryValue", "memo", "derived"];
  beforeAll(async () => {
    assertIntegrationDatabase(target);
    if (!target) throw new Error("Set APTLSS_TEST_DATABASE_URL to run the required CI MySQL checkpoint tests.");
    reader = mysql.createConnection({ uri: target, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    writer = mysql.createConnection(target); db = writer.promise();
    const [[identity]] = await db.query("SELECT DATABASE() name,@@port port,@@datadir directory,@@event_scheduler scheduler");
    expect(["OFF", "DISABLED"]).toContain(identity.scheduler);
    options = { database: identity.name, port: Number(identity.port), dataDirectory: identity.directory, eventScheduler: identity.scheduler };
    await db.query(`CREATE TABLE \`${table}\` (id BIGINT,numberValue BIGINT UNSIGNED,binaryValue VARBINARY(32),memo LONGTEXT,derived BIGINT GENERATED ALWAYS AS (id+1) STORED) ENGINE=InnoDB`);
    await db.execute(`INSERT INTO \`${table}\` (id,numberValue,binaryValue,memo) VALUES (?,?,?,?)`, [1, "18446744073709551614", Buffer.from([0, 255]), "retained"]);
    await db.query(`CREATE VIEW \`${view}\` AS SELECT id FROM \`${table}\``);
    await db.query(`CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON \`${table}\` FOR EACH ROW SET NEW.id=NEW.id`);
  });
  afterAll(async () => {
    try { if (db) { await db.query(`DROP VIEW IF EXISTS \`${view}\``); await db.query(`DROP TABLE IF EXISTS \`${table}\``); } }
    finally { if (db) await db.end(); if (reader) await reader.promise().end(); }
  });
  it("uses a real consistent read-only transaction and retains the complete ledger and generated columns", async () => {
    const before = await captureFullDataCheckpoint(reader, options);
    const after = await captureFullDataCheckpoint(reader, options);
    expect(() => assertFullDataUnchanged(before, after)).not.toThrow();
    expect(before.tables.find(item => item.name === "__drizzle_migrations").records.count).toBeGreaterThan(0);
    expect(before.tables.find(item => item.name === table).columns).toEqual(columns);
    expect(before.tables.find(item => item.name === table).records.count).toBe(1);
    expect(before.tables.find(item => item.name === view).type).toBe("VIEW");
    expect(before.objects.find(item => item.name === trigger).type).toBe("TRIGGER");
    expect(JSON.stringify(before)).not.toContain("18446744073709551614");
    const [header] = await reader.promise().query("DO 0");
    expect(header.serverStatus & 1).toBe(0);
  });
  it("detects adjacent large integers that JavaScript numeric coercion cannot distinguish", async () => {
    const before = await fingerprintAllColumns(reader, table, columns);
    await db.query(`UPDATE \`${table}\` SET numberValue=18446744073709551615`);
    const after = await fingerprintAllColumns(reader, table, columns);
    expect(after.hash).not.toBe(before.hash); expect(after.count).toBe(before.count);
  });
  it("distinguishes binary changes, null/empty strings and duplicate multiplicity", async () => {
    const before = await fingerprintAllColumns(reader, table, columns);
    await db.query(`UPDATE \`${table}\` SET memo=NULL,binaryValue=X'00FE'`);
    const changed = await fingerprintAllColumns(reader, table, columns);
    expect(changed.hash).not.toBe(before.hash);
    await db.query(`UPDATE \`${table}\` SET memo=''`);
    expect((await fingerprintAllColumns(reader, table, columns)).hash).not.toBe(changed.hash);
    await db.query(`INSERT INTO \`${table}\` (id,numberValue,binaryValue,memo) SELECT id,numberValue,binaryValue,memo FROM \`${table}\``);
    expect((await fingerprintAllColumns(reader, table, columns)).count).toBe(2);
  });
  it("detects additive schema changes rather than ignoring new columns", async () => {
    const before = await captureFullDataCheckpoint(reader, options);
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN addedDetail VARCHAR(40) DEFAULT 'retained addition'`);
    const after = await captureFullDataCheckpoint(reader, options);
    expect(() => assertFullDataUnchanged(before, after)).toThrow();
    expect(after.tables.find(item => item.name === table).columns).toContain("addedDetail");
  });
  it("rejects wrong target identity without ending a caller's active transaction", async () => {
    await reader.promise().beginTransaction();
    await expect(captureFullDataCheckpoint(reader, options)).rejects.toThrow(/borrow/);
    const [header] = await reader.promise().query("DO 0");
    expect(header.serverStatus & 1).toBe(1);
    await reader.promise().rollback();
    await expect(captureFullDataCheckpoint(reader, { ...options, database: "production" })).rejects.toThrow(/database/);
  });
});
