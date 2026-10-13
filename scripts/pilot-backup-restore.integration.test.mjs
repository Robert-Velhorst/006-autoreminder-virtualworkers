import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSqlBackup,
  nativeBackupArguments,
} from "./pilot-database-backup.mjs";
import {
  openVerifiedBackup,
  assertEventDisabledServer,
  restoreClientArguments,
  restoreClientEnvironment,
  importVerifiedBackup,
} from "./pilot-backup-restore.mjs";

const enabled = process.env.PILOT_RESTORE_SAFETY_TESTS === "1";
const client = path.resolve(
  "../joyce-work-schedule-aptlss/artifacts/native-mysql-20260905/runtime/mysql-8.4.11-winx64/bin/mysql.exe"
);

describe.skipIf(!enabled)(
  "native MySQL restore safety fixture (not an operational restore)",
  { timeout: 30000, hookTimeout: 30000 },
  () => {
    const name = "restore_safety_test_" + randomUUID().replaceAll("-", "");
    const folder = path.resolve(".local/pilot", name);
    let db;
    let password;
    let sequence = 0;
    let failed = false;
    let created = false;

    beforeAll(async () => {
      try {
        const url = new URL(process.env.APTLSS_REHEARSAL_DATABASE_URL || "");
        if (
          url.protocol !== "mysql:" ||
          url.hostname !== "127.0.0.1" ||
          url.port !== "33317" ||
          url.pathname !== "/aptlss_pilot_rehearsal" ||
          url.search ||
          url.hash ||
          url.username !== "root"
        ) {
          throw new Error(
            "Explicit isolated native administrator URL on port 33317 required"
          );
        }
        password = decodeURIComponent(url.password);
        db = await mysql.createConnection({
          host: "127.0.0.1",
          port: 33317,
          user: "root",
          password,
          connectTimeout: 10000,
          dateStrings: true,
        });
        await assertEventDisabledServer(db, 33317);
        await fs.stat(client);
        await fs.mkdir(folder, { recursive: true });
        await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
        created = true;
        await db.query(`CREATE TABLE \`${name}\`.marker (id INT)`);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    afterEach(context => {
      if (context.task.result?.state === "fail") failed = true;
    });
    afterAll(async () => {
      try {
        // Never clear a preexisting or uncertain fixture to obtain a passing run.
        if (db && created && !failed) {
          await db.query(`DROP DATABASE \`${name}\``);
          await fs.rm(folder, { recursive: true, force: true });
        }
      } finally {
        await db?.end();
      }
    });

    async function restore(sql) {
      const data = Buffer.from(
        sql + "\n-- Dump completed on 2026-10-01 00:00:00\n"
      );
      const sqlFile = `fixture-${sequence++}.sql`;
      const manifestPath = path.join(folder, sqlFile + ".json");
      await fs.writeFile(path.join(folder, sqlFile), data, { flag: "wx" });
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          sqlFile,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        }),
        { flag: "wx" }
      );
      const backup = await openVerifiedBackup(folder, manifestPath);
      try {
        await importVerifiedBackup(
          backup,
          client,
          restoreClientArguments("root", name, 33317),
          restoreClientEnvironment(password),
          { timeoutMs: 15000 }
        );
      } finally {
        await backup.close();
      }
    }

    it("imports actual SQL, binary bytes, CRLF and Unicode using the native client", async () => {
      await restore(
        "CREATE TABLE retained (id INT, evidence LONGTEXT, binaryValue VARBINARY(16));\nINSERT INTO retained VALUES (1, 'line\\r\\nnext \\n \u00e9\u4e2d\ud83d\udce8', 0x007fff);"
      );
      const [[row]] = await db.query(`SELECT * FROM \`${name}\`.retained`);
      expect(row.evidence).toBe("line\r\nnext \n \u00e9\u4e2d\ud83d\udce8");
      expect(row.binaryValue).toEqual(Buffer.from([0, 127, 255]));
      await assertEventDisabledServer(db, 33317);
    });

    it("imports a 16 MiB evidence statement without the native client's default packet restriction", async () => {
      const evidence = "x".repeat(16 * 1024 * 1024);
      await restore(`INSERT INTO retained VALUES (2, '${evidence}', NULL);`);
      const [[row]] = await db.query(
        `SELECT LENGTH(evidence) AS bytes, SHA2(evidence, 256) AS digest FROM \`${name}\`.retained WHERE id=2`
      );
      expect(Number(row.bytes)).toBe(evidence.length);
      expect(row.digest).toBe(
        createHash("sha256").update(evidence).digest("hex")
      );
    });

    it.each([
      "\\! echo VA_RESTORE_COMMAND_BLOCKED",
      "source va-restore-command-blocked.sql",
    ])("does not execute local client command %s", async command => {
      await expect(
        restore(command + ";\nINSERT INTO marker VALUES (3);")
      ).rejects.toThrow("Restore failed");
      const [[row]] = await db.query(
        `SELECT COUNT(*) AS count FROM \`${name}\`.marker`
      );
      expect(Number(row.count)).toBe(0);
    });

    it("cannot re-enable the event scheduler from imported SQL", async () => {
      await expect(
        restore("SET GLOBAL event_scheduler=ON; INSERT INTO marker VALUES (4);")
      ).rejects.toThrow("Restore failed");
      await assertEventDisabledServer(db, 33317);
    });

    it("detects version-comment events as real database objects, prevents execution and refuses acceptance", async () => {
      await restore(
        "/*!50106 CREATE*/ /*!50117 DEFINER=CURRENT_USER*/ /*!50106 EVENT blocked_event ON SCHEDULE EVERY 1 SECOND DO INSERT INTO marker VALUES (99) */;"
      );
      await expect(assertEventDisabledServer(db, 33317)).rejects.toThrow(
        "separate review"
      );
      await new Promise(resolve => setTimeout(resolve, 1200));
      const [[row]] = await db.query(
        `SELECT COUNT(*) AS count FROM \`${name}\`.marker`
      );
      expect(Number(row.count)).toBe(0);
      await db.query(`DROP EVENT \`${name}\`.blocked_event`);
      await assertEventDisabledServer(db, 33317);
    });

    it("round-trips an actual native mysqldump backup without losing the large/binary/Unicode records", async () => {
      await assertEventDisabledServer(db, 33317);
      const fingerprint = async () =>
        (
          await db.query(
            `SELECT id,LENGTH(evidence) AS bytes,SHA2(evidence,256) AS digest,HEX(binaryValue) AS binaryValue FROM \`${name}\`.retained ORDER BY id`
          )
        )[0];
      const before = await fingerprint();
      const dump = path.join(path.dirname(client), "mysqldump.exe");
      const args = nativeBackupArguments({
        MYSQL_PORT: "3307",
        MYSQL_DATABASE: "joyce_work_schedule_consolidated",
        MYSQL_ROOT_PASSWORD: password,
      });
      // The opt-in fixture is created by this test on its guarded isolated server.
      // Only these two arguments differ from the operational native producer.
      args[args.indexOf("--port=3307")] = "--port=33317";
      args[args.length - 1] = name;
      const sqlFile = `native-dump-${sequence++}.sql`;
      const result = await createSqlBackup(
        dump,
        args,
        restoreClientEnvironment(password),
        path.join(folder, sqlFile),
        { timeoutMs: 30000 }
      );
      const manifestPath = path.join(folder, sqlFile + ".json");
      await fs.writeFile(manifestPath, JSON.stringify({ sqlFile, ...result }), {
        flag: "wx",
      });
      const backup = await openVerifiedBackup(folder, manifestPath);
      try {
        await db.query(
          `UPDATE \`${name}\`.retained SET evidence='fixture changed after backup' WHERE id=1`
        );
        await importVerifiedBackup(
          backup,
          client,
          restoreClientArguments("root", name, 33317),
          restoreClientEnvironment(password),
          { timeoutMs: 30000 }
        );
      } finally {
        await backup.close();
      }
      expect(await fingerprint()).toEqual(before);
      await assertEventDisabledServer(db, 33317);
    });
  }
);
