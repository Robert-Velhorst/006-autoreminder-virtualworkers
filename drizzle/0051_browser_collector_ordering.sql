SET @browser_capture_sequence_ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='browser_tab_states' AND COLUMN_NAME='captureSequence'
  ),
  'SELECT 1',
  'ALTER TABLE `browser_tab_states` ADD COLUMN `captureSequence` int unsigned NOT NULL DEFAULT 0'
);
--> statement-breakpoint
PREPARE browser_capture_sequence_stmt FROM @browser_capture_sequence_ddl;
--> statement-breakpoint
EXECUTE browser_capture_sequence_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE browser_capture_sequence_stmt;
--> statement-breakpoint
SET @browser_source_capture_ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='browser_tab_states' AND COLUMN_NAME='sourceCapturedAt'
  ),
  'SELECT 1',
  'ALTER TABLE `browser_tab_states` ADD COLUMN `sourceCapturedAt` timestamp NULL'
);
--> statement-breakpoint
PREPARE browser_source_capture_stmt FROM @browser_source_capture_ddl;
--> statement-breakpoint
EXECUTE browser_source_capture_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE browser_source_capture_stmt;
