/** Return true only when a worker-owned task assignment was actually updated. */
export function didUpdateSingleTaskAssignment(result: unknown): boolean {
  return typeof result === "object" && result !== null
    && (result as { rowCount?: unknown }).rowCount === 1;
}
