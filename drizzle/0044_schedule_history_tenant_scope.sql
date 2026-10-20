ALTER TABLE `task_schedule_history`
  ADD COLUMN `founderId` int,
  ADD COLUMN `assignmentId` int;
--> statement-breakpoint
UPDATE `task_schedule_history` history
INNER JOIN (
  SELECT taskId, MIN(founderId) AS founderId, MIN(id) AS assignmentId
  FROM `task_assignments`
  GROUP BY taskId
  HAVING COUNT(DISTINCT founderId) = 1
) assignment_scope ON assignment_scope.taskId = history.taskId
SET history.founderId = assignment_scope.founderId,
    history.assignmentId = assignment_scope.assignmentId
WHERE history.founderId IS NULL;
--> statement-breakpoint
CREATE INDEX `task_schedule_history_assignment_created_idx`
  ON `task_schedule_history` (`assignmentId`, `createdAt`);
