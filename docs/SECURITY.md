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
