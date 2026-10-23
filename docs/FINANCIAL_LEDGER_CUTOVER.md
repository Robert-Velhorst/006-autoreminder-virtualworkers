# Financial Ledger Cutover

Migration 0009 adds financial identities and audit history. It does not transfer
money, approve a payment, reconcile historical ownership or erase duplicates.
This procedure applies only after the release's native financial tests pass.

## Before Migration

1. Stop application writers, scheduled jobs and any direct financial imports.
   Keep the last verified application image and configuration available.
2. Take a private database backup and prove restoration into a separate database.
   Never attach financial records, credentials or exports to a public issue.
3. Run these read-only checks on the intended database:

   ```sql
   SELECT "founderId", "cycleStart", "cycleEnd", count(*) AS records,
          array_agg(id ORDER BY id) AS cycle_ids
   FROM payment_cycles
   GROUP BY "founderId", "cycleStart", "cycleEnd"
   HAVING count(*) > 1;

   SELECT "founderId", "vaId", "weekStart", count(*) AS records,
          array_agg(id ORDER BY id) AS weekly_log_ids
   FROM weekly_pay_log
   GROUP BY "founderId", "vaId", "weekStart"
   HAVING count(*) > 1;
   ```

4. Any duplicate is a stop condition. Review raw rows, settlement state, worker
   account ownership and linked history privately. Do not choose the newest row,
   delete rows or rewrite a founder to satisfy the migration. Obtain a separate
   approved reconciliation plan. Migration 0009 repeats the duplicate checks
   under writer locks and aborts the transaction without choosing a winner.
5. Review existing links and overlapping periods as well: uniqueness is not
   proof that historical financial meaning or ownership is correct. `vaId` in
   `weekly_pay_log` identifies a user account, not a worker-profile row.

## Explicitly Approved Identical Weekly Records

The transfer command optionally accepts `LEGACY_WEEKLY_RECONCILIATION_FILE`, a
private JSON plan with version 1, the owner's verbatim approval, verified source
backup SHA-256, owner/worker user IDs, explicitly confirmed EUR amount and every
field of every original weekly row. Never commit this record-bearing plan.
This is not automatic deduplication: the default importer still rejects conflicts.

The narrow reviewed path accepts only identical business values, zero adjustments,
no notes or payment-cycle links, confirmed admin/worker identities, no incoming
references and no collision at the approved destination. Any source drift fails.
It uses session-local temporary source tables inside the consistent read-only
snapshot; permanent source records remain unchanged. The lowest original ID is
retained only as a technical reference anchor, not as an inferred authority.
The canonical row records confirmed currency and provenance in its notes.

All original fields and timestamps, the approval and canonical row are archived in
`migration_audit.approved_weekly_reconciliations` in the same PostgreSQL transaction
as the import. Its schema and table revoke PUBLIC access. Application-runtime
roles must not receive audit-schema access. The archive is included in full
backups and must be checked during restore acceptance. Source/target digests
cover the approved canonical source projection; the report separately identifies
the plan hash and preserved original count. Original totals and canonical totals
must be reconciled explicitly rather than treating the smaller row count as loss.
This records a historical allowance, not a payment or evidence of settlement.

## Runtime Acceptance

- Validate canonical migration receipts and actual nondeferrable financial
  uniqueness constraints, not only matching index names.
- Check foreign-founder requests and stale account/profile authority fail
  without writes. A founder must explicitly select an owned worker when saving.
- Exercise concurrent settlement, first weekly creation and automatic D1 events
  in a disposable PostgreSQL database. Observe real lock waits; a mock call order
  is not concurrency evidence.
- Confirm repeated settlement retains one successor, and injected successor or
  audit failure rolls the complete operation back.
- Confirm settled linked/overlapping periods and applicable locked reviews
  cannot be edited, including by removing a payment-cycle link.
- Confirm automatic charge retries preserve one event and do not mark a flag
  charged when ledger persistence failed.
- Verify worker changes reset the browser editor and each save carries the
  selected worker identity. Opening Home must not create a financial record.
- Require the form's originally loaded revision for every founder save, including
  an explicit absent-record revision for creation. A background refresh must not
  silently replace that revision while retaining old form values. Concurrent
  creation or a new automatic D1 event must reject the stale form unchanged.

The historical day-review table has one global record per date and no persisted
worker/founder ownership. Its locked dates remain conservatively protected;
tenant-specific historical ownership cannot be guessed from missing metadata.

Counters remain nonnegative integer counts. Estimates use the existing
application's fixed weights, calculated in integer cents. Negative projected
estimates are retained rather than silently floored; they are not a payment
instruction. Existing historical amounts are not automatically recomputed.

## Recovery

Keep writers stopped if migration or data acceptance fails. Additive DDL is not
permission to drop audit history or restore over new writes. Validate the
previous application's schema compatibility before rollback; otherwise restore
the verified pre-cutover backup into a separate database and reconcile any
post-backup writes explicitly. Resume only after ownership, historical values,
readiness and backup restoration have been checked.

The separate [production cutover](PRODUCTION_CUTOVER.md), provider checks and
human-reviewed shadow trial remain required. CI is not operational approval.
