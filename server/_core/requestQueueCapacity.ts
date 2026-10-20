const DEFAULT_PENDING_REQUEST_QUEUE_CAP = 500;
const MAX_PENDING_REQUEST_QUEUE_CAP = 10_000;

export function getPendingRequestQueueCap(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number.parseInt(env.MAX_PENDING_REQUESTS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PENDING_REQUEST_QUEUE_CAP;
  return Math.min(parsed, MAX_PENDING_REQUEST_QUEUE_CAP);
}
