# Background startup isolation

`BACKGROUND_JOBS_ENABLED=false` prevents this application process from starting
its six automatic workers: briefing, Manus, reminders, maintenance, APTLSS
manager and founder decision alerts. It is supported in production. The default
is `true`, including when the variable is omitted; individual worker policies
and enable flags still apply. Only literal `true` and `false` are accepted.
Restart the process after changing the variable.

Use this for an owned compatibility rehearsal or a standby instance that must
not compete with the active process. Production configuration and local bypass
validation run first. Invalid browser-test configuration is still rejected,
even when this global switch is off, before server/Redis initialization.

## What remains available

- Login, role checks, worker isolation, CSRF/origin protection and rate limiting.
- HTTP readiness checks, Redis and authenticated WebSockets.
- Explicit authorized manual work, subject to its existing approval policies.
- Incoming provider callbacks and collectors, subject to their authentication.
- In-memory Trello callback configuration for explicit Settings actions.
  Startup passes `false` to webhook auto-registration; it does not register or
  synchronize provider webhooks automatically.

This is **not** a database read-only mode, a network firewall, a suspension of
incoming events, or an authorization bypass. Do not connect a standby to live
incoming traffic merely because its workers are disabled. For a read-only
rehearsal, isolate networking, control incoming requests, and compare complete
data/schema checkpoints before and after. A successful readiness check alone
does not establish that automatic jobs or integrations work.

## Verification required

Verify the actual built image: startup logs must report the switch as disabled,
all six workers must be suppressed, and authorized login/role boundaries must
still work. Observe at least the immediate Manus and the five-second/sixty-second
maintenance startup windows. Compare complete before/after data checkpoints,
not only job counts. Only synthetic owned fixtures are suitable for the ordinary
configured-runtime harness; do not point it at a production-data restore.

The switch does not retrospectively change old images. In particular, the
current operational fallback `fa20db9c...` has not been proven to support this
configuration. Its full-data backward/forward compatibility remains a separate
gate. Preserve the old image and database backup; do not treat a newly hardened
image as proof that the exact previous binary is safe to start on a restore.

See [Full-data rollback checkpoints](FULL_DATA_ROLLBACK_CHECKPOINT.md) and
[Production runtime rehearsal](PRODUCTION_RUNTIME_REHEARSAL.md). This document
does not issue activation, cutover or rollback clearance.
