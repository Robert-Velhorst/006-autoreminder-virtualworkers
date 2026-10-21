type Environment = Record<string, string | undefined>;

export type SessionIdentityProof = { userId: number; sessionEpoch: string };

export function isSessionEpoch(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}

export function sessionIdentityProof(user: { id: number; sessionEpoch: string }): SessionIdentityProof {
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || !isSessionEpoch(user.sessionEpoch)) {
    throw new Error("Session identity unavailable");
  }
  return { userId: user.id, sessionEpoch: user.sessionEpoch };
}

const DEFAULT_SESSION_AUDIENCE = "va-dashboard";

export function getSessionAudience(env: Environment = process.env) {
  return env.SESSION_APP_ID?.trim()
    || env.VITE_APP_ID?.trim()
    || DEFAULT_SESSION_AUDIENCE;
}
