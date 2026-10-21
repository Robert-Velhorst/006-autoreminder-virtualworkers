const pilotDenialMessage = "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.";

export function isManagerPilotDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("data" in error) || !("message" in error)) return false;
  const data = error.data;
  // Other FORBIDDEN responses can indicate broken authentication or authorization.
  return !!data && typeof data === "object" && "code" in data && data.code === "FORBIDDEN" && error.message === pilotDenialMessage;
}

export function managerExecutionCoverageReady(error: unknown, executionReady: unknown): boolean {
  return isManagerPilotDenied(error) || executionReady === true;
}

type StatusQuery = { state: { error: unknown; errorUpdatedAt?: number } };

export function managerStatusRetryRemaining(error: unknown, errorUpdatedAt: number, now = Date.now()): number {
  if (!error || typeof error !== "object" || !("data" in error)) return 0;
  const data = error.data;
  if (!data || typeof data !== "object" || !("retryAfter" in data)) return 0;
  const seconds = data.retryAfter;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(0, errorUpdatedAt + seconds * 1000 - now);
}

export const managerStatusQueryOptions = {
  retry: false as const,
  staleTime: 30_000,
  enabled: (query: StatusQuery) => !isManagerPilotDenied(query.state.error),
  refetchOnWindowFocus: (query: StatusQuery) => !isManagerPilotDenied(query.state.error)
    && managerStatusRetryRemaining(query.state.error, query.state.errorUpdatedAt ?? 0) === 0,
  refetchOnReconnect: (query: StatusQuery) => !isManagerPilotDenied(query.state.error)
    && managerStatusRetryRemaining(query.state.error, query.state.errorUpdatedAt ?? 0) === 0,
};

export function managerStatusPollingInterval(query: StatusQuery): number | false {
  return isManagerPilotDenied(query.state.error) ? false
    : Math.min(2_147_483_647, Math.max(60_000, managerStatusRetryRemaining(query.state.error, query.state.errorUpdatedAt ?? 0)));
}
