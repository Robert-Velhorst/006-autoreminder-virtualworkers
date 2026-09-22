-- Additive consolidation of reliability source 0032-0036 onto canonical main 0044.
-- Do not change historical migrations or __drizzle_migrations rows.
-- Run only with one migration process; MySQL DDL implicitly commits.
-- Preserve existing columns/rows. Missing mode columns default to shadow, not active.
-- Preflight existing definitions, duplicate keys and orphan references on a restored DB.
CREATE TABLE IF NOT EXISTS `aptlss_evidence_conflicts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`sourceEvidenceId` int NOT NULL,
	`assertedEvidenceId` int NOT NULL,
	`status` enum('needs_verification','consistent','resolved','dismissed') NOT NULL DEFAULT 'needs_verification',
	`resolution` text,
	`resolvedBy` varchar(128),
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aptlss_evidence_conflicts_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_evidence_conflict_pair_unique` UNIQUE(`sourceEvidenceId`,`assertedEvidenceId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_evidence_revisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`evidenceId` int NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`truthClass` enum('source_record','worker_assertion','system_inference') NOT NULL,
	`summary` text,
	`content` text,
	`metadataJson` text,
	`observedAt` timestamp NOT NULL,
	`recordedBy` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_evidence_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_evidence_revision_hash_unique` UNIQUE(`evidenceId`,`contentHash`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_evidence_subject_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`evidenceId` int NOT NULL,
	`vaId` int NOT NULL,
	`subjectType` enum('card','worker','decision','plan_block') NOT NULL,
	`subjectId` varchar(256) NOT NULL,
	`relevanceScore` int NOT NULL,
	`linkMethod` enum('automatic','manual','confirmed') NOT NULL DEFAULT 'automatic',
	`matchReason` varchar(512) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aptlss_evidence_subject_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_evidence_subject_unique` UNIQUE(`evidenceId`,`vaId`,`subjectType`,`subjectId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_verification_followups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`cardId` varchar(64),
	`conflictId` int,
	`title` varchar(512) NOT NULL,
	`question` text NOT NULL,
	`status` enum('open','resolved','superseded') NOT NULL DEFAULT 'open',
	`dueAt` timestamp,
	`resolution` text,
	`resolvedBy` varchar(128),
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aptlss_verification_followups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_evidence_conflicts' AND CONSTRAINT_NAME = 'aptlss_evidence_conflict_source_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'),
  'SELECT 1',
  'ALTER TABLE `aptlss_evidence_conflicts` ADD CONSTRAINT `aptlss_evidence_conflict_source_fk` FOREIGN KEY (`sourceEvidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_evidence_conflicts' AND CONSTRAINT_NAME = 'aptlss_evidence_conflict_asserted_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'),
  'SELECT 1',
  'ALTER TABLE `aptlss_evidence_conflicts` ADD CONSTRAINT `aptlss_evidence_conflict_asserted_fk` FOREIGN KEY (`assertedEvidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_evidence_revisions' AND CONSTRAINT_NAME = 'aptlss_evidence_revision_item_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'),
  'SELECT 1',
  'ALTER TABLE `aptlss_evidence_revisions` ADD CONSTRAINT `aptlss_evidence_revision_item_fk` FOREIGN KEY (`evidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_evidence_subject_links' AND CONSTRAINT_NAME = 'aptlss_evidence_subject_item_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'),
  'SELECT 1',
  'ALTER TABLE `aptlss_evidence_subject_links` ADD CONSTRAINT `aptlss_evidence_subject_item_fk` FOREIGN KEY (`evidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_verification_followups' AND CONSTRAINT_NAME = 'aptlss_verification_followup_conflict_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'),
  'SELECT 1',
  'ALTER TABLE `aptlss_verification_followups` ADD CONSTRAINT `aptlss_verification_followup_conflict_fk` FOREIGN KEY (`conflictId`) REFERENCES `aptlss_evidence_conflicts`(`id`) ON DELETE set null ON UPDATE cascade'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_evidence_conflicts' AND INDEX_NAME = 'aptlss_evidence_conflict_va_status_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_evidence_conflict_va_status_idx` ON `aptlss_evidence_conflicts` (`vaId`,`status`,`createdAt`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_evidence_revisions' AND INDEX_NAME = 'aptlss_evidence_revision_observed_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_evidence_revision_observed_idx` ON `aptlss_evidence_revisions` (`evidenceId`,`observedAt`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_evidence_subject_links' AND INDEX_NAME = 'aptlss_evidence_subject_lookup_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_evidence_subject_lookup_idx` ON `aptlss_evidence_subject_links` (`vaId`,`subjectType`,`subjectId`,`relevanceScore`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_verification_followups' AND INDEX_NAME = 'aptlss_verification_followup_va_status_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_verification_followup_va_status_idx` ON `aptlss_verification_followups` (`vaId`,`status`,`dueAt`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_verification_followups' AND INDEX_NAME = 'aptlss_verification_followup_card_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_verification_followup_card_idx` ON `aptlss_verification_followups` (`cardId`,`status`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`inputHash` varchar(64) NOT NULL,
	`trigger` varchar(32) NOT NULL,
	`snapshotJson` longtext NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_state` (
	`vaId` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`intervalMinutes` int NOT NULL DEFAULT 5,
	`checkedAt` timestamp,
	`inputHash` varchar(64),
	`sourceHash` varchar(64),
	`lastError` varchar(512),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aptlss_manager_state_vaId` PRIMARY KEY(`vaId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_updates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`cardId` varchar(64) NOT NULL,
	`detail` text NOT NULL,
	`interventionId` varchar(256),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_updates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_runs' AND INDEX_NAME = 'aptlss_manager_runs_worker_created_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_manager_runs_worker_created_idx` ON `aptlss_manager_runs` (`vaId`,`createdAt`,`id`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_updates' AND INDEX_NAME = 'aptlss_manager_updates_worker_card_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_manager_updates_worker_card_idx` ON `aptlss_manager_updates` (`vaId`,`cardId`,`createdAt`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_control` (
	`id` int NOT NULL,
	`activeVaId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aptlss_manager_control_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`runId` int NOT NULL,
	`proposalHash` varchar(64) NOT NULL,
	`verdict` enum('correct','incorrect','insufficient') NOT NULL,
	`critical` boolean NOT NULL DEFAULT false,
	`correction` text NOT NULL,
	`source` text NOT NULL,
	`reviewerId` int NOT NULL,
	`reviewedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_manager_review_run_unique` UNIQUE(`runId`)
);
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_runs' AND COLUMN_NAME = 'mode'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_runs` ADD `mode` enum(''shadow'',''active'') DEFAULT ''shadow'' NOT NULL'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_runs' AND COLUMN_NAME = 'proposalHash'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_runs` ADD `proposalHash` varchar(64)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_runs' AND COLUMN_NAME = 'previousPlanJson'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_runs` ADD `previousPlanJson` longtext'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_runs' AND COLUMN_NAME = 'appliedPlanHash'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_runs` ADD `appliedPlanHash` varchar(64)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_state' AND COLUMN_NAME = 'mode'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_state` ADD `mode` enum(''shadow'',''active'') DEFAULT ''shadow'' NOT NULL'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_state' AND COLUMN_NAME = 'policyRevision'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_state` ADD `policyRevision` int DEFAULT 0 NOT NULL'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_state' AND COLUMN_NAME = 'shadowStartedAt'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_state` ADD `shadowStartedAt` timestamp DEFAULT (now()) NOT NULL'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_state' AND COLUMN_NAME = 'lastSuccessfulAt'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_state` ADD `lastSuccessfulAt` timestamp'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_reviews' AND CONSTRAINT_NAME = 'manager_review_run_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_reviews` ADD CONSTRAINT `manager_review_run_fk` FOREIGN KEY (`runId`) REFERENCES `aptlss_manager_runs`(`id`) ON DELETE no action ON UPDATE no action'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_reviews' AND INDEX_NAME = 'aptlss_manager_review_worker_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_manager_review_worker_idx` ON `aptlss_manager_reviews` (`vaId`,`reviewedAt`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_corrections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`reviewId` int NOT NULL,
	`scope` enum('card','worker') NOT NULL DEFAULT 'card',
	`cardId` varchar(64),
	`topic` varchar(64) NOT NULL,
	`correction` text NOT NULL,
	`conditionsJson` text NOT NULL,
	`evidenceJson` longtext NOT NULL,
	`validFrom` timestamp NOT NULL,
	`validUntil` timestamp NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	`revokedBy` int,
	`revocationReason` text,
	CONSTRAINT `aptlss_manager_corrections_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_manager_correction_review_unique` UNIQUE(`reviewId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_trial_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`trialKey` varchar(64) NOT NULL,
	`event` enum('started','closed') NOT NULL,
	`afterRunId` int NOT NULL,
	`implementationDigest` varchar(64) NOT NULL,
	`actorId` int NOT NULL,
	`reason` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_trial_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_manager_trial_event_unique` UNIQUE(`vaId`,`trialKey`,`event`)
);
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_corrections' AND CONSTRAINT_NAME = 'manager_correction_review_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_corrections` ADD CONSTRAINT `manager_correction_review_fk` FOREIGN KEY (`reviewId`) REFERENCES `aptlss_manager_reviews`(`id`) ON DELETE no action ON UPDATE no action'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_corrections' AND INDEX_NAME = 'aptlss_manager_correction_scope_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_manager_correction_scope_idx` ON `aptlss_manager_corrections` (`vaId`,`scope`,`cardId`,`validUntil`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_trial_events' AND INDEX_NAME = 'aptlss_manager_trial_worker_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_manager_trial_worker_idx` ON `aptlss_manager_trial_events` (`vaId`,`id`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_reviews' AND INDEX_NAME = 'aptlss_manager_reviews_proposal_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_manager_reviews_proposal_idx` ON `aptlss_manager_reviews` (`vaId`,`proposalHash`,`runId`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_runs' AND INDEX_NAME = 'aptlss_manager_runs_proposal_idx'),
  'SELECT 1',
  'CREATE INDEX `aptlss_manager_runs_proposal_idx` ON `aptlss_manager_runs` (`vaId`,`proposalHash`,`createdAt`,`id`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_queue` (
	`vaId` int NOT NULL,
	`state` enum('idle','pending','leased','failed') NOT NULL DEFAULT 'idle',
	`generation` int NOT NULL DEFAULT 0,
	`claimedGeneration` int NOT NULL DEFAULT 0,
	`priority` int NOT NULL DEFAULT 0,
	`trigger` varchar(40) NOT NULL DEFAULT 'periodic',
	`availableAt` timestamp(3) NOT NULL DEFAULT (now()),
	`requestedAt` timestamp(3) NOT NULL DEFAULT (now()),
	`attempts` int NOT NULL DEFAULT 0,
	`leaseToken` varchar(64),
	`leaseUntil` timestamp(3),
	`lastError` varchar(255),
	`completedAt` timestamp(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_queue_vaId` PRIMARY KEY(`vaId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_queue_events` (
	`eventHash` varchar(64) NOT NULL,
	`vaId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_queue_events_eventHash` PRIMARY KEY(`eventHash`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `aptlss_manager_queue_slots` (
	`id` int NOT NULL,
	`vaId` int,
	`token` varchar(64),
	`leaseUntil` timestamp(3),
	CONSTRAINT `aptlss_manager_queue_slots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_queue' AND INDEX_NAME = 'manager_queue_ready_idx'),
  'SELECT 1',
  'CREATE INDEX `manager_queue_ready_idx` ON `aptlss_manager_queue` (`state`,`availableAt`,`priority`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_queue' AND INDEX_NAME = 'manager_queue_lease_idx'),
  'SELECT 1',
  'CREATE INDEX `manager_queue_lease_idx` ON `aptlss_manager_queue` (`state`,`leaseUntil`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
SET @aptlss_pilot_ddl = IF(
  EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aptlss_manager_queue_events' AND INDEX_NAME = 'manager_queue_event_worker_idx'),
  'SELECT 1',
  'CREATE INDEX `manager_queue_event_worker_idx` ON `aptlss_manager_queue_events` (`vaId`,`createdAt`)'
);
--> statement-breakpoint
PREPARE aptlss_pilot_stmt FROM @aptlss_pilot_ddl;
--> statement-breakpoint
EXECUTE aptlss_pilot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE aptlss_pilot_stmt;
--> statement-breakpoint
INSERT INTO `aptlss_manager_queue_slots` (`id`)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM `aptlss_manager_queue_slots` WHERE `id` = 1);
--> statement-breakpoint
INSERT INTO `aptlss_manager_queue_slots` (`id`)
SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM `aptlss_manager_queue_slots` WHERE `id` = 2);
--> statement-breakpoint
INSERT INTO `aptlss_manager_queue_slots` (`id`)
SELECT 3 WHERE NOT EXISTS (SELECT 1 FROM `aptlss_manager_queue_slots` WHERE `id` = 3);
--> statement-breakpoint
INSERT INTO `aptlss_manager_queue_slots` (`id`)
SELECT 4 WHERE NOT EXISTS (SELECT 1 FROM `aptlss_manager_queue_slots` WHERE `id` = 4);
