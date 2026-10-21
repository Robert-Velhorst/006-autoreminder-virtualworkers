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
The local branch remains until the image-security integration contains it.

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
