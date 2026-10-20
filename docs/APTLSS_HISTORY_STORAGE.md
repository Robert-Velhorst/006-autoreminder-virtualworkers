# APTLSS assessment history

## Purpose

Repeated shadow assessments used to store another complete source dossier even
when the advice, evidence and execution conditions were unchanged. Migration
`0053_manager_history_checks` adds smaller, immutable checks for that specific
case. It does not rewrite or remove any existing full assessment or source record.
The canonical journal now contains 54 identities. The developer lineage through
`0027_glorious_epoch` and every subsequent applied identity remain unchanged.

## What Is Retained

A full `aptlss_manager_runs` record remains the base. Each equivalent check in
`aptlss_manager_checks` references that base directly, not a chain of patches.
The check retains its input/source identities, trigger, exact assessment/check
times, proposal and change explanation. Hashes validate both the retained base
and the exact reconstructed snapshot. A missing, corrupt or wrong-worker check
cannot authorize work. The dashboard and all three legacy timer-start paths use
the same validated current-history reader.

Only shadow assessments that have not changed the execution plan can reuse a
base. Equality is stricter than proposal-review sample deduplication. Evidence,
source versions, policy, assignments, implementation identity, dependencies,
reliability, actions, timing predictions, actual proposed slots and numeric
planning constraints must match. New or unknown snapshot fields are compared,
not silently ignored. Only declared clock fields may differ, and their exact
values remain in the check. Changed semantic-review outcomes also require a full
run. Policy/correction/trial invalidation forces a new full assessment.

Checks are bounded to 64 KiB and used only if their payload is less than half
the new full snapshot's size. Oversized proposals and small dossiers retain the
ordinary full-run path. The check and current-state pointer commit together
under the existing worker/queue ownership and fresh-context protections.

Equivalent checks retain the base run ID because the advice remains identical.
They do not count as additional reviewed proposals toward the 100-proposal
shadow-trial acceptance gate. Active/applied-plan history is never compacted;
previous plan versions and rollback records remain on the full-run path.

## Freshness And Failure

The assessment's own recorded time governs freshness. A polling timestamp or
failed attempt cannot make old guidance fresh. Invalidated state blocks work
until reassessment. The existing exact-input polling fast path is still not a
new successful assessment. This change does not hide urgent warnings, change
worker authority, enable active mode or permit external messages to be sent.

## Rollback

`APTLSS_MANAGER_COMPACT_HISTORY` defaults to enabled. To prepare rollback to an
older application binary:

1. Keep migration 0053 and every full run/check. Do not drop the additive table
   or state columns.
2. Set `APTLSS_MANAGER_COMPACT_HISTORY=false` in the current application.
3. Obtain a new assessment for each affected worker and verify that it produced
   a new full run and cleared `currentCheckId`. When compact history is disabled,
   a retained check bypasses both identical-input return paths: the manager
   re-evaluates deterministic eligibility and persists full history even if the
   source fingerprint and clock are unchanged. The semantic review and evidence
   dates are not renewed merely by materialization. Further identical polls can
   reuse the resulting full run without duplicating it.
4. Verify the full-run assessment's time, source coverage and worker scope before
   switching binaries. Retain the previous application and database backup.

The new reader accepts a newer full run written by an older binary over an older
check pointer. It still rejects missing or corrupt referenced history. This is
compatibility support, not proof of a full-data application rollback.

## Verification And Limits

Codec tests cover exact reconstruction, changed and future fields, integrity
failure, protected planning values and size bounds. Separate real-MySQL tests
cover immutable base records, successive checks, worker isolation, source and
policy changes, SQL failure rollback and rollback materialization. Route tests
exercise current-history authorization through all legacy timer paths.

This reduces future storage only for equivalent shadow dossiers. Changing real
plans, facts and semantic reviews still produce full runs. It does not shrink
the existing multi-gigabyte history or establish a lifetime storage bound.
Production migration, full-size migration/rerun preservation and measured
full-data application rollback remain release gates. See the dated verification
record for the exact tested source/image and reports.
