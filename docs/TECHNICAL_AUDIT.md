# Technical Audit

## Architecture

The application is one persistent Node service with a React client, Express
and tRPC APIs, MySQL, Redis, Socket.IO, scheduled jobs, and an optional ngrok
edge. The developer platform through migration `0027` remains canonical.
Worker-operator capabilities are additive migrations and route namespaces.

## Correctness Improvements

- Removed the duplicate legacy worker portal mount; old bookmarks redirect to
  the canonical worker shell.
- Scoped legacy `/api` middleware so it no longer intercepts tRPC login state.
- Added worker ownership checks to APTLSS cards, decisions, waiting reasons,
  evidence, plans, browser data, reminders, and Trello actions.
- Made reminders durable, leased, idempotent, rate limited, retryable, and
  auditable.
- Centralized OpenAI access and retained deterministic validation/fallback.
- Added progress and ETA state for maintenance and planning operations.
- Added graceful scheduler shutdown and independent maintenance intervals.
- Removed the unreferenced in-memory APTLSS queue; generation now has one
  durable, database-backed execution path.
- Normalized persisted batch-operation responses at the client boundary so
  queue refreshes retain progress, elapsed time, and ETA data without
  fabricating unsupported per-task detail.
- Corrected batch pause targeting so a queue-row control always affects the
  selected running operation rather than an unrelated primary job.
- Repaired migration/schema parity and rehearsed migrations against MySQL.
- Added one-time owner access recovery without enabling public registration.

## Resource Improvements

- Bounded worker lists use progressive reveal instead of rendering all rows.
- Background jobs use persisted schedules and leases rather than overlapping
  browser polling loops.
- Redis-backed cache and request controls remain optional locally and required
  when configured in production.
- Evidence ingestion is incremental and provider scopes are read-only unless a
  separate send permission is explicitly connected.

## External Activation Still Required

- The owner must choose the initial owner password with the one-time token.
- Each replacement worker must accept their own invitation and connect their
  own Google/Trello identity where required.
- Google OAuth redirect URIs must match the active public origin.
- Browser tab evidence requires one explicit browser extension approval.
- Outbound Gmail delivery remains disabled until send-only OAuth is approved
  and notifications are enabled.
- Webhook health depends on a stable public HTTPS callback and Trello approval.

These are provider or owner consent boundaries, not simulated completion.
