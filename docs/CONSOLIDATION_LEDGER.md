# Consolidation Ledger

## Active Review: PR #148

PR #148 contains the complete PR #147 history plus scheduled creator approval.
PR #147 was closed as superseded, not merged or accepted. Its candidate head
`53feeb8ddebf7dff38c47ec2374c2068a6790870` is preserved by remote annotated tag
`archive/batch-history-authority-candidate-20261021`, object
`03f28eea00dcc0c2962410b77e2e614802c706d2`, with the peeled head verified before
removing its matching branch using an expected-SHA lease.

The remote branch inventory now consists of `main` and the PR #148 branch.
All six registered local worktrees were inspected: no tracked changes or
untracked application source were found at that checkpoint. Detached candidate
heads remain preserved by remote archive tags. Runtime/evidence artifacts are
not a claim that operational data or credentials were uploaded to GitHub.
PR #148 still needs its complete exact-head quality result and resolution of
the two open CodeQL findings before normal consolidation into `main`.

## Superseded Candidate Archive: October 21, 2026

PR #146 head `dd23e75df25e229a3acaa0d153ecc4ddc34e9061` is fully contained in
published PR #147 head `53feeb8ddebf7dff38c47ec2374c2068a6790870`. Ancestry and
the intervening source changes were checked before closing the redundant PR.
The exact candidate is retained by annotated remote tag
`archive/subscription-authority-candidate-20261021`, tag object
`073669e56400fa25f0d1530121be50f0557591bd`, verified peeled head `dd23e75`.
Only the matching remote ref was removed, with its expected-SHA lease; guarded
local branch deletion succeeded. This was supersession, not a production or
security-acceptance merge.

PR #147 quality `39575196607` completed successfully at its exact published
head. Its CodeQL aggregate still has two unaccepted executable-configuration
findings. The launch-root finding is absent from the newer branch analysis.
Subsequent scheduled-approval source remains separate until its own gates pass;
neither candidate's tests accept those later edits. Only-main consolidation is
not complete while the current review/follow-up branches remain.

## Current Consolidation Checkpoint: October 21, 2026

Main now includes accepted timer PR #141, OAuth PR #142 and assignment PR #143.
Assignment merge `7dfe3584d3855f878c7060af897f685707ed7fec` and reviewed head
`e57811c9cd40d5facb829c66074bea18e06a1f79` share tree
`76faa0ee2839a63b4f723393e5e0bf9448a6060b`. Exact-head quality `39551621023`
and CodeQL `39551616110` passed. The reviewed head is preserved under
`archive/canonical-assignment-acceptance-20261021`. Assignment PR #143 was merged
normally with its expected full head; its matching branch was then removed.
Post-merge main quality `39553158382` and CodeQL/push `39553156950` subsequently
passed at that exact merge. These are source gates, not Hetzner acceptance.

Financial authority PR #144 is now merged as
`b92be39f88d66e4f53fae782900b70705f9ade90`. Its tree
`12ed4cfa58c5f3a35da0f144ff92d5b65c26c279` is identical to reviewed head
`c43dee70fadc49522fc4c3fe42285bc37cb5ecb2`. Exact-head quality `39557268165`
and CodeQL workflow `39557267429` plus its aggregate check passed. The reviewed head is preserved by
verified remote annotated tag `archive/financial-authority-acceptance-20261021`:
tag object `e17499ed7bd47d8a00d4d51769a6dfb51690a775`, peeled commit
`c43dee70fadc49522fc4c3fe42285bc37cb5ecb2`. After archive and merged-tree
verification, the remote financial branch was deleted with its exact-SHA lease.
Ordinary local deletion initially refused while the integration merge was in
progress. After merge `be5eea6` contained the accepted source, guarded
`git branch -d` succeeded. No forced local deletion was performed.

PR #135 was the source integration candidate at the preceding checkpoint. Earlier head
`f391013` passed full CI `39557333508`, including an exact-image scan of 633
packages with zero vulnerabilities and no exceptions, and positive PostgreSQL
acceptance with confirmed cleanup for that same image. The pinned official
artifact-upload Action was the sole approved Action-policy addition; the earlier
policy blocker is resolved without broadening the remaining allowlist.

That local PR #135 source included generic credential documentation commit
`0ab95ce` and completed merge `be5eea6` of the accepted main. The integration
requires fresh exact-head quality, security, image and acceptance gates. Neither
the earlier PR #135 receipt nor PR #144's acceptance transfers to this changed
source. Only after those gates and review pass may the reviewed head be archived,
the integration merged, and matching branch refs removed. The target remains
only `main`, preserving all source and recovery history; that final branch state
has not yet been established at this checkpoint. Private configuration, secrets
and recovery archives remain outside Git. No external-provider, deployment or
human shadow-trial acceptance is claimed.

The integration subsequently passed quality `39560277949` and CodeQL
`39560273868` at full head `cba207691700f51b5e88690eeb0cbfa0babac5b5`.
Normal merge `0e18557d45452f5ef1812955eb55f959ebf822d4` and that reviewed head
share tree `56c4fa7fd3fee89d0cc38b1b9e4dbf770c9b58bc`. The verified annotated
remote tag `archive/exact-image-security-20261021` peels to the accepted head;
its tag object is `c3db880dbd3fce0ccc0dd60e677fbc27bd0e183e`. The matching
remote branch was removed with an exact-SHA lease; guarded local deletion
succeeded. New durable-analysis source remains on its own review branch until
its fresh gates pass. No unfinished source was discarded to manufacture an
only-main state, and no operational deployment is implied.

Confirmed-analysis PR #145 subsequently passed quality `39565591698`, CodeQL
`39565587914` and its aggregate at `ce2f95cf61e675939363eee76e284e0324d8db5a`.
Normal merge `820ee121fb137b122727560b9e0deeab71a44bfb` and that reviewed head
share tree `c6f3ce1635fdefc92a3e03895200590d02850376`. Verified archive tag
`archive/atis-admission-acceptance-20261021` has object
`5e2da5f009af43538c3d139861cda80a2fc0659c` and peels to the accepted head.
The remote branch was deleted with the exact-head lease and its contained local
branch with guarded deletion. Subsequent subscription, calendar and authority
work stays separate until its own exact-head acceptance.

### Earlier Only-Main Checkpoint

PR [#99](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/pull/99)
merged as `77d4bf762893a735d9c2aa170b8e9bfe538c5b5f`, with a tree identical to
the green reviewed head `01222c24b3cdf358781a95fa058d2c8b78e3e243`. That head
is preserved by the verified remote tag
`archive/production-consolidation-20261021`. The obsolete PR branch was deleted
using its exact expected SHA. At this checkpoint GitHub and both inspected local
Git common repositories contained only `main` as a branch. New work may require
temporary review branches, which must be consolidated after acceptance.

Six earlier local source snapshots are preserved under remote tags
`archive/local-progress-20261020/*`; the additional preserved consolidation
history remains reachable through archive tags and the consolidated history.
Private configuration, database backups and operational evidence were not
published. Docker cleanup and fixture removal are not authorization to destroy
the retained recovery data or unrelated projects.

Current runtime and acceptance limits are recorded in
[Technical Audit](TECHNICAL_AUDIT.md) and [Production Cutover](PRODUCTION_CUTOVER.md).
The entries below are dated recovery history, not instructions to recreate old
branches, MySQL deployments, tunnel hosting or obsolete providers. In particular,
old references to work being uncommitted describe the original observation,
not the current publication state.

## Recovery Record

| Item | Reference | Decision |
| --- | --- | --- |
| Developer baseline | `5a04e6a` | Canonical application architecture and migration lineage |
| Kamal delivery tag | `delivery/kamal-platform-2026-07-28` | Immutable reference to the exact paid delivery tree at `5a04e6a` |
| Kamal delivery archive | `archive/kamal-platform-delivery-2026-07-28` | Checkout-ready recovery branch for the exact paid delivery |
| Overwritten `main` snapshot | `549b932` | Preserved as tag `backup/joyce-overwrite-2026-07-29` and branch `archive/joyce-operator-current-2026-07-29` |
| Developer source commit | `917a9af45692718796f2bc3a875ee16453a24c67` by Kamal Uddin | Capability source inspected; code adapted only where additive |
| Consolidated branch | `main` at `2a675cd` | Canonical forward branch after verified fast-forward cutover |
| Developer migration boundary | `0027_glorious_epoch` | Canonical; no journal entries were reused or rewritten |

The recovery branch was reverted to a tree that exactly matched `5a04e6a` before any integration work began.

The `5a04e6a` and restored-checkpoint trees both resolve to tree object
`4577bd1d959b3aceeb348093be2167dd3e9e5631`. Kamal's delivered code therefore
remains byte-for-byte recoverable independently of later consolidation work.

## Historical Branch Disposition (July 2026)

| Branch | Disposition |
| --- | --- |
| `main` | Canonical consolidated product; contains the verified recovery history |
| `recovery/restore-developer-platform` | Fully contained in `main`; removed after cutover |
| `consolidation/joyce-operator` | Fully contained in `main`; removed after cutover |
| `archive/joyce-operator-current-2026-07-29` | Retain as rollback snapshot of the overwritten Joyce-only application |
| `archive/kamal-platform-delivery-2026-07-28` | Retain as the exact paid Kamal delivery |
| `codex/port-joyce-operator` | Local source worktree; its commits are fully contained in recovery history |
| `auto-reminder-structured` | Not merged. This unrelated 2025 split application tracked populated credentials and performed automatic Trello, email, SMS, and WhatsApp actions. Its relevant reminder concepts are superseded by the approval-gated platform. The remote branch was removed after cutover; rotate every credential that appeared in its tracked `.env`. |

## Retained Developer Capabilities

- Express bootstrap and REST route structure
- Signed-session authentication and role-based access
- Admin, founder, worker, Robert, and command-center surfaces
- VA management, scheduling, calendar, working hours, holidays, and rescheduling
- ATIS, ARES, interviews, notifications, communication, reports, and analytics
- Trello configuration, boards, webhooks, chatbot, and cache
- Redis, Socket.IO, request queueing, rate limiting, health checks, Docker, and deployment structure
- Drizzle schema and migration lineage through `0027`
- Existing APTLSS plans, steps, card states, scores, audit log, daily plans, policies, follow-ups, and weekly analysis
- Existing time, payment, compliance, triage, reply monitor, email inbox, and Sunday workflows

The previous worker dashboard remains preserved in the developer delivery and
repository history, but its dead compatibility component has been removed from
the consolidated tree and it is not mounted inside the worker operator.
Historical `/worker/operations` links redirect to `/worker` so the product has
one worker shell and one approval model.

The consolidated runtime uses one same-origin `/api` contract. Local and Trello
sessions use the stable `SESSION_APP_ID` audience (default `va-dashboard`) and
do not depend on a legacy Manus `VITE_APP_ID`. This prevents a successful login
from producing a JWT that the protected REST and tRPC procedures immediately
reject.

## Imported Joyce Capabilities

| Capability | Source | Integrated as | Compatibility decision |
| --- | --- | --- | --- |
| Work lane order | Joyce archive | `shared/workLanePriority.ts` | ON-HOLD, DOING, TO-DO, then other |
| Work queue next action | Joyce archive | `server/aptlssWorkQueue.ts` | Joins existing developer APTLSS records; does not replace the engine |
| Free-flow waiting reason | Joyce archive | Deterministic interpreter plus durable history | Local evidence only; no external side effects |
| Decision outcomes | Joyce archive | Transactional operator mutation | Requires free-text outcome; resolves only the linked open step |
| Browser hygiene | Joyce archive | Token-authenticated collector and daily evidence | Uses developer `app_settings`, Socket.IO, and work schedule |
| Plan My Day | Adapted for recovered schema | Versioned deterministic `daily_plans` payload | Protects configured breaks and preserves unscheduled/founder-decision items |
| Operator evidence model | Joyce archive, adapted | New migration `0029` | Additive tables and columns only |
| Worker operator UI | Joyce archive design direction, reimplemented generically | Authenticated `/worker` routes | Joyce is profile data; founder/admin layouts remain separate |
| Local auth bypass | Recovery requirement | Loopback-only worker resolution | Startup rejects production and non-loopback usage |
| Advanced scheduling contract | Developer baseline, repaired on recovery branch | Canonical batch adapter, owner-scoped history, shortcuts, metrics, and one Socket.IO subscription | Retains the developer queue and schema while removing invalid raw-column writes and dynamic React hook calls |

## Deliberately Not Imported

- Replacement application shell, central server bootstrap, and router from the Joyce archive
- Conflicting Joyce migration journal
- Provider-specific model cascade that bypassed the developer AI configuration
- Upwork integration
- Automatic Trello comments, moves, or outbound messages
- Browser-extension auto-install behavior, which browsers do not allow safely
- Hard-coded Trello API and Power-Up keys; setup values now load from server configuration at runtime
- The `auto-reminder-structured` legacy application, its tracked credentials,
  and its automatic outbound reminder jobs

## Data Authority

- Developer identity, worker assignment, scheduling, authentication, ATIS, and ARES data remain authoritative.
- Existing APTLSS plans, steps, states, scores, and daily plans remain the shared operational source.
- Joyce evidence and history are imported only into compatible or operator-specific tables. Compatible history includes APTLSS plans/steps/states/scores/audit, daily plans, app settings, compliance snapshots, and time entries; identity rows are excluded.
- Database transfer must use `scripts/operator-data-transfer.mjs`, a source backup, and a reconciliation report.

## Required Merge Gates

- Typecheck, full unit/integration tests, production build
- Migration apply and rerun against a developer-lineage database
- Export/import/reconciliation rehearsal from a Joyce snapshot
- Admin, worker, unauthorized, and wrong-role auth checks
- Desktop/mobile and dark/light browser QA for restored routes and worker routes
- Trello, timers, Redis, WebSockets, notifications, Gmail/Drive evidence, and maintenance verification
- Rollback rehearsal using the preserved branch, tag, previous build, and database snapshot

The recovery branch passed the repository quality gate on 30 July 2026:
secret scan, TypeScript, canonical MySQL migrations, schema parity, 564 tests,
production build, and migration-drift detection. The two failing deployment checks
are obsolete project configurations that still point to removed `Frontend` and
`Backend` directories; they are not application test failures.

The retired request-only hosting projects must not be repointed to the
repository root or recreated. The consolidated server requires a persistent
container runtime for Express, tRPC, scheduled work and WebSockets, with optional
external Redis. Their earlier removal did not establish replacement-host
acceptance; the Hetzner cutover gate remains mandatory.

## October 1, 2026: reliability changes without capability removal

| Existing capability | Change | Preservation and verification |
| --- | --- | --- |
| Developer admin workload timeline | Replace the decorative third-party image with a local background | Timeline, schedule data, filters and navigation remain unchanged. A real browser trace reproduced the external DNS failure; the final live browser matrix is recorded in the dated production verification dossier. |
| Attachment extraction | Use the installed PDFParse v2 API and await parser cleanup | PDF text and page counts remain available; no generated page-footers are inserted into evidence. Real-parser regressions run with the frozen dependency set. |
| Attachment downloads | Await asynchronous rejection inside the error boundary and use redacted failure labels | Pinned-address HTTPS, byte limit and unavailable-result semantics are retained. No provider credential or attachment address is added to logs. |
| Developer and operator migration lineage | Verify generated values in bounded indexed batches | All records and canonical expressions are checked; none are sampled, removed or rewritten. Full database rerun fingerprints are still required separately. |
| Redis cache and realtime transport | Recover from sustained outages and Redis missing at startup, with each retry delay capped at two seconds and one stable socket adapter | Application commands have finite retries and no offline queue. Only the dedicated subscriber retains fixed internal subscriptions. Offline adapter publications stay local; disconnect-race rejections are handled. Both clients must be ready for healthy readiness. Real cross-process recovery and offline-shutdown/session checks are recorded in the verification dossier; no data or service is removed. |

Session-recovery follow-up: canonical Express/tRPC authentication now distinguishes
infrastructure failure from rejected credentials. Unverified writes fail closed
with 503; an outage neither grants nor clears a cookie. Developer users/roles and
worker-profile checks remain authoritative. Compiled-image MySQL outage/startup
tests preserve all synthetic records except intentional login timestamps; the VA
gets recovery instructions without AI or driver diagnostics.

These are uncommitted changes in the shadow-pilot branch. Candidate image checks
do not authorize a production cutover, replace role-based access, or establish
live provider readiness. See `PRODUCTION_VERIFICATION_20260930.md` for the
source-specific passing and failed reports.

## October 1: Shared Scheduled-Job Ownership

The existing `scheduled_job_leases` and `scheduled_job_runs` remain authoritative;
no migration, discarded history or parallel job subsystem was introduced.
The shared runner uses database-clock ownership, a post-acquisition completion
check, transactional start/completion fencing and owner-scoped cleanup.
Interrupted attempts retain their abandoned record. Briefing/EOD delivery checks
ownership before its provider call. The separate manager queue and reminder
transactions retain their existing contracts. Source: this checkout's scoped
production-hardening changes; no transplanted third-party commit or authorship.
Evidence and explicit external-provider limitations are recorded in
`docs/PRODUCTION_VERIFICATION_20260930.md`, October 1 shared-job section.

## October 1: Operation-Level Ownership Fences

The existing maintenance, timer, Google evidence, source-commitment, Trello reply,
checklist-generation, webhook and email modules now carry the shared job's
ownership/cancellation checks. Transactional checks reuse the current connection;
maintenance eligibility and its run record are claimed atomically. Timer stop
preserves concurrent manual edits. Webhook inventory failures cannot authorize
bulk removals, and rejected preload cleanup is handled. Manual actions retain
their existing contracts and approval gates. No migration, removed developer
capability, transplanted source commit or authorship change is involved.

The current source-specific candidate and passing evidence are recorded in
`PRODUCTION_VERIFICATION_20260930.md`, operation-level section. Its 2,786 ordinary
assertions, focused assertions and separate SQL assertions overlap; do not sum
them. Synthetic local proof is not live provider acceptance or authorization to
cut over production. Provider outcome reconciliation remains a separate gate.

## Deployment branch reconciliation (2026-10-19)

PR #103 keeps the current PostgreSQL runtime, verified TLS, source/release gates,
notification policy, and working-day regression tests. Its obsolete MySQL
Compose alternative is retired. Placeholder rejection, configured Redis health,
Docker credential/data exclusions and the missing Trello comment opt-in guard
are retained. No live cutover or credential rotation was performed.
