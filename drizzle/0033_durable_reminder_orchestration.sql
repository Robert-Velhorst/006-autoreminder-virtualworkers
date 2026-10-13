CREATE TABLE `commitments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceOwnerId` int NOT NULL,
  `assignedUserId` int NULL,
  `createdByUserId` int NOT NULL,
  `sourceType` enum('manual','trello','gmail','google_drive','system') NOT NULL,
  `sourceId` varchar(255) NULL,
  `sourceUrl` varchar(1024) NULL,
  `title` varchar(500) NOT NULL,
  `context` text NULL,
  `dueAt` timestamp NOT NULL,
  `status` enum('open','completed','cancelled') NOT NULL DEFAULT 'open',
  `completedAt` timestamp NULL,
  `cancelledAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `commitments_id` PRIMARY KEY(`id`),
  CONSTRAINT `commitments_workspace_source_unique` UNIQUE(`workspaceOwnerId`, `sourceType`, `sourceId`)
);
--> statement-breakpoint
CREATE INDEX `commitments_workspace_status_due_idx` ON `commitments` (`workspaceOwnerId`, `status`, `dueAt`);
--> statement-breakpoint
CREATE INDEX `commitments_assignee_status_due_idx` ON `commitments` (`assignedUserId`, `status`, `dueAt`);
--> statement-breakpoint
CREATE TABLE `reminder_rules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceOwnerId` int NOT NULL,
  `createdByUserId` int NOT NULL,
  `name` varchar(255) NOT NULL,
  `triggerType` enum('before_due','at_due','after_due','no_update','manual') NOT NULL DEFAULT 'before_due',
  `offsetMinutes` int NOT NULL DEFAULT 60,
  `channel` enum('in_app','email') NOT NULL DEFAULT 'in_app',
  `requireApproval` boolean NOT NULL DEFAULT true,
  `maxAttempts` int NOT NULL DEFAULT 1,
  `cooldownMinutes` int NOT NULL DEFAULT 60,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `reminder_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `reminder_rules_workspace_active_idx` ON `reminder_rules` (`workspaceOwnerId`, `active`);
--> statement-breakpoint
CREATE TABLE `reminder_policies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  `inAppEnabled` boolean NOT NULL DEFAULT true,
  `emailEnabled` boolean NOT NULL DEFAULT false,
  `maxPerDay` int NOT NULL DEFAULT 3,
  `minIntervalMinutes` int NOT NULL DEFAULT 60,
  `quietHoursStart` varchar(5) NOT NULL DEFAULT '22:00',
  `quietHoursEnd` varchar(5) NOT NULL DEFAULT '08:00',
  `timezone` varchar(64) NOT NULL DEFAULT 'UTC',
  `allowWeekends` boolean NOT NULL DEFAULT false,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `reminder_policies_id` PRIMARY KEY(`id`),
  CONSTRAINT `reminder_policies_user_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `reminder_schedules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `commitmentId` int NOT NULL,
  `ruleId` int NOT NULL,
  `recipientUserId` int NOT NULL,
  `scheduledFor` timestamp NOT NULL,
  `state` enum('scheduled','preparing','draft_ready','sending','sent','failed','needs_review','escalated','skipped','cancelled') NOT NULL DEFAULT 'scheduled',
  `channel` enum('in_app','email') NOT NULL,
  `idempotencyKey` varchar(64) NOT NULL,
  `draftTitle` varchar(500) NULL,
  `draftContent` text NULL,
  `policyReason` text NULL,
  `attemptCount` int NOT NULL DEFAULT 0,
  `lastAttemptAt` timestamp NULL,
  `approvedAt` timestamp NULL,
  `approvedByUserId` int NULL,
  `sentAt` timestamp NULL,
  `escalatedAt` timestamp NULL,
  `error` text NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `reminder_schedules_id` PRIMARY KEY(`id`),
  CONSTRAINT `reminder_schedules_idempotency_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `reminder_schedules_due_state_idx` ON `reminder_schedules` (`state`, `scheduledFor`);
--> statement-breakpoint
CREATE INDEX `reminder_schedules_recipient_state_idx` ON `reminder_schedules` (`recipientUserId`, `state`, `scheduledFor`);
--> statement-breakpoint
CREATE INDEX `reminder_schedules_commitment_idx` ON `reminder_schedules` (`commitmentId`);
--> statement-breakpoint
CREATE TABLE `reminder_audit_events` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceOwnerId` int NOT NULL,
  `commitmentId` int NULL,
  `scheduleId` int NULL,
  `actorUserId` int NULL,
  `eventType` varchar(64) NOT NULL,
  `detailsJson` longtext NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `reminder_audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `reminder_audit_workspace_created_idx` ON `reminder_audit_events` (`workspaceOwnerId`, `createdAt`);
--> statement-breakpoint
CREATE INDEX `reminder_audit_commitment_created_idx` ON `reminder_audit_events` (`commitmentId`, `createdAt`);
--> statement-breakpoint
CREATE INDEX `reminder_audit_schedule_created_idx` ON `reminder_audit_events` (`scheduleId`, `createdAt`);
