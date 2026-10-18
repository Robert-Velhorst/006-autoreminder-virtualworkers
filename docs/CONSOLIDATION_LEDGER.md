# Consolidation Ledger

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

## Branch Disposition

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

Those projects must not be repointed to the repository root. The consolidated
server requires a persistent container runtime for Express, tRPC, scheduled
work, Redis, and WebSockets. Retire obsolete hosting Git integrations only
after the public container replacement passes the production cutover gate.
