CREATE TABLE `aptlss_manager_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`inputHash` varchar(64) NOT NULL,
	`trigger` varchar(32) NOT NULL,
	`snapshotJson` longtext NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `aptlss_manager_state` (
	`vaId` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`intervalMinutes` int NOT NULL DEFAULT 5,
	`checkedAt` timestamp,
	`inputHash` varchar(64),
	`sourceHash` varchar(64),
	`lastError` varchar(512),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `aptlss_manager_state_vaId` PRIMARY KEY(`vaId`)
);
--> statement-breakpoint
CREATE TABLE `aptlss_manager_updates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vaId` int NOT NULL,
	`cardId` varchar(64) NOT NULL,
	`detail` text NOT NULL,
	`interventionId` varchar(256),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_updates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `aptlss_manager_runs_worker_created_idx` ON `aptlss_manager_runs` (`vaId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `aptlss_manager_updates_worker_card_idx` ON `aptlss_manager_updates` (`vaId`,`cardId`,`createdAt`);