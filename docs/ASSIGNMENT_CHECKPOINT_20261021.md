# Assignment identity work-in-progress checkpoint

Saved on 2026-10-21 at the owner's request to publish current progress and
clean local generated artifacts. This is not an accepted release or migration.

## Follow-up Local Verification

The subsequent repair addresses the initial fixture failures, transactional
recipient checks, scheduling/cache eligibility, checklist authorization,
cross-worker conflict handling and briefing due windows. Its final local suite
passed 4,395 tests with 393 environment-dependent skips across 375 files.
TypeScript, transfer typecheck, frontend/backend build and seal, whitespace and
staged secret scanning passed. Node contracts passed 93 with three platform
skips. These results overlap the focused runs; do not sum them.

Nineteen service/migration and nine mounted HTTP assignment cases were collected
but not executed locally. Exact-head hosted PostgreSQL, image, browser and
security acceptance remain required. The earlier failed checkpoint is retained
below as dated evidence, not the current local test result. Neither this repair
nor green CI authorizes operational duplicate resolution or live cutover.

Hosted quality `39551153089` at `1035477` passed the configured PostgreSQL image
stage and all 19 service/migration plus nine mounted HTTP assignment cases.
Its overall regression stage failed: the digest-outbox fixture setup and one
session-lifecycle assertion still expected 138 tables, while additive migration
0008 correctly produced 139. That run reported 4,726 passing tests, one failed
test and 61 skips (including cases skipped after the failed fixture setup).
The two exact schema-count expectations are corrected to 139; no assertion is
removed. A new exact-head CI run is required. The failed run is not relabeled
accepted, and earlier native passes are not transferred to changed source.

## Preserved implementation

- PostgreSQL assignment identity migration and dedicated assignment event table.
- Transactional assignment service, fresh account/profile checks and task-key locks.
- Canonical assignment guards in scheduling, manager, timer and handoff paths.
- Focused service, route and native database test fixtures.

## Initial Checkpoint Verification

The following observations describe checkpoint `b4f64a0`, not acceptance of
subsequent source changes. The follow-up repair is tracked in the same PR143.

- The complete current checkpoint passes TypeScript (`tsc --noEmit --incremental false`).
- Service agent reported 40 focused tests passing and one database-dependent skip.
- Scheduling agent reported 20 focused tests passing.
- Route integration agent's last run reported 59 passing and 30 failing tests;
  subsequent fixture-only edits were not rerun. Do not merge this checkpoint as ready.
- Seventeen new native assignment cases were collected but not executed locally.
  Concurrency expectations need review against account-first locking: shared
  account locks can serialize requests before they reach task advisory locks.
- Route test fixtures still need fresh actor/profile identities and advisory-lock
  support. Handoff actor signature callers and tests need reconciliation.
- Conflict-resolution multi-task repair and remaining primary VA-management
  handoff/timer/read paths still need integration and verification.
- Migration rollback, native lock behavior and the full regression suite remain
  unverified for this checkpoint. Do not apply migration 0008 to operational data
  until duplicate review and native acceptance have completed.

## Cleanup boundary

Source progress belongs in Git. Credentials, private configuration, local databases,
operator evidence and recovery archives do not belong in this public repository.
Generated builds, dependency installations and browser-test reports may be rebuilt.
Docker cleanup requires a responsive engine and verified project ownership; a CLI
timeout is not evidence that containers, images or volumes have been removed.
