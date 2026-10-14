# Documentation Authority

Use these files for the current system state. Older planning and implementation
reports are historical snapshots and are not deployment or release evidence.

| Topic | Current source of truth |
| --- | --- |
| Product overview and supported runtime | [README.md](README.md) |
| Environment variables and local setup | [.env.example](.env.example), [LOCAL_DEV_SETUP.md](LOCAL_DEV_SETUP.md) |
| Database schema and migrations | `drizzle/schema.postgres.ts`, `drizzle-postgres-v1/` |
| Runtime deployment | [DEPLOYMENT.md](DEPLOYMENT.md), [DEPLOYMENT_TARGET.md](DEPLOYMENT_TARGET.md) |
| Data transfer, cutover, and rollback gates | [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md) |
| Migration lineage and ownership decisions | [docs/CONSOLIDATION_LEDGER.md](docs/CONSOLIDATION_LEDGER.md) |
| Automated repository checks | [.github/workflows/ci.yml](.github/workflows/ci.yml) |

## Current production facts

- The application runtime uses PostgreSQL. MySQL references in the legacy
  schema and transfer tooling are not supported runtime backends and do not
  confirm which database currently contains production data.
- Hetzner is the production hosting target. The app requires a persistent
  process for HTTP, WebSockets, and scheduled work; Vercel and ngrok are not
  production targets.
- Docker Compose runs one application container. PostgreSQL and optional Redis
  are provisioned separately.
- The actual production source database has not been confirmed. The retained
  MySQL-to-PostgreSQL utility is conditional and has not been accepted against
  a confirmed source or restored production backup. Production cutover remains
  unverified until all gates in `docs/PRODUCTION_CUTOVER.md` pass.
- CI, local tests, and image publication do not prove live Hetzner acceptance.

Documents such as `PRODUCTION_COMPLETION_PLAN.md`,
`PRODUCTION_READINESS_GUIDE.md`, `PROJECT_OVERVIEW.md`, and
`IMPLEMENTATION_COMPLETE.md` may contain old estimates, dependencies, or
commands. Follow the current sources linked above when they disagree.
