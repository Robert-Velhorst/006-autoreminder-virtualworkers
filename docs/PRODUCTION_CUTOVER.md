# Production Cutover

## Target Runtime

The consolidated application requires a persistent Node.js container runtime,
MySQL, Redis, HTTPS, and WebSocket support. It also runs scheduled work inside
the application process. A static or request-only serverless deployment does
not preserve the complete runtime contract.

Use `Dockerfile` and `docker-compose.yml` for a single-host deployment, or map
the same services to a managed container platform. Keep one application
instance active until scheduled-job locking has been verified on the target
platform.

For a standby or owned compatibility rehearsal, set `BACKGROUND_JOBS_ENABLED=false`
in a build that actually supports it. This suppresses the six automatic startup
workers without weakening login or role checks. It does not make the instance
read-only or prevent authorized callbacks/manual writes. Keep it away from live
incoming traffic and compare complete data/schema checkpoints. The normal active
instance defaults to enabled workers; do not disable its required scheduled work
as a substitute for delivery acceptance. See
[Background startup isolation](BACKGROUND_STARTUP_ISOLATION.md). The exact old
rollback image still needs its own compatibility proof.

The supported single-host public entrypoint is `pnpm docker:public`. It runs
the application and ngrok in the same Compose network, binds the app and
database ports to loopback only, and records the current public endpoint in
`.local/public-dashboard.json`. Because an automatically assigned ngrok URL
can change after a restart, rerun the command after reboot so the backend and
Trello callback use the current URL.

Set `NGROK_URL` in `.env.db.local` when the account has more than one endpoint
or another application already uses the account's default developer domain.
Public password registration is disabled; existing workers authenticate with
their registered Trello identity or a separately provisioned local password.

Do not point either obsolete Vercel project at the repository root. A Vercel
deployment would omit the persistent process, scheduled work, and WebSocket
runtime required by the platform. Production startup rejects the Vercel
runtime explicitly so an incomplete frontend cannot be mistaken for an
operational deployment.

## Required Secrets

Configure these values in the deployment platform's secret store:

- `DATABASE_URL`: MySQL connection URL.
- `JWT_SECRET`: newly generated random value of at least 32 characters.
- `TRELLO_API_KEY`: active Trello API key.
- `TRELLO_TOKEN`: active Trello member token.
- `OPENAI_API_KEY`: active OpenAI API key for existing non-APTLSS platform AI
  features when used, or the explicitly selected `openai-api` manager provider.
  Subscription-mode startup does not require this key; legacy API-backed
  features remain unavailable without it. It is never an APTLSS fallback.
- `REDIS_URL`: authenticated Redis connection URL.

For Docker Compose, also set `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`,
`MYSQL_USER`, `MYSQL_PASSWORD`, and `REDIS_PASSWORD`. Do not commit `.env`.

The server accepts the old local names `TrelloAPIKey` and `TrelloAPIToken`
during transition, but production configuration should use the canonical
uppercase names.

`OPENAI_REQUEST_TIMEOUT_MS` is optional. It defaults to 120 seconds and is
capped at five minutes so an unavailable provider cannot hold operator work
indefinitely.

## APTLSS subscription review

APTLSS defaults to `APTLSS_MANAGER_PROVIDER=codex-subscription`, which uses the
official Codex CLI authenticated through ChatGPT on a separately running host
runner. It begins with Luna low and escalates only as needed to medium or high.
There is no OpenAI API fallback. If the host runner or subscription is
unavailable, deterministic checks remain available and the semantic review is
reported as unavailable.

The host runner must stay online and authenticated. For the shadow-pilot
deployment, provide `APTLSS_CODEX_QUEUE_DIR` in the app and mount only the
private transport queue using `deployment/codex-subscription.yml`; never mount
the Codex home directory, authentication files, or runner working directory.
Set `APTLSS_MANAGER_PILOT_WORKER_IDS` to exactly one explicitly selected
numeric worker ID. An empty allowlist keeps the manager disabled. The pilot is
shadow-only and does not send messages or mutate Trello.

## Optional Integrations

- `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, and
  `NOTIFICATIONS_ENABLED=true` enable outbound email notifications and
  automated Trello comments.
- `TRELLO_WEBHOOK_CALLBACK_URL` and `TRELLO_WEBHOOK_SECRET` enable verified
  Trello push updates after a public HTTPS domain exists.
- `SCHEDULED_TASK_SECRET` protects explicitly exposed scheduled-task routes.
- Founder decision deadline alerts require migration `0049` before starting the
  updated server. They persist only in the admin's in-app notification history;
  `FOUNDER_DECISION_ALERTS_ENABLED=false` disables the periodic scan. They do
  not send email or perform Trello actions.

Do not migrate the legacy MongoDB URL, Twilio credentials, React frontend URL,
or old reminder timing variables. They belong to the retired split
application, not the consolidated runtime.

## Verification Gate

Before traffic is moved:

1. Back up the source database.
2. Deploy MySQL and Redis with persistent storage.
3. Apply the canonical Drizzle migrations. Docker Compose runs the one-shot
   `migrate` service and starts the app only after it succeeds.
4. Start the application with `NODE_ENV=production`, `HOST=0.0.0.0`, and
   `LOCAL_AUTH_BYPASS=false`.
5. Confirm `/api/health`, authenticated founder/admin/worker access,
   WebSockets, scheduled jobs, Trello, Gmail, Drive, and other required legacy
   platform AI features. Separately verify the Codex host runner and
   APTLSS subscription review without enabling active plan changes.
6. Confirm no unapproved Trello comment, move, email, or other external action
   occurs during smoke testing.
7. Point the public domain and Trello webhook callback at the new runtime.
8. Retain the prior build and database snapshot through the rollback window.

The canonical role enum is currently `admin`, `worker`, and `user`. The founder
portal uses an admin-role account with founder-owned worker-profile scoping;
it is not a fourth, independently permissioned founder role. Verify the actual
ownership boundary and wrong-role rejection, and do not describe a separate
founder login as proof of distinct founder/admin privileges. If deployment
requires founder accounts without global administrative access, that remains
an explicit authorization-model change before those accounts are provisioned.

The configured candidate has an isolated HTTPS/MySQL/authenticated-Redis
rehearsal, including real signed-cookie logins, wrong-role and cross-site
rejection, WebSocket authentication/origin/worker-room checks, compiled role
pages and existing-session survival through an application restart. The Redis
recovery candidate also recovers after an observed 45-second Redis outage.
The subsequent cold-start candidate preserves sockets when Redis is missing
at startup, restores actual cross-process worker-room delivery when Redis returns,
and shuts down normally with Redis unavailable. Application publications are
not queued for replay; only fixed internal subscriber registrations wait for Redis.
See [the rehearsal guide](PRODUCTION_RUNTIME_REHEARSAL.md) and the dated
verification dossier for exact image/report identities. Self-signed fixture TLS,
synthetic accounts and disabled external jobs do not prove live providers,
public TLS, scheduled-job delivery or a full-data application rollback.

Before reusing an existing database volume, create a logical SQL backup and
keep the previous stopped database container until the public verification
gate passes. `MYSQL_VOLUME_NAME` selects the preserved volume explicitly.

For the established Windows operational database, use
`node scripts/aptlss-pilot-backup.mjs --native`. Docker-exec dumping is deliberately
refused: terminating its Windows CLI does not prove that the remote dump stopped.
The native producer is awaited and terminated on timeout or stream failure. It
uses an exclusive output file, a one-hour deadline and a 12 GiB free-space reserve,
checked throughout the stream. Failed SQL files remain for inspection and never
receive a successful manifest. Successful output is flushed, checked for its final
completion marker and recorded with its SHA-256, duration, source migration
identities and the observed rollback image. Credentials are passed only to the
native client's environment; unrelated provider secrets are not inherited.

The source must be the known loopback database on port 3307, with InnoDB tables.
Normal writes continue under mysqldump's single-transaction snapshot. Do not run
DDL or migrations during the backup. The before/after table-name and migration
inventories detect inventory changes but cannot prove that an untracked ALTER or
an alteration followed by reversal did not occur. A later source row count is
not the same snapshot as the dump and must not be presented as exact preservation
proof. Compare original records within the isolated restored snapshot instead.

Record-preservation fingerprints now stream table rows in a read-only transaction
and retain only per-row digests, with the existing checkpoint format unchanged.
They are not backups. The native restore utility now checks SQL files in 64 KiB
chunks and rechecks the same open file during import. It requires the isolated
server on loopback port 33317 to have `event_scheduler=DISABLED` at startup and
requires complete event visibility. `OFF` is insufficient because imported SQL
could re-enable it. Native client commands, login-path defaults, local file loading
and automatic reconnection are disabled. Import has a 30-minute timeout.
Before creating the isolated database, restore requires free disk space at least
equal to the SQL file's size plus a 12 GiB reserve. It rechecks that reserve
before input, at bounded stream intervals, every second while the client is
active (including input backpressure), and after successful client exit.
A resource failure terminates and awaits only the owned native client, prevents
acceptance, and retains the partial isolated database. It never clears other
backups or databases to make space. This guard assumes the owned native data
directory and backup directory are on the same filesystem; verify that placement.

Any restored event definition prevents acceptance, even though it cannot execute
on that server. Failed restores remain available for inspection; they are not
silently deleted or retried over an existing database. Checkpoint capture accepts
an optional JSON filename directly under `.local/pilot`; use a new name for each
rehearsal. Preservation reports are timestamped and never overwrite older proof.
For a current backup, set `APTLSS_REHEARSAL_SOURCE_MANIFEST` to its manifest
basename when running the native migration assertions. This uses the backup's
captured source identities rather than overwriting the September 5 ledger.
The restored/fresh rerun checks allow up to 30 minutes only when that current
manifest is explicitly supplied, because they hash every row twice. Ordinary
historical checks retain their original 60-second deadline.

The native assertions now cover the current lineage through 0052, including
generated review columns. An isolated restore of the 12.5 MB September 5 backup
and subsequent migration/preservation checks passed. This is historical-data
regression evidence, not proof that today's multi-gigabyte production database
can be restored within the rollback window. That current-size rehearsal remains
mandatory before cutover.

On a current-size restore, generated-column verification uses bounded indexed
keyset batches rather than one unbounded aggregate over the complete JSON history.
Each stored generated value is compared with its checked-in canonical expression
for every record. Coverage must equal the transaction's inventory; mismatches,
missing records, invalid cursors and bounded query failures prevent acceptance.
This is not sampling and does not replace whole-table schema/data/ledger
fingerprints before and after an idempotent migration rerun. Retain failed
rehearsal reports as well as the final passing report.

The current operational backup captured on 2026-09-30 contains 14,441,189,811
bytes and 53 source migration identities, and completed in 1,417,893 ms.
Its verified SHA-256 is
`704bd569e39d4ab2cc81ff9c6a5239e04964e301830735a18f15d78c80b81325`.
The isolated full-size restore subsequently completed in 1,684,982 ms with the
same hash and byte count and the scheduler still startup-DISABLED. This establishes
database restoration, not a measured application rollback. The subsequent
checkpoint comparison preserved all 94,674 original records across 132 data
tables, with their original selected columns. Schema and migration-rerun assertions
have their separate reports; they do not replace public application verification.
Retain the private manifest
`.local/pilot/backup-2026-09-30T23-45-47-073Z.json` and its SQL file locally;
do not include them in source exports or CI artifacts.

The new additive lineage through `0053_manager_history_checks` has separate
isolated SQL verification. The full-size restoration and preservation results
above are for the previous 53-identity lineage; they must not be relabeled as
proof for migration 0053. A subsequent October 1 rehearsal applied migration
0053 to the retained full-size restore and passed all 11 native assertions with
no failures or skips, including complete schema, record-digest and migration-ledger
preservation on rerun. Its separate receipt is
`artifacts/production-current-restore-history-0053-20261001.json`.
The restored ledger retains 56 historical identities; the clean canonical ledger
contains 54. These historical identities must not be removed to make the counts
equal. This is database migration proof, not full-data application rollback. See
[assessment history storage](APTLSS_HISTORY_STORAGE.md) for compatibility,
integrity checks and the required full-run materialization before rolling back
to an older binary. No historical full runs are deleted by this feature.

Only disconnect or delete the obsolete Vercel projects after this gate passes
against the public replacement.
