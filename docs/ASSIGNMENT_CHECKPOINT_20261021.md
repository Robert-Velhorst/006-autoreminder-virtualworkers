# Assignment identity work-in-progress checkpoint

Saved on 2026-10-21 at the owner's request to publish current progress and
clean local generated artifacts. This is not an accepted release or migration.

## Preserved implementation

- PostgreSQL assignment identity migration and dedicated assignment event table.
- Transactional assignment service, fresh account/profile checks and task-key locks.
- Canonical assignment guards in scheduling, manager, timer and handoff paths.
- Focused service, route and native database test fixtures.

## Verification and remaining work

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
