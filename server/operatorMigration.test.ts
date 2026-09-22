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
  const workerInvitationMigration = readFileSync(
    new URL("../drizzle/0032_worker_invitations.sql", import.meta.url),
    "utf8",
  );
  const reminderMigration = readFileSync(
    new URL("../drizzle/0033_durable_reminder_orchestration.sql", import.meta.url),
    "utf8",
  );
  const haiMigration = readFileSync(
    new URL("../drizzle/0034_hai_worker_control_connector.sql", import.meta.url),
    "utf8",
  );
  const workerEvidenceIsolationMigration = readFileSync(
    new URL("../drizzle/0035_worker_evidence_isolation.sql", import.meta.url),
    "utf8",
  );
  const atisChecklistMigration = readFileSync(
    new URL("../drizzle/0036_formalize_atis_checklist.sql", import.meta.url),
    "utf8",
  );
  const maintenanceMigration = readFileSync(
    new URL("../drizzle/0037_maintenance_job_settings.sql", import.meta.url),
    "utf8",
  );
  const replyLifecycleMigration = readFileSync(
    new URL("../drizzle/0038_reply_thread_lifecycle.sql", import.meta.url),
    "utf8",
  );
  const legacyCommentTokenCleanupMigration = readFileSync(
    new URL("../drizzle/0039_remove_legacy_trello_comment_tokens.sql", import.meta.url),
    "utf8",
  );
  const taskCacheCapacityMigration = readFileSync(
    new URL("../drizzle/0040_expand_trello_task_cache.sql", import.meta.url),
    "utf8",
  );
  const browserCollectorTokenMigration = readFileSync(
    new URL("../drizzle/0041_hash_browser_tab_collector_tokens.sql", import.meta.url),
    "utf8",
  );
  const legacyBrowserCollectorTokenMigration = readFileSync(
    new URL("../drizzle/0042_hash_legacy_browser_tab_collector_token.sql", import.meta.url),
    "utf8",
  );
  const workerCockpitIndexMigration = readFileSync(
    new URL("../drizzle/0043_worker_cockpit_query_indexes.sql", import.meta.url),
    "utf8",
  );
  const scheduleHistoryTenantScopeMigration = readFileSync(
    new URL("../drizzle/0044_schedule_history_tenant_scope.sql", import.meta.url),
    "utf8",
  );
  const journal = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("is appended after the developer migration lineage", () => {
    // Keep validating the canonical segment when later additive migrations exist.
    const entries = journal.entries.slice(28, 45);
    expect(entries.map((entry) => entry.tag)).toEqual([
      "0028_add_task_assignment_schedule",
      "0029_operator_evidence_foundation",
      "0030_restore_schema_parity",
      "0031_worker_operator_scope",
      "0032_worker_invitations",
      "0033_durable_reminder_orchestration",
      "0034_hai_worker_control_connector",
      "0035_worker_evidence_isolation",
      "0036_formalize_atis_checklist",
      "0037_maintenance_job_settings",
      "0038_reply_thread_lifecycle",
      "0039_remove_legacy_trello_comment_tokens",
      "0040_expand_trello_task_cache",
      "0041_hash_browser_tab_collector_tokens",
      "0042_hash_legacy_browser_tab_collector_token",
      "0043_worker_cockpit_query_indexes",
      "0044_schedule_history_tenant_scope",
    ]);
    expect(entries.map((entry) => entry.idx)).toEqual([28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44]);
  });

  it("does not drop or rename developer data", () => {
    for (const sql of [
      migration,
      parityMigration,
      workerScopeMigration,
      workerInvitationMigration,
      reminderMigration,
      haiMigration,
      workerEvidenceIsolationMigration,
      atisChecklistMigration,
      maintenanceMigration,
      replyLifecycleMigration,
      scheduleHistoryTenantScopeMigration,
    ]) {
      expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
      expect(sql).not.toMatch(/\bRENAME\s+TABLE\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    }
  });

  it("preserves reply history when assigned cards leave the active queue", () => {
    expect(replyLifecycleMigration).toContain("'inactive'");
    expect(replyLifecycleMigration).not.toMatch(/DELETE\s+FROM/i);
  });

  it("removes only the legacy Trello comment token values that no write path consumes", () => {
    expect(legacyCommentTokenCleanupMigration).toMatch(
      /DELETE FROM `app_settings` WHERE `key` = 'trello_comment_token'/,
    );
  });

  it("expands the task cache without dropping historic cached schedules", () => {
    expect(taskCacheCapacityMigration).toMatch(
      /ALTER TABLE\s+`trello_cached_tasks`\s+MODIFY COLUMN\s+`taskData`\s+MEDIUMTEXT\s+NOT NULL/i,
    );
    expect(taskCacheCapacityMigration).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });

  it("replaces historic browser collector tokens with irreversible hashes", () => {
    expect(browserCollectorTokenMigration).toContain("SHA2(`value`, 256)");
    expect(browserCollectorTokenMigration).toContain("browserTabCollectorToken:%");
    expect(browserCollectorTokenMigration).not.toMatch(/DELETE\s+FROM|DROP\s+/i);
    expect(legacyBrowserCollectorTokenMigration).toContain("`key` = 'browserTabCollectorToken'");
    expect(legacyBrowserCollectorTokenMigration).toContain("SHA2(`value`, 256)");
  });

  it("adds worker cockpit query indexes without altering retained records", () => {
    expect(workerCockpitIndexMigration).toContain("va_time_entries_period_idx");
    expect(workerCockpitIndexMigration).toContain("email_tasks_va_status_received_idx");
    expect(workerCockpitIndexMigration).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });

  it("formalizes the ATIS checklist table instead of relying on request-time schema changes", () => {
    expect(atisChecklistMigration).toContain("CREATE TABLE IF NOT EXISTS `atis_checklist_completion`");
    expect(atisChecklistMigration).toContain("card_step_user_unique");
    expect(atisChecklistMigration).toContain("atis_checklist_user_completed_idx");
  });

  it("persists modular maintenance intervals without provider actions", () => {
    expect(maintenanceMigration).toContain("CREATE TABLE `maintenance_job_settings`");
    expect(maintenanceMigration).toContain("`intervalMinutes`");
    expect(maintenanceMigration).not.toMatch(/INSERT\s+INTO/i);
  });

  it("scopes legacy evidence by worker user identity without discarding ambiguous rows", () => {
    for (const table of [
      "workspace_evidence_items",
      "communication_evidence",
      "compliance_card_evidence",
      "compliance_communication_evidence",
      "compliance_clarification_requests",
    ]) {
      expect(workerEvidenceIsolationMigration).toContain(`ALTER TABLE \`${table}\` ADD \`vaId\``);
    }
    expect(workerEvidenceIsolationMigration).toContain("SELECT MIN(`userId`) FROM `va_profiles`");
    expect(workerEvidenceIsolationMigration).not.toMatch(/DELETE\s+FROM/i);
    expect(workerEvidenceIsolationMigration).toContain("workspace_evidence_va_source_id_unique");
    expect(workerEvidenceIsolationMigration).toContain("communication_evidence_va_channel_external_unique");
    expect(workerEvidenceIsolationMigration).toContain("assignedToWorker");
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
});
