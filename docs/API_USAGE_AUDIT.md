# API Usage Audit

## Canonical Contracts

- `/api/trpc/*`: typed application queries and mutations.
- `/api/auth/*`: session, Trello login, local login, and one-time owner setup.
- `/api/health`, `/api/health/ready`, `/api/health/live`: runtime probes.
- `/api/google-evidence/*`: worker OAuth and evidence intake.
- `/api/worker-invitations/*`: owner-created, expiring worker activation.
- `/api/hai/*`: token-scoped HAI feed and acknowledgement.
- `/api/trello-webhook`: verified Trello push evidence.

## Hardening Applied

- The legacy APTLSS router is scoped to its own paths and cannot intercept
  tRPC or authentication traffic.
- Protected handlers resolve session identity before worker-scoped lookup.
- Card IDs are authorized against worker assignments before Trello mutations.
- Scheduled and collector endpoints use dedicated secrets instead of browser
  sessions.
- Reminder and maintenance writes are idempotent and retain audit records.
- Rate limits cover login, bootstrap, provider callbacks, and external actions.

## Known Compatibility Surface

Legacy developer REST routes remain mounted because founder, scheduling, ATIS,
ARES, reports, and administration still use them. Removal requires a measured
call-site audit and replacement tests; they are not silently deleted.
