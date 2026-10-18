# Production Deployment Target

Hetzner is the production hosting target. New production deployments must not
use unapproved serverless hosting or public-tunnel services.

The application runtime uses PostgreSQL. The owner intends to use one shared,
open-source PostgreSQL service for their GitHub tools; the VA Dashboard
production database has not yet been provisioned. Share the service, not
application data or credentials: each app must have its own database and
least-privilege role. The exact service topology and private network placement
remain to be provisioned and verified. The repository's MySQL transfer utility
is conditional and must not be used unless a real VA Dashboard data source is
identified and an import is explicitly planned. Redis is optional and external;
verify its data only if Redis is configured or used by the current deployment.

Before deploying or retiring infrastructure, verify the actual running
application, PostgreSQL backup and restore, secrets, security controls,
restore procedure, rollback path, DNS, TLS, scheduled work, WebSockets, and
enabled external integrations. Do not claim migration or cutover until the
checks in [Production Cutover](docs/PRODUCTION_CUTOVER.md) pass against the
target environment.

Use the repository's Docker Compose deployment and cutover checklist as the
operational source of truth. Keep database credentials, integration tokens,
and private operational data out of this file and source control.
