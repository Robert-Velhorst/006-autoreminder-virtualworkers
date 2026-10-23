# Native PostgreSQL Backup And Recovery

## Scope

The VA application uses its own database on the existing shared PostgreSQL 17
server. A provider disk snapshot, successful database connection, archive header
or `pg_restore --list` is not proof that an application database can be restored.
The accepted migration backup and reconciliation receipts remain separate from
this ongoing operational backup requirement. Keep those retained originals.

The new utility is a manual, capacity-guarded backup producer, not an installed
timer, off-server backup service or automatic retention policy. Its presence in
Git does not establish that production data has been backed up with it.

## Boundaries

- The production CLI selects only `va_dashboard` on the local Unix socket and
  native PostgreSQL 17 tools. It does not accept arbitrary database names,
  executable paths, passwords or destinations from command-line input.
- Database access uses the existing local `postgres` peer identity for fixed
  native commands; application secrets and inherited provider credentials are
  not copied into child environments or written to receipts.
- The archive and receipt are root-private. Existing files, symlinks, unexpected
  permissions and insufficient capacity must be refused, never silently fixed.
- The producer checks capacity before starting and while streaming. It must
  observe a three-GiB free-space reserve for archive writes, enforce a deadline and
  stop/join its own process group on failure. It does not stop PostgreSQL,
  Docker, the application or another application's processes.
  A nonblocking directory lock refuses a second producer for the same target.
  Space checks are observations, not reservations against other disk writers;
  exhausted storage can prevent even the small private failure receipt.
- Existing backups are never overwritten or pruned. A failed newly created
  partial archive is not an accepted backup; its private failure evidence is
  retained for explicit review.
- Unexpected child warnings are not ignored: even a zero exit with diagnostics
  stops acceptance and requires review. Public errors expose only fixed reason
  codes, never raw database diagnostics or connection credentials.
- Publication requires a successful producer, nonempty custom-format archive,
  digest/byte accounting and successful native archive listing. The receipt
  explicitly records `restoreVerified: false`; listing does not restore data.

`pg_dump` uses a consistent database snapshot even while normal reads/writes
continue. This is a single-database backup, not a backup of cluster-wide roles,
tablespaces or operating-system configuration. Privilege/bootstrap configuration
and private connector secrets require a separately controlled recovery path.
See the official [PostgreSQL 17 pg_dump documentation](https://www.postgresql.org/docs/17/app-pgdump.html).

## Read-Only Capacity Check

From an independently reviewed source tree on the intended Linux host:

```sh
sudo python3 -B -I deployment/hetzner/postgres_backup.py --check
```

This checks the fixed target, installed tools, database metadata and space without
creating a backup directory or archive. Do not bypass a failed space check by
deleting retained archives or reducing the reserve to make the command pass.

After destination and capacity acceptance, a separately authorized manual run is:

```sh
sudo python3 -B -I deployment/hetzner/postgres_backup.py --run
```

Do not enable repeated local runs while the only available capacity would fill
after a small number of backups. Select an authorized off-server destination,
encryption/key recovery, retention and failure notification first. No storage
purchase, third-party upload, timer or retention deletion is implied here.

## Isolated Recovery Proof

The opt-in native test creates only two uniquely named synthetic databases,
`va_backup_fixture_<nonce>` and `va_backup_restore_<nonce>`. It backs up the
synthetic source, restores into the newly created empty target, compares all
fixture values and column metadata, and checks the restored identity sequence.
It checks ownership markers before removing those test databases and removes
only its newly created synthetic files. It never restores into `va_dashboard`.

```sh
sudo env VA_BACKUP_NATIVE_TEST=1 \
  python3 -B -I deployment/hetzner/postgres_backup_integration_test.py
```

This controlled fixture proves the utility's native path, not restoration of a
particular production backup. For production acceptance, independently verify
the chosen archive hash, restore into an explicitly isolated authorized target,
compare complete application data and schema, verify sequences and role grants,
and test the application against that restored database. Never use `--clean` or
`--create` against an existing shared or production database to simplify a test.
Restoring an archive executes database code; use trusted provenance and an
isolated target. See [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).

## Remaining Operational Gate

Accept a repeatable off-server backup, independent restore and key-recovery path,
capacity/retention behavior, failure notification and a bounded recovery objective
before calling ongoing production recovery complete. A local archive alone must
not be described as completing this gate.
