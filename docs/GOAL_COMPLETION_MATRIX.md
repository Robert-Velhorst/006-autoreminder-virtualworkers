# Goal Completion Matrix

Statuses describe the repository, not provider consent outside the repository.

## Current Release Decision, 2026-10-23

**v1.0.1 is deployed; full production acceptance and active automatic planning
remain incomplete.** The authoritative dated release, image, deployment and
provider-backup checkpoint is [Production Deployment Target](../DEPLOYMENT_TARGET.md).
Do not duplicate its release identifiers in historical capability records below.

| Requirement | Current evidence | Still required |
| --- | --- | --- |
| Accepted source and release | PR #153 merged after exact-head checks; identical merge tree passed post-merge quality and CodeQL. Stable release and exact-digest publisher completed. | Fresh checks and artifact acceptance for subsequent changes. |
| Live single-container deployment | Owner-approved restricted workflow deployed v1.0.1. One healthy loopback-bound VA container, verified release digest/revision, HTTPS health/readiness and database connectivity. | Real authenticated owner/worker workflow acceptance; a rendered login page is not that evidence. |
| Data preservation and recovery | Original migration records and backups retained; independent native restore and complete-value reconciliation passed. Existing provider disk backups and database storage scope were inspected. | Recurring database backup validation and successful recovery from the selected provider backup; disk capture alone is not a database-consistency proof. |
| Access controls and providers | Public unauthenticated API and WebSocket access are denied. Financial/background/bypass holds remain intact and management is shadow-only. | Approved Trello origin and actual login, Google callbacks, browser pairing and private subscription bridge acceptance. Holds are not working integrations. |
| Security | Default-branch CodeQL inventory empty after v1.0.1; release image scan and provenance verified. | Historical exposed credential remediation remains unresolved; no revocation is inferred from code removal. |
| Operational activation | Production route and runtime are deployed without server expansion. | Monitoring/recovery acceptance, financial operational acceptance, controlled outbound work and the supervised shadow trial described below. |

The following 2026-10-21 and older sections retain their original evidence scope.
Their no-deployment/no-database statements are historical, not current state.
No section below authorizes bypassing the remaining real-account or recovery gates.

## Historical Release Decision, 2026-10-21

**At that checkpoint: not cleared for production deployment or active automatic planning.** The
accepted PR #144 source receipt is `c43dee7`. PR #144 merged as
`b92be39f88d66e4f53fae782900b70705f9ade90`, with a tree identical to
`12ed4cfa58c5f3a35da0f144ff92d5b65c26c279`. Quality run `39557268165`,
CodeQL `39557267429` and the aggregate gate succeeded. PR #135 then passed quality
`39560277949` and CodeQL `39560273868` at exact head `cba2076`, and merged normally
as `0e18557d45452f5ef1812955eb55f959ebf822d4` with the same reviewed tree.
Durable card-analysis PR #145 then passed quality `39565591698`, CodeQL
`39565587914` and its aggregate at `ce2f95c`. Its normal merge is
`820ee121fb137b122727560b9e0deeab71a44bfb`, with reviewed tree
`c6f3ce1635fdefc92a3e03895200590d02850376`. Subsequent subscription, calendar
and authority changes require their own fresh acceptance.
This supersedes older source/publication/branch
observations below, not their retained historical evidence. A passed source gate
is not a live deployment receipt or acceptance of every production path.

The supported target is one persistent application container with separately
provisioned shared PostgreSQL and optional external Redis. The dated MySQL
implementation and rehearsal sections below are historical, not another runtime
target. Do not start an additional permanent dashboard or remove private data
and recovery archives while consolidating source branches.

| Requirement | Verified current evidence | Remaining acceptance |
| --- | --- | --- |
| Consolidate local source without losing history | Accepted PR #145 merged as `820ee121fb137b122727560b9e0deeab71a44bfb`, with tree `c6f3ce1635fdefc92a3e03895200590d02850376` matching reviewed `ce2f95c`. The head is archived; its matching development branch was removed after verification. | Review and accept subsequent subscription/calendar/authority work before removing its branch. Preserve unique source/history and its branch until authorized archival/removal; do not claim only `main` while it exists. |
| Canonical runtime and additive data model | Persistent Node 26.12.0 application and PostgreSQL 18.6 fixtures. Accepted main has 142 tables through migration 0010. Exact-head schema, native and configured-image tests passed in `39565591698`. Historical migrations are not another runtime backend. | Provision and test the actual shared PostgreSQL service, dedicated application database and least-privilege role. Reconcile any transferred data against its source and preserve rollback evidence; synthetic fixtures and transfer tooling do not prove a real import. |
| Source safety and regressions | Accepted PR #145 quality `39565591698` passed 5,156 Vitest tests with 22 skips, 294 Node contracts, 1,044 manager service cases, 97 manager Chromium cases and the 15-case confirmed-analysis browser gate. CodeQL `39565587914` and the aggregate were green. Counts describe separate, potentially overlapping gates, not additive feature coverage. | Require fresh quality, native, browser, image and security gates for subsequent subscription/calendar/authority changes. Source tests do not verify real provider delivery, target-host recovery or unexamined roadmap criteria. |
| Durable notification delivery and recovery | PR #134 records exact digest membership, immutable payload/address, dispatch phases, lease fencing and audited recovery. Final provider-boundary checks cover consent, address and worker-access changes during provider preparation. Issue #75 is closed against its regression evidence. | Verify the selected live provider and operator recovery procedure. Provider acceptance is not inbox receipt; uncertain results must not become silent replay permission. |
| Manual generation and history retry | The local follow-up scopes history to its creator, propagates fresh actor/lease authority, binds a stable retry child to its original parent and retains uncertain-outcome fences. A 33-case native PostgreSQL run includes repeated original-parent and concurrent-retry cases; 15 mounted Chromium scenarios check truthful outcomes. Migration 0011 widens the existing partial-error status columns without rewriting history. | Publish and accept this exact follow-up source, including fresh hosted native/browser/image/security checks. These cases do not establish live provider acceptance, scheduled-job approval or historical deleted/recreated-account lineage. |
| Image vulnerability enforcement | PR #145 quality `39565591698` scanned its actual built image: 633 packages, zero findings and no exceptions; configured PostgreSQL acceptance used that same image and confirmed fixture cleanup. The exact-pinned artifact Action approval was applied; other policy entries were unchanged. | Rerun all required gates for subsequent changes and retain their exact-image receipt. Require protected-main verification and a real release's exact-digest scan, configured PostgreSQL acceptance, attestation and same-digest promotion. Earlier previews are not proof of a new accepted release; do not bypass artifact/action policy. |
| Private information and historical credentials | Accepted source has secret-scan evidence. Private configuration, recovery archives and operational data are not source publication artifacts. Provider-specific remediation documentation was removed in favor of generic historical credential-remediation guidance. Historical alerts #1 and #4 remain open; the owner declined deletion. | Do not treat documentation removal or owner-declined deletion as credential remediation or alert closure. Verify authorized rotation/revocation and record the remaining historical exposure boundary without publishing secret values. Private backups are not a data-migration receipt. |
| Deployable release and infrastructure | The repository contains guarded deployment and exact-artifact release tooling. Existing `v1.0.0-rc.1` remains a historical, non-production preview. Synthetic configured-image acceptance exists, not an accepted target-host deployment. | Verify the actual host/domain, private runtime configuration, shared database/TLS, backups/restore and authorized deployment credentials. Publish/promote only a freshly accepted exact artifact, then perform authorized deployment, rollback and operator checks. Infrastructure and real deployment remain unverified. |
| Real operator and integration acceptance | Authenticated synthetic browser, source-contract and database tests exist. Their account and provider scopes remain explicit. | Verify real owner/worker access, Google/Trello/browser callbacks and freshness, WebSockets, schedulers and recovery on the target environment. Mocked transports and local previews are not live-account acceptance. |
| Reliable APTLSS activation | Shadow-mode controls and regression evidence remain available. No calibrated probability of future correctness is claimed. | At least five working days and 100 human-reviewed proposals, Robert's review of urgent conflicts, zero critical errors and at least 98 correct and sufficiently supported proposals; begin active operation with one worker only after acceptance. |

The remaining issue inventory must be checked against current code and tests,
not treated as either proven defects or automatically completed work. Existing
capability criteria that have not been inspected remain unproven. Do not close
broader security or integration issues using a narrow digest or UI test result.

Accepted source now includes account offboarding, output escaping, canonical
timer ownership, browser-bound legacy OAuth state, founder/full-task assignment
identity and atomic audited financial ledger changes with optimistic save
revisions. Do not repeat earlier audits as if those paths were unchanged, or
equate their bounded acceptance with all source being production-ready.

The read-only ATIS audit against `c43dee7` identified two concrete gaps:
legacy `reprocess-failed`, `reprocess/:cardId` and `reanalyze-all` routes call
provider analysis outside durable operation admission/lease fencing, while
their request-rate limit is not a per-card analysis quota; and bulk clients
request 200/500 cards while the server silently caps selection at 100 without
explicit continuation. The ordinary understanding process endpoint already
uses durable operations. Preserve the legacy features and clients while adding
bounded confirmed selection, durable execution/quota controls and truthful
batch completion. The follow-up implements one confirmed, durable path for these
routes, a frozen 100-card batch with explicit continuation, per-card outcomes,
authority fencing and safe maintenance tools. See
[Confirmed Card Analysis](CARD_ANALYSIS_ADMISSION.md). Its migration and
browser/native tests passed exact-head acceptance in PR #145; this is not
evidence that all roadmap criteria or operational behavior have been verified.
Infrastructure is not the only remaining acceptance.

Use [Image Security](IMAGE_SECURITY.md),
[Notification Delivery](NOTIFICATION_DELIVERY.md),
[Consolidation Ledger](CONSOLIDATION_LEDGER.md), and
[Production Cutover](PRODUCTION_CUTOVER.md), alongside
[Technical Audit](TECHNICAL_AUDIT.md), for the current contracts. The
records below retain their original source, database, artifact and date scopes.

## Release Decision, 2026-10-02

**Not cleared for production cutover or active automatic planning.** The older
implementation labels below are a historical capability inventory, not current
acceptance. Use [dated production evidence](PRODUCTION_VERIFICATION_20260930.md)
and [cutover gates](PRODUCTION_CUTOVER.md), retaining each receipt's exact image,
source identity, database lineage and scope.

| Requirement | Current evidence boundary | Still required |
| --- | --- | --- |
| Preserve the developer platform and operator history | Existing capability ledger, additive schema and canonical migrations remain in the working branch | Complete feature comparison and authorized branch consolidation; ancestry alone is insufficient |
| Safe build and test baseline | The pre-keyless post-cleanup source passed type check, 3,147 ordinary tests in 303 files (204 environment skips), secret scan, sealed build and all 190 mandatory MySQL tests. The newer subscription-startup fix passed 123 focused provider/config tests, six doctor tests, type check, sealed build, eight actual-image packaging checks and 21 configured checks without an API key | Broader gates on the exact final release source, complete route/workflow coverage and remote CI on the reviewable release commit |
| Production authentication and worker isolation | The subscription-startup image passed all 21 configured checks in the five-account synthetic owned fixture without an OpenAI API key or local auth bypass, including four compiled browser cases. The founder fixture is a separate admin-role owner account, not a distinct role | Real owner/replacement-worker acceptance and production permission review |
| Desktop/mobile and dark/light routes | The pre-keyless image completed all 64 route cases and eight setup checks with passing settled UI checks. Overall acceptance remains degraded because source APIs were unavailable; receipt: `artifacts/production-single-runtime-20261001-attempt9/boundary.json`. The newer startup-fix image has four compiled browser smoke cases, not a new 64-case matrix | Final-image route matrix, populated worker/manager workflows and source API diagnosis; unavailable sources cannot be called working integrations |
| Preserve data through migration and rollback | Full restored baseline revalidated after native-server restart: all columns/schema of 134 tables and 94,730 records exactly unchanged. Additive migration receipts and synthetic startup-preservation checkpoints exist | Exact previous and new application binaries on full restored data, backward/forward compatibility and complete before/after reconciliation; the old binary does not honor the candidate's background-disable switch |
| Scheduled jobs and realtime | Lease/concurrency SQL tests and isolated authenticated WebSocket checks exist. New standby switch suppresses startup workers without bypassing auth | Target-host scheduler delivery, notifications, recovery and supervision; worker suppression is not delivery proof |
| Google, Trello, browser and email | Existing adapters, source checks and approval boundaries remain | Actual consent, fresh credentials, stable callbacks and controlled delivery verified with the relevant accounts |
| Reliable APTLSS activation | Shadow-only policy and evidence/review controls remain | At least five working days and 100 reviewed proposals, all urgent reviews, zero critical errors, at least 98 correct and supported proposals; activate one worker first |
| Cutover and recoverability | Old image and database backup retained; no production replacement | Authorized publication, deployment, rollback rehearsal and operator sign-off |

Passing one row does not satisfy the others. No probability of future
error-free decisions is implied by the proposal acceptance threshold.

### Latest Controls and Restore Gate

The combined control suite subsequently passed all 54 cases with zero skips on
Node 22.23.3 and the pinned Vitest/TypeScript/tsx dependencies. It covers the
supervisor, publication exclusions, fixture connection and read-only account
controls, not the complete application or live providers. The temporary test
container was independently absent afterward; the operational image stayed
healthy and unchanged. See FULL_DATA_REHEARSAL_PREFLIGHT_20261002.md for failed
harness attempts and the final run boundary.

A fresh volume inspection found C: with 22,908,940,288 bytes free, below the
27,326,091,699-byte full-restore requirement. D: has space but uses exFAT and
cannot satisfy the required private-directory ACLs. The unlettered NTFS volume
has only 117,465,088 bytes free. These are point-in-time observations, not
reserved capacity. A protected NTFS location or explicitly approved cleanup is
required; no retained backup or unrelated project may be removed to bypass this
gate. The operator has been asked for that decision. Production remains uncleared.

### Review Branch Publication Gate, October 2

Live Git inspection confirmed the working branch is
`codex/aptlss-shadow-pilot-2026-09-25` and its existing GitHub counterpart resolves
to `6a8029cedc61f89609f79a021e193844fb1d716e`. The working tree has 315 changed or
untracked entries; 188 tracked files differ from HEAD. These totals are dated
inventory observations, not evidence that every changed file has been reviewed.
The existing workflow did not run on pushes to this branch, because its filters
covered only main and recovery branches. The exact review branch was added and
validated with a YAML parser; workflow contents permission remains read-only.
Human publication approval was requested. No commit, push, merge or remote CI
execution occurred during this inspection. A current source/secret inventory
and approved reviewable commit remain required before publication.

Publication preflight subsequently found untracked `.superpowers/brainstorm`
runtime state, including a token filename, outside the old ignore rules. No
content was printed. Git and Docker ignore rules now exclude that local state;
all `.env.*` files are excluded from Git except example templates. Three local
regression tests passed and CI includes them. A tracked-file check found only
`.env.example` among the checked runtime/private paths; no such files were
removed. This is an exclusion check, not a complete source secret scan or
proof that prior published history never contained credentials.

Subsequent current-publication scan captured 1,092 ordinary Git-eligible files,
digest `ae95c3448a03f338aec9bfe9e11cf3bb448b535a964e0d71b308cbfc36bf6f10`.
The pinned Gitleaks image exited zero with zero findings on this exact copy,
using the existing explicit ignore file and redacted report output. Inventory
and receipt: `artifacts/current-publication-scan-20261002/`. Private runtime
paths and non-example environment files were rejected from the inventory;
the networkless scanner container was independently confirmed removed.
This does not scan Git history or prove absence of every possible secret.
Documentation edited after the copy is outside that digest.

GitHub source refs were read directly for checkout v7, setup-node v7,
upload-artifact v7 and pnpm/action-setup v4.4.0. All seven workflow action uses
are now pinned to those verified 40-character commits. YAML parsing and the
all-action pin assertion passed. No remote workflow run or publication occurred.

### Local History Secret Scan

The pinned scanner was subsequently run against all reachable local refs
(404 commits at inspection time), with a read-only common Git directory and
network disabled. It exited 1 with 12 generic-key findings; this is not a
passing history scan. Redacted detail is retained only under the protected
private history-scan directory; the non-secret receipt is
`artifacts/history-scan-20261002.json`. Metadata/source-context review identified
two UUID request identifiers in tests, four canonical checksum-manifest entries
and three historical frontend findings in Trello authorization URL context.
Those contexts do not establish that every finding is an exposed credential.
Subsequent historical-source review identified the assessment key as a label
in the structured scoring-signal list, not an authentication credential. Both
JWT findings contain the same literal documentation example still present in
the current guide, in example environment-configuration context. A private
comparison confirmed neither equals the operational container's configured
JWT secret; no values were printed. The guide's reusable-looking sample was
replaced with a requirement to generate a unique private secret. This does
not prove no other installation reused the published example. Provider/session
impact and any required rotation remain review gates. No findings were silently
ignored, no history was rewritten, no credential was printed and no remote
refs were refreshed. Unreachable objects are outside this scan's scope.

The [compiled workflow follow-up](PRODUCTION_WORKFLOW_VERIFICATION_20261001.md)
records all nine passing populated worker, administrator-review and founder-approval
scenarios on the newer response-disposal image. The previous response-observation
failure is resolved. Visual inspection exposed an additional completed-decision
label defect. The repair subsequently passed a fresh sealed build, 190 focused
tests, ten diagnostic/classifier tests, eight packaging checks and all nine compiled
workflow cases on candidate image
`sha256:32778f7b00cf5da12ac33b782b046146f7a923d4b2332f8c5b8333c88445671b`.
The interrupted outer receipt remains unchanged; the inner execution and full
browser report, followed by independent cleanup/health inspection on October 2,
provide the bounded recovered evidence described in the follow-up document.
The same candidate subsequently passed all 21 configured-runtime checks in
`artifacts/production-subscription-runtime-completed-decisions-20261001-attempt4/boundary.json`,
with confirmed temporary-container removal and original operational health.
Live-provider, full-data rollback, broad final-source,
remote-CI and shadow-trial gates remain open.

### Current Candidate And Verified Follow-Up

The October 2 host-runner and supervisor changes are newer than the packaged
candidate below and are not deployed. The recovered operational connection is
documented in `PRODUCTION_CONNECTION_RECOVERY_20261002.md`. The working-source
ordinary run passed 3,166 tests with 206 skips, but used local Node 25.2.1 and
Vitest 2.1.9 rather than the release's Node 22 / Vitest 4.1.11 runtime. It does
not close the final-source gate; see `CURRENT_SOURCE_TESTS_20261002.md`.
Subsequent focused bridge and supervisor checks cover startup cleanup, owned
lease preservation, IPC shutdown/disconnect, missing heartbeats and active
local fixture cancellation. They do not prove official CLI descendant cleanup,
Windows reboot recovery, installed supervision or live provider correctness.
New runtime preflight and CI gates prevent silently accepting the observed
toolchain mismatch. A fresh locked-dependency final-source run remains required.

Follow-up: `LOCKED_SOURCE_TESTS_20261002.md` records a frozen 1,082-file source
copy tested with Node 22.23.3 / Vitest 4.1.11. All 3,169 ordinary tests and 25
separate Node checks passed; 206 environment skips remain. Type checking passed.
The sole test container was removed and operational health rechecked. This
supersedes the toolchain mismatch for that exact source-test scope only; a new
sealed build/image, complete source inventory, integration and external gates
are still required.

The latest packaged candidate is the reconnect image
`sha256:2c9ecf74eaf55e2c2ad48124c39c73655bbf5d581b38eb8f54e250d5335b172a`,
from frozen source
`4b57a61d9a30c6cdf09bdd456a794b124978b5b7874db6e619573e828babd20c`.
Its type check, 208 focused tests, ten Node checks, sealed build and eight
actual-image packaging checks passed. It has not been deployed.

Attempt 38 refreshed all 21 configured-runtime security/startup checks on this
same image, including synthetic session/role/workspace and websocket isolation,
four compiled browser smoke cases, and confirmed cleanup/operational health.
This is isolated acceptance, not real-account consent or public TLS verification.

Attempt 39 refreshed the broad 64-route matrix plus eight login/theme setups.
All settled UI assertions passed, but overall acceptance is degraded because
fixture source APIs remain unavailable (Trello, assignments/timeline, nonpilot
manager status). This is not a passing live-integration gate. The exact failed
outer receipt and successful UI scope are retained in the workflow evidence.

On this image, attempts 23, 24 and 26 establish the nine-case real browser
workflow, deliberate websocket interruption/re-authentication and retrieval of
the correct stored assessment across desktop dark/light and mobile light.
Attempt 27's twelve individual cases also passed, including populated urgent
conflict notification and blocked dependent work. Its outer receipt failed only
on the obsolete nine-case harness count. Attempt 28 passed the corrected full
twelve-case rerun and its outer acceptance receipt.
All these attempts confirmed temporary-container cleanup and operational health.

Keep SQL evidence source-specific: completed-decisions attempt 9 passed 190
mandatory MySQL tests; attempt 20 passed 191 with the new lifecycle-test overlay.
Reconnect attempt 29 now passed all 191 mandatory MySQL tests on the frozen
latest source, without a test overlay, under Node 22.23.3. Its outer receipt
confirms temporary-container removal and original operational health. Likewise,
the 3,163-test ordinary suite (204 skips) belongs to the completed-decisions
source, not the latest source. Do not rerun already proven older cases merely to
inflate totals; refresh the gates affected by the final source and release.

Attempt 32 additionally passed the browser conflict response/resolution chain
in all three view variants: an unsupported note leaves the issue open, source
proof resolves it, and reassessment remains shadow-only with no day-plan change.
Both failed fixture attempts are retained in the workflow evidence chronology.

Attempt 33 passed 192 mandatory MySQL checks with a recorded integration-test
overlay, proving timed durable conflict consumption through the real manager
service, urgent intervention storage, blocked work and unchanged shadow plan.
Its mocked websocket/model boundaries do not prove automatic browser delivery.

Attempt 34 passed automatic application-to-browser delivery in three actual
browser variants with background processing enabled in the isolated fixture.
A seeded durable request yields an urgent websocket event and visible warning
without manual reassessment, followed by proof-backed worker resolution.
This does not establish live-provider ingestion or target-host supervision.

Attempt 37 passed new-conflict delivery during a held realtime outage in all
three browser variants. Periodic HTTP status polling displays the missed warning,
realtime re-authenticates after restoration, and proof-backed resolution preserves
the day plan. This is not full internet-offline or Socket.IO polling-only proof.

Remaining functional acceptance includes target-host scheduler supervision
and any required Socket.IO polling-only transport acceptance. Full restored-data binary rollback, actual providers,
remote CI/release approval and the human-reviewed shadow trial remain open.
Exact receipts and failure history are linked in the workflow follow-up above.

### Host Recovery Incident And Restoration, 2026-10-01

The combined single-container configured-runtime setup did not execute any
acceptance checks. During its image setup, Docker inspection and the operational
readiness endpoint stopped responding. The owned build client was cancelled
after repeated readiness timeouts; the causal relationship is not established.
The failed logs and zero-check boundary remain in
`artifacts/production-single-runtime-20261001-attempt2/boundary.json`.

Robert authorized a Docker Desktop restart. Normal shutdown timed out; a
targeted restart of the verified Docker processes and only the `docker-desktop`
WSL environment restored engine responses. No volumes, images or containers were
deleted. The original MySQL/Redis containers were restarted and reported healthy.
Tool policy rejected starting the original application/tunnel containers; manual
startup was requested. Their restoration and dashboard readiness remain unproven
at this checkpoint. Do not start another verification phase until the original
operational image is healthy and the temporary-container slot is empty.

After Robert manually started the original app/tunnel, restoration was verified
in `artifacts/production-host-restored-20261001/boundary.json`: all four original
containers running, the original application image unchanged, MySQL/Redis/app
healthy, readiness and `/worker` both HTTP 200, and no temporary VA containers.
This clears the host-restoration hold, not the configured acceptance or cutover
gates. The failed attempt2 receipt remains unchanged.

The prepared adapter now retains phase checkpoints and a failed final receipt
on setup/verification failure. Cleanup observations cannot hide the original
failure, and acceptance requires confirmed temporary-container removal and
operational-image health. Nine local lifecycle regression tests passed without
starting Docker containers; this is harness evidence, not application acceptance.
Its Docker build-client deadline is five minutes. A client timeout does not
prove the Docker daemon's build stopped; inspect the daemon before any retry.

### Trello Source Availability Repair, 2026-10-01

The working candidate now verifies the configured Trello token owner's complete
board inventory before reading assignments or timeline cards. Provider failures
return a sanitized unavailable response, not all cached boards or a successful
empty result. Timeline pagination uses the same verified board scope as the
returned cards. This preserves the established token-owner scope; it is not a
new per-founder tenancy model.

Founder assignments distinguish unavailable, genuinely empty and populated
states. Failed reads suppress assignment/dependency actions; a successful write
overlapping a refresh queues a fresh read. Valid `drop_everything` priorities
remain supported. The home timeline retains last-loaded work as read-only when
the source cannot be verified; task, interview, reschedule and synchronization
callbacks are guarded during refresh and failure.

The focused synthetic tests passed: 112 tests in six files. A fresh frozen-tree
type check, complete test suite, mandatory MySQL gate, build and compiled browser
checks are being recorded separately. Earlier image and route receipts above
must not be treated as proof of this newer source. No live provider, production
deployment or active-planning acceptance is implied. The worker-settings
heartbeat/status discrepancy remains a separate open item.

### Observed Scheduler Status And Assignment Labels, 2026-10-01

The candidate labels `unassigned` tasks explicitly rather than calling them
assigned. All five retained task statuses have render regressions.

Worker settings separate the configured assessment interval from observed
automatic-check status. Queue observations require successful queue polling
and fallback reads, expire when stale, and retain independent failure signals.
Startup, shutdown, paused worker policy and failed status refreshes do not claim
healthy automatic checks. Only a sanitized current-process state reaches the
worker; this is not a cluster heartbeat or proof of successful assessments.
An assessment can still fail while its queue-processing loop is responding.

Fresh release gates for this batch must be recorded independently of the
previous source digest and image. The operating deployment is unchanged;
full-data rollback, live provider acceptance, reviewed shadow-trial thresholds,
remote CI and approved cutover remain required.

### Fresh Frozen-source Gates After Docker Cleanup, 2026-10-01

The 1,071-file source inventory with digest
`0499f0200e7ffb37c4f08db8af80bdfb7e0c30da60d94d6918f8ac4f75c53fcf`
passed type checking and the complete ordinary suite: 3,147 passed, zero failed,
204 skipped, 303 files. The skipped cases are not database acceptance evidence.
The secret scan used the repository's existing exact false-positive exceptions;
no new exception was added. The sealed package build passed on the same source
and dependency image, using `npm run build` to execute the unchanged package
script without pnpm's implicit install against the test-only symlink.

The combined receipt is
`artifacts/production-post-cleanup-build-20261001/boundary.json`, linked to
`artifacts/production-post-cleanup-20261001-attempt3/source.json` and the complete
test report. Earlier failed setup attempts remain available. A failed type-check
attempt exhausted its temporary heap; the subsequent successful attempt used
more memory. The initial build attempt was rejected by pnpm's module-directory
safety check, not accepted as a successful build.

Only one temporary verification container ran at a time. Cleanup was confirmed
after each phase; the operational app/image and production database remained
untouched. The container-lifecycle documentation was updated after this source
freeze and is not part of its digest. No new production image, real database
rehearsal, browser acceptance, provider access or cutover is proved by this run.

### Same-source Single-container Database Gate, 2026-10-01

The same frozen application/test source passed the mandatory MySQL gate:
190 tests in nine suites, zero failures or skips, MySQL 8.4.11 and Node 22.23.3.
All 54 canonical migrations applied and reran without altering the migration
ledger. Schema parity found all 133 application tables (134 including the
ledger), with no missing tables/columns or unexpected columns beyond the four
explicitly retained legacy compatibility columns.

MySQL and the tests ran inside one networkless temporary container, with no
published ports or production-data mounts. MySQL shut down normally, the
container was removed, and the operational app/image remained unchanged.
Receipt: `artifacts/production-single-container-mysql-20261001-attempt2/boundary.json`;
execution/parity details and the complete test report are retained beside it.
The failed first attempt is retained separately: its compiled default file-import
directory did not exist. Explicitly disabling file import/export fixed setup.
This proves fresh synthetic SQL integration, not full-data binary rollback,
configured browser acceptance, provider delivery or production cutover.

### Same-source Configured Runtime Gate, 2026-10-01

All 21 configured checks passed against the post-cleanup image
`sha256:9ce59dedd3dab7f1d9892ad507e91f5e1367c16d13ed3a73e14310522aa1a73e`
with its sealed bundle, locked dependencies and original Node 22.23.3. The
application ran as UID 1001 in its original filesystem inside one disposable
container, with fresh MySQL 8.4.11, password-protected Redis 7.4.10, TLS and
Chromium. No provider network, production database, local bypass or background
execution was enabled. The 54-entry migration ledger was preserved.

Receipt: `artifacts/production-single-runtime-20261001-attempt6/boundary.json`;
check details, screenshots and execution proof are retained alongside it.
Application, Redis and MySQL exited normally with zero; the temporary container
was removed and the original operational application remained healthy.

The failures remain separate evidence: attempt3 accessed Redis before readiness;
attempt4 passed 20 checks but lacked process information for memory reporting;
attempt5 refused setup because capability reduction was unavailable. The final
setup mounts only the disposable container's own process information read-only
into the candidate root, then drops mount/capability-change authority from every
capability set before any Node/source/database/browser code executes. The harness
asserts these restrictions. No application code or verifier assertion was changed
to make the health check pass. These checks do not prove live providers, populated
worker workflows, 64 route cases, full-data rollback or reviewed shadow trials.

### Same-source Route Matrix, 2026-10-01

Attempt9 completed 16 routes across desktop/mobile and dark/light: all 64 UI
cases and eight authentication/theme setups passed, with zero page errors,
asset errors, external requests or blocked mutation attempts. The frozen
application and verifier remain unchanged. Screenshot inspection sampled the
mobile worker dark view and desktop admin light view; automated checks cover all
64 views. This is empty/degraded synthetic-account coverage, not populated work.

The overall result remains `passed: false`, `uiPassed: true`, `degraded: true`.
Trello endpoints returned 412/500, task-source endpoints 503, and manager status
403 for the synthetic non-pilot worker. These errors are retained rather than
stubbed or counted as working integrations. Evidence is in
`artifacts/production-single-runtime-20261001-attempt9/runtime/route-matrix`.

Attempt7 exceeded the adapter's shorter child deadline; attempt8 was explicitly
cancelled while diagnosing missing candidate resolver configuration. Neither is
a pass. The adapter now waits for application readiness, aligns its deadline
with the unchanged matrix budget, and supplies a fixture-only loopback resolver
with bounded failure and no DNS listener. No external network is available.
Attempt9 preserved the 54-entry migration ledger, kept SQL scheduling disabled,
shut down app/Redis/MySQL with zero exits, removed its temporary container and
confirmed the original operational image remained healthy. No deployment or
provider acceptance is implied.

### Subscription Startup And Configuration Repair, 2026-10-01

Production startup no longer requires `OPENAI_API_KEY` for the default
`codex-subscription` manager route. Explicit `openai-api` still requires a
nonempty key; unknown provider settings fail before startup without echoing
their values. This changes configuration requirements, not provider availability
or permission to use paid features. Legacy API features remain unavailable
without a key. The doctor now parses dotenv values rather than accepting empty
variable names as configured, honors process overrides and applies the same
provider selection. Documentation was updated without changing real secrets.

Frozen source `5372087f5bb6cbfd961e7d48b996606240ff677ccc2ed456c947c4ce4ab560a1`
contains 1,072 files. Locked Node 22.23.3/Vitest 4.1.11 verification passed 123
focused tests, six standalone doctor tests, type check and sealed build:
`artifacts/production-subscription-config-20261001`. The actual Dockerfile image
`sha256:6d3754b561d549b9853af2f460be4c7a6cfb27cda834f353ef65423a455d3860`
passed eight packaging checks: `artifacts/production-subscription-image-20261001`.

All 21 unchanged configured checks passed with the candidate's actual Node,
sealed bundle, fresh MySQL and authenticated Redis, explicitly without any
OpenAI API key: `artifacts/production-subscription-runtime-20261001-attempt2`.
The 54-entry migration ledger stayed unchanged, SQL scheduling stayed disabled,
all three child processes exited zero, the single temporary container was
removed and the original operational image remained healthy. No deployment,
live model/provider access, populated-workflow acceptance, new full route matrix,
full-data binary rollback or reviewed shadow-trial acceptance is claimed.

### Same-source Production Image Gate, 2026-10-01

The actual frozen Dockerfile built successfully using its pinned Node base and
frozen lockfile. Inspected image:
`sha256:9ce59dedd3dab7f1d9892ad507e91f5e1367c16d13ed3a73e14310522aa1a73e`.
All eight packaging/startup checks passed: production default, non-root, no
environment files, sealed bundle, collector integrity, icon, no Vitest and
fail-closed missing-configuration startup. Receipt:
`artifacts/production-single-container-image-20261001-attempt2/boundary.json`.

The first build failed because networkless dependency downloads could not
resolve the registry. Its logs remain. The successful build allowed dependency
downloads; runtime verification remained networkless. Check containers ran
sequentially and removal was confirmed before the next check. The operational
image stayed unchanged. These eight checks do not replace configured
authentication, Redis, browser or full-data rollback acceptance.

## Current Verification Boundary (2026-08-15)

The table below records architectural coverage. It is not a substitute for a
fresh verification run. The following evidence was rerun against the current
working tree on 2026-08-15:

- `pnpm test`: 99 test files and 725 tests passed.
- `pnpm check`, `pnpm build`, and `pnpm audit:prod` passed.
- The current public browser matrix passed 85 anonymous route/login checks
  across Chromium, Firefox, WebKit, Mobile Chrome, and Mobile Safari. It
  covers every protected application entry route plus the login surface.
- Local and public health/readiness checks returned HTTP 200 after the current
  Docker image was rebuilt and recreated.
- Versioned static assets are served with immutable caching and gzip encoding.
- Trello comment automation now requires an explicit opt-in; operator-side
  mutations verify card access, require provider credentials, and append audit
  history only after the provider request succeeds.

The current browser suite verifies all protected worker, founder, and admin
entry routes redirect safely to authentication without client errors. Genuine
cross-role workflows, provider-live, migration-rehearsal, clean-machine, and
full reminder lifecycle acceptance remain distinct verification work. Provider
configuration being present does not prove provider permission, delivery, or
webhook acceptance.

| Prompt phases | Status | Evidence or remaining boundary |
| --- | --- | --- |
| 000-006 | Implemented | Preserved Git baseline, dependency audit, architecture, schema, configuration validation |
| 007-010 | Implemented | Signed sessions, RBAC, ownership checks, API errors, canonical navigation |
| 011-019 | Implemented | Worker vertical slice, provider truth, policy gates, durable jobs, rate limits, audit |
| 020-023 | Implemented | Next-action dashboard, validated forms, bounded lists, transfer/import tooling |
| 024-030 | Implemented | Settings presets, central AI, approval queue, reminders, privacy controls, headers, secret validation |
| 031-036 | Implemented | Local and Docker runtime, migrations, doctor, health/readiness, diagnostics |
| 037-039 | Not applicable | Live product contains no demo provider or fake-success mode; test fixtures remain test-only |
| 040-043 | Partial | Broad unit/integration coverage and login E2E exist; full cross-role E2E suite remains smaller than the product surface |
| 044-051 | Implemented | Acceptance contract, adversarial/ownership/provider tests, responsive QA, indexes and bounded queries |
| 052-053 | Implemented | Pagination/progressive reveal, backup and transfer/reconciliation tooling |
| 054 | Not applicable | No independently specified phase 054 requirement was present in the supplied index |
| 055-061 | Implemented | Local-first metrics, no forced billing, timezone/locale settings, flags, state models, invariants |
| 062-069 | Implemented | Pre-action gates, credential checks, threat/privacy boundaries, locked dependencies, CI/release/rollback docs |
| 070-077 | Implemented | Runbook, setup/troubleshooting references, UI/API audits, truthful docs, debt and work logs |
| 078-084 | Implemented | Adversarial tests, nontechnical worker flow, autonomy/value/realism review reflected in UI and policies |
| 085-091 | Implemented | Traceability, task graph, checkpoints, resume rules, stabilization, feature completion rules |
| 092-093 | Partial | Container path is repeatable and browser evidence exists; a separate clean-machine install remains an operator acceptance step |
| 094-101 | Implemented | Search/audit, completion matrix, verification report, roadmap, credential cleanup policy, doctor diagnostics |
| 102-104 | Implemented | Retention/archives, additive production migration, emergency disable and approval controls |
| 105-106 | Implemented | Owner bootstrap, worker invitation onboarding, role-specific settings |
| 107-111 | Implemented | Confidence gates, reduced decision burden, exceptions, safe retry, explicit ambiguous-action review |
| 112 | Implemented | Versioned package, migration journal, worklog, and release/change documentation are maintained in the repository |
| 113 | Implemented | Unit/integration baseline is recorded and rerun with the current tree; deployment readiness is checked separately |
| 114 | Implemented | Legacy portal duplication and disconnected token storage were removed; remaining deprecated code is tracked for a bounded follow-up audit |
| 115 | Partial | Login and readiness browser evidence exists; a real owner and replacement-worker acceptance pass still requires the relevant account holders |

## External Acceptance Items

- Owner chooses the initial password once.
- A replacement worker accepts an invitation.
- Google, Trello, browser, and optional mail permissions are approved by their
  actual account owners.
- A stable public callback is registered for push webhooks.

## Container Lifecycle Constraint, 2026-10-01

**Historical runtime description superseded:** the MySQL/Redis/tunnel stack
below describes the former deployment, not the current target. Use one
application container with separately provisioned shared PostgreSQL and
optional external Redis, as specified in [Production Cutover](PRODUCTION_CUTOVER.md).
Retain existing data and recovery archives until authorized migration/cutover;
this supersession does not authorize deleting a former database volume.
The one temporary verification workspace and exact-owned-resource cleanup
constraints remain in force.

Robert requested one operational VA Dashboard instance instead of accumulated
test instances. Keep the existing `joyce-work-schedule` application and its
required MySQL, Redis and tunnel services; these four services form one stack,
not four dashboard instances. Do not replace the operational image as part of
container housekeeping.

Future verification containers must be temporary and removed in a `finally`
cleanup after their receipts and necessary recovery state have been retained.
Use `--rm` where that preserves required evidence; otherwise remove the exact
owned stopped container IDs explicitly. Do not leave successive rehearsal
applications, builders or browser runners active between verification phases.
Do not use shared-host pruning or remove database volumes, recovery images or
other projects as a shortcut. Recreating a test environment does not authorize
production cutover or another permanent dashboard instance.

Robert tightened this rule on 2026-10-01: allow at most one temporary
verification container alongside the operational stack. Run verification phases
sequentially and confirm removal before starting the next one. A cleanup failure
blocks the next phase. A database/browser rehearsal needing several separate
containers must first be redesigned as one isolated test workspace; do not
silently recreate a multi-container test stack. Keep the required operational
MySQL, Redis and tunnel services intact.
