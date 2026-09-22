const pilotDenialMessage = "Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.";

export function isManagerPilotDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("data" in error) || !("message" in error)) return false;
  const data = error.data;
  // Other FORBIDDEN responses can indicate broken authentication or authorization.
  return !!data && typeof data === "object" && "code" in data && data.code === "FORBIDDEN" && error.message === pilotDenialMessage;
}

type StatusQuery = { state: { error: unknown } };

export const managerStatusQueryOptions = {
  retry: false as const,
  staleTime: 30_000,
  enabled: (query: StatusQuery) => !isManagerPilotDenied(query.state.error),
};

export function managerStatusPollingInterval(query: StatusQuery): number | false {
  return isManagerPilotDenied(query.state.error) ? false : 60_000;
}
