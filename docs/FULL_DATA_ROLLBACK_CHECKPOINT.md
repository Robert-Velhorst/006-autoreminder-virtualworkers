# Full-data rollback checkpoint

This is a read-only preservation component for the outstanding full-data
application rollback rehearsal. It is not a deployment command, permission to
roll back, proof of application compatibility, or a database restore operation.
The legacy rollback command remains disabled.

## Scope

`scripts/full-data-rollback-checkpoint.mjs` captures all base tables, including
`__drizzle_migrations`, full manager runs, compact checks, and every existing
column. It includes generated and invisible columns rather than using the old
checkpoint's selected legacy columns. Views, triggers and stored routines have
their complete definitions fingerprinted. An unreadable definition fails the
capture. View/routine/trigger creation SQL-mode and character-set metadata are
included where returned by MySQL, not only the displayed SQL body. Non-InnoDB
tables and scheduled database events are refused.

The capture requires an explicit database name, server port, exact server data
directory and disabled/off event scheduler. It refuses an existing transaction,
starts a repeatable-read consistent read-only transaction, verifies the actual
MySQL transaction flags, and always rolls back its own transaction. Database
identity and complete schema are checked again before returning. A schema change,
missing digest, interrupted stream or mismatched row count cannot produce proof.

Values are hashed by MySQL before transport, avoiding JavaScript rounding of
large integers and transfer of retained message/document payloads. Null markers
and fixed-width value hashes preserve column boundaries. Sorted row hashes retain
duplicate multiplicity without depending on query order. Counts are independently
checked within the same snapshot. The versioned format is intentionally distinct
from older row-object and selected-column fingerprints; those formats must not
be compared to it.

Receipts contain table/column names, definition hashes, record counts and hashes,
not raw records, DDL bodies, credentials or worker messages. Treat receipts as
private operational evidence nonetheless. They are not signed attestations and
must be retained alongside their trusted source inventory and execution evidence.

## Caller Responsibilities

Before calling `captureFullDataCheckpoint`, prove ownership of the isolated
server and its storage/process, validate backup provenance, and stop all app
writers on that restored copy. A matching SQL identity alone is not proof of
ownership. Keep provider credentials, public ports and production mounts absent.
Network isolation alone does not stop local scheduled writes.

For the full restored production-data rehearsal, the native server must have
`event_scheduler=DISABLED` at startup. `OFF` is accepted for the separate,
disposable CI/test database, which contains no restored database events. The CI
workflow explicitly disables that disposable service's scheduler; tests and the
checkpoint itself do not silently change a server's global configuration.

Use a dedicated connection. The capture sets its timezone to UTC and must not
borrow an application connection or transaction. It never seeds, migrates,
deletes, cleans up data, launches an application, or restores SQL. The optional
progress callback receives only table/count totals; observer failure aborts the
capture instead of returning partial evidence.

`assertFullDataUnchanged(before, after)` verifies receipt consistency and exact
equality. There are no omitted history tables or ignored timestamp columns.
Any legitimate rehearsal mutation needs explicit, narrowly scoped reconciliation
in the future application runner; do not weaken this comparison to obtain a pass.
Capture a fresh baseline immediately before that runner starts. A previously
captured baseline does not establish that the fixture has remained unchanged.

## Verification And Remaining Gate

The unit suite covers identity/transaction refusal, schema drift, missing ledger,
missing definitions, events, nontransactional storage, duplicate hashes,
interrupted streams, progress failures and altered/forged receipts. The mandatory
MySQL gate includes the separate integration suite: real read-only transaction
flags, ledger/generated-column inclusion, adjacent unsigned 64-bit values,
binary/null/empty changes, duplicate records, additive columns and protection
of a caller's existing transaction. The test-created table is uniquely named
and removed only within the explicitly allowed disposable test database.

Successful capture still reports `releaseReady: false` and
`applicationRollbackVerified: false`. The actual candidate -> backup-manifest
fallback -> candidate application exercise is still required on the same full
restored data, with background-writer isolation, history materialization,
authentication/CSRF/RBAC, worker/founder scope, WebSocket rooms, all timer-start
paths, record preservation and explicit reconciliation. Do not replace it with
the five-user runtime fixture, migration-only results, or an old SQL restore.

See [current rollout warning](APTLSS_SHADOW_ROLLOUT.md#current-compatibility-warning-2026-10-01)
and [verification receipts](PRODUCTION_VERIFICATION_20260930.md).

## Restart Revalidation And Fallback Inspection, 2026-10-01

The owned native server was observed stopped, then restarted on loopback port
33317 with `event_scheduler=DISABLED`, no binary logging and its existing data
directory preserved. The listener's child PID and launcher identity were checked
independently. A fresh consistent read-only capture exactly matches the earlier
full baseline: 134 base tables, 94,730 records, all 56 ledger records and 5,901
full manager runs. Its receipt is
`artifacts/production-full-data-resume-baseline-20261001.json`; this proves
preservation after the database-server restart, not an application switch.

Static inspection of the exact operational fallback image `fa20db9c...`
confirmed that `BACKGROUND_JOBS_ENABLED` is absent from its compiled bundle.
Its Manus scheduler runs immediately and every 60 seconds; maintenance starts
after five seconds and repeats every 60 seconds. Passing the new global switch
to this old binary cannot isolate those writers. The image was never started
on restored operational data. Keep the old-binary-specific isolation and explicit
mutation-reconciliation gate open rather than treating candidate behavior as
proof of fallback behavior.

The older original-column CLI also now rejects empty/malformed/inconsistent
baselines before connecting, preserves unsafe BIGINT values without rounding,
and labels its proof `legacy-original-columns`. Safe legacy number hashes remain
compatible; already-rounded unsafe legacy baselines fail comparison. This CLI
still excludes the ledger, additive columns and schema definitions. Its result
must never replace the full-data component or application-rollback rehearsal.
