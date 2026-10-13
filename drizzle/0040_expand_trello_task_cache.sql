-- Scheduling responses can include a full multi-board work queue. TEXT is
-- capped at 64 KiB in MySQL and caused the live cache path to be disabled.
-- MEDIUMTEXT retains existing rows and supports cache payloads up to 16 MiB.
ALTER TABLE `trello_cached_tasks`
  MODIFY COLUMN `taskData` MEDIUMTEXT NOT NULL;
