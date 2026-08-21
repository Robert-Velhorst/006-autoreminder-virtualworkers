CREATE TABLE `aptlss_evidence_conflicts` (
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
CREATE TABLE `aptlss_evidence_revisions` (
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
CREATE TABLE `aptlss_evidence_subject_links` (
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
CREATE TABLE `aptlss_verification_followups` (
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
ALTER TABLE `aptlss_evidence_conflicts` ADD CONSTRAINT `aptlss_evidence_conflict_source_fk` FOREIGN KEY (`sourceEvidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE `aptlss_evidence_conflicts` ADD CONSTRAINT `aptlss_evidence_conflict_asserted_fk` FOREIGN KEY (`assertedEvidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE `aptlss_evidence_revisions` ADD CONSTRAINT `aptlss_evidence_revision_item_fk` FOREIGN KEY (`evidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE `aptlss_evidence_subject_links` ADD CONSTRAINT `aptlss_evidence_subject_item_fk` FOREIGN KEY (`evidenceId`) REFERENCES `workspace_evidence_items`(`id`) ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE `aptlss_verification_followups` ADD CONSTRAINT `aptlss_verification_followup_conflict_fk` FOREIGN KEY (`conflictId`) REFERENCES `aptlss_evidence_conflicts`(`id`) ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX `aptlss_evidence_conflict_va_status_idx` ON `aptlss_evidence_conflicts` (`vaId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `aptlss_evidence_revision_observed_idx` ON `aptlss_evidence_revisions` (`evidenceId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `aptlss_evidence_subject_lookup_idx` ON `aptlss_evidence_subject_links` (`vaId`,`subjectType`,`subjectId`,`relevanceScore`);--> statement-breakpoint
CREATE INDEX `aptlss_verification_followup_va_status_idx` ON `aptlss_verification_followups` (`vaId`,`status`,`dueAt`);--> statement-breakpoint
CREATE INDEX `aptlss_verification_followup_card_idx` ON `aptlss_verification_followups` (`cardId`,`status`);