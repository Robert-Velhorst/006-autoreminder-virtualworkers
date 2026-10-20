import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const sql = readFileSync(path.join(root, "drizzle/0045_aptlss_pilot_consolidation.sql"), "utf8").replace(/\r\n/g, "\n");
const snapshot = JSON.parse(readFileSync(path.join(root, "drizzle/meta/0045_snapshot.json"), "utf8"));
const baseline = JSON.parse(readFileSync(path.join(root, "drizzle/contracts/0045-canonical-baseline.json"), "utf8"));
const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const quoted = (names: string[]) => names.map(name => "`" + name + "`").join(",");
const dynamic = [...sql.matchAll(/^  '((?:''|[^'])*)'\n\);/gm)].map(m => m[1].replace(/''/g, "'"));
const expanded = sql + "\n" + dynamic.join(";\n");
const creates = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)` \(\n([\s\S]*?)\n\);/g)];

describe("APTLSS pilot SQL matches declared storage contracts (offline, not a DB rehearsal)", () => {
  it("contains the exact source-only table set", () => {
    expect(creates.map(m => m[1]).sort()).toEqual(Object.keys(snapshot.tables).filter(n => !(n in baseline.tables)).sort());
  });

  for (const create of creates) {
    const name = create[1];
    it("preserves column types, defaults, precision and constraints for " + name, () => {
      const table = snapshot.tables[name];
      const columns: Record<string, string> = {};
      for (const m of create[2].matchAll(/^\s*`([^`]+)` (.*?)(?:,)?$/gm)) columns[m[1]] = m[2].replace(/,$/, "");
      for (const ddl of dynamic) {
        const m = ddl.match(/^ALTER TABLE `([^`]+)` ADD `([^`]+)` (.*)$/);
        if (m?.[1] === name) columns[m[2]] = m[3];
      }
      expect(Object.keys(columns).sort()).toEqual(Object.keys(table.columns).sort());
      for (const [columnName, definition] of Object.entries(columns)) {
        const column = table.columns[columnName];
        expect(definition.match(/^\w+(?:\([^)]*\))?/)?.[0], columnName).toBe(column.type);
        expect(/\bNOT NULL\b/.test(definition), columnName).toBe(column.notNull);
        expect(/\bAUTO_INCREMENT\b/.test(definition), columnName).toBe(column.autoincrement);
        expect(/ON UPDATE CURRENT_TIMESTAMP/.test(definition), columnName).toBe(!!column.onUpdate);
        const defaultValue = definition.match(/\bDEFAULT ((?:'[^']*')|\(now\(\)\)|\w+)/)?.[1];
        expect(defaultValue, columnName).toBe(column.default === undefined ? undefined : String(column.default));
      }
      for (const key of Object.values(table.compositePrimaryKeys) as any[]) {
        expect(compact(create[2])).toContain(compact("CONSTRAINT `" + key.name + "` PRIMARY KEY(" + quoted(key.columns) + ")"));
      }
      for (const index of Object.values(table.indexes) as any[]) {
        const ddl = index.isUnique
          ? "CONSTRAINT `" + index.name + "` UNIQUE(" + quoted(index.columns) + ")"
          : "CREATE INDEX `" + index.name + "` ON `" + name + "` (" + quoted(index.columns) + ")";
        expect(compact(expanded), index.name).toContain(compact(ddl));
      }
      for (const fk of Object.values(table.foreignKeys) as any[]) {
        const ddl = "ALTER TABLE `" + name + "` ADD CONSTRAINT `" + fk.name + "` FOREIGN KEY (" +
          quoted(fk.columnsFrom) + ") REFERENCES `" + fk.tableTo + "`(" + quoted(fk.columnsTo) +
          ") ON DELETE " + fk.onDelete + " ON UPDATE " + fk.onUpdate;
        expect(compact(expanded), fk.name).toContain(compact(ddl));
      }
    });
  }

  it("tests each addition against its own table and column/index/constraint before preparing it", () => {
    const statements = sql.split("--> statement-breakpoint").map(s => s.trim());
    let guards = 0;
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (!statement.startsWith("SET @aptlss_pilot_ddl = IF(")) continue;
      guards++;
      const ddl = statement.match(/^  '((?:''|[^'])*)'\n\);/m)![1].replace(/''/g, "'");
      const alter = ddl.match(/^ALTER TABLE `([^`]+)` ADD (?:CONSTRAINT )?`([^`]+)`/);
      const index = ddl.match(/^CREATE INDEX `([^`]+)` ON `([^`]+)`/);
      const table = alter?.[1] ?? index?.[2];
      const object = alter?.[2] ?? index?.[1];
      const kind = index ? "INDEX_NAME" : ddl.includes("ADD CONSTRAINT") ? "CONSTRAINT_NAME" : "COLUMN_NAME";
      expect(statement).toContain("TABLE_NAME = '" + table + "'");
      expect(statement).toContain(kind + " = '" + object + "'");
      expect(statement).toContain("'SELECT 1'");
      expect(statements.slice(i + 1, i + 4)).toEqual([
        "PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;",
        "EXECUTE aptlss_pilot_stmt;",
        "DEALLOCATE PREPARE aptlss_pilot_stmt;",
      ]);
    }
    expect(guards).toBe(30);
  });
});
