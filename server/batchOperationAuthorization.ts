type AssignedTask = { taskId: string };

export function findUnownedBatchTaskIds(
  assignedTasks: readonly AssignedTask[],
  requestedTaskIds: readonly string[],
): string[] {
  const assignedTaskIds = new Set(assignedTasks.map((task) => task.taskId));
  return requestedTaskIds.filter((taskId) => !assignedTaskIds.has(taskId));
}
