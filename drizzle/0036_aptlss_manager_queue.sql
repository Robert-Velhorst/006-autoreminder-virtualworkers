CREATE TABLE `aptlss_manager_queue` (
	`vaId` int NOT NULL,
	`state` enum('idle','pending','leased','failed') NOT NULL DEFAULT 'idle',
	`generation` int NOT NULL DEFAULT 0,
	`claimedGeneration` int NOT NULL DEFAULT 0,
	`priority` int NOT NULL DEFAULT 0,
	`trigger` varchar(40) NOT NULL DEFAULT 'periodic',
	`availableAt` timestamp(3) NOT NULL DEFAULT (now()),
	`requestedAt` timestamp(3) NOT NULL DEFAULT (now()),
	`attempts` int NOT NULL DEFAULT 0,
	`leaseToken` varchar(64),
	`leaseUntil` timestamp(3),
	`lastError` varchar(255),
	`completedAt` timestamp(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_queue_vaId` PRIMARY KEY(`vaId`)
);
--> statement-breakpoint
CREATE TABLE `aptlss_manager_queue_events` (
	`eventHash` varchar(64) NOT NULL,
	`vaId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `aptlss_manager_queue_events_eventHash` PRIMARY KEY(`eventHash`)
);
--> statement-breakpoint
CREATE TABLE `aptlss_manager_queue_slots` (
	`id` int NOT NULL,
	`vaId` int,
	`token` varchar(64),
	`leaseUntil` timestamp(3),
	CONSTRAINT `aptlss_manager_queue_slots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `manager_queue_ready_idx` ON `aptlss_manager_queue` (`state`,`availableAt`,`priority`);--> statement-breakpoint
CREATE INDEX `manager_queue_lease_idx` ON `aptlss_manager_queue` (`state`,`leaseUntil`);--> statement-breakpoint
CREATE INDEX `manager_queue_event_worker_idx` ON `aptlss_manager_queue_events` (`vaId`,`createdAt`);
--> statement-breakpoint
INSERT INTO `aptlss_manager_queue_slots` (`id`) VALUES (1), (2), (3), (4);
