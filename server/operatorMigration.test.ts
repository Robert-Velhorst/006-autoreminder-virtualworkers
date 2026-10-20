import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("operator migration contract", () => {
  const migration = readFileSync(
    new URL("../drizzle/0029_operator_evidence_foundation.sql", import.meta.url),
    "utf8",
  );
  const parityMigration = readFileSync(
    new URL("../drizzle/0030_restore_schema_parity.sql", import.meta.url),
    "utf8",
  );
  const workerScopeMigration = readFileSync(
    new URL("../drizzle/0031_worker_operator_scope.sql", import.meta.url),
    "utf8",
  );
  const evidenceGraphMigration = readFileSync(
    new URL("../drizzle/0032_aptlss_evidence_graph.sql", import.meta.url),
    "utf8",
  );
  const managerMigration = readFileSync(
    new URL("../drizzle/0033_aptlss_project_manager.sql", import.meta.url),
    "utf8",
  );
  const journal = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("is appended after the developer migration lineage", () => {
    const entries = journal.entries.slice(28);
    expect(entries.map((entry) => entry.tag)).toEqual([
      "0028_add_task_assignment_schedule",
      "0029_operator_evidence_foundation",
      "0030_restore_schema_parity",
      "0031_worker_operator_scope",
      "0032_aptlss_evidence_graph",
      "0033_aptlss_project_manager",
      "0034_aptlss_manager_reliability",
      "0035_aptlss_review_learning",
      "0036_aptlss_manager_queue",
    ]);
    expect(entries.map((entry) => entry.idx)).toEqual([28, 29, 30, 31, 32, 33, 34, 35, 36]);
  });

  it("does not drop or rename developer data", () => {
    const additions = ["0034_aptlss_manager_reliability", "0035_aptlss_review_learning", "0036_aptlss_manager_queue"]
      .map(tag => readFileSync(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8"));
    for (const sql of [migration, parityMigration, workerScopeMigration, evidenceGraphMigration, managerMigration, ...additions]) {
      expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
      expect(sql).not.toMatch(/\bRENAME\s+TABLE\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    }
  });

  it("backfills operator records before enforcing worker scope", () => {
    for (const table of [
      "aptlss_waiting_reasons",
      "decision_outcomes",
      "browser_tab_states",
      "browser_tab_daily_evidence",
    ]) {
      expect(workerScopeMigration).toContain(`ALTER TABLE \`${table}\``);
      expect(workerScopeMigration).toMatch(new RegExp(`UPDATE \\\`${table}\\\`|UPDATE \\\`${table}\\\` AS`));
    }
    expect(workerScopeMigration).toContain("browser_tab_daily_va_date_idx");
    expect(workerScopeMigration).toContain("browserTabCollectorToken");
  });

  it("creates the required operator evidence domains", () => {
    for (const table of [
      "aptlss_assessments",
      "aptlss_waiting_reasons",
      "decision_outcomes",
      "workspace_evidence_items",
      "communication_evidence",
      "compliance_card_evidence",
      "time_reconciliation_items",
      "scheduled_job_runs",
      "browser_tab_daily_evidence",
    ]) {
      expect(migration).toContain(`CREATE TABLE \`${table}\``);
    }
  });

  it("adds durable manager state, worker updates, and append-only run snapshots", () => {
    for (const table of ["aptlss_manager_state", "aptlss_manager_updates", "aptlss_manager_runs"]) {
      expect(managerMigration).toContain(`CREATE TABLE \`${table}\``);
    }
  });

  it("adds an append-only evidence graph without replacing source evidence", () => {
    for (const table of [
      "aptlss_evidence_revisions",
      "aptlss_evidence_subject_links",
      "aptlss_evidence_conflicts",
      "aptlss_verification_followups",
    ]) {
      expect(evidenceGraphMigration).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(evidenceGraphMigration).toContain("workspace_evidence_items");
    expect(evidenceGraphMigration).toContain("ON DELETE cascade");
  });
});
