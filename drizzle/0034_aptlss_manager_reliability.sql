CREATE TABLE `aptlss_manager_control` (
	`id` int NOT NULL,
	`activeVaId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aptlss_manager_control_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `aptlss_manager_reviews` (
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
ALTER TABLE `aptlss_manager_runs` ADD `mode` enum('shadow','active') DEFAULT 'shadow' NOT NULL;--> statement-breakpoint
ALTER TABLE `aptlss_manager_runs` ADD `proposalHash` varchar(64);--> statement-breakpoint
ALTER TABLE `aptlss_manager_runs` ADD `previousPlanJson` longtext;--> statement-breakpoint
ALTER TABLE `aptlss_manager_runs` ADD `appliedPlanHash` varchar(64);--> statement-breakpoint
ALTER TABLE `aptlss_manager_state` ADD `mode` enum('shadow','active') DEFAULT 'shadow' NOT NULL;--> statement-breakpoint
ALTER TABLE `aptlss_manager_state` ADD `policyRevision` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `aptlss_manager_state` ADD `shadowStartedAt` timestamp DEFAULT (now()) NOT NULL;--> statement-breakpoint
ALTER TABLE `aptlss_manager_state` ADD `lastSuccessfulAt` timestamp;--> statement-breakpoint
ALTER TABLE `aptlss_manager_reviews` ADD CONSTRAINT `manager_review_run_fk` FOREIGN KEY (`runId`) REFERENCES `aptlss_manager_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `aptlss_manager_review_worker_idx` ON `aptlss_manager_reviews` (`vaId`,`reviewedAt`);