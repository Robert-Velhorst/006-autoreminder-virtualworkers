# PostgreSQL Production Image Acceptance

## Invocation

```sh
CI=true node scripts/verify-postgres-production-image.mjs IMAGE
```

Alternatively, an operator can explicitly set
`POSTGRES_IMAGE_ACCEPTANCE_FIXTURE=isolated-owned`. Linux on the native Docker
Engine host (not a Docker Desktop VM bridge), a local Docker daemon,
OpenSSL, installed locked project dependencies, and already-loaded application
and `postgres:18.6` images are prerequisites. The harness does not pull, build,
publish, or promote images. An existing CI PostgreSQL service is not used; its
locally cached image can be reused, but its database and data are never opened.
No existing `DATABASE_URL`, production environment file, or provider credentials
are copied into the fixture.

`IMAGE` can be a local tag or an already-pulled registry digest. The harness
resolves it once with image inspection and starts the application by the returned
immutable image ID. Container inspection checks that the running image matches.
The caller owns registry-digest/source binding and any subsequent promotion.

## Isolation and TLS

- A UUID supplies exact container/network names and an ownership label. The new
  bridge network is internal; both containers attach only to that network. No
  ports are published. The Linux host probes the inspected container addresses
  directly, as supported by [Docker internal networking](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal).
  Each address must be private IPv4 inside the owned network's inspected subnet;
  its attachment must match the exact network ID. Unexpected published bindings,
  foreign network IDs, missing addresses, and out-of-subnet/public targets fail
  before sending fixture credentials or HTTP requests.
- PostgreSQL 18.6 uses tmpfs at its PostgreSQL 18 data-volume parent,
  `/var/lib/postgresql`, with no persistent/anonymous data volume. All accounts
  and records are synthetic. The disposable database is initialized inside this
  new container, never selected from an operator database URL.
- Bounded OpenSSL commands generate a one-day ephemeral CA and server certificate
  with `fixture-postgres` DNS and `127.0.0.1` IP SANs. The CA private key is never
  mounted in a container. PostgreSQL receives only its server key/certificate and
  CA certificate. Its private key is copied into owned tmpfs with PostgreSQL
  ownership and mode 0600. The application receives only the public CA file.
- Both PostgreSQL URLs specify `sslmode=verify-full` and `sslrootcert`. The host
  driver uses structured connection fields plus an explicit CA,
  `rejectUnauthorized: true`, and `servername: fixture-postgres`: routing uses
  the owned container IP while certificate verification uses its private DNS SAN.
  It does not pass `connectionString`, because [node-postgres URL SSL options
  replace an explicit SSL object](https://node-postgres.com/features/ssl#usage-with-connectionstring).
  The host checks the authorized TLS stream.
  `pg_stat_ssl` confirms TLS on host and distinct application connections.
  There is no certificate-verification bypass or production test-mode override.
- Migrations and seeding use the disposable fixture owner. The application uses
  a separate random-password role with NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
  NOREPLICATION, NOINHERIT and NOBYPASSRLS. It receives CONNECT, schema USAGE,
  public-table SELECT/INSERT/UPDATE/DELETE, public-sequence USAGE/SELECT, and
  SELECT only on the Drizzle ledger. PUBLIC database CREATE/TEMPORARY and public
  schema CREATE are revoked. Role flags and denied TRUNCATE, ledger writes,
  schema/database CREATE and temporary-table privileges are checked before
  startup and after offboarding. Actual application TLS connections must report
  this role's username, not the migration owner's.
- The application retains `NODE_ENV=production`, `LOCAL_AUTH_BYPASS=false`, and
  uses `BACKGROUND_JOBS_ENABLED=false`. Notifications and briefing/manager
  schedulers are disabled; Redis and external OAuth are unconfigured. Required
  Trello configuration uses freshly generated nonfunctional values. Internal
  networking prevents provider egress even if an unintended provider path runs.

The HTTP probe itself uses the owned private application IP, not a browser
or a public HTTPS proxy. Production cookie flags are asserted, and the synthetic
cookies are manually replayed over this isolated host-to-container channel. The HTTPS
origin is configuration/CSRF context only. This does not establish browser cookie,
public HTTPS, reverse-proxy, provider, or deployment acceptance.

## Checks

The host `pg` and Drizzle PostgreSQL drivers apply **all** migrations from
`drizzle-postgres-v1` to a fresh database. The latest journal SQL hash/timestamp
must match the actual ledger, and public table/column inventory must match the
latest canonical snapshot. No frozen table count or older MySQL fixture is used.

After seeding a bcrypt-backed administrator and worker with one active profile:

1. Start the actual application image and require `/api/health/ready` to return
   HTTP 200 with `ready: true`; health must report a connected database and
   liveness must report `alive: true`.
2. Require anonymous `GET /api/trpc/auth.me` to return a serialized null identity.
3. Log both accounts in through `POST /api/auth/login`; require success and
   `app_session_id` cookies with Secure, HttpOnly, Path=/ and SameSite=Lax.
4. Read real `auth.me` identities, rejecting password/epoch disclosure. Read
   `GET /api/va/worker/profile` and match the seeded active profile/account.
   Confirm the worker cannot read the administrator `/api/va/vas` route.
5. Use the administrator cookie and configured Origin to call
   `DELETE /api/va/vas/:profileId`; require HTTP 200 with `success: true`.
   Independently verify persisted inactive status, an increased session epoch,
   and one committed offboarding audit row.
6. Replay the old worker cookie: `auth.me` must return null and the protected
   worker profile route must return HTTP 401. A new worker password login must
   return HTTP 403, while the administrator session remains usable.

These expectations follow `server/routes/local-auth.ts`, `server/routers.ts`,
`server/routes/va-management.ts`, and `server/sessionLifecycle.ts`. The fixture
borrows the full-migration and synthetic-account approach from
`server/sessionLifecycle.integration.test.ts` and lifecycle route expectations
from `server/routes/va-management.lifecycle.integration.test.ts`, without importing
their test bypasses or requiring a pre-existing test database.

## Cleanup and Evidence

Commands have finite deadlines (OpenSSL 20 seconds; ordinary Docker commands
60 seconds; inspection 15 seconds; removal 30 seconds). PostgreSQL connection
startup retries for at most 30 seconds; application readiness for 60 seconds;
HTTP requests time out after 5 seconds. The operation has a 180-second abort
deadline; a blocking command can finish its own bounded timeout before abort
is observed. Cleanup runs afterward, with separate bounded connection closes.

Success or failure closes host clients, removes only the exact tracked containers
and network after validating their ownership label, confirms their absence, and
removes the invocation's temporary certificates/environment files. Creation
attempts are tracked before issuing Docker commands, covering ambiguous failures.
No prune, wildcard deletion, existing-service cleanup, or operational database
drop is performed. Cleanup failure overrides an otherwise passing result.
Catchable SIGINT/SIGTERM trigger the same path; SIGKILL/daemon/host loss cannot
guarantee cleanup. A failure reports no production acceptance and requires the
operator to inspect this invocation's labeled resources, never broad-prune them.

The JSON success report contains immutable image IDs, canonical migration/hash,
table count, named checks, and `cleanupConfirmed: true`. It deliberately declares
`providerAcceptance: false`. Command output, database URLs, passwords, cookies,
and raw driver diagnostics are not emitted. Container-inspection failures expose
only bounded booleans/counts/exit codes and fixed operation names, not raw engine
output, addresses, mount paths, or credentials. Failure JSON also reports whether
owned-resource cleanup was confirmed, separately from the failed acceptance.

The new `.test.mjs` uses injected commands, filesystem resources, database fixture
preparation, and HTTP responses. Run it with:

```sh
node --test scripts/verify-postgres-production-image.test.mjs
```

Those tests establish orchestration and failure-handling contracts only. They
do not start Docker, OpenSSL, PostgreSQL, or the image. A real Linux CI/release
invocation of the CLI is separately required for native image acceptance.
