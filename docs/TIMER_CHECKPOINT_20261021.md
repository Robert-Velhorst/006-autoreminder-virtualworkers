# Canonical timer checkpoint record

This checkpoint preserves work in progress at the owner's request. It is not a
production release or approval to migrate an operational database.

## Included work

- Explicit canonical account/profile timer ownership with retained legacy provenance.
- Shared identity-bound start/stop handling and an active-timer database invariant.
- Additive PostgreSQL migration and explicit legacy identity-review tooling.
- Scoped history readers, completeness reporting, and worker-timezone date context.
- Client controls that retain exact entry IDs and avoid implicit timer switching.
- Unit, browser-component, and native PostgreSQL regression coverage.

## Initial Draft Gaps at df3931f

- Execute and review native PostgreSQL migration, rollback, restricted-role,
  concurrent-writer, and process-restart cases. These were not run locally.
- Provide an audited offline closure path for duplicate unresolved legacy open
  timers. Readiness currently blocks those records; the CLI cannot yet finish
  that recovery. Do not guess ownership or fabricate stop times.
- Finish operator cutover documentation and complete review of the consolidated
  implementation before enabling it in production.
- Investigate the shared reminder integration fixture failure observed on base
  main commit `5af68da3216986bef1b26f634f9abb2e264d0a28`. Its protective assertion
  detected unrelated due reminders; this checkpoint does not fix that isolation issue.
- Final local test results and any failures are recorded in the pull request.
  Earlier passing runs are not acceptance evidence for later source revisions.
- The local Node script suite currently has 12 failures in the existing operator
  transfer fixture contracts after canonical timer import changes. Those fixtures
  and the actual import behavior require reconciliation before acceptance.

## Initial Local Checkpoint Verification

- TypeScript and whitespace checks passed.
- Vitest: 4,059 passed, 319 skipped without a local database.
- Node script contracts: 77 passed, 12 failed, 3 platform-dependent skips.
- Staged Gitleaks scan: no leaks found.
- Browser component checks use intercepted requests, not a live backend. A broad
  status selector was corrected after a 65/66 run; the PR records the final rerun.

## Follow-up Implementation

Subsequent changes address those draft gaps; the initial failures above remain
historical evidence, not descriptions of a passing release:

- [Timer Identity Cutover](TIMER_IDENTITY_CUTOVER.md) documents explicit offline
  duplicate recovery, preserved provenance/durations, audit replay, database
  privilege and settlement boundaries. Native cases cover the real SQL paths.
- Operator transfer fixtures and legacy staging privilege checks are updated
  without inferring account identity from an old numeric alias.
- Reminder integration uses its own fully migrated temporary database; its
  unrelated-work guard is retained. Manager fixtures use canonical timer IDs and
  remove only exact owned records before restrictive profile cleanup.
- History requests no longer retain active-timer mutation locks. Canonical
  timezone/calendar resolution is shared across relevant timer readers.
- PostgreSQL RESTRICT assertions check the actual restrictive-FK error rather
  than expecting the different foreign-key SQLSTATE.

These changes require fresh exact-head CI, including native migration, locking,
recovery, restricted-role, settlement, restart, and complete regression checks.
Presence of a native test is not proof that it passed. Consult the PR checks for
the source revision under consideration.

Real provider behavior, production deployment, operational backups/restores, and
the human-reviewed shadow trial require separate acceptance. No credentials,
private configuration, user database dumps, or recovery archives belong in this
source checkpoint.
