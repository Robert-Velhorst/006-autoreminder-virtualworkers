export type WorkerIntegrationSyncInput = {
  enabled: boolean;
  intervalMinutes: number;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type WorkerIntegrationSyncStatus = {
  label: "Needs attention" | "Paused" | "Never synced" | "Check due" | "Up to date" | "Time unknown";
  detail: string;
  tone: "critical" | "muted" | "warning" | "healthy";
};

export function describeWorkerIntegrationSync(
  input: WorkerIntegrationSyncInput,
  nowMs = Date.now(),
): WorkerIntegrationSyncStatus {
  if (!input.enabled) {
    return { label: "Paused", detail: "Automatic checks are turned off.", tone: "muted" };
  }
  if (input.lastError) {
    return { label: "Needs attention", detail: input.lastError, tone: "critical" };
  }
  if (!input.lastSyncedAt) {
    return { label: "Never synced", detail: "No successful check has been recorded yet.", tone: "warning" };
  }

  const lastSyncMs = Date.parse(input.lastSyncedAt);
  if (!Number.isFinite(lastSyncMs) || lastSyncMs > nowMs + 5 * 60_000) {
    return { label: "Time unknown", detail: "The last successful check time could not be verified.", tone: "warning" };
  }

  const intervalMs = Number.isFinite(input.intervalMinutes)
    ? Math.max(1, input.intervalMinutes) * 60_000
    : 60 * 60_000;
  if (nowMs - lastSyncMs >= intervalMs) {
    return { label: "Check due", detail: "The configured sync interval has elapsed.", tone: "warning" };
  }

  return { label: "Up to date", detail: "Within the configured sync interval.", tone: "healthy" };
}
