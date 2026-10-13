# Migration 0045 rehearsal result

Verified on 2026-09-05 after the parent authorized writes to the restored isolated
database and creation of a separate fresh canonical test database. Scope is schema
and migrations only. No application services, browser suites, providers, deployment,
commits or live database access were involved.

## Outcome

| Check | Result |
| --- | --- |
| Full backup artifact | 12501536 bytes; SHA-256 verified below |
| Restored input ledger | 47 exact hash/timestamp matches with supplied artifact |
| Canonical historical SQL | All 45 hashes and identities match restored ledger |
| Extra restored lineage | Exact source evidence-graph and initial-manager SQL hashes |
| Restored migration | Existing runner applied only 0045; ledger 47 -> 48 |
| Original records | Parent verifier retained all 46321 rows across 124 original tables |
| Restored rerun | All table definitions, row digests and ledger rows unchanged |
| Fresh recovery_test | Absent before creation; all 46 canonical migrations applied from empty |
| Fresh rerun | All table definitions, row digests and ledger rows unchanged |
| Direct 0045 SQL replay | Passed on recovery_test; no schema/data/ledger changes or duplicate slots |
| Schema parity, both DBs | 131 expected tables present; no missing tables/columns or unexpected extra columns |
| Pilot metadata, both DBs | Types, nullability, defaults, precision, auto-increment, update rules, PKs, indexes and FKs match |
| Focused tests | 28 passed across three test files |

Each completed DB contains 132 base tables: 131 application tables and the Drizzle
migration ledger. The restored ledger contains 48 rows; fresh recovery_test contains
46, exactly one for each canonical journal entry, with no foreign lineage. Both end
at timestamp 1788645600000 and the unchanged 0045 hash below.

## Database boundaries and handoff

All database connections used loopback TCP 127.0.0.1 port 33317 on native MySQL
8.4.11. No connection was made to the live operational DB or aptlss_test.

- aptlss_pilot_rehearsal: parent-restored operational backup; original-record
  preservation confirmed with the parent's verifier before and after migration,
  after runner reruns, and after the final focused test run.
- recovery_test: parent-requested fresh canonical path for the existing integration
  and browser harness. information_schema confirmed the database was absent before
  CREATE DATABASE. It was never overwritten. All 46 migrations ran from an empty DB.
  No application test users, runs, reviews, active manager state or pilot activation
  were seeded. The only migration seed is four unoccupied queue slots, ids 1-4.
- aptlss_pilot_canonical_0045_20260905: an earlier fresh test DB created before the
  parent specified recovery_test. It independently passed full migration, rerun and
  SQL replay checks. Retained without deletion; not the requested browser target.

No stored database events exist in these three test DBs. The native server's shared
event_scheduler setting was ON and was not changed. Server SQL mode included
STRICT_TRANS_TABLES, NO_ZERO_IN_DATE, NO_ZERO_DATE and NO_ENGINE_SUBSTITUTION;
explicit_defaults_for_timestamp was 1.

recovery_test is ready for the parent to use for consolidated original-manager
integration/browser suites. This migration task did not run those application suites.

## Evidence and commands

Local evidence inputs:

- .local/pilot/applied-migrations.json: all 47 original hash/timestamp pairs.
- .local/pilot/rehearsal-before.json: original column lists, row counts and sorted
  per-row aggregate hashes for all 124 original tables (excluding the migration ledger).
- .local/pilot/rehearsal-preservation.json: successful parent verifier result.
- drizzle/contracts/0045-canonical-baseline.json: immutable canonical SQL hashes,
  journal entries and all 117 pre-consolidation table-definition hashes.

Executed the existing scripts/run-migrations.mjs with an explicit test-only
DATABASE_URL for each target, never an implicit .env-selected database. The normal
runner was not edited. It applied 0045 to the restored DB and the full journal to
each fresh database. Reruns added no ledger entry. The opt-in tests additionally
replayed 0045 directly, split using the real statement-breakpoint delimiter, on the
fresh DB to exercise actual SQL guards rather than merely the runner's timestamp skip.

Parent's required verification command passed:

```text
APTLSS_REHEARSAL_DATABASE_URL=<explicit isolated restored URL>
node scripts/aptlss-pilot-rehearsal.mjs verify
{"preserved":true,"originalTables":124}
```

Focused test invocation (set both variables explicitly in the current shell):

```text
APTLSS_PILOT_REHEARSAL_TESTS=1
APTLSS_REHEARSAL_DATABASE_URL=<explicit isolated restored URL>
node node_modules/vitest/vitest.mjs run server/aptlssPilotMigrationContract.test.ts server/aptlssPilotMigrationSqlParity.test.ts server/aptlssPilotMigrationRehearsal.test.ts
```

Result: three files passed, 28 tests passed. The rehearsal file is skipped in normal
runs and rejects targets other than the explicitly named restored loopback database;
its second target is the fixed recovery_test name on the same local server. Rerunning
the DB checks after parent application tests mutate recovery_test may require fresh
baseline coordination; do not reset or overwrite the parent's work.

scripts/verify-schema-parity.ts also passed separately against both named targets.
It reported 131 expected / 132 actual tables, no missing tables/columns, no unexpected
extra columns, and the four retained reply_threads compatibility columns.

## Limits and data compatibility risks

- All seven preexisting evidence-graph/initial-manager tables contained zero rows
  in the restored backup. Schema upgrade, default definitions, existing main-data
  preservation and empty-table compatibility are proven. Backfilling populated
  historical manager rows, retaining populated graph records and occupied queue
  lease behavior require additional fixtures; do not describe them as exercised here.
- Complete rerun and direct SQL replay are proven. Deliberately interrupted DDL
  at intermediate boundaries and concurrent migration attempts were not tested.
- MySQL DDL can implicitly commit. A deployment failure needs inspection before
  retry; this change does not supply multi-runner locking or transaction rollback.
- Existence guards preserve existing definitions, not repair arbitrary drift.
  Exact pilot metadata passed on these test DBs, but future live preflight must still
  reject incompatible existing columns/indexes/FKs and unexpected ledger changes.
- Missing mode defaults to shadow. Existing mode values, including active, are
  intentionally not reset. This migration is not a global execution-disable switch.
- shadowStartedAt represents migration time when newly added, not historical proof
  that an old run belonged to an accepted trial.
- Database/schema acceptance does not establish application integration, browser,
  provider, backup-at-deployment-time or production rollout acceptance.

## SHA-256

Backup:
33fd77945dfd7cc011a4701b77214b23fb42a3f1ec368eb70cd621b5b8b3bbad

0045_aptlss_pilot_consolidation.sql (unchanged after rehearsal):
c2969e1f094055780dbdd51cc092c4db18167bfbbb928eb1522cca8dd17303e4

0045_snapshot.json:
2cdad58130a5b10be2b66466c9214d979eb1ba4813a877e1dd03f116e388d339

The two preserved foreign ledger rows:

- Source 0032 evidence graph, timestamp 1787341181245:
  65ae6acb2993eaed05b1bec6e989d0996f153e3c330bed7ef6a941486af53458
- Source 0033 initial manager, timestamp 1788555042308:
  166b6b711aaf96560af70f162f8804077b087ae54e55075bed087c8ba64c63d7

No old migration, journal identity, snapshot or applied ledger row was rewritten.
