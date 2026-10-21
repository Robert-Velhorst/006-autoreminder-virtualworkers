# Confirmed Card Analysis

## Operator Workflow

1. Select cards or a board and load a preview. This reads the database only.
2. Review the named cards, selected count and remaining count. A preview expires
   after ten minutes. Each batch contains at most 100 cards.
3. Explicitly confirm the frozen preview. Confirmation returns a durable job;
   an acknowledgement does not mean the analysis has finished.
4. Observe each card's outcome. A generated plan, a fallback needing review, a
   missing card and an unknown outcome are different results.
5. Preview and confirm the next batch separately when matching cards remain.

Closing the dialog or pausing status checks does not cancel server work. Status
reads never resubmit analysis. Interrupted work requires explicit recovery
acknowledgement; unknown calls may already have incurred provider usage.

The batch bound is not a new daily token allowance or a Luna reasoning limit.
This change does not configure a provider, enable a paid fallback or establish
live provider acceptance.

## Persistence And Authority

Migration `0010_atis_analysis_admission` adds requests and per-card progress
without replacing understanding history. Preview membership and guidance are
frozen server-side, not stored in scheduler metadata or browser storage.

Confirmation atomically consumes the preview, reserves its membership and
creates the durable run under the existing global understanding lease. Preview
expiry uses the database clock after acquiring the row lock. Repeated identical
confirmation returns the recorded job; a different confirmation key conflicts.

Administrator role, account session epoch and lease ownership are checked
before execution and again at result-write boundaries. The provider transport
also checks ownership after asynchronous preparation, immediately before its
request. A request already sent to a provider cannot be recalled by revoking
authority afterwards; a revoked result must not be persisted as authorized work.

A committed calling marker without a verified outcome remains uncertain after
interruption. It is not silently relabeled as failure or automatically retried.
The ordinary process, failed-card retry, single-card retry and bulk reanalysis
routes all use this admission path.

## Maintenance Commands

Production images include sealed JavaScript tools; no TypeScript compiler or
source checkout is required:

```sh
node dist/tools/reanalyze_all.js --help
node dist/tools/reanalyze_active_placeholders.js --help
node dist/tools/reanalyze_all.js --owner-user-id <administrator-id>
```

The last command creates a preview only. It prints the explicit confirmation
command with preview identity and stable request key. Review the named cards
before using it. Both tools require an explicit administrator identity and use
the same durable admission core. They do not delete existing understanding rows.
For source development, use `node --import tsx server/scripts/reanalyze_all.ts`.
Never substitute an operational database into the isolated integration tests.

## Verification Boundary

Unit and intercepted Chromium tests exercise admission adapters, explicit
confirmation, polling, cooldowns, recovery and operator-facing outcomes.
Dedicated native PostgreSQL cases exercise locks, concurrent confirmation,
rollback, authority changes and ambiguous outcomes with mocked providers.
The CI workflow runs the new browser suite and canonical native fixtures.

Read test receipts for the exact reviewed commit. Local skipped database cases
are not native acceptance. Neither mocked-provider tests nor configured-image
checks prove actual provider delivery, target-host operation, migrated personal
data, or the human-reviewed APTLSS shadow trial.
