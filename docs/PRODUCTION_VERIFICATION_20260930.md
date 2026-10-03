# Production verification: 2026-09-30, continued 2026-10-01

## Decision

Not ready for cutover. Keep production authentication and APTLSS shadow mode enabled.
This is a dated verification record, not a claim that all existing product functionality
has been accepted. Preserve the developer platform and existing operator features.

## Changes prepared in the working branch

- Mandatory MySQL verification via `pnpm test:mysql`: seven integration suites must
  execute every assertion successfully. Missing, skipped, duplicate, or inconsistent
  reports fail the gate. An explicit loopback test database is required; the script
  does not fall back to the production database URL.
- CI now runs that gate and the existing isolated APTLSS browser acceptance suite.
  Browser smoke tests disable background jobs in an explicit test database.
- CI retains integration and browser reports, including reports from failed runs.
- The disposable CI database user can inspect only the two performance-schema
  lock tables needed by the concurrency tests. Production grants are unchanged.
- Updated Axios to 1.20.0, DOMPurify to 3.4.16, and Engine.IO to 6.6.10. Other
  pre-existing dependency changes are retained.
- Node container base pinned by digest. The Trello icon assets and narrowly scoped
  cross-origin image header remain part of the source release.
- The final runtime image defaults to production mode and excludes every `.env.*`
  file from its build context. CI verifies the actual image, not only source:
  non-root user, sealed bundle/collector, icon, no root environment files, no Vitest,
  and rejected startup without required configuration, with provider network access disabled.
- An acknowledged review becomes read-only immediately, even when the review inbox
  refresh is delayed. An unconfirmed save keeps the form editable and preserves the
  entered notes. This is based on the server acknowledgement, not an optimistic save.
- Browser lifecycle failures retain their original cause and mutation name while
  preserving uncertain fixtures until the dedicated test server has stopped.
- Operational and rehearsal record-preservation checks stream source rows instead
  of retaining entire tables of assessment JSON in memory. Existing checkpoint
  columns, row counts and hashes remain compatible, including duplicate records.
  These checks retain one digest per row; total memory is not constant.
- Image acceptance uses uniquely named, network-disabled temporary containers
  and attempts cleanup of exactly those containers, including after a client
  timeout. Unconfirmed cleanup fails acceptance; no shared services are removed.
- Native SQL restore checks the recorded size, SHA-256 and completion marker with
  bounded reads, holds the same descriptor for import and verifies it again.
  It rejects changed files, out-of-directory paths, oversized manifests and
  incomplete imports. Native client commands and local file loading are disabled.
- Restore requires the isolated server's scheduler to be startup `DISABLED`,
  not merely `OFF`, and complete event visibility. Event definitions block
  acceptance after import; failed databases are retained and cannot execute events.
  The hash precheck has a 10-minute deadline; import has a 30-minute deadline.
- Native migration rehearsal covers all 53 canonical entries through 0052, keeps
  captured foreign/legacy identities intact, checks generated review columns and
  streams its distinct historical row-object digests. Preservation checkpoints
  and timestamped reports retain earlier evidence instead of overwriting it.

## Evidence obtained

| Check | Result | Scope and limitation |
| --- | --- | --- |
| Host full suite | 2,378 passed; 156 skipped | Baseline only: installed host dependencies were older than the current lockfile. Does not prove database behavior or the updated dependency set. |
| MySQL gate unit tests | 15 passed | Unsafe URLs and incomplete, skipped, duplicate, or misleading reports are rejected. |
| Initial streaming-fingerprint verification | 31 passed; zero failed or skipped | Includes three real-MySQL assertions with large source payloads, dates, binary data, Unicode and duplicates. Host Vitest is older than the locked release dependency set. Report: `artifacts/operational-fingerprint-host-20261001.json`. |
| Expanded verification-tool unit tests | 37 passed; zero failed or skipped | Includes immutable column selection, pre-query identifier validation and bounded image-container isolation/cleanup. Host-dependency evidence only. Report: `artifacts/production-verification-tools-host-20261001.json`. |
| Current verification-tool tests with locked dependencies | 37 passed; zero failed or skipped | Newly built isolated verification image, Vitest 4.1.11. Report: `artifacts/production-verification-tools-locked-20261001.json`. |
| Restore and verification-tool tests with locked dependencies | 87 passed; zero failed or skipped | Vitest 4.1.11 in the owned verification container: 49 backup/child-lifecycle cases, 16 fingerprint cases, 15 strict SQL-gate cases and seven image-verifier cases. Report: `artifacts/pilot-restore-tools-locked-20261001.json`. Not a Linux native-client integration run. |
| Native MySQL restore safety | 71 passed; zero failed or skipped | Host Vitest 2.1.9: 49 backup/lifecycle cases, 16 fingerprint cases and six real native MySQL 8.4.11 imports. Includes a 16 MiB statement, binary/Unicode/CRLF preservation, rejected shell/source commands, immutable scheduler state and version-comment events that cannot execute or pass acceptance. Report: `artifacts/pilot-backup-restore-native-host-retry-20261001.json`. |
| Historical operational restore and current migrations | Seven passed; 124 original table fingerprints preserved | The actual September 5 backup (12,501,536 bytes, SHA-256 `33fd77945dfd7cc011a4701b77214b23fb42a3f1ec368eb70cd621b5b8b3bbad`) restored using the revised utility on a newly created native server. Original 47 ledger identities retained; eight canonical entries appended through 0052. Fresh lineage contains all 53 entries. Report: `artifacts/pilot-migration-rehearsal-historic-retry-20261001.json`; private checkpoint `.local/pilot/rehearsal-safety-20261001-before.json` and its timestamped preservation report. Not a current-size production restore, configured application acceptance or rollback-duration proof. |
| Final formatted restore source | Host: 78 passed; locked tools: 87 passed; zero failed or skipped | Reports: `artifacts/pilot-restore-final-host-20261001.json` and `artifacts/pilot-restore-final-locked-20261001.json`. Host report includes all seven historical migration assertions and six native-client import cases. Locked report is tool-unit evidence only; these counts overlap and must not be added together. |
| Frozen dependency installation | Passed | Updated lockfile installed inside the isolated release-check container. |
| Dependency audit | No known vulnerabilities found | Updated dependency set, including development dependencies; not a guarantee of security or an OS image scan. |
| Type check with updated dependencies | Passed again after the review UI fix | Isolated release-check container; the initial low-memory retry failed with a JavaScript heap exhaustion, not a type diagnostic. |
| Current fresh-image cold type check | Passed on retry | New verification image with current source and frozen dependencies. The initial 1 GiB heap attempt exhausted memory; retry used a 2 GiB heap in the owned 2.5 GiB verification container. |
| Focused current locked-dependency tests | 35 passed; zero failed or skipped | Shadow controls, production configuration and strict MySQL report gate after the review UI fix. Report: `artifacts/production-focused-20261001.json`. |
| Canonical migrations and rerun | Passed | Fresh disposable MySQL database, not a production-data restore rehearsal. |
| Builder-stage image | Built successfully | Built before the final dependency/CI edits; not the final production runtime image. |
| Locked-dependency full suite before the review UI fix | 2,542 passed; zero failed; seven skipped | The seven skipped cases require the separate restored native-MySQL rehearsal. Includes the 149 real integration assertions, not additional to them. Report: `artifacts/production-all-tests-20260930.json`. |
| Ordinary full suite before the restore-tool changes | Report: 2,415 passed; zero failed; 159 skipped | Explicitly no database URL or provider credentials. The 152 SQL assertions passed separately in the fresh seven-suite gate. The seven native cases were skipped in this report and later passed independently against the historical backup, not today's full-size database. Report: `artifacts/production-full-unit-20261001.json`. The completed Docker command's Windows client remained attached and was stopped only after confirming no active container exec; do not report a normal successful client exit or a full-suite rerun after the latest restore changes. |
| Prior real MySQL integration gate | 149 passed; zero failed or skipped | Six suites on a fresh disposable `aptlss_test` database, updated locked dependencies. Before adding the seventh streaming-fingerprint suite; not evidence for the expanded current gate. Report: `artifacts/production-mysql-passed-20260930.json`. |
| Expanded MySQL gate on the reused browser database | Refused: 139 passed; 13 skipped | Queue suite initialization correctly rejected an unowned worker retained by the earlier browser fixture. An isolated diagnostic reproduced `Periodic queue fixtures require no unowned workers; refusing to enqueue unrelated work.` Existing fixture evidence was not deleted. Report: `artifacts/production-mysql-expanded-20261001.json`. |
| Current expanded MySQL gate on a fresh isolated database | 152 passed; zero failed or skipped | All seven required suites executed with frozen dependencies, after all 53 canonical migrations on a new MySQL instance. Report: `artifacts/production-mysql-fresh-expanded-20261001.json`. This does not prove a production-data restoration. |
| Schema parity | Passed | All 132 expected tables and columns present; four historical compatibility columns preserved. `__drizzle_migrations` is the additional actual table. |
| Migration generation drift | None | Drizzle reports no schema changes in the isolated candidate. |
| Production runtime image before the review UI fix | Built; eight image checks passed | `va-dashboard:production-runtime-candidate-20260930`, non-root, production default, frozen updated dependencies, sealed artifacts and icon. Not deployed; rebuild required after subsequent source edits. |
| Production runtime image after the review UI fix | Built successfully; image acceptance incomplete | `va-dashboard:production-runtime-candidate-20261001`. Eight-check verification stopped on a bounded Docker runtime-command timeout; do not reuse the earlier image's passing result for this candidate. Not deployed. |
| Current production runtime image with verification updates | Built; all eight image checks passed | `va-dashboard:production-runtime-candidate-tools-20261001`, inspected image ID `sha256:037a723d0a575826484af79ce5f0acdcb31990aa8b35c2b45258b5892affc2f8`. Verifier exited zero; no named check containers remained. Report: `artifacts/production-image-tools-20261001.json`. Not deployed and not configured/authenticated runtime acceptance. |
| Final runtime image after restore-source formatting | Built; all eight image checks passed | `va-dashboard:production-runtime-candidate-restore-final-20261001`, inspected image ID `sha256:8fc4cad137127f8495bbbc6a15f3a5fa15134436009962983fd26d9cbeb087b1`. Verifier exited zero and its named containers were absent afterward. Current locked-dependency type check also exited zero. Summary: `artifacts/production-restore-verification-20261001.json`. Not deployed, no provider calls or authenticated-runtime acceptance implied. |
| Initial host browser acceptance | 82 passed; one failed; one not run | Exposed the mobile saved-review refresh bug. Report: `artifacts/production-host-browser-20260930.json`. |
| Mobile live routes after the fix | Three passed | Real API and isolated MySQL: source/worker update, saved review and shadow-only activation denial, founder approval and worker reassessment. Report: `artifacts/production-mobile-rerun-20261001.json`. |
| Extended host browser acceptance after the fix | 86 passed; one failed | All three new save-confirmation regressions passed. Mobile guidance-withdrawal lifecycle timed out; retained trace and fixture. Report: `artifacts/production-host-browser-20261001.json`. Uses Playwright 1.60.0, but host backend dependencies are not the newly installed Linux release dependency set. |
| Separate mobile review-lifecycle rerun | One passed | Same timeouts, no competing heavy checks. Guidance withdrawal, reassessment and trial lifecycle passed. Report: `artifacts/production-review-lifecycle-20261001.json`. Does not erase or explain the earlier full-run failure. |
| Release-tree secret scan | Zero findings | 1,015 non-ignored source files, pinned CI Gitleaks image, six existing exact fixture fingerprints excluded. Ignored local environment files, private backups, generated artifacts and Git history were not scanned. This does not prove provider credential rotation. |
| Updated release-tree secret scan | Zero findings | 1,019 non-ignored source files after adding the verification helpers/tests, pinned CI Gitleaks image and the same six exact fixture exclusions. Report: `artifacts/release-secret-scan-20261001/gitleaks-report-20261001-tools-final.json`. An initial scan mounted at `/scan` instead of `/repo` reported the six known fixtures because the exact exclusion paths did not match; the exclusions were not broadened. |
| Public readiness recheck | HTTP 200 locally and publicly | Observed 2026-09-30 21:40 UTC; this checks the existing public build, not the new candidate or live integrations. |
| Later existing-build readiness recheck | Not confirmed healthy | Local port 3025 exceeded the 15-second request timeout and the public readiness request returned an unsuccessful HTTP response. No cutover or shared-runtime restart was performed. Intermittent host/deployment availability remains open. |
| Latest existing-build readiness observation | HTTP 200 locally and publicly | Observed 2026-09-30 22:39:34 UTC. Recovery of responsiveness does not establish the incident's cause or prove that the new candidate is deployed. |
| Subsequent tunnel observation | Local HTTP 200; public HTTP 404, then 503 | Local/public observation at 22:59:51 UTC; public retry at 23:00:42 UTC returned `ERR_NGROK_3004`. The provider documents an invalid/incomplete upstream HTTP response, not a proven authentication failure. Exact cause remains unestablished; no shared restart or cutover. |
| Remote CI | Not run | Changes remain local; no push or merge performed. |

## Runtime incident and testing precautions

During verification, two test commands were started against the same disposable
database. That concurrency was a test orchestration error; neither pending run may
be treated as release evidence. The competing full-suite process and its children
were stopped after checking their isolated-container identity. The release-check
container was subsequently inspected and had no running test commands before retrying.

The Docker CLI temporarily stopped responding. The existing localhost readiness endpoint
timed out, and the public readiness URL returned HTTP 404. The cause is not
established. The CLI subsequently recovered, and the existing application container
reported healthy. No shared-runtime restart was performed. Do not stop unrelated
containers as part of this verification without authorization.

The Docker command delay recurred during the 2026-10-01 continuation. The focused
tests and new image build eventually completed, but the bounded image runtime
verification timed out. A subsequent readiness probe could not confirm the
existing application's availability. Do not call this a candidate regression or
a resolved infrastructure incident without determining the actual cause.

At 23:00:42 UTC the public readiness URL returned HTTP 503 with
`ERR_NGROK_3004`. [The provider's primary documentation](https://ngrok.com/docs/errors/err_ngrok_3004)
describes an invalid or incomplete HTTP response from upstream. Its suggested
HTTP/HTTPS mismatch is one possible cause, not a diagnosis of this deployment.
Earlier responses alternated between 200 and 404, while the later local probe
returned 200. Preserve these time-bounded observations rather than claiming the
tunnel or application has been repaired.

The failed first MySQL run is preserved as
`artifacts/production-mysql-failed-20260930.json` (130 passed, six failed,
13 skipped). It exposed missing test-only lock-observation grants; its concurrent
run also invalidated the fixture isolation. The passing rerun used a fresh test
database with those narrow grants and no competing suite. The release-check
container is now limited to one CPU and 1.5 GiB of memory (2 GiB including swap).

The fresh expanded verification container initially used the same limits. Its
cold TypeScript check exhausted a 1 GiB JavaScript heap before obtaining a result.
Only this owned verification container was increased to 2.5 GiB of memory
(3 GiB including swap), with a 2 GiB heap for the retry. Production limits and
shared services were unchanged. The failed cold check is not a passing type result.

Run database verification, the full suite, and browser acceptance sequentially.
Use bounded CPU/memory for newly created rehearsal containers. The test database
is separate from production, and existing production records have not been migrated
or replaced in this verification round.

The expanded seven-suite run used the earlier browser-test database and correctly
refused its remaining unowned worker. It obtained 139 passing assertions but skipped
the 13 queue assertions after the fixture guard failed. That report is not accepted.
A new disposable MySQL instance on loopback port 33319 was prepared for the retry;
the old browser database and its retained fixture remain intact. Both use the same
locally verified MySQL image identity and test-only lock-observation grants.
The fresh retry subsequently passed all 152 assertions in seven suites. The
refused earlier report remains available and is not rewritten as a successful run.

The ordinary full-suite report completed with 2,415 passing assertions, no failures,
152 explicitly skipped SQL assertions and seven skipped native restore assertions.
Docker inspection showed only the idle container process and `ExecIDs: null`,
but its Windows command client did not close. The exact client identity and
output-file argument were verified before stopping only that client; no container
or production service was stopped. Preserve this transport limitation separately
from the assertion results. Remote CI still needs a normal complete command exit.

## Remaining release gates

1. Recheck actual public readiness before cutover; a healthy container state alone
   does not prove the public application route or integrations are operational.
2. Complete the secret scan, browser matrix and locked-dependency APTLSS browser
   acceptance. Preserve source-linked reports; rerun checks if source changes.
3. Verify the candidate's configured health endpoints, asset headers, and RBAC for
   worker, founder, and admin separately. Passing image-integrity and fail-closed
   startup checks do not replace authenticated runtime acceptance.
4. Rotate exposed credentials through the appropriate provider accounts. Never
   put real credentials in source control, CI artifacts, or handoff documentation.
   Live-provider acceptance must be explicit and must not send unintended messages.
5. Back up the actual deployment database and previous build, rehearse restoration
   and additive migrations with preserved record counts/aggregates, and record
   rollback steps. Fresh-database migration success is not this evidence.
   Bounded SQL validation and native event/client safety are now tested. Current
   0052 assertions passed on the historical September 5 restore, with all original
   record fingerprints preserved. Rehearse today's full-size backup and rollback
   duration separately; the small historical backup does not satisfy that gate.
6. Keep APTLSS in shadow mode until the existing five-working-day and 100-reviewed-
   proposal acceptance criteria are met. No critical errors; at least 98/100
   adequately supported, correct reviewed proposals. This is not a probability
   of future correctness. External messages remain worker-reviewed drafts.
7. Make the authorized cutover only after all gates pass, then verify the actual
   public worker path and integration health. Do not replace the current dashboard
   merely because a candidate image builds.

The 2026-10-01 full host browser run retained an uncertain mobile fixture after
`operator.revokeManagerCorrection` did not produce a response within 45 seconds.
The request trace also shows an unfinished decision-inbox read. A later read-only
inspection of the isolated database showed zero lock waits; that later observation
does not establish the cause at failure time. The desktop lifecycle passed. Do not
hide the failed run or increase timeouts merely to obtain a green report.

## Restore follow-up evidence

The initial native restore-safety run refused MySQL 8.4's expanded global privilege
representation; it did not execute the six import cases. The initial historical
schema run then failed two generated-expression comparisons because MySQL metadata
escapes its quotes. Both original reports are retained. The fixes accept an explicit
global EVENT privilege (or ALL PRIVILEGES), preserve literal case when comparing
generated expressions, and do not weaken the DISABLED scheduler requirement.

The final formatted-source run passed all 78 host cases, including six real native
imports and seven restored/fresh migration cases. The distinct locked-container
tool run passed 87 cases. The owned native server was shut down normally after
verification; its restored data and previous checkpoints remain in private local
storage. No production service was restarted or replaced.

The final redacted Gitleaks scan found zero findings across 1,022 non-ignored source
files (about 17.82 MB). Report:
`artifacts/release-secret-scan-restore-20261001/gitleaks-report-restore-final.json`.
This is not a scan of Git history, private environment files or SQL backups, and
does not prove that exposed provider credentials have been rotated.

At 2026-09-30 23:27:36 UTC, both the local and public readiness endpoints returned
200 again. That single recovery observation does not establish the cause of the
earlier ngrok failure or prove ongoing availability.

The restore boundary follows MySQL's documented distinction between startup
[DISABLED and runtime OFF](https://dev.mysql.com/doc/refman/8.4/en/events-configuration.html).
The native import uses [binary mode](https://dev.mysql.com/doc/refman/8.4/en/mysql-command-options.html)
to disable local client commands while preserving binary and line-ending data.

## Newly observed storage risk

A read-only production metadata query found `aptlss_manager_runs` occupying
12,364,300,288 data bytes (InnoDB allocated size; not exact logical JSON size).
The five most recent snapshots each contain 2,508,336 bytes and were recorded
about six minutes apart. This is evidence of a storage-growth risk, not proof
that all snapshots are identical or that source context can be discarded.

A second read-only inspection at 2026-09-30 22:47:49 UTC measured the latest
operational run (5891, worker 2), without printing its personal source content:

| Snapshot field | Bytes | Entries |
| --- | ---: | ---: |
| Assessments | 751,497 | 98 |
| Proposed plan | 636,480 | - |
| Interventions | 400,610 | 98 |
| Actions | 318,765 | 459 |
| Evidence | 266,453 | 106 |
| Changes | 114,001 | 450 |
| Cards | 19,281 | 98 |

The whole snapshot is 2,508,336 bytes. Evidence accounts for approximately 10.6%
of this one record, so evidence-only deduplication cannot resolve most of its
storage cost. Investigate lossless reuse/compression of the full immutable
assessment, including repeated proposal/action context, while preserving generated
review-index fields, worker isolation, historical reconstruction and rollback
compatibility. This single-record measurement is not a whole-history redundancy
analysis or proof that every recorded payload can be shared.

Before production acceptance, investigate content-addressed context reuse or
another additive, lossless representation so each assessment does not repeat
large source payloads unnecessarily. Preserve existing history and the ability
to reconstruct an assessment. Do not delete old runs or simply shorten evidence
to make backups smaller. Validate backup and restore duration on the actual
database size, not on the small fixture database.

Streaming preservation fingerprints address a verification-memory failure mode,
not the database's storage growth. They do not replace a logical SQL backup,
prove restoration, or justify deleting retained assessment context.

## Current-sized backup and restore follow-up

The native backup of the actual operational database completed successfully:
14,441,189,811 bytes, SHA-256
`704bd569e39d4ab2cc81ff9c6a5239e04964e301830735a18f15d78c80b81325`,
elapsed 1,417,893 ms (about 23 minutes 38 seconds). The manifest captured 133
InnoDB tables, 53 migration identities and the observed existing application
image `sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`.
The source table/engine and ledger inventories matched before and after; this
is not proof that no untracked DDL occurred. The SQL and credentials remain
private under `.local/pilot`, outside source and release scan artifacts.

Restore now refuses insufficient initial capacity and monitors its 12 GiB disk
reserve while its native client is live, including after SQL input has ended.
Failure stops and awaits that client only; no partial database is silently
removed or accepted. Resource diagnostics are not echoed into import errors.

| Current check | Result | Scope |
| --- | --- | --- |
| Native producer/importer and resource-guard tests | 109 passed, no failures or skips | Host Vitest 2.1.9; 102 backup/ledger/guard cases and seven actual native MySQL fixture cases, including a real dump/import round trip with binary/Unicode and a 16 MiB statement. `artifacts/production-restore-resource-guard-native-20261001.json`. Not the full operational restore. |
| Locked verification-tool tests | 118 passed, no failures or skips | Frozen Vitest 4.1.11; 102 backup/ledger/guard cases plus 16 fingerprint cases. `artifacts/production-restore-resource-guard-locked-20261001.json`. Counts overlap the host report. |
| Host timing projection tests | 26 passed, no failures or skips | Preserves valid estimate ordering, accepts MySQL-decoded JSON or strings, rejects malformed forecasts, and retains only timing fields. `artifacts/production-timing-projection-host-20261001.json`. |
| Locked timing and manager regressions | 81 passed, no failures or skips | Timing projections, manager engine and shadow execution under frozen dependencies. `artifacts/production-timing-projection-locked-20261001.json`. |
| Expanded SQL gate after timing projection and queue barrier | 154 passed, no failures or skips | All seven required suites, frozen dependencies, dedicated MySQL database. Strict report verifier and command exited zero. `artifacts/production-mysql-timing-projection-passed-20261001.json`. |
| Current locked type check | Passed | Includes the timing projection and revised queue integration assertion; completed with exit zero. |

The first host guard command used the wrong environment variable for the native
fixture URL. Its report retained 102 passing unit cases, seven unexecuted native
cases and a failed initialization. It is not accepted integration evidence:
`artifacts/production-restore-resource-guard-host-20261001.json`.
The correctly configured native rerun passed all 109 cases; no operational
data was changed by either test command.

The full 14.44 GB restore completed on a new, owned native MySQL instance at
loopback port 33317, with the scheduler startup-DISABLED, binary logging and
local file loading disabled, and a 128 MiB buffer pool. Its separate data
directory preserves the historical September 5 rehearsal. The restore command
exited zero, verified the same source hash and byte count, and reconfirmed the
startup-DISABLED scheduler after import. Elapsed time was 1,684,982 ms (about
28 minutes 5 seconds), including input validation. The restored database contains
133 InnoDB table files. Its private proof is
`.local/pilot/current-restore-20261001.json`.

The migration command exited zero. All 132 original data-table fingerprints
subsequently matched their pre-migration checkpoint, covering 94,674 records
(including 5,901 manager runs), with every originally selected column still
present. Checkpoint: `.local/pilot/rehearsal-current-20261001-before.json`;
private preservation proof:
`.local/pilot/rehearsal-current-20261001-before-preservation-2026-10-01T01-03-00.258Z.json`.
The ledger is excluded from that record checkpoint and has separate lineage
assertions. Current full-size schema/rerun assertions are still being checked.
A successful database restore alone does not establish a complete application
rollback or authenticated runtime.

Time calibration now selects only the previous runs' action arrays in SQL,
not 100 complete source dossiers. Worker filtering, latest-100 ordering and
pre-start prediction matching remain in place. Parsing retains only card,
step and estimate fields and rejects malformed forecasts. Stored full snapshots
are not rewritten or deleted. This reduces calibration transport/memory cost;
it does not solve the separately documented full-history storage-growth risk.

The first expanded SQL gate after this change passed 153 assertions and failed
one existing dispatcher-concurrency assertion. Both new SQL timing assertions
passed, including latest-100 worker isolation with a large retained dossier and
an actual completed-work calibration against its pre-start forecast. The queue
test used a 60 ms task sleep and observed no overlap under SQL latency. Its
retry now holds both executions at an explicit barrier and requires two active
lanes before release; it does not lengthen the simulated task's timed sleep or
change the production runner. Retain the failed report:
`artifacts/production-mysql-timing-projection-first-20261001.json`.
The complete retry passed all 154 assertions with no skipped suites and a normal
zero command exit. The first failed report remains available. Production queue
logic was not changed to accommodate a test.

At 2026-10-01 00:24:53/54 UTC, the existing local and public readiness endpoints
both returned HTTP 200. The backup's observed rollback image is still available
locally. Neither observation proves that the new candidate is deployed or that
the intermittent availability incident's cause has been resolved.

## Source-identity follow-up

The complete locked-dependency unit command exited one with 2,537 passing
assertions, one failure and 168 explicitly skipped integration/native assertions.
The failed executable-module identity check exposed an unsafe metadata cache:
same-size writes can retain the same modification/change timestamps on a coarse
filesystem. A timestamp match does not establish that source bytes are unchanged.
Retain the original report `artifacts/production-full-unit-timing-20261001.json`.

Source identity now hashes the actual normalized file bytes on every check rather
than accepting cached hashes based on size and timestamps. Production artifact
and collector verification remain unchanged. All ten focused identity checks
passed under frozen dependencies, including a same-size rewrite with its original
modification time restored: `artifacts/production-source-identity-20261001.json`.
The complete retry command subsequently exited zero with 2,539 passing assertions,
zero failures and 168 explicitly skipped integration/native assertions:
`artifacts/production-full-unit-source-identity-20261001.json`. The locked
TypeScript check also exited zero. Skipped assertions are not passing tests;
retain the separate SQL and native proof. The initial failed report is retained.

The updated production candidate built successfully and all eight isolated image
checks exited zero: `va-dashboard:production-runtime-candidate-timing-20261001`,
inspected image ID
`sha256:5cd37fa014a78ae479ad7218ede69f4cc28f08468f3f9f9fd1541a363faab404`.
Report: `artifacts/production-image-source-identity-20261001.json`. It contains the
timing projection and source-identity fix. It is not deployed; these checks do not
replace configured, authenticated runtime or live integration acceptance.
The normalized working-tree source digest independently matched the seal in
this candidate: `94391ba2e4783f5a35460a0c9df16f847b075e64ece3585573267047b06d23ef`.

The complete seven-suite MySQL gate was rerun after the source-identity fix and
passed all 154 assertions without skips, with a normal zero command exit:
`artifacts/production-mysql-source-identity-20261001.json`. This report replaces
neither the native migration rehearsal nor the browser acceptance matrix.

The redacted release-tree Gitleaks command exited zero with no findings after the
identity fix. Inventory: 1,025 non-ignored source files, 18,181,285 staged bytes;
Gitleaks inspected approximately 17.86 MB. The pinned image and existing six exact
fixture fingerprints were unchanged. Report:
`artifacts/release-secret-scan-source-identity-20261001/gitleaks-report.json`.
Environment files, private databases and backups, generated artifacts and Git
history are outside this scan. Exposed provider credential rotation remains open.

At 2026-10-01 00:31:42 UTC, anonymous `auth.me` requests to the existing local and
public deployment both returned HTTP 200 with a null authenticated user. A
read-only configuration inspection showed production mode, login bypass disabled
and APTLSS shadow-only enabled. These observations do not prove independently
authenticated founder/admin/worker access on the new candidate.

## Redis connection-pair follow-up

An added regression suite reproduced three false availability states in the
existing Redis service: the subscriber rejects, remains connecting after the
startup timeout, or disconnects after startup while the publisher stays ready.
The initial report contains five passing and three failing assertions:
`artifacts/production-redis-pair-before-20261001.json`. It is retained.

Redis availability now requires both publisher and subscriber readiness. The
startup success log uses the same condition. The existing WebSocket initialization
therefore does not attach its Redis adapter to a missing subscriber, and configured
health/readiness checks no longer treat an incomplete pair as healthy. Primary
cache access and the existing single-instance fallback remain unchanged.

All 19 focused Redis, WebSocket and health tests passed with frozen dependencies:
`artifacts/production-redis-pair-20261001.json`. The new Redis cases use controlled
clients, not a live provider. The full ordinary retry exited zero: 2,547 passed,
zero failed, 168 explicitly skipped integration/native assertions.
Report: `artifacts/production-full-unit-redis-pair-20261001.json`. The locked
TypeScript check also exited zero. The previously
verified timing candidate predates this change and must be rebuilt; its passing
image report must not be presented as verification of the new Redis behavior.

The rebuilt Redis-pair candidate passed all eight isolated image checks with a
normal zero command exit: `va-dashboard:production-runtime-candidate-redis-pair-20261001`,
image ID `sha256:c63bf8c10d5a33bf5e14905d5420c0ae0e4d28afd085c8d405eb595dd66e43f8`.
Report: `artifacts/production-image-redis-pair-20261001.json`. This candidate is
not deployed and still requires configured, authenticated runtime acceptance.

The normalized working-tree source digest matched this rebuilt candidate's seal:
`a0b0300835a68bfb85d7cb65903f36caaa99158faa19da9e09613126fc729239`.
The full seven-suite SQL gate also passed again after the Redis fix: 154 assertions,
zero failures or skips, normal zero exit.
Report: `artifacts/production-mysql-redis-pair-20261001.json`.

The updated redacted source scan exited zero with no findings across 1,026 staged
source files (18,191,224 staged bytes; Gitleaks inspected approximately 17.87 MB).
Report: `artifacts/release-secret-scan-redis-pair-20261001/gitleaks-report.json`.
The same six exact fixture fingerprints remain unchanged. This is not a scan of
Git history, private environment files or backups, and is not credential-rotation
or deployment evidence.

## References

- [Deployment and cutover requirements](PRODUCTION_CUTOVER.md)
- [Capability preservation ledger](CONSOLIDATION_LEDGER.md)
- [Existing APTLSS improvement and acceptance work](APTLSS_25_IMPROVEMENTS.md)
- [MySQL2 streaming implementation](https://github.com/sidorares/node-mysql2/blob/master/lib/results_stream.js)
- [ngrok error 3004](https://ngrok.com/docs/errors/err_ngrok_3004)
- [Axios advisory](https://github.com/advisories/GHSA-c29m-xwm3-cm6r)
- [DOMPurify advisory](https://github.com/advisories/GHSA-p98j-92pf-mc4p)
- [Engine.IO advisory](https://github.com/advisories/GHSA-2gc4-cqfq-p2gv)

## October 1: current parser, download and browser-dependency checks

Health and database-initialization failure logs now retain a fixed diagnostic
label instead of serializing an error that may contain a private connection
address. Pool cleanup and the original error propagation remain covered.
The initial failing reports are retained: two failures in
`artifacts/production-health-log-before-20261001.json` and three in
`artifacts/production-db-log-before-20261001.json`.

The attachment extractor now uses the actually installed PDFParse v2 API,
awaits parser cleanup, and does not introduce generated page-footer text into
the extracted content. A rejected asynchronous download is now awaited inside
the error boundary; both DNS-resolution and download errors produce a controlled
unavailable result without logging the private address or token. The initial
parser run failed all three cases; the initial download run passed four and
failed the two new error-boundary cases. Both reports are retained. The current
locked-dependency focused report passes all 26 assertions across the parser,
download, database lifecycle, health logging and generated-record verifier:
`artifacts/production-final-focused-20261001.json`.

The first complete locked browser run recorded 85 passed, one failed and one
not executed: `artifacts/production-locked-browser-gnu-20261001.json`.
The retained trace established a failed DNS request for a decorative remote
timeline image after the admin-review assertions. That dependency was replaced
by a local decorative background; timeline data, controls and scheduling were
not removed. Live browser tests now also reject unexpected external resource
requests. The subsequent complete locked browser run passed all 87 cases with
zero skipped, unexpected or flaky results and zero top-level errors, with a
normal zero command exit:
`artifacts/production-locked-browser-local-assets-20261001.json`. This matrix
contains 11 real-backend/test-MySQL lifecycle cases and 76 intercepted-API UI
contract cases; it is not 87 live-provider tests. Playwright 1.60.0, frozen
dependencies and the GNU-compatible runtime were used. The earlier failed
report remains available and is not acceptance evidence.

The first full PDF/logging unit run passed 2,553, failed two and explicitly
skipped 168 database/native assertions. The two failure durations exceeded
five seconds; a focused rerun passed all 15 assertions without changing their
deadlines. The next complete run passed 2,568 with no failures and the same 168
explicit skips, but preceded the two new asynchronous-download tests:
`artifacts/production-full-unit-local-assets-20261001.json`. The final full run on
the download-safety source subsequently passed 2,570 assertions with zero
failures and 168 explicit database/native skips, with a normal zero command
exit and matching JSON totals:
`artifacts/production-full-unit-download-safety-20261001.json`. Separate SQL
and native evidence is still required for those skipped cases.

The subsequent strict seven-suite MySQL gate passed all 154 assertions with
zero failures or skips, verified matching totals, and exited normally with zero:
`artifacts/production-mysql-download-safety-20261001.json`. It ran only after
the browser fixture finished and cleaned up, against the dedicated test database.
This remains separate from current-size native restoration and real-provider
acceptance. The final locked TypeScript check also completed with exit zero.

A read-only check at 02:03 UTC confirmed that the unchanged existing application
was still running its previous image, with health and readiness returning 200,
anonymous `auth.me` returning null, production authentication bypass disabled
and the deployment restricted to shadow mode. No new image was deployed or
production database migrated in this verification round.

The download-safety candidate image built successfully and passed all eight
isolated image checks. Its independently computed normalized source digest
matches the image seal. Evidence:
`artifacts/production-image-download-safety-20261001.json`. This is not a
deployed image or configured authenticated-runtime acceptance. A fresh redacted
secret scan started only after all 1,030 source files had finished staging,
exited zero and reported no findings:
`artifacts/production-secret-scan-download-safety-20261001.json`. It excludes
private operational backups and environment files deliberately; it does not
prove that historical exposed provider credentials have been rotated.

The first current-size native schema check exceeded its 15-minute SQL deadline
and correctly stopped further database work; its two passed and five failed
assertions remain recorded in
`artifacts/production-current-restore-migrations-bounded-20261001.json`.
Generated-column verification now checks every row in bounded keyset batches,
using canonical covering-index values and one canonical expression evaluation
per row. Thirteen focused regressions cover complete coverage, mismatch,
cursor/count anomalies, unsafe identifiers and query-failure rollback. It does
not sample or delete history. The final full-size rehearsal passed all seven
assertions with zero failures or skips and a normal zero command exit:
`artifacts/production-current-restore-migrations-indexed-20261001.json`.
The restored schema and complete generated-value check took approximately
7 minutes 43 seconds; the idempotent rerun with before/after whole-table
schema, record and ledger fingerprints took approximately 15 minutes 39 seconds.
The fresh canonical lineage, fresh rerun and direct 0045 replay also passed.
This completes the current-size migration regression gate on the preserved
14,441,189,811-byte operational restore. It does not establish application
rollback duration, live integrations or APTLSS active-mode acceptance.

### Current candidate gates and remaining acceptance

| Gate on current download-safety source | Verified result |
| --- | --- |
| Frozen ordinary test suite | 2,570 passed; 168 explicit database/native skips |
| Separate strict MySQL gate | Seven suites, 154 passed, no skips |
| Native current-size migration rehearsal | Seven passed, no skips; complete generated checks and rerun fingerprints |
| Locked browser matrix | 87 passed, no skipped/flaky/unexpected results; 11 real-backend cases, 76 UI contract cases |
| Frozen TypeScript check and production build | Both exited zero |
| Current candidate image | Eight isolated checks passed; independent source digest matches seal |
| Redacted current-source secret scan | No findings; private operational files excluded intentionally |

The separate gate counts overlap some ordinary skipped categories and focused
regressions; do not add them together to claim one comprehensive live suite.
Configured production-candidate role/Redis/WebSocket acceptance, live-provider
verification and credential rotation, bounded ongoing history growth, full
application rollback, remote CI and authorized public cutover remain open.
APTLSS stays in shadow mode pending the practice-review acceptance gate.

## October 1: configured production, sustained Redis outage and restart

The download-safety image was first exercised with actual production settings
on the separately owned internal `va-production-acceptance-20261001` network.
The app, fresh MySQL and password-protected Redis had no published ports. Only
five synthetic accounts were seeded into its fresh `recovery_test` database;
all maintenance settings and relevant external-job flags were disabled. No
real provider credentials or operational data were used. The browser fixture
provided ephemeral self-signed HTTPS and a reverse proxy with a trusted hop.

An initial verifier attempt ran before startup readiness and produced upstream
502 failures. It is retained at
`.local/production-runtime-first-20261001/results.json` and is not acceptance.
The verifier now awaits bounded readiness, forwards rejected WebSocket upgrade
responses, waits for the full password-login response and closes its owned
upgraded sockets explicitly. Both subsequent 21-check runs exited normally
with zero; the final report is
`artifacts/production-runtime-final-20261001/results.json`.

These checks cover real production password sessions and Secure/HttpOnly/Lax
cookies, anonymous/wrong-role denial, own-worker identity, founder workspace
isolation, CSRF rejection, anonymous and untrusted-origin WebSocket rejection,
authenticated realtime and no cross-worker room leakage. Compiled HTTPS
browser flows cover worker desktop/mobile, founder and admin, with screenshots,
no unhandled browser exception, no unexpected external HTTP resource and no
horizontal document overflow. The mobile screenshot was also inspected.
The founder account uses the canonical `admin` role; this proves separate
workspace ownership, not independent founder/admin permissions.

The same original image recovered from a short Redis interruption, but failed
to recover after an observed 45-second outage: restarting Redis left readiness
at 503 and its connections disconnected. Its retry strategy stopped after
three attempts. The observed before evidence is
`artifacts/production-runtime-redis-recovery-before-20261001.json`.
The new regression first passed nine and failed one assertion:
`artifacts/production-redis-recovery-before-20261001.json`.

Redis reconnect attempts now continue with delays capped at two seconds.
Per-command retries remain finite and the offline queue remains disabled;
application work is not queued indefinitely during an outage. Readiness still
requires both publisher and subscriber. The focused service/health run passed
all 12 assertions with a normal zero exit:
`artifacts/production-redis-recovery-focused-20261001.json`.

The final frozen ordinary suite passed 2,572 assertions, zero failed, with 168
explicit database/native skips and a normal zero exit:
`artifacts/production-full-unit-redis-recovery-20261001.json`.
The frozen TypeScript check exited zero. The first subsequent strict SQL run
used `recovery_test` in a fixture which only has `aptlss_test`; access was denied,
with zero passed, one failed and 153 skipped. That report is retained as
`artifacts/production-mysql-redis-recovery-first-20261001.json` and is not a
passing gate. After verifying the fixture inventory and selecting its actual
`aptlss_test`, all seven strict suites passed all 154 assertions, with zero
failed/skipped, matching verified totals and a normal zero exit:
`artifacts/production-mysql-redis-recovery-20261001.json`.

### Current recovery candidate identity

- Tag: `va-dashboard:production-runtime-candidate-redis-recovery-20261001`.
- Inspected image ID:
  `sha256:9df1862541080ce3f28df9f754ff82565bbbe26c1ff465fd3d9aeb883ef8ee88`.
- Normalized source digest, independently identical in the host checkout,
  frozen test fixture and image seal:
  `e33d9c8be11089e05d2112ef085950106566c06b0f2c616698b96fe2d7127078`.
- Bundle hash:
  `f0cdae2ec37308da8002a70b699e252c1b8c102490bf847c7c749572b00e0bce`.
- Collector hash remains
  `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.

The new image built with frozen dependencies and passed all eight isolated
image assertions with normal zero exits. An initial attempt incorrectly used
the build log's configuration digest as a runnable image ID and was rejected;
the inspected ID above is the one actually accepted and exercised.
Image evidence: `artifacts/production-image-redis-recovery-20261001.json`.

The configured new image passed the same 21 real production checks:
`artifacts/production-runtime-redis-recovery-20261001/results.json`.
A repeated 45-second Redis outage returned readiness 503 while disconnected,
then healthy 200 in the first recovery poll 1,758 ms after the Redis start
command returned, without restarting the application:
`artifacts/production-runtime-redis-recovery-after-20261001.json`.
Its controlled application stop completed in 1,093 ms, with exit zero and no
OOM kill. The same container restarted without changing its test database or
credentials. All 22 configured checks then passed, including the pre-restart
signed worker cookie, observed unavailability and lower process uptime:
`artifacts/production-runtime-restart-20261001/results.json`.
That command also completed normally with exit zero. Container evidence:
`artifacts/production-runtime-graceful-restart-20261001.json`.

The final pinned, network-isolated, redacted source scan covers 1,032 staged
source/document files, with the same six exact fixture exclusions. It exits
zero with no findings:
`artifacts/production-secret-scan-redis-recovery-20261001.json`.
It intentionally excludes private environment files, operational backups,
artifacts and Git history, and does not prove provider credential rotation.

The prior 87-case locked browser matrix and seven current-size native migration
assertions remain separate preserved evidence for unchanged frontend/migration
behavior; neither was rerun as a full matrix in this Redis-only change.
The 21/22 configured runs overlap each other and some ordinary checks. Do not
sum them into one comprehensive live-provider test count. The synthetic restart
and outage timings are not full-data application rollback or public recovery SLAs.

At 02:36 UTC, a read-only check confirmed the unchanged existing production
image `sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`
was still running, with health/readiness 200 and anonymous `auth.me` null.
No production cutover, migration, provider rotation, commit, push or merge
occurred in this round. Follow
[the configured rehearsal guide](PRODUCTION_RUNTIME_REHEARSAL.md) for the
ownership, isolation and report requirements.

Still open: live integrations and credential rotation, startup dependency-loss
acceptance, scheduled-job acceptance, bounded ongoing history growth, full-data
application rollback, remote CI and authorized public cutover. Distinct founder
privileges, if required, must be an explicit authorization-model change rather
than assumed from these role-page tests. APTLSS stays shadow-only pending real
practice-review acceptance; these fixture checks do not satisfy that gate.

## October 1: cold Redis startup, stable socket rooms and offline shutdown

This follow-up supersedes the Redis startup behavior and candidate identity
in the previous section. It does not supersede unrelated migration/browser
evidence or authorize a production cutover.

### Findings and repairs

Starting the previous `9df186...` candidate with Redis absent and then restoring
Redis left health/readiness at 503. The initial connection rejection nulled the
module's client references even though the orphaned clients kept reconnecting.
Observed before report:
`artifacts/production-runtime-cold-start-before-20261001.json`.

The client references are now retained through initial connection failure.
Initialization remains bounded, readiness requires both clients, and shutdown
disconnects non-ready clients rather than queuing a quit command. Ready-client
quit has a two-second deadline and always stops further reconnect attempts.
The initial regression report passed nine and failed seven assertions:
`artifacts/production-redis-cold-before-20261001.json`.
An intermediate attempt to install the Redis adapter after readiness lost
existing socket rooms (25 passed, one failed):
`artifacts/production-redis-cold-focused-first-20261001.json`.

The final implementation installs a single stable adapter before sockets join.
Only its dedicated subscriber retains the fixed internal subscriptions until
Redis returns. Cache commands and application publications have no offline
queue. Room ownership and session authorization are unchanged.

The first actual cross-process attempt failed because the independent publisher
had not recovered when the first process became healthy. The failing 24/25
report is retained at
`artifacts/production-runtime-redis-cold-first-20261001/results.json`.
The old publisher also logged an unhandled rejection: the Redis adapter does
not await a publication's promise. New regressions passed three and failed two
before the repair:
`artifacts/production-websocket-publish-before-20261001.json`.
The adapter-specific publisher now skips unavailable Redis and catches a
disconnect race, preserving local delivery without queuing application events
or logging the provider error's sensitive details. Ordinary Redis callers
retain their normal error behavior. The verifier independently waits for both
processes before asserting cross-process delivery.

### Verified current candidate

- Tag: `va-dashboard:production-runtime-candidate-redis-cold-verified-20261001`.
- Independently inspected image ID:
  `sha256:5785b193f246e355cda7e092ed5e516e914410510ab72f51cf23732ac08c1e57`.
- Normalized source digest, identical in the host checkout, frozen test fixture
  and image seal:
  `681b9db6a5e1f4acfc06ae56b60907aa4238ad9d3ae010dce9b842ae1038127a`.
- Bundle hash:
  `8a3c4b817213d73d06c0138ccca02b3c3c1d61b7182437dc935583d612133257`.
- Collector hash unchanged:
  `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.

The production image built with frozen dependencies and passed all eight
isolated image checks with normal zero exits. The frozen TypeScript check
also exited zero. The final focused Redis/socket run passed 28 assertions,
zero failed/skipped, normal zero exit:
`artifacts/production-redis-cold-focused-20261001.json`.
The complete frozen ordinary suite passed 2,580 assertions, zero failed,
with 168 explicitly skipped SQL/native cases, normal zero exit:
`artifacts/production-full-unit-redis-cold-final-20261001.json`.
The separate strict SQL gate passed all 154 assertions in seven suites,
zero failed/skipped and normal zero exit:
`artifacts/production-mysql-redis-cold-20261001.json`.
Do not sum focused and ordinary totals: they overlap.

All 27 configured cold-start checks passed with a normal zero exit:
`artifacts/production-runtime-redis-cold-final-20261001/results.json`.
They observed liveness 200/readiness 503 with Redis missing, authenticated
worker sockets and scoped local delivery during the outage, recovery without
app restart or socket replacement, and a real Redis-backed event from the
separate publisher to the pre-recovery receiver. It arrived exactly once and
did not reach the other worker, despite a spoofed worker ID in the payload.
The 5,093 ms checkpoint-to-readiness observation includes host orchestration;
it is not a Redis recovery SLA. Uptime increased from 6.99 to 12.77 seconds.

A separate run observed readiness 503 with Redis stopped, then stopped the
candidate in 4,985 ms with exit zero, no OOM kill and no forced termination.
The same container restarted with the existing database and credentials.
All 22 configured checks passed, normal zero exit, including the previously
signed worker cookie:
`artifacts/production-runtime-redis-offline-restart-20261001/results.json`.
Measured container state:
`artifacts/production-runtime-redis-offline-shutdown-20261001.json`.
The candidate's inspected logs contained no unhandled rejection during these
fixture tests. The worker mobile screenshot was inspected; missing source data
produces a clear hold state, not a fabricated queue or AI diagnostic dump.

A pinned, network-isolated, redacted secret scan of 1,033 staged source/document
files exited zero with no findings and the same six exact fixture exclusions:
`artifacts/production-secret-scan-redis-cold-20261001.json`.
Private environment files, database snapshots, artifacts and Git history were
not part of that scan. The final evidence-document update is scanned separately.

At 02:59 UTC the existing production image remained
`sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`,
running with health/readiness 200. No production migration, cutover, provider
rotation, commit, push or merge occurred. The earlier 87-case locked browser
matrix and seven current-size native migration assertions remain preserved
separate evidence for unchanged areas, not fresh full-matrix proof of this image.

Still open: actual provider credential rotation/verification, database-loss
startup acceptance, scheduled-job acceptance and cross-instance job locking,
bounded ongoing history growth, full-data application rollback, remote CI and
authorized public cutover. APTLSS remains shadow-only until the real five-workday,
100-reviewed-proposal acceptance gate is satisfied. Synthetic fixture tests do
not substitute for that pilot or for an operational worker's real integrations.

## October 1: database recovery and truthful session failures

The retained before report is
`artifacts/production-runtime-mysql-outage-before-20261001/results.json`.
It reproduced three failures: valid-session auth.me returned 200/null during
database loss, password login returned 500, and a protected write returned 401.

The canonical Express optional-auth middleware now distinguishes known session
rejection from failed verification. Operational failures return sanitized 503,
Retry-After: 5 and no-store; tRPC produces SERVICE_UNAVAILABLE for single/batch
calls. No session cookie is issued or cleared during failure. Null configured
user lookups/upserts fail closed. Auth-route catches recognize wrapped driver
codes without publishing queries, connection data or credentials.

The VA sees a short recovery message and Try again on failed first loads, not
a misleading login/reset request. An existing worker page retains its cached
identity and mounted content during failed rechecks. Only the read-only session
probe repeats: every minute while authenticated, every five seconds after
failure, with no interval for a confirmed anonymous session. Submitted actions
are never retried automatically. This is not durable draft persistence across
browser reloads or crashes.

### Current candidate

- Tag: `va-dashboard:production-runtime-candidate-mysql-recovery-final-20261001`.
- Independently inspected image ID:
  `sha256:eaabf224b20e0b06e28737f6a9e937bd08279377d424fe3f6dfc9c8f004c0921`.
- Matching host, frozen checkout and image source digest:
  `58ee5f918ef3d1f9c7c20f2d34390fb718de23b0ea2dea6db50f72163282c510`.
- Bundle hash: `a61f28c9a607f1979f14c831acc75e5506269b554e6f915435eadc3cd6059806`.
- Collector hash unchanged:
  `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.

Frozen TypeScript checking, immutable build and all eight isolated image checks
exited zero. Ordinary tests passed 2,602 assertions, zero failed, with 168 explicit
SQL/native skips; the separate strict SQL gate passed all 154 assertions in seven
suites, no skips. Both terminated normally with zero:
`artifacts/production-full-unit-mysql-recovery-20261001.json` and
`artifacts/production-mysql-recovery-20261001.json`.
Focused tests overlap these totals and must not be added.

### Compiled-image fault injection

- Running-app MySQL outage: 12/12, normal exit zero,
  `artifacts/production-runtime-mysql-outage-after-20261001/results.json`.
  The original session remained valid; writes failed closed; the page stayed
  mounted. Desktop/mobile first loads showed recovery, and the original cookie
  returned the worker automatically. Uptime rose 35.04 -> 44.17 -> 121.53 seconds;
  database recovery required no app restart.
- App started with MySQL offline: 9/9, normal exit zero,
  `artifacts/production-runtime-mysql-cold-after-20261001/results.json`.
  Liveness remained available/readiness failed, then returning MySQL recovered
  that same new process and a cookie previously obtained through real password
  login. Uptime increased 17.27 -> 38.49 seconds during recovery.
- All 133 synthetic tables, 72 records, five accounts and 53 migration entries
  retained fingerprint `b3a6880131473c30042fa99890574374eb60f7968c33bd20f9bbe75208f41f91`.
  Only users.lastSignedIn and users.updatedAt are excluded for expected login
  updates. All other rows/columns are fingerprinted.

The owned TLS/Chromium fixture used no real providers or host-exposed ports.
The current image also passed all 21 configured auth, CSRF, worker-isolation,
WebSocket and four-view browser checks with normal exit zero:
`artifacts/production-runtime-mysql-healthy-20261001/results.json`.
The founder fixture uses the canonical admin role with owned worker profiles;
this is not proof of a separate founder role or actual provider-connected work.
These timings are not a recovery SLA, provider acceptance, a full outage matrix
or full-data application rollback. The unchanged production image was inspected
running/healthy: `sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`.
No production migration, cutover, credential rotation, commit, push or merge
occurred. Still required: provider rotation/acceptance, scheduled-job acceptance
and cross-instance locking, bounded history growth, full-data application rollback,
remote CI and authorized cutover. APTLSS remains shadow-only pending the real
five-workday/100-reviewed-proposal acceptance gate.

A pinned, network-isolated, redacted secret scan of 1,038 staged source/document
files exited normally with zero findings, retaining the six exact existing
fixture exclusions: `artifacts/production-secret-scan-mysql-recovery-20261001.json`.
Private environments, snapshots, artifacts and Git history were excluded. The
final evidence-document addition is rescanned separately; no provider credential
rotation is implied by a clean repository scan.

## October 1: shared scheduled-job ownership

The corrected-fixture baseline reproduced five actual failures in the shared
runtime: stale completion preflight permitted duplicate work, a fast application
clock could steal a live lease, expired and replaced owners could record success,
and run-record failure retained the acquired lease. Retained evidence:
`artifacts/production-scheduled-jobs-baseline-20261001.json` (5 passed, 5 failed,
normal exit 1). The earlier `before` report included invalid timestamp fixtures
and is not the authoritative reproduction.

The existing job tables, daily keys, canonical server and separate durable
manager/reminder queues remain intact. Acquisition/renewal now use database time;
success is rechecked after acquiring ownership. Transactions lock that ownership
through run creation and completion. Interrupted attempts remain abandoned in
history. Failed starts release only their own lease; renewal loss signals
cancellation. Morning/EOD emails check ownership immediately before their provider
call. No migration, table replacement or provider permission expansion was needed.

Current candidate:
- Tag: `va-dashboard:production-runtime-candidate-scheduled-jobs-20261001`.
- Independently inspected image ID:
  `sha256:767658f4f0d2b5d12de6d3ac2718f4cc651300fa2a0198e829ee992858101ada`.
- Matching host, frozen checkout and compiled-image source digest:
  `8fcddb8c4fca1d74a2847824a0177524812845522a2cca4767009089bae52815`.
- Bundle hash: `5a580bb1de1e2119067f21c7f47d11f4285716f7bd2cd5717618ad0b10c399d9`.
- Collector hash unchanged: `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.

Frozen TypeScript and build exited zero. All eight image checks passed. The final
ordinary suite passed 2,605 assertions, zero failed, with 184 explicit SQL/native
skips: `artifacts/production-full-unit-scheduled-jobs-final-20261001.json`.
The separate mandatory MySQL gate passed all 170 assertions in eight suites,
no skips: `artifacts/production-mysql-scheduled-jobs-20261001.json`.
Both terminated normally with zero. The focused 34 assertions overlap these
totals and must not be added: `artifacts/production-scheduled-jobs-focused-final-20261001.json`.
The new 16 MySQL cases exercise live/expired/stolen ownership, database clock,
renewal, start failure, retries, stale preflight, independent Node processes,
process termination and restart. Three unit cases check email ownership boundaries.

The compiled candidate passed all 21 configured auth/CSRF, worker-isolation,
WebSocket and four-view browser checks with a normal zero exit:
`artifacts/production-runtime-scheduled-jobs-20261001/results.json`.
The mobile screenshot was inspected. Its founder fixture is the canonical admin
role with an owned workspace, not evidence of a distinct founder role. Production
login bypass is false and automatic manager execution remains shadow-only.

These are isolated synthetic checks, not live scheduler/provider acceptance or
an exactly-once guarantee. Providers can accept a request immediately before a
process fails to persist its outcome. Existing long maintenance/generation
callbacks still need per-operation ownership checks and ambiguous-outcome
reconciliation; cancellation cannot reverse completed external actions.
See `docs/PRODUCTION_RUNTIME_REHEARSAL.md` for the exact fixture boundary.
The earlier MySQL/Redis outage and full-size restore reports remain separate
historical proof, not a freshly repeated complete fault matrix for this image.

A pinned network-isolated redacted scan of 1,041 staged source/document files
exited zero with no findings, retaining only the six existing exact fixture
exclusions: `artifacts/production-secret-scan-scheduled-jobs-20261001.json`.
Final documentation additions are rescanned separately. Private environments,
snapshots, artifacts and Git history are excluded; this is not key rotation.
The unchanged production image remained running/healthy, readiness 200:
`sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`.
No production migration, cutover, provider write, rotation, commit, push or merge
occurred. Still open: live provider/scheduler acceptance, remaining operation-level
fencing, bounded history growth, full-data application rollback, remote CI,
authorized cutover, and the actual five-workday/100-reviewed-proposal shadow trial.

## October 1: operation-level ownership fences

This follow-up preserves the canonical application, existing job tables and
migration lineage. No migration was needed. It fixes seven operational paths:

- Periodic maintenance checks due/enabled state under the owned lease. Its
  schedule claim and run-history insertion share one transaction; contenders
  cannot postpone work, and a failed run insertion rolls back the schedule claim.
  A job that is no longer due is skipped, not recorded as a successful no-op.
- Transactional ownership checks use the active transaction connection and a
  current shared locking read. The lease is retained through commit. This avoids
  deadlock when only one pool connection is available. Source commitments and
  Gmail/Drive ingestion pass that connection through their checkpoints.
- Maintenance, Google ingestion, Trello reply/commitment collectors and scheduled
  checklist generation propagate cancellation to subsequent operations. Combined
  generation contexts check the parent before the child. Provider request signals
  include ownership cancellation; detected lease loss is not an ordinary retry.
- Timer auto-stop uses the selected row as its compare-and-set condition,
  including binary string comparisons. Concurrent manual edits are not
  overwritten; foreign, voided, future or invalid timer entries remain unchanged.
- Missing or failed webhook inventory reads fail closed instead of masquerading
  as an empty board list. Failed local persistence stops further provider changes.
  The baseline reproduced five failures (19 passed, five failed, normal exit 1):
  `artifacts/production-webhook-inventory-before-20261001.json`.
- Cache-preload cleanup no longer creates an unhandled rejected promise. Its
  baseline had two passing assertions but normal exit 1; report success alone was
  insufficient. The repaired two-test run exited zero:
  `artifacts/production-cache-cleanup-before-20261001.json` and
  `artifacts/production-cache-cleanup-after-20261001.json`.
- Scheduled email ownership reaches the final SMTP/SendGrid send boundary and
  Gmail token/MIME preparation and HTTP dispatch. Lease-loss errors propagate.
  Manual delivery and existing policy gates remain unchanged. Tests use mocks,
  not real recipients. These fences cannot recall a request already accepted.

Verified candidate for this exact source snapshot:
- Tag: `va-dashboard:production-runtime-candidate-operation-fences-20261001`.
- Independently inspected image ID:
  `sha256:5f46a2df9d46ae21688901e47866398f6b679afd58d4ac30776c10c391ac9306`.
- Matching host, frozen checkout and compiled source digest:
  `359053e94dda1df86c76ebb830b2dceb954eb2d0591734e9a237a8bcb485f413`.
- Bundle hash: `cc232055275bc2627f69d14c870113d4ea15713000699708ed21e235a511f3ca`.
- Collector hash remains `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.

Frozen TypeScript and the production build exited zero. All eight image checks
passed with zero exit. The ordinary suite passed 2,786 assertions, zero failed,
with 190 explicit SQL/native skips across 290 files, normal exit zero:
`artifacts/production-operation-ownership-full-20261001.json`.
The 252 focused assertions overlap that suite and must not be added to it:
`artifacts/production-operation-ownership-focused-20261001.json` (zero skips,
normal exit zero). The 22 real-MySQL runtime tests also passed without skips:
`artifacts/production-transaction-ownership-20261001.json`. They include actual
one-connection operation, transactional schedule rollback, competing ownership,
independent processes, cancellation and restart; they overlap the strict gate.

The mandatory MySQL gate passed all 176 assertions in eight suites, zero skipped
and zero failed, with normal zero exit:
`artifacts/production-operation-ownership-mysql-20261001.json`.
Its guarded loopback test database is distinct from both production and the
configured-runtime rehearsal database. No production records were migrated.

The compiled image passed all 21 configured auth, CSRF, worker-isolation,
WebSocket and four-view browser checks, normal exit zero:
`artifacts/production-runtime-operation-fences-20261001/results.json`.
The 390px worker screenshot was inspected. Missing work-source coverage correctly
blocks timer start without exposing AI diagnostics. The founder fixture is an
admin-role account with an owned workspace, not proof of a distinct founder role.
The owned fixture's previous candidate is stopped and retained; its replacement
uses synthetic credentials, the same owned database/Redis, no published ports
and disabled automatic delivery. Production and the local preview are unchanged.

These checks do not establish live provider acceptance, exactly-once delivery or
full-data application rollback. Call-boundary checks alone cannot make all
multi-write helpers atomic; ambiguous accepted requests still need reconciliation
before retries. Old outage/restore reports are historical proof, not a newly
repeated complete fault matrix for this candidate. Still open: provider rotation
and live acceptance, bounded history growth, full-data application rollback,
remote CI, authorized cutover and the actual five-workday/100-reviewed-proposal
shadow trial. No production migration, live provider write, rotation, commit,
push or merge occurred in this follow-up.

A pinned, network-isolated redacted source/document scan exited zero with no
findings: `artifacts/production-secret-scan-operation-fences-20261001.json`.
The staged inventory contains 1,048 files and retains the six existing exact
fixture exclusions. Private environments, snapshots, artifacts and Git history
were excluded; this is not credential rotation or proof those private sources
contain no secrets. The production image remained unchanged and healthy, with
readiness HTTP 200:
`sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`.

## Lossless equivalent-history follow-up, 2026-10-01

Repeated equivalent shadow dossiers can now use immutable bounded checks,
referencing an unchanged full run. This is an additive storage change, not
deletion or rewriting of retained history. Full details and older-binary rollback
steps are in [assessment history storage](APTLSS_HISTORY_STORAGE.md).

Migration `0053_manager_history_checks` appends identity 54 and introduces one
table and two nullable state columns. The separate loopback test database and
synthetic configured-runtime database were migrated; production was not. The
previous full-size restored-database proof remains for identity 53. Migration
0053 and its preservation/rerun assertions on that full-size restore are not yet
verified. A read-only attempt to connect to the retained native fixture was
rejected by authentication; no further credentials were guessed or changed.

Storage reuse requires identical source/scope identities and a strict comparison
of every snapshot field except explicitly retained volatile clocks/trigger.
Changed slots, numeric planning constraints, facts, policy, assignments,
implementation, explanations or semantic retries require another full run.
Checks are at most 64 KiB and less than half the full dossier size. They reconstruct
directly from the immutable base, with base and reconstructed hashes checked.
Active/applied runs are never compacted. Checks do not inflate reviewed-proposal
acceptance counts. The feature reduces future equivalent storage, not existing
database size or all future history growth.

The dashboard and all three legacy timer-start paths now share the validated
current-history reader. Invalidated state, missing/wrong-worker checks or corrupt
hashes block execution. Polling/error timestamps cannot refresh an old assessment.
Check insert and state pointer commit atomically under the existing fresh-context
and worker/queue ownership protections.

Observed verification:
- Pure codec/canonical metadata: 31 passed, zero failed/skipped, normal zero exit.
  `artifacts/production-history-unit-contract-20261001.json`.
- Focused real MySQL chain: 113 passed, zero failed/skipped, normal zero exit.
  `artifacts/production-history-mysql-focused-fixed-20261001.json`.
  The earlier six failures were synthetic timer fixtures that claimed a successful
  assessment while retaining an invalidated null input hash. Fixtures now model
  the successful state; production guards were not weakened. The failed report
  remains retained.
- Strict MySQL release gate: eight suites, 183 passed, zero failed/skipped,
  normal zero exit. `artifacts/production-history-mysql-20261001.json`.
- Production build and all eight image checks exited zero. The first complete
  ordinary suite had one outdated source-contract assertion (2,834 passed,
  one failed, 197 explicit SQL/native skips), normal exit one. That assertion was
  updated to require the validated reader and retain the source gate before
  insertion. Its failed report is `artifacts/production-history-full-20261001.json`.
- The complete retry passed 2,835 assertions, zero failed, with 197 explicit
  SQL/native skips across 291 files, normal zero exit:
  `artifacts/production-history-full-fixed-20261001.json`. The separate SQL counts
  are not additional assertions to sum into this total. Frozen TypeScript also
  exited zero after the final test correction.
- Final compiled candidate passed 21 configured authentication, authorization,
  CSRF, worker-isolation, WebSocket and four-view browser checks, normal zero exit:
  `artifacts/production-runtime-history-checks-final-20261001/results.json`.
  The 390px worker screenshot was inspected; absent work coverage blocks execution
  without AI diagnostics. Synthetic founder uses the existing admin role.

Final candidate identity:
- Tag: `va-dashboard:production-runtime-candidate-history-checks-final-20261001`.
- Independently inspected image:
  `sha256:63cb6d61701dd938991ed1f992802563430b256b94a87919acd9b36844a00620`.
- Matching host/frozen/compiled source identity:
  `305ce1893897f6d47eef67e69cb5c134b19f09d6c8cf4ca691c8271434c37849`.
- Bundle: `7444aea7d9e9055bc084ebd3f56e2a3fd1771859b557996e6d00afb5872a1c6f`.
- Collector: `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.

Only the owned configured-runtime application was replaced; both earlier owned
candidates are stopped and retained. The new fixture has no published ports,
synthetic credentials, disabled scheduled delivery, production RBAC and shadow
mode. Production image/readiness were rechecked unchanged/healthy, HTTP 200.
No provider key rotation, public deployment, commit, push or merge occurred.
Remote CI, full-data application rollback, provider-live acceptance, full-size
migration rehearsal and the actual five-workday/100-reviewed-proposal trial
remain open release gates.

## Full-size 0053 preservation and host runner recovery, 2026-10-01

The retained native fixture's original test access was recovered from this
task's recorded fixture setup, without guessing or changing credentials.
The database identity was checked against the owned restored data directory,
loopback port 33317 and startup-disabled MySQL event scheduler; there are no
database events. No production database was migrated.

The current backup contains 53 source migration identities. The restored fixture
retains those identities plus two later canonical additions through 0052 (55
identities). Migration 0053 appended one identity, producing 56 retained entries.
The separate clean fixture has 54 canonical identities. These are deliberately
different lineages, not a reason to delete, rewrite or normalize the restored
ledger. Every exact hash/timestamp and its order was checked, not only counts.
The additive migration completed in 274 ms on the full restored fixture and
156 ms on the clean fixture.

Original-field record fingerprints were compared with the retained pre-0053
checkpoint, including 132 original tables, 94,674 records and 5,901 full manager
runs. The verification process exited normally with zero and `preserved: true`.
Private receipt:
`.local/pilot/rehearsal-current-20261001-before-preservation-2026-10-01T04-57-12.968Z.json`.
It records success at 04:57:12 UTC. The original checkpoint was not overwritten.
This proves retained original data, not older-application compatibility.

The broader schema, generated-value and whole-record idempotent rerun suite is
running against these two isolated native databases. Its runtime is Node
24.19.0 / Vitest 2.1.9, distinct from the frozen Node 22 release gate. Until its
normal terminal result is inspected, that broader 0053 gate remains unproven.
The later completion receipt below supersedes that pending status, not the
historical observations above.

Separately, the live Codex host runner was absent and its last heartbeat was
dated 15 September. The recorded lock PID did not exist, ChatGPT sign-in was
confirmed, and no pending transport request was present before restart. The
existing launcher exited zero and started owned Node process 48140 at
04:57:26 UTC. A fresh heartbeat confirms `gpt-5.6-luna`,
`luna-adaptive-v1`, and low -> medium -> high reasoning. The operational app
still selects worker 2, subscription-only processing and shadow mode; its image
was independently inspected as unchanged and healthy. No synthetic live prompt
or paid API fallback was used. A fresh heartbeat proves transport readiness,
not accepted semantic advice or an automatic restart service.

## Rollback preflight and verification-seal follow-up, 2026-10-01

The historical production rollback command now refuses before reading runtime
secrets, resolving the worker, invoking Docker or recreating an application.
Caller-supplied proof claims and environment overrides cannot bypass it. This
closes an unsafe shortcut; it does not supply the still-required full-data
application rollback workflow. Deploying an older image through another command
is not an approved workaround.

The build identity also includes the imported rollout-validation module. Tests
prove that changing this module changes the identity and that a missing module
fails closed. No existing history, migration or worker permissions were removed.

Observed frozen Node 22.23.3 / Vitest 4.1.11 verification, each normal zero exit:
- 41 rollout preflight tests, including permission-restricted subprocesses that
  cannot read runtime files or execute Docker:
  `artifacts/production-rollback-preflight-20261001.json`.
- 52 focused preflight/seal tests, overlapping the complete suite:
  `artifacts/production-rollback-seal-focused-20261001.json`.
- 2,851 passed, zero failed and 197 explicit SQL/native skips across 291 files:
  `artifacts/production-rollback-seal-full-20261001.json`.
- Strict MySQL gate: eight suites, 183 passed and zero failures/skips:
  `artifacts/production-rollback-seal-mysql-20261001.json`.
- TypeScript check and production build exited zero. All eight production image
  checks passed, including non-root operation, rejected missing configuration,
  sealed assets and the 144px dashboard icon.
- Compiled configured runtime: 21 authentication, CSRF, worker-scope, WebSocket
  and four-view browser checks passed, normal zero exit:
  `artifacts/production-runtime-rollback-seal-20261001/results.json`.
  The 390px worker screenshot was inspected: absent work-source coverage blocks
  execution without displaying AI diagnostics. The founder fixture still uses
  the existing admin role, not a separately proven founder role.

The first browser launch omitted the required isolated-fixture marker and was
rejected before connection. An initial private wrapper also refused an incorrect
assumption about the browser container's network namespace. The corrected
wrapper verifies the exact retained browser/test-MySQL container identities and
their owned acceptance-network membership; database credentials go through
stdin, never command arguments or reports. These were rehearsal invocation
errors, not successful application acceptance runs.

Current candidate, independently inspected:
- Tag: `va-dashboard:production-runtime-candidate-rollback-seal-20261001`.
- Image: `sha256:96033c3a44400cd6f93decb1f50546b02b3b9613e4b2d4f2bf6c206059c7e24d`.
- Matching frozen/compiled source identity:
  `f4b822f99040b5ede7fd74aefbe9a8e4bbf1377e661c7fa918ba327c5da15fc9`.
- Bundle: `eed79ebc4a94922e44490f327b9618fe441536169caaf34ddbf856467e3b297e`.
- Collector: `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.

Only the owned synthetic runtime app was replaced. Its preceding container was
stopped and retained; the replacement is healthy, has no published ports or
host mounts, keeps production RBAC and shadow mode, and disables automatic
delivery. It is not the operational dashboard. The live dashboard image and
local preview remain unchanged. No production migration, public deployment,
provider key rotation, commit, push or merge occurred in this follow-up.

Full-size 0053 schema/rerun completion, full-data application rollback, provider
acceptance, remote CI, authorized cutover and the actual five-workday/100-reviewed
proposal trial are not established by this candidate's local acceptance tests.

### Subsequent operational subscription acceptance

After the existing retry interval elapsed, the unchanged operational application
issued a normal evidence request at 05:12:24 UTC. No synthetic live prompt or
forced retry was inserted. The private runner reported completion at 05:13:30
UTC, and read-only database inspection confirmed persisted manager run 5956 at
05:13:31 UTC: `semanticReview.success=true`, provider `codex-subscription`,
`mode=shadow`, and no applied plan hash. The previous run 5955 retained its
unsuccessful semantic state; its history was not rewritten.

Recorded adaptive sequence:
- Low: structured-output validation failed, 30,721 ms; 24,229 input and 1,498
  output tokens. It was not accepted or applied as an intermediate result.
- Medium: accepted, 34,657 ms; 24,263 input and 1,649 output tokens.
- High was not needed. No paid API fallback or outgoing message was added.

The persisted successful reservation reset its failure count to zero. This is
stronger than a heartbeat or a mocked provider test: a real operational request
passed the app's semantic validators and was persisted. It remains a single
shadow assessment, not founder-reviewed correctness, complete live-provider
acceptance, or authorization to enable active planning. Windows automatic
startup/restart supervision for the host runner is still not installed.

The redacted, network-isolated source scan also exited zero with no findings:
`artifacts/production-secret-scan-rollback-seal-20261001.json`. Its snapshot
contains exactly the 1,054 current tracked/unignored source/document files and
retains the six existing exact fixture exclusions. It excludes private
environments, SQL backups, local artifacts and Git history. It is not a key
rotation or proof that those private sources contain no credentials. This scan
preceded this additional non-secret operational receipt.

## Full-size 0053 native rehearsal completion, 2026-10-01

The previously pending host-native rehearsal completed normally with exit zero.
`artifacts/production-current-restore-history-0053-20261001.json` records
11 passed, zero failed, zero pending and zero skipped assertions using Node
24.19.0 and Vitest 2.1.9. Four assertions cover additive canonical metadata;
seven execute against the isolated restored and fresh MySQL databases.

The restored database retains 56 migration identities and all historical full
manager runs. The fresh database has 54 canonical identities. The tests check
all expected tables, types, defaults, keys, foreign keys and retained generated
values, then compare every table definition, row digest and ledger row across
a migration rerun. The restored schema assertion took 461,485 ms; its complete
rerun preservation assertion took 981,757 ms. No sampling replaced the retained
record checks. The separate original-field checkpoint proof preserved all 94,674
original records across 132 original tables, including 5,901 full manager runs.

The test run took approximately 24 minutes. The unchanged live application
readiness endpoint returned HTTP 200 at 2026-10-01T05:22:10.459Z. Neither the
live application's schema nor its build was changed by this rehearsal.
This closes the full-size 0053 migration/rerun gate, but does not establish
full-data application backward/forward rollback, provider-wide acceptance,
remote CI, cutover authorization or the reviewed shadow-pilot accuracy gate.

## Expanded route matrix: not a release pass, 2026-10-01

The optional `route-matrix` mode in
`scripts/verify-configured-production-runtime.mjs` exercised 64 cases against
the unchanged compiled rollback-seal candidate: 40 admin cases and 24 worker
cases, each on desktop/mobile and dark/light. It used five owned fixture users,
the isolated HTTPS proxy and real UI theme selection. No provider request,
model prompt or execution action was authorized by this matrix.

The process exited one. The retained receipt is
`artifacts/production-runtime-route-matrix-seal-20261001.json`: 47 UI assertions
passed and 17 failed; all eight authenticated theme setups passed. API-observation
coverage is degraded, so even the passing UI assertions are not provider or
complete data-loading acceptance. No unhandled page errors, external requests
or blocked mutation attempts were observed in the case records.

The `/robert` mobile cases independently recorded a 556px document/body at a
390px viewport in both themes: an actual horizontal-overflow release finding.
Founder and calendar route-specific expectations and all four admin-header
expectations failed and need direct diagnosis, not weakened assertions. Three
other failures on calendar, ATIS and reminders recorded asset failures before
the expected heading appeared. These may include fixture timing/resource or
locator problems; the report alone does not establish their root cause.
The viewed home screenshot still showed loading skeletons, which is not proof
that its data-loading path completed. The matrix needs settled-content and
failed-case screenshot evidence before it can close the broader route gate.

The host source digest remains
`f4b822f99040b5ede7fd74aefbe9a8e4bbf1377e661c7fa918ba327c5da15fc9`:
only the verification harness and documentation changed after the candidate
seal. The operational application readiness check returned HTTP 200 at
2026-10-01T05:30:52.3770787Z; the subscription runner heartbeat was current at
05:30:45.469Z. No production migration, deployment or cutover occurred.
The expanded route gate remains open; earlier 21-check acceptance must not be
presented as passing these additional 64 cases.

## Route diagnosis and truthful failure states, 2026-10-01

The retained four-case diagnostic receipt is
`artifacts/production-runtime-route-diagnostics-seal-20261001.json`. All four
desktop/dark UI cases passed against the prior compiled candidate, but the
runner exited two because source/API coverage was degraded. This is not a
release pass. A 15-second browser interception timeout was shorter than the
application's 30-second request policy and competed with its 15-second Trello
provider deadline. The matrix now permits the existing requests to settle,
records outstanding API paths and failed-case screenshots, and distinguishes
a selected diagnostic run from the complete 64-case matrix.

The diagnosis also found actual application failures: the home timeline and
calendar could imply confirmed empty work after a failed source read; admin
monitoring could label a read failure as denied access or inactive webhooks;
and the Robert oversight header overflowed the 390px viewport. The bounded
patches retain the established routes, backend authorization and provider
permissions. Home/calendar now retain successful data with explicit stale
warnings, expose persistent initial-failure alerts with retry, and suppress
empty-success views until a read succeeds. Webhook health distinguishes
unconfigured, unavailable, verified inactive and verified active. The Robert
header and task text wrap without masking overflow or removing controls.

Parent-owned frozen Node 22.23.3 verification passed 63 focused tests with no
failures or skips, followed by `pnpm check` with exit zero. The focused receipt
is `artifacts/production-route-ui-focused-20261001.json`; its hook/SSR and
service assertions are not rendered browser or live-provider proof. The
network-isolated redacted scan passed with zero findings across 1,058 source
files in `artifacts/production-secret-scan-route-ui-20261001.json`. It preserves
the previous six exact fixture exclusions and excludes private environments,
backups, local artifacts and Git history. Its immutable snapshot precedes the
additional matrix assertions and this non-secret documentation receipt.

The host and frozen source identities match:
`14b6ba651b40cd7af213f8ffb5842e067494628e3a6c5ea5cb1c7814f8b4230d`.
The prior compiled candidate still has the old identity; it must not be
presented as containing these patches until a fresh build and rendered checks
pass. Full tests, compiled-route acceptance and the broader production gates
remain open at this checkpoint. No operational application deployment or
production database migration was performed.

### Fresh compiled route-UI candidate

The ordinary frozen suite completed normally with 2,905 passing tests, zero
failures and 197 explicit database/environment skips, across 295 files:
`artifacts/production-route-ui-full-20261001.json`. The separate strict MySQL
gate passed all 183 tests in eight suites with no skips:
`artifacts/production-route-ui-mysql-20261001.json`. These are separate receipts;
the ordinary skips are not counted as successful integration coverage.

The immutable scanned source snapshot built successfully as
`va-dashboard:production-runtime-candidate-route-ui-20261001`. The inspected
Docker image identity is
`sha256:f61e79baddd90ebd166bbcb7a81fc8b0d483637f675d7eb9338d54aea567838d`;
the build's image-config hash is a different value and is not used as the
container ownership pin. All eight production-image checks passed, including
non-root execution, absence of environment files, bundle/collector integrity,
the 144px icon and fail-closed startup without required configuration.

The compiled seal retains source digest
`14b6ba651b40cd7af213f8ffb5842e067494628e3a6c5ea5cb1c7814f8b4230d`,
bundle hash `434fdbcc59dd217f40e26d40d83639eb3061c97b142a315ddd36877cc123ce63`
and collector hash
`cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.
Only the owned, no-published-ports fake-data fixture was replaced. Its previous
application container was stopped and retained; the operational app was not
replaced. The fixture remains production-authenticated, shadow-only, with
schedulers/delivery disabled and provider traffic blocked by its internal
network.

The 21 standard configured-runtime checks passed with normal exit zero:
`artifacts/production-runtime-route-ui-20261001/results.json`. They cover
session cookies, role and founder/worker scope, CSRF, WebSocket authentication
and room isolation, readiness, headers and initial compiled UI renders. The
worker mobile screenshot still shows initial loading, so this receipt is not
settled task-data acceptance. The additional 64-case matrix is the separate
settled-content gate and was still running at this checkpoint.

The public icon URL also returned HTTP 200, `image/png`, 3,021 bytes and a
valid 144-by-144 PNG header in a fresh read-only check. No new key, permission,
deployment or active manager policy was changed by that verification.

### Settled route coverage and corrected admin assertion

The full fresh-candidate matrix finished with 64 completed cases, eight
successful authenticated theme setups, 60 UI passes and four failures:
`artifacts/production-runtime-route-ui-matrix-20261001/route-matrix/results.json`.
All four failures were the admin webhook-health text assertion, not a missing
screen: the locator matched only the short phrase, while the rendered paragraph
contained the complete unavailable-health explanation. The failure screenshots
and original non-passing report remain unchanged.

The corrected v3 harness retains the full explanation and negative checks for
false inactive/zero-webhook claims. Its four-case rerun passed every UI assertion
and recorded the exact harness checksum, both themes, both viewport sizes,
real fixture identity and settled content:
`artifacts/production-runtime-route-ui-admin-status-20261001/route-matrix/results.json`.
This rerun still reports overall `passed: false` because provider/API coverage
is degraded during authentication setup. It is not a complete matrix rerun or
live-provider proof.

`artifacts/production-runtime-route-ui-coverage-20261001.json` consolidates the
60 original passes and the four passing corrected-locator reruns. It checks
the unchanged image, exact case identities, all setup outcomes, settled
content, layout bounds, browser safeguards and hashes of both source receipts.
It reports 64 UI cases covered, `uiPassed: true`, `degraded: true`,
`passed: false` and `realProvidersVerified: false`. It does not rewrite the
original full-run outcome. No unhandled page errors, external requests, blocked
mutations/redirects or asset errors were recorded in the effective cases.

Both Robert oversight mobile variants now measured viewport/document/body at
390px, replacing the previous 556px overflow. Home and calendar displayed
persistent source-failure alerts and enabled retry, without confirmed-empty
work claims, in all eight desktop/mobile/theme combinations. Browser retry
recovery and populated stale refresh are not demonstrated by this read-only
matrix; those transitions have the focused hook/SSR regression coverage only.

The operational app remained on image
`sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`
and its readiness check returned HTTP 200 at 2026-10-01T06:21:15.443Z. The source
digest still matches the new candidate. No production migration, deployment,
commit, push, permission change or active-mode enablement occurred.

The full-data application backward/forward rollback, real-provider acceptance,
remote CI and authorized cutover, Windows runner supervision and the reviewed
five-workday/100-proposal shadow trial remain open. A further presentation
finding remains for the next bounded pass: empty oversight scopes currently
say that a worker is working autonomously. The empty-admin screenshot does
not support that claim; empty, unavailable and verified operational state need
distinct wording before release.

The final redacted, network-isolated source scan also passed: zero findings
across the same 1,058 allowed files in
`artifacts/production-secret-scan-route-ui-final-20261001.json`. This second
immutable snapshot includes the corrected harness and consolidated verification
notes, but precedes this non-secret scan/heartbeat addendum. Private sources
and Git history remain excluded; this is not credential rotation.
The existing host runner PID 48140 was still running, with heartbeat
2026-10-01T06:23:29.548Z and `gpt-5.6-luna` efforts low/medium/high. A current
heartbeat is not a newly accepted semantic review or installed supervision.

### Oversight availability and identical-input full history

The next bounded pass repairs two observed gaps without replacing existing
platform modules. Robert oversight now describes stored exception categories,
not inferred autonomous work or execution clearance. Main and auxiliary query
failures, initial loading, stale snapshots and retained refresh failures have
separate notices and retries. Main refresh retries all four sources. Repair-only
attention is no longer hidden by the backend total that excludes repair cards.
The new focused SSR/query-hook suite contains 32 tests; the four responsive
structural guards also passed locally. Compiled UI proof follows separately.

Disabling compact manager history now bypasses both identical-input return paths
while a compact head remains. A deterministic reassessment can therefore append
one full record and clear the pointer without advancing source dates or making
another semantic-review call when its retry is not due. Subsequent identical
polls reuse that full record. Tests preserve every earlier full run/check and
the executing plan, and verify atomic rollback of a failed full-history write.
All 185 strict MySQL tests in eight suites passed with no skips on frozen
Node 22.23.3: `artifacts/production-oversight-full-history-mysql-20261001.json`.
This is isolated synthetic integration proof, not full-data binary rollback.

The generic operator runbook incorrectly advised restoring an old SQL snapshot
together with an old image. That instruction now explicitly forbids automatic
database restoration, preserves later activity, and refers to the existing
blocked legacy-rollback and full-data compatibility gates. No production
database or application was changed by these patches. A new source seal,
full suite, compiled image and rendered recovery proof remain pending here;
previous candidate receipts must not be relabeled as testing these edits.

The current backup manifest records the intended pre-cutover rollback image as
`sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`,
matching the freshly inspected operational container. The August image
`sha256:7de4148fe2032b5a2c9183ca28f823864260e4363d9484c55cc5040a91adb674`
also exists locally, but is the historical initial-pilot fallback, not the
recent backup's fallback. Do not substitute it in the current full-data gate.
The full-data-safe runner must use the recent manifest, retain all original
users/data, suppress both binaries' local background writers, and validate the
current candidate -> manifest fallback -> current candidate on the same isolated
restored database. The synthetic five-user runtime runner is not that rehearsal.

The immutable 1,059-file allowed source snapshot passed its redacted isolated
scan with zero findings. Frozen TypeScript checking exited zero. The complete
ordinary suite then passed 2,937 tests across 296 files, with zero failures and
199 explicit SQL/native/environment skips:
`artifacts/production-oversight-full-history-full-20261001.json`.
The 36 oversight availability/responsive assertions are included in that count.
The separate 185-test MySQL receipt above remains the no-skip SQL gate.

The new Docker build and all eight production-image checks passed. The inspected
image is `sha256:ef7c588f0b0889eaebcb0dcd1e062ef12646f7b1d4854f463c42a77dcf7a1003`;
its source digest matches both host and frozen checkout:
`7f8f3b27a4d49bee92e8bffbf6632f1c9d7a84c7bf52b992024d0baa35623bf1`.
The compiled bundle hash is
`f605ed3a6e38e40c49d250af67ecb1379f952a1cf5b01187bd08936d48cdad81`;
the collector hash is unchanged. Only the owned no-public-ports fake-data
application fixture was replaced, with its prior container stopped and retained.
The operational application and full-size restored database remain untouched.

All 21 configured-runtime checks completed normally with exit zero:
`artifacts/production-runtime-oversight-full-history-20261001/results.json`.
They verify signed-cookie role/scope access, CSRF, WebSocket origin/authentication
and room isolation, headers/readiness and initial compiled role pages. As before,
initial-role rendering does not prove settled worker task data or real providers.
The separate four-case oversight GET-failure/retry recovery matrix is pending at
this checkpoint. Previous 64-case receipts belong to their earlier candidate.

The oversight recovery subset subsequently completed all four desktop/mobile
and dark/light cases successfully:
`artifacts/production-runtime-oversight-full-history-recovery-20261001/route-matrix/results.json`.
Each controlled GET failure displayed a persistent unavailable notice without
empty-success categories. Clicking its retry recovered from the real isolated
backend; main Refresh then fetched all four reads and cleared alerts. Both
mobile cases measured viewport/document/body at 390px; desktop measured 1440px.
Screenshots of the unavailable and recovered states were retained and visually
inspected for desktop dark and mobile light. The real UI theme toggles,
authenticated empty-admin identity and exact harness hash were recorded.

The report truthfully remains `passed: false`, `uiPassed: true`, `degraded: true`
and `realProvidersVerified: false`. Each case records the two intentionally
failed oversight requests; authentication setup also records offline Trello
and timeline-source failures. Cases and setups have zero unhandled page errors,
external requests, blocked mutations/redirects and asset errors. Console counters
are not zero: three error messages per recovery case and twelve per setup, with
no warnings. Payloads were deliberately not retained; do not describe this as
a clean-console or live-provider acceptance result. The wrapper returned a
nonzero degraded result normally, not a passing release status.

Both runtime receipts use harness checksum
`9ee7bc7a8b0fd6ff97e2cb1782f8199427eb7b5e5c274878feb23daed7c32934`.
The initial scanned build snapshot precedes the added console counters and these
documentation receipts; those do not change the sealed application source digest,
which was checked again after the browser run. A final allowed-source scan follows
separately. This delta gate is not a fresh 64-route matrix or full-data application
rollback. Real integrations, full-data backward/forward compatibility, reviewed
shadow-trial acceptance, runner supervision and authorized CI/cutover remain open.

The final isolated, redacted allowed-source scan completed normally with exit
zero: 1,059 files and zero findings, recorded in
`artifacts/production-secret-scan-oversight-full-history-final-20261001.json`.
It includes the final runtime harness counters and the preceding documentation
receipts. This non-secret result addendum was appended after that snapshot; no
application source or operational deployment was changed by recording it.

## Full-data rollback checkpoint preparation, 2026-10-01

The dedicated read-only checkpoint component now includes all columns and
all tables, including the migration ledger and both full/compact manager history.
It compares schema as well as multiset row digests without exporting retained
payloads or coercing 64-bit values through JavaScript numbers. It is a preparation
component, not the still-outstanding application backward/forward rehearsal.
See `docs/FULL_DATA_ROLLBACK_CHECKPOINT.md` for ownership/isolation requirements,
format, limitations and the exact remaining gate. Legacy rollback stays disabled.

The first mandatory MySQL run was refused because the separately owned disposable
test server still had `event_scheduler=ON`. Its failure evidence is preserved at
`artifacts/production-full-data-checkpoint-mysql-failed-20261001.json`: 185 passed,
the new five assertions skipped due to the failed setup, and the suite failed.
That is not a successful release gate. With ownership and absence of database
events verified, only that disposable server was changed to `OFF`. CI now makes
the same explicit change only to its disposable MySQL service. The full-size
native restore retains startup `DISABLED`; the operational server was untouched.

The subsequent complete mandatory run passed 190 tests across nine MySQL suites
with no failures/skips, recorded at
`artifacts/production-full-data-checkpoint-mysql-20261001.json`. Follow-up focused
real-MySQL checks also exercised retained view/trigger definitions successfully.
A final frozen-source run and full-size baseline capture follow separately;
these earlier results are not substituted for those receipts.

The frozen final source subsequently passed TypeScript checking and its complete
ordinary suite: 2,971 assertions passed, zero failures, and 204 explicitly
SQL/native/environment-dependent skips across 298 files:
`artifacts/production-full-data-checkpoint-full-20261001.json`.
All 34 checkpoint unit assertions are included; the five real-MySQL checkpoint
assertions are explicitly skipped in that ordinary receipt. The separate final
mandatory SQL gate passed all 190 assertions across nine suites with zero skips:
`artifacts/production-full-data-checkpoint-final-mysql-20261001.json`.
It includes actual generated-column, view/trigger, 64-bit-value, binary/null,
duplicate-record, schema-change and transaction-ownership checks.

The complete native restored-data baseline also finished normally:
`artifacts/production-full-data-rollback-baseline-20261001.json`.
Its single read-only consistent snapshot covers 134 InnoDB base tables and
94,730 records, including all 56 migration-ledger records and 5,901 full manager
runs. There are no views or trigger/routine objects in this restored inventory.
Capture took 462,731 ms and completed at `2026-10-01T07:04:23.673Z`; schema and
server identity were rechecked, with no other clients at the boundary checks.
Digest: `f7a1c26701d7fb04fcde81b4738a706da2489447831e4cc54ae4bebb360d2467`.
It validates against the final checkpoint format. The capture began before the
creation-metadata hashing enhancement for views/triggers/routines; that change
does not affect this all-base-table, zero-object inventory or its row hashing.
This baseline is not evidence of a later unchanged fixture or an application
switch. Both release/rollback clearance fields remain false.

The frozen candidate build and all eight isolated production-image checks passed.
Inspected image ID:
`sha256:8cdf28a297ab05e292df5a34bb5077822e5ddf625e698422fd3053dd99d6b352`.
Source digest, independently matched across host, frozen source and image:
`45b33ef90a5dadb3af98145e8fabf1dcc504c827b7ec40bdd8e22ba71cb05646`.
The compiled server bundle and browser collector hashes remain exactly those of
the prior candidate (`f605ed3a...` and `cd077b5d...` respectively). No dashboard
UI changed in this round; the prior browser receipts retain their own image,
scope and degraded status and are not relabelled as new browser execution.

Two allowed-source scans completed with 1,063 files and zero findings:
`artifacts/production-secret-scan-full-data-checkpoint-20261001.json` and
`artifacts/production-secret-scan-full-data-checkpoint-final-20261001.json`.
The final build snapshot includes the final library/view/trigger tests; README
wording and this execution addendum postdate it. A further receipt snapshot
follows, without changing sealed application source. No production application,
production database, provider credentials, published Git history or live model
calls changed. Operational readiness was checked again at
`2026-10-01T07:07:05.266Z` and returned ready. Remote CI, full-data application
backward/forward compatibility, live providers and reviewed shadow acceptance
are still unproven; no cutover or activation clearance is issued.

The receipt snapshot scan subsequently completed normally with exit zero:
`artifacts/production-secret-scan-full-data-checkpoint-receipts-20261001.json`,
1,063 allowed files, zero findings. It includes the updated README and preceding
execution receipts. Only this non-secret completion addendum postdates that scan;
the sealed source digest and checkpoint component are unchanged. All processes
started for this round's capture, tests, builds and scans have completed normally,
apart from the explicitly retained first refused SQL gate. No application rollback
was started or approved.

## Background startup isolation, 2026-10-01

`BACKGROUND_JOBS_ENABLED=false` now suppresses all six automatic workers in a
production process. Unset/literal `true` retains normal startup; invalid values
fail closed. The existing loopback-only local bypass and browser-test validation
remain restrictive, before Express/Redis startup. Authentication, roles, CSRF,
manual authorized actions and incoming callbacks remain available. This is not
a read-only mode. Webhook initialization still explicitly passes `false` and
retains in-memory callback configuration without automatic provider registration.
See `docs/BACKGROUND_STARTUP_ISOLATION.md` for limits and remaining rollback gates.

The frozen source passed TypeScript checking and the ordinary suite: 2,997 passed,
zero failed, 204 explicitly environment-dependent skips across 299 files,
including all 26 new startup-isolation assertions:
`artifacts/production-background-startup-full-20261001.json`.
The separate mandatory MySQL gate passed 190 assertions across nine suites with
no failures or skips: `artifacts/production-background-startup-mysql-20261001.json`.
The allowed-source scan covered 1,066 files with zero findings:
`artifacts/production-secret-scan-background-startup-20261001.json`.

The built candidate, not deployed, has inspected image ID
`sha256:97f1d4fedca0d148fb630cb4c699ae425838bfe1342e96700e2498999c9d52a2`.
Its source seal is `a16af2499e28e7eb370cd153614c846a51ae20d8b7e807b14116b255f6f5d7cd`,
compiled bundle hash `c96d9b95f3ffa569f689ecaa50f4f0ec6b81418c2329f47bee23903ce1f2169a`,
collector hash `cd077b5d65d876a8f8f34abb9efc1dfedbc08ddcbc8a69c87de48c19ecd827a4`.
The actual build seal is retained beside the startup checkpoints as `build-seal.json`.
All eight actual-image checks were rerun successfully against the inspected ID
and retained in `artifacts/production-background-startup-image-20261001.json`:
production default, non-root, no environment files, sealed bundle, collector
integrity, icon dimensions, no Vitest and fail-closed missing configuration.
The current host and frozen runner independently recomputed the same source
digest after the documentation updates; no sealed application source changed.

The startup rehearsal used only the owned synthetic database: five accounts,
134 base tables and 74 records, including 54 migration-ledger rows. Individual
worker-enable flags were true, and a local database-preload maintenance setting
was armed and made overdue before startup. With the global switch false,
the complete armed checkpoint equals the post-start and post-anonymous-probe
checkpoints. Restoring the original setting produced a checkpoint exactly equal
to the original pre-arm state. Data, all-column digests and schema were compared,
not just counts. The receipt and five checkpoints are in
`artifacts/production-runtime-background-startup-retry2-20261001`.
These preservation comparisons end before authorized login; later login checks
may legitimately update synthetic account timestamps.

Earlier attempts were refused rather than treated as passes: the first helper
did not recognize startup-disabled MySQL event scheduling, the second referenced
a nonexistent `nextRunAt` storage column, and the resumed auth caller supplied a
nested report directory rejected by the verifier. None is a release pass.
The corrected startup helper used the actual `lastScheduledAt` field and
`event_scheduler=DISABLED`. Successful snapshots were retained without rerunning
or overwriting them. An additional auth-only caller initially refused the known
MySQL data volume before any mutation; it then pinned that owned volume explicitly.

The subsequent configured runtime verification passed all 21 checks normally:
`artifacts/production-runtime-background-startup-auth-20261001/results.json`.
It covers real password sessions, cookie security, anonymous/wrong-role denial,
worker/workspace isolation, CSRF, authenticated WebSockets and worker-room
non-leakage. Four compiled browser screenshots were retained and visually
inspected. Their assertions cover heading, login completion, viewport overflow
and uncaught browser errors, not fully settled data: the mobile summary and
founder worker cards still show loading at screenshot time. Admin webhook
information is explicitly unavailable without Trello access. Do not treat this
as complete visual or live-provider acceptance. Runtime harness hash:
`9ee7bc7a8b0fd6ff97e2cb1782f8199427eb7b5e5c274878feb23daed7c32934`.

Only owned rehearsal applications were stopped/restarted; the new candidate
was retained stopped and the four previously running rehearsal applications
were resumed. The operational container and exact `fa20db9c...` image remain
unchanged. Full-data application backward/forward compatibility, populated
route coverage, real provider acceptance, reviewed shadow-trial acceptance,
supervision, authorized remote CI and cutover remain unproven. No active-mode,
rollback or release clearance is issued by these receipts.

Read-only GitHub checks of `Robert-Velhorst/006-autoreminder-virtualworkers`
returned no workflow runs for `codex/aptlss-shadow-pilot-2026-09-25` (limit five),
and no pull requests for that head branch in any state (limit ten). The local
HEAD remains `6a8029cedc61f89609f79a021e193844fb1d716e`; the tested worktree changes
are not attested by that commit or a remote CI result. No commit, push, draft PR,
workflow dispatch, merge or deployment was performed in this continuation.

The separate settled route matrix subsequently completed all 64 cases and eight
login/theme setups against the same candidate image and harness hash:
`artifacts/production-runtime-background-startup-matrix-20261001/route-matrix/results.json`.
It covers 1440px desktop and 390px mobile, dark and light, using the actual theme
toggle. All UI assertions passed: role identity, route content, settled loading
states, expected theme, viewport overflow, unavailable-source notices and
missing-source execution holds. All 64 screenshots were retained; representative
founder, calendar, worker, settings and oversight captures were visually inspected.
This is an empty-admin/missing-work-sources fixture, not populated acceptance.

The overall receipt deliberately remains `passed: false`, `uiPassed: true`,
`degraded: true`. Route cases recorded 32 API failures and 76 console errors;
setups recorded 12 API failures and 64 console errors. There were no uncaught
page errors, console warnings, failed assets, external browser requests,
redirect violations or prohibited browser mutations in either group. The
provider-dependent failures include timeline, assignments, Trello workspace,
board and task requests, plus action alerts returning HTTP 412. Request failures
are not all HTTP errors and their root causes have not all been diagnosed.
They cannot be dismissed or relabelled as working integrations. The browser
guard prohibited external requests and non-login writes. Real providers remain
unverified. Only owned rehearsal applications were cycled; the candidate was
left stopped and the four prior rehearsal applications were resumed.

Two follow-up boundaries were identified, not fixed or verified here. Worker
settings currently describe enabled policy and configured intervals as running
guidance; those labels do not prove a scheduler heartbeat, especially with
startup workers suppressed. The assignments route also retries provider board
discovery and can fall back to all locally stored boards when none are found.
Provider unavailability, empty membership and tenant-safe cached access need
separate tests and a scoped correction before that fallback is accepted.

The final receipt snapshot scan passed with 1,066 allowed source files and zero
findings: `artifacts/production-secret-scan-background-startup-receipts-20261001.json`.
It includes the matrix addendum and current completion matrix; only this
non-secret completion note postdates that scan. Scoped whitespace checking
passed and the application source digest remains `a16af249...` as recorded above.
At `2026-10-01T08:06:14.8024280Z`, the operational `/readyz` probe returned HTTP
200 and `status: healthy`. Docker independently reported the exact retained
`fa20db9c...` image running and healthy. The candidate was stopped and all four
previous owned rehearsal applications were running. No live cutover occurred.

## Restart, Runtime And Rehearsal Follow-Up, 2026-10-01

The complete restored baseline was revalidated after restarting only the owned
native MySQL server on loopback port 33317 with event scheduling disabled.
All 134 base tables and 94,730 records matched the original complete checkpoint,
including 56 migration records and 5,901 manager runs. This proves preservation
across a server restart, not candidate/fallback application rollback.
Receipt: `artifacts/production-full-data-resume-baseline-20261001.json`.

The observed-scheduler candidate image `sha256:c3744226...` passed 21 configured
runtime checks against an isolated five-account fixture: password sessions,
role and worker isolation, CSRF, WebSocket isolation, readiness and compiled
desktop/mobile browser routes. This is not acceptance against the full restored
database or live providers. The candidate was stopped after testing.

Two defects in the legacy rehearsal CLI were corrected: malformed or empty
checkpoints now fail before connecting, and unsafe BIGINT values retain exact
decimal precision rather than being rounded. Legacy original-column proof is
explicitly distinguished from complete data preservation and application
rollback. The locked Node 22.23.3/Vitest 4.1.11 focused run passed 143 tests.
Receipt: `artifacts/production-legacy-rehearsal-fixed-locked-20261001.json`.
The previous full application suite belongs to its frozen source snapshot;
these subsequent CLI/test/document edits require a fresh final source gate.

Seven native restore-safety tests passed on Node 25.2.1/Vitest 2.1.9 using only a
separate generated fixture database: binary/Unicode/large-message preservation,
blocked executable SQL and disabled event scheduling. They did not modify the
full restored baseline. Receipt:
`artifacts/production-native-restore-safety-resumed-20261001.json`.
The owned native server then completed a normal shutdown at
`2026-10-01T10:14:42.753167Z`; its retained data was not removed.

Read-only inspection of the exact operational fallback found no implementation
of `BACKGROUND_JOBS_ENABLED`. Its Manus and maintenance startup paths execute
unconditionally. Therefore the new global flag cannot isolate the old binary;
a controlled full-data binary rollback rehearsal remains open. The operational
fallback was not started against the restored database.

## Authorized Container Cleanup, 2026-10-01

At Robert's request, 31 extra VA test, build and obsolete containers were
removed. The single operational `joyce-work-schedule` stack remains: application,
MySQL, Redis and ngrok. Its exact operational image was neither replaced nor
restarted. Final readiness returned HTTP 200 and `status: healthy`.

All nine database/cache volumes attached to removed containers were inspected
and retained, as were the two operational data volumes. Twenty-four local
recovery images preserve former container filesystem state; mounted database
contents are retained in their volumes, not in image snapshots. These images
can contain private runtime settings and must not be published as public images.
No shared-host prune, volume/image deletion or network deletion was performed.
All 201 previously inventoried unrelated containers were retained.

Receipt: `artifacts/production-docker-cleanup-20261001.json`. The owned native
full-data restore directory and its original checkpoint also remain available.
Removed rehearsal container IDs are historical evidence, not currently runnable
prerequisites. Further tests must create a scoped temporary environment and
remove it after retaining receipts, following the container lifecycle constraint
in `docs/GOAL_COMPLETION_MATRIX.md`. This cleanup is not production cutover or
proof of complete application rollback.

## Post-cleanup Frozen-source Verification, 2026-10-01

The current combined source was frozen and checked without provider credentials,
network access or production-database access. Type checking, 3,147 ordinary tests
in 303 files, the secret scan and the unchanged sealed package build passed;
204 environment-dependent tests were skipped. See the source identity and exact
boundaries in `docs/GOAL_COMPLETION_MATRIX.md`, under "Fresh Frozen-source Gates
After Docker Cleanup", and the combined receipt
`artifacts/production-post-cleanup-build-20261001/boundary.json`.

The initial secret-scan invocation omitted the existing path-specific exceptions;
its six findings were verified schema hashes and fixed test IDs. The successful
run used the same `/repo` path and unchanged exceptions as CI. The initial
type-check runner exhausted its constrained heap; the successful run used 4 GiB
container memory and a 3 GiB JavaScript heap. The first build invocation failed
pnpm's symlink safety check; `npm run build` then executed the identical package
script successfully with the exact locked dependency image. All failed attempts
remain separate evidence, not overwritten passes.

Robert's tightened lifecycle rule was applied: one temporary verification
container at a time, with removal confirmed before another phase started. The
two-container database harness was not launched and was withdrawn. Final Docker
inspection found only the operational application, MySQL, Redis and ngrok in the
VA stack, with no temporary VA runners. Documentation changes after the freeze
are not included in its source digest. Mandatory current-source MySQL/browser
acceptance and actual production-image verification remain outstanding; the
operational deployment was not replaced.

## Single-container MySQL Verification, 2026-10-01

The post-cleanup frozen source now has a fresh mandatory database gate, as
recorded in `docs/GOAL_COMPLETION_MATRIX.md` under "Same-source Single-container
Database Gate". All 190 tests across nine suites passed without failures/skips.
All 54 migrations reran without ledger changes; schema parity passed.
Receipt: `artifacts/production-single-container-mysql-20261001-attempt2/boundary.json`.

The pinned Node/dependency image and stock MySQL 8.4.11 runtime shared a single
temporary container. It had no external network, published ports, production
credentials or production database mounts. MySQL exited normally and container
removal was confirmed before the next phase. The first failed setup attempt is
retained, not replaced with a passing report. Configured-runtime/browser tests,
full-data binary rollback, provider acceptance and cutover remain separate gates.

## Single-container Production Image Verification, 2026-10-01

The same frozen source built through the actual Dockerfile and passed all eight
packaging/fail-closed startup checks. Inspected image:
`sha256:9ce59dedd3dab7f1d9892ad507e91f5e1367c16d13ed3a73e14310522aa1a73e`.
Receipt: `artifacts/production-single-container-image-20261001-attempt2/boundary.json`.
The earlier networkless build could not download pnpm; its failed logs remain.
The successful build allowed locked dependency downloads. Runtime checks had
no network or provider credentials, ran sequentially and confirmed cleanup.
The operating dashboard was not replaced. These eight checks are not configured
auth/browser/realtime acceptance or a full operational-data rollback rehearsal.

## Configured-runtime Setup And Docker Recovery Hold, 2026-10-01

The proposed single-container runtime adapter did not execute the configured
21-check suite. The first build interpreted bare local image IDs as registry
names and failed. The corrected local references were inspected against their
exact IDs, but the second build stalled. Operational readiness timed out at
12:14:47 and 12:16:44 UTC; the owned build client/plugin were cancelled at
12:17:12 UTC. The build's responsibility for the engine failure is not established.

Robert approved a shared Docker Desktop restart. Normal quit failed after its
four-minute deadline. The verified Docker processes were then stopped and only
the `docker-desktop` WSL distribution terminated; no data or containers were
deleted. Engine 29.6.2 responded at 12:40:18 UTC. The original MySQL and Redis
containers reported healthy at 12:42:01 UTC. The tool policy rejected startup of
the existing app/tunnel, so their manual startup was requested. Restoration is
not yet proved; no new candidate was deployed. Preserve
`artifacts/production-single-runtime-20261001-attempt2/boundary.json`, containing
the zero-check failure and recovery boundary. This does not supersede the prior
passing SQL/package-image gates, nor extend them to configured acceptance.

## Prepared Runtime Lifecycle Regression, 2026-10-01

The adapter's local checkpoint/cleanup controller passed nine Node regression
tests, with zero failures or skips. Setup/runtime errors retain a failed receipt;
cleanup cannot erase the original failure. A passing receipt requires confirmed
checks, temporary-container removal and operational-image health. The host now
rechecks health/container inventory after building, and explicitly selects the
correct subscription-provider setting in the synthetic application environment.
Syntax checks passed. No Docker build or test container was started for this
follow-up. These are harness tests, not the 21 configured application checks.

Evidence: `artifacts/production-runtime-lifecycle-20261001/results.json`,
`tests.tap` and the separate read-only `host-status.json`. The latest inspection
still found the original app/tunnel stopped, original MySQL/Redis healthy and no
temporary VA containers. Manual restoration remains required before any new
configured run. The frozen application/test inventory is unchanged; only the
three production-evidence documents differ from that frozen tree. No release
commit, deployment, provider action or data mutation was performed.

## Original Host Restored, 2026-10-01

Robert manually restarted the existing application and tunnel. Fresh read-only
inspection confirmed all four original containers running, app/MySQL/Redis
healthy, the operational image unchanged, HTTP 200 for readiness and `/worker`,
and no temporary VA containers. Receipt:
`artifacts/production-host-restored-20261001/boundary.json`. This supersedes the
host-restoration hold only; previous failed setup receipts remain failures.
No candidate image was deployed. The configured candidate verification is a
separate gate and must not be inferred from operational-host readiness.

## Single-container Configured Candidate Verified, 2026-10-01

The same post-cleanup candidate image passed all 21 configured checks, with the
unchanged frozen verifier. This includes TLS/CSP, five real-password synthetic
accounts, worker/owner/admin isolation, CSRF, WebSocket origin/authentication and
worker-room boundaries, and four compiled Chromium cases. Real providers remain
unverified; the founder fixture is an admin-role owner, not a new founder role.
Receipt: `artifacts/production-single-runtime-20261001-attempt6/boundary.json`;
individual checks/screenshots are under `runtime`, and `execution.json` proves
Node 22.23.3, UID 1001, migration-ledger preservation, disabled SQL scheduler,
normal child exits, container cleanup and operational-host health.

The earlier attempts are not passes. Attempt3 initialized/migrated/seeded MySQL
but approached Redis before readiness. Attempt4 passed 20/21 checks; an isolated
probe confirmed `uv_resident_set_memory` returned `ENOENT` because the candidate
root lacked `/proc`. Attempt5 refused capability reduction and ran no checks.
The final fixture mounts only its own process information read-only into the
candidate root, then removes setup authority from all capability sets before
Node, source, MySQL or browser execution. The harness verifies this restriction.
No production permission, app code, verification assertion or source freeze was
changed to turn these failures into a pass. Fourteen controller/readiness tests
passed separately; reports are in `artifacts/production-runtime-readiness-20261001`.
Full route-matrix, provider delivery, full-data binary rollback, remote CI,
reviewed shadow-trial acceptance and authorized cutover remain separate gates.

## Same-source Route Matrix Completed, 2026-10-01

The post-cleanup image completed all 64 route cases (16 routes, desktop/mobile,
dark/light) and eight authentication/theme setups. All UI checks passed, with
zero page errors, asset errors, external requests or blocked mutation attempts.
The mobile worker dark and desktop admin light screenshots were manually
inspected; this does not imply manual inspection of all 64 captures.

Overall acceptance remains failed/degraded, not green: Trello endpoints returned
412/500, task-source endpoints 503, and manager status 403 for the synthetic
non-pilot worker. The fixture has no live provider credentials or external
network. It proves settled empty/degraded presentation, not provider access,
populated work, model review or the intervention-to-plan workflow. Receipt:
`artifacts/production-single-runtime-20261001-attempt9/boundary.json`; individual
cases and screenshots: `runtime/route-matrix`; isolation/shutdown: `execution.json`.

Failed attempt7 retains its adapter deadline/startup issues. Attempt8 retains
its explicit cancellation receipt; its container exited 137, not a normal
shutdown. Attempt9 waits for real app readiness, aligns the adapter timeout with
the unchanged verifier budget, and uses a fixture-only loopback resolver with
bounded failure and no DNS listener. No application code or verifier assertion
was changed. All attempts were sequential, with cleanup confirmed before the
next. Attempt9 preserved the 54-entry ledger, disabled SQL scheduling, ended all
three application/storage processes with zero exits, removed its temporary
container and confirmed the original dashboard remained healthy. No candidate
was deployed. Live integrations, populated workflows, full-data binary rollback,
remote CI, reviewed shadow-trial acceptance and authorized cutover remain open.

## Subscription Startup Repair Verified, 2026-10-01

The previous production guard incorrectly required an OpenAI API key even for
the default subscription manager route. Startup now validates the selected
provider: default/explicit `codex-subscription` needs no API key, explicit
`openai-api` requires a nonempty key, and unknown providers are rejected without
echoing private values. Legacy platform AI remains API-backed, not silently
converted or enabled. Codex runner availability remains a separate live gate.

The doctor now checks parsed dotenv values instead of treating an empty variable
name as configured. Process overrides, explicit clearing, paid-mode missing keys
and unknown-provider redaction have standalone regressions. README, environment
template and cutover instructions match the new contract; no real secrets changed.

Frozen source has 1,072 files, digest
`5372087f5bb6cbfd961e7d48b996606240ff677ccc2ed456c947c4ce4ab560a1`.
`artifacts/production-subscription-config-20261001` proves locked Node 22.23.3,
Vitest 4.1.11, 123 passing focused provider/config tests without skips, six passing
doctor tests, type check and sealed build. This is not a rerun of the older
3,147-test ordinary suite or 190-test SQL gate. The actual Dockerfile image passed
all eight packaging checks in `artifacts/production-subscription-image-20261001`.
Its generic lifecycle `testContainerStarted` flag was not updated by the
packaging wrapper; the verifier's two sequential owned container checks did run
and were cleaned up. Do not interpret that default flag as no container execution.

Candidate image
`sha256:6d3754b561d549b9853af2f460be4c7a6cfb27cda834f353ef65423a455d3860`
passed all 21 unchanged configured runtime checks, including four compiled
browser cases, explicitly without an OpenAI API key. Receipt:
`artifacts/production-subscription-runtime-20261001-attempt2/boundary.json`.
`execution.json` records `openaiApiKeyConfigured: false`, subscription provider,
UID 1001, auth bypass off, preserved 54-entry ledger, SQL scheduling disabled and
normal app/Redis/MySQL zero exits. Temporary-container cleanup and original-host
health passed. Verification used fresh synthetic data and no external network.
No candidate was deployed and no model prompt or provider mutation was submitted.

The new image has four browser smoke cases, not a fresh 64-route acceptance.
Populated VA workflows, broader final-source gates, live integrations, full-data
binary rollback, remote CI, human-reviewed shadow trial and authorized cutover
remain open. Earlier evidence retains its exact source/image boundaries.
