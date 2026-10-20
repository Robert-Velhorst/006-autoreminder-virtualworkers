ALTER TABLE `reply_threads`
  MODIFY COLUMN `status` enum('pending','replied','overdue','inactive') NOT NULL DEFAULT 'pending';
