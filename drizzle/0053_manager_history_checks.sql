CREATE TABLE IF NOT EXISTS `aptlss_manager_checks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `vaId` int NOT NULL,
  `runId` int NOT NULL,
  `inputHash` varchar(64) NOT NULL,
  `sourceHash` varchar(64) NOT NULL,
  `baseSnapshotHash` varchar(64) NOT NULL,
  `snapshotHash` varchar(64) NOT NULL,
  `snapshotPatchJson` longtext NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `aptlss_manager_checks_id` PRIMARY KEY (`id`),
  CONSTRAINT `manager_check_run_fk` FOREIGN KEY (`runId`) REFERENCES `aptlss_manager_runs` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  INDEX `aptlss_manager_checks_worker_idx` (`vaId`, `id`),
  INDEX `aptlss_manager_checks_run_idx` (`runId`, `id`)
);
--> statement-breakpoint
SET @manager_current_check_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_state' AND COLUMN_NAME='currentCheckId'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_state` ADD COLUMN `currentCheckId` int NULL, ALGORITHM=INPLACE, LOCK=NONE'
);
--> statement-breakpoint
PREPARE manager_current_check_stmt FROM @manager_current_check_ddl;
--> statement-breakpoint
EXECUTE manager_current_check_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE manager_current_check_stmt;
--> statement-breakpoint
SET @manager_history_scope_ddl = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='aptlss_manager_state' AND COLUMN_NAME='historyScopeHash'),
  'SELECT 1',
  'ALTER TABLE `aptlss_manager_state` ADD COLUMN `historyScopeHash` varchar(64) NULL, ALGORITHM=INPLACE, LOCK=NONE'
);
--> statement-breakpoint
PREPARE manager_history_scope_stmt FROM @manager_history_scope_ddl;
--> statement-breakpoint
EXECUTE manager_history_scope_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE manager_history_scope_stmt;
