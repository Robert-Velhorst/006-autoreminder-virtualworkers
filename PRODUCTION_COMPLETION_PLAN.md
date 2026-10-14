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

## Latest Verification Snapshot

Verified 2026-10-14 UTC against PR #110 at commit
`48fb1053b2bdf2e0c25c65bd44627fd5cf1abe74`, with successful quality-gate
[38629932982](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/38629932982)
and CodeQL [38629935529](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/38629935529):

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
  alerts. The latter concern historical database credentials. The credential
  has not been revoked because Robert explicitly declined deleting the related
  database user; do not mark the alerts as resolved until the credential is
  safely invalidated or GitHub confirms an appropriate resolution.
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
  The legacy MySQL-to-PostgreSQL transfer has not been rehearsed against the
  actual source or a restored backup, and no live Hetzner deployment or
  production acceptance has occurred.

This is a dated evidence snapshot, not a claim of production readiness. Refresh
it after a default-branch merge, secret revocation, host configuration, release,
data-transfer rehearsal, or live deployment.

## Operational sources

- [Deployment](DEPLOYMENT.md)
- [Production cutover](docs/PRODUCTION_CUTOVER.md)
- [Deployment target](DEPLOYMENT_TARGET.md)
- [Current application overview](README.md)

Do not use old root-level planning documents as deployment instructions unless
they explicitly link back to these current sources.
