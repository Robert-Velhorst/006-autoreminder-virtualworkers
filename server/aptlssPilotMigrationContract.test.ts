import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateMySQLDrizzleJson } from "drizzle-kit/api";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "../drizzle/schema";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const baseline = JSON.parse(read("drizzle/contracts/0045-canonical-baseline.json"));
const journal = JSON.parse(read("drizzle/meta/_journal.json"));
const migrationPath = "drizzle/0045_aptlss_pilot_consolidation.sql";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const names = [
  "aptlss_evidence_conflicts", "aptlss_evidence_revisions",
  "aptlss_evidence_subject_links", "aptlss_verification_followups",
  "aptlss_manager_state", "aptlss_manager_updates", "aptlss_manager_runs",
  "aptlss_manager_reviews", "aptlss_manager_control", "aptlss_manager_corrections",
  "aptlss_manager_trial_events", "aptlss_manager_queue",
  "aptlss_manager_queue_events", "aptlss_manager_queue_slots",
];

describe("APTLSS pilot additive migration contract", () => {
  it("preserves every canonical applied SQL hash and journal identity through 0044", () => {
    expect(journal.entries.slice(0, 45)).toEqual(baseline.journal.entries);
    for (const [file, expected] of Object.entries(baseline.hashes)) {
      expect(hash(readFileSync(path.join(root, "drizzle", file))), file).toBe(expected);
    }
  });

  it("schedules exactly one consolidation after the observed foreign migration watermark", () => {
    expect(journal.entries).toHaveLength(47);
    expect(journal.entries[45]).toMatchObject({
      idx: 45, tag: "0045_aptlss_pilot_consolidation", version: "5", breakpoints: true,
    });
    expect(journal.entries[45].when).toBeGreaterThan(1788555042308);
    expect(existsSync(path.join(root, migrationPath))).toBe(true);
    const migrations = readMigrationFiles({ migrationsFolder: path.join(root, "drizzle") });
    expect(migrations.filter(m => m.folderMillis > 1788555042308 && m.folderMillis <= journal.entries[45].when)).toHaveLength(1);
    expect(migrations[45]?.hash).toBe(hash(read(migrationPath)));
  });

  it("preserves all 117 main table definitions and adds exactly the 14 source tables", async () => {
    const current = await generateMySQLDrizzleJson(schema);
    for (const [name, expected] of Object.entries(baseline.tables)) {
      expect(hash(JSON.stringify(current.tables[name])), name).toBe(expected);
    }
    expect(Object.keys(current.tables).filter(name => !(name in baseline.tables)).sort()).toEqual([...names].sort());
    for (const name of ["aptlss_manager_state", "aptlss_manager_runs"]) {
      expect(current.tables[name]?.columns.mode).toMatchObject({
        type: "enum('shadow','active')", notNull: true, default: "'shadow'",
      });
    }
  }, 30000);

  it("records a complete Drizzle-generated snapshot linked to the retained previous snapshot", async () => {
    expect(existsSync(path.join(root, "drizzle/meta/0045_snapshot.json"))).toBe(true);
    const snapshot = JSON.parse(read("drizzle/meta/0045_snapshot.json"));
    const previous = JSON.parse(read("drizzle/meta/0031_snapshot.json"));
    const current = await generateMySQLDrizzleJson(schema);
    expect(snapshot.prevId).toBe(previous.id);
    const latest = JSON.parse(read("drizzle/meta/0046_snapshot.json"));
    expect(latest.prevId).toBe(snapshot.id);
    expect(latest.tables).toEqual(current.tables);
    expect(latest.views).toEqual(current.views);
    const retained = structuredClone(latest.tables);
    delete retained.aptlss_manager_runs.columns.reviewDigest;
    delete retained.aptlss_manager_runs.columns.reviewUrgent;
    delete retained.aptlss_manager_runs.indexes.aptlss_manager_runs_review_idx;
    expect(retained).toEqual(snapshot.tables);
    expect(snapshot.version).toBe("5");
    expect(snapshot.dialect).toBe("mysql");
  }, 30000);

  it("limits DDL to source-only tables and guards MySQL 8 additions without destructive changes", () => {
    expect(existsSync(path.join(root, migrationPath))).toBe(true);
    const sql = read(migrationPath);
    const statements = sql.split("--> statement-breakpoint").map(s => s.replace(/^--[^\n]*\n/gm, "").trim()).filter(Boolean);
    expect(statements.filter(s => /^CREATE TABLE IF NOT EXISTS/.test(s))).toHaveLength(14);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|RENAME TABLE|REPLACE INTO|INSERT IGNORE|FOREIGN_KEY_CHECKS)\b/i);
    expect(sql).not.toMatch(/ADD (?:COLUMN )?IF NOT EXISTS/i);
    const targets = [...sql.matchAll(/(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE) `([^`]+)`/g)].map(m => m[1]);
    expect(targets.every(name => names.includes(name))).toBe(true);
    const guarded = statements.filter(s => /^SET @aptlss_pilot_ddl = IF/.test(s));
    expect(guarded.filter(s => s.includes("information_schema.COLUMNS"))).toHaveLength(8);
    expect(guarded.every(s => s.includes("DATABASE()"))).toBe(true);
    expect(statements.filter(s => /^PREPARE /.test(s))).toHaveLength(guarded.length);
    expect(statements.filter(s => /^EXECUTE /.test(s))).toHaveLength(guarded.length);
    expect(statements.filter(s => /^DEALLOCATE PREPARE /.test(s))).toHaveLength(guarded.length);
    // Seeding must not clear occupied slot leases or suppress unrelated SQL errors.
    const seeds = statements.filter(s => /^INSERT INTO/.test(s));
    expect(seeds).toHaveLength(4);
    for (const seed of seeds) expect(seed).toMatch(/WHERE NOT EXISTS/);
  });
});
