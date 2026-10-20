# Virtual Worker Operations Platform

This repository combines the developer platform with a reusable worker operator while preserving the developer architecture, authentication, RBAC, database lineage, and deployment services. Joyce is the first configured worker profile; her identity, schedule, timezone, evidence, and integrations are profile data rather than application-wide assumptions.

## Application Surfaces

| Route | Role | Purpose |
| --- | --- | --- |
| `/` | admin | Developer administration dashboard |
| `/founder` | admin | Founder and worker management |
| `/aptlss` | admin | APTLSS management |
| `/settings` | admin | Platform settings |
| `/calendar` | admin | Calendar |
| `/advanced-scheduling` | admin | Advanced scheduling |
| `/atis-phases` | admin | ATIS analysis |
| `/robert` | admin | Robert oversight |
| `/command-center` | admin | Priority command center |
| `/admin` | admin | System monitor |
| `/worker` | worker | Profile-scoped worker queue |
| `/worker/plan` | worker | Persisted Plan My Day |
| `/worker/decisions` | worker | Decision inbox and recorded outcomes |
| `/worker/evidence` | worker | Evidence and integration state |

The worker experience has one canonical application shell. Historical
`/worker/operations` bookmarks redirect to `/worker`; the recovered worker
dashboard source remains preserved in Git history and the Kamal delivery
archive, but it is not mounted as a second portal.

## Evidence-Backed APTLSS Manager

The worker queue includes an evidence-backed project manager. It starts in **shadow mode**:
it retains assessments, source passages, verification questions and proposed day plans,
but does not overwrite the worker's executing plan or send external messages.
The founder can review proposals in the existing founder portal. Automatic plan changes
are restricted to one pilot worker after code-specific safety tests and a real reviewed
trial of at least five working days and 100 distinct proposals pass. A displayed trial
result is not a probability that future decisions will be correct.

See [APTLSS reliability and acceptance](docs/APTLSS_RELIABILITY.md) for the behavior,
permissions, additive migrations, test commands, activation gates and remaining live
acceptance requirements. Automated tests do not substitute for the human shadow trial.

## Local Setup

1. Install Node.js 20 or newer and pnpm 10.4.1.
2. Copy `.env.example` to `.env` and supply the required database, session, and Trello settings.
3. Start MySQL and optional Redis with `docker compose up -d mysql redis`.
4. Apply migrations with `pnpm db:push`.
5. Run `pnpm dev`.

The server binds to `127.0.0.1` by default. Set `HOST` explicitly for a deployed environment.

## Production Deployment

The complete application needs a persistent container runtime with MySQL,
Redis, HTTPS, and WebSocket support. `docker-compose.yml` applies the canonical
Drizzle migrations before starting the application and refuses insecure or
incomplete production configuration.

Vercel's request-only runtime is not a supported deployment target for this
application. The server performs scheduled work, maintains WebSocket state,
and serves the frontend and API from one Node process. Do not repoint the old
`Frontend` or `Backend` Vercel projects at the repository root; deploy the
provided Docker image to a persistent container host instead.

For the approved local Docker + ngrok deployment, keep the ignored `.env` for
application credentials and `.env.db.local` for Docker-only credentials, then
run:

```powershell
pnpm docker:public
```

The command builds the unified app, starts MySQL, Redis, the application and
ngrok, discovers the assigned HTTPS URL, injects it back into the backend for
webhook generation, and verifies both local and public health endpoints. The
current URL is written to ignored `.local/public-dashboard.json`.

See [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md) for the required
secret contract, verification gate, rollback requirements, and the boundary
for retiring the old Vercel projects.

## Authentication

Production uses the restored user table, signed sessions, and role checks. Admin and worker routes are independent.

For loopback development only, `LOCAL_AUTH_BYPASS=true` can select one existing worker account. The server refuses to start when this flag is enabled in production or when `HOST` is not loopback. If more than one worker exists, set `LOCAL_AUTH_BYPASS_OPEN_ID` to the exact worker `openId`.

## Operator Data

The canonical migration lineage is the developer sequence through `0027_glorious_epoch`. Consolidated migrations are additive:

- `0028_add_task_assignment_schedule`
- `0029_operator_evidence_foundation`
- `0030_restore_schema_parity`
- `0031_worker_operator_scope`

`0029` adds evidence-backed assessments, waiting reasons, decision outcomes, cross-source evidence, communication and compliance evidence, time reconciliation, maintenance run history, and browser-tab evidence. It does not drop or rename developer tables.

`0030` repairs three schema/migration parity gaps found during the fresh-database rehearsal. It adds the Trello member identifier, backfills generic reply-thread columns while retaining their legacy Joyce-named sources, and creates the unsigned-message table expected by the restored application.

`0031` scopes waiting reasons, decision outcomes, browser inventories, browser policies, collector tokens, and daily browser evidence to the authenticated worker. Existing operator rows are backfilled to the matching worker account before the new constraints are enforced.

Use the transfer utility before importing an operator database:

```powershell
node scripts/operator-data-transfer.mjs export --out .local/operator-export.json
node scripts/operator-data-transfer.mjs import --in .local/operator-export.json --target $env:TARGET_DATABASE_URL --worker-id 42 --founder-id 1
node scripts/operator-data-transfer.mjs reconcile --in .local/operator-export.json --target $env:TARGET_DATABASE_URL
```

The utility never prints connection strings and produces row-count, identity-map, and conflict reports. It imports compatible APTLSS, daily-plan, compliance, time, and operator history, but deliberately excludes `users`, VA identity, founder identity, authentication, scheduling, ATIS, and ARES records because the developer database remains authoritative for those domains. `--worker-id` and `--founder-id` must reference existing target identities; legacy rows are never attached by guessing.

## External Actions

Trello comments, card moves, outbound messages, and similar external effects remain explicit and policy-gated. Recording a decision outcome or waiting reason only updates local platform data. The browser collector uses a dedicated bearer token and stores sanitized URLs without query strings or fragments.

## Verification

```powershell
npx.cmd pnpm@10.4.1 check
npx.cmd pnpm@10.4.1 test
npx.cmd pnpm@10.4.1 build
npx.cmd pnpm@10.4.1 test:e2e
```

See [docs/CONSOLIDATION_LEDGER.md](docs/CONSOLIDATION_LEDGER.md) for source ownership and compatibility decisions.
See [docs/BRANCH_CONSOLIDATION.md](docs/BRANCH_CONSOLIDATION.md) for the
preserved Kamal delivery, branch dispositions, and main cutover rules.
