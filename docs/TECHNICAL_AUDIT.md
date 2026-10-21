# Technical Audit

## Latest Source Acceptance Boundary: October 21, 2026

The configured PostgreSQL production-image gate was accepted in PR
[#140](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/pull/140)
at source `5f237b01f84f3254108882d797902fc5b68f23a1`, merged as
`5af68da3216986bef1b26f634f9abb2e264d0a28`. The isolated check exercised verified
database TLS, canonical migrations, a restricted application role, actual HTTP
authentication and worker offboarding, and confirmed fixture cleanup. This is
not acceptance of the real Hetzner host, providers, or operational data.

PR [#141](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/pull/141)
merged canonical timer identity and worker-interface changes as
`df5c9f3f8af3c06723fe0d1992a50d6153ed4410`, with an identical tree to reviewed
head `386aab90401312d48f818d3e8c3ccb6ab2266d76`. That head passed quality
`39543523895` and CodeQL `39543520471`: 4,460 Vitest cases with 22 skips,
all 17 native cross-reader cases, configured image acceptance, browser gates
and isolated backup/restore. Earlier failed candidates remain failed historical
evidence. The merged-main run and any later source need their own acceptance.

Independent source review still confirms application blockers: issue #95's
nontransactional assignment upsert lacks founder/task uniqueness, and issue
#52's legacy OAuth callback lacks browser-bound single-use initiation. Their
fixes require scoped native/route regression evidence; timer correctness or
current Google OAuth protections do not establish these separate requirements.

PR [#135](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/pull/135)
retains the separate exact-image vulnerability and promotion gate. Its workflow
cannot start under the current selected-Action policy. Permission for the one
pinned official artifact upload action remains an owner decision; neither
removing evidence retention nor broadening permissions is a substitute.

The dated results below describe earlier source revisions. The live acceptance
requirements remain in [Production Cutover](PRODUCTION_CUTOVER.md), and branch
disposition is tracked in [Consolidation Ledger](CONSOLIDATION_LEDGER.md).

## Architecture

The application is one persistent Node service with a React client, Express
and tRPC APIs, PostgreSQL, Socket.IO, and database-leased scheduled jobs.
Redis is optional and external. Compose runs one application container; the
shared PostgreSQL service must be provisioned separately with a dedicated
application database and least-privilege role. Hetzner is the intended deployment
target behind a stable HTTPS reverse proxy. The retired hosting/tunnel setup is
not a production dependency.

`drizzle/schema.postgres.ts` and `drizzle-postgres-v1` define the current
database contract. Historical MySQL migrations and operator-only transfer tools
are not an alternative runtime backend. Worker-operator capabilities share the
canonical identity, evidence, planning and scheduled-job records.

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
- Repaired PostgreSQL migration/schema parity; PR #140's isolated migrated
  PostgreSQL 18.6 fixture verified 138 expected tables. Later schema changes
  require a new full parity check, not reuse of this earlier result.
- Added one-time owner access recovery without enabling public registration.
- Made administrator ATIS sync/analysis asynchronous: durable operation IDs,
  bounded status polling, explicit interruption recovery, request deduplication,
  and ownership-fenced writes. Ordinary HTTP timeouts remain bounded.

## Verification Boundary

PR [#99](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/pull/99)
merged as `77d4bf762893a735d9c2aa170b8e9bfe538c5b5f`. Its tree exactly matches
the reviewed head `01222c24b3cdf358781a95fa058d2c8b78e3e243`, whose required CI
and CodeQL checks passed. CI covered migrations, schema parity, tests, build,
authentication and worker browser contracts, guarded database/browser checks,
backup/restore, and production image build/runtime. Five additional intercepted
Chromium cases exercise the administrator's asynchronous-operation UI; these are
UI contract tests, not live provider tests.

The local database-backed suite passed 3,775 tests with 22 skipped using two
workers. An earlier unrestricted local run timed out in one cache performance
test; no assertion or timeout was weakened. Green source checks do not establish
that a production database, deployment, provider connection or worker trial has
been accepted. Consult the actual GitHub checks for later commits rather than
transferring this checkpoint's result to changed code.

The subsequent exact-main run `39516188582` failed in the collector-transfer
integration case: concurrent shared-fixture transactions produced a deadlock
instead of the expected ownership collision. The follow-up test isolates that
transfer in its own disposable database, applies the complete canonical
migrations, and retains the collision, unchanged-owner, and successful-import
assertions while another fixture transaction stays open. This repairs test
isolation, not online-import safety; operational imports still require quiesced
writers. The follow-up also binds ARES rule mutations to their owned
configuration, isolates personal settings by worker, and enforces persisted
recipient email consent for scheduled digests and briefings. These changes need
their own exact-head checks before acceptance.

Local follow-up acceptance under Node 26.12.0 and PostgreSQL 18.6 passed 3,840
tests with 22 skipped and four workers, plus TypeScript and the staged secret
scan. The isolated collector databases were confirmed removed before stopping
the sole tmpfs PostgreSQL fixture. Hosted checks and live infrastructure remain
separate acceptance requirements.

Personal settings use worker-qualified keys with an ownership-conditional
upsert. Historical unqualified keys could have had their value overwritten
without changing the recorded owner, so a matching old owner field is not proof
of provenance. Such rows are retained for review, not automatically copied into
another worker's scope. When ownership is reported as unverified, inspect the
retained record privately and explicitly save the intended personal setting
through the authenticated settings page. Do not repair this by relabeling an old
row's owner or weakening the ownership predicate.

## Resource Improvements

- Bounded worker lists use progressive reveal instead of rendering all rows.
- Background jobs use persisted schedules and leases rather than overlapping
  browser polling loops.
- Redis-backed cache and request controls remain optional locally and required
  when configured in production.
- Evidence ingestion is incremental and provider scopes are read-only unless a
  separate send permission is explicitly connected.

## External Activation Still Required

- Confirm and prepare the Hetzner host, domain, private shared PostgreSQL service,
  application role/database, TLS, backups and tested restore procedure. Production
  SSH deployment secrets were not configured at this checkpoint.
- Resolve the two historical credential alerts through verified rotation or
  revocation. Removing credentials from the current tree does not revoke them;
  the owner declined deletion of the existing shared database user.
- The owner must choose the initial owner password with the one-time token.
- Each replacement worker must accept their own invitation and connect their
  own Google/Trello identity where required.
- Google OAuth redirect URIs must match the active public origin.
- Browser tab evidence requires one explicit browser extension approval.
- Outbound Gmail delivery remains disabled until send-only OAuth is approved
  and notifications are enabled.
- Webhook health depends on a stable public HTTPS callback and Trello approval.
- Subscription-backed manager execution needs a verified private host transport;
  the base application container does not by itself provide that connection.
- Keep the manager in shadow mode until the documented worker-trial acceptance
  criteria pass. Unit tests and CI are not substitutes for that trial.

These are provider or owner consent boundaries, not simulated completion.
Follow [Production Cutover](PRODUCTION_CUTOVER.md) for the live acceptance gate.
