# VA Dashboard

VA Dashboard is a self-hosted operations workspace for coordinating virtual-worker tasks. It brings task planning, evidence, decisions, reminders, time tracking, and supervised Trello workflows into one application.

The application has two main surfaces:

- **Worker workspace** for a profile-scoped task queue, daily plan, decisions, evidence, reminders, and time tracking.
- **Operator workspace** for worker and schedule administration, APTLSS assessments, oversight, and platform settings.

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | Admin | Developer administration dashboard |
| `/founder` | Admin | Founder and worker management |
| `/aptlss` | Admin | APTLSS management |
| `/settings` | Admin | Platform settings |
| `/calendar` | Admin | Calendar |
| `/advanced-scheduling` | Admin | Advanced scheduling |
| `/atis-phases` | Admin | ATIS analysis |
| `/robert` | Admin | Oversight |
| `/command-center` | Admin | Priority command center |
| `/admin` | Admin | System monitor |
| `/worker` | Worker | Profile-scoped queue and current work |
| `/worker/plan` | Worker | Daily time blocks |
| `/worker/decisions` | Worker | Decision inbox and recorded outcomes |
| `/worker/evidence` | Worker | Evidence and integration state |

This repository is actively developed. A versioned container image and tagged release are produced only by the GitHub Release workflow after its verification gates pass. The project does not currently provide a hosted production service.

## Current Status

- The application uses a persistent Node.js process and PostgreSQL; Redis is optional.
- Docker Compose is the supported single-host deployment path.
- Trello, email, Google evidence, and AI-provider integrations require credentials supplied by the operator.
- External actions such as Trello changes and outbound messages are policy-gated; configure and verify integrations before enabling them.
- Production readiness depends on deployment-specific configuration and operational checks. A successful build or container publication is not proof of a live production deployment.

## Requirements

- Docker Engine and Docker Compose v2 for the application container.
- Node.js 26.11.1 and pnpm 12.13.0 for development outside Docker.
- A separately provisioned PostgreSQL database. Redis is optional and external.

## Quick Start: Docker Compose

1. Clone the repository and enter its directory.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL` for a separately
   provisioned PostgreSQL database and configure required Trello and session
   secrets. Generate a unique `JWT_SECRET` of at least 32 characters. Do not
   commit `.env`.
3. Apply database migrations from a trusted operator environment:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm db:migrate
   ```

4. Build and start the single application container:

   ```powershell
   docker compose --env-file .env up -d --build
   ```

5. Open `http://127.0.0.1:3025/worker` and verify the health endpoint at
   `http://127.0.0.1:3025/api/health`.

Compose starts only the application. It does not provision PostgreSQL/Redis or
run migrations at startup. Keep database and cache endpoints private; never
expose them directly to the public internet.

To stop the application container:

```powershell
docker compose --env-file .env down
```

## Development

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

The development server uses `DATABASE_URL` from `.env`. Provision PostgreSQL
separately and configure `REDIS_URL` only when a Redis service is available.
Keep production credentials out of local development files and never commit
environment files.

The canonical migration lineage continues through `0027_glorious_epoch`. Consolidated migrations are additive and include task assignments/schedules, evidence foundations, schema parity repairs, and worker-scoped operator data. See [the consolidation ledger](docs/CONSOLIDATION_LEDGER.md) for migration ownership and compatibility decisions.

Useful checks:

```powershell
pnpm check
pnpm test
pnpm build
pnpm test:e2e
```

## Deployment

The full application needs a persistent container runtime with HTTPS and WebSocket support. It also runs scheduled work in the application process. Request-only serverless platforms are not supported and must not be presented as the production service.

`Dockerfile` builds the application image. `docker-compose.yml` runs only the application container; PostgreSQL and optional Redis are external services. This keeps the Docker footprint to one VA Dashboard container. Run database migrations explicitly from a trusted administration environment with `pnpm db:migrate` before deploying the corresponding application version. For Hetzner production, use a dedicated PostgreSQL role and secret-managed connection string. Route the stable production domain through the host's HTTPS reverse proxy. The repository does not provide a public tunnel launcher.

See [Production Cutover](docs/PRODUCTION_CUTOVER.md) before deploying. It lists required credentials, data backup and migration steps, integration checks, rollback requirements, and the boundary for retiring the old hosting projects. Configure secrets in the target platform's secret manager; do not put them in source control, image layers, release notes, or issue comments.

The GitHub Release workflow publishes a versioned image to `ghcr.io/robert-velhorst/006-autoreminder-virtualworkers` after a release is published. It does not deploy that image to a live host. An operator must configure the runtime, persistent storage, secrets, networking, and backups separately.

## Authentication and Access

Production authentication uses registered accounts and role-based access controls. `LOCAL_AUTH_BYPASS` is for loopback development only; the server refuses that mode in production or on a non-loopback host. Do not expose the dashboard publicly until authentication, account recovery, role boundaries, HTTPS, and integration scopes have been reviewed for the target deployment.

## Integrations and Data

The application stores operational data in PostgreSQL. Redis is used for shared cache and realtime coordination when configured. Trello and other providers require separately provisioned credentials. Follow least privilege when creating provider accounts and tokens, and rotate any credential that has entered source control or an untrusted log.

The operator transfer tools and data ownership rules are described in the [consolidation ledger](docs/CONSOLIDATION_LEDGER.md). The owner intends to consolidate their GitHub tools on a shared open-source PostgreSQL service. The VA Dashboard production database has not yet been provisioned. Each app must have its own database and least-privilege role; the service is shared, not app credentials or data. After provisioning, apply the PostgreSQL migrations and verify backup/restore. The repository also retains a MySQL-to-PostgreSQL transfer command, `pnpm db:migrate:mysql-to-postgres`, with read-only `preflight` and explicit `copy --execute` operations plus per-table row-count and SHA-256 reconciliation. This tool is not a runtime backend and must only be used if an actual source containing VA Dashboard data is identified and an import is approved. No legacy source or import plan is currently identified. Application runtime targets PostgreSQL.

## Security

Please do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for supported-version and private-reporting guidance. Secret scanning, push protection, dependency alerts, automated security updates, code scanning, and protected `main` checks are enabled or configured at the repository level; verify their current state in GitHub before relying on them.

## Project Documentation

- [Production cutover and operations](docs/PRODUCTION_CUTOVER.md)
- [Consolidation ledger and data ownership](docs/CONSOLIDATION_LEDGER.md)
- [Branch consolidation history](docs/BRANCH_CONSOLIDATION.md)
- [Environment variable template](.env.example)

## License

MIT. See [LICENSE](LICENSE).

## APTLSS shadow-pilot source integration

The manager, evidence and reminder features are being reconciled with the canonical PostgreSQL runtime. See [PR99 integration](docs/PR99_INTEGRATION.md) for source changes and acceptance boundaries. Historical MySQL deployment and pilot verification documents do not establish current PostgreSQL or provider acceptance.
