# APTLSS reliability and acceptance

## Verification checkpoint: 2026-09-05

- The complete repository suite passed 1,246 tests with zero failures or skips.
  This includes 599 APTLSS tests, 337 fixed regression cases and 59 tests against
  a separate real MySQL 8.4 database.
- Type checking and the production build passed on this version.
- The combined safety gate passed all 599 APTLSS tests and 23 browser checks
  with zero failures, skips or retries. Eight browser checks use real login,
  API and MySQL state; fifteen use explicit UI contract fixtures.
- The safety attestation, current source digest and sealed production build
  match. The final attestation was written at `2026-09-05T21:10:53.131Z`.
- The full additive migration lineage through `0036_aptlss_manager_queue` was
  applied to the separate database. A rerun succeeded, schema parity passed,
  and generation detected no schema drift.
- Database initialization now waits for a single complete connection/migration
  attempt before publishing the pool. Cache tests explicitly isolate their
  storage, and timezone tests exercise owned production-route fixtures instead
  of silently depending on an unrelated localhost server.
- Browser fixtures wait for their actual mutations before cleanup and remove
  only owned queue records. They verify the real login screen after development
  compilation and navigate through the application's founder entry. Mobile
  founder access is available only to the admin role.
- Earlier failed runs were used for diagnosis, not counted as acceptance.
  They exposed duplicate worker questions, retained test queue jobs and hard
  browser navigation aborting unrelated requests. The actual mobile menu also
  required the existing portaled Sheet component to remain clickable above the
  page. These fixes are included in the final full-suite and browser results.
- Post-test verification found zero remaining fixture users, review records,
  queue jobs or occupied queue slots; all four processing slots and all 37
  migration records remain intact in the isolated test database.
- The operational database and running main dashboard were not migrated or
  replaced. No commit, merge or deployment is implied by these local checks.

This is local technical evidence, not completion of the five-working-day human
trial, live provider validation, a deployment, or a claim of error-free operation.

## What the worker sees

APTLSS evaluates the worker's assigned tasks and explicitly linked evidence. Its
recommendation includes the next action, reason, prerequisite, retained source and
an estimated time range. Source coverage, freshness, unresolved contradictions and
the strength of support replace an uncalibrated confidence percentage.

Unknown information is not a fact. A stopped timer does not prove task completion.
A worker's explanation is retained as a statement and causes reassessment; it does
not erase contradictory evidence. Source-conflict resolution requires an exact quote
from a current, scoped source revision covering the disputed subject and topic. An
unrecognized statement requires verification rather than speculative execution.

The manager reads only ingested, worker-scoped records. It does not claim complete
access to Gmail, Drive, Trello or any disconnected platform. Evidence must be linked
to the task. Duplicate messages do not become independent corroboration.

Verification questions are grouped by task, urgent first. The worker sees one
consequential question and can expand all remaining blockers and exact source
passages. A source date, observation date and effective date are distinct;
missing dates remain unknown. Selecting a context card switches the question and
submission scope together. Consolidating the display does not resolve any issue.

## Planning and execution boundaries

- Full dates and the worker's timezone govern follow-up eligibility, working days,
  breaks and deadlines. Tomorrow's follow-up is not scheduled today.
- Urgent risks precede ON-HOLD, DOING and TO-DO. Deadline and priority order work
  within the same category. Blocked tasks receive verification or unblocking work,
  not unsupported execution instructions.
- A dependent step remains unavailable until its predecessors actually complete.
- Completed and active blocks, their step IDs and the active timer are protected.
  Completing one step does not discard all other work on the same card.
- Immediately before committing, the manager rechecks source state, timer, worker
  schedule, policy and plan version under a serializable transaction. Changed
  input causes one fresh reassessment; a second conflict leaves the old plan intact.
- Personal duration learning uses completed, non-interrupted execution sessions.
  Waiting and interrupted time are reported separately. Truncated histories are
  excluded from calibration. Prediction error compares actual time with an estimate
  recorded before execution began, not a retrospectively generated estimate.
- Source text is data, never instructions. Optional OpenAI extraction produces
  quoted, structured proposals. Deterministic rules do not treat model output as
  an authoritative decision or allow it to remove safety gates.

## Shadow mode and founder review

`ManagerPolicy.mode` is `shadow` by default, including migrated records. Shadow
cycles save immutable assessments and proposed schedules; they do not change
`daily_plans`, Trello, messages or any other external system.

The canonical platform uses the `admin` role for founder access. Only this role
can record proposal reviews, activate a pilot or restore a manager-modified plan.
Workers can supply statements and choose assessment intervals, but cannot activate
automatic plan changes. Existing external-action approval policies remain in place;
the manager never sends a message itself.

A review records `correct`, `incorrect` or `insufficient`, a source, any correction,
the reviewer and timestamp. Reviews are immutable. The gate requires:

1. Passing fixed safety tests for exactly the current implementation, including
   real MySQL and browser integration tests and at least 100 regression cases.
2. At least five working days represented by reviewed shadow proposals.
3. At least 100 distinct reviewed proposals, with at least 98 of the latest 100
   correct and sufficiently supported.
4. No critical errors and no unreviewed urgent proposals.
5. Only one active worker in the pilot, enforced with a database lock.

Repeated polls and shifted start times do not create independent samples. An
unreviewed repeat cannot manufacture an additional reviewed day. These thresholds
measure the trial, not a 98% guarantee of future correctness. A changed implementation
requires new code-specific proof and reviews. The full gate is checked again before
each automatic write. A critical review returns the worker to shadow mode.

The founder inbox groups repeat occurrences of the same substantive proposal
and pages through 25 entries at a time. Poll timestamps and shifted slots are not
additional trial samples. Reviewed days are measured from actual reviewed
occurrences in the worker's timezone, not from later unreviewed repeats.

Founders may close or restart a trial with an explanation. These actions append
trial events, retain all prior runs/reviews and return the worker to shadow mode.
Closing pauses automatic assessment; restarting opens a new implementation-bound
sample. Historical reviews cannot be reused to pass the new trial.

### Scoped learning

A founder can retain a correction as handling guidance for a specific card, or
for a worker under explicit conditions. Guidance has an expiry of at most 90 days
and exact source fingerprints. Revocation, expiry, source revision or mismatching
conditions prevent reuse. Conflicting or unsafe guidance blocks the affected step
and requests founder verification. Worker statements and model proposals cannot
serve as authoritative correction evidence.

The next assessment displays applicable guidance with its review and source IDs.
This is explicit rule reuse, not model training or a newly established fact. It
does not remove dependencies, resolve source conflicts, grant permissions, send
messages or turn a draft into an external action.

### Plan impact

Every proposed schedule includes a before/after comparison of deadline position,
dependency completion, available buffer and protected blocks. Time ranges remain
estimates; a reserved slot is not proof that work will finish. Unknown inputs are
shown explicitly. A new material risk requires review instead of silently
replacing the executing plan. The retained schedule is the conservative
alternative, with its own known risks still visible.

Applied changes retain their previous schedule. Founder rollback rejects newer
plan edits, live timers, or changes to completed, active or elapsed blocks. It also
returns the worker to shadow mode. If there was no previous plan, no previous-plan
rollback is claimed; the initial proposal remains in the run history.

## Storage and API

Migrations `0033_aptlss_project_manager` and `0034_aptlss_manager_reliability` are
additive extensions after the existing canonical lineage. They add manager state,
immutable runs, worker updates, founder reviews and a single-pilot control record.
Existing evidence, conflict, identity and day-plan tables remain authoritative.
Back up an operational database before applying any migration.

`0035_aptlss_review_learning` adds scoped corrections, append-only trial events and
review lookup indexes. `0036_aptlss_manager_queue` adds durable jobs, deduplicated
event receipts and four global processing slots. These migrations do not replace
the developer's canonical tables or migration lineage.

The existing operator router exposes worker-scoped `getManagerStatus`,
`runManager`, `updateManagerPolicy`, and `submitManagerUpdate`. Founder/admin
procedures are `getManagerReviewInbox`, `runManagerForReview`, `recordManagerReview`,
`setManagerMode` and `restoreManagerPlan`. Conflict proof uses
`resolveVerificationFollowup` with `sourceEvidenceId` and `sourceQuote`.

Founder trial controls are `closeManagerTrial`, `restartManagerTrial` and
`revokeManagerCorrection`; `recordManagerReview` optionally accepts scoped
correction knowledge. These remain founder/admin-only.

After a committed assessment, the authenticated user WebSocket room receives
`aptlss:manager-updated`. The UI refreshes its snapshot, with polling fallback and
visible connection state and data age. This notifies after processing; it is not a
promise of zero-latency provider ingestion.

Scoped evidence writes and worker updates enqueue durable, deduplicated work in
the same transaction. The queue coalesces new events, processes two workers by
default (maximum four), renews leases, retries bounded transient failures and
rejects expired owners before any assessment write. Periodic scanning remains
the fallback for older ingestion paths. Worker status exposes pending, processing,
retry and failure state without exposing lease tokens or another worker's jobs.

A long model response does not restart merely because a minute elapsed. Before
saving, the system rechecks real inputs and recomputes time eligibility and slots
using the current clock. Source, timer, policy, worker schedule, date or plan
changes still require reassessment. No model call occurs inside that transaction.

## Verification commands

Use a disposable MySQL 8 database. Never use the operational database for tests.
The integration suite accepts an explicit loopback URL naming `aptlss_test` or
`recovery_test`; it has no fallback to production credentials. Test fixture identities
are unique, worker-scoped, and removed by the test cleanup.

```powershell
$env:APTLSS_TEST_DATABASE_URL = 'mysql://<test-user>:<test-password>@127.0.0.1:<test-port>/aptlss_test'
$env:DATABASE_URL = $env:APTLSS_TEST_DATABASE_URL
pnpm exec drizzle-kit migrate
pnpm check
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 --fileParallelism=false
pnpm exec playwright install chromium
pnpm test:aptlss-safety
pnpm build
pnpm exec playwright test --config=playwright.aptlss.config.ts
```

Without `APTLSS_TEST_DATABASE_URL`, the real database suite is skipped and cannot
produce a safety attestation. CI supplies its separate MySQL service explicitly.
`test:aptlss-safety` runs database and browser checks and refuses success unless the actual integration assertions pass without skipped browser cases;
mocked service tests do not count as database proof.

The browser suite starts a separate loopback server on port 3035 with provider
credentials removed and scheduled manager execution disabled. Contract fixtures
exercise degraded states; the separate live test uses real login, API and database
state rather than intercepting business responses. No live provider messages are sent.

The ignored `artifacts/aptlss-safety.json` binds automated proof to the source digest.
`pnpm build` produces `dist/aptlss-build.json` with the tested source identity and
compiled backend hash so source-free Docker images can verify that identity. Mount
the matching safety attestation read-only at `APTLSS_SAFETY_ATTESTATION` in the
deployment. A missing, mismatched or stale proof prevents active operation.

## Human acceptance still required

On the tested branch, founder review is available through **VA Management >
Manager review**, including the mobile menu. Select the pilot worker, keep
**Shadow** mode, and review genuine proposals there. Closing or restarting a
trial retains its history; test fixtures must not be used as operational reviews.

Automated fixtures are not genuine worker observations and must never be imported
as successful trial reviews. Run shadow mode on real assigned work for at least five
working days. Robert reviews every urgent conflict and a representative sample of
ordinary proposals, including ambiguous language, changes of agreement and missing
evidence. Review a minimum of 100 distinct proposals before activation is considered.

Live OpenAI quality, connected-provider latency and the five-day human trial require
separate operational evidence. Passing local tests alone does not establish that
APTLSS is error-free or ready for unsupervised real-world decisions.

The local feature branch has not been committed, merged or deployed. Controlled
availability for a real pilot worker, operational backups/migrations and the
genuine shadow trial remain separate steps requiring the appropriate approval.
