# Production Deployment Target

Hetzner is the production hosting target. New production deployments must not
use Vercel or ngrok.

The application runtime uses PostgreSQL. MySQL is a legacy data source that
must remain available, with its backups, until the migration and rollback
window are accepted. Redis is optional and external; verify its data only if
Redis is configured or used by the current deployment.

Before deploying or retiring infrastructure, verify the actual running
application, source and target database backups, secrets, security controls,
restore procedure, rollback path, DNS, TLS, scheduled work, WebSockets, and
enabled external integrations. Do not claim migration or cutover until the
checks in [Production Cutover](docs/PRODUCTION_CUTOVER.md) pass against the
target environment.

Use the repository's Docker Compose deployment and cutover checklist as the
operational source of truth. Keep database credentials, integration tokens,
and private operational data out of this file and source control.
