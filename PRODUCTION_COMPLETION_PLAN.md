# Production Completion Plan

This file replaces the superseded 70%-complete roadmap. Its percentage,
timeline, cost estimate, MySQL runtime instructions, and feature checklist were
not measured against the current application and must not be used for release
decisions.

## Current target

- Runtime: one persistent VA Dashboard application container on Hetzner.
- Database: PostgreSQL. MySQL is retained only as a legacy source for the
  pending data migration; it is not a supported application runtime.
- Redis: optional, external, and not part of the required single-container
  application deployment.
- Hosting: Docker Compose behind a stable HTTPS reverse proxy. Vercel and
  ngrok are not production targets.

## Release blockers

1. Back up the actual legacy MySQL source and prove that the backup can be
   restored into an isolated rehearsal environment.
2. Run the PostgreSQL transfer preflight and copy against that restored source;
   reconcile every table and preserve the generated report.
3. Test PostgreSQL backup/restore, application read/write behavior, sequences,
   rollback, and repeatability on a fresh target.
4. Deploy to Hetzner and verify health/readiness, authentication and role
   boundaries, WebSockets, scheduled jobs, and each enabled provider integration.
5. Complete the cutover and rollback window before retiring any remaining
   source data or infrastructure.

The migration and live deployment gates have not been accepted yet. A green
local test suite, image build, or CI run does not establish production
acceptance.

## Operational sources

- [Deployment](DEPLOYMENT.md)
- [Production cutover](docs/PRODUCTION_CUTOVER.md)
- [Deployment target](DEPLOYMENT_TARGET.md)
- [Current application overview](README.md)

Do not use old root-level planning documents as deployment instructions unless
they explicitly link back to these current sources.
