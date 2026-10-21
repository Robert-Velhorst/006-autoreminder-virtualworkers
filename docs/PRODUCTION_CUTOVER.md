# Production Cutover

## Target Runtime

The consolidated application requires a persistent Node.js container runtime,
PostgreSQL, HTTPS, and WebSocket support. Redis is optional and external. It also runs scheduled work inside
the application process. A static or request-only serverless deployment does
not preserve the complete runtime contract.

Use `Dockerfile` and `docker-compose.yml` for deployment on the Hetzner host.
Compose runs only one application container; PostgreSQL and optional Redis must
be provisioned separately. Put the application behind the host's HTTPS reverse proxy and point the
production DNS name and Trello callback at that stable domain. Keep one
application instance active until scheduled-job locking has been verified on
the target platform. The application port binds to loopback. Do not expose the
database or cache publicly; use a private network or loopback-bound host services.
Public password registration is disabled; existing workers authenticate with
their registered Trello identity or a separately provisioned local password.

Set `PUBLIC_URL`, `APP_URL`, and `VITE_FRONTEND_URL` in the same
`/opt/va-dashboard/.env` file passed to `docker compose --env-file`. All three
must be the public HTTPS origin (for example `https://dashboard.example.com`),
without a trailing path; do not leave the localhost defaults from `.env.example`
in production. Compose uses `PUBLIC_URL` and `TRELLO_WEBHOOK_CALLBACK_URL` for
origin and callback configuration, so both must also be present in that file.
If Trello webhooks are enabled, set `TRELLO_WEBHOOK_CALLBACK_URL` to the exact
URL `https://dashboard.example.com/api/trello-webhook` and configure
`TRELLO_WEBHOOK_SECRET`. Keep the callback unset if webhooks are not deliberately
enabled. Production startup rejects missing, non-HTTPS, or mismatched public
origins and rejects a webhook callback that does not match the public origin and
exact callback path. It also rejects a callback configured without its signing
secret, or a signing secret configured without the callback.

## Release and Deployment Gate

Production deployment is started manually from protected `main`. The selected
release must be a published stable `vMAJOR.MINOR.PATCH` tag whose commit is
contained in `main`. The workflow verifies the GHCR image's provenance against
that exact source commit before connecting to the host. The GitHub `production`
environment requires Robert Velhorst as reviewer and allows him to approve his
own deployment. The administrator bypass remains enabled as an explicit
emergency recovery path; administrators can therefore override the configured
deployment protection. Use that bypass only when the normal deployment gate is
unavailable and record the reason. Deployments remain restricted to protected
branches, and the workflow validates these settings before it starts the
production job.

Configure these four GitHub Actions secrets on the `production` environment;
they are SSH transport credentials and are separate from the application's
runtime `.env` on the host:

- `HETZNER_SSH_HOST`: server DNS name or IPv4 address on SSH port 22.
- `HETZNER_SSH_USER`: dedicated, least-privilege deployment account.
- `HETZNER_SSH_PRIVATE_KEY`: private key for that account; never commit it or
  paste it into a pull request or chat.
- `HETZNER_SSH_KNOWN_HOSTS`: verified host-key line for the server.

The deploy workflow does not provision the host or create `/opt/va-dashboard/.env`.
Prepare that directory, the runtime environment file, Docker, HTTPS reverse
proxy, persistent PostgreSQL, backups, and SSH account before dispatching a
deployment. Do not proceed if host identity or the database restore path has
not been verified.

The former hosting projects and GitHub integration were retired at the owner's
request before production cutover. Do not recreate or reconnect them as a
deployment target: a request-only deployment would omit the persistent process,
scheduled work, and WebSocket runtime required by the platform. Production
startup rejects the request-only runtime explicitly so an incomplete frontend cannot
be mistaken for an operational deployment.

## Required Secrets

Configure these values in the deployment platform's secret store:

- `DATABASE_URL`: PostgreSQL connection URL for the Hetzner runtime.
- `JWT_SECRET`: newly generated random value of at least 32 characters.
- `TRELLO_API_KEY`: active Trello API key.
- `TRELLO_TOKEN`: active Trello member token.

Set `DATABASE_URL` in `.env` to the separately provisioned PostgreSQL service.
For PostgreSQL installed on the Docker host, use `host.docker.internal`; for
production, use private networking and add one `sslmode=verify-full` option to
the URL without an `ssl` override. Node.js then verifies the certificate and
hostname using its TLS trust configuration. Set `REDIS_URL` only
when an external Redis service is configured. Do not commit `.env`.

**The approved production PostgreSQL target and VA Dashboard database have not
been confirmed for this application.** The owner intends to consolidate their
GitHub tools on a shared open-source PostgreSQL service. Confirm that intended
service before provisioning another one; lack of configuration in this repo is
not evidence that no shared service exists elsewhere. Verify private network
access, TLS, automated backups, and tested recovery. Create or verify a separate VA
Dashboard database and least-privilege role; other apps must have separate
databases and credentials. No legacy data source or import plan has been
identified. Apply this app's migrations to the new database, then test backup,
restore, application behavior, and the live Hetzner runtime. Do not run a
legacy transfer unless an actual source containing VA Dashboard data is
identified and its import is explicitly approved.

### MySQL-to-PostgreSQL Transfer Rehearsal (Conditional)

This procedure is retained for a possible future use only. It is not applicable
to the new PostgreSQL installation unless an actual MySQL source containing VA
Dashboard data is identified and an import is explicitly approved.

Use a trusted operator shell, not the app container. Configure
`LEGACY_MYSQL_DATABASE_URL` with a read-only MySQL account and `DATABASE_URL`
with the empty PostgreSQL target that has already received the Drizzle
migrations. Do not put the legacy URL in the app's runtime secret set.

```powershell
$env:LEGACY_MYSQL_DATABASE_URL = 'mysql://readonly_user:<url-encoded-password>@legacy-host:3306/legacy_database'
$env:DATABASE_URL = 'postgresql://migration_user:<url-encoded-password>@postgres-host:5432/va_dashboard'
pnpm db:migrate
pnpm db:migrate:mysql-to-postgres preflight
```

Preflight is read-only. It requires matching source/target tables, columns, and
primary keys; InnoDB source tables; an empty PostgreSQL application schema; and
only the three explicitly recognized PostgreSQL-only tables. Fix every
reported mismatch before proceeding. Take and restore-test a source backup
first, then rehearse against that restored copy.

The transfer sets the MySQL session timezone to UTC before opening its
consistent snapshot. MySQL `TIMESTAMP` values are therefore read in UTC and
stored as UTC wall-clock values in the PostgreSQL schema's `timestamp without
time zone` columns. `DATETIME` and `DATE` values retain their stored wall-clock
or calendar values. Before cutover, confirm that application code and reports
interpret these timestamp columns consistently; do not apply an additional
timezone conversion to the imported rows.

For the rehearsed cutover only, stop app writes to the target and run:

```powershell
pnpm db:migrate:mysql-to-postgres copy --execute
```

The copy holds one PostgreSQL transaction, locks target application tables,
reads the source from a consistent read-only snapshot, and rolls back all target
rows if a copy or reconciliation check fails. It rejects MySQL zero-dates and
unsupported boolean values instead of guessing. Each copied table is checked
for exact row count and a normalized SHA-256 digest of every row. Save the
resulting report with the cutover record; it contains counts and hashes, not
credentials. Keep the source and its backups intact through the rollback
window. This command has not been accepted against the real source yet.

The server accepts the old local names `TrelloAPIKey` and `TrelloAPIToken`
during transition, but production configuration should use the canonical
uppercase names.

## Optional Integrations

- AI provider API keys are optional and are not enabled by default. The
  self-hosted server does not currently authenticate with Codex subscription
  credentials; do not assume subscription-backed AI is available in Hetzner.
  AI-dependent features are not part of the production acceptance gate unless
  an explicitly supported provider is configured and its behavior is verified.
- `REDIS_URL` is optional and enables shared cache/realtime coordination when
  an external Redis service is provisioned.
- `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, and
  `NOTIFICATIONS_ENABLED=true` explicitly enables outbound email and automated Trello-comment notifications. Notifications remain disabled when unset or set to any other value, including in production.
- `TRELLO_WEBHOOK_CALLBACK_URL` and `TRELLO_WEBHOOK_SECRET` enable verified
  Trello push updates after a public HTTPS domain exists. Set the callback to
  the exact `https://<domain>/api/trello-webhook` URL. The secret is the Trello
  app secret used to verify `X-Trello-Webhook`; unsigned callbacks are rejected.
  Webhook registration, deletion, manual comments, and check-ins require an admin.
- `SCHEDULED_TASK_SECRET` protects explicitly exposed scheduled-task routes.

Do not migrate legacy database URLs, Twilio credentials, the old frontend URL,
or old reminder timing variables. They belong to the retired split
application, not the consolidated runtime.

## Verification Gate

Before the first production traffic is enabled:

1. Provision the shared PostgreSQL service with persistent storage, private
   network access, TLS, automated backups, and a tested restore procedure.
   Create a dedicated VA Dashboard database and least-privilege role; never
   reuse another app's role or database.
2. Apply the PostgreSQL Drizzle migrations from a trusted administration
   environment using `pnpm db:migrate`; Compose does not start a migration container.
3. Do not transfer legacy data unless an actual source containing VA Dashboard
   data is identified and its import is approved. If the source is confirmed as
   MySQL, follow the conditional rehearsal below; otherwise design and review a
   source-specific transfer before touching data.
4. For a fresh/no-import target, follow [Owner Provisioning](OWNER_PROVISIONING.md)
   after migrations. `pnpm owner:provision` defaults to dry run and prepares a
   pending owner; it does not create a worker profile. Start the application
   behind restricted access, finish the one-time owner setup, and verify the
   resulting founder account before inviting workers or enabling traffic.
   Do not rely on public registration: production rejects `/api/auth/register`.
   For an approved import, verify that imported accounts and required worker
   profiles are present and usable. Verify founder/admin/worker role boundaries
   without local auth bypass, retaining only redacted evidence. Keep general
   production traffic disabled until this bootstrap/import check succeeds.
5. Test the PostgreSQL backup and restore, verify sequences and app read/write
   behavior, and document the exact rollback point before any traffic move.
6. Start the application with `NODE_ENV=production`, `HOST=0.0.0.0`, and
   `LOCAL_AUTH_BYPASS=false`.
7. Confirm the public origin variables resolve to the stable HTTPS domain and,
   when enabled, the Trello callback is the exact configured HTTPS URL.
8. Confirm `/api/health` and `/api/health/ready` report healthy only after the
   current PostgreSQL migration is applied; confirm `/api/health/live` remains
   independent of database availability. Then verify authenticated
   founder/admin/worker access, WebSockets, scheduled jobs, Trello, and each
   optional integration deliberately configured for production. Do not mark an
   unconfigured integration as verified or treat an unavailable optional
   integration as a successful smoke test.
9. Confirm no unapproved Trello comment, move, email, or other external action
   occurs during smoke testing.
10. Point the public domain and Trello webhook callback at the new runtime.
11. Retain tested database backups and the prior build through the rollback
    window. If data was imported, retain its source through acceptance.

Compose does not provision or alter database storage. Keep verified database
backups through the public verification gate and rollback window.

The former hosting projects were removed before this gate passed. That removal
does not constitute a production cutover or acceptance of the Hetzner runtime;
complete every migration, deployment, and rollback check above before moving
production traffic.
