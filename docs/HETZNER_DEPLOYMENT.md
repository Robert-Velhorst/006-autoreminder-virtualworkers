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

Use the release image from GHCR rather than building arbitrary source on the
server. Pin the app image to a release tag or digest after verifying its
provenance. Run one app instance and one migration job. The existing Compose
file builds locally and includes MySQL, Redis, and optional ngrok; adapt it for
the host by using the verified GHCR image and a host-level TLS reverse proxy.
Do not expose Compose service ports beyond loopback or the private Compose
network.

Before the first start:

1. Provision the server, restrict SSH, enable the host firewall, and apply OS
   security updates.
2. Create a deployment directory owned by a dedicated, non-root service user.
3. Provide `.env` and `.env.db.local` through a secret manager or root/service
   protected files with restrictive permissions. Never place secrets in Git,
   shell history, image build arguments, or deployment logs.
4. Configure `PUBLIC_URL` and `WEBHOOK_BASE_URL` to the final HTTPS origin.
   Configure the Trello webhook callback to the corresponding application
   endpoint only after HTTPS is live.
5. Back up and inspect the source database. Rehearse the migration/import and
   reconciliation against a separate test database before production cutover.
6. Start MySQL, Redis, migrations, and the app; verify `/api/health`, login,
   worker/admin role separation, WebSockets, scheduled jobs, and enabled
   provider integrations.
7. Confirm backups can be restored. Keep the previous host and database
   snapshot available until the rollback window ends.
8. Move DNS only after the checks pass. Monitor logs, health, disk, and
   integrations after cutover.

## Rollback

Keep the previous host and deployment artifacts untouched until the new
service has passed its public acceptance period. If the app, integrations,
database, or WebSocket path fails, restore DNS to the previous endpoint and
the corresponding compatible application/database snapshot. Do not roll back
schema changes by deleting or rewriting migration history.

## Retirement of Previous Hosting

Once the Hetzner endpoint passes the public acceptance and rollback gates,
disable only the old Vercel Git integrations and projects belonging to this
dashboard. Keep account-wide settings and unrelated projects unchanged.
Historical GitHub deployment records are audit history and should remain.
