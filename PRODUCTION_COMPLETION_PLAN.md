# Production Completion Plan

This file replaces the superseded 70%-complete roadmap. Its percentage,
timeline, cost estimate, MySQL runtime instructions, and feature checklist were
not measured against the current application and must not be used for release
decisions.

## Current target

- Runtime: one persistent VA Dashboard application container on Hetzner.
- Database: PostgreSQL, intended as the shared open-source database platform
  for the owner's GitHub tools. The VA Dashboard production database has not
  yet been provisioned. Share the PostgreSQL service, not application data or
  credentials: create a separate database and least-privilege role per app.
  Hetzner is the hosting target; the exact PostgreSQL service topology and
  network placement still need to be provisioned and verified.
- Redis: optional, external, and not part of the required single-container
  application deployment.
- Hosting: Docker Compose behind a stable HTTPS reverse proxy. Vercel and
  ngrok are not production targets.

## Release blockers

1. Provision the shared PostgreSQL service and a dedicated VA Dashboard
   database and least-privilege role. Restrict network access, configure TLS,
   and establish automated backups with a verified restore procedure.
2. Apply the PostgreSQL migrations to the new VA Dashboard database. Do not
   run a legacy transfer unless an actual source containing VA Dashboard data
   is identified and its owner approves a specific backup and transfer plan.
   The retained MySQL transfer utility is conditional and is not evidence of a
   MySQL production source.
3. Test PostgreSQL backup/restore, application read/write behavior, sequences,
   rollback, and repeatability on a fresh target.
4. Deploy to Hetzner and verify health/readiness, authentication and role
   boundaries, WebSockets, scheduled jobs, and each enabled provider integration.
5. If existing VA data must be imported, complete its separately approved
   transfer and rollback window before retiring that source. Otherwise, record
   the agreed initial-data/bootstrap approach before production acceptance.

The migration and live deployment gates have not been accepted yet. A green
local test suite, image build, or CI run does not establish production
acceptance.

## Repository Verification Snapshot (2026-10-14)

Verified 2026-10-14 UTC against PR #110 code at commit
`18da0e9cd71b6ca4d9742263addf51d9c46d721a`, with successful quality-gate
[38630609725](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/38630609725), PR checks
[38630605017](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/38630605017), and
[CodeQL](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/runs/116081601414):

- The GitHub Actions quality gate passed, including dependency and secret
  scans, type checks, transfer checks,
  PostgreSQL migration/schema parity, tests/build, browser smoke tests, an
  isolated PostgreSQL backup/restore and sequence check, production-container
  smoke test, and Hetzner deployment-script syntax validation. Readiness also
  verifies the exact checked-in PostgreSQL migration hash; production fails on
  a port bind conflict and closes its PostgreSQL pool during graceful shutdown.
  This validates CI, not a live production migration or deployment.
- The dependency audit for this PR branch reports no known vulnerabilities.
- GitHub reports zero open Dependabot alerts and two open secret-scanning
  alerts concerning historical database credentials. Credential validity or
  rotation has not been verified. Robert declined deletion of the related Atlas
  database user; preserve that account. Do not dismiss the alerts until the
  exposed credentials have been safely invalidated and GitHub confirms an
  appropriate resolution.
- GitHub `main` protection is enabled with strict required CI and CodeQL
  analysis checks, administrator enforcement, conversation resolution, and no
  force-push or branch deletion. GitHub Actions is restricted to selected
  actions and requires SHA-pinned action references. No required human review
  is configured for code pull requests.
- GitHub's `production` environment currently has no secrets or variables. The
  deploy workflow therefore cannot connect to a host; its four required SSH secrets
  are listed in [Production Cutover](docs/PRODUCTION_CUTOVER.md). No stable
  release is available: `v1.0.0-rc.1` is a prerelease and is rejected by the
  production gate.
- The PostgreSQL backup/restore test passed against isolated CI databases.
  The shared production PostgreSQL service and VA Dashboard database have not
  yet been provisioned. No legacy data source or import plan has been
  identified, and no live Hetzner deployment or production acceptance has
  occurred.

This is a dated evidence snapshot, not a claim of production readiness. Refresh
it after a default-branch merge, secret revocation, host configuration, release,
data-transfer rehearsal, or live deployment.

The owner confirmed on 2026-10-15 that the production database is not yet
provisioned and that the intended direction is a shared open-source PostgreSQL
service for their GitHub tools, with a separate database and role per app.

## Operational sources

- [Deployment](DEPLOYMENT.md)
- [Production cutover](docs/PRODUCTION_CUTOVER.md)
- [Deployment target](DEPLOYMENT_TARGET.md)
- [Current application overview](README.md)

Do not use old root-level planning documents as deployment instructions unless
they explicitly link back to these current sources.
