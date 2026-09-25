export type WorkerSourceCheck = {
  key: "trello" | "gmail" | "google_drive" | "communication";
  label: string;
  linkedCount: number;
  checkedAt: string | null;
  status: "current" | "overdue" | "unknown" | "disabled" | "disconnected";
  checkedLabel: string;
  nextAction: string | null;
};

type ProviderSync = {
  enabled: boolean;
  lastSyncedAt: string | null;
  intervalMinutes: number;
} | null;

export type WorkerSourceCheckInput = {
  sources: Array<{ key: string; count: number }>;
  trelloCache: { cachedAt: string; expiresAt: string } | null;
  gmail: ProviderSync;
  drive: ProviderSync;
  googleConnectionReady: boolean | null;
  now: number;
};

function validTime(value: string | null | undefined, now: number) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + 60_000 ? parsed : null;
}

function validExpiry(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function assessWorkerSourceChecks(input: WorkerSourceCheckInput) {
  const count = (key: string) => Math.max(0, input.sources.find(source => source.key === key)?.count ?? 0);
  const checks: WorkerSourceCheck[] = [];
  const cacheTime = validTime(input.trelloCache?.cachedAt, input.now);
  const expiry = validExpiry(input.trelloCache?.expiresAt);
  checks.push({
    key: "trello",
    label: "Trello card",
    linkedCount: count("trello"),
    checkedAt: cacheTime ? new Date(cacheTime).toISOString() : null,
    status: !cacheTime || !expiry || expiry < cacheTime ? "unknown" : input.now > expiry ? "overdue" : "current",
    checkedLabel: "Cached copy saved",
    nextAction: !cacheTime || !expiry || expiry < cacheTime || input.now > expiry ? "Open the original Trello card and verify it before changing it." : null,
  });

  const addProvider = (key: "gmail" | "google_drive", label: string, provider: ProviderSync, action: string) => {
    const linkedCount = count(key);
    if (!linkedCount) return;
    const lastSync = validTime(provider?.lastSyncedAt, input.now);
    const interval = provider?.intervalMinutes ?? 0;
    const status = !provider ? "unknown"
      : !provider.enabled ? "disabled"
      : input.googleConnectionReady === false ? "disconnected"
      : !lastSync || !Number.isFinite(interval) || interval <= 0 ? "unknown"
      : input.now - lastSync > interval * 2 * 60_000 ? "overdue" : "current";
    checks.push({
      key, label, linkedCount,
      checkedAt: lastSync ? new Date(lastSync).toISOString() : null,
      status,
      checkedLabel: "Worker account last synced",
      nextAction: status === "current" ? null : action,
    });
  };

  addProvider("gmail", "Gmail", input.gmail, "Open the original email and verify it before replying or filing.");
  addProvider("google_drive", "Drive", input.drive, "Open the original file and verify its current contents before using it.");
  if (count("communication")) {
    checks.push({
      key: "communication", label: "Messages", linkedCount: count("communication"),
      checkedAt: null, status: "unknown", checkedLabel: "No sync time recorded",
      nextAction: "Open the linked conversation to check for newer messages.",
    });
  }

  return {
    checks,
    coverageGap: count("gmail") + count("google_drive") + count("communication") === 0
      ? "No email, file or conversation is linked to this task. Check any required source before acting."
      : null,
  };
}
