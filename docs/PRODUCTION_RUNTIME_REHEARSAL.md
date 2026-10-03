# Configured Production Runtime Rehearsal

## Current Lifecycle Restriction, 2026-10-01

The multi-container fixture described below is historical. Its containers were
removed in the authorized Docker cleanup; the old names and ownership labels
do not establish a currently running test environment. Earlier receipts retain
their original source/image and scope, but are not fresh acceptance of the
current working source.

Robert now permits only one temporary VA verification container at a time,
alongside the existing operational stack. Do not recreate the separate MySQL,
Redis, application and browser containers in this historical recipe. The complete
configured-runtime exercise now uses the single isolated adapter below; do not
reuse the historical multi-container recipe. Keep authenticated Redis, real
storage, actual compiled application behavior, TLS, browser checks and data
preservation in its scope; simplifying it to isolated unit tests is not a
replacement. Follow the lifecycle constraint in `GOAL_COMPLETION_MATRIX.md`.

### Single-workspace Adapter: Configured Gate Verified

The ignored `.local/single-runtime-20261001` adapter combines the pinned stock
MySQL/Redis/browser runtimes, locked test dependencies and the actual candidate
filesystem in one temporary networkless container. It retains the existing
21-check verifier unchanged. The candidate runs as UID 1001 inside its original
filesystem with fixture-local host aliases and a read-only mount of the
disposable container's own process information; HTTPS certificates, synthetic
accounts and the test database are disposable. It never mounts production data.
The host checks source/image identity and the operational app before starting,
and removes only its ownership-labelled test container in cleanup.

Its first local-image reference setup failed before tests; the second setup
stalled while operational probes also timed out and was cancelled. Docker
recovery is recorded in `GOAL_COMPLETION_MATRIX.md` under "Host Recovery Incident
And Restoration". After restoration, attempt3 failed Redis startup observation,
attempt4 passed 20 checks but failed health due to the fixture's missing `/proc`,
and attempt5 refused to run before reducing setup privileges. All failures are
retained. Attempt6 passed all 21 configured checks on the unchanged frozen source
and candidate image. Syntax checks alone were never counted as runtime evidence.

The adapter's local lifecycle regressions now cover nine success/failure paths:
preflight/build/runtime failure, preserving the original failure when cleanup
also fails, and rejecting acceptance when cleanup, operating-app health or
verification is unconfirmed. These tests run without Docker; their report is
`artifacts/production-runtime-lifecycle-20261001/results.json`. Phase checkpoints
and final receipts contain sanitized error identifiers, not exception messages.
Readiness and the empty container slot are rechecked after image setup, not just
before it. The five-minute build-client deadline is not proof of daemon-side
cancellation; do not retry after a timeout without checking owned build state.
The application fixture explicitly selects the actual
`APTLSS_MANAGER_PROVIDER=codex-subscription` setting; no paid fallback is enabled.
The configured pass is `artifacts/production-single-runtime-20261001-attempt6`.
Its setup requires mount/capability-reduction privileges only to expose its own
container process information read-only to the candidate root. Both are dropped
from effective, permitted, bounding, inherited and ambient sets before Node or
source code runs; the harness verifies this. No host PID namespace, Docker socket,
production mount, provider network or privileged-container flag is used. The
application remains UID 1001 with no authentication bypass. Candidate, MySQL and
Redis shut down normally; test-container removal and operational health passed.
Full route/workflow, provider and full-data rollback gates remain independent.

The same-image route matrix completed in attempt9: 64/64 UI cases and eight
setups passed, but overall acceptance is degraded because fixture source APIs
are unavailable. See `artifacts/production-single-runtime-20261001-attempt9`.
This covers settled empty/degraded screens, not populated manager workflows or
live providers. Attempt7 timed out under an adapter deadline shorter than the
verifier's budget; attempt8 was explicitly cancelled during resolver diagnosis.
Both failed receipts remain retained. The adapter now waits for app readiness,
allows the unchanged matrix its full budget, and adds a fixture-only loopback
resolver with a one-second failure limit and no DNS listener. This supplies no
provider access. The candidate filesystem otherwise remains unchanged except
for the documented fixture hosts and own-container read-only process mount.
Normal app/Redis/MySQL shutdown, container removal and original-host health were
verified after attempt9. Overall failure is intentionally preserved despite the
passing UI checks.

The original dashboard/tunnel were manually restarted and restoration verified
before attempt3: `artifacts/production-host-restored-20261001/boundary.json`.
The original application image is retained; readiness and the worker page
responded HTTP 200. This is restoration evidence, not new-image acceptance.

## Purpose and limits

`scripts/verify-configured-production-runtime.mjs` tests an actual immutable
production image through an ephemeral HTTPS reverse proxy, real MySQL,
password-protected Redis and Chromium. It does not deploy the image, contact
live providers, enable active APTLSS, migrate production or change access to
Robert's existing dashboard. It is intentionally restricted to the named,
separately owned October 1 fixtures, not a general-purpose production probe.

The verifier uses five synthetic accounts only. The founder fixture is an
admin-role account with two owned worker profiles; a different admin-role
account owns none. This tests workspace isolation in the existing model, not
distinct founder/admin privileges. A pending `user` and two `worker` accounts
exercise wrong-role and worker identity boundaries.

## Fixture prerequisites

- Verify ownership label `codex.task=va-production-acceptance-20261001` before
  changing any fixture. Never stop the current dashboard, shared Redis or a
  production database for these tests.
- The application, Redis and fresh MySQL fixtures must have no published
  ports and must connect only to the internal
  `va-production-acceptance-20261001` network. Check a new subnet against
  existing Docker networks and host routes; do not prune networks or alter
  Docker's shared address pools to make space.
- MySQL's only test database is `recovery_test`, at
  `va-runtime-mysql:3306`, with the canonical 54 migration identities through
  `0053`. Run migrations against that fresh fixture before seeding. The earlier
  receipts below retain their original migration counts; do not relabel them.
  This is different from `aptlss_test` in the existing strict-SQL fixture.
- The application runs with `NODE_ENV=production`, `LOCAL_AUTH_BYPASS=false`,
  `PUBLIC_URL=https://127.0.0.1:3443`, `TRUST_PROXY_HOPS=1`, authenticated Redis,
  shadow-only APTLSS and `BACKGROUND_JOBS_ENABLED=false` to suppress all six
  startup workers. This preserves HTTP, authentication and WebSocket checks;
  it is not proof of scheduled delivery. Earlier images used individual flags;
  this switch cannot be assumed to work in those old images.
  All eight maintenance job settings are disabled in the fresh database.
- Use only obvious synthetic placeholder provider values to satisfy the
  canonical startup configuration. No actual API or OAuth credential belongs
  in this fixture. The internal network prevents backend provider access;
  this is not provider acceptance.
- The owned GNU-compatible Playwright fixture must be able to reach those
  internal aliases. It already shares the namespace of the separately owned
  expanded SQL fixture, which was explicitly attached to the internal network.
  Do not attach a production container or expose the private backend publicly.
- In the browser fixture, generate a short-lived self-signed certificate with
  SAN `IP:127.0.0.1`. Keep it at
  `/app/.local/production-runtime-rehearsal/server.crt` with its private key at
  `server.key` in the same directory. Restrict the key to mode 600. It is not
  a public certificate and must not enter source exports or CI artifacts.

The proxy listens on loopback port 3443 only in the fixture. Certificate trust
exceptions are limited to its HTTP/WebSocket clients and browser contexts;
the script does not disable TLS validation globally.

## Modes

Set `PRODUCTION_RUNTIME_FIXTURE=isolated-owned` and
`PRODUCTION_RUNTIME_DATABASE_URL` to the fresh fixture connection. The script
rejects any other host, port or database, and rejects URL query/fragment values.

`seed` requires an empty `users` table and exactly 54 migration records. It
inserts the synthetic users, profiles and disabled maintenance settings in one
transaction. It refuses reseeding and never clears an existing database.

The default `verify` mode refuses any unowned user and runs 21 named checks:
readiness and health, strict production headers, anonymous rejection, five
signed-password sessions and Secure/HttpOnly/Lax cookies, worker identity,
administrative denial, founder workspace ownership, CSRF rejection, three
WebSocket connection cases, worker-room non-leakage and four compiled browser
flows (worker desktop/mobile, founder and admin).

`PRODUCTION_RUNTIME_UPSTREAM` may select only `va-runtime-app`,
`va-runtime-app-recovery` or `va-runtime-app-cold-after`. Set `PRODUCTION_RUNTIME_IMAGE_ID` to the inspected
container image ID, not merely a Docker build log's configuration digest.
Independently inspect the container/image and compare its source seal before
accepting that report: the script records the supplied ID but does not query
Docker itself. Choose a new `PRODUCTION_RUNTIME_REPORT_DIRECTORY` matching
`artifacts/production-runtime-[a-zA-Z0-9-]+` for each run so earlier evidence is
retained. It must be a single directory: a nested path such as
`artifacts/production-runtime-example/auth` is rejected before connection or login.

See [Background startup isolation](BACKGROUND_STARTUP_ISOLATION.md) for the
switch's scope and the complete data-checkpoint requirements. Never substitute
this synthetic-account harness for full-data backward/forward compatibility.

`restart-session` adds a 22nd check. It prints
`session-ready-for-owned-restart` only after establishing the synthetic signed
worker session. The host then stops and restarts only the ownership-checked
candidate fixture. The verifier must observe unavailability, restored
readiness, a lower process uptime and the same authenticated worker identity
using the pre-restart cookie. It fails if that complete sequence is not
observed within 90 seconds. Record the container's stop status separately;
a passing login alone is not graceful-shutdown evidence.

`cold-redis` requires the fixed `va-runtime-app-cold-after` upstream and adds
six checks to the usual 21. Stop only the owned Redis fixture before starting
the candidate. The verifier requires liveness 200, readiness 503, a connected
database and disconnected Redis, then authenticates two different workers
while Redis is still unavailable. It tests local scoped delivery and prints
`sockets-ready-for-owned-redis-start`. Restore the owned Redis at that checkpoint,
with a host-side `finally` that also restores it if verification fails.

Recovery must preserve process uptime and the existing socket ID. Before
cross-process delivery, the independently running `va-runtime-app-recovery`
publisher must also become ready. A synthetic task event from that process
must arrive exactly once at the original worker socket, not at another worker.
No task record is completed or external action performed by that event.
`checkpointToReadyMs` includes the host's response to the checkpoint; it is
not a measurement starting at the Redis service's actual recovery time.

Reports and four screenshots are saved inside the browser fixture. Copy them
to the matching ignored `artifacts` directory only after completion. A printed
passing report is not enough: also await the actual zero command exit. The
proxy closes its owned upgraded sockets explicitly during cleanup.

## Outage and restart evidence

The original download-safety candidate recovered from a short Redis outage,
but stayed unhealthy after Redis was stopped for 45 seconds and restarted.
Its configured clients stopped reconnecting after three attempts. The retained
before report is `artifacts/production-runtime-redis-recovery-before-20261001.json`.

The recovery candidate is
`va-dashboard:production-runtime-candidate-redis-recovery-20261001`, inspected
image ID
`sha256:9df1862541080ce3f28df9f754ff82565bbbe26c1ff465fd3d9aeb883ef8ee88`.
It retains finite per-command retries and disables offline command queuing,
but reconnects with retry delays capped at two seconds. Returning a numeric
retry delay and manual-close behavior follow the existing
[ioredis reconnect contract](https://github.com/redis/ioredis#auto-reconnect).

For the observed 45-second outage, readiness correctly returned 503 while
Redis was unavailable. After restarting the owned Redis fixture, the same
application process returned healthy within the first recovery poll,
1,758 ms after the Redis start command returned. No application restart was
needed for recovery. Report:
`artifacts/production-runtime-redis-recovery-after-20261001.json`.

A separate controlled application stop completed in 1,093 ms, exited zero
and was not OOM-killed. The same candidate container was restarted without
changing the test database or credentials. All 22 configured checks passed,
including the existing cookie; report:
`artifacts/production-runtime-restart-20261001/results.json`.
Container-stop evidence:
`artifacts/production-runtime-graceful-restart-20261001.json`.

These timings are observations on small synthetic fixtures. They are not a
public recovery SLA or a rollback measurement on the full operational dataset.
Live integrations, startup with missing database dependencies, scheduled-job acceptance,
cross-instance scheduling locks, full-data application rollback and real
APTLSS shadow-practice reviews remain separate release conditions.

## Cold Redis startup and offline shutdown follow-up

The sustained-outage candidate above still discarded its Redis client references
after an initial connection rejection. Starting it without Redis and restoring
Redis left readiness at 503, even after the orphaned clients logged ready.
The before evidence is `artifacts/production-runtime-cold-start-before-20261001.json`.

The current cold-start candidate is
`va-dashboard:production-runtime-candidate-redis-cold-verified-20261001`, image
`sha256:5785b193f246e355cda7e092ed5e516e914410510ab72f51cf23732ac08c1e57`.
It retains its clients and installs one stable Redis adapter before sockets join.
Only the dedicated subscriber retains fixed internal channel subscriptions;
ordinary cache commands and application publications have no offline queue.
The adapter publisher skips offline events and catches a publish disconnect race,
retaining same-process delivery without an unhandled rejection or event replay.

All 27 cold-start configured checks passed, including actual cross-process
delivery to a socket established before Redis returned:
`artifacts/production-runtime-redis-cold-final-20261001/results.json`.
The app's uptime increased from 6.99 to 12.77 seconds and its original socket
survived. The 5,093 ms checkpoint-to-readiness observation includes orchestration.

The first cross-process attempt sent from the independently running publisher
before that process had recovered; it failed and is retained at
`artifacts/production-runtime-redis-cold-first-20261001/results.json`.
It also revealed an unhandled publish rejection in the prior publisher image.
The corrected verifier waits for that publisher's readiness, while separate
regressions cover local delivery and rejection handling in the new application.

With Redis stopped and readiness 503, the candidate exited normally in 4,985 ms,
exit zero and no OOM kill. After restarting both owned fixtures, all 22 configured
checks passed, including the pre-restart signed cookie:
`artifacts/production-runtime-redis-offline-restart-20261001/results.json`.
Stop-state evidence is `artifacts/production-runtime-redis-offline-shutdown-20261001.json`.
These remain synthetic-fixture checks, not production cutover or full-data rollback.

## MySQL outage and startup follow-up

`scripts/verify-production-database-recovery.mjs` supports `outage` and `cold`.
Both require `PRODUCTION_RUNTIME_FIXTURE=isolated-owned`, the exact owned
`va-runtime-mysql:3306/recovery_test` URL and internal `va-runtime-app-cold-after`
alias. The TLS proxy binds loopback inside the browser fixture; no host port.

In outage mode, stop independently ownership-checked MySQL only after
`session-ready-for-owned-mysql-stop`. Restore it in either mode after
`outage-observed-ready-for-owned-mysql-start`, and always in the host's finally
block even on failure. Never substitute a production database URL.

Cold mode starts the app with MySQL offline and uses the real-login synthetic
cookie saved privately by the outage run in
`.local/production-runtime-rehearsal/mysql-outage-session-cookie`, mode 0600
inside Linux. It is not exported into reports, source or chat. Supply the verified
baseline fingerprint as `PRODUCTION_DB_EXPECTED_DIGEST`. Snapshots require exactly
five owned synthetic accounts and 53 migrations; all rows/columns are checked
except users.lastSignedIn and users.updatedAt, which login intentionally updates.

Candidate `va-dashboard:production-runtime-candidate-mysql-recovery-final-20261001`,
image `sha256:eaabf224b20e0b06e28737f6a9e937bd08279377d424fe3f6dfc9c8f004c0921`,
passed 12 outage and nine cold-start checks with normal zero exits. Worker recovery
screenshots were inspected at desktop/mobile sizes. This supplements, not replaces,
configured auth/WebSocket checks, full-data rollback or real shadow-pilot acceptance.

## Shared scheduled-job ownership follow-up

`server/scheduledJobRuntime.integration.test.ts` is a mandatory member of the
strict MySQL gate in `scripts/run-mysql-integration.mjs`. Its explicit target
guard accepts only loopback `aptlss_test` or `recovery_test`; it never falls back
to the application's database. Each test owns a random `job-runtime-test:` key
and cleanup removes only that key's synthetic run/lease records. Child-process
fixtures require the same guarded target, an owned key and IPC. No real email,
Trello action or other provider call is performed.

The shared runtime retains the existing tables and per-day job keys. Database
time governs acquisition/expiry/renewal. Success is rechecked after acquisition;
run creation and completion lock the owned, unexpired lease. Interrupted runs
remain in history as abandoned, not fabricated successes. A replacement owner's
lease is never released by its predecessor. Renewal failure signals cancellation;
email briefings check ownership again immediately before their provider call.

This is not an exactly-once guarantee for external providers. A process may crash
after a provider accepts a request but before its local result is stored. An
AbortSignal cannot forcibly stop arbitrary callbacks or reverse an already-sent
request. Longer maintenance/generation callbacks still require per-operation
ownership checkpoints and provider-specific ambiguous-outcome reconciliation.
Do not enable automatic retries for uncertain external writes on the strength
of the shared lease tests alone. Production cutover and live scheduler acceptance
remain separate gates.

### Operation-level follow-up

The operation-fences candidate retains the same owned rehearsal database and
Redis. The previous owned application container is stopped, not deleted. The
replacement `va-runtime-app-operation-fences-20261001` has no published ports,
synthetic credentials, production RBAC and shadow-only manager execution; no
automatic delivery is enabled. Its 21 configured checks exited normally with
zero, with desktop/mobile images retained under
`artifacts/production-runtime-operation-fences-20261001`.

Shared ownership checks inside transactions use that transaction's connection
and lock the lease through commit. The explicit MySQL runtime tests now cover a
one-connection pool, schedule-claim rollback on run-record failure, and competing
ownership blocked until commit. Fixture schedule rollback owns a random
`test-schedule:` app-setting key and removes only that key afterward. Collector,
timer, webhook and email boundary tests use mocks; they do not grant provider
write permission. Full source-specific counts, image identity and residual
limitations are in the operation-level section of
`docs/PRODUCTION_VERIFICATION_20260930.md`.
