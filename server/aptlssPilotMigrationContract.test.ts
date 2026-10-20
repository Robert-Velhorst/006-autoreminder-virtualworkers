import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDrizzleJson } from "drizzle-kit/api";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "../drizzle/schema.postgres";

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
  "aptlss_manager_checks",
];

describe("APTLSS pilot additive migration contract", () => {
  it("preserves every canonical applied SQL hash and journal identity through 0044", () => {
    expect(journal.entries.slice(0, 45)).toEqual(baseline.journal.entries);
    for (const [file, expected] of Object.entries(baseline.hashes)) {
      const sql = readFileSync(path.join(root, "drizzle", file), "utf8");
      const lineEndingHashes = [
        hash(sql),
        hash(sql.replace(/\r\n/g, "\n")),
        hash(sql.replace(/\r?\n/g, "\r\n")),
      ];
      expect(lineEndingHashes, file).toContain(expected);
    }
  });

  it("retains the consolidation and appends only the reviewed additive migrations", () => {
    expect(journal.entries).toHaveLength(55);
    expect(journal.entries[45]).toMatchObject({
      idx: 45, tag: "0045_aptlss_pilot_consolidation", version: "5", breakpoints: true,
    });
    expect(journal.entries[45].when).toBeGreaterThan(1788555042308);
    expect(existsSync(path.join(root, migrationPath))).toBe(true);
    const migrations = readMigrationFiles({ migrationsFolder: path.join(root, "drizzle") });
    expect(migrations.filter(m => m.folderMillis > 1788555042308 && m.folderMillis <= journal.entries[45].when)).toHaveLength(1);
    expect(migrations[45]?.hash).toBe(hash(read(migrationPath)));
    expect(journal.entries.slice(47).map((entry: { idx: number; tag: string }) => [entry.idx, entry.tag])).toEqual([
      [47, "0047_worker_queue_trello_due_index"],
      [48, "0048_structured_manager_worker_updates"],
      [49, "0049_founder_decision_deadlines"],
      [50, "0050_founder_decision_disposition"],
      [51, "0051_browser_collector_ordering"],
      [52, "0052_manager_completion_reports"],
      [53, "0053_manager_history_checks"],
      [54, "0054_revoked_sessions"],
    ]);
    expect(migrations[50]?.hash).toBe(hash(read("drizzle/0050_founder_decision_disposition.sql")));
    expect(migrations[51]?.hash).toBe(hash(read("drizzle/0051_browser_collector_ordering.sql")));
    expect(migrations[52]?.hash).toBe(hash(read("drizzle/0052_manager_completion_reports.sql")));
    expect(migrations[53]?.hash).toBe(hash(read("drizzle/0053_manager_history_checks.sql")));
    expect(migrations[54]?.hash).toBe(hash(read("drizzle/0054_revoked_sessions.sql")));
  });

  it("preserves all 117 historical MySQL main table definitions in the frozen migration lineage", async () => {
    const current = JSON.parse(read("drizzle/meta/0054_snapshot.json"));
    for (const [name, expected] of Object.entries(baseline.tables)) {
      const table = structuredClone(current.tables[name]);
      if (name === "trello_cached_cards") delete table.indexes.trello_cached_cards_user_card_cached_idx;
      if (name === "decision_outcomes") delete table.columns.disposition;
      if (name === "browser_tab_states") {
        delete table.columns.captureSequence;
        delete table.columns.sourceCapturedAt;
      }
      expect(hash(JSON.stringify(table)), name).toBe(expected);
    }
    expect(Object.keys(current.tables).filter(name => !(name in baseline.tables)).sort()).toEqual([...names, "founder_decision_deadlines", "revoked_sessions"].sort());
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
    const current = JSON.parse(read("drizzle/meta/0054_snapshot.json"));
    expect(snapshot.prevId).toBe(previous.id);
    const review = JSON.parse(read("drizzle/meta/0046_snapshot.json"));
    const queue = JSON.parse(read("drizzle/meta/0047_snapshot.json"));
    const update = JSON.parse(read("drizzle/meta/0048_snapshot.json"));
    const deadline = JSON.parse(read("drizzle/meta/0049_snapshot.json"));
    const disposition = JSON.parse(read("drizzle/meta/0050_snapshot.json"));
    const latest = JSON.parse(read("drizzle/meta/0051_snapshot.json"));
    const completion = JSON.parse(read("drizzle/meta/0052_snapshot.json"));
    const history = JSON.parse(read("drizzle/meta/0053_snapshot.json"));
    const sessions = JSON.parse(read("drizzle/meta/0054_snapshot.json"));
    expect(review.prevId).toBe(snapshot.id);
    expect(queue.prevId).toBe(review.id);
    expect(update.prevId).toBe(queue.id);
    expect(deadline.prevId).toBe(update.id);
    expect(disposition.prevId).toBe(deadline.id);
    expect(latest.prevId).toBe(disposition.id);
    expect(completion.prevId).toBe(latest.id);
    expect(history.prevId).toBe(completion.id);
    expect(sessions.prevId).toBe(history.id);
    expect(sessions.tables).toEqual(current.tables);
    expect(sessions.views).toEqual(current.views);
    const beforeSessionRevocation = structuredClone(sessions.tables);
    delete beforeSessionRevocation.revoked_sessions;
    expect(beforeSessionRevocation).toEqual(history.tables);
    expect(sessions.views).toEqual(history.views);
    const beforeHistoryChecks = structuredClone(history.tables);
    delete beforeHistoryChecks.aptlss_manager_checks;
    delete beforeHistoryChecks.aptlss_manager_state.columns.currentCheckId;
    delete beforeHistoryChecks.aptlss_manager_state.columns.historyScopeHash;
    expect(beforeHistoryChecks).toEqual(completion.tables);
    const beforeCollectorOrdering = structuredClone(latest.tables);
    delete beforeCollectorOrdering.browser_tab_states.columns.captureSequence;
    delete beforeCollectorOrdering.browser_tab_states.columns.sourceCapturedAt;
    expect(beforeCollectorOrdering).toEqual(disposition.tables);
    const beforeDisposition = structuredClone(disposition.tables);
    delete beforeDisposition.decision_outcomes.columns.disposition;
    expect(beforeDisposition).toEqual(deadline.tables);
    const beforeDeadline = structuredClone(deadline.tables);
    delete beforeDeadline.founder_decision_deadlines;
    expect(beforeDeadline).toEqual(update.tables);
    const beforeQueue = structuredClone(queue.tables);
    delete beforeQueue.trello_cached_cards.indexes.trello_cached_cards_user_card_cached_idx;
    expect(beforeQueue).toEqual(review.tables);
    const beforeUpdate = structuredClone(update.tables);
    for (const column of ["outcome", "deadlineDate", "sourceEvidenceId", "sourceDescription"]) delete beforeUpdate.aptlss_manager_updates.columns[column];
    expect(beforeUpdate).toEqual(queue.tables);
    const beforeCompletionReports = structuredClone(completion.tables);
    for (const column of ["reportKind", "actionId", "assessmentRunId", "requestKey"]) delete beforeCompletionReports.aptlss_manager_updates.columns[column];
    delete beforeCompletionReports.aptlss_manager_updates.indexes.aptlss_manager_updates_request_unique;
    expect(beforeCompletionReports).toEqual(latest.tables);
    const retained = structuredClone(review.tables);
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

  it("guards both later migrations and never removes existing data", () => {
    for (const file of ["drizzle/0047_worker_queue_trello_due_index.sql", "drizzle/0048_structured_manager_worker_updates.sql"]) {
      const sql = read(file);
      expect(sql).toMatch(/information_schema\.(?:STATISTICS|COLUMNS)/);
      expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|RENAME TABLE)\b/i);
      const guarded = [...sql.matchAll(/SET @\w+ = IF\(EXISTS\(/g)].length;
      expect(guarded).toBe(file.includes("0047") ? 1 : 4);
      expect([...sql.matchAll(/EXECUTE \w+;/g)]).toHaveLength(guarded);
    }
  });

  it("adds only the founder deadline history and guards its index on rerun", () => {
    const sql = read("drizzle/0049_founder_decision_deadlines.sql");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `founder_decision_deadlines`/);
    expect(sql).toMatch(/information_schema\.STATISTICS/);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|RENAME TABLE)\b/i);
    expect(sql).toMatch(/PREPARE founder_deadline_stmt/);
    expect(sql).toMatch(/EXECUTE founder_deadline_stmt/);
  });

  it("adds only an explicit disposition to existing decision outcomes and is rerun-safe", () => {
    const sql = read("drizzle/0050_founder_decision_disposition.sql");
    expect(sql).toMatch(/information_schema\.COLUMNS/);
    expect(sql).toMatch(/TABLE_NAME='decision_outcomes'.*COLUMN_NAME='disposition'/s);
    expect(sql).toMatch(/ENUM\(''recorded'',''approved'',''rejected''\)/);
    expect(sql).toMatch(/NOT NULL DEFAULT ''recorded''/);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|RENAME TABLE)\b/i);
    expect(sql).toMatch(/PREPARE founder_decision_disposition_stmt/);
    expect(sql).toMatch(/EXECUTE founder_decision_disposition_stmt/);
    expect([...sql.matchAll(/--> statement-breakpoint/g)]).toHaveLength(3);
  });

  it("adds collector ordering metadata without changing existing rows or dropping schema", () => {
    const sql = read("drizzle/0051_browser_collector_ordering.sql");
    expect(sql).toMatch(/information_schema\.COLUMNS/);
    expect(sql).toMatch(/captureSequence/);
    expect(sql).toMatch(/sourceCapturedAt/);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|RENAME TABLE)\b/i);
    expect(sql.match(/^PREPARE /gm)).toHaveLength(2);
    expect(sql.match(/^EXECUTE /gm)).toHaveLength(2);
  });

  it("adds completion-report fields and a request key index with guarded additive DDL", () => {
    const sql = read("drizzle/0052_manager_completion_reports.sql");
    expect(sql).toMatch(/information_schema\.COLUMNS/);
    expect(sql).toMatch(/information_schema\.STATISTICS/);
    expect(sql).toMatch(/aptlss_manager_updates_request_unique/);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|RENAME TABLE)\b/i);
    const statements = sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
    const guarded = statements.filter(s => /^SET @\w+ = IF\(\s*EXISTS\(/s.test(s));
    expect(guarded).toHaveLength(5);
    expect(guarded.every(s => s.includes("DATABASE()"))).toBe(true);
    expect(statements.filter(s => /^PREPARE /.test(s))).toHaveLength(5);
    expect(statements.filter(s => /^EXECUTE /.test(s))).toHaveLength(5);
    expect(statements.filter(s => /^DEALLOCATE PREPARE /.test(s))).toHaveLength(5);
  });
});


describe("active PostgreSQL feature migration metadata", () => {
  it("exactly matches the generated runtime schema and preserves the snapshot chain", async () => {
    const journal = JSON.parse(read("drizzle-postgres-v1/meta/_journal.json"));
    const snapshots = journal.entries.map((entry: { idx: number }) => JSON.parse(read(`drizzle-postgres-v1/meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`)));
    for (let index = 1; index < snapshots.length; index++) expect(snapshots[index].prevId).toBe(snapshots[index - 1].id);
    const generated = await generateDrizzleJson(schema);
    expect(snapshots.at(-1).tables).toEqual(generated.tables);
    expect(snapshots.at(-1).enums).toEqual(generated.enums);
    expect(snapshots.at(-1).views).toEqual(generated.views);
    expect(generated.tables["public.browser_tab_states"].columns.captureSequence.type).toBe("bigint");
    const historical = JSON.parse(read("drizzle/meta/0054_snapshot.json"));
    for (const [name, table] of Object.entries(historical.tables) as [string, { columns: Record<string, unknown> }][]) {
      const runtime = generated.tables[`public.${name}`];
      expect(runtime, name).toBeDefined();
      expect(Object.keys(runtime.columns).sort(), name).toEqual(Object.keys(table.columns).sort());
    }
  }, 30000);
});
