# Application Architecture

The former “actual architecture” report was a dated snapshot containing
unverified completion percentages, an obsolete MySQL-only runtime description,
and feature/test claims that no longer match the current application. It has
been retired rather than used as evidence of production readiness.

For current behavior and verification boundaries, use:

- [README.md](README.md) for supported application surfaces and runtime.
- [PostgreSQL schema](drizzle/schema.postgres.ts) and the
  [`drizzle-postgres-v1/`](drizzle-postgres-v1/) migration lineage for the
  current database contract.
- [Production deployment](DEPLOYMENT.md) and
  [deployment target](DEPLOYMENT_TARGET.md) for hosting requirements.
- [Production cutover](docs/PRODUCTION_CUTOVER.md) for data migration,
  rollback, and live acceptance gates.
- [Documentation authority](DOCUMENTATION-AUTHORITY.md) for the current source
  of truth by topic.

Do not use historic root-level project reports as proof that a feature, test,
security control, migration, or deployment is currently operational.
