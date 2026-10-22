# Restricted VA Deployment Connection

## Authority

The owner confirmed General-Server `159.69.55.178` and intended origin
`https://006-va-dashboard.noodzakelijkonline.de` on 22 October 2026. This does not
prove a running application or configured DNS/TLS. The coordinator reported
NXDOMAIN, Hetzner nameservers and candidate port 3025 free; recheck before use.

The dedicated key may stage Compose and request deployment of an image digest
from the VA GHCR repository. It cannot upload code, run a shell, read `.env`,
use SCP/SFTP, forward sockets, allocate a PTY or directly invoke Docker/sudo.
Deployment authority still includes replacing application code and therefore
access to that application's secrets through its container. The server checks
the repository/digest shape, not release provenance independently: the existing
protected-main, environment-review and attestation workflow gates remain required.

## Fixed Paths

| Path | Owner / mode | Purpose |
| --- | --- | --- |
| `/var/empty/va-dashboard-deploy` | root / 0755 | Non-writable account home |
| `/etc/ssh/authorized_keys/va-dashboard-deploy` | root / 0644 | Dedicated PUBLIC key and restrictions |
| `/usr/local/lib/va-dashboard-deploy` | root / 0755 | Installed trusted assets |
| `ssh_gate.py`, `root-helper` inside it | root / 0755 | Identical installed Python source; separate fixed entrypoints |
| `deploy.sh`, `docker-compose.yml`, `installed-sha256.json` inside it | root / 0700, 0600, 0600 | Pinned shell/Compose source and hashes |
| `/var/lib/va-dashboard-deploy` | va-dashboard-deploy / 0700 | Only account-owned deployment directory |
| `compose.candidate` inside it | va-dashboard-deploy / 0600 | Atomic upload, 1..65536 bytes |
| `/opt/va-dashboard` | root / 0700 | Runtime and rollback files |
| `/opt/va-dashboard/.env` | root / 0600 | Separately provisioned runtime configuration |

The forced command is `/usr/bin/python3 -I /usr/local/lib/va-dashboard-deploy/ssh_gate.py`.
The only sudoers executable is `/usr/local/lib/va-dashboard-deploy/root-helper`;
its argument parser accepts only `status` or `deploy FULL_DIGEST`. It does not
execute stdin. No `sudo bash`, `sudo docker`, Docker-group membership, or
user-writable authorized-keys path is granted. No private key is an installer input.

## Administrator Installation

Keep the existing verified administrator SSH session open throughout bootstrap.
Do not replace or reuse its key. Transfer an independently reviewed source tree
(including `deployment/hetzner/generalserver.compose.yml`) to a root-controlled directory, for example
`/root/va-deployment-source`. Transfer only the dedicated `.pub` file to
`/root/va_dashboard_deploy_ed25519.pub`. Verify its fingerprint privately against
the generated public key. Do not copy a private key into the repository or host.

On the host, as administrator:

```sh
sudo /bin/bash /root/va-deployment-source/deployment/hetzner/install-ssh-gate.sh \
  /root/va_dashboard_deploy_ed25519.pub generalserver
```

The installer accepts one Ed25519 public-key file and one fixed target name:
`default` selects root `docker-compose.yml`; `generalserver` selects
`deployment/hetzner/generalserver.compose.yml`. No arbitrary source path is accepted.
The selected file is checked with the same source/ancestor ownership, symlink and
LF checks, then installed as `docker-compose.yml`. The manifest retains exactly
four entries: `ssh_gate.py`, `root-helper`, `deploy.sh`, `docker-compose.yml`.
The installer preserves exact
LF source bytes, installs root-owned copies and computes their root-only manifest.
Reused accounts must have exactly `/bin/sh`, only their dedicated group and the
exact expected home. An existing home and every ancestor must be root-owned and
non-writable by group/others; the home must be empty. Startup files, `.ssh` content,
symlinks or an unverified missing home on a reused account fail before changes.
The installer never silently removes startup files or repairs an existing account.
It creates the isolated account/home/staging/runtime directories, installs the
exact sudoers rule and a `Match User` SSH configuration, and runs `visudo -cf`,
`sshd -t` and effective-configuration checks. It does not reload sshd, install
Docker, configure DNS, create/read `.env`, migrate data or deploy the app.
After the checks pass, reload the host's actual SSH service (Ubuntu normally
`sudo systemctl reload ssh`), retaining the original session and recovery access.

Runtime configuration is a separate administrator operation. Provision the
app-specific PostgreSQL role/database and verified TLS, then securely install
the root-only `.env`; never print its values into CI logs. Set the app's public
origin settings to the confirmed HTTPS origin and configure the host reverse
proxy and DNS separately. `VA_PUBLIC_ORIGIN` is GitHub metadata, not automatic
host `.env` provisioning. Verify available memory and port 3025 before starting.

For future source upgrades, review and reinstall the trusted assets/manifest as
administrator. Do not relax the byte-equality check to accept arbitrary Compose.
The unmodified installed `deploy.sh` retains its app-only lock, health and rollback
behavior. The helper adds a second lock covering candidate validation/copy through
the entire deployment. Uploaded bytes are read once, size-bounded, checked for
ownership/links and hash equality, then copied atomically as root before execution.

## Connection Proof (No Deployment)

From the trusted workstation, use the dedicated key and separately verified
known-hosts file. Replace only these local path placeholders; never disable host
key checking or use unauthenticated `ssh-keyscan` as trust establishment.

```sh
ssh -T -i /path/to/va_dashboard_deploy_ed25519 -o IdentitiesOnly=yes \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/path/to/va_known_hosts \
  va-dashboard-deploy@159.69.55.178 va-dashboard-status
```

Expected JSON includes `gate: ready`, `runtime_env_ready: false` until secrets are
installed, `application: not_checked`, and `public_dns_tls: not_checked`. This is
proof of the restricted connection only, not a live VA application.

Using the same options, each of the following must fail without side effects:
an empty command/interactive shell, `id`, `bash`, `sudo id`, `internal-sftp`,
`scp -t /tmp/x`, `va-dashboard-status; id`, and a deploy request using `:latest`
or another repository. A PTY request must be refused. Inspect permissions and
`id va-dashboard-deploy` as administrator; it must have only its own group.

## Reviewed Release Deployment

The four GitHub `production` SSH secrets use the dedicated account/key and pinned
known-hosts data. Never use the administrator key as `HETZNER_SSH_PRIVATE_KEY`.
The workflow checks out the validated `release_commit` SHA, verifies a stable
release and its attestation, then stages that commit's exact GeneralServer file:

```sh
ssh [verified-options] va-dashboard-deploy@159.69.55.178 \
  va-dashboard-stage-compose < deployment/hetzner/generalserver.compose.yml
ssh [verified-options] va-dashboard-deploy@159.69.55.178 \
  'va-dashboard-deploy ghcr.io/robert-velhorst/006-autoreminder-virtualworkers@sha256:FULL_64_HEX_DIGEST' < /dev/null
```

The second command changes the application and requires release/deployment
approval. The placeholder above is intentionally not a runnable digest. A
successful helper exit confirms only the installed script's local health checks.
Timeout/failure is unconfirmed; inspect current runtime/rollback as administrator
before any new deployment. Public HTTPS, WebSockets, authenticated workflows,
provider acceptance and data/backup/restore checks remain separate.

## GeneralServer Private Route

See [GeneralServer preparation](GENERALSERVER.md). This target cannot deploy until
the administrator has separately approved and provisioned the owned network,
VA-only INPUT protection and interface-bound PostgreSQL proxy. After canonical
hash equality but before candidate copy or deployment, the root helper inspects
network metadata/membership, socket state/binding, firewall unit state, exact
dedicated-chain order/content and the first/unique INPUT hook. Bounded read-only
`iptables -S` output is parsed as canonical fixed tokens; extra/duplicate rules
in the dedicated chain or a preceding bypass rule refuse deployment.
Missing/mismatched prerequisites refuse deployment;
they are never created or repaired by the gate. A successful preflight is not a
TLS/query, concurrent-rule-change, Caddy or public-acceptance proof. `status` remains
non-invasive and does not perform this deployment preflight.

## Tests

`python3 -B -I deployment/hetzner/ssh_gate_test.py` uses only the standard library;
it never invokes real sudo, Docker or SSH. Linux runs real temporary-file security
cases; Windows skips those POSIX-specific cases. Fixed-command, digest, hash,
clean-environment and dispatch tests use injected boundaries. CI runs this command
and installer Bash syntax validation. Neither unit tests nor source review prove
the live account, sshd configuration or host identity; record actual positive and
negative connection results after installation.
