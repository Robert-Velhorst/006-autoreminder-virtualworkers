# Published work checkpoint: 2026-10-21

This checkpoint preserves unfinished work for review. It is not authorization
to migrate an operational database, settle pay, deploy, or enable active mode.

## Included

- Additive financial ledger migration 0009, audit events, financial identity
  constraints, transaction-based settlement and weekly record services.
- Financial route adapters, explicit worker selection on saves, and removal of
  the Home pay chip's write-on-render behavior. Worker switches reset the editor.
- Stable rate-limit policy buckets across route aliases, with HTTP regressions.
- Passive timeline reads: missing analysis is reported, not started by GET.
- Isolated native PostgreSQL fixtures for financial concurrency and migration
  checks. These require a dedicated test URL, not an operational database URL.
- Follow-up: atomic source-marker/D1 transactions, stable replay keys, fresh
  payment-read ownership and required optimistic revisions for founder saves.
  A stale form is rejected rather than overwriting a newer automatic charge.

## Outstanding Before Acceptance

- Execute native financial tests against the guarded isolated PostgreSQL fixture.
- Verify the new atomic reply-monitor integration in native PostgreSQL, including
  source-marker rollback and unchanged-history replay.
- The historical `time_day_reviews` table is globally keyed by date, without
  worker/founder ownership. Its conservative global lock is retained; do not
  infer or invent historical ownership to bypass a locked day.
- Complete explicit analysis preview/quota handling for the remaining legacy
  analysis entry points; passive timeline GET alone does not complete that work.
- Repeat the dedicated financial browser gate in hosted CI; local intercepted
  browser acceptance does not establish real provider or operational behavior.
- Complete independent review and exact-head hosted checks before merging.

## Local Verification

Source checkpoint `751b416` passed the full local Vitest run: 4,477 tests passed,
418 skipped across 378 files. Skips include tests requiring absent database
fixtures; they are not successful native database acceptance. Full project and
database-transfer TypeScript checks, production frontend/backend builds, build
seal, staged Gitleaks and whitespace checks passed. Browser acceptance and live
provider/deployment behavior were not verified in this checkpoint.

The checkpoint is published as draft PR #144, now targeting main after accepted
assignment PR #143 merged. No financial merge, operational migration, or
deployment was performed.

Hosted quality `39553061106` at `02ba5a8` applied migrations and passed the
configured PostgreSQL image stage. It then reported 4,872 tests passed, one
failed and 22 skipped: the native concurrent-increment assertion expected a
numeric string from PostgreSQL JSON, whose actual value was numeric `5`.
The assertion is corrected without removing the retained-increment check.
The failed receipt is not acceptance of this follow-up source.

The follow-up adds fresh payment-read authority, transactional flag/charge
markers, required form revisions, real native rollback/queued-stale-save cases
and a dedicated isolated browser gate in CI. Eight intercepted Chromium tests
passed locally, including worker switching during a save, refusing saves before
loading, stale-form conflict/reload, read-only worker access and no Home writes.
An earlier concurrent browser execution had seven passes and one timeout after
functional assertions; the unchanged quiet run passed all eight in 11.9 seconds.

A broad local follow-up run reported 4,538 passes, three timeouts and 422 skips.
The timeouts were in existing Codex runner process/junction cases and a Trello
shadow status-route case, not financial assertions. That run remains failed;
focused reruns and fresh hosted checks are separate evidence, not a relabeling.
The two unchanged files then passed all 61 tests in a quiet one-worker rerun
(11.24 seconds), without changing assertions or timeouts. This narrows the local
diagnostic but does not turn the earlier full run into a passing receipt.

## Rate-Limit Scan Follow-Up

At source `03fa752`, CodeQL aggregate `119070700006` reported five new
`js/missing-rate-limiting` findings on synthetic HTTP tests. Its SARIF related
locations all identify two calls in the read-probe wrapper: the probe predicate
and the attempt-counting middleware. Neither performs authorization. The
[CodeQL authorization model](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/SensitiveActions.qll)
classifies calls heuristically by names containing `auth`, `login` or `verify`.
The [rate-limit model](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/dataflow/MissingRateLimiting.qll)
then treats such calls as expensive actions; it does not model this custom
counter middleware as a recognized limiter.

The actual helpers are renamed to `isSignInReadProbe` and
`signInAttemptRateLimiter`, with all internal references and verification scripts
updated. No quota, middleware ordering, test assertion, CodeQL query or scan
exclusion is changed. All 25 focused rate-limit tests and TypeScript pass.
This is a documented model correction, not dismissal of an actual authorization
boundary, and requires a fresh aggregate result before acceptance.

Exact source `f7b1007` subsequently passed CodeQL workflow `39554924516` and
aggregate `119072528447`. Its quiet full local suite passed 4,541 tests, with
422 environment-dependent skips. Functional workflow `39554928758` still
failed the manager live-browser gate (88 passed, three failed, three not run).
The logs include HTTP 429 responses: serial scenarios share a worker account's
unchanged 60-per-minute quota even though their test client IPs differ.

The follow-up preserves all quotas and adds typed tRPC throttling responses,
a read-only worker status-reload action respecting the supplied cooldown, and
serial live-fixture pacing using actual reset headers. A mutation completion
timer starts only after dispatch; missing dispatch has a separate bounded
admission wait and does not imply a running server mutation. The new pacing
helper and its tests participate in the source safety digest. No failed run is
reclassified, no mutation is automatically retried, and fresh exact-head
browser/database acceptance remains required before merging PR144.

Separately, PR135 source `192a4dc` passed its real image scan in workflow
`39556533820`: zero HIGH/CRITICAL findings, zero exceptions, one MEDIUM finding.
Runtime and isolated PostgreSQL image acceptance passed for the same image.
That older security-branch image is not acceptance of the financial source,
the complete workflow, real providers or a Hetzner deployment.

## Accepted Financial Source And Image Integration

PR144 was accepted at `c43dee70fadc49522fc4c3fe42285bc37cb5ecb2` and normally
merged as `b92be39f88d66e4f53fae782900b70705f9ade90`. Both trees equal
`12ed4cfa58c5f3a35da0f144ff92d5b65c26c279`. Quality `39557268165` and CodeQL
`39557267429` plus its aggregate passed: 4,952 Vitest tests with 22 skips,
99 Node contracts, all 29 native financial cases, eight financial browser
cases, 1,041 manager service tests and 97 manager browser cases. The acceptance
also includes configured PostgreSQL image checks and isolated backup/restore;
it does not prove the live data cutover, providers or human shadow trial.

The accepted head is preserved under the verified annotated remote tag
`archive/financial-authority-acceptance-20261021`. Its remote development branch
was deleted using its expected full SHA after archive and merge-tree comparison.
After image-security integration merge `be5eea6` contained it, guarded local
branch deletion also succeeded; no forced deletion was needed.

PR135 separately passed full quality `39557333508` at `f391013`, including
a real zero-finding image report without exceptions. The current integration
retains both financial and image-security Node contracts, the scoped compiler
peer removals and the final-stage zlib patch. It must pass fresh exact-head
checks before its own merge; neither predecessor receipt accepts the combined
source automatically.

## Cleanup Boundaries

Only source, tests and documentation are published. Private environment files,
credentials, database exports, backups and local operational data are excluded.
The local Docker inventory timed out; images and volumes were not proved unused
and were not deleted. The execution policy rejected temporary scan-directory
deletion before execution. No bypass or reclaimed-space claim was made.

## Accepted Image Integration And Analysis Follow-Up

PR135 exact head `cba207691700f51b5e88690eeb0cbfa0babac5b5` passed quality
`39560277949` and CodeQL `39560273868`. The real image scan reported 633
packages, zero findings and zero exceptions. Configured PostgreSQL image checks,
the complete manager browser gate and isolated backup/restore passed. This is
source/image acceptance, not a Hetzner deployment or live provider receipt.

The normal merge is `0e18557d45452f5ef1812955eb55f959ebf822d4`; its tree and
the reviewed head both equal `56c4fa7fd3fee89d0cc38b1b9e4dbf770c9b58bc`.
The verified annotated archive is `archive/exact-image-security-20261021`.
The matching remote branch was removed with an expected-SHA lease and its local
branch with guarded deletion. Unfinished analysis work was not discarded.

The next source checkpoint adds [confirmed card analysis](CARD_ANALYSIS_ADMISSION.md),
additive migration 0010, per-card durable outcomes, explicit continuation and
sealed maintenance tools. Its new source requires independent exact-head CI,
including native PostgreSQL and browser acceptance. Four outdated old-contract
assertions failed the first broad local run; that failed run is retained as a
diagnostic, not relabeled as acceptance by focused reruns.

After those test contracts were updated, the broad local command passed 4,740
Vitest tests with 437 skips, followed by 291 Node passes and three skips. The
final UI attribution follow-up additionally passed its 69 focused unit tests
and the complete 15-case intercepted Chromium suite. Project and transfer type
checks, full production build/seal and migration metadata regeneration passed;
regeneration reports 142 tables with no drift. Both compiled maintenance tools
passed help and missing-owner rejection with no database/provider configured.
These local receipts do not execute the new native PostgreSQL cases or verify
a live provider. Their exact-head hosted gate remains required.

## Accepted Confirmed Analysis

The first hosted run `39564144161` at `59bfd64` passed native/schema/image gates
but failed three older Home browser cases that expected automatic analysis.
Those scenarios now exercise preview and explicit confirmation, retaining
duplicate-start, completion, reload and rejected-request safeguards.

Exact source `ce2f95cf61e675939363eee76e284e0324d8db5a` then passed quality
`39565591698`, CodeQL `39565587914` and the aggregate. Receipts include 5,156
Vitest passes with 22 skips, 294 Node passes, five Home browser cases, 13 digest
recovery cases, eight financial cases, 15 confirmed-analysis cases, 1,044 manager
service cases and 97 manager Chromium cases. These gates can overlap and are
not additive coverage claims. Backup/isolated restore and metadata parity passed.

The image receipt reports 633 packages, zero vulnerabilities and no exceptions
for `sha256:85936ef8aefe2e9e8a1ac633f7c779185dfcf9bdf5841abc5fc248712d0896e5`.
Configured PostgreSQL acceptance used that same image with confirmed cleanup.
Normal merge `820ee121fb137b122727560b9e0deeab71a44bfb` has the exact reviewed
tree `c6f3ce1635fdefc92a3e03895200590d02850376`. The accepted head is retained
under `archive/atis-admission-acceptance-20261021`; matching development refs
were removed only after archive and merge-tree verification.

## Subsequent Production Follow-Up

The follow-up corrects persisted worker calendar precedence and prevents
unsupported timezones from silently importing Bangladesh holidays. Existing
stored calendars were not rewritten; suspected historical imports require
source-aware review before cutover. It also adds the general subscription
transport, self-contained private bridge packages, caller authority fencing and
subscription-aware admin status. See [bridge boundaries](CODEX_SUBSCRIPTION_BRIDGE.md).
This changed source requires new exact-head hosted acceptance; predecessor
receipts do not accept the new transport or authority changes automatically.

Local native PostgreSQL acceptance used one temporary, labelled PostgreSQL
18.6 container, loopback-only networking and tmpfs storage with no persistent
volumes. The extended first run passed 19 cases and failed one ownership check.
That failure exposed an untyped PostgreSQL CONCAT parameter in the assignment
prefix guard. The corrected bound-prefix comparison retains the guard. The
subsequent run passed all 20 cases across admission, generation-reader and
interview-authority integration suites. Container cleanup was confirmed after
each run. Trello and inference boundaries were synthetic; this does not prove
live provider access or a production database deployment.

The broad Windows run subsequently passed 4,885 tests but failed two generic
subscription transport cases, with 442 skips. A dispatch-file replacement
collision was observed. This failed run is diagnostic evidence, not acceptance;
per-attempt immutable transport files require fresh focused and broad checks.

After the immutable per-attempt fix, the fresh broad local run passed 4,889
Vitest tests with 442 skips, followed by 315 Node passes and three skips.
Project and transfer typechecks, the complete production build/seal and schema
metadata regeneration passed (142 tables, no drift). Chromium repeated five
Home lifecycle and 15 confirmed-analysis scenarios with intercepted APIs.
These browser fixtures do not exercise live providers. The bridge build also
probes the self-contained bundles outside the source/dependency tree, including
both transport heartbeats and confirmed shutdown without authenticating a
Codex account or executing inference.

The full-directory secret scan reported six pre-existing matches: four schema
contract hashes and two synthetic request UUIDs in an unchanged router test.
They are not operational credentials. Publication still requires a clean scan
of the staged changes and new exact-head hosted quality/image/security gates.

A fresh local Docker Desktop inventory now responds. No containers, tagged
images or named/project-labelled volumes identify VA Dashboard, Joyce, APTLSS
or this repository. Unattributed resources and other projects were not deleted;
this is not a claim that every anonymous object can be attributed or removed.
Six local worktrees were inspected: no loose source edits were found outside
the active follow-up; private session state and test artifacts were not uploaded.

## Batch And History Authority Follow-Up

The subscription/calendar/authority source was published as PR #146 at
`dd23e75df25e229a3acaa0d153ecc4ddc34e9061`. The CodeQL analysis workflow
`39572287153` completed successfully, but its aggregate check subsequently
failed on three findings. Successful scanner execution is not a clean security
verdict. The findings remain unaccepted at this checkpoint; no gate was bypassed.
Quality `39572287982` remains in progress at this checkpoint. Its retained
image report identifies `sha256:23f3fa96416605a5d1dd70604d6c1d48c4d1260440e0d105759b64af6baa4e59`:
639 packages, zero vulnerabilities, no exceptions. Configured PostgreSQL
acceptance passed on that same image with confirmed cleanup. These partial
receipts are not full quality acceptance or permission to merge yet.

A separate read-only review then confirmed two remaining manual-generation
gaps: batch/retry calls omitted the request-actor context, and history/retry
queries did not scope their parent job to its creator. The separate local
follow-up must preserve the published PR #146 head while correcting these paths
and proving both cross-founder isolation and in-flight revocation. Do not infer
that scheduled-job approval or deleted/recreated-account lineage is accepted
from these bounded checks.

The first real extended PostgreSQL run passed the previous 20 cases but failed
all nine new cases during setup with SQLSTATE 22001: the existing terminal value
`completed_with_errors` has 21 characters while `generation_jobs.status` allowed
only 20. `scheduled_jobs.status` had the same mismatch. Migration 0011 widens
both columns to 32, retains all existing rows, and advances the readiness ledger
requirement. The failed fixture was removed with cleanup confirmed and no
persistent volumes. The new migration and route cases require a fresh native
run; the failed setup is not acceptance of either route or status persistence.

After migration 0011, the next native run passed 30 of 31 cases. Its remaining
failure was an incorrect test expectation: a source containing only a task
description conservatively caps its evidence score at 72 and needs review. The
test now verifies that real result and its persisted `needs_review` state;
validation was not disabled. The fresh subsequent run passed all 31 cases
across four files, including partial-error status persistence and both-founder
isolation. Each temporary container was removed, with no persistent volumes.

The mounted-page retry browser suite passed 15 Chromium scenarios with
intercepted API responses. It checks real errors, in-flight duplicate
submission, unknown outcomes and disjoint completed/review/failed counts. A
missing legacy review count is explicitly unreported, not assumed zero.
Project typecheck and the complete production build/seal passed. The suite is
included in CI after Chromium installation. Live-provider acceptance and a new
exact-head hosted gate remain required for this additional source/migration.

The independent follow-up review also found that a fresh retry child ID could
escape an earlier child's uncertain-outcome marker when the original parent
was submitted again. The initial 31-case passing receipt does not cover that
original-parent replay/concurrency problem. Stable child identity and durable
serialization require additional native regressions before publication.

The local bridge-root follow-up now confines the selected launch root as well
as its queue/private directories. An outside launch root is rejected even when
explicit transport directories are inside the workspace. Eighteen focused
filesystem/bridge lifecycle cases passed; a fresh hosted security analysis is
still required. No CodeQL findings were dismissed during this source change.

The stable retry follow-up now binds one child to the owner/original parent,
serializes work with the existing durable manual lease, and checks its actor,
membership and settings manifest before replay. The fresh native run passed
all 33 cases, including repeated original-parent submission after an uncertain
Trello mutation, a concurrent contender receiving 409, and completed replay
without another inference/provider call. Cleanup was confirmed with zero
persistent volumes. Independent source review found the reported replay fence
closed; it did not execute tests or accept unrelated production paths.

The final broad local run after stable retry serialization and bridge-root
confinement passed 4,915 Vitest tests with 455 skips, followed by 315 Node passes
and three skips. The native 33-case run was separate and executed, not inferred
from those skips. Project typecheck, full build/seal, staged secret scan and
whitespace checks passed. Migration metadata regeneration found no drift;
snapshot comparison changes only the two intended status widths plus normal
snapshot identifiers. This is local source acceptance, not a passing new hosted
security aggregate, target deployment or live-provider/operator acceptance.
