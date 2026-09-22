CREATE TABLE `maintenance_job_settings` (
	`jobKey` varchar(96) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`intervalMinutes` int NOT NULL,
	`lastScheduledAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `maintenance_job_settings_jobKey` PRIMARY KEY(`jobKey`)
);
