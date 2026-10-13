# Hetzner Deployment

## Status

Hetzner is the intended production host, but this repository has not been
deployed to a Hetzner server yet. The published GHCR image is a release
artifact, not a running service. Do not point the production domain at the new
host until the verification and rollback gates below pass.

## Host Requirements

- A supported Linux Hetzner Cloud server with Docker Engine and Compose v2.
- A DNS name whose A/AAAA records are deliberately pointed at that server.
- A TLS reverse proxy on the host (for example, Caddy) forwarding HTTPS and
  WebSocket traffic to `127.0.0.1:3025`.
- Persistent, separately backed-up storage for MySQL and Redis data.
- Firewall policy allowing SSH only from trusted management addresses and
  public TCP 80/443; do not expose MySQL, Redis, or the application port.
- Monitoring for host capacity, container health, disk space, backups, and
  certificate renewal.

## Deployment Shape

Use `deployment/compose.hetzner.yml` and release images from GHCR rather than
building arbitrary source on the server. The release workflow publishes an
app image and a migration image (`<release>-migrate`) from the same commit,
with build provenance and an SBOM. Verify both image attestations and pin both
images to the same release tag or digest. Run exactly one app instance and one
one-shot migration job. The app is published only to host loopback port 3025;
MySQL and Redis have no host-published ports. A host-level TLS reverse proxy
forwards HTTPS and WebSocket traffic to the app.

After authenticating to GHCR, verify both release attestations before using
the images. Replace `vX.Y.Z` with the published release tag:

```sh
gh attestation verify oci://ghcr.io/robert-velhorst/006-autoreminder-virtualworkers:vX.Y.Z \
  --repo Robert-Velhorst/006-autoreminder-virtualworkers \
  --signer-workflow github.com/Robert-Velhorst/006-autoreminder-virtualworkers/.github/workflows/publish-container.yml
gh attestation verify oci://ghcr.io/robert-velhorst/006-autoreminder-virtualworkers:vX.Y.Z-migrate \
  --repo Robert-Velhorst/006-autoreminder-virtualworkers \
  --signer-workflow github.com/Robert-Velhorst/006-autoreminder-virtualworkers/.github/workflows/publish-container.yml
```

Before the first start:

1. Provision the server, restrict SSH, enable the host firewall, and apply OS
   security updates.
2. Create a deployment directory owned by a dedicated, non-root service user.
3. Copy `deployment/.env.hetzner.example` to the ignored
   `deployment/.env.hetzner` and `deployment/.env.app.example` to the ignored
   `deployment/.env.app`; replace every placeholder. The first file contains
   Compose/runtime settings, while the second contains app secrets. Never put
   secrets in Git, shell history, image build arguments, or deployment logs.
   Set `APP_IMAGE` and `MIGRATION_IMAGE` to the same release with `-migrate`
   appended to the latter. Set `DATABASE_URL` to host `mysql` and `REDIS_URL`
   to host `redis`; URL-encode reserved characters in credentials.
4. Configure `PUBLIC_URL` and `WEBHOOK_BASE_URL` to the final HTTPS origin.
   Configure the Trello webhook callback to the corresponding application
   endpoint only after HTTPS is live.
5. Back up and inspect the source database. Rehearse migration/import and
   reconciliation against a disposable test database before production
   cutover.
6. From the repository root, validate the Compose file with
   `docker compose --env-file deployment/.env.hetzner -f deployment/compose.hetzner.yml config -q`, then start it with
   `docker compose --env-file deployment/.env.hetzner -f deployment/compose.hetzner.yml pull app migrate` and
   `docker compose --env-file deployment/.env.hetzner -f deployment/compose.hetzner.yml up -d`.
   This starts one app container, private MySQL/Redis containers, and one
   one-shot migration container. Verify `/api/health`, login,
   worker/admin role separation, WebSockets, scheduled jobs, and enabled
   provider integrations.
7. Confirm backups can be restored. Keep the previous host and database
   snapshot available until the rollback window ends.
8. Move DNS only after the checks pass. Monitor logs, health, disk, and
   integrations after cutover.

## Rollback

Keep the previous host and deployment artifacts untouched until the new
service has passed its public acceptance period. If the app or integrations
fail, first freeze writes and keep the Hetzner database as the authoritative
copy. Roll back the app image only when its schema is backward-compatible with
the current database; never restore a pre-cutover database snapshot over new
production writes. If schema rollback is unavoidable, preserve a fresh
Hetzner backup and reconcile every post-cutover write before serving traffic
from another database. Do not delete or rewrite migration history.

## Retirement of Previous Hosting

Once the Hetzner endpoint passes the public acceptance and rollback gates,
retire only the previous hosting resources that belong to this dashboard.
Keep account-wide settings, unrelated projects, and unrelated deployment
history unchanged. The repository's old Vercel deployment records and empty
GitHub deployment environments have been removed; the repository-scoped
Vercel GitHub App authorization still requires GitHub reauthentication before
it can be revoked.
