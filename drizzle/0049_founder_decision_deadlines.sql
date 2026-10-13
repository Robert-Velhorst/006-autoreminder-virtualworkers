-- Append-only founder deadline revisions; existing APTLSS steps remain unchanged.
CREATE TABLE IF NOT EXISTS `founder_decision_deadlines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`stepId` int NOT NULL,
	`dueAt` timestamp,
	`source` varchar(1024) NOT NULL,
	`recordedBy` varchar(64) NOT NULL,
	`recordedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `founder_decision_deadlines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
SET @founder_deadline_ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='founder_decision_deadlines' AND INDEX_NAME='founder_decision_deadlines_step_idx'), 'SELECT 1', 'CREATE INDEX `founder_decision_deadlines_step_idx` ON `founder_decision_deadlines` (`stepId`,`id`)');
--> statement-breakpoint
PREPARE founder_deadline_stmt FROM @founder_deadline_ddl;
--> statement-breakpoint
EXECUTE founder_deadline_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE founder_deadline_stmt;
