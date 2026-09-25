SET @report_kind_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='reportKind'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `reportKind` varchar(24) NOT NULL DEFAULT ''update'', ALGORITHM=INPLACE, LOCK=NONE'
);
--> statement-breakpoint
PREPARE report_kind_stmt FROM @report_kind_ddl;
--> statement-breakpoint
EXECUTE report_kind_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE report_kind_stmt;
--> statement-breakpoint
SET @action_id_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='actionId'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `actionId` varchar(256) NULL, ALGORITHM=INPLACE, LOCK=NONE'
);
--> statement-breakpoint
PREPARE action_id_stmt FROM @action_id_ddl;
--> statement-breakpoint
EXECUTE action_id_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE action_id_stmt;
--> statement-breakpoint
SET @assessment_run_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='assessmentRunId'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `assessmentRunId` int NULL, ALGORITHM=INPLACE, LOCK=NONE'
);
--> statement-breakpoint
PREPARE assessment_run_stmt FROM @assessment_run_ddl;
--> statement-breakpoint
EXECUTE assessment_run_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE assessment_run_stmt;
--> statement-breakpoint
SET @request_key_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND COLUMN_NAME='requestKey'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_updates` ADD COLUMN `requestKey` varchar(36) NULL, ALGORITHM=INPLACE, LOCK=NONE'
);
--> statement-breakpoint
PREPARE request_key_stmt FROM @request_key_ddl;
--> statement-breakpoint
EXECUTE request_key_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE request_key_stmt;
--> statement-breakpoint
SET @request_index_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_updates' AND INDEX_NAME='aptlss_manager_updates_request_unique'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_updates` ADD UNIQUE INDEX `aptlss_manager_updates_request_unique` (`vaId`, `requestKey`), ALGORITHM=INPLACE, LOCK=NONE'
);
--> statement-breakpoint
PREPARE request_index_stmt FROM @request_index_ddl;
--> statement-breakpoint
EXECUTE request_index_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE request_index_stmt;
