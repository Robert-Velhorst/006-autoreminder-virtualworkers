CREATE TABLE IF NOT EXISTS `atis_checklist_completion` (
  `id` int AUTO_INCREMENT NOT NULL,
  `card_id` int NOT NULL,
  `step_index` int NOT NULL,
  `user_id` int NOT NULL,
  `completed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `atis_checklist_completion_id` PRIMARY KEY(`id`),
  CONSTRAINT `card_step_user_unique` UNIQUE(`card_id`,`step_index`,`user_id`)
);
--> statement-breakpoint
CREATE INDEX `atis_checklist_user_completed_idx` ON `atis_checklist_completion` (`user_id`,`completed_at`);
