# Dashboard Reliability Repair - 2026-09-13

## Scope And Boundaries

Continuation of the September 13 loading repair in the isolated shadow-pilot
checkout. Canonical main, authentication, worker ownership and active-mode
prohibitions remain unchanged. No Git commit, merge or push is included.

## Confirmed Cause Of AI Failure

A single diagnostic of the configured manager request received HTTP 429 from
OpenAI, model gpt-5.2, code credit_balance_exhausted and type insufficient_quota.
This was not a missing-key or response-schema error. Credit purchase requires
the account owner. No billing settings were changed and no credit was purchased.

The application now distinguishes exhausted credit, rejected credentials/model
access and transient rate limits without copying raw provider messages. Exhausted
credit imposes a durable six-hour automatic retry delay. An explicit manual retry
after at least one minute permits recovery after the owner restores billing;
scheduled work cannot bypass that delay. The worker sees AI review unavailability
without opening source details. Deterministic checks remain active in shadow mode.

## Historical Read Performance

Additive migration 0046 derives read-only reviewDigest and reviewUrgent columns
from the existing snapshot JSON, with a covering review index. No source records
are rewritten. Review grouping retains implementation, trial, worker, urgent and
critical-review boundaries. Generated metadata also covers writes from the prior
application image, so rolling back the application does not create a backfill gap.
The migration guards each addition for safe replay. The canonical migrations and
0045 snapshot remain intact; a new Drizzle-generated 0046 snapshot follows them.

Timing calibration avoids loading the last 100 full dossiers when there are no
completed timing observations. When observations exist, each dossier is parsed
once rather than repeatedly for every observation.

## Worker Experience

- Active reminders sort earliest due first; completed history remains newest first.
- Card details label heuristic assessments uncalibrated, without a target percentage.
- Pending plan generation shows actual elapsed time and an unavailable ETA instead
  of fabricated stages, completion percentages or a countdown stuck at one second.
  Backend-reported stages and a calibrated ETA are still future work.
- Plan loading errors are distinct from an empty saved plan. An uncertain mutation
  response asks the worker to reload before retrying rather than claiming no write occurred.
- Decision and unscheduled-plan specifics are available through disclosures.

## Browser And Google Connections

The Google connect route was verified to reach Google's account chooser with
gmail.readonly and drive.metadata.readonly scopes. The user must sign in with the
appropriate worker-authorized account and approve access. No other user's token
was copied and no Google permission was granted by this repair.

The browser extension was missing from the recovered platform. Popup and options
markup were adapted from archive/joyce-operator-current-2026-07-29, source commit
549b93291426a20a44a69642461285c563b51f42. The collector and pairing code were adapted
for the current authenticated worker endpoint rather than restoring obsolete
automatic token retrieval. Source ownership is preserved in this record.

The extension is packaged at /downloads/worker-browser-collector.zip. Worker
Settings includes its download, installation and pairing path. Pairing is explicit
and host access is requested for the selected HTTPS or loopback dashboard only.
Reporting is disabled until enabled by the user. It sends tab IDs, domains, pinned
state, active state and window IDs, not titles, URL paths, page contents, URL query
strings, fragments, credentials or browsing history. Incognito tabs are excluded.
Over 250 reportable tabs causes an explicit failure, not a partial compliant count.
End-of-day warnings use the existing server policy. Closing selected tabs still
requires confirmation. No extension was silently installed in a real browser.

Repackage extension source changes on Windows with scripts/package-browser-collector.ps1;
the credential-free ZIP is a public static build asset. This is an unpacked local
extension, not a Chrome/Edge store publication.

## Database Recovery Proof

Full backup: .local/pilot/operational-2026-09-13T17-38-24-705Z.sql,
3,742,609,825 bytes, SHA-256
f254f804f21571da8898b31929b7afa948f1193624d0f659203e416393955992.
The backup helper now verifies its stream without loading a multi-gigabyte file
into memory. No backup was removed.

Restored to the dedicated loopback test database
aptlss_review_rehearsal_20260913195500. Migration and rerun passed; record counts
in 131 tables and the complete manager snapshot hash were preserved. Indexed
lookup measured 4 ms on that restored dataset. Full proof:
.local/pilot/aptlss_review_rehearsal_20260913195500.json.

## Verification

General suite: 1,508 passed, zero failed, 67 optional database cases skipped.
The real-MySQL review-index test separately checks preserved old snapshots,
new writes, missing legacy digest, idempotent migration and a covering query plan.
TypeScript and production image build passed. Exact-image shadow safety and live
cutover evidence are recorded below after completion; local tests alone do not
prove Google authorization, installed browser collection or restored API credit.

## Live Cutover

The final safety gate passed 663 tests with no pending cases and 26 Playwright
tests, including 345 fixed regression scenarios. Attestation verified at
2026-09-13T18:00:30.267Z; source digest:
43cfb09268905fb55584c986069f39f1b490d987038625397b21832e7762818f.
This is shadow-pilot evidence, not acceptance for autonomous execution.

Live migration 0046 completed successfully; the operational ledger now contains
49 entries and the new covering index is present. Only the application container
was recreated with va-dashboard:joyce-shadow-reliability-20260913, image digest
sha256:df6ff2a8b76ab38163ac34c96133ef0175687f45eef842935c77d8f61a97109c.
Previous image va-dashboard:joyce-shadow-dashboard-20260913 and its proof directory
.local/pilot/proof-dashboard-20260913 remain available for application rollback.
Use the compose helper's deploy operation with that image/proof, not its generic
rollback operation which points to the older pre-pilot baseline. The additive
generated columns can remain when the previous application is restored.

At 2026-09-13T18:06:53Z both loopback and the existing public /api/health returned
200, with database and Redis connected. The public collector ZIP returned 200
with application/zip. A read-only live gate check completed in 878 ms; 1,764
manager runs existed, zero had appliedPlanHash, and activation remained ineligible.
The operational checker still compares daily plans against a September 6
checkpoint; its changed-plan flag is not evidence of changes by this deployment.

Authenticated public-browser checks passed for Today (49 assessed cards), the
protected-day plan, expanding/collapsing all 49 unscheduled details, worker
Settings, and earliest-first active reminders. Desktop and mobile Settings
screenshots were inspected; no horizontal overflow was observed at 1280 or 390
pixels, and mobile light and dark themes were checked. Original theme and browser
viewport were restored. Two WebSocket errors were captured during the container
restart, before the new-page verification; the reloaded page reconnected.

Outstanding operator actions: restore OpenAI API credit, complete Google login
and consent for this worker, and explicitly install/pair the browser collector.
No real Google ingestion, real-browser report, paid AI recovery, or new live plan
generation was claimed or triggered as part of browser QA. Exact generation ETA
is still unavailable; the UI now says so instead of inventing progress.
