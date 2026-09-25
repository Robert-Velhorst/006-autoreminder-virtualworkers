-- Record an explicit final decision type while preserving every legacy outcome.
SET @founder_decision_disposition_ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='decision_outcomes' AND COLUMN_NAME='disposition'
  ),
  'SELECT 1',
  'ALTER TABLE `decision_outcomes` ADD COLUMN `disposition` ENUM(''recorded'',''approved'',''rejected'') NOT NULL DEFAULT ''recorded'''
);
--> statement-breakpoint
PREPARE founder_decision_disposition_stmt FROM @founder_decision_disposition_ddl;
--> statement-breakpoint
EXECUTE founder_decision_disposition_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE founder_decision_disposition_stmt;
