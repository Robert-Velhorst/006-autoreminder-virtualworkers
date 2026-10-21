# Scheduled Generation Approval

## Boundary

A scheduled generation job needs both an execution lease and current creator
authority. A lease prevents overlapping workers; it does not grant administrator
permissions. Approval binds the canonical creator account, its global session
epoch and the reviewed schedule inputs. Source cards and client-supplied settings
cannot provide that proof.

Migration `0012_scheduled_generation_approval` adds nullable creator, epoch,
approval time and input-hash fields. Existing rows remain unchanged and unbound.
The database requires either a complete valid approval tuple or four NULLs.
Readiness requires the exact migration ledger entry.

The input hash detects changes to the approved revision. It is not a secret,
digital signature or substitute for authentication, and cannot protect against a
trusted database administrator rewriting the underlying records.

## Operator Flow

- Review the selected cards, generation options and future execution time before
  creating a schedule. The server records approval under fresh administrator
  authority in the same short transaction as the job.
- An unbound or no-longer-authorized schedule requires explicit review. Its
  history is retained; the worker must not infer approval from an old OpenID.
- Reapproval reviews the stored inputs and chooses a future execution time. A
  changed preview requires another review, not an automatic POST retry.
- Cancelling pending or held work must not be presented as cancellation of a
  request already accepted by an external provider.

Ordinary single-session sign-out does not itself change the global account
epoch. Password/global-session revocation or an authority change invalidates
the old proof and requires deliberate reapproval. No operational account or
historical schedule is migrated into approved status automatically.

## Execution And Recovery

The worker must recheck the creator account, role, epoch and approved inputs
before inference grants, checklist mutations and successful persistence. It
reuses supplied transaction readers and does not hold account locks across
provider waits. Authority loss and execution-lease loss are different outcomes:
neither permits further provider work, and an old worker cannot overwrite a new
approval or claim completion.

Reapproval does not clear completed items or uncertain Trello outcomes. Existing
generation-history and retry fences remain authoritative. Checks cannot undo a
network operation already accepted before revocation; preserve uncertainty and
require source reconciliation instead of silently repeating it.

## Verification

This document defines the contract, not production acceptance. Required evidence
includes native PostgreSQL approval/revocation/concurrency cases, mounted browser
creation/review/cancellation flows, unchanged-owner success and retained
uncertain outcomes. Hosted exact-head checks, real provider and target-host
acceptance, data reconciliation and the human shadow trial remain separate.

### Local Checkpoint: October 21, 2026

- Native PostgreSQL 18.6: 45 cases passed across five migrated integration
  suites, including an actual row-lock wait during concurrent reapproval,
  revoked creator authority, and orphan recovery retaining uncertain outcomes.
  The disposable database container was removed; no persistent volume was used.
- The same 45 cases passed on PostgreSQL 17.11. Its temporary container and
  newly downloaded image were removed, including an image-ID absence check.
  This is compatibility evidence, not a query against the shared production DB.
- Broad local tests: 5,003 Vitest cases passed, 467 skipped; the separate Node
  suite passed 315 cases with three skips. Skipped cases are not acceptance.
- Repository and database-transfer type checks passed. Schema regeneration
  reported no drift across 142 tables. Migration 0012 remains additive.
- Final mounted Chromium checks: 54 passed, no skips, covering scheduling and
  existing history retry flows. Light/dark mobile and desktop checks use the
  real theme/toast providers and verify unobscured keyboard-reachable actions.
  Structured goal previews preserve nested business content; incomplete,
  oversized or excluded technical content blocks approval rather than silently
  hiding functional inputs.
- The final production build passed. The staged-change secret scan found no
  leaks. These local receipts do not accept inherited open CodeQL findings.

Browser fixtures intercept providers and use synthetic accounts. Native database
fixtures use real PostgreSQL but synthetic CLI/Trello responses. Neither proves
live provider access, target-host readiness or a completed operational trial.
