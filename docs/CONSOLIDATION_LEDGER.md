# Consolidation Ledger

## Current Consolidation Checkpoint: October 21, 2026

The latest accepted main source is merge
`df5c9f3f8af3c06723fe0d1992a50d6153ed4410` from PR #141. Its tree exactly
matches reviewed head `386aab90401312d48f818d3e8c3ccb6ab2266d76`, preserved
under verified annotated tag `archive/canonical-timer-acceptance-20261021`.
Reviewed-head quality `39543523895` and CodeQL `39543520471` passed. Separate
post-merge main quality `39544579909` and CodeQL/push `39544579781` also passed.
The timer branch was removed only after archive and merge-tree verification.

Two temporary source branches remain: PR #135 for exact-image security and the
browser-bound OAuth state repair. PR #135's integrated head `188dc0d` passed
local checks and CodeQL `39545169245`, but quality `39545173841` could not
start; the narrowly scoped Action-policy decision remains pending. The OAuth
repair requires its own exact-head native/route checks and review. Neither
branch is discarded to manufacture an only-main result. Consolidate each only after
its exact-head checks and review pass, preserve the reviewed head in a verified
archive tag, and delete only the matching branch ref. Private configuration,
secrets and recovery archives remain outside Git.

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
