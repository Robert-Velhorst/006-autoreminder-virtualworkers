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

- The application uses a persistent Node.js process, MySQL, and optional Redis.
- Docker Compose is the supported single-host deployment path.
- Trello, email, Google evidence, and AI-provider integrations require credentials supplied by the operator.
- External actions such as Trello changes and outbound messages are policy-gated; configure and verify integrations before enabling them.
- Production readiness depends on deployment-specific configuration and operational checks. A successful build or container publication is not proof of a live production deployment.

## Requirements

- Docker Engine and Docker Compose v2 for the complete local stack.
- Node.js 24.21.0 LTS and pnpm 12.11.2 for development outside Docker.
- MySQL 9.7.2. Redis is included in the provided Compose stack.

## Quick Start: Docker Compose

1. Clone the repository and enter its directory.
2. Copy `.env.example` to `.env` and set the required application values. Generate a unique `JWT_SECRET` of at least 32 characters. Do not commit `.env`.
3. Create `.env.db.local` with the Docker-only settings below. Use unique strong passwords; these are examples of variable names, not values:

   ```dotenv
   MYSQL_ROOT_PASSWORD=<unique-strong-password>
   MYSQL_DATABASE=va_dashboard
   MYSQL_USER=va_dashboard
   MYSQL_PASSWORD=<different-unique-strong-password>
   REDIS_PASSWORD=<another-unique-strong-password>
   MYSQL_PORT=3307
   ```

4. Start the application and dependencies:

   ```powershell
   docker compose --env-file .env.db.local up -d --build
   ```

5. Open `http://127.0.0.1:3025/worker` and verify the health endpoint at `http://127.0.0.1:3025/api/health`.

Compose runs the canonical database migrations before starting the application. The database and Redis ports bind to loopback by default. Do not expose them directly to the public internet.

To stop the local stack while preserving its data:

```powershell
docker compose --env-file .env.db.local down
```

Do not add `-v` unless you intend to delete the database volumes.

## Development

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
docker compose --env-file .env.db.local up -d mysql redis
pnpm db:push
pnpm dev
```

For the development server, set `DATABASE_URL` in `.env` to the mapped MySQL port (3307 by default, or the value of `MYSQL_PORT`). The server uses its app configuration from `.env`; Compose reads its database and Redis credentials from `.env.db.local`. Keep production credentials out of local development files and never commit environment files.

The canonical migration lineage continues through `0027_glorious_epoch`. Consolidated migrations are additive and include task assignments/schedules, evidence foundations, schema parity repairs, and worker-scoped operator data. See [the consolidation ledger](docs/CONSOLIDATION_LEDGER.md) for migration ownership and compatibility decisions.

Useful checks:

```powershell
pnpm check
pnpm test
pnpm build
pnpm test:e2e
```

## Deployment

The full application needs a persistent container runtime with HTTPS and WebSocket support. It also runs scheduled work in the application process. Request-only serverless platforms such as the repository's former Vercel deployment are not supported and must not be presented as the production service.

`Dockerfile` builds the application image. `docker-compose.yml` provides the Hetzner single-host stack with MySQL, Redis, migration ordering, a health check, and loopback-only application/database/Redis bindings. Route the stable production domain through the host's HTTPS reverse proxy. The repository does not provide a public tunnel launcher.

See [Production Cutover](docs/PRODUCTION_CUTOVER.md) before deploying. It lists required credentials, data backup and migration steps, integration checks, rollback requirements, and the boundary for retiring the old hosting projects. Configure secrets in the target platform's secret manager; do not put them in source control, image layers, release notes, or issue comments.

The GitHub Release workflow publishes a versioned image to `ghcr.io/robert-velhorst/006-autoreminder-virtualworkers` after a release is published. It does not deploy that image to a live host. An operator must configure the runtime, persistent storage, secrets, networking, and backups separately.

## Authentication and Access

Production authentication uses registered accounts and role-based access controls. `LOCAL_AUTH_BYPASS` is for loopback development only; the server refuses that mode in production or on a non-loopback host. Do not expose the dashboard publicly until authentication, account recovery, role boundaries, HTTPS, and integration scopes have been reviewed for the target deployment.

## Integrations and Data

The application stores operational data in MySQL. Redis is used for shared cache and realtime coordination when configured. Trello and other providers require separately provisioned credentials. Follow least privilege when creating provider accounts and tokens, and rotate any credential that has entered source control or an untrusted log.

The operator transfer tools and data ownership rules are described in the [consolidation ledger](docs/CONSOLIDATION_LEDGER.md). The tools are designed to avoid guessing worker or founder identities. Back up both source and target databases before importing data.

Before importing, export and inspect the source data. Supply explicit, existing target worker and founder IDs; the utility does not infer identity mappings:

```powershell
node scripts/operator-data-transfer.mjs export --out .local/operator-export.json
node scripts/operator-data-transfer.mjs import --in .local/operator-export.json --target $env:TARGET_DATABASE_URL --worker-id $env:WORKER_ID --founder-id $env:FOUNDER_ID
node scripts/operator-data-transfer.mjs reconcile --in .local/operator-export.json --target $env:TARGET_DATABASE_URL
```

## Security

Please do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for supported-version and private-reporting guidance. Secret scanning, push protection, dependency alerts, automated security updates, code scanning, and protected `main` checks are enabled or configured at the repository level; verify their current state in GitHub before relying on them.

## Project Documentation

- [Production cutover and operations](docs/PRODUCTION_CUTOVER.md)
- [Consolidation ledger and data ownership](docs/CONSOLIDATION_LEDGER.md)
- [Branch consolidation history](docs/BRANCH_CONSOLIDATION.md)
- [Environment variable template](.env.example)

## License

MIT. See [LICENSE](LICENSE).
