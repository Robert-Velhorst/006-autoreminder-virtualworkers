# Production Readiness

> This replaces the old 70%-complete guide. Its MySQL/SQLite runtime diagrams,
> Manus OAuth setup, `db:push` commands, sample secrets, and completion claims
> described a different version of the application and are obsolete.

The current production target is a persistent Node.js application container on
Hetzner, PostgreSQL as the application database, and an HTTPS reverse proxy.
Redis is optional and external. Docker Compose runs the application container
only.

## Readiness status

Production cutover is **not yet verified**. In particular, the actual legacy
MySQL database has not been rehearsed through backup, restore, PostgreSQL
transfer, and reconciliation, and the Hetzner deployment has not passed live
acceptance. Do not treat local tests or image publication as live acceptance.

## Required release gates

1. Restore-test a backup of the actual legacy source in an isolated environment.
2. Run `pnpm db:migrate` on an empty PostgreSQL target, then run the read-only
   transfer preflight and a rehearsed `copy --execute` against the restored
   source. Review all row counts and hashes.
3. Test target backup/restore, sequences, application reads and writes,
   repeatability, and the rollback path.
4. Deploy the verified release to Hetzner and test health/readiness, login and
   role boundaries, WebSockets, scheduled work, and all enabled integrations.
5. Retain the source, backups, and previous application release throughout the
   agreed rollback window. Retire old hosting only after acceptance.

## Current instructions

- [Deployment](DEPLOYMENT.md) describes the supported container deployment.
- [Production cutover](docs/PRODUCTION_CUTOVER.md) is the operational checklist
  and documents the migration limitations.
- [Deployment target](DEPLOYMENT_TARGET.md) records the hosting decision.
- [CI workflow](.github/workflows/ci.yml) defines automated repository checks;
  it does not prove the live environment works.

No percentage-complete estimate is maintained. Readiness is determined by the
release gates above and direct evidence from the target environment.
