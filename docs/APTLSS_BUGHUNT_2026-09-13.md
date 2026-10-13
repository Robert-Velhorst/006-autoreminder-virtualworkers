# APTLSS bug hunt, 13 September 2026

## Scope and preservation

This audit focused on the worker dashboard, APTLSS assessment path, adaptive
Codex subscription transport, and browser request lifecycle. It is not a claim
that every platform feature or live provider has been exhaustively verified.
Changes are in `recovery/joyce-shadow-pilot`; existing uncommitted work and the
main checkout were preserved. No database migration, RBAC change, Trello action,
or active-mode enablement is part of these fixes.

## Findings fixed

1. **Missing evidence did not block execution.** A terminal Codex
   `missing_evidence` result now blocks non-verification actions for the cards
   actually submitted for review and creates durable verification questions.
   It does not block cards outside that bounded review batch. The current signal
   does not identify a particular missing fact per card, so questions explicitly
   ask the worker to identify the required source rather than inventing one.
   Reusing an unchanged assessment retains this gate.
2. **Contradictory transport responses could be accepted.** Replies now validate
   the ordered low/medium/high attempt history against their terminal status,
   selected effort, and output. Cancelled requests are not queued or consumed.
3. **Premature stream completion was accepted.** The parser requires assistant
   output before completion and rejects subsequent events, duplicate completion,
   and unexpected tool activity.
4. **Expired private queue payloads could survive an app crash.** The runner now
   removes expired, identity-validated request/reply files and their temporary
   counterparts. It preserves unrelated files and fresh pending work. This is
   transport cleanup, not deletion of source evidence or database history.
5. **The browser cancelled long assessments after 30 seconds.** Three exact
   same-origin manager POST endpoints now have a 450-second deadline, covering
   the 420-second provider budget plus persistence overhead. Ordinary API calls
   retain 30 seconds. Caller cancellation is preserved; mutations are not retried
   automatically. The second unconditional tRPC timeout was removed.

## Verification completed before rollout

- TypeScript check passed; production Docker build passed.
- General suite: 1,567 passed, zero failed, 68 existing optional tests skipped.
- Separate safety/service/MySQL suite: 715 passed, zero failed or skipped.
- A dedicated browser regression delayed a manager response for 31 seconds and
  verified the loading state and successful completion rather than a timeout.
- The updated host runner completed a synthetic subscription review on Luna low:
  HTTP 200, 6,358 ms, 3,993 input tokens, 139 output tokens. This verifies transport,
  not real-world recommendation accuracy. No paid API fallback was invoked.
- Before deployment: eight saved daily plans, zero applied manager runs. The
  full-plan content hash was
  `1961dbc05856efa3f40c10ad2daefaf257b3b572feefd1ecdcef0b13f6382e99`.

## Boundaries and outstanding setup

- Worker Google OAuth for Gmail/Drive and browser collector pairing remain
  incomplete. These require the intended account/device authorization; tests do
  not substitute for it.
- During a pre-rollout public Settings visit, API parsing briefly received HTML
  instead of JSON. Reloading and subsequent requests returned HTTP 200 JSON.
  The cause was not reproduced or established; this is not marked fixed.
- Shadow-only restrictions remain. The five-workday reviewed trial and active
  mode acceptance criteria still apply; passing these tests does not satisfy
  those operational criteria.
- The model cascade remains Luna low, then medium, then high only when needed.
  The subscription path applies to the APTLSS manager; it does not establish that
  every unrelated AI feature uses the same provider.

## Rollout record

Deployed image: `va-dashboard:joyce-shadow-codex-bughunt-20260913`, digest
`sha256:5ae900ffdf5bdb7b647faab6e3930a75a4846b66e59fc159584ac49e7f9152af`.

- Final frozen-source safety run: 715 tests passed, including 352 fixed
  regression cases; 28 browser tests passed with zero skips. The browser suite
  includes real disposable-MySQL/API workflows and explicitly intercepted UI
  fixtures; neither is represented as a live-provider accuracy trial.
- Safety digest:
  `427c8f711644540eb914b80763d81bdc7f2247085fb9626779e4564f3d111498`.
  Attestation completed at `2026-09-13T19:43:27.273Z` and is retained in
  `.local/pilot/proof-codex-bughunt-20260913/aptlss-safety.json`.
- App-only rollout passed the exact-image/attestation check. The database and
  Redis containers were not recreated. Health returned HTTP 200 with both
  services connected; the app container reported healthy.
- The authenticated public `/worker/settings` and `/worker` pages rendered
  after reload. Observed API responses returned HTTP 200 JSON. The worker page
  displayed a fresh assessment at 19:44:26 UTC, realtime connected, Shadow, and
  Luna low-first/high-maximum. No new browser console error was observed after
  deployment; the pre-deployment transient HTML response remains unresolved.
- Post-rollout saved plans still total eight, with the identical content hash
  listed above. Applied manager run count remains zero.

The preceding adaptive image and proof remain available for recovery:
`va-dashboard:joyce-shadow-codex-adaptive-20260913` and
`.local/pilot/proof-codex-adaptive-20260913`. The updated runner retains its
version-2 adaptive protocol. Recovery must use the matching proof directory and
explicit subscription setting, not a historical generic rollback capture.
