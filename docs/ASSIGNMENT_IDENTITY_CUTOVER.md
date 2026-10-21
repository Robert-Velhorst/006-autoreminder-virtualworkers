# Assignment Identity Cutover

The canonical operational identity is `(founderId, full taskId)` across **all**
statuses and workers. Checklist item keys remain distinct from their parent card
and from other items. Completed work is not an exception to identity uniqueness.
History belongs in the retained schedule, handoff, decision and assignment event
records, not in duplicate operational assignments.

## Before Migration 0008

1. Stop application writers and scheduled jobs. Verify a private, recoverable
   database backup and tested restore path. Never publish operator data in Git.
2. In a trusted operator database session, inspect this read-only report:

   ```sql
   SELECT "founderId", "taskId", count(*) AS records,
          array_agg(id ORDER BY id) AS assignment_ids
   FROM task_assignments
   GROUP BY "founderId", "taskId"
   HAVING count(*) > 1
   ORDER BY "founderId", "taskId";
   ```

3. If duplicates exist, stop. Review their complete raw rows and linked history
   privately with the owner. Do not select the newest/minimum ID automatically,
   discard completed rows, rewrite full task keys, or delete history to make the
   migration pass. A separately approved, audited data-resolution procedure is
   required; this migration deliberately does not invent one.
4. Apply canonical migrations only after the duplicate report is empty and the
   other cutover gates are satisfied. Migration 0008 locks assignment writers,
   repeats the duplicate check inside its transaction, adds a nondeferrable
   unique constraint and the additive `assignment_events` table. A duplicate
   abort leaves assignment rows, history and the migration ledger unchanged.

## Runtime Acceptance

- Readiness checks the exact migration receipt and actual unique constraint,
  not merely a percentage, matching index name or status-filtered row count.
- Assignment/reassignment/status operations recheck actor and worker identities
  under ordered account/profile locks. Sorted founder/task transaction advisory
  locks fence missing identities as well as existing rows.
- Reassignment retains the assignment ID and historical fields. Explicit null
  notes clear the note; omitted notes preserve it. Identical retries add no
  audit event or timestamp churn. Audit failure rolls back the operation.
- Timer starts validate exact child and parent-fallback keys together. Stopping
  or pausing a known historical timer must not require a new assignment grant.
- Native acceptance must demonstrate real database uniqueness, transaction
  rollback, role/profile races, absent-key fencing and migration refusal on
  duplicate data. Test-double ordering alone is not concurrency proof.

Run native tests only against the explicitly validated disposable PostgreSQL
fixture configured through `APTLSS_TEST_DATABASE_URL`. The assignment fixture
creates its own UUID database, applies canonical migrations and removes that
owned database afterward. Never redirect these tests to an operational database.

Source/CI acceptance is not permission to apply migration 0008 to live data,
resolve duplicate ownership, send provider messages or activate APTLSS planning.
Keep the separate [production cutover](PRODUCTION_CUTOVER.md) and human-reviewed
shadow-trial gates.
