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

## Deploy a published release to Hetzner

The repository has a manual GitHub Actions workflow named **Deploy to Hetzner**. It accepts stable `vMAJOR.MINOR.PATCH` releases only, verifies the image's GitHub provenance, deploys the immutable GHCR digest, and restores the previous application image if the new container does not become healthy. It does not run database migrations or change application secrets.

Bootstrap the host before using the workflow:

1. Provision Docker Engine and the Compose plugin, then create `/opt/va-dashboard` owned by a dedicated deployment account that can run Docker. This account has control of the host through Docker; restrict its SSH key and access accordingly.
2. Put the production `.env` at `/opt/va-dashboard/.env`, set its permissions to `0600`, and configure the verified PostgreSQL URL, application secrets, and integrations. The deploy workflow never reads or transfers this file.
3. Configure a stable HTTPS reverse proxy to the Compose loopback port. The published port is derived from `PORT` in the host `.env`; do not expose it publicly.
4. Protect the `main` branch. In GitHub, create a `production` environment with at least one required reviewer and restrict deployments to protected branches. This repository allows the deployment initiator to approve their own deployment, as configured for its single-owner workflow; this is not an independent second-person approval. The workflow's preflight fails unless the reviewer and protected-branch rules exist and dispatch runs from `main`. Add these environment secrets: `HETZNER_SSH_HOST` (DNS name or IPv4, standard SSH port 22), `HETZNER_SSH_USER`, `HETZNER_SSH_PRIVATE_KEY`, and `HETZNER_SSH_KNOWN_HOSTS`. The last secret must contain the host key obtained and verified through a trusted channel; the workflow does not use unauthenticated `ssh-keyscan`.
5. Before dispatching a release, take and verify the PostgreSQL backup, apply that release's PostgreSQL migrations from a trusted administration environment, and confirm the rollback point. The workflow rolls back the application image only; it cannot reverse a database migration.
6. From the protected `main` branch, start **Deploy to Hetzner** with a stable published release tag and explicitly select `deploy`. GitHub's `production` environment approval is an additional gate. The current `v1.0.0-rc.1` release is a prerelease and is rejected.

The deployment workflow uses one Compose service. Before replacing it, the host pins the running container's exact image ID under a local rollback tag; rollback uses that tag without pulling a mutable registry tag and checks the restored container's health. If the first deployment fails, its application container is removed because there is no previous version to restore. Rollback tags and other old images are intentionally retained for recovery and are not automatically pruned. The workflow does not remove database data.

## PostgreSQL migration status

The PostgreSQL schema and migration lineage are in `drizzle/schema.postgres.ts` and `drizzle-postgres-v1/`. Do not run the legacy MySQL migration lineage against PostgreSQL. The dedicated whole-database transfer command is `pnpm db:migrate:mysql-to-postgres`; it provides a read-only preflight and an explicit `copy --execute` operation with per-table row-count and normalized SHA-256 reconciliation. The tool has not yet been rehearsed against the actual legacy source or a restored production backup. Backup/restore, repeatability, rollback, and live Hetzner acceptance remain required before production data cutover. See [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md).

## Operations

- Health endpoint: `/api/health`
- Apply migrations as a separate, reviewed deployment step before starting a release that depends on them.
- Back up PostgreSQL using the provider-supported process and periodically test restore into an isolated database.
- Keep secrets out of Git, container build arguments, and logs.
- For local-only development, `LOCAL_AUTH_BYPASS` must remain disabled in production.
