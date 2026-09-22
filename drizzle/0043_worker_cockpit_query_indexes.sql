CREATE INDEX `va_time_entries_period_idx` ON `time_entries` (`vaId`,`startTime`,`endTime`);
--> statement-breakpoint
CREATE INDEX `email_tasks_va_status_received_idx` ON `email_tasks` (`vaId`,`status`,`receivedAt`);
--> statement-breakpoint
CREATE INDEX `email_tasks_va_trello_card_idx` ON `email_tasks` (`vaId`,`trelloCardId`);
--> statement-breakpoint
CREATE INDEX `va_aptlss_step_card_idx` ON `aptlss_steps` (`vaId`,`cardId`);
