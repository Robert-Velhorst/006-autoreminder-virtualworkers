# Deployment

This repository deploys the VA Dashboard as one application container. PostgreSQL and optional Redis are external services; Docker Compose does not create database, cache, or migration containers.

## Prerequisites

- Docker Engine and Docker Compose plugin
- A reachable PostgreSQL database, with network access restricted to the app host
- A secret-managed `.env` file containing the application settings and `DATABASE_URL`
- A stable HTTPS domain and reverse proxy for production

The application currently runs on PostgreSQL. The old MySQL schema and transfer utility are retained only for legacy-source inspection and migration work; they are not supported runtime backends.

## Deploy with Compose

1. Prepare PostgreSQL and a least-privilege application role. Do not expose the database publicly.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, authentication secrets, and the integrations you actually enable. For a database on the Docker host, use `host.docker.internal` in the URL; on Linux Compose maps that name to the host gateway. Production PostgreSQL must use one `sslmode=verify-full` option with no `ssl` override so Node.js verifies both certificate and hostname.
3. From a trusted administration environment with the PostgreSQL URL configured, apply the checked-in PostgreSQL migrations:

   ```sh
   pnpm install --frozen-lockfile
   pnpm db:migrate
   ```

4. Build and start the single application container:

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   ```

5. Configure exactly one trusted host reverse proxy to the loopback-published app port. It must replace `X-Forwarded-Proto` with the actual external scheme and append the actual client address to `X-Forwarded-For`; the app trusts one proxy hop for client IP and secure-cookie decisions. Confirm HTTPS, WebSockets, authentication, database access, and provider integrations before inviting workers.

Compose binds the application to `127.0.0.1` by default. Do not publish it directly to the public network. `docker compose down` stops the app without touching PostgreSQL or Redis data.

For a fresh database, also follow [first-owner provisioning](docs/OWNER_PROVISIONING.md) from the trusted administration environment. Preview before executing and complete the one-time owner setup UI before inviting workers. Provisioning does not create a worker profile or enable public registration.

## Deploy a published release to Hetzner

The repository has a manual GitHub Actions workflow named **Deploy to Hetzner**. It accepts stable `vMAJOR.MINOR.PATCH` releases only, verifies the image's GitHub provenance, deploys the immutable GHCR digest, and restores the previous application image if the new container does not become healthy. It does not run database migrations or change application secrets.

Bootstrap the host before using the workflow:

1. Provision Docker Engine and the Compose plugin, then install the [restricted SSH deployment gate](deployment/hetzner/SSH_GATE.md) from reviewed source using a dedicated public key. The account is `va-dashboard-deploy`, without Docker-group membership or a general shell/sudo grant. `/opt/va-dashboard` and the installed deployment code remain root-owned; only `/var/lib/va-dashboard-deploy` is writable through this account's staging command.
2. Put the production `.env` at `/opt/va-dashboard/.env`, set its permissions to `0600`, and configure the verified PostgreSQL URL, application secrets, and integrations. The deploy workflow never reads or transfers this file.
3. Configure a stable HTTPS reverse proxy to the Compose loopback port. The published port is derived from `PORT` in the host `.env`; do not expose it publicly.
4. Protect the `main` branch. In GitHub, create a `production` environment with at least one required reviewer and restrict deployments to protected branches. This repository allows the deployment initiator to approve their own deployment, as configured for its single-owner workflow; this is not an independent second-person approval. The workflow's preflight fails unless the reviewer and protected-branch rules exist and dispatch runs from `main`. Add these environment secrets: `HETZNER_SSH_HOST` (DNS name or IPv4, standard SSH port 22), `HETZNER_SSH_USER`, `HETZNER_SSH_PRIVATE_KEY`, and `HETZNER_SSH_KNOWN_HOSTS`. The last secret must contain the host key obtained and verified through a trusted channel; the workflow does not use unauthenticated `ssh-keyscan`.
5. Before dispatching a release, take and verify the PostgreSQL backup, apply that release's PostgreSQL migrations from a trusted administration environment, and confirm the rollback point. The workflow rolls back the application image only; it cannot reverse a database migration.
6. From the protected `main` branch, start **Deploy to Hetzner** with a stable published release tag and explicitly select `deploy`. GitHub's `production` environment approval is an additional gate. The current `v1.0.0-rc.1` release is a prerelease and is rejected.

The deployment workflow uses one Compose service. Before replacing it, the host pins the running container's exact image ID under a local rollback tag; rollback uses that tag without pulling a mutable registry tag and checks the restored container's health. If the first deployment fails, its application container is removed because there is no previous version to restore. Rollback tags and other old images are intentionally retained for recovery and are not automatically pruned. The workflow does not remove database data.

The SSH workflow stages Compose bytes and requests an immutable digest; it never
uploads executable shell code. A root-owned helper accepts only the fixed VA
repository digest format and verifies staged Compose against the root-installed
canonical file before invoking the installed, hash-pinned `deploy.sh`. A changed
Compose or deploy script requires a separate administrator-reviewed installation.
`va-dashboard-status` reports connection/configuration readiness without reading
runtime secret values or claiming application, DNS or TLS acceptance.

## PostgreSQL database and legacy transfer status

The PostgreSQL schema and migration lineage are in `drizzle/schema.postgres.ts` and `drizzle-postgres-v1/`. The owner intends to consolidate their GitHub tools on a shared open-source PostgreSQL service. The VA Dashboard database has not yet been provisioned. Use a separate database and least-privilege role for each app; do not share app credentials or data. Apply this app's migrations with `pnpm db:migrate` after provisioning its database. The legacy MySQL migration lineage is not a runtime backend. The dedicated transfer command `pnpm db:migrate:mysql-to-postgres` is conditional: use it only if an actual source containing VA Dashboard data is identified and an import is approved. Its presence is not evidence of a MySQL production source. Backup/restore, repeatability, rollback, and live Hetzner acceptance remain required before production acceptance. See [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md).

## Operations

- Container health endpoint: `/api/health`; it returns unhealthy when the
  PostgreSQL connection or required migration version is unavailable.
- Readiness endpoint: `/api/health/ready`; use it before routing traffic. Its
  bounded database probe checks that the current canonical migration has been
  applied.
- Liveness endpoint: `/api/health/live`; it reports process liveness without
  depending on PostgreSQL, so a database outage does not trigger a restart loop.
- Apply migrations as a separate, reviewed deployment step before starting a release that depends on them.
- Back up PostgreSQL using the provider-supported process and periodically test restore into an isolated database.
- Keep secrets out of Git, container build arguments, and logs.
- For local-only development, `LOCAL_AUTH_BYPASS` must remain disabled in production.
