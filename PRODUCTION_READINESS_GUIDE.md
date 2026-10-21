# Production Readiness

> This replaces the old 70%-complete guide. Its MySQL/SQLite runtime diagrams,
> Manus OAuth setup, `db:push` commands, sample secrets, and completion claims
> described a different version of the application and are obsolete.

The current production target is a persistent Node.js application container on
Hetzner, PostgreSQL as the application database, and an HTTPS reverse proxy.
Redis is optional and external. Docker Compose runs the application container
only.

## Readiness status

Production cutover is **not yet verified**. The owner intends to consolidate
their GitHub tools on a shared open-source PostgreSQL service. The approved
target service and VA Dashboard database have not been confirmed for this
application. Check for the intended shared service before provisioning another
one. Use a separate
database and least-privilege role for this app. No legacy data source or import
plan has been identified; do not run the retained MySQL transfer utility unless
a real source is identified and an import is approved. The Hetzner deployment
has not passed live acceptance. Do not treat local tests or image publication
as live acceptance.

## Required release gates

1. Confirm the approved shared PostgreSQL service and provision only what is
   missing, including an isolated VA Dashboard database/least-privilege role.
   Define network access, TLS, automated backup,
   and a restore-tested recovery procedure.
2. Run `pnpm db:migrate` on the new PostgreSQL database. Only define a transfer
   path if an existing source containing VA Dashboard data is identified and
   its import is approved; the MySQL utility is conditional, not a default.
3. Test target backup/restore, sequences, application reads and writes,
   repeatability, and the rollback path.
4. Deploy the verified release to Hetzner and test health/readiness, login and
   role boundaries, WebSockets, scheduled work, and all enabled integrations.
5. Retain backups and the previous application release throughout the agreed
   rollback window. If data is imported, retain its source until acceptance.
   Retire old hosting only after acceptance.

## Current instructions

- [Deployment](DEPLOYMENT.md) describes the supported container deployment.
- [Production cutover](docs/PRODUCTION_CUTOVER.md) is the operational checklist
  and documents the migration limitations.
- [Deployment target](DEPLOYMENT_TARGET.md) records the hosting decision.
- [CI workflow](.github/workflows/ci.yml) defines automated repository checks;
  it does not prove the live environment works.

No percentage-complete estimate is maintained. Readiness is determined by the
release gates above and direct evidence from the target environment.
