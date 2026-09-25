-- Keep the original worker narrative; add independently queryable, optional fields.
SET @update_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='outcome'), 'SELECT 1', 'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `outcome` varchar(32) NULL, ALGORITHM=INPLACE, LOCK=NONE');
--> statement-breakpoint
PREPARE update_stmt FROM @update_ddl;
--> statement-breakpoint
EXECUTE update_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE update_stmt;
--> statement-breakpoint
SET @update_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='deadlineDate'), 'SELECT 1', 'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `deadlineDate` varchar(10) NULL, ALGORITHM=INPLACE, LOCK=NONE');
--> statement-breakpoint
PREPARE update_stmt FROM @update_ddl;
--> statement-breakpoint
EXECUTE update_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE update_stmt;
--> statement-breakpoint
SET @update_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='sourceEvidenceId'), 'SELECT 1', 'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `sourceEvidenceId` varchar(256) NULL, ALGORITHM=INPLACE, LOCK=NONE');
--> statement-breakpoint
PREPARE update_stmt FROM @update_ddl;
--> statement-breakpoint
EXECUTE update_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE update_stmt;
--> statement-breakpoint
SET @update_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='sourceDescription'), 'SELECT 1', 'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `sourceDescription` varchar(512) NULL, ALGORITHM=INPLACE, LOCK=NONE');
--> statement-breakpoint
PREPARE update_stmt FROM @update_ddl;
--> statement-breakpoint
EXECUTE update_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE update_stmt;
