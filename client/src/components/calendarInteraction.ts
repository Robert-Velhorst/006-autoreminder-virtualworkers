export function canRescheduleCalendarTask(
  onTaskReschedule: ((taskId: string, newDate: string) => void) | undefined,
) {
  return typeof onTaskReschedule === "function";
}
