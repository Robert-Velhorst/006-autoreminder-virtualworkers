export const API_REQUEST_TIMEOUT_MS = 30_000;
export const MANAGER_REQUEST_TIMEOUT_MS = 450_000;

const managerMutations = new Set([
  "/api/trpc/operator.runManager",
  "/api/trpc/operator.runManagerForReview",
  "/api/trpc/operator.submitManagerUpdate",
]);

export function dashboardApiDeadline(input: RequestInfo | URL, init: RequestInit | undefined, origin: string) {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? input.toString(), origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  return method === "POST" && managerMutations.has(url.pathname)
    ? MANAGER_REQUEST_TIMEOUT_MS
    : API_REQUEST_TIMEOUT_MS;
}
