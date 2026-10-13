# Production Cutover

## Target Runtime: Hetzner

The consolidated application requires a persistent Node.js container runtime,
MySQL, Redis, HTTPS, and WebSocket support. It also runs scheduled work inside
the application process. A static or request-only serverless deployment does
not preserve the complete runtime contract.

Hetzner is the selected target. Use `deployment/compose.hetzner.yml` on a
single Hetzner server with persistent storage and a host-level TLS reverse
proxy. The application is not yet deployed to Hetzner. Keep exactly one app
instance active until scheduled-job locking has been verified on the target
host.

The production images are published to GHCR when a GitHub release is
published. The release workflow publishes both the app image and a
migration-capable image tagged with the same release plus `-migrate`. Pin both
to the same release version (or verified digest); do not build the production
image from an unreviewed working tree on the server.

The already-published `v1.0.0-rc.1` predates the migration-image workflow and
has no corresponding `v1.0.0-rc.1-migrate` image. Do not use that prerelease
for the Hetzner Compose deployment. Verify both app and migration image
attestations for a later release before pulling either image.

`pnpm docker:public` is a local testing helper that starts ngrok. It is not a
production entrypoint. Production ingress terminates HTTPS at the host proxy
and forwards app and WebSocket traffic to loopback port 3025. MySQL and Redis
remain private to the Compose network.

Public password registration is disabled; workers authenticate with their
registered Trello identity or a separately provisioned local password.
Do not use request-only serverless hosting: scheduled work, Redis coordination,
and WebSockets require a persistent process.

## Required Secrets

Keep application secrets in the ignored `deployment/.env.app` file with
restrictive permissions, or inject them from a secret manager. Copy
`deployment/.env.app.example` to that file. Copy
`deployment/.env.hetzner.example` to the ignored `deployment/.env.hetzner`
for Compose and database/Redis settings. Never commit populated files or pass
secrets as image build arguments.

- `JWT_SECRET`: newly generated random value of at least 32 characters.
- `TRELLO_API_KEY`: active Trello API key.
- `TRELLO_TOKEN`: active Trello member token.

For Hetzner Compose, set `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_USER`,
`MYSQL_PASSWORD`, `REDIS_PASSWORD`, `DATABASE_URL`, and `REDIS_URL` in
`deployment/.env.hetzner`. `APP_ENV_FILE` defaults to `.env.app`, relative to
the Compose file. Set `APP_IMAGE` and `MIGRATION_IMAGE` to the same release
version, with `-migrate` on the latter. Use the `mysql` and `redis` Compose
hostnames in the respective URLs. URL-encode reserved characters in credentials.

The server accepts the old local names `TrelloAPIKey` and `TrelloAPIToken`
during transition, but production configuration should use the canonical
uppercase names.

AI provider credentials are not required for the server to start. AI-backed
features remain unavailable until a supported provider is configured in the
Settings UI or through its documented environment variable. This application
does not currently implement Codex subscription authentication; do not treat
an OpenAI API key as an equivalent subscription credential.

## Optional Integrations

- `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, and
  `NOTIFICATIONS_ENABLED=true` enable outbound email notifications.
- `TRELLO_WEBHOOK_CALLBACK_URL` and `TRELLO_WEBHOOK_SECRET` enable verified
  Trello push updates after a public HTTPS domain exists.
- `SCHEDULED_TASK_SECRET` protects explicitly exposed scheduled-task routes.

Do not migrate the legacy MongoDB URL, Twilio credentials, React frontend URL,
or old reminder timing variables. They belong to the retired split
application, not the consolidated runtime. Before production cutover, revoke
any credentials exposed by that retired application and resolve the related
secret-scanning alerts after rotation; removing a value from Git history does
not revoke it.

## Verification Gate

Before traffic is moved:

1. Back up the source database and rehearse its import into an isolated,
   disposable target database.
2. Deploy MySQL and Redis with persistent storage and verify a restorable
   backup before importing production data.
3. Copy both deployment templates to `deployment/.env.hetzner` and
   `deployment/.env.app`, replace all placeholders, and restrict file
   permissions. Run `docker compose --env-file deployment/.env.hetzner -f deployment/compose.hetzner.yml config -q` before starting any service.
4. Pull the pinned images with `docker compose --env-file deployment/.env.hetzner -f deployment/compose.hetzner.yml pull app migrate`, then start MySQL, Redis, the one-shot migration, and app with `docker compose --env-file deployment/.env.hetzner -f deployment/compose.hetzner.yml up -d`. The app starts only after migration succeeds.
5. Confirm the application runs with `NODE_ENV=production`, `HOST=0.0.0.0`, and
   `LOCAL_AUTH_BYPASS=false`.
6. Confirm `/api/health`, authenticated founder/admin/worker access,
   WebSockets, scheduled jobs, Trello, Gmail, and Drive. Test any explicitly
   enabled AI provider only after its configuration and account authorization
   have been verified.
7. Confirm no unapproved Trello comment, move, email, or other external action
   occurs during smoke testing.
8. Freeze writes briefly, take a final source-database backup, import and
   reconcile it, then switch the public domain and Trello webhook callback.
9. Retain the prior build and source snapshot through the rollback window.

Before reusing an existing database volume, create a logical SQL backup and
keep the previous stopped database container until the public verification
gate passes. `MYSQL_VOLUME_NAME` selects the preserved volume explicitly.

Retire the previous deployment only after the Hetzner deployment passes every
verification gate and the public domain serves the new host. Preserve
deployment history and rollback artifacts; do not remove infrastructure that
belongs to another application.

The Vercel GitHub App was uninstalled from Robert Velhorst's GitHub account on
2026-10-13, removing its access to all 43 repositories. All seven projects in
the Noodzakelijk Online Vercel team were deleted through the dashboard, which
also removed their deployments and project-level configuration. The Vercel
account itself remains. `promise-app` had the custom domain `promiseapp.io`;
DNS records at the domain provider were not inspected or changed. Verify and
update or remove those records during the Hetzner cutover. The Hetzner service
is not live yet, so Vercel deletion is not evidence of a completed production
migration. The Hetzner public acceptance gate remains outstanding.
