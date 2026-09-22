/** Return true only when a worker-owned task assignment was actually updated. */
export function didUpdateSingleTaskAssignment(result: unknown): boolean {
  const value = Array.isArray(result) ? result[0] : result;
  return Number((value as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0) === 1;
}
