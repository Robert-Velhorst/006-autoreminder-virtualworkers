-- Derived, read-only review metadata; the source snapshots remain unchanged.
SET @review_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_runs' AND COLUMN_NAME='reviewDigest'), 'SELECT 1', 'ALTER TABLE `aptlss_manager_runs` ADD COLUMN `reviewDigest` varchar(64) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(snapshotJson, ''$.implementationDigest''))) VIRTUAL');
--> statement-breakpoint
PREPARE review_stmt FROM @review_ddl;
--> statement-breakpoint
EXECUTE review_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE review_stmt;
--> statement-breakpoint
SET @review_ddl = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_runs' AND COLUMN_NAME='reviewUrgent'), 'SELECT 1', 'ALTER TABLE `aptlss_manager_runs` ADD COLUMN `reviewUrgent` boolean GENERATED ALWAYS AS (COALESCE(JSON_CONTAINS(JSON_EXTRACT(snapshotJson, ''$.interventions[*].severity''), ''"urgent"''), 0)) VIRTUAL');
--> statement-breakpoint
PREPARE review_stmt FROM @review_ddl;
--> statement-breakpoint
EXECUTE review_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE review_stmt;
--> statement-breakpoint
SET @review_ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_runs' AND INDEX_NAME='aptlss_manager_runs_review_idx'), 'SELECT 1', 'ALTER TABLE `aptlss_manager_runs` ADD INDEX `aptlss_manager_runs_review_idx` (`vaId`, `reviewDigest`, `proposalHash`, `mode`, `createdAt`, `id`, `reviewUrgent`), ALGORITHM=INPLACE, LOCK=NONE');
--> statement-breakpoint
PREPARE review_stmt FROM @review_ddl;
--> statement-breakpoint
EXECUTE review_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE review_stmt;
