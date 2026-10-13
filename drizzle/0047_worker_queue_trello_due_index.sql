-- The worker queue reads current Trello deadlines for assigned cards.
SET @queue_index_ddl = IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trello_cached_cards' AND INDEX_NAME='trello_cached_cards_user_card_cached_idx'), 'SELECT 1', 'ALTER TABLE `trello_cached_cards` ADD INDEX `trello_cached_cards_user_card_cached_idx` (`userId`, `cardId`, `cachedAt`), ALGORITHM=INPLACE, LOCK=NONE');
--> statement-breakpoint
PREPARE queue_index_stmt FROM @queue_index_ddl;
--> statement-breakpoint
EXECUTE queue_index_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE queue_index_stmt;
