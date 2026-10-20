CREATE TABLE `aptlss_manager_corrections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`reviewId` int NOT NULL,
	`scope` enum('card','worker') NOT NULL DEFAULT 'card',
	`cardId` varchar(64),
	`topic` varchar(64) NOT NULL,
	`correction` text NOT NULL,
	`conditionsJson` text NOT NULL,
	`evidenceJson` longtext NOT NULL,
	`validFrom` timestamp NOT NULL,
	`validUntil` timestamp NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	`revokedBy` int,
	`revocationReason` text,
	CONSTRAINT `aptlss_manager_corrections_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_manager_correction_review_unique` UNIQUE(`reviewId`)
);
--> statement-breakpoint
CREATE TABLE `aptlss_manager_trial_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`trialKey` varchar(64) NOT NULL,
	`event` enum('started','closed') NOT NULL,
	`afterRunId` int NOT NULL,
	`implementationDigest` varchar(64) NOT NULL,
	`actorId` int NOT NULL,
	`reason` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_trial_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `aptlss_manager_trial_event_unique` UNIQUE(`vaId`,`trialKey`,`event`)
);
--> statement-breakpoint
ALTER TABLE `aptlss_manager_corrections` ADD CONSTRAINT `manager_correction_review_fk` FOREIGN KEY (`reviewId`) REFERENCES `aptlss_manager_reviews`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `aptlss_manager_correction_scope_idx` ON `aptlss_manager_corrections` (`vaId`,`scope`,`cardId`,`validUntil`);--> statement-breakpoint
CREATE INDEX `aptlss_manager_trial_worker_idx` ON `aptlss_manager_trial_events` (`vaId`,`id`);--> statement-breakpoint
CREATE INDEX `aptlss_manager_reviews_proposal_idx` ON `aptlss_manager_reviews` (`vaId`,`proposalHash`,`runId`);--> statement-breakpoint
CREATE INDEX `aptlss_manager_runs_proposal_idx` ON `aptlss_manager_runs` (`vaId`,`proposalHash`,`createdAt`,`id`);