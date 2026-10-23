# Production Deployment Target

Hetzner is the production hosting target. New production deployments must not
use unapproved serverless hosting or public-tunnel services.

The owner confirmed General-Server (`159.69.55.178`) and the public origin
`https://006-va-dashboard.noodzakelijkonline.de`. On 23 October 2026 the stable
v1.0.1 release was deployed there through the reviewed GitHub workflow. The
earlier discovery state (NXDOMAIN, no VA database or application) is superseded
by the verified checkpoint below. Use the dedicated restricted
SSH connection described in [the installation guide](deployment/hetzner/SSH_GATE.md),
not the existing administrator key, for workflow deployments.

The application runtime uses PostgreSQL. The owner intends to use one shared,
open-source PostgreSQL service for their GitHub tools. The VA production database
and separate owner/runtime roles now exist in the shared PostgreSQL 17 service.
Share the service, not application data or credentials: each app has its own
database and least-privilege role. The VA bridge-bound TCP proxy requires
verified TLS and has a source/interface-specific firewall boundary. The
restricted audit schema is not accessible to the application role. The
repository's MySQL transfer utility remains an explicit operator migration tool,
not a runtime dependency or permission to repeat a transfer. Redis is optional and external;
verify its data only if Redis is configured or used by the current deployment.

## Verified Deployment Checkpoint: 23 October 2026

- Release v1.0.1 targets commit `e19b53c8d724eeaebedf774efaf471cfb899e84d`.
  PR #153 passed exact-head checks and merged with an identical source tree.
  Post-merge quality run [39964023338](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/39964023338)
  and CodeQL run [39964022908](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/39964022908) succeeded on that commit before publication.
  Release publication run [39967830416](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/39967830416) passed image scanning, configured PostgreSQL
  runtime acceptance and provenance attestation.
- The published immutable image digest is
  `sha256:30990b106ca3b22ee7c1353fd1c3a826a2804f6fdc064a8fb25614bb108fd7a3`.
  The scan reported no vulnerabilities under its recorded scanner/database;
  this is a dated result, not a guarantee against future findings.
- Deployment run [39970379495](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/39970379495) completed after the owner's registered production
  review. It used the restricted SSH gate and verified release provenance.
- Exactly one VA app container runs on loopback port 3025. Public HTTPS health
  reports healthy/database connected. HTTP redirects to HTTPS. The VA-only
  Unix-socket upstream was added by validated graceful Caddy reload; existing
  site configuration bytes were preserved and the shared container not restarted.
- Anonymous worker access returns 401. The real public WebSocket route rejects
  an invalid authentication token. The public browser renders the login page.
- The actual legacy source was migrated and a native backup restored separately.
  Complete table-value fingerprints, reserved identifiers, private reconciliation
  originals and independently decoded manager history were verified. Raw records,
  credentials, private audit material and backups remain outside Git.
- No server expansion, shared database restart or source/backup deletion occurred.
- Existing provider disk backups are enabled; three available daily copies were
  observed, latest `2026-10-22T18:48:21Z`. PostgreSQL data and WAL are on the
  backed-up root filesystem, with no external tablespaces. This establishes
  storage scope, not successful recovery or database consistency in a particular
  provider image. No backup was created, deleted or converted during inspection.

## Not Yet Accepted

- Trello sign-in reaches an `Invalid return_url` response because the new origin
  is absent from the existing app's Allowed origins. A narrowly scoped owner
  approval is pending; no key, secret or scope was changed. An authenticated
  owner/worker walkthrough is not yet accepted.
- Gmail/Drive callbacks, browser collector pairing and the private Codex
  subscription connection require real production acceptance. Paid API fallback
  is not enabled. Retained credentials and mocks are not provider acceptance.
- Financial functions and financial writes remain held pending currency-aware
  historical display and separately confirmed future terms. Background/outbound
  jobs are off; AI management remains shadow-only. These holds are not proof of
  completed functionality.
- The default-branch CodeQL inventory was empty after the v1.0.1 analysis.
  This is a dated code-scanning result, not evidence that all security concerns
  are resolved. Historical secret-scanning alerts remain open; their credentials
  have not been declared revoked or their alerts dismissed.
- Restore-tested off-server backups exist, but a recurring consolidated
  off-server database backup schedule and recovery from the provider's disk
  images have not yet been verified. Do not provision new paid storage or remove retained
  backups without the owner's approval.
- Monitoring, recovery after reboot and the operational shadow trial remain
  separate gates. No disruptive shared-server reboot test was performed.

This checkpoint proves a deployed login-protected shell and tested runtime
boundaries, not completion of all production workflows. See
[GeneralServer contracts](deployment/hetzner/GENERALSERVER.md) for infrastructure
boundaries and [Production Cutover](docs/PRODUCTION_CUTOVER.md) for acceptance.

Before deploying or retiring infrastructure, verify the actual running
application, PostgreSQL backup and restore, secrets, security controls,
restore procedure, rollback path, DNS, TLS, scheduled work, WebSockets, and
enabled external integrations. Do not claim migration or cutover until the
checks in [Production Cutover](docs/PRODUCTION_CUTOVER.md) pass against the
target environment.

Use the repository's Docker Compose deployment and cutover checklist as the
operational source of truth. Keep database credentials, integration tokens,
and private operational data out of this file and source control.

Inventory any legacy production hosting or public-tunnel services and migrate them to the verified Hetzner target before retiring them. Preserve local development and test tooling when still needed.
