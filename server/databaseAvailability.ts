import type { Response } from "express";

export const DATABASE_UNAVAILABLE_MESSAGE = "The dashboard is temporarily unavailable. Please try again shortly.";

export class DatabaseUnavailableError extends Error {
  constructor() {
    super(DATABASE_UNAVAILABLE_MESSAGE);
    this.name = "DatabaseUnavailableError";
  }
}

const availabilityCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "ER_SERVER_SHUTDOWN", "ER_CON_COUNT_ERROR", "ER_TOO_MANY_USER_CONNECTIONS",
  "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR",
]);

// Drizzle wraps driver errors; inspect codes, never query text or credentials.
export function isDatabaseUnavailable(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16 && current && typeof current === "object"; depth++) {
    if (visited.has(current)) return false;
    visited.add(current);
    if (current instanceof DatabaseUnavailableError) return true;
    const detail = current as { code?: unknown; cause?: unknown };
    if (typeof detail.code === "string" && availabilityCodes.has(detail.code)) return true;
    current = detail.cause;
  }
  return false;
}

export function respondDatabaseUnavailable(res: Response) {
  res.setHeader("Retry-After", "5");
  res.setHeader("Cache-Control", "no-store");
  return res.status(503).json({ error: DATABASE_UNAVAILABLE_MESSAGE });
}
