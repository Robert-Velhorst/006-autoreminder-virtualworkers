import { randomUUID, createHash } from "node:crypto";
import mysql from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertIntegrationDatabase } from "./run-mysql-integration.mjs";
import { fingerprintTable } from "./operational-record-fingerprint.mjs";

const target = process.env.APTLSS_TEST_DATABASE_URL;
const hash = value => createHash("sha256").update(value).digest("hex");
const legacy = (rows, columns) => ({
  columns,
  count: rows.length,
  hash: hash(
    rows
      .map(row => hash(JSON.stringify(columns.map(column => row[column]))))
      .sort()
      .join("\n")
  ),
});

describe.skipIf(!target)(
  "operational fingerprint real MySQL compatibility",
  { timeout: 30_000, hookTimeout: 30_000 },
  () => {
    let connection;
    let db;
    const table = `fingerprint_${randomUUID().replaceAll("-", "")}`;
    const columns = ["memo", "id", "sourceDate", "binaryValue", "jsonText"];

    beforeAll(async () => {
      assertIntegrationDatabase(target);
      connection = mysql.createConnection({
        uri: target,
        dateStrings: true,
        charset: "utf8mb4",
        connectTimeout: 10_000,
      });
      db = connection.promise();
      const [identity] = await db.query("SELECT DATABASE() AS name");
      expect(identity[0].name).toBe(new URL(target).pathname.slice(1));
      // This table belongs only to this connection and disappears on disconnect.
      await db.query(
        `CREATE TEMPORARY TABLE \`${table}\` (id INT, jsonText LONGTEXT, binaryValue VARBINARY(16), sourceDate DATETIME, memo VARCHAR(200)) CHARACTER SET utf8mb4`
      );
      const rows = [
        [
          2,
          '{"evidence":["line\\nnext"]}',
          Buffer.from([0, 127, 255]),
          "2026-09-30 22:00:00",
          "\u00e9\u4e2d\ud83d\udce8",
        ],
        [1, null, null, null, "pending"],
        [1, null, null, null, "pending"],
      ];
      for (let id = 3; id < 19; id++)
        rows.push([
          id,
          `${id}:` + "x".repeat(1024 * 1024),
          null,
          null,
          "large retained source",
        ]);
      for (const row of rows)
        await db.execute(`INSERT INTO \`${table}\` VALUES (?,?,?,?,?)`, row);
      await db.query("SET SESSION TRANSACTION READ ONLY");
      await db.beginTransaction();
    });

    afterAll(async () => {
      if (db) {
        try {
          await db.rollback();
        } finally {
          await db.end();
        }
      }
    });

    it("preserves the original manifest for large payloads, duplicates, dates, binary data and unicode", async () => {
      const [rows] = await db.query(
        `SELECT ${columns.map(column => `\`${column}\``).join(",")} FROM \`${table}\``
      );
      expect(await fingerprintTable(connection, table, columns)).toEqual(
        legacy(rows, columns)
      );
    });

    it("retains the read-only transaction and stored records across repeated reads", async () => {
      const before = await fingerprintTable(connection, table, columns);
      expect(await fingerprintTable(connection, table, columns)).toEqual(
        before
      );
      const [state] = await db.query(
        "SELECT @@session.transaction_read_only AS readOnly"
      );
      expect(Number(state[0].readOnly)).toBe(1);
      expect(before.count).toBe(19);
    });

    it("rejects a failed SQL stream instead of reporting a partial fingerprint", async () => {
      await expect(
        fingerprintTable(connection, table, ["missing_column"])
      ).rejects.toThrow();
      expect((await fingerprintTable(connection, table, columns)).count).toBe(
        19
      );
    });
  }
);
