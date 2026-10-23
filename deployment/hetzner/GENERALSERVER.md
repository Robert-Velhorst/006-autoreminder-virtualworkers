# GeneralServer: Inactive Preparation Only

These source files are not permission to activate anything. The parent owns HBA,
firewall, network allocation, Caddy, credentials, source reconciliation and migration.
No installer creates networks, changes firewall rules, installs/enables these units,
changes PostgreSQL, or edits Caddy. Do not run deployment until the checks below pass.

## Target Contract

`generalserver.compose.yml` becomes the root-installed canonical `docker-compose.yml`
only through the installer's fixed `generalserver` target. Do not merge it with
the generic Compose or render it using real secrets in logs. Its paths are relative
to `/opt/va-dashboard` after installation, NOT to the source checkout.

One `app` container uses `172.30.6.2/29` on the external network
`va_dashboard_private`, with HTTP published only on `127.0.0.1:3025`.
Docker rotates this app's logs at 10 MB per file, retaining at most three files;
this does not change other applications' logs or historical database records.
The network is root-administrator managed via Docker, not a Unix-owned file.
Its ownership label is a configuration assertion, not independent authorization:

- Driver `bridge`, scope `local`, IPv6 disabled, external egress retained.
- IPAM exactly `172.30.6.0/29`, gateway `172.30.6.1`.
- Bridge option `com.docker.network.bridge.name=br-va-db`.
- Label `io.va-dashboard.owner=va-dashboard`.
- No members, or only the existing Compose project `va-dashboard`, service `app`,
  at `172.30.6.2/29`. No other application may join; no Docker socket is mounted.

### Dedicated Codex Transport

The prepared source configuration adds supplementary GID 16006 and exactly one
transport mount: `/srv/va-dashboard-bridge/queue` to `/app/codex-queue`, with
`create_host_path: false`. It never mounts the bridge workspace, authentication
home, instructions or private schemas. The existing PostgreSQL CA mount remains
read-only. The app remains its image's non-root UID 1001; do not change it to
the bridge account or an unrelated host identity.

Before deploying this canonical configuration, prepare the dedicated
`va-dashboard-codex` account at UID/GID 16006 with nologin shell, private workspace
mode 0700, and all seven transport directories at mode 2770. The root gate
verifies these exact metadata constraints before app replacement. See
[Private Codex Subscription Bridge](../../docs/CODEX_SUBSCRIPTION_BRIDGE.md)
for the directory list and acceptance boundaries. The preparation script
refuses existing targets and is not an updater.

Sharing defaults off. Do not set `APTLSS_CODEX_SHARED_QUEUE=true` or select the
mounted queue in private runtime configuration until matching accepted bridge
bundles are installed and the cross-UID test passes. A mount does not enable
the pilot or prove account/model acceptance. Root-installed gate assets and
the running container are not updated by editing these source files.

Parent reported on 22 October 2026: existing Docker networks use 172.17/18/19/20,
localhost HBA uses SCRAM (Unix local uses peer), and UFW is inactive with INPUT
ACCEPT. These are parent observations, not verification by these source tests.
Before allocation, recheck all Docker networks, host/VPN routes and addresses;
absence from this reported list is not proof that the /29 is unused.

## PostgreSQL And Firewall Templates

`systemd/va-dashboard-pg.socket` listens only on `172.30.6.1:15433` and is bound
to `br-va-db`. The service transparently forwards to `127.0.0.1:5432`, capped at
four connections; the app pool defaults to two. Do not enable `PrivateNetwork`:
the proxy must reach host loopback. Verify the installed proxy executable path
and supported options before installing root-owned units (root:root, 0644).

The PG socket deliberately disables normal socket startup dependencies because
it must start after Docker; ordinary `Before=sockets.target` plus `After=docker`
can cause a boot ordering cycle. It binds to the bridge device and fails if the
address/device is missing. Parent must verify boot and bridge-recreation recovery;
`After=docker.service` alone does not prove that the external network exists.

`va-dashboard-pg-firewall.service` is an INACTIVE iptables template, subject to
parent review of the actual nft/legacy backend, firewall manager and INPUT order.
Its only changes are creation of dedicated chain `VA_DASHBOARD_PG`, an allow for
interface `br-va-db` AND source `172.30.6.2/32` AND destination
`172.30.6.1/32:15433`, a terminal DROP, and an INPUT hook for that destination/port.
It inserts the hook first so broad existing ACCEPT rules cannot bypass it.
It never flushes INPUT, FORWARD, Docker chains or another application's rules.

Persistence is the scoped oneshot unit, not a global firewall ruleset save/restore.
It is intentionally not a reconciler: an existing chain causes startup to fail,
not overwrite unknown rules. Partial failure before the final INPUT hook leaves
an unhooked chain and prevents dependent PG socket startup. Stop the PG socket
before administrator recovery or firewall-unit restart. Review any leftover chain
and remove ONLY its exact hook/owned rules after confirming ownership. Stopping
the firewall unit does not remove protection; no permissive ExecStop is provided.
Do not combine this template with an existing persistence mechanism blindly.

The gate performs read-only preflight after trusted Compose equality: exact
network configuration, VA-only member labels/address, active PG socket with exact
listen/interface properties and active firewall unit. Read-only `iptables -S`
inspection requires exactly the dedicated chain declaration, canonical .2/interface
allow, then DROP, with no extra or duplicate rules. INPUT must have its expected
ACCEPT policy followed immediately by the exact VA hook, with no other reference
to the VA chain. Unrelated INPUT rules may follow the hook. Fixed-token parsing
expects iptables' canonical `-s`, `-d`, `-i`, `-p tcp -m tcp` serialization; alternate
spellings/order fail closed rather than broadening accepted rules. Each command's
stdout is capped at 64 KiB while reading, stderr is discarded, and its overall
deadline is ten seconds; command failures, overflow and malformed output refuse
deployment before app changes. This checks the inspected rules/order, not an
atomic firewall snapshot or reachability proof: parent must still verify actual
traffic denial and avoid concurrent rule changes during preflight/deployment.
No network/firewall/proxy repair, automatic activation or secret printing occurs.

## Verified TLS And Runtime Configuration

The administrator privately provides `/opt/va-dashboard/.env` (root:root, 0600).
The DATABASE_URL must name `noodzakelijkonline-01`, port `15433`, the VA database
and least-privilege role, with `sslmode=verify-full` and
`sslrootcert=/run/va-postgres-root.crt`. URL-encode credentials; never print them.
Compose maps that hostname to `172.30.6.1` and bind-mounts only the PUBLIC
`/etc/ssl/certs/ssl-cert-snakeoil.pem` file read-only, without auto-creating a
missing source path. No private key, certificate directory or root env is mounted.
Confirm the public certificate is readable by app UID 1001, unexpired, matches
the expected fingerprint/SAN and is trusted by the actual image's pg driver.
Parent handles certificate rotation; file bind mounts can retain an old inode
after atomic replacement, requiring VA-only container recreation.

The proxy does not restrict database/user names or enforce TLS itself. PostgreSQL
sees loopback connections, so parent must preserve SCRAM and least-privilege
authorization for VA and other apps. Do not widen listen_addresses, open 5432,
restart PostgreSQL, disable verification, or touch the existing private key.

## Existing Caddy Volume: HTTP Socket Only

`va-dashboard-http.socket` creates only
`/var/lib/docker/volumes/sharet_caddy-data/_data/va-dashboard-http.sock`;
`va-dashboard-http.service` forwards it to `127.0.0.1:3025`. These are root-owned
templates, not installed units. Confirm the existing volume/directory and its
mount into Caddy at `/data`; do not create a replacement volume/directory.
Default socket permissions are root:root 0600. Parent must verify Caddy's actual
host-mapped UID/GID; if not root, approve a narrow socket group/mode adjustment,
never a broad directory chmod. Do not touch the MemoryLayer socket/file/key,
certificate storage, volume contents, or Caddy container/deployment definition.

Only after VA's application/database health and socket reachability succeed,
parent may stage the new site using this upstream:

```caddyfile
006-va-dashboard.noodzakelijkonline.de {
    reverse_proxy unix//data/va-dashboard-http.sock
}
```

Parent validates the complete candidate Caddy configuration, atomically promotes
it and reloads the existing Caddy instance. Preserve trusted-proxy handling:
this extra proxy hop must not turn arbitrary client forwarding headers into trust.
Public DNS/TLS, authenticated flows and WebSockets remain separate acceptance.

## Required Acceptance And Rollback

Before activation: verify root-owned source/unit paths, subnet ownership, INPUT
ordering/only-owned chain rules, no public/wildcard/IPv6 PG proxy listener, no
changed PostgreSQL listener, and existing apps/Caddy upstreams still healthy.
Then prove actual app-container TLS/query success, wrong-hostname/untrusted-CA
failure, denial from another bridge and external ingress, and reboot recovery.
Missing proxy or wrong/missing/foreign network must refuse deployment before
candidate promotion; generic target deployments retain their existing behavior.

Rollback only VA app/image/Compose, its two proxy sockets/services and its exact
firewall hook/owned chain, following parent approval. Do not flush global rules,
restart Docker/PG, remove the shared Caddy volume, or prune networks. The external
network survives Compose operations. App rollback is not a database migration undo.

## Local Tests (No Containers)

Run `python3 -B -I deployment/hetzner/ssh_gate_test.py`, the release-source and
deployment Node contract suites, and `bash -n` for both deployment shell scripts.
Tests inject subprocess boundaries; they never inspect a real daemon, query a
database, activate systemd/firewall, or access runtime secrets. POSIX filesystem
and Bash integration cases require Linux; Windows skips them. Host unit validation
and real runtime acceptance remain parent responsibilities.
