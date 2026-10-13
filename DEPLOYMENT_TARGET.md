# Production deployment target

Hetzner is the target for production deployment. New production deployments must be prepared for Hetzner. Do not use Vercel or ngrok for production.

Before deploying or retiring any existing service, verify the running application, MySQL and Redis data, secrets, security controls, backups and restore procedure, rollback path, DNS, TLS, scheduled work, and external integrations. Do not claim migration or cutover until those checks pass.

Use the repository's Docker Compose deployment and `docs/PRODUCTION_CUTOVER.md` as the operational source of truth. Keep database credentials, integration tokens, and private operational data out of this file and source control.

Local development and test tooling may remain when needed, but it must not be presented as production hosting.
