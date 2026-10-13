# Controlled APTLSS Shadow Rollout

## Authorized Scope

Robert requested the shadow trial on the existing dashboard, selecting the
existing Joyce worker (user 2, profile 1). Keep the canonical developer platform,
founder/admin/worker permissions, current functionality, and operational history.
No active automatic planning or outbound messaging is authorized by this rollout.

## Integration Boundary

The `recovery/joyce-shadow-pilot` worktree began at main `dc64c96`, then received
a file-for-file snapshot of the current main worktree, including unpublished
improvements and deletions. The original main worktree is not edited. Only
subsystem-specific APTLSS additions are adapted from the tested
`feat/aptlss-shared-evidence-engine` worktree; it must not replace the platform.

The operational migration history contains additions from both older lineages.
Canonical migrations are retained. New additive migration work must tolerate
already-present evidence/manager tables without dropping or relabeling records.

## Gates

- [x] Confirm existing Joyce identity and assigned work using read-only checks.
- [x] Preserve current main source in a separate integration worktree.
- [x] Produce and verify an operational database backup and rollback image.
- [x] Integrate backend, founder review, and worker status additively.
- [x] Enforce worker-2-only and shadow-only server deployment controls.
- [x] Rehearse migrations on a restored isolated database and verify preservation.
- [x] Run consolidated type, unit/integration, build, and browser checks.
- [x] Deploy the verified build without changing the public URL or credentials.
- [x] Verify a genuine operational shadow assessment and unchanged daily plans.
- [ ] Verify the authenticated operational UI after Robert signs in (isolated authenticated browser tests passed).

## Boundaries

Automated test fixtures do not count toward the five-working-day, 100-reviewed-
proposal acceptance trial. The trial starts only with actual operational
availability. No reviews are recorded on Robert's behalf. Active mode remains
disabled even if historical settings or a direct API request ask to enable it.

The previous container image and SQL backup are retained. Rollback restores the
previous application image; additive schema changes are not destructively rolled
back. A full database restore is only a separate recovery operation, not an
automatic reversal that could erase later worker activity.

## Backup Evidence

On 2026-09-05 the complete operational SQL export finished successfully (12,501,536
bytes; SHA-256 `33fd77945dfd7cc011a4701b77214b23fb42a3f1ec368eb70cd621b5b8b3bbad`).
The export was restored successfully into `aptlss_pilot_rehearsal` on the separate
native test server. Original-column row fingerprints were captured for all 124
preexisting application tables; 47 migration ledger rows were retained separately.
This initial backup was followed by a fresh cutover backup described below.

Rollback image observed before rollout:
`sha256:7de4148fe2032b5a2c9183ca28f823864260e4363d9484c55cc5040a91adb674`.
Sensitive SQL exports and detailed manifests remain in ignored `.local/pilot`.

## Integration Verification In Progress

Both migration paths passed: the restored operational lineage and a fresh canonical
database. All 46,321 original rows across 124 tables preserved their hashes.
The first backend safety run passed 644 tests including 59 real MySQL assertions.
After the final backend review fixes, 654 backend safety tests passed without
failures or skips. Direct TypeScript checking also passed.
The first production frontend build passed. These intermediate results do not
constitute the final release gate after review fixes.

The browser gate exposed development CSP blocking Vite's inline refresh preamble.
The development-only correction retains strict production CSP. A legacy test that
queried an unrelated localhost:3000 service is being replaced with isolated route
tests. Final review additionally requires authoritative trial closure, canonical
automatic model resolution, valid reasoning-response metadata handling, and bounded
retry of transient semantic failures. These fixes passed a second read-only
review. The browser assertion for missing semantic review now also recognizes
the explicit bounded-retry state, requiring unsuccessful review and visible
coverage limits rather than treating deferred analysis as success.

The final browser-only run passed all 23 tests without skips: eight real
login/API/MySQL scenarios and fifteen intercepted UI contracts. Desktop dark,
desktop light, and mobile light flows preserved the operational plan, retained
worker context and founder reviews, and rejected active-mode requests. The
initial WebSocket HTTP 400 was reproduced as a missing test-origin allowlist;
the launcher now permits only its explicit loopback origin, without changing
production origin/authentication controls. Frontend and backend production
builds and build sealing passed.

The final uninterrupted safety command passed with 341 regression scenarios,
real MySQL integration and all 23 browser tests. The resulting shadow-only
attestation records source digest
`bb02ec0215afad5ca7a7ea54eb48afb06a5e969e36b79ba8b3cdf240e0e7c440`.
The complete repository suite passed 1,495 tests. Its 66 opt-in database tests
were exercised separately: 59 by the safety command and seven by the final
migration rehearsal (all passed, none skipped). A fresh TypeScript check passed.
The queue pending-age test now uses a controlled clock instead of a flaky
wall-clock delay; production queue behavior is unchanged. These are local
verification results, not remote CI or active-mode acceptance. No operational
human review was fabricated.

## Runtime Recovery

On 2026-09-06 Docker inspection and the existing dashboard readiness endpoint
stopped responding within bounded timeouts. No operational migration, container
replacement, or shared Docker restart has been performed by this rollout.
Robert authorized a Docker restart. Docker initially recovered without one, but
after the temporary read-only environment interruption it again failed to resolve
its internal proxy. The authorized Docker Desktop restart completed around
2026-09-06 09:30 UTC. Containers whose recorded stop times matched that restart
were resumed, including the existing dashboard, HAI, LARO and running test
databases. Previously stopped applications were not started. The build then
completed successfully using the normal Dockerfile and frozen dependency lock.

## Operational Cutover: 2026-09-06

Only the dashboard application was stopped for the migration. Before changing
the database, the exact candidate image matched the completed shadow safety
attestation and its compiled bundle hash was verified offline.

- Fresh backup: `operational-2026-09-06T09-32-18-506Z.sql`, 12,685,719 bytes.
- Backup SHA-256: `c9a684be34314f3e95e953283e2afd4b1dc8254c4d67decc6fc93377eb779cb0`.
- All 47,187 original rows across 124 tables matched their original-column
  fingerprints after migration and before application startup.
- Migration ledger: 48 records, with additive `0045` applied.
- Live image: `va-dashboard:joyce-shadow-pilot-20260906`;
  `sha256:d348918c751577b2b128472177fafdc00aca14d281c6c1343d6d145a69b2bbab`.
- Runtime verification: healthy, existing environment/credentials preserved,
  production authentication enabled, `LOCAL_AUTH_BYPASS=false`, worker ID 2 only.
- Local and existing public readiness endpoints both returned HTTP 200:
  `http://127.0.0.1:3025` and `https://joyce-va-dashboard-006.ngrok.app`.
- First real periodic assessment: run 1, 09:33:02 UTC, worker 2, shadow mode,
  proposal retained, no applied plan hash. All saved daily plans still matched
  the pre-cutover fingerprints afterward. Default interval: five minutes.
- Second automatic assessment: run 2 at 09:39:00 UTC, also shadow-only with
  unchanged saved plans. The one-minute fallback poll adds scheduling latency
  to the configured interval.
- Anonymous requests to both `operator.getManagerStatus` and
  `operator.getManagerReviewInbox` returned HTTP 401. The reloaded login page
  had no captured browser console errors.

The user browser reloads the current login page successfully. No credentials
were fabricated, reset or bypassed to claim authenticated live UI acceptance.
No commits, merges or pushes were performed; main remains untouched.

## Initial External Limitation (Resolved Credit Block)

The first operational run reported missing semantic review. One bounded,
read-only assessment diagnostic against the configured OpenAI API confirmed
HTTP 429, `insufficient_quota`, code `credit_balance_exhausted` for the selected
`gpt-5.2` model. It saved no manager run, human review or plan. No credit was
purchased and no provider was substituted. The automatic retry remains bounded.

At that point the shadow scheduler used the deterministic assessment
and exposes the semantic coverage gap. Do not represent this as successful
AI-assisted assessment or completed five-working-day/100-human-review acceptance.
The configured OpenAI account needed available API credit before that full trial
could be evaluated. The credit block was resolved on 2026-09-06; see the update below.

## Semantic Input Update: 2026-09-06

After Robert added API credit, bounded diagnostics returned HTTP 200 and a
completed `gpt-5.2` response. No payment or billing settings were changed by the
agent. Two application problems were reproduced and repaired:

- The manager's hardcoded 15-second timeout now uses the existing configured
  OpenAI request budget (120 seconds by default), still bounded and abortable.
- Repeated derived action/assessment trees consumed the input budget and evicted
  original evidence. Compact metadata now preserves the actual source passages.
  The diagnostic input retained evidence for all ten selected cards.

Exact source validation remains mandatory. The final diagnostic still rejected
the model response because two of 41 citations were not exact source quotations.
HTTP success alone is not accepted as a successful evidence-backed assessment.
No diagnostic saved a manager run, human review, or operational plan.

Verification: TypeScript passed; the general suite passed 1,498 tests with 66
optional database tests skipped. The separate safety gate passed real MySQL
integration, 344 regression cases and all 23 browser tests, producing digest
`4f276fb3224daa93a8212d6353deb6764cf7d9f6089d5b227eaa918ca90d7291`.
The standard production Docker build passed and its bundle/digest matched that
proof before deployment. This does not constitute active-mode acceptance.

Only the application was replaced at 10:54:58 UTC, without database migration:

- Image: `va-dashboard:joyce-shadow-pilot-semantic-20260906`.
- Image ID: `sha256:f27bce6dac84e55f89d39335cee425740252206877a2fa46ad1c296567155b68`.
- Proof directory: `.local/pilot/proof-semantic-fix` (old proof retained).
- Fresh backup: `operational-2026-09-06T10-54-36-297Z.sql`, 38,998,468 bytes;
  SHA-256 `f0761da9b3045ae9489fe52cd6b07fb4fd6693ab13b59aa8a6fedc98ec7ee10c`.
- Container healthy; local and public readiness both HTTP 200.
- Production authentication and existing credentials preserved; worker 2 only,
  shadow mode, five-minute configured interval. Existing saved plans unchanged.
- First post-update periodic run: 15 at 10:56:55 UTC, shadow proposal retained,
  `applied=false`, saved plans unchanged. Semantic enrichment was not accepted;
  the stored generic diagnostic is "Semantic review unavailable". The specific
  runtime rejection reason is not exposed, so the earlier diagnostic citation
  mismatch must not be asserted as the proven cause of this separate run.
  Live AI-assisted assessment acceptance therefore remains outstanding.

For a later authorized incremental deployment, the rollout helper accepts
`PILOT_IMAGE` and `PILOT_PROOF_DIRECTORY`, and checks the exact image against the
selected proof. To return to the first shadow release, use its retained
`va-dashboard:joyce-shadow-pilot-20260906` tag and `.local/pilot/proof` with the
`deploy` operation. The `rollback` operation below instead returns to the older
pre-pilot application. Neither operation restores SQL or removes later history.

## Local Operation And Rollback

Run the checked-in rollout helpers from the shadow-pilot worktree, retaining the
ignored `.local/pilot/runtime-compose.json`, `runtime-before.json`, proof directory
and backup files. The ignored runtime file contains credentials; never commit or
print it. `node scripts/aptlss-pilot-compose.mjs check` verifies the configuration.
`node scripts/aptlss-pilot-operational-check.mjs status` reads the trial and saved
plan preservation status without exposing source contents.

An explicitly authorized rollback uses
`node scripts/aptlss-pilot-compose.mjs rollback` to restore the captured previous
application image only. It retains additive database changes and later history.
Do not restore SQL over a running database as an automatic rollback.

### Current Compatibility Warning, 2026-10-01

The command above documents the historical September rollout, not a verified
rollback path for the current consolidated application. The historical
`rollback` branch selected the captured pre-pilot image and skipped the
image-proof gate, without checking compact-history materialization or current
RBAC/data boundaries. The current helper now refuses `rollback` before reading
runtime credentials or invoking Docker. Neither environment flags nor supplied
proof claims can override that refusal. Do not use `deploy` with an older image
to work around the missing compatibility gate; explicit authorization alone does
not establish compatibility.

For the current release, first complete a separate owned, full-data application
rollback rehearsal. Preserve migration 0053 and every full run/check. Disable
compaction and verify a new full run with a cleared current-check pointer for
every affected worker. The current implementation explicitly materializes a
compact head even on identical input; changing the flag without verifying the
stored result is insufficient. See [assessment history storage](APTLSS_HISTORY_STORAGE.md).
Independently inspect source and target image identities
and their source/bundle/collector seals. Check sessions, CSRF, founder/worker
scope, realtime rooms, all timer-start paths and record preservation through the
switch backward and forward. Measure materialization separately from application
switch/readiness time. Keep all failed reports and prior containers.

Use a dedicated full-data-safe runner, not the synthetic configured-runtime or
ordinary SQL fixture runners: those intentionally have different inventory and
cleanup boundaries. Provider credentials/calls, public endpoints and production
mounts must be absent. Network restrictions alone do not stop local background
writes: both binaries' Manus, maintenance and other scheduled workers require
explicit isolation before either starts on the restored data. A successful SQL
restore or migration/rerun does not establish any of these application checks.

The [full-data checkpoint component](FULL_DATA_ROLLBACK_CHECKPOINT.md) provides
an all-column, all-history read-only baseline for that dedicated runner. It does
not launch or approve rollback and does not replace the remaining application
compatibility checks.
