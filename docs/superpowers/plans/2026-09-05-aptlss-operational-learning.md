# APTLSS operational learning and reliability

Approved scope: six follow-up improvements after the reliability implementation.
Work only in the existing isolated feature worktree. Do not deploy, merge, send
provider messages or alter the operational database. Preserve the canonical
developer platform, worker scope, immutable evidence and shadow-mode gates.

## Execution ledger

- Implemented and verified: database initialization and cache stability. The
  complete repository suite passed 1,246 tests with no failures or skips against
  disposable MySQL, including the final mobile navigation and fixture corrections.
- Implemented and database-verified: deduplicate the founder review queue, prioritize urgent work,
  remove the raw-run capacity trap, and add history-preserving trial restart.
- Implemented and database-verified: use explicitly scoped, source-supported founder corrections in
  subsequent assessments without converting exceptions into global rules.
- Implemented and database-verified: durable event-driven worker assessment queue with bounded
  concurrency, leases, retries, urgent priority and periodic fallback.
- Implemented and focused-verified: one consequential verification question per
  task, exact scoped source comparison, separate source/observation timestamps,
  and progressive disclosure preserving all blockers. Eight unit scenarios pass;
  the final combined desktop/mobile browser run passed.
- Implemented and focused-verified: proposed-plan impact comparison including deadlines,
  dependencies, buffer and a conservative alternative.
- Verified: additive migration apply/rerun/parity and no generated schema drift.
- Verified: 599 APTLSS tests in the full repository run, including real MySQL
  integration, with no failures or skips after the final corrections.
- Verified: final typecheck and production build.
- Verified: combined safety gate, 599 APTLSS tests and 23 browser checks with no
  failures, skips or retries; eight browser checks use real login/API/MySQL.
- Verified: the safety attestation matches the current source and built backend.
- Verified: test cleanup leaves zero users, reviews, jobs and occupied slots,
  while preserving all four queue slots and 37 migration records.
- Not performed: commit, merge, deployment, live-provider qualification or the
  genuine five-working-day, 100-human-reviewed-proposal operational trial.

## Verification and limits

The shared Docker test path became unavailable. A disposable native MySQL 8.4
runtime was started on loopback port 33317 without restarting Docker or touching
the operational database. Full canonical migrations through 0036 and an
idempotent rerun passed there. The real database suites passed against
this isolated runtime. A timestamp-precision migration defect was found and
fixed before the queue tables existed; no migration journal history was rewritten.

Write failing focused tests before implementation. Final tests must exercise the
connected path, worker isolation, stale evidence, retries, duplicate events and
policy gates. Live provider quality and the five-working-day, 100-reviewed-proposal
shadow trial require actual operational observations; fixtures cannot stand in
for them. Record remaining external acceptance gates separately from code proof.

Ruling: revisions to the trial do not delete past runs or reviews. Learning is
task-scoped by default and never grants authority to send or unblock contradictory
evidence by itself. Source-change checks must include applicable correction state.
