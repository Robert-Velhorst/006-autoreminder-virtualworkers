import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.APTLSS_PILOT_REHEARSAL_TESTS === "1";
const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const escape = (value: string) => "`" + value.replace(/`/g, "``") + "`";
const freshName = "recovery_test";

// Deliberately excluded from ordinary test runs. No dotenv or application imports.
describe.skipIf(!enabled)("isolated native MySQL pilot migration rehearsal", () => {
  const connections: Connection[] = [];
  let restored: Connection;
  let fresh: Connection;
  const snapshot = JSON.parse(read("drizzle/meta/0046_snapshot.json"));
  const baseline = JSON.parse(read("drizzle/contracts/0045-canonical-baseline.json"));
  const journal = JSON.parse(read("drizzle/meta/_journal.json"));
  const migrationSql = read("drizzle/0045_aptlss_pilot_consolidation.sql");

  beforeAll(async () => {
    const url = new URL(process.env.APTLSS_REHEARSAL_DATABASE_URL || "");
    if (url.protocol !== "mysql:" || url.hostname !== "127.0.0.1" || url.port !== "33317"
      || url.pathname !== "/aptlss_pilot_rehearsal" || url.search || url.hash) {
      throw new Error("Only the explicitly restored rehearsal database on 127.0.0.1:33317 is allowed");
    }
    for (const database of ["aptlss_pilot_rehearsal", freshName]) {
      connections.push(await mysql.createConnection({
        host: url.hostname, port: 33317, user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password), database, connectTimeout: 10000,
        dateStrings: true,
      }));
    }
    [restored, fresh] = connections;
  });

  afterAll(async () => {
    for (const connection of connections) await connection.end();
  });

  async function rows(db: Connection, query: string) {
    return (await db.query<RowDataPacket[]>(query))[0];
  }

  async function fingerprint(db: Connection) {
    const tables = await rows(db, "SELECT TABLE_NAME name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    const result: Record<string, unknown> = {};
    for (const { name } of tables) {
      const definition = (await rows(db, "SHOW CREATE TABLE " + escape(name)))[0]["Create Table"];
      const records = await rows(db, "SELECT * FROM " + escape(name));
      const digests = records.map(row => hash(JSON.stringify(row))).sort();
      result[name] = { definition, count: records.length, hash: hash(digests.join("\n")) };
    }
    return result;
  }

  const normalizeDefault = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return value ? "1" : "0";
    const text = String(value).replace(/^'|'$/g, "");
    return /^(?:\(*now\(\)\)*|current_timestamp(?:\(\d*\))?)$/i.test(text) ? "now" : text;
  };

  it("retains all 47 restored applied identities and appends canonical 0045 and 0046", async () => {
    const original = JSON.parse(read(".local/pilot/applied-migrations.json"));
    const ledger = await rows(restored, "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id");
    expect(ledger).toHaveLength(49);
    expect(ledger.slice(0, 47).map(row => ({ hash: row.hash, created_at: Number(row.created_at) }))).toEqual(original);
    expect(ledger[47]).toMatchObject({ hash: hash(migrationSql), created_at: journal.entries[45].when });
    expect(ledger[48]).toMatchObject({ hash: hash(read("drizzle/0046_manager_review_index.sql")), created_at: journal.entries[46].when });
  });

  it("applies all 46 canonical migrations from empty with no foreign lineage", async () => {
    const ledger = await rows(fresh, "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id");
    expect(ledger.map(row => ({ hash: row.hash, created_at: Number(row.created_at) }))).toEqual(
      journal.entries.map((entry: { tag: string; when: number }) => ({ hash: hash(read("drizzle/" + entry.tag + ".sql")), created_at: entry.when }))
    );
  });

  for (const target of ["restored", "fresh"] as const) {
    it("matches all expected tables and pilot types/defaults/keys/FKs on " + target, async () => {
      const db = target === "restored" ? restored : fresh;
      const columns = await rows(db, "SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE()");
      const indexes = await rows(db, "SELECT TABLE_NAME,INDEX_NAME,COLUMN_NAME,NON_UNIQUE,SEQ_IN_INDEX FROM information_schema.statistics WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX");
      const fks = await rows(db, "SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION");
      for (const [name, table] of Object.entries(snapshot.tables) as [string, any][]) {
        const actual = columns.filter(row => row.TABLE_NAME === name);
        expect(actual.length, name).toBeGreaterThan(0);
        for (const columnName of Object.keys(table.columns)) {
          expect(actual.some(row => row.COLUMN_NAME === columnName), name + "." + columnName).toBe(true);
        }
        if (name in baseline.tables) continue;
        expect(actual).toHaveLength(Object.keys(table.columns).length);
        for (const [columnName, column] of Object.entries(table.columns) as [string, any][]) {
          const found = actual.find(row => row.COLUMN_NAME === columnName)!;
          expect(found.COLUMN_TYPE, name + "." + columnName).toBe(column.type === "boolean" ? "tinyint(1)" : column.type);
          expect(found.IS_NULLABLE).toBe(column.notNull ? "NO" : "YES");
          expect(normalizeDefault(found.COLUMN_DEFAULT), name + "." + columnName).toBe(normalizeDefault(column.default));
          expect(found.EXTRA.includes("auto_increment")).toBe(column.autoincrement);
          expect(found.EXTRA.includes("on update")).toBe(!!column.onUpdate);
        }
        for (const index of Object.values(table.indexes) as any[]) {
          const found = indexes.filter(row => row.TABLE_NAME === name && row.INDEX_NAME === index.name);
          expect(found.map(row => row.COLUMN_NAME), index.name).toEqual(index.columns);
          expect(found.every(row => Number(row.NON_UNIQUE) === (index.isUnique ? 0 : 1))).toBe(true);
        }
        for (const pk of Object.values(table.compositePrimaryKeys) as any[]) {
          expect(indexes.filter(row => row.TABLE_NAME === name && row.INDEX_NAME === "PRIMARY").map(row => row.COLUMN_NAME)).toEqual(pk.columns);
        }
        for (const fk of Object.values(table.foreignKeys) as any[]) {
          const found = fks.filter(row => row.TABLE_NAME === name && row.CONSTRAINT_NAME === fk.name);
          expect(found.map(row => row.COLUMN_NAME)).toEqual(fk.columnsFrom);
          expect(found.map(row => row.REFERENCED_COLUMN_NAME)).toEqual(fk.columnsTo);
          expect(found.every(row => row.REFERENCED_TABLE_NAME === fk.tableTo)).toBe(true);
          const rule = (value: string) => value === "NO ACTION" ? "RESTRICT" : value;
          expect(found.every(row => rule(row.UPDATE_RULE) === rule(fk.onUpdate.toUpperCase()))).toBe(true);
          expect(found.every(row => rule(row.DELETE_RULE) === rule(fk.onDelete.toUpperCase()))).toBe(true);
        }
      }
    }, 30000);

    it("runner rerun preserves every table definition, row digest and ledger row on " + target, async () => {
      const db = target === "restored" ? restored : fresh;
      const before = await fingerprint(db);
      await migrate(drizzle(db), { migrationsFolder: path.join(root, "drizzle") });
      expect(await fingerprint(db)).toEqual(before);
    }, 60000);
  }

  it("direct 0045 SQL replay preserves schema, data and ledger without duplicating slots", async () => {
    const before = await fingerprint(fresh);
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      if (statement.trim()) await fresh.query(statement);
    }
    expect(await fingerprint(fresh)).toEqual(before);
    expect(await rows(fresh, "SELECT id,vaId,token,leaseUntil FROM aptlss_manager_queue_slots ORDER BY id")).toEqual(
      [1, 2, 3, 4].map(id => ({ id, vaId: null, token: null, leaseUntil: null }))
    );
  }, 60000);
});
