# Hetzner Deployment Connection Acceptance - 22 October 2026

## Confirmed Scope

The owner confirmed General-Server (`159.69.55.178`) and the intended public
origin `https://006-va-dashboard.noodzakelijkonline.de`. The SSH connection below
is accepted; the application deployment and public origin are **not** accepted.

The existing independently pinned server identity was verified before bootstrap.
A new Ed25519 key was generated specifically for VA deployment. Its private part
remains outside the repository and was installed only as an encrypted GitHub
`production` environment secret, not copied to the server.

## Installed and Verified

- Dedicated account `va-dashboard-deploy`, with only its own group, an empty
  root-owned home, public-key-only authentication, forced command, no PTY or
  forwarding, and no Docker-group access.
- Root-owned trusted deployment assets and manifest under
  `/usr/local/lib/va-dashboard-deploy`; the sole sudo entry is its fixed helper.
- Root-only `/opt/va-dashboard` and separate restricted staging directory.
- GitHub production secrets `HETZNER_SSH_HOST`, `HETZNER_SSH_USER`,
  `HETZNER_SSH_PRIVATE_KEY`, and `HETZNER_SSH_KNOWN_HOSTS`; metadata variable
  `VA_PUBLIC_ORIGIN` records the intended origin, not runtime provisioning.
- Existing administrator SSH access, SSH service, PostgreSQL service, and the
  existing five containers remained available after the SSH configuration reload.

The workstation and uploaded source hashes matched before installation:

| Asset | SHA-256 |
| --- | --- |
| `ssh_gate.py` / installed root helper | `16ccb4679c65b09ac35f83dc2e3580d8db13d9dabafc51df54fa54e6993a4a78` |
| `install-ssh-gate.sh` | `9f862d8eef7fe0bbb0a03b9203d04a11487d16798a68b27d14f0f90757e8ee5f` |
| `deploy.sh` | `cb2ada97c84205f253a7ec856495610908fe63650609099a1b273fffaeae93bc` |
| Canonical `docker-compose.yml` | `3507d34328e08dfcfbf305378a5e62226d48281e2b2ed1bde6cf39b7556e51be` |

## Actual Checks

- Python gate suite on General-Server: **18 passed, zero skipped**. The initial
  test upload lacked workflow fixtures; the complete fixture upload passed.
- Same suite on Windows: **15 passed, three POSIX-specific skips**.
- Existing deployment/release/image-workflow Node contracts: **31 passed, three
  Windows integration skips**. These are not full application regression results.
- Installer and existing deploy script passed Bash syntax validation; sudoers
  and effective SSH configuration passed host validation.
- Dedicated-key `va-dashboard-status` succeeded and returned `gate: ready`,
  `runtime_env_ready: false`, `application: not_checked`, and
  `public_dns_tls: not_checked`.
- Exact-byte canonical Compose upload succeeded; its staged hash and private
  ownership/mode were verified.
- Ten live requests were refused: empty shell request, `id`, `bash`, `sudo id`,
  SFTP, SCP, command injection, mutable image tag, another image repository, and
  a correctly shaped digest while the runtime configuration is absent.
- Remote port forwarding was refused with SSH exit 255.
- Independent source review found an existing-account startup-file bypass;
  the shell/empty-home guard and two regression tests closed that finding before
  installation. This is not a claim that all security risks are eliminated.

## Remaining Gates

At verification, DNS returned NXDOMAIN. The authoritative nameservers are
Hetzner's; browser access to DNS administration was blocked by its security
check. No DNS or shared reverse-proxy change was made.

PostgreSQL 17.11 is running on localhost only; database `va_dashboard` does not
exist. Provision the app's own database/role and a verified private connection
without disrupting other applications. `/opt/va-dashboard/.env` does not exist.

No image was pulled or application container started, no database migrated,
and no provider integration or public HTTPS/WebSocket route was accepted.
The GitHub workflow change still requires normal review/CI acceptance before
use. Runtime configuration, DNS/TLS, release provenance, backup/restore,
operator data, external integrations, and shadow-trial acceptance remain
separate requirements in the production cutover checklist.

See [restricted connection operations](../deployment/hetzner/SSH_GATE.md) and
[production target](../DEPLOYMENT_TARGET.md).

## DNS Accepted Later On 22 October

After the desktop restart restored browser control, the existing Hetzner zone
received exactly one additional record: `006-va-dashboard`, type `A`, value
`159.69.55.178`, TTL `300`. The seven prior records remained present; no AAAA
record was added. A direct query to `hydrogen.ns.hetzner.com` returned the
expected address and TTL. This supersedes the earlier NXDOMAIN/access blocker,
not the outstanding runtime, TLS, data, provider, or release-acceptance gates.

## Private Database Transport Accepted Later On 22 October

Installed the reviewed VA-only systemd socket/firewall units and allocated the
labelled `va_dashboard_private` network, subnet `172.30.6.0/29`. PostgreSQL itself
still listens on loopback port 5432. The proxy binds only `br-va-db`, address
`172.30.6.1:15433`, with an exact source/interface allow and terminal DROP.

The credential-free probe from a disposable official Python container at
`172.30.6.2` verified the public certificate pin and hostname. Wrong hostname and
untrusted CA were rejected. A sequential probe on the default Docker bridge
could not open TCP. The owned diagnostic containers and newly pulled image were
removed afterward; no SQL, credentials or application database were used.

This proves the tested transport boundary, not actual application-image query,
external-ingress, reboot, database-migration or public HTTPS acceptance. HTTP
proxy units are prepared but not enabled. No VA application is running yet.

Quality run `39819248579` and CodeQL run `39819241084` passed for commit
`ce00b2ae387d024849644027c7cce48955d7fff5`. Later source edits require new CI.
