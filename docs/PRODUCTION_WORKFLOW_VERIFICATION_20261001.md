# Compiled Production Workflow Verification, 2026-10-01

## Decision

Not cleared for production cutover or active planning. This evidence supplements,
not replaces, the completion matrix and provider, recovery and shadow-trial gates.

## Exact Scope

The application is the unchanged compiled image
`sha256:6d3754b561d549b9853af2f460be4c7a6cfb27cda834f353ef65423a455d3860`,
running Node 22.23.3 as UID 1001 without an OpenAI API key or authentication bypass.
Its frozen source inventory is
`artifacts/production-subscription-config-20261001/source.json` (1,072 files;
digest `5372087f5bb6cbfd961e7d48b996606240ff677ccc2ed456c947c4ce4ab560a1`).

The updated browser spec and its error-classification helper are a separately
hashed test overlay, recorded in each run's `execution.json`. They do not change
the application image or imply that the entire current working tree was rebuilt.

One temporary, network-isolated container contains fresh MySQL, Redis, the actual
application filesystem, Chromium and a fixture-only TLS proxy. It has no published
ports, production database mounts or provider credentials. Background jobs and
automatic external writes are disabled. Tests use real UI login, business APIs
and persisted database records, not intercepted API responses. This is synthetic
fixture acceptance, not live Google/Trello/model delivery or a human shadow trial.

## Initial Results And Failure

In `artifacts/production-subscription-runtime-20261001-attempt5`, the worker
workflow passed on desktop dark, desktop light and mobile light. It verifies:

- New linked evidence is retained and used on reassessment.
- A worker's submitted update is saved as evidence and produces a newer run.
- The generated shadow proposal is not applied to the saved daily plan.
- A completed block remains protected.
- Worker access to founder review and policy mutation is denied.
- Settings distinguish a configured interval from disabled automatic checks.
- The worker interface excludes technical/model assessment text; the plan
  suggestion remains separate from the executing agenda.

The administrator scenarios fail the final browser-error audit: Chromium cannot
retrieve two unavailable-provider response bodies (`Network.getResponseBody: No
data found for resource with given identifier`). Their assignment/timeline 503
messages therefore remain unverified failures, not ignored errors. Business
review assertions alone do not make those browser scenarios accepted. Serial
founder-approval follow-up scenarios are skipped after the administrator failure;
they are not counted as passing coverage.

The terminal result at 15:44 UTC is three passed, three failed and three skipped
scenarios. All four owned child services exited normally, the temporary container
was removed and the original operational application remained healthy. The 54-row
migration ledger was unchanged and MySQL event scheduling stayed disabled.
`boundary.json`, `execution.json` and `workflow.json` retain the failed overall
result; cleanup success does not turn a failing verification into acceptance.

Attempts 3 and 4 are retained. Attempt 3 exposed an outdated settings expectation;
attempt 4 exposed the specific unlinked-Trello-member precondition previously
hidden by a blanket console-error exception. No failed receipt was rewritten.

## Test Repairs

The blanket exception for all HTTP 412 errors was removed. The intentional
unlinked-member fixture failure is accepted only on `trello.actionAlerts` with
HTTP 412, the exact message, numeric error code and structured procedure/code
fields. Its console query message also requires a verified corresponding response.
Unavailable assignment/timeline responses require their exact HTTP 503 contracts.
Unknown, unreadable or differently scoped failures continue to fail the test.

Four error-classifier tests and six setup-diagnostic tests passed locally. Their
combined command is now in CI; remote CI has not been run for these edits.

## Follow-Up From Initial Run

### Response Disposal Follow-Up

Inspection of the failed trace shows `net::ERR_ABORTED` on both HTTP 503 responses,
with no retained body. Both frontend reads threw on a non-OK status without reading
the response body. The working source now consumes and discards that body before
raising the existing generic unavailable error; it never renders the private body.
Two regressions assert `bodyUsed` and absence of private diagnostics in the UI.
All 59 tests in the two affected availability suites passed locally with Node
25.2.1 and Vitest 2.1.9. This is not the pinned production-runtime verification.

This source edit is newer than the compiled image above. It still needs a fresh
frozen build and full compiled workflow rerun; the trace observation and local
tests do not prove that it resolves the complete browser failure.

The initial run required repairing response-observation reliability without
masking errors and rerunning all nine compiled workflows; the fresh result below
records that work. Populated urgent-conflict/intervention coverage and actual
provider/runner availability still need verification. Full-data
old/new binary rollback, final-source broad checks, remote CI and the reviewed
five-working-day/100-proposal trial remain required before activation.

## Fresh Compiled Response-Disposal Result

The response-disposal repair now passed all nine compiled browser scenarios:
new evidence and worker update, administrator review/activation denial, and
founder approval unlocking follow-up, each on desktop dark, desktop light and
mobile light. There were no skipped cases. The prior response-body failures are
resolved in this run; earlier failed receipts remain unchanged.

Exact evidence:

- Frozen source: `artifacts/production-subscription-config-response-disposal-20261001/source.json`,
  1,075 files, digest `603fb029fe0cf829a83897bbd20c165e746bb5f8e9c533c671bd2721a1d62ce9`.
- Type check, sealed build, 182 focused tests with no failures/skips, and ten Node
  diagnostic/classifier tests passed on Node 22.23.3 (Vitest 4.1.11).
- Actual candidate image: `sha256:de88be7924df987e139ffafe06b5050f4bf6fc168408a49dc65a602de8514ef9`.
  Eight packaging/security checks passed in
  `artifacts/production-subscription-image-response-disposal-20261001/boundary.json`.
- Workflow receipt: `artifacts/production-subscription-runtime-response-disposal-20261001-attempt6/boundary.json`.
  All nine cases passed; the temporary container was removed and the original
  operational application remained healthy. Owned child services exited normally,
  the migration ledger stayed unchanged, and SQL scheduling remained disabled.

These are isolated synthetic workflows, not live-provider acceptance, a complete
route matrix, reviewed practice proposals or an authorized cutover.

### Additional Visual Finding

Inspection of the passing founder-approval screenshot exposed a display gap:
the completed prerequisite still said "Waiting for founder decision" because
the inspector used the historical `requiresRobert` flag without checking status.
The earlier assertions checked the released follow-up, not the prerequisite label.

The working source now gives completed status precedence, shows "Done", and
suppresses stale waiting/decision labels or stale manager-action badges. Open and
deferred decisions keep their existing hold. Five rendering regressions plus the
three existing projection tests passed locally (Node 25.2.1/Vitest 2.1.9).
The full browser workflow now also asserts the approved prerequisite's label.

This inspector repair and strengthened browser assertion are newer than the image
and frozen source above. They require a fresh build and compiled rerun. No deploy
or complete-production-readiness claim is implied by the nine earlier passing cases.

### Completed-Decision Candidate

The inspector repair has now passed a fresh frozen-source build on Node 22.23.3:
190 focused tests, ten Node diagnostic/classifier tests, type checking and the
sealed production build. Source digest:
`900c355113bb2f1911ee36dc9138768ee46dcc42f6ced46d60880d3c8fce908a`
(1,075 files). The actual Docker candidate is
`sha256:32778f7b00cf5da12ac33b782b046146f7a923d4b2332f8c5b8333c88445671b`.
All eight packaging checks passed; the temporary container was removed and the
original application remained healthy. Evidence lives in
`artifacts/production-subscription-config-completed-decisions-20261001/` and
`artifacts/production-subscription-image-completed-decisions-20261001/`.
Compiled workflow acceptance is separate from these build checks.

The subsequent compiled workflow attempt (`production-subscription-runtime-completed-decisions-20261001-attempt2`)
did not execute browser cases: the combined test-environment Docker build reached
its 300-second client timeout without confirmed build completion. A separate
Docker status query also stopped responding. No test-container launch occurred.
Do not infer either browser acceptance or current operational health from this
attempt. Its failed receipt is preserved; no Docker daemon restart or operational
container replacement was performed.

A subsequent bounded recheck confirmed that `docker ps` still timed out after
15 seconds. Direct HTTP requests to the operational port 3025 health and readiness
endpoints each timed out after five seconds. Therefore operational availability
is currently unverified, not healthy by inference from earlier receipts. A
controlled Docker Desktop restart requires operator authorization because this
host also runs unrelated projects. No restart or additional container launch was
performed during this recheck. After recovery, verify the original application
identity, image and health, inspect any pending build state, and only then select
a fresh unique workflow attempt; do not overwrite the timed-out attempt.

While Docker recovery remained pending, the current working source passed 290
local tests across `aptlssManagerConflict.test.ts` (66),
`aptlssManagerFacts.test.ts` (159), `aptlssManagerEngine.test.ts` (46), and
`aptlssManagerQuestions.test.ts` (19), using Vitest 2.1.9. These verify bounded
logic and mocked transaction contracts, not a compiled browser/realtime/SQL
conflict lifecycle. They do not substitute for the outstanding populated urgent
conflict integration scenario or authorize activation.

### Recovered Completed-Decision Workflow Result (2026-10-02)

Attempt 3 completed inside the isolated container at 2026-10-01T16:24:52.506Z.
Direct inspection of `execution.json` and `workflow.json` confirms all nine cases
passed, with no skipped cases, on the completed-decision candidate identified
above. The strengthened approved-step `Done` assertions are included in test
overlay digest `33d426972998cdb62541a07375f7cd04666397fd232635559bf674e86f15f625`.
The migration ledger was preserved, SQL scheduling disabled, and all four owned
services exited normally with code zero.

The interrupted outer controller left its `boundary.json` unfinished. That file
is retained unchanged, not retroactively presented as a successful controller
receipt. Recovery inspection at 2026-10-02T06:52:56.440Z verified the original
operational container still runs its original image and is healthy; a separate
Docker inventory found no `va-dashboard` temporary container. No restart or
cutover was needed. This resolves the compiled workflow gate for the inspector
repair, not live providers, broad final-source checks, full-data rollback or the
reviewed practice trial.

### Configured Runtime On The Same Candidate (2026-10-02)

Attempt 4 passed all 21 configured-runtime checks using the same completed-decision
candidate image and Node 22.23.3. Its final controller receipt explicitly confirms
acceptance, temporary-container removal and original operational health:
`artifacts/production-subscription-runtime-completed-decisions-20261001-attempt4/boundary.json`.
No production database or live providers were accessed. Unlike recovered attempt 3,
this attempt has a complete outer lifecycle receipt. These checks do not substitute
for a complete final-image route matrix, full-data rollback or live acceptance.

### Full Route Matrix On The Same Candidate (2026-10-02)

Attempt 5 completed all 64 route cases (40 admin, 24 worker) and eight setup
checks on the completed-decision candidate. All settled UI checks passed across
desktop/mobile and dark/light. No setup reported page errors, asset errors,
external requests or blocked mutations. A management screenshot was visually
inspected; its empty-worker state is not populated management acceptance.

Overall acceptance remains **degraded**, not passed: the isolated unlinked,
non-pilot fixture returned manager-status 403, Trello action-alert 412 and timeline
503 responses. The verifier correctly exited unsuccessfully despite passing UI
checks. These observations require account/source acceptance, not relaxed error
filtering. The failed outer receipt confirms temporary-container removal and
original operational health:
`artifacts/production-subscription-runtime-completed-decisions-20261001-attempt5/boundary.json`.
Detailed scope and case results are in `runtime/route-matrix/results.json` within
that artifact directory. This closes route execution coverage on this candidate,
not provider functionality or complete production acceptance.

### Full Ordinary Suite On Frozen Candidate (2026-10-02)

`artifacts/production-completed-decisions-full-20261002/full-suite.json` confirms
3,163 passing tests, zero failures and 204 environment-dependent skips across
303 files, on Node 22.23.3/Vitest 4.1.11 and source digest
`900c355113bb2f1911ee36dc9138768ee46dcc42f6ced46d60880d3c8fce908a`.
Type checking also passed. Mandatory MySQL acceptance is not covered by these
skips or this database-free run.

The subsequent harness build command failed because pnpm attempted to reinstall
the locked symlinked dependency directory (`ERR_PNPM_UNSAFE_MODULES_DIR`). No
application build error was demonstrated by this attempt. The harness now uses
the same direct npm build-script invocation as the previously successful sealed
candidate build; that correction is not retroactive success of this failed
combined attempt. Its boundary remains failed, and the running host used the
older cleanup implementation, leaving operational-health acceptance unset.
An independent post-run Docker inspection confirmed the original application
image healthy and no temporary VA container. Earlier exact-source sealed-build
and packaging receipts remain the separate build evidence.

### Single-Container MySQL Acceptance Preparation (2026-10-02)

The owned single-container harness now has a MySQL mode invoking the frozen
source's mandatory nine-suite verifier against its own loopback `recovery_test`
database. It requires all 190 assertions, no skips, preserved migration ledger
and disabled SQL scheduling. No operational database is mounted or addressed.

Attempt 6 initialized the owned database but failed before test execution because
the glibc controller could not load the musl dependency bundle's native Rollup
module. The owned MySQL service exited normally. The harness was corrected to run
the suite with candidate Node 22.23.3 and its musl loader/library paths instead.
That runtime correction is not yet verified: attempt 7 failed at Docker container
inventory preflight with HTTP 500, before launching a test container. Neither
attempt proves MySQL acceptance. Preserve both failed receipts under
`artifacts/production-subscription-runtime-completed-decisions-20261001-attempt6/`
and `artifacts/production-subscription-runtime-completed-decisions-20261001-attempt7/`.
Do not start another attempt until Docker inventory, the original operational
container health and the empty temporary-container slot can all be verified.

### Mandatory MySQL Acceptance Passed (2026-10-02)

Attempt 8 failed before test execution: starting Node through the loader made
child processes use the loader as their executable. The harness was corrected
to start the candidate Node executable directly, with the copied musl interpreter
and required library paths. That failed receipt remains preserved.

Attempt 9 passed all 190 tests across the nine mandatory integration suites on
Node 22.23.3, against the isolated loopback test database and the same frozen
source digest `900c355113bb2f1911ee36dc9138768ee46dcc42f6ced46d60880d3c8fce908a`.
The 54-entry migration ledger was preserved and SQL scheduling remained disabled.
The owned MySQL process exited normally. The completed outer receipt confirms
temporary-container removal and original operational-container health.

Evidence: `artifacts/production-subscription-runtime-completed-decisions-20261001-attempt9/boundary.json`,
`execution.json` and `mysql-integration.json` in that directory.
No production database or live provider was accessed. This establishes current
candidate SQL integration acceptance, not full-data old/new binary rollback,
live subscription-runner acceptance or the required human-reviewed shadow trial.

### Urgent-Conflict Browser Coverage Audit (2026-10-02)

Inspection of `e2e/aptlss-manager-live.spec.ts` confirms that its new-evidence /
worker-update case explicitly expects zero interventions. Its successful nine
browser cases therefore do not prove the populated urgent-conflict lifecycle.
Mocked cases in `e2e/aptlss-manager.spec.ts` are separate UI contract coverage,
not replacement evidence for persisted conflict resolution or realtime delivery.

The missing isolated end-to-end acceptance must establish all of the following:

- Two retained, genuinely contradictory claims about the same subject produce
  an urgent intervention with identifiable claims and source references.
- A connected worker receives the intervention without manual reassessment;
  a disconnected client can recover it through polling/reconnection.
- Only the dependent task is blocked; unrelated work remains executable.
- A worker answer is retained as a declaration, not silently promoted to proof.
- An unsupported answer leaves the conflict open. A supported resolution is
  persisted with its source and causes a new assessment and shadow proposal.
- The active day plan remains unchanged throughout; another worker cannot read
  or resolve the fixture's conflict.

Use one owned temporary container and its isolated database. Do not write these
synthetic claims to operational accounts or count this audit as test execution.

### Conflict Path Inspection And Local Logic Refresh (2026-10-02)

The actual graph persistence path in `server/aptlssEvidenceGraphDb.ts` enqueues
urgent work transactionally for conflict creation, unresolved follow-up notes
and verified resolution. `operator.resolveVerificationFollowup` subsequently
attempts an immediate assessment; its caught assessment failure does not replace
the durable queued event. This is source inspection, not proof that a deployed
queue consumer or websocket delivered the event.

A fresh local run of `aptlssManagerFacts.test.ts` (159),
`aptlssManagerQuestions.test.ts` (19) and `aptlssManagerConflict.test.ts` (66)
passed all 244 tests with Vitest 2.1.9 at 09:19 local time. These tests cover
bounded logic and mocked contracts; they are not pinned-candidate SQL or browser
acceptance. The separate 190-test candidate SQL receipt remains authoritative
for its own scope. The populated urgent-conflict browser gate remains open.

### Persisted Conflict Lifecycle Acceptance (2026-10-02)

Attempt 20 passed 191 tests across all nine mandatory MySQL suites, including
the added conflict lifecycle test. It checks urgent assessment, an unsupported
answer retaining the open conflict without decision evidence, proof-backed
resolution, a subsequent assessment, and an unchanged stored daily plan.

The application is the unchanged frozen completed-decisions candidate. Only
`server/aptlssManagerIntegration.test.ts` was overlaid for this run, with SHA-256
`d20935c08eef366ab3a4ab04c1a916dfa53d6498e1303731ee5b4908665ab876`.
This is not a newly sealed source release. Node 22.23.3 was used; the completed
receipt confirms temporary-container removal and operational health.
Evidence: `artifacts/production-subscription-runtime-completed-decisions-20261001-attempt20/boundary.json`
and the integration report in that directory. Browser delivery, websocket timing,
reconnection and live provider acceptance remain separate open gates.

### Real Websocket Browser Assertion Failed (2026-10-02)

Attempt 21 adds real Socket.IO frame observation to the existing evidence/update
workflow, requiring the persisted run ID in a manager-updated event. All three
viewport/theme variants failed this assertion; six later serial cases did not
run. Type checking passed, but realtime delivery acceptance did not.
The cause is not yet established: application connection/emission, fixture
transport and observation must be distinguished before changing product code.
The fixture proxy already contains an upgrade-forwarding handler; absence of
that handler is not an established explanation.

The test overlay digest is
`37c81af34c13492b608166127d1dc4c68af16c336a2808b03254c9ff334ba11e`.
The failed receipt under
`artifacts/production-subscription-runtime-completed-decisions-20261001-attempt21/`
confirms temporary-container removal and original operational health. Preserve
the failure and traces; do not suppress or weaken the assertion to claim success.

### Websocket Observation Corrected And Passed (2026-10-02)

Both `client/src/hooks/useWebSocket.ts` and `server/services/websocket.ts`
configure `/ws`. Attempt 21's observer incorrectly filtered `/socket.io/`, so
its failure did not establish a product delivery defect. The observer now
matches the actual `/ws` transport without changing the event assertions.

Attempt 22 passed all nine browser workflow cases on desktop dark, desktop light
and mobile light. Each evidence/update case receives actual Socket.IO frames
containing the persisted source-assessment and subsequent worker-update run IDs.
Test overlay SHA-256:
`aa8c086880834d8aae0776df12a9a38ecef639f73fc7f9a52f6cdf13eccd163d`.
The completed receipt in
`artifacts/production-subscription-runtime-completed-decisions-20261001-attempt22/`
confirms temporary-container cleanup and original operational health.
This proves connected-client notifications for these nonurgent assessments;
urgent-conflict rendering, disconnected recovery and live integrations are not
covered by this result and remain open.

### Reconnection Listener Fix (2026-10-02)

Installed Socket.IO client type definitions locate `reconnect`,
`reconnect_error` and `reconnect_failed` on its Manager. The worker hook had
registered these events on the Socket, so its reconnect diagnostics would not
receive them. `client/src/hooks/useWebSocket.ts` now registers them through
`socket.io.on`; business events remain on the authenticated Socket.

Three new `server/workerWebSocketHook.test.ts` tests passed locally with Vitest
2.1.9: correct event targets, old-identity disconnect on cleanup, and no anonymous
connection. Type checking also passed. These are registration-contract tests,
not network-recovery acceptance. This production-source edit is newer than the
frozen candidate used in attempts 20 and 22; those receipts do not prove this
edited hook's compiled browser behavior. A fresh sealed candidate and a real
disconnect/reconnect browser case are still required.

### Reconnection Candidate Build (2026-10-02)

Reconnect Manager listeners now use named callbacks and are explicitly removed
on hook cleanup. The cleanup test verifies the exact registered callback is
removed before disconnecting the old identity. The combined local hook/server/
Redis-recovery run passed 18 tests.

A new frozen source candidate, digest
`4b57a61d9a30c6cdf09bdd456a794b124978b5b7874db6e619573e828babd20c`,
passed type checking, 208 focused tests without skips, ten Node checks and its
sealed build using the pinned dependency container. Receipt:
`artifacts/production-subscription-config-reconnect-20261001/boundary.json`.
The receipt confirms temporary-container cleanup and operational health.
Its `compiledRuntimeAcceptance` is explicitly false: this build is not yet
packaged-image acceptance, real network recovery or live-provider acceptance.

The reconnect candidate was subsequently packaged as Docker image
`sha256:2c9ecf74eaf55e2c2ad48124c39c73655bbf5d581b38eb8f54e250d5335b172a`.
All eight actual-image checks passed: production default, non-root execution,
no environment files, sealed bundle, collector integrity, icon, no Vitest, and
fail-closed startup. The receipt under
`artifacts/production-subscription-image-reconnect-20261001/` confirms cleanup
and operational health. No candidate deployment was performed.

Attempt 23 passed all nine real browser workflow cases on this reconnect image,
including connected-worker assessment notifications, worker updates, admin
review restrictions and completed-step presentation across desktop dark,
desktop light and mobile light. Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt23/boundary.json`.
The temporary container was removed and operational health confirmed. The
workflow overlay remains `aa8c086880834d8aae0776df12a9a38ecef639f73fc7f9a52f6cdf13eccd163d`.
No deliberate network interruption is included in these nine cases: reconnect
recovery remains an open gate, rather than implied by ordinary notifications.

### Real Transport Interruption And Recovery (2026-10-02)

Attempt 24 passed all nine browser cases on the reconnect candidate. The three
evidence/update cases now deliberately destroy upgraded websocket transports
through a loopback-only fixture proxy endpoint, then require a new authenticated
Socket.IO connection and a successful manager-status response within 30 seconds.
The stored assessment run and daily plan remain unchanged. The fixture harness
sets `APTLSS_TEST_TRANSPORT_RECOVERY=true`; no operational proxy is modified.
Type checking and fixture proxy syntax checking passed separately.

Receipt: `artifacts/production-subscription-runtime-reconnect-20261001-attempt24/boundary.json`.
The completed receipt confirms temporary-container removal and operational
health. This proves reconnect authentication and a status request after a real
transport loss in desktop dark/light and mobile light. It does not prove that a
new urgent conflict generated while disconnected is recovered, or polling-only
delivery when reconnection remains unavailable; those remain distinct gates.

Attempt 25 strengthened the recovery assertion to inspect the complete status
response. It failed because the test expected internal `snapshot.runId`, which
the worker projection intentionally omits. The actual operator API exposes
`expectedRunId` separately for concurrency control. The assertion now checks
that existing field against the persisted run; no worker data exposure changed.
The corrected assertion has not yet been rerun. Preserve attempt 25's failed
receipt, which confirms temporary-container cleanup and operational health.

Attempt 26 passed all nine cases with the corrected complete-response assertion.
The three recovery cases require `expectedRunId` from the deserialized worker
status to equal the persisted post-update run, after a real transport disconnect
and a new authentication. This strengthens attempt 24's status-request proof
without exposing internal snapshot fields. Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt26/boundary.json`.
Temporary-container cleanup and operational health are confirmed. Test overlay
digest: `a1449df1a43b71be4150ba3b733ffd17ab7180526e2d5aab3c063d21cb00f4b3`.
Missed new urgent information and polling-only delivery remain
unverified.

### Populated Urgent Conflict Browser Test Added (2026-10-02)

The workflow spec now adds one retained invoice conflict case per viewport/theme,
bringing the required count to twelve. It transactionally seeds two contradictory
source/worker statements, revisions, task links and a needs-verification conflict
in the owned test database, then invokes the real UI reassessment. Assertions
require an urgent persisted intervention, blocked dependent work, an actual urgent
websocket notification, a visible alert and an unchanged daily plan. The fixture
records use the existing exact worker-owned cleanup namespace.

Type checking and diff whitespace checks passed. These new cases have not been
executed: previous nine-case receipts do not cover them. Their assessment is
manually triggered; automatic queue consumption and conflict resolution through
the browser are still separate requirements, not implied by these assertions.

Attempt 27 executed all twelve browser cases successfully, including all three
retained urgent-conflict cases. The actual-image results in
`artifacts/production-subscription-runtime-reconnect-20261001-attempt27/runtime/results.json`
record twelve executed passing checks. The desktop-dark conflict screenshot was
visually inspected: worker guidance and a visible conflicting-facts warning are
rendered; dependent work is unavailable and technical AI assessment is hidden.
Workflow test digest:
`5eca23e2be0f16e26112f5993697ca267e2ef67e1275722bc8f3a099f9038a4f`.

The outer attempt nevertheless remains failed: a final inner-harness assertion
still required nine cases after the spec expanded to twelve. The assertion now
uses the explicit expected count supplied by the host, but this correction has
not been rerun. Preserve the failed receipt and successful individual browser
results separately. All owned services exited normally, the temporary container
was removed, and the original operational container remained healthy.

Attempt 28 reran the same twelve-case workflow with the corrected final expected
count and passed both individual browser cases and outer acceptance. Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt28/boundary.json`.
All twelve checks were executed under Node 22.23.3; cleanup and original
operational health are confirmed. This closes the harness-count failure from
attempt 27 without rewriting its receipt. Automatic urgent queue processing,
worker conflict resolution, missed-event recovery and polling-only acceptance
remain open and are not claimed by this successful notification/blocking run.

### Latest-Source Mandatory MySQL Acceptance

Reconnect attempt 29 passed all 191 mandatory MySQL checks under Node 22.23.3,
using the frozen reconnect source and packaged image identified above, with no
test overlay. Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt29/boundary.json`.
This refreshes the database gate for the latest candidate rather than borrowing
the completed-decisions candidate's SQL evidence. The conflict lifecycle check
retains an unsupported worker answer as a note, keeps the conflict open, and
requires source-backed resolution before reassessment; the shadow day plan
remains unchanged. This is database/service acceptance, not browser resolution
or automatic queue-delivery acceptance. The outer run passed, its temporary
container was removed, and the original operational application remained
healthy. No production data or live providers were accessed.

### Browser Conflict Resolution Extension: First Attempt

Attempt 30 extends each retained-conflict browser case with an open verification
follow-up, an unsupported note, and a source-backed resolution through the
existing task inspector. Owned cleanup now includes only this fixture worker's
verified-resolution evidence namespace as well as its assertions.

The nine preceding workflow cases passed; all three extended cases timed out
before reaching verification because the test requested `Open details` while
the blocked-work state exposes `Open related task`. The existing worker page
source confirms that conditional control. The test now targets the blocked-work
control, but the correction is not yet rerun. Do not count the note/resolution
browser path as accepted from this attempt. Preserve the failed receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt30/boundary.json`.

Attempt 31 reached the actual verification controls and saved the unsupported
note, but source-backed resolution was correctly rejected: the fixture had
registered its supposed external source under the worker-assertion namespace.
The three extended cases failed; the other nine passed. No application proof
restriction was weakened. The fixture now uses an exact owned external-source
identity for the original record, retains the worker-assertion identity for the
contrary assertion, and observes the source before conflict creation. Cleanup
includes that exact original identity, not an unbounded source pattern.
Attempt 31's failed receipt and diagnostics are retained; its test container
was removed and operational health confirmed.

Attempt 32 passed all twelve browser cases and outer acceptance under Node
22.23.3. In desktop dark/light and mobile light, the worker opens the blocked
task's existing inspector, saves an unsupported note without closing the
conflict, selects the retained external source and exact sentence, and closes
the follow-up with verified evidence. SQL assertions confirm both conflict and
follow-up status, a newer shadow assessment, and unchanged active day plan.
Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt32/boundary.json`.
The temporary container was removed and the operational app remained healthy.
This accepts the tested manual worker response/resolution route; it does not
establish automatic urgent-queue delivery, missed-event recovery, polling-only
delivery, live-provider consent, or the human-reviewed shadow trial.

### Automatic Durable Conflict Consumption: Service Acceptance

Attempt 33 passed 192 mandatory MySQL checks under Node 22.23.3, including a
new integration case using the existing timed queue runner with the real manager
service, not an execute stub. A canonical conflict is durably enqueued before
the runner starts; without calling manual reassessment or `drain`, the timed
runner persists an urgent intervention and blocked dependent work. The saved
assessment remains shadow-only and the active day plan is unchanged. The runner
is stopped in `finally` before fixture cleanup.

Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt33/boundary.json`.
The candidate application/source remain the reconnect build, with the current
integration test supplied as a recorded test overlay. This is not a new packaged
release source. The model and websocket adapter remain mocked by the existing
integration suite, so this establishes automatic queue-to-manager database/service
behaviour, not automatic application-process-to-browser delivery or live model
acceptance. Temporary-container removal and original operational health passed.
Type checking also passed after adding the case. No live accounts were touched.

### Automatic Application-To-Browser Delivery

Attempt 34 passed three targeted browser cases under Node 22.23.3, desktop
dark/light and mobile light, with the packaged application's existing background
workers and manager scheduler enabled inside the network-isolated owned fixture.
External reminders, briefings and founder alerts stayed disabled. No new
production scheduler or test endpoint was added.

The fixture transaction retains contradictory evidence, its follow-up and a
durable urgent queue request. The test never invokes manual manager assessment:
it waits for the application's timer-driven queue consumer to persist an urgent
assessment, observes the actual authenticated websocket event for that run, and
asserts a visible worker alert and blocked dependent work. The worker then saves
an unsupported note and resolves the issue using the retained external source
and exact wording. Conflict/follow-up persistence, newer shadow assessment and
unchanged active day plan are checked as in attempt 32.

Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt34/boundary.json`.
All three cases and outer acceptance passed; the temporary container was
removed and original operational health confirmed. The queue request is seeded
directly in this browser fixture; canonical ingestion-to-enqueue is covered by
the separate service/database case, not falsely described as live-provider
ingestion here. Live model/provider acceptance, new information during an
outage, polling-only delivery and target-host supervision remain open.

### New Conflict During Realtime Outage: Pending Acceptance

Attempt 35 adds a fixture-proxy pause of both websocket upgrades and Socket.IO
polling requests while ordinary dashboard requests remain available. After
authenticated realtime connection, the test pauses that channel, retains a new
urgent conflict and queue request, and waits for the actual periodic manager
status query to display the conflict. It checks that no realtime event for that
assessment arrived, resumes the channel, observes re-authentication, and then
performs the existing source-backed worker resolution.

All three variants reached final console-error validation, which failed on
expected websocket connection/reconnection timeout diagnostics generated by the
deliberate pause. The receipt remains failed:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt35/boundary.json`.
The test now classifies only those exact timeout diagnostics during its own
controlled-outage window as expected. Other errors, and timeouts outside that
window, remain failures. This correction has not yet been rerun; do not mark
outage/polling acceptance complete. Cleanup and original operational health
were confirmed after the failed attempt.

Attempt 36 passed desktop-dark and mobile-light completely. Desktop-light
reached final console validation but failed because the proxy's resume control
destroyed a held websocket handshake, generating handshake-closed and websocket
error diagnostics. The receipt remains failed (two passing cases, one failure),
with confirmed cleanup and original operational health. The proxy now resumes
held HTTP/upgrade requests by forwarding them to the real application rather
than destroying their live sockets. No broader console-error exemption was
added. Proxy syntax and repository type checking passed; the full rerun of this
proxy correction is still pending. Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt36/boundary.json`.

Attempt 37 passed all three outage browser cases and outer acceptance with the
corrected proxy: desktop dark/light and mobile light, under Node 22.23.3. Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt37/boundary.json`.
The actual background manager processes a new retained conflict while realtime
is held unavailable. No websocket event for that run reaches the browser; the
ordinary periodic manager-status query nevertheless renders the conflicting-facts
warning. Resuming held requests restores authenticated realtime, followed by
source-backed conflict resolution and unchanged active day-plan assertions.
Temporary-container removal and original operational health both passed.

This accepts periodic HTTP status polling as fallback for missed realtime
information. It is not an offline internet-access guarantee, Socket.IO
long-polling-only transport acceptance, live-provider/model acceptance or
target-host scheduler supervision. The failed attempts remain unchanged.

### Latest Candidate Configured Security And Startup Gate

Attempt 38 passed all 21 configured-runtime checks on the reconnect image under
Node 22.23.3, without an OpenAI API key or local authentication bypass. Coverage
includes readiness with MySQL/authenticated Redis, CSP/HTTPS headers, anonymous
API rejection, five synthetic account sessions/cookies, worker and pending-role
restrictions, workspace isolation between separate admin-role accounts,
cross-site mutation rejection, websocket authentication/origin/room isolation,
and four compiled HTTPS browser smoke cases. Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt38/boundary.json`.
The detailed check inventory is retained in the same attempt's
`runtime/results.json`. All checks and outer acceptance passed; temporary
container cleanup and original operational health passed.

The TLS certificate and accounts are owned synthetic fixtures. This does not
establish public TLS, real worker invitation acceptance, provider permissions,
live model availability, broader 64-route acceptance or production cutover.

### Latest Candidate Broad Route Matrix

Attempt 39 completed all 64 route cases and eight login/theme setups on the
reconnect image. Settled UI assertions passed for every case, including desktop
and mobile, dark and light. An admin-settings dark screenshot was inspected and
shows the missing-Trello-source error explicitly rather than a successful empty
result. Overall acceptance remains degraded/failed because source APIs are
unavailable; no integration error was relabelled as a pass.

Receipt:
`artifacts/production-subscription-runtime-reconnect-20261001-attempt39/boundary.json`.
Route detail: the same attempt's `runtime/route-matrix/results.json`.
Observed boundaries: timeline tasks and assignments return 503; Trello boards,
workspaces and tasks return 500 with unusable fixture credentials; action alerts
return 412 for an unlinked account; manager status returns 403 for fixture accounts
outside the configured pilot. These are not live-account/provider acceptance.
The previous source-specific broad UI evidence is now refreshed for this image,
but populated workflow evidence remains the separate attempts described above.
Temporary-container removal and original operational health were confirmed.
