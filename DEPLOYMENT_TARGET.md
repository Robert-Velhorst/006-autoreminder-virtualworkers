# Production Deployment Target

Hetzner is the production hosting target. New production deployments must not
use Vercel or ngrok.

The application runtime uses PostgreSQL. The actual production source database
has not been confirmed. The repository retains a MySQL transfer utility, but
that does not establish MySQL as the live source. Identify and back up the
confirmed source, and retain it with its backups until migration and rollback
are accepted. Redis is optional and external; verify its data only if Redis is
configured or used by the current deployment.

Before deploying or retiring infrastructure, verify the actual running
application, source and target database backups, secrets, security controls,
restore procedure, rollback path, DNS, TLS, scheduled work, WebSockets, and
enabled external integrations. Do not claim migration or cutover until the
checks in [Production Cutover](docs/PRODUCTION_CUTOVER.md) pass against the
target environment.

Use the repository's Docker Compose deployment and cutover checklist as the
operational source of truth. Keep database credentials, integration tokens,
and private operational data out of this file and source control.
