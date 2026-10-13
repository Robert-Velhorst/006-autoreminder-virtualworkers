# Worker Dashboard Repair: 2026-09-13

## Verified Starting State

The running deployment was the September 6 shadow-pilot semantic image, healthy
at the existing ngrok address. The user's authenticated worker session exposed
a real failure: Today showed unavailable manager status and an empty work queue.
Browser logs reported request timeouts. Batched tRPC transport coupled unrelated
reads, so a slow manager query also prevented work, timer and context results.

The read-only production diagnosis found 1,754 manager runs, 73 distinct proposal
hashes and zero applied plan hashes. The most recent ten retained semantic
reviews were successful. This supersedes the September 6 observation that no
semantic response had yet been accepted. It does not mean human acceptance has
been completed, or that every assessment invokes the model anew.

The original September 6 daily-plan fingerprint no longer matches the current
database. That historical comparison is not evidence of a manager plan write:
the separate run audit found no applied plans. Existing intervening records
must be preserved, not reverted to make an old fingerprint pass.

## Changes

- Worker status no longer recalculates full acceptance history during each poll.
  Its existing current-state, latest-run and queue reads remain worker-scoped.
  The acceptance gate remains in the founder/admin review inbox; shadow-only
  execution controls are unchanged. No client consumed the removed status gate.
- Browser tRPC requests use independent HTTP requests, retaining cookies,
  cancellation, finite deadlines and the existing query cache. A slow request
  cannot hold unrelated responses hostage in a batch.
- Day-plan heuristic percentages are no longer displayed as confidence. A
  protected day is labeled as such; other advice remains uncalibrated.
- Regression coverage checks the bounded status read, transport wiring and
  probability presentation. A browser test holds a Trello read pending and
  requires the manager status to render before that request is released.

The repaired status read against the real database took 1,171 ms, including
module loading, and returned the existing 1,881,751-byte snapshot. The previous
acceptance-history query exceeded the explicit 20-second diagnostic limit.

## Verification And Boundaries

TypeScript passed. The complete general suite passed 1,501 tests with 66 opt-in
database tests skipped. Production Docker build passed. The separate current-source
safety gate passed 344 regression cases, real MySQL integration and 24 browser
tests. The browser fixture was updated to decode both batched and independent
request envelopes before the entire gate was rerun successfully. This does not
claim that all 66 optional tests from the general suite were executed.
No database migration, credential change, auth bypass, commit, merge or push is
part of this repair. The existing main checkout and other services are untouched.

## Live Deployment And Verification

The application-only replacement completed at 2026-09-13 17:10:17 UTC:

- Image tag: `va-dashboard:joyce-shadow-dashboard-20260913`.
- Image ID: `sha256:bc3b368be9be5c39fa0b2c608378ffdc4a34cc395eecb7e87cc413b0b7bea358`.
- Safety digest: `2dc69eef976951f4d148395a856a3edb7bc6ce2eedefbcdbfb858019913efea5`.
- Proof directory: `.local/pilot/proof-dashboard-20260913`.
- Previous September 6 image remains available for application rollback.
- Runtime environment values were unchanged; local and public readiness returned 200.

In the existing authenticated worker session, Today loaded 49 cards (6 ON-HOLD,
12 DOING, 31 TO-DO) and 18 decisions. The manager displayed Shadow and 49 assessed
cards. The observed dashboard data requests all returned 200. Card details opened
and closed successfully. Desktop and 390px mobile checks found no horizontal
overflow. The viewport override was reset. The day-plan page displayed Protected
day with no new console errors during the post-deployment check.

The first new-source automatic assessment, run 1756 at 17:11:23 UTC, retained
shadow mode and a proposal with no applied plan, but reported semanticSuccess=false:
"Semantic review unavailable; deterministic assessment remains active." Its
specific provider/validation failure cause was not established in this repair.
Earlier retained successful reviews are not proof of current fresh-model success.
Resolving this semantic review failure remains necessary before active acceptance.

Remaining work is explicit: acceptance-history aggregation still needs a scalable
indexed read path for the founder review surface; the large current snapshot
would benefit from separately loaded detail. The worker route fix must not be
represented as a complete production audit or active-mode acceptance.

Other observed follow-ups, outside this focused loading repair:

- Google evidence and the browser collector are not connected for this worker;
  the live Evidence page explicitly reports setup required. Do not borrow a
  different user's authorization to conceal that gap.
- Reminder records load, but the visible active queue presents far-future dates
  first. Prioritization should be reviewed without rewriting source due dates.
- The plan-generation progress UI is elapsed-time based rather than reported
  backend stages; it should not imply measured percentage completion.
- Empty/loading/error distinctions and drill-down for unscheduled plan counts
  need further UX verification beyond the timeout repair.
