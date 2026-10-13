# Security Model

## Trust Boundaries

- Admin and founder accounts manage workers and platform policy.
- Worker accounts can access only assigned or owned operational records.
- Scheduled jobs authenticate separately and use leases and idempotency keys.
- HAI and browser collectors use dedicated scoped bearer tokens.
- Provider credentials remain server-side; browser tokens are independently
  verified before a session is created.

## Authentication

- Sessions are signed, HTTP-only, same-site cookies with a stable audience.
- Each session has a unique JWT ID. Logout stores only its SHA-256 hash in
  MySQL, and authenticated requests reject revoked IDs. Expired revocation rows
  are pruned during later logout operations.
- Deploy the `revoked_sessions` migration before serving the updated app. Older
  session cookies without a JWT ID are rejected, so users must sign in again.
- A pre-revocation binary does not consult `revoked_sessions` and can accept a
  still-valid cookie after logout. Do not return that binary to user traffic
  as a security-equivalent rollback. A production fallback must include the
  session-revocation checks and be verified against the retained database.
- `JWT_SECRET` also encrypts Google refresh tokens. Rotating it to invalidate
  cookies without first migrating those encrypted values can break Gmail/Drive
  access. Do not use secret rotation as a rollback shortcut.
- Public registration is off by default.
- Development bypass is accepted only on loopback and rejected in production.
- Owner bootstrap requires an existing admin with no password, a token of at
  least 24 characters, rate limiting, and a password of at least 12 characters.
  It closes after the first successful password write.
- Every newly managed local password uses the same 12-character minimum,
  including development registration, worker invitations, and founder-managed
  worker password changes.

## External Actions

Read-only evidence collection and local assessment are separate from provider
mutations. Trello comments and moves, outbound email, and similar actions
require policy approval and an explicit operator action. Every attempted send
records success or failure; no provider response is converted into fake
success.

## Operations

- Keep `.env`, `.env.db.local`, `.local`, backups, and exports out of Git.
- Rotate any credential ever pasted into a chat or committed to history.
- Bind application, database, Redis, and ngrok inspection ports to loopback.
- Back up MySQL before migrations and keep the previous image for rollback.
- Run `pnpm run doctor`, tests, schema parity, and readiness before public cutover.
