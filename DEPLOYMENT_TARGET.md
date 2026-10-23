# Production Deployment Target

Hetzner is the production hosting target. New production deployments must not
use unapproved serverless hosting or public-tunnel services.

The owner confirmed General-Server (`159.69.55.178`) and the public origin
`https://006-va-dashboard.noodzakelijkonline.de`. On 23 October 2026 the stable
v1.0.0 release was deployed there through the reviewed GitHub workflow. The
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

- Release v1.0.0 targets commit `5034569911de03bf6ce55b73d3c9fa877c017b13`.
  Exact-head quality and CodeQL checks passed before merge. Release publication
  run [39944380798](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/39944380798), attempt 2, passed image scanning, configured PostgreSQL
  runtime acceptance and provenance attestation.
- The published immutable image digest is
  `sha256:79ba7e354129f7afc0c1e215b12cf53de14da610c4268901ec4017f369b8ed8a`.
  The scan reported no vulnerabilities under its recorded scanner/database;
  this is a dated result, not a guarantee against future findings.
- Deployment run [39953635968](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/actions/runs/39953635968) completed after the owner's registered production
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

## Not Yet Accepted

- Trello sign-in reaches an `Invalid return_url` response because the new origin
  is absent from the existing app's Allowed origins. A narrowly scoped owner
  approval is pending; no key, secret or scope was changed. An authenticated
  owner/worker walkthrough is not yet accepted.
- Gmail/Drive callbacks, browser collector pairing and the private Codex
  subscription connection require real production acceptance. Paid API fallback
  is not enabled. Retained credentials and mocks are not provider acceptance.
- Financial functions and database writes remain held pending currency-aware
  historical display and separately confirmed future terms. Background/outbound
  jobs are off; AI management remains shadow-only. These holds are not proof of
  completed functionality.
- Current repository security findings require individual triage/remediation;
  passing PR checks alone do not mean the whole repository is alert-free.
  Historical credential alerts have not been declared revoked or dismissed.
- Restore-tested off-server backups exist, but a recurring consolidated
  off-server database backup schedule and current provider backup coverage have
  not yet been verified. Do not provision new paid storage or remove retained
  backups without the owner's approval.
- Monitoring, recovery after reboot and the operational shadow trial remain
  separate gates. No disruptive shared-server reboot test was performed.

This checkpoint proves a deployed authenticated shell and tested runtime
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
