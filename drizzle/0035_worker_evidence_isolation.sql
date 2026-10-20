ALTER TABLE `workspace_evidence_items` ADD `vaId` int NULL;
--> statement-breakpoint
UPDATE `workspace_evidence_items`
SET `vaId` = CAST(SUBSTRING(`sourceContainerId`, 8) AS UNSIGNED)
WHERE `sourceContainerId` REGEXP '^worker:[0-9]+$';
--> statement-breakpoint
UPDATE `workspace_evidence_items`
SET `vaId` = (SELECT MIN(`userId`) FROM `va_profiles`)
WHERE `vaId` IS NULL AND (SELECT COUNT(*) FROM `va_profiles`) = 1;
--> statement-breakpoint
ALTER TABLE `workspace_evidence_items` DROP INDEX `workspace_evidence_source_id_unique`;
--> statement-breakpoint
ALTER TABLE `workspace_evidence_items` DROP INDEX `workspace_evidence_source_modified_idx`;
--> statement-breakpoint
ALTER TABLE `workspace_evidence_items` DROP INDEX `workspace_evidence_active_observed_idx`;
--> statement-breakpoint
ALTER TABLE `workspace_evidence_items` DROP INDEX `workspace_evidence_review_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_evidence_va_source_id_unique` ON `workspace_evidence_items` (`vaId`,`source`,`sourceId`);
--> statement-breakpoint
CREATE INDEX `workspace_evidence_va_source_modified_idx` ON `workspace_evidence_items` (`vaId`,`source`,`modifiedAt`);
--> statement-breakpoint
CREATE INDEX `workspace_evidence_va_active_observed_idx` ON `workspace_evidence_items` (`vaId`,`active`,`observedAt`);
--> statement-breakpoint
CREATE INDEX `workspace_evidence_va_review_idx` ON `workspace_evidence_items` (`vaId`,`reviewStatus`,`modifiedAt`);
--> statement-breakpoint

ALTER TABLE `communication_evidence` ADD `vaId` int NULL;
--> statement-breakpoint
UPDATE `communication_evidence`
SET `vaId` = (SELECT MIN(`userId`) FROM `va_profiles`)
WHERE `vaId` IS NULL AND (SELECT COUNT(*) FROM `va_profiles`) = 1;
--> statement-breakpoint
ALTER TABLE `communication_evidence` DROP INDEX `communication_evidence_channel_external_unique`;
--> statement-breakpoint
ALTER TABLE `communication_evidence` DROP INDEX `communication_evidence_card_occurred_idx`;
--> statement-breakpoint
ALTER TABLE `communication_evidence` DROP INDEX `communication_evidence_response_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `communication_evidence_va_channel_external_unique` ON `communication_evidence` (`vaId`,`channel`,`externalId`);
--> statement-breakpoint
CREATE INDEX `communication_evidence_va_card_occurred_idx` ON `communication_evidence` (`vaId`,`linkedCardId`,`occurredAt`);
--> statement-breakpoint
CREATE INDEX `communication_evidence_va_response_idx` ON `communication_evidence` (`vaId`,`responseRequired`,`respondedAt`);
--> statement-breakpoint

ALTER TABLE `compliance_card_evidence` ADD `vaId` int NULL;
--> statement-breakpoint
ALTER TABLE `compliance_card_evidence` ADD `assignedToWorker` boolean NOT NULL DEFAULT true;
--> statement-breakpoint
UPDATE `compliance_card_evidence`
SET `vaId` = (SELECT MIN(`userId`) FROM `va_profiles`), `assignedToWorker` = `assignedToJoyce`
WHERE (SELECT COUNT(*) FROM `va_profiles`) = 1;
--> statement-breakpoint
ALTER TABLE `compliance_card_evidence` DROP INDEX `compliance_evidence_date_card_unique`;
--> statement-breakpoint
ALTER TABLE `compliance_card_evidence` DROP INDEX `compliance_evidence_card_date_idx`;
--> statement-breakpoint
ALTER TABLE `compliance_card_evidence` DROP INDEX `compliance_evidence_date_compliant_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_evidence_va_date_card_unique` ON `compliance_card_evidence` (`vaId`,`snapshotDate`,`cardId`);
--> statement-breakpoint
CREATE INDEX `compliance_evidence_va_card_date_idx` ON `compliance_card_evidence` (`vaId`,`cardId`,`snapshotDate`);
--> statement-breakpoint
CREATE INDEX `compliance_evidence_va_date_compliant_idx` ON `compliance_card_evidence` (`vaId`,`snapshotDate`,`compliant`);
--> statement-breakpoint

ALTER TABLE `compliance_communication_evidence` ADD `vaId` int NULL;
--> statement-breakpoint
UPDATE `compliance_communication_evidence`
SET `vaId` = (SELECT MIN(`userId`) FROM `va_profiles`)
WHERE `vaId` IS NULL AND (SELECT COUNT(*) FROM `va_profiles`) = 1;
--> statement-breakpoint
ALTER TABLE `compliance_communication_evidence` DROP INDEX `compliance_comm_date_key_unique`;
--> statement-breakpoint
ALTER TABLE `compliance_communication_evidence` DROP INDEX `compliance_comm_date_kind_outcome_idx`;
--> statement-breakpoint
ALTER TABLE `compliance_communication_evidence` DROP INDEX `compliance_comm_external_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_comm_va_date_key_unique` ON `compliance_communication_evidence` (`vaId`,`snapshotDate`,`evidenceKey`);
--> statement-breakpoint
CREATE INDEX `compliance_comm_va_date_kind_outcome_idx` ON `compliance_communication_evidence` (`vaId`,`snapshotDate`,`kind`,`outcome`);
--> statement-breakpoint
CREATE INDEX `compliance_comm_va_external_idx` ON `compliance_communication_evidence` (`vaId`,`channel`,`externalId`);
--> statement-breakpoint

ALTER TABLE `compliance_clarification_requests` ADD `vaId` int NULL;
--> statement-breakpoint
UPDATE `compliance_clarification_requests`
SET `vaId` = (SELECT MIN(`userId`) FROM `va_profiles`)
WHERE `vaId` IS NULL AND (SELECT COUNT(*) FROM `va_profiles`) = 1;
--> statement-breakpoint
ALTER TABLE `compliance_clarification_requests` DROP INDEX `compliance_clarification_date_key_unique`;
--> statement-breakpoint
ALTER TABLE `compliance_clarification_requests` DROP INDEX `compliance_clarification_status_requested_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_clarification_va_date_key_unique` ON `compliance_clarification_requests` (`vaId`,`snapshotDate`,`evidenceKey`);
--> statement-breakpoint
CREATE INDEX `compliance_clarification_va_status_requested_idx` ON `compliance_clarification_requests` (`vaId`,`status`,`requestedAt`);
