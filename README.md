# Virtual Worker Operations Platform

This repository contains a production-oriented operations platform for managing virtual workers, their assigned work, their evidence trail, and the safety rules around external actions. It started as the `006-autoreminder-virtualworkers` project and now consolidates the recovered developer platform with the worker-operator features built during the Joyce dashboard work.

The product is intentionally worker-neutral. "Joyce" may still appear in old paths, migration compatibility notes, screenshots, backup names, or historical documentation, but the application model is generic: a worker is a profile with assignments, schedule settings, evidence connections, compliance history, reminders, and permissions. Replacing a worker means inviting a new worker profile; it does not require renaming or rebuilding the app.

## Plain-English Summary

The platform helps an owner, founder, or operations manager answer four practical questions:

1. What should the worker do next?
2. What evidence supports that recommendation?
3. Has the worker communicated, updated cards, tracked time, and handled follow-up properly?
4. Which actions are safe to automate, and which require explicit human approval?

It combines Trello work data, APTLSS assessments, worker schedules, timers, Gmail/Drive evidence, browser-tab hygiene, reminders, compliance history, and maintenance jobs into one controlled application.

The application does not blindly send messages, move Trello cards, archive email, or modify third-party systems. Read-only evidence collection is separated from external side effects. Any consequential provider action must remain explicit, permission-checked, and policy-gated.

## Who This Is For

Non-technical users can use the dashboard to:

- See the worker's current queue and daily plan.
- Review decisions that require a recorded outcome.
- Check whether communication, time tracking, browser organization, and Trello updates are being handled.
- Connect evidence sources such as Gmail and Google Drive.
- Run or schedule maintenance jobs from Settings.
- Replace a worker without losing historical audit data.

Software developers can use the repository to:

- Run the full-stack app locally or in Docker.
- Inspect and extend the Express, tRPC, React, Drizzle, MySQL, Redis, Socket.IO, and Playwright implementation.
- Add additive migrations after the canonical developer migration lineage.
- Verify role boundaries, provider-safety boundaries, schema parity, and Docker deployment.
- Integrate additional evidence sources without creating automatic external mutations.

## Product Surfaces

The app has separate surfaces for different roles. This is important: the worker operator is not the entire platform, and the founder/admin views are not embedded inside the worker portal.

| Route | Role | Purpose |
| --- | --- | --- |
| `/` | admin | Main developer/admin dashboard |
| `/founder` | admin | Founder and worker management |
| `/aptlss` | admin | APTLSS management and analysis controls |
| `/settings` | admin | Platform settings, maintenance, integrations, policies |
| `/calendar` | admin | Calendar and schedule view |
| `/advanced-scheduling` | admin | Advanced scheduling and batch scheduling controls |
| `/atis-phases` | admin | ATIS phase analysis |
| `/robert` | admin | Robert oversight surface |
| `/command-center` | admin | Priority command center |
| `/admin` | admin | System monitor |
| `/worker` | worker | Worker cockpit: now, next, context, evidence, actions |
| `/worker/plan` | worker | Plan My Day and time-blocked daily plan |
| `/worker/decisions` | worker | Decision inbox and recorded outcomes |
| `/worker/evidence` | worker | Connected evidence and compliance facts |
| `/worker/reminders` | worker | Durable reminders and follow-up commitments |
| `/worker/settings` | worker | Worker-specific settings and source connections |
| `/accept-invite/:token` | invited worker | One-time worker account activation |

Historical `/worker/operations` bookmarks redirect to `/worker`. The recovered worker dashboard source is preserved in Git history and archives, but it is not mounted as a second portal.

## Core Capabilities

### Worker Cockpit

The worker cockpit is the daily execution surface. It prioritizes the current work item, the next few items, and the context needed to act without mixing every possible report and action into one feed.

It includes:

- Now and next work queue.
- Worker-scoped Trello context.
- APTLSS-backed next action and confidence information.
- Current timer state.
- Evidence summary for Trello, Gmail, Drive, communication, and time.
- Browser-tab hygiene warnings.
- Details drawer for deeper task context and secondary actions.

### APTLSS Assessment System

APTLSS is the platform's assessment layer for cards, steps, waiting reasons, priority, and operational confidence. It uses existing Trello state, APTLSS plans, card states, scores, steps, Robert-required decisions, worker evidence, communication evidence, Gmail/Drive evidence, and tracked time to determine what should happen next.

Current APTLSS-related behavior includes:

- Work lane ordering: ON-HOLD first, then DOING, then TO-DO, then other cards.
- Free-flow waiting reason interpretation.
- Durable waiting reason history.
- Decision outcome recording.
- Confidence and evidence summaries.
- Daily plan generation and persistence.
- Maintenance jobs for keeping queue state fresh.

APTLSS assessments are local platform records. They do not automatically post Trello comments or move cards.

### Plan My Day

Plan My Day produces and stores a daily schedule for the worker. It is based on the worker's profile, working window, breaks, active cards, APTLSS state, priority scores, decisions, blockers, and available minutes.

It supports:

- Loading an existing daily plan before regenerating.
- Generating a plan for a date.
- Persisting a versioned JSON schedule in `daily_plans`.
- Updating block status.
- Protecting configured working windows and breaks.
- Showing unscheduled and decision-required items.

### Decisions

The decision inbox is worker-facing. It focuses on open decisions and operational exceptions, not on a long static rule guide.

It supports:

- Open decision queue.
- Decision inspector with card context.
- Required free-text outcome before closing a decision.
- Local persistence of the recorded outcome.
- Resolution of the linked open APTLSS decision step.
- Recent outcome history.

Recording an outcome does not post to Trello and does not move the card.

### Compliance And Accountability

Compliance history is designed to be evidence-backed rather than manually asserted. It can include:

- Trello card update compliance.
- ON-HOLD and DOING review coverage.
- Email/message processing status.
- Communication response rates.
- Time tracking and overtime.
- Browser-tab hygiene at end of day.
- Daily, monthly, quarterly, and yearly evidence views.
- Low-confidence items that require the worker to explain or update the record.

The system should ask for clarification when evidence is insufficient instead of fabricating a conclusion.

### Communication Evidence

The platform can track communication-related evidence, including Gmail-derived inbox tasks and response/completion status. Gmail evidence intake is read-only. It does not send, archive, label, delete, or move messages.

Outbound email delivery is a separate capability and remains disabled unless explicitly configured and enabled.

### Google Evidence

Worker-managed Google evidence can use:

- Gmail read-only scope for inbox evidence.
- Google Drive metadata read-only scope for file evidence.
- Per-worker OAuth connection.
- Worker-controlled sync intervals.
- Bounded import and source ownership checks.

Connected Codex Gmail or Google Drive tools are not runtime credentials for this app. The app needs its own Google OAuth setup.

### Trello Integration

Trello is a primary work source. The platform supports:

- Server-side Trello API key and token for trusted backend operations.
- Optional Trello login API key for browser sign-in.
- Trello board/card context.
- Webhook callback registration when a public HTTPS URL exists.
- Polling fallback when webhooks are unavailable.
- Worker-scoped card authorization checks.
- Approval-gated comments and mutations.

Trello webhooks require a public HTTPS callback and the appropriate Trello app allowlist.

### Browser Hygiene

The browser collector is a local evidence source for tab organization. It uses a dedicated bearer token and stores sanitized URLs without query strings or fragments.

It can warn the worker near the end of the day when too many actionable tabs are open. Browser extensions cannot be silently installed by a website or dashboard; the user must approve the extension once in the browser.

### Reminders

The reminder system tracks commitments and follow-up. It supports:

- Manual and source-linked reminders.
- Due reminder processing.
- Worker/admin access checks.
- Quiet hours, delivery limits, and policy controls.
- In-app reminders.
- Email reminders only when email delivery is explicitly enabled and approved.

### Maintenance Center

Operational maintenance runs are grouped under Settings instead of scattered across the app. Each job can have its own interval and can be run manually.

Current maintenance job keys include:

- `google_evidence`
- `trello_commitments`
- `communication_evidence`
- `eod_compliance`
- `weekly_analysis`
- `aptlss_queue`
- `webhook_sync`
- `database_preload`

Maintenance runs use local job state, active-run protection, interval settings, and progress/ETA-oriented UI where supported.

### ATIS And ARES

The recovered developer platform includes ATIS and ARES capabilities. These remain part of the admin/developer application surface and are not replaced by the worker cockpit.

ATIS is used for task intelligence and phase analysis. ARES remains in the restored router and schema lineage. See [docs/ATIS-SPECIFICATION.md](docs/ATIS-SPECIFICATION.md) and the admin routes for implementation details.

## Architecture

At a high level:

```text
React/Vite UI
  -> REST APIs under /api
  -> tRPC APIs under /api/trpc
  -> Express unified Node server
  -> MySQL via Drizzle ORM
  -> Redis for cache/distributed realtime support
  -> Socket.IO for realtime updates
  -> Provider APIs: Trello, Google, OpenAI, optional email providers
```

Important directories:

| Path | Purpose |
| --- | --- |
| `client/src` | React application, pages, components, hooks, tRPC client |
| `server` | Express routes, tRPC routers, services, auth, schedulers, tests |
| `server/_core` | Server bootstrap, cookies, production config, static serving, tRPC context |
| `server/routes` | REST route modules |
| `server/services` | Trello, ATIS, reminders, scheduling, cache, evidence, email, queues |
| `drizzle` | Canonical SQL migrations and schema definitions |
| `shared` | Shared domain helpers and types used by client and server |
| `e2e` | Playwright browser tests |
| `scripts` | Migration, doctor, data-transfer, Docker/ngrok helper scripts |
| `docs` | Architecture, runbook, audits, security, cutover and verification notes |

The app is built as a single unified Node process that serves both frontend and backend. This matters for deployment: scheduled work, Redis, WebSockets, Express routes, tRPC, and static serving are part of the same runtime contract.

## Backend API Overview

REST routes are mounted under `/api`. tRPC is mounted under `/api/trpc`.

Major REST areas include:

- `/api/health` and `/readyz`
- `/api/auth`
- `/api/worker-invitations`
- `/api/google-evidence`
- `/api/trello`
- `/api/working-hours`
- `/api/va`
- `/api/holidays`
- `/api/reschedule`
- `/api/atis`
- `/api/notification-preferences`
- `/api/notifications`
- `/api/trello-webhook`
- `/api/trello-webhook/bulk`
- `/api/trello-boards`
- `/api/handoff`
- `/api/communication`
- `/api/analytics`
- `/api/reports`
- `/api/interview`
- `/api/performance`
- `/api/scheduling`
- `/api/atis/phases`
- `/api/batch-operations`

Major tRPC routers include:

- `auth`
- `system`
- `trello`
- `aptlss`
- `replyMonitor`
- `operator`
- `reminders`
- `haiConnector`
- `maintenance`
- `interview`
- `settings`
- `ares`
- `atis`
- `scheduling`
- `payment`
- `payLog`
- `triage`
- `onHoldChecks`
- `streak`
- `sunday`
- `timer`
- `compliance`
- `emailInbox`
- `cardSnooze`

## Data And Migrations

The developer database lineage through `0027_glorious_epoch` is canonical. Later worker/operator changes are additive and must not rewrite earlier migration history.

Important additive migrations include:

| Migration | Purpose |
| --- | --- |
| `0028_add_task_assignment_schedule` | Task assignment scheduling |
| `0029_operator_evidence_foundation` | Operator evidence, decisions, waiting reasons, compliance and time evidence |
| `0030_restore_schema_parity` | Schema parity repairs after consolidation |
| `0031_worker_operator_scope` | Worker scoping for operator evidence |
| `0032_worker_invitations` | Expiring worker invitations |
| `0033_durable_reminder_orchestration` | Durable reminders and commitments |
| `0034_hai_worker_control_connector` | HAI read-only feed |
| `0035_worker_evidence_isolation` | Strict worker evidence ownership |
| `0036_formalize_atis_checklist` | Formal ATIS checklist records |
| `0037_maintenance_job_settings` | Maintenance job intervals and controls |
| `0038_reply_thread_lifecycle` | Generic reply-thread lifecycle |
| `0039_remove_legacy_trello_comment_tokens` | Legacy Trello comment token cleanup |
| `0040_expand_trello_task_cache` | Expanded Trello task cache |
| `0041_hash_browser_tab_collector_tokens` | Hashed browser collector tokens |
| `0042_hash_legacy_browser_tab_collector_token` | Legacy token hashing |
| `0043_worker_cockpit_query_indexes` | Worker cockpit query indexes |
| `0044_schedule_history_tenant_scope` | Tenant-scoped schedule history |

Use additive migrations only. Do not drop developer tables, reuse conflicting migration journals, or attach imported worker history to a new worker by guessing.

## Authentication And Authorization

Production uses:

- Signed HTTP-only session cookies.
- Role checks for admin and worker routes.
- Separate admin/founder and worker surfaces.
- Worker-scoped evidence and card authorization.
- Rate limiting.
- Trusted session origin checks for browser writes.
- Local auth bootstrap for the first owner only when explicitly configured.
- Loopback-only local auth bypass for development.

`LOCAL_AUTH_BYPASS=true` is accepted only for loopback development and is rejected in production or on a non-loopback host.

## External Action Policy

The platform deliberately separates evidence from action.

Read-only or local actions:

- Ingest Trello context.
- Ingest Gmail read-only evidence.
- Ingest Drive metadata.
- Interpret waiting reasons.
- Record decision outcomes.
- Update local compliance history.
- Update local daily plans.
- Store browser-tab evidence.

External side effects requiring explicit policy and user action:

- Posting Trello comments.
- Moving Trello cards.
- Sending email.
- Retrying provider sends.
- Closing externally meaningful workflow items.

No provider response should be converted into fake success. If a provider is unavailable, the app should report the failure.

## Required Local Tools

- Windows PowerShell or a compatible shell.
- Node.js 20 or newer.
- `pnpm` 11.19.0, or use `npx.cmd pnpm@11.19.0 ...` on Windows.
- Docker Desktop for MySQL, Redis, app container, and optional ngrok.
- MySQL 8.4 when not using Docker Compose.
- Optional Redis 7.
- Playwright browsers for E2E tests.

## Environment Setup

1. Copy `.env.example` to `.env`.
2. Fill in at least:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - `TRELLO_API_KEY`
   - `TRELLO_TOKEN`
   - `OWNER_OPEN_ID`
   - `OWNER_NAME`
3. Add `OPENAI_API_KEY` when AI-backed features are used, and always in production.
4. Add Google OAuth values only when Gmail/Drive evidence is needed:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
5. Add Redis, webhook, ngrok, and email settings only when those capabilities are enabled.

Never commit `.env`, `.env.db.local`, `.local`, backups, exported data, provider tokens, or database dumps.

## Running Locally Without Docker

```powershell
pnpm install
pnpm db:push
pnpm dev
```

The development server binds to `127.0.0.1` by default. If the configured port is busy in development, the server searches for the next available port.

On Windows, if PowerShell cannot resolve `pnpm`, use:

```powershell
npx.cmd pnpm@11.19.0 dev
```

## Running With Docker Compose

For local persistent services:

```powershell
docker compose --env-file .env.db.local up -d mysql redis
pnpm db:push
pnpm dev
```

For the full local container stack:

```powershell
docker compose --env-file .env.db.local up -d --build
```

For the approved local app plus public ngrok tunnel:

```powershell
pnpm docker:public
```

That script starts MySQL, Redis, migrations, the app, and ngrok, then checks local and public health. The public tunnel can go offline briefly during replacement. The current public URL is written to `.local/public-dashboard.json`.

## Production Deployment

The supported production shape is a persistent container runtime with:

- Node.js application container.
- MySQL with persistent storage.
- Redis with persistent storage.
- HTTPS public URL.
- WebSocket support.
- Scheduled job execution.

Vercel request-only/serverless deployment is not a supported target for this app. The server needs long-running process behavior for scheduled jobs, WebSockets, cache coordination, and unified frontend/backend routing.

Before public cutover:

1. Back up the source database.
2. Configure secrets in the deployment secret store.
3. Apply migrations.
4. Confirm `/api/health` and `/api/health/ready`.
5. Confirm admin and worker login.
6. Confirm WebSocket connectivity.
7. Confirm Trello, Google, OpenAI, Redis, scheduled jobs, and maintenance state.
8. Confirm no unapproved Trello comment, card move, email send, or provider mutation happens during smoke testing.
9. Keep the previous build and database snapshot through the rollback window.

See [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md).

## Google Evidence Setup

To connect Gmail and Drive evidence:

1. Enable Gmail API and Google Drive API in Google Cloud.
2. Create an OAuth 2.0 Web application client.
3. Add the deployed callback URL:

   ```text
   https://your-public-domain.example/api/google-evidence/callback
   ```

4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Restart the app.
6. Sign in as the worker.
7. Open Worker Settings.
8. Connect Google evidence.
9. Configure Gmail and Drive intervals.

Scopes requested:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/drive.metadata.readonly`

Gmail sending uses a separate `gmail.send` grant and a separate delivery configuration. Evidence intake remains read-only.

See [docs/GOOGLE_EVIDENCE_SETUP.md](docs/GOOGLE_EVIDENCE_SETUP.md).

## Trello Setup

Required backend values:

- `TRELLO_API_KEY`
- `TRELLO_TOKEN`

Optional login value:

- `TRELLO_LOGIN_API_KEY`

Optional webhook values:

- `PUBLIC_URL`
- `WEBHOOK_BASE_URL`
- `TRELLO_WEBHOOK_CALLBACK_URL`
- `TRELLO_WEBHOOK_SECRET`

If Trello login fails with an invalid return URL, the Trello app key's allowed origins must include the dashboard origin, not only the callback path.

If webhooks are not configured, the app can still use polling and manual sync where supported.

## Email Delivery

Outbound delivery is disabled by default.

Recommended provider:

- `EMAIL_PROVIDER=gmail_api`
- Connect owner Gmail with `gmail.send`.
- Set `NOTIFICATIONS_ENABLED=true`.

Optional fallbacks:

- Gmail SMTP with a Google App Password:
  - `EMAIL_PROVIDER=gmail_smtp`
  - `GMAIL_SMTP_USER`
  - `GMAIL_SMTP_APP_PASSWORD`
- SendGrid:
  - `EMAIL_PROVIDER=sendgrid`
  - `SENDGRID_FROM_EMAIL`
  - `SENDGRID_API_KEY`

Never store a normal Gmail password.

## OpenAI Setup

OpenAI is the production model provider for AI-backed features. Configure:

- `OPENAI_API_KEY`
- Optional `OPENAI_MODEL`
- Optional `OPENAI_REQUEST_TIMEOUT_MS`

The default request timeout is 120 seconds and is capped at five minutes. Do not add provider cascades that bypass the platform's configured AI provider.

## HAI Connector

The HAI connector is a read-only account bridge. It can expose bounded worker-control records to HAI through a revocable token. It cannot send reminders or mutate Trello, Gmail, Drive, or dashboard records.

Configure and rotate the token from admin Settings, then register a `worker-control` source in HAI.

## Browser Collector

The browser collector supports browser-tab hygiene evidence. It requires:

- The local browser extension to be loaded and approved by the user.
- A worker-scoped collector token from Worker Settings.
- A configured browser-tab policy.

The dashboard cannot silently install a Chrome extension. Browsers require the user to approve extension installation.

## Data Transfer And Recovery

Use the operator transfer utility to move compatible worker/operator history into a consolidated database:

```powershell
node scripts/operator-data-transfer.mjs export --out .local/operator-export.json
node scripts/operator-data-transfer.mjs import --in .local/operator-export.json --target $env:TARGET_DATABASE_URL --worker-id 42 --founder-id 1
node scripts/operator-data-transfer.mjs reconcile --in .local/operator-export.json --target $env:TARGET_DATABASE_URL
```

The utility does not print connection strings. It produces row-count, identity-map, and conflict reports.

Developer identity, worker assignment, authentication, scheduling, ATIS, and ARES data remain authoritative in the target database. Legacy worker rows are not attached by guessing.

## Verification

Useful local checks:

```powershell
npx.cmd pnpm@11.19.0 check
npx.cmd pnpm@11.19.0 test
npx.cmd pnpm@11.19.0 build
npx.cmd pnpm@11.19.0 test:e2e
npx.cmd pnpm@11.19.0 audit:prod
pnpm run db:verify-parity
pnpm run doctor
```

What these checks cover:

- TypeScript correctness.
- Unit and integration behavior.
- Production build.
- Browser route/auth boundary tests.
- Dependency audit for production dependencies.
- Schema parity between Drizzle expectations and database state.
- Local app health and configuration checks.

What they do not prove by themselves:

- A real Gmail account has consented.
- Google Drive has provider-live access.
- Trello webhooks are registered on every board.
- A public tunnel or production domain is stable.
- Outbound email is enabled.
- A human has approved an external message or Trello mutation.

## Common Operational Workflows

### First Owner Access

If an existing admin has no usable password:

1. Set `OWNER_BOOTSTRAP_OPEN_ID`.
2. Set a random `OWNER_BOOTSTRAP_TOKEN` with at least 24 characters.
3. Restart the app.
4. Use the login page's owner setup action once.
5. Remove both bootstrap variables.
6. Restart the app again.

### Replace A Worker

1. Keep the old worker profile for audit history.
2. Create an expiring worker invitation.
3. Let the replacement worker accept the invite.
4. Assign work to the new profile.
5. Connect the new worker's own Trello, Google, browser, and notification settings.
6. Do not bulk relabel the old worker's evidence as belonging to the new worker.

### Investigate A Compliance Problem

1. Open worker evidence and compliance history.
2. Review source-backed records first.
3. Check Trello update history, email processing, communication response rates, browser evidence, and tracked time.
4. If evidence is missing or low-confidence, ask the worker for an immediate explanation/update.
5. Record the outcome locally before considering any provider-side action.

### Run Maintenance

1. Open admin Settings.
2. Review Maintenance Center.
3. Check each job's interval, status, last run, and active state.
4. Run only the job needed.
5. Review failures before retrying.

## Troubleshooting

### Cannot Log In

- Confirm the user exists.
- Confirm the correct role is being used for the route.
- Confirm cookies are not blocked.
- For owner bootstrap, confirm the token is configured and not already used.
- For Trello login, confirm the Trello app allowed origins include the dashboard origin.

### API Calls Fail From The Browser

- Confirm the app is served by the unified Node server, not a static frontend.
- Check `/api/health/ready`.
- Check `LOCAL_ACCESS_ORIGINS`.
- Check cookie/session origin settings.
- Check reverse proxy and HTTPS configuration.

### Google Connect Fails

- Confirm Gmail and Drive APIs are enabled.
- Confirm the OAuth client is a Web application.
- Confirm the exact callback URL is allowlisted.
- Confirm `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are present in the runtime environment.
- Restart the app after changing secrets.

### Trello Webhook Health Fails

- Confirm a public HTTPS URL exists.
- Confirm `PUBLIC_URL`, `WEBHOOK_BASE_URL`, or `TRELLO_WEBHOOK_CALLBACK_URL` is set.
- Confirm the Trello token can access the board.
- Confirm callback signatures can be verified when `TRELLO_WEBHOOK_SECRET` is set.
- Use polling/manual sync while webhook setup is incomplete.

### Docker App Is Unhealthy

- Check the one-shot migration container.
- Check MySQL and Redis health.
- Confirm `.env` and `.env.db.local` are both available where Compose expects them.
- Confirm production-required secrets are present.
- Check `docker compose --env-file .env.db.local logs app migrate mysql redis`.

## Documentation Map

| Document | Purpose |
| --- | --- |
| [docs/CONSOLIDATION_LEDGER.md](docs/CONSOLIDATION_LEDGER.md) | Source ownership, preserved branches, imported capabilities |
| [docs/BRANCH_CONSOLIDATION.md](docs/BRANCH_CONSOLIDATION.md) | Branch disposition and cutover rules |
| [docs/PRODUCTION_CUTOVER.md](docs/PRODUCTION_CUTOVER.md) | Production runtime, secrets, cutover, rollback |
| [docs/OPERATOR_RUNBOOK.md](docs/OPERATOR_RUNBOOK.md) | Day-to-day operation and incident checks |
| [docs/GOOGLE_EVIDENCE_SETUP.md](docs/GOOGLE_EVIDENCE_SETUP.md) | Google OAuth setup for worker evidence |
| [docs/SECURITY.md](docs/SECURITY.md) | Security boundaries and operating rules |
| [docs/SYSTEM-ARCHITECTURE.md](docs/SYSTEM-ARCHITECTURE.md) | Broader architecture notes |
| [docs/TECHNICAL_AUDIT.md](docs/TECHNICAL_AUDIT.md) | Technical audit findings |
| [docs/UI_ACTION_AUDIT.md](docs/UI_ACTION_AUDIT.md) | UI/action surface audit |
| [docs/API_USAGE_AUDIT.md](docs/API_USAGE_AUDIT.md) | API consumption and efficiency audit |
| [docs/TASK_GRAPH.md](docs/TASK_GRAPH.md) | Task graph and relationships |
| [docs/ATIS-SPECIFICATION.md](docs/ATIS-SPECIFICATION.md) | ATIS implementation specification |
| [docs/ACCEPTANCE_TESTS.md](docs/ACCEPTANCE_TESTS.md) | Acceptance test scope |
| [docs/FINAL_VERIFICATION_REPORT.md](docs/FINAL_VERIFICATION_REPORT.md) | Verification evidence and unresolved provider gates |
| [docs/GOAL_COMPLETION_MATRIX.md](docs/GOAL_COMPLETION_MATRIX.md) | Goal completion state |
| [docs/CODEX_WORKLOG.md](docs/CODEX_WORKLOG.md) | Implementation worklog |
| [docs/CODEX_CHECKPOINTS.md](docs/CODEX_CHECKPOINTS.md) | Checkpoints and intermediate verification |

## Development Rules

- Preserve Kamal's recovered developer platform and migration lineage.
- Keep worker/operator features additive.
- Do not mount duplicate old portals inside the worker portal.
- Do not silently remove developer capabilities.
- Do not create provider actions that bypass approval gates.
- Do not commit credentials, backups, exports, `.env`, `.env.db.local`, or `.local`.
- Prefer focused tests for every behavior change.
- Keep provider-live acceptance separate from local, CI, and Docker verification.

## Current Recovery And Ownership Notes

The paid developer delivery is preserved as an immutable recovery point. The consolidation ledger records:

- Developer baseline: `5a04e6a`
- Kamal delivery tag: `delivery/kamal-platform-2026-07-28`
- Kamal delivery archive: `archive/kamal-platform-delivery-2026-07-28`
- Joyce overwrite backup: `backup/joyce-overwrite-2026-07-29`
- Joyce operator archive: `archive/joyce-operator-current-2026-07-29`

The forward product lives on `main` and should continue from the consolidated platform, not from the retired duplicate portal or the Joyce-only overwrite.

## License

This project is currently declared as MIT in `package.json`.
