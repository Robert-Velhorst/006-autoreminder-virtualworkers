import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { generateMySQLDrizzleJson } from "drizzle-kit/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import * as schema from "../drizzle/schema";
import { fingerprintWholeTable } from "../scripts/operational-record-fingerprint.mjs";
import { readRehearsalMigrationLedger } from "../scripts/pilot-migration-ledger.mjs";
import { verifyGeneratedRecords } from "../scripts/verify-generated-records.mjs";

const enabled = process.env.APTLSS_PILOT_REHEARSAL_TESTS === "1";
const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const escape = (value: string) => "`" + value.replace(/`/g, "``") + "`";
const freshName = "recovery_test";

describe("manager history additive migration metadata", () => {
  const previous = JSON.parse(read("drizzle/meta/0053_snapshot.json"));
  const snapshot = JSON.parse(read("drizzle/meta/0054_snapshot.json"));
  const journal = JSON.parse(read("drizzle/meta/_journal.json"));

  it("appends migration 0054 as the 55th canonical identity", () => {
    expect(journal.entries).toHaveLength(55);
    expect(journal.entries.map((entry: { idx: number }) => entry.idx)).toEqual(
      Array.from({ length: 55 }, (_, idx) => idx)
    );
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 54, version: "5", tag: "0054_revoked_sessions", breakpoints: true,
    });
    expect(journal.entries.at(-1).when).toBeGreaterThan(journal.entries.at(-2).when);
    const migrations = readMigrationFiles({ migrationsFolder: path.join(root, "drizzle") });
    expect(migrations).toHaveLength(55);
    expect(migrations.at(-1)).toMatchObject({
      hash: hash(read("drizzle/0054_revoked_sessions.sql")),
      folderMillis: journal.entries.at(-1).when,
    });
  });

  it("matches the generated schema and links the session migration snapshot", async () => {
    const current = await generateMySQLDrizzleJson(schema);
    expect(snapshot).toMatchObject({ version: "5", dialect: "mysql", prevId: previous.id });
    expect(snapshot.id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    expect(snapshot.id).not.toBe(previous.id);
    expect(snapshot.tables).toEqual(current.tables);
    expect(snapshot.views).toEqual(current.views);
    const retained = structuredClone(snapshot.tables);
    delete retained.revoked_sessions;
    expect(retained).toEqual(previous.tables);
    expect(snapshot.views).toEqual(previous.views);
  }, 30000);

  it("keeps state additions nullable and compact checks linked without cascades", () => {
    const state = snapshot.tables.aptlss_manager_state;
    expect(state.columns.currentCheckId).toMatchObject({ type: "int", notNull: false });
    expect(state.columns.historyScopeHash).toMatchObject({ type: "varchar(64)", notNull: false });
    expect(state.columns.currentCheckId.default).toBeUndefined();
    expect(state.columns.historyScopeHash.default).toBeUndefined();
    const checks = snapshot.tables.aptlss_manager_checks;
    expect(Object.keys(checks.columns)).toEqual([
      "id", "vaId", "runId", "inputHash", "sourceHash", "baseSnapshotHash",
      "snapshotHash", "snapshotPatchJson", "createdAt",
    ]);
    expect(checks.columns.id).toMatchObject({ type: "int", autoincrement: true, notNull: true });
    expect(checks.compositePrimaryKeys.aptlss_manager_checks_id.columns).toEqual(["id"]);
    for (const field of ["vaId", "runId"]) {
      expect(checks.columns[field]).toMatchObject({ type: "int", notNull: true });
    }
    for (const field of ["inputHash", "sourceHash", "baseSnapshotHash", "snapshotHash"]) {
      expect(checks.columns[field]).toMatchObject({ type: "varchar(64)", notNull: true });
    }
    expect(checks.columns.snapshotPatchJson).toMatchObject({ type: "longtext", notNull: true });
    expect(checks.columns.createdAt).toMatchObject({ type: "timestamp", notNull: true, default: "(now())" });
    expect(checks.indexes).toEqual({
      aptlss_manager_checks_worker_idx: { name: "aptlss_manager_checks_worker_idx", columns: ["vaId", "id"], isUnique: false },
      aptlss_manager_checks_run_idx: { name: "aptlss_manager_checks_run_idx", columns: ["runId", "id"], isUnique: false },
    });
    expect(checks.foreignKeys).toEqual({
      manager_check_run_fk: {
        name: "manager_check_run_fk", tableFrom: "aptlss_manager_checks", tableTo: "aptlss_manager_runs",
        columnsFrom: ["runId"], columnsTo: ["id"], onDelete: "no action", onUpdate: "no action",
      },
    });
  });

  it("adds only the revocation table without destructive DDL", () => {
    const sql = read("drizzle/0054_revoked_sessions.sql");
    expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS `revoked_sessions`/);
    expect(sql).toContain("`sessionHash` varchar(64) NOT NULL");
    expect(sql).toContain("`expiresAt` timestamp NOT NULL");
    expect(sql).toContain("INDEX `revoked_sessions_expires_at_idx` (`expiresAt`)");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME|DELETE|UPDATE|FOREIGN_KEY_CHECKS)\b/i);
  });

  it("uses only guarded additive DDL without migrating or deleting history", () => {
    const sql = read("drizzle/0053_manager_history_checks.sql");
    const statements = sql.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean);
    expect(statements).toHaveLength(9);
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `aptlss_manager_checks`/);
    expect(statements[0]).toContain("ON DELETE NO ACTION ON UPDATE NO ACTION");
    expect(statements[0]).toContain("INDEX `aptlss_manager_checks_worker_idx` (`vaId`, `id`)");
    expect(statements[0]).toContain("INDEX `aptlss_manager_checks_run_idx` (`runId`, `id`)");
    const guards = statements.filter(statement => /^SET @\w+ = IF\(/.test(statement));
    expect(guards).toHaveLength(2);
    for (const [idx, column] of ["currentCheckId", "historyScopeHash"].entries()) {
      expect(guards[idx]).toContain("TABLE_SCHEMA=DATABASE()");
      expect(guards[idx]).toContain("TABLE_NAME='aptlss_manager_state' AND COLUMN_NAME='" + column + "'");
      expect(guards[idx]).toContain("'SELECT 1'");
      expect(guards[idx]).toContain("NULL, ALGORITHM=INPLACE, LOCK=NONE");
    }
    for (const prefix of [/^PREPARE /, /^EXECUTE /, /^DEALLOCATE PREPARE /]) {
      expect(statements.filter(statement => prefix.test(statement))).toHaveLength(2);
    }
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME|CASCADE|FOREIGN_KEY_CHECKS)\b/i);
    expect(statements.some(statement => /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement))).toBe(false);
    expect([...sql.matchAll(/ALTER TABLE `([^`]+)`/g)].map(match => match[1])).toEqual([
      "aptlss_manager_state", "aptlss_manager_state",
    ]);
  });
});

// Deliberately excluded from ordinary test runs. No dotenv or application imports.
describe.skipIf(!enabled)(
  "isolated native MySQL pilot migration rehearsal",
  () => {
    const connections: Connection[] = [];
    let restored: Connection;
    let fresh: Connection;
    let rehearsalFailed = false;
    const fullSize = Boolean(process.env.APTLSS_REHEARSAL_SOURCE_MANIFEST);
    const snapshot = JSON.parse(read("drizzle/meta/0054_snapshot.json"));
    const baseline = JSON.parse(
      read("drizzle/contracts/0045-canonical-baseline.json")
    );
    const journal = JSON.parse(read("drizzle/meta/_journal.json"));
    const migrationSql = read("drizzle/0045_aptlss_pilot_consolidation.sql");

    beforeAll(async () => {
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
          "Only the explicitly restored rehearsal database on 127.0.0.1:33317 is allowed"
        );
      }
      for (const database of ["aptlss_pilot_rehearsal", freshName]) {
        connections.push(
          await mysql.createConnection({
            host: url.hostname,
            port: 33317,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            database,
            connectTimeout: 10000,
            dateStrings: true,
          })
        );
      }
      [restored, fresh] = connections;
      // Bound server work below the test deadline; a timed-out SELECT must not
      // remain queued while a subsequent migration test uses the connection.
      for (const connection of connections) {
        await connection.query("SET SESSION MAX_EXECUTION_TIME=" + (fullSize ? 900000 : 25000));
      }
    });

    beforeEach(() => {
      if (rehearsalFailed) throw new Error("Rehearsal stopped after a failed assertion; no further database work is allowed");
      onTestFailed(() => {
        rehearsalFailed = true;
        for (const connection of connections) connection.destroy();
      });
    });

    afterAll(async () => {
      if (rehearsalFailed) return;
      for (const connection of connections) await connection.end();
    });

    async function rows(db: Connection, query: string) {
      return (await db.query<RowDataPacket[]>(query))[0];
    }

    async function fingerprint(db: Connection) {
      await db.query("SET SESSION TRANSACTION READ ONLY");
      await db.beginTransaction();
      try {
        const tables = await rows(
          db,
          "SELECT TABLE_NAME name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
        );
        const result: Record<string, unknown> = {};
        for (const { name } of tables) {
          const definition = (
            await rows(db, "SHOW CREATE TABLE " + escape(name))
          )[0]["Create Table"];
          result[name] = {
            definition,
            ...(await fingerprintWholeTable(db.connection, name)),
          };
        }
        return result;
      } finally {
        await db.rollback();
        await db.query("SET SESSION TRANSACTION READ WRITE");
      }
    }

    const normalizeDefault = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value === "boolean") return value ? "1" : "0";
      const text = String(value).replace(/^'|'$/g, "");
      return /^(?:\(*now\(\)\)*|current_timestamp(?:\(\d*\))?)$/i.test(text)
        ? "now"
        : text;
    };

    it("retains every captured applied identity and appends only unapplied canonical migrations through 0054", async () => {
      const original = readRehearsalMigrationLedger(
        root,
        process.env.APTLSS_REHEARSAL_SOURCE_MANIFEST
      );
      const ledger = await rows(
        restored,
        "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id"
      );
      expect(Array.isArray(original) && original.length > 0).toBe(true);
      const lastApplied = Math.max(
        ...original.map((entry: { created_at: number }) =>
          Number(entry.created_at)
        )
      );
      expect(Number.isSafeInteger(lastApplied)).toBe(true);
      const appended = journal.entries.filter(
        (entry: { when: number }) => entry.when > lastApplied
      );
      expect(
        ledger.map(row => ({
          hash: row.hash,
          created_at: Number(row.created_at),
        }))
      ).toEqual([
        ...original,
        ...appended.map((entry: { tag: string; when: number }) => ({
          hash: hash(read("drizzle/" + entry.tag + ".sql")),
          created_at: entry.when,
        })),
      ]);
    });

    it("applies all 55 canonical migrations through 0054 from empty with no foreign lineage", async () => {
      expect(journal.entries).toHaveLength(55);
      expect(journal.entries.at(-1).tag).toBe(
        "0054_revoked_sessions"
      );
      const ledger = await rows(
        fresh,
        "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id"
      );
      expect(
        ledger.map(row => ({
          hash: row.hash,
          created_at: Number(row.created_at),
        }))
      ).toEqual(
        journal.entries.map((entry: { tag: string; when: number }) => ({
          hash: hash(read("drizzle/" + entry.tag + ".sql")),
          created_at: entry.when,
        }))
      );
    });

    for (const target of ["restored", "fresh"] as const) {
      it(
        "matches all expected tables and pilot types/defaults/keys/FKs on " +
          target,
        async () => {
          const db = target === "restored" ? restored : fresh;
          const columns = await rows(
            db,
            "SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,GENERATION_EXPRESSION FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE()"
          );
          const indexes = await rows(
            db,
            "SELECT TABLE_NAME,INDEX_NAME,COLUMN_NAME,NON_UNIQUE,SEQ_IN_INDEX FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX"
          );
          const fks = await rows(
            db,
            "SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION"
          );
          for (const [name, table] of Object.entries(snapshot.tables) as [
            string,
            any,
          ][]) {
            const actual = columns.filter(row => row.TABLE_NAME === name);
            expect(actual.length, name).toBeGreaterThan(0);
            for (const columnName of Object.keys(table.columns)) {
              expect(
                actual.some(row => row.COLUMN_NAME === columnName),
                name + "." + columnName
              ).toBe(true);
            }
            if (name in baseline.tables) continue;
            expect(actual).toHaveLength(Object.keys(table.columns).length);
            const generatedColumns: { name: string; expression: string }[] = [];
            for (const [columnName, column] of Object.entries(
              table.columns
            ) as [string, any][]) {
              const found = actual.find(row => row.COLUMN_NAME === columnName)!;
              expect(found.COLUMN_TYPE, name + "." + columnName).toBe(
                column.type === "boolean" ? "tinyint(1)" : column.type
              );
              expect(found.IS_NULLABLE).toBe(column.notNull ? "NO" : "YES");
              expect(
                normalizeDefault(found.COLUMN_DEFAULT),
                name + "." + columnName
              ).toBe(normalizeDefault(column.default));
              expect(found.EXTRA.includes("auto_increment")).toBe(
                column.autoincrement
              );
              expect(found.EXTRA.includes("on update")).toBe(!!column.onUpdate);
              if (column.generated) {
                expect(found.EXTRA).toContain(
                  column.generated.type.toUpperCase() + " GENERATED"
                );
                const expression = found.GENERATION_EXPRESSION.replaceAll(
                  "\\'",
                  "'"
                );
                const normalize = (expression: string) =>
                  expression
                    .replaceAll("`", "")
                    .replace(/_utf8mb4(?=')/g, "")
                    .replace(/\s+/g, "")
                    .toLowerCase();
                expect(normalize(expression)).toBe(
                  normalize(column.generated.as)
                );
                // JSON paths and literal values are case-sensitive even though SQL
                // function names and MySQL's generated formatting are not.
                expect(expression.match(/'(?:''|[^'])*'/g)).toEqual(
                  column.generated.as.match(/'(?:''|[^'])*'/g)
                );
                generatedColumns.push({ name: columnName, expression: column.generated.as });
              } else {
                expect(
                  found.GENERATION_EXPRESSION,
                  name + "." + columnName
                ).toBe("");
              }
            }
            if (generatedColumns.length) {
              const covering = (Object.values(table.indexes) as any[]).find(index =>
                index.columns.includes("id") && generatedColumns.every(column => index.columns.includes(column.name))
              );
              expect(covering, name + " generated verification index").toBeDefined();
              await verifyGeneratedRecords(db, name, generatedColumns, covering.name);
            }
            for (const index of Object.values(table.indexes) as any[]) {
              const found = indexes.filter(
                row => row.TABLE_NAME === name && row.INDEX_NAME === index.name
              );
              expect(
                found.map(row => row.COLUMN_NAME),
                index.name
              ).toEqual(index.columns);
              expect(
                found.every(
                  row => Number(row.NON_UNIQUE) === (index.isUnique ? 0 : 1)
                )
              ).toBe(true);
            }
            for (const pk of Object.values(
              table.compositePrimaryKeys
            ) as any[]) {
              expect(
                indexes
                  .filter(
                    row =>
                      row.TABLE_NAME === name && row.INDEX_NAME === "PRIMARY"
                  )
                  .map(row => row.COLUMN_NAME)
              ).toEqual(pk.columns);
            }
            for (const fk of Object.values(table.foreignKeys) as any[]) {
              const found = fks.filter(
                row =>
                  row.TABLE_NAME === name && row.CONSTRAINT_NAME === fk.name
              );
              expect(found.map(row => row.COLUMN_NAME)).toEqual(fk.columnsFrom);
              expect(found.map(row => row.REFERENCED_COLUMN_NAME)).toEqual(
                fk.columnsTo
              );
              expect(
                found.every(row => row.REFERENCED_TABLE_NAME === fk.tableTo)
              ).toBe(true);
              const rule = (value: string) =>
                value === "NO ACTION" ? "RESTRICT" : value;
              expect(
                found.every(
                  row =>
                    rule(row.UPDATE_RULE) === rule(fk.onUpdate.toUpperCase())
                )
              ).toBe(true);
              expect(
                found.every(
                  row =>
                    rule(row.DELETE_RULE) === rule(fk.onDelete.toUpperCase())
                )
              ).toBe(true);
            }
          }
        },
        fullSize && target === "restored" ? 1200000 : 30000
      );

      it(
        "runner rerun preserves every table definition, row digest and ledger row on " +
          target,
        async () => {
          const db = target === "restored" ? restored : fresh;
          const before = await fingerprint(db);
          await migrate(drizzle(db), {
            migrationsFolder: path.join(root, "drizzle"),
          });
          expect(await fingerprint(db)).toEqual(before);
        },
        fullSize && target === "restored" ? 1800000 : 60000
      );
    }

    it("direct 0045 SQL replay preserves schema, data and ledger without duplicating slots", async () => {
      const before = await fingerprint(fresh);
      for (const statement of migrationSql.split("--> statement-breakpoint")) {
        if (statement.trim()) await fresh.query(statement);
      }
      expect(await fingerprint(fresh)).toEqual(before);
      expect(
        await rows(
          fresh,
          "SELECT id,vaId,token,leaseUntil FROM aptlss_manager_queue_slots ORDER BY id"
        )
      ).toEqual(
        [1, 2, 3, 4].map(id => ({
          id,
          vaId: null,
          token: null,
          leaseUntil: null,
        }))
      );
    }, 60000);
  }
);
