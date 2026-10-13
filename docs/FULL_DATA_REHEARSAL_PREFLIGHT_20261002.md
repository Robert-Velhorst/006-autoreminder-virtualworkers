# Full-data rehearsal preflight - 2026-10-02

Current inspection found the restored native data directory still present at
`.local/mysql-production-restore-20261001/data`, but no running `mysqld.exe`
whose command line identifies that owned restore directory. No database or
application was started during this inspection. Historical checks on port
33317 do not establish current database availability or unchanged contents.

The previous revalidation helper hardcodes PID 47032 and an October 1 output
receipt. It must not be rerun unchanged: the PID is not current and prior
receipts must remain immutable. Existing helpers recover the fixture URL from
a historical session archive; that is not a durable deployment configuration
and must not be presented as a production credential-management solution.

## Required next execution boundary

1. Recover the existing owned fixture connection configuration privately;
   never print the URL or reuse the operational database URL.
2. Restart only the exact native binary and preserved restore directory, on
   loopback 33317, with database events DISABLED at startup. Record the actual
   process identity rather than an old PID. Check port ownership first.
3. Validate actual SQL datadir, port, schema, scheduler and absence of other
   clients. Obtain a new all-column checkpoint and compare it to the historical
   full-data baseline before starting an application.
4. Establish old-binary writer isolation before any application switch. The
   exact fallback image does not honor BACKGROUND_JOBS_ENABLED; its immediate
   Manus scheduler and delayed maintenance are not suppressed by that setting.
   Network isolation does not prevent local database mutations.
5. Only then run the exact candidate / fallback / candidate sequence with
   narrowly recorded allowed mutations and full before/after reconciliation.
   Stop owned processes and preserve all receipts afterwards.

The full-data application rollback remains unverified. Current source tests,
the sealed source build and synthetic five-account fixtures do not satisfy
this gate. This preflight changes no production data, provider configuration,
Windows tasks or Docker containers.

## Fresh Read-Only Revalidation Completed

The existing native binary was subsequently started with its preserved owned
data directory on loopback 33317, events DISABLED, binary logging disabled and
MySQL X disabled. Actual listener PID 39548 was independently checked as the
child of owned launcher PID 22952, with the expected directory and arguments.
SQL identity and absence of other clients were checked before capture.

The full all-column checkpoint exactly matches the historical baseline: 134
base tables and 94,730 records, with schema and ledger included. Receipt:
`artifacts/full-data-revalidation-20261002.json`. This used the existing bounded
fixture-connection recovery in memory; no credential was printed or persisted.
That legacy recovery still needs replacement with durable private configuration.

The helper requested a normal SQL shutdown after checking no other clients.
Independent inspection confirmed the test listener, launcher and server absent,
data directory retained, and the unchanged operational dashboard healthy.
No application was started against the restored data. Consequently the exact
old/new binary sequence, writer isolation and mutation reconciliation remain
open; `applicationRollbackVerified` remains false.

## Private Connection Configuration

A one-time bounded recovery subsequently placed only the owned fixture's
connection configuration in the existing protected, Git-ignored
`.local/pilot/codex-private/rehearsal-db.json`. Nothing was overwritten and no
credential was printed. The current revalidation helper now reads that file
instead of scanning the session archive. The validator requires version 1,
exact keys, loopback 33317, the rehearsal database, no URL options and the exact
owned data directory. Nine tests passed and CI now includes them. This is
configuration validation, not a new database login or application rollback.

## Exact fallback startup inspection

Read-only inspection of `/app/dist/index.js` in the unchanged operational image
`sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`
confirmed startup calls to briefing, Manus, reminder, maintenance and manager
schedulers, followed by optional webhook auto-registration. The compiled bundle
has no `BACKGROUND_JOBS_ENABLED` check. `startManusScheduler` calls its worker
immediately as well as every minute. The inspected image was not started as an
application and received no database configuration or network access.

The next rehearsal must enforce a database-level read-only account for the
unmodified fallback read/compatibility phase. A rejected background write is
not evidence that a worker workflow succeeded. Required write workflows need
an independently controlled write phase and complete mutation reconciliation;
do not waive those workflows merely to obtain an unchanged checkpoint. Do not
edit the fallback binary to suppress its workers and call that exact-image
rollback proof. Candidate read-only startup must also be classified separately
from the additive migration phase, which requires its own narrowly scoped
privileges and checkpoint. Actual account provisioning and execution of these
phases have not occurred yet.

`scripts/rehearsal-readonly.mjs` now provides the pre-application account gate:
it checks the actual session schema and port and validates `SHOW GRANTS FOR
CURRENT_USER`. Only explicit SELECT/SHOW VIEW on the owned rehearsal schema
and global USAGE are accepted; write rights, global reads, roles, delegation,
dynamic privileges, missing evidence and unfamiliar grant syntax are rejected.
Eleven local tests passed, and the CI rehearsal check includes them. This
validator has not yet been executed against a provisioned read-only MySQL
account or wired into a complete exact-image rehearsal launcher; those remain
required before starting an application. It does not replace the separate
datadir/process-ownership verification.

### Actual MySQL privilege verification

The new opt-in `scripts/rehearsal-readonly.mysql.test.mjs` was run against one
network-isolated temporary MySQL 8.4 container with only synthetic probe data.
It confirmed SELECT succeeds, INSERT is rejected with MySQL error 1142, and
adding UPDATE makes the validator reject the account. Actual MySQL account
quoting exposed a defect in the initial strict grammar; backtick account
notation is now supported and covered by a regression test. The final run
passed all 13 unit/integration tests, with no skips. Earlier failed attempts
are not passing evidence. A delayed Docker launch also exposed cleanup risk;
the harness now labels each launch uniquely and locates its owned container
after an unconfirmed start. Independent inspection confirmed no temporary
container remains. No production data or restored full-data fixture was used.
This verifies real grant behavior, not the full old/new application rollback.

The subsequent 13-test run also exercised `assertReadOnlyRehearsalSession`
against actual MySQL responses for DATABASE(), @@port and current-user grants.
The permitted account passed; both newly granted UPDATE and WITH GRANT OPTION
were rejected by the complete session gate. All tests passed without skips,
and independent inspection again confirmed removal of the owned container.
The connection adapter in this test uses the actual MySQL command-line client;
the eventual application rehearsal still needs its mysql2 connection and
separate process/datadir ownership checks.

## Reader Preflight Entry Point

`node scripts/verify-rehearsal-reader.mjs` now provides a mysql2-based entry
point for the preserved full-data fixture. It reads a separate protected
`rehearsal-reader.json` with the same strict version-1 configuration format;
it never falls back to the existing administrator connection. It validates
SQL datadir, port, disabled events, current schema and restricted account
grants, closes its connection and reports no credentials or filesystem paths.
Any error exits nonzero and supplies no application-start clearance. The
combined configuration/account/identity unit run passed 26 tests. The reader
configuration/account has not been provisioned and this entry point has not
yet been run against the full restored fixture. It does not start an app,
grant privileges, verify Windows listener ownership or claim rollback proof.

`scripts/rehearsal-reader-account.mjs` prepares bounded account provisioning
for that fixture only. Before any write it requires matching SQL schema,
datadir, port, disabled events and no other clients. It generates a fresh
hex-only account identity, grants only schema SELECT/SHOW VIEW, verifies the
new reader connection and delegates secret persistence to a protected caller.
Failed grant/verification/persistence removes only the newly created account;
cleanup failure is surfaced instead of silently reported successful. Five
unit tests passed, covering identity/client refusal and cleanup after failed
grants or private persistence. This helper has not provisioned an actual
account; it remains to be connected to a caller that verifies the native
listener, preserves existing private files, and records non-secret evidence.

### Owned restored-fixture reader provisioned

The separate reader was subsequently provisioned against the preserved native
restore, not production. Restore manifest lineage, exact native executable,
loopback listener/process identity, SQL datadir/port/events and no other clients
were checked before account creation. The initial attempt exposed an overlong
generated MySQL username; the generator now stays within 32 characters and the
unit suite checks that bound. After correction, actual mysql2 reader login and
the combined identity/restricted-grant verifier succeeded. Protected config
was created exclusively at `rehearsal-reader.json`, without printing secrets
or replacing existing files. Non-secret receipt:
`artifacts/rehearsal-reader-provisioned-20261002.json`.

The server was normally shut down; independent inspection confirmed the test
listener, native child and launcher absent. The reader file is Git-ignored and
its ACL permits only the current Windows user and SYSTEM. The operational app
remains healthy on its unchanged image. This step adds only a test MySQL account
and grant metadata; no application was connected and no new all-column data
checkpoint was captured in this provisioning step. Full application rollback,
old-image reads and controlled mutation reconciliation remain unverified.

## Single-Workspace Binary Preparation

A dedicated local test image now combines the existing single-workspace
runtime with a separately copied, unchanged fallback filesystem. Test image:
`sha256:7ce3d117dd0bf89fcd8e74dfbb1d80cd8483b7fee6813b7972d36e114b09fe1c`.
The checked local parents were fallback
`sha256:fa20db9cda1524433685b8e85faa6137729629e1d8199a7b1e63d15b5f9d3156`
and existing harness
`sha256:37ee3527646efaf102c4ef85b87c4c5e8a614dd93056fcc7c5383508f0ddeed2`.
The initial raw-SHA Dockerfile FROM syntax failed; the successful build used
local hash-named tags and the build output confirmed their resolved identities.

One networkless inspection container confirmed fallback bundle hash
`3f68aca7f5024c7832aea5e954d5230b502bdb1d07ed9bd82152dce93901825a`
and candidate bundle hash
`80d9137a96b13babfa6bff7c8783ba1d81a0abd1ef80375074f81668c13317ce`.
The fallback hash was independently read from the original image and matched.
Original application Node versions remain 22.23.2 and 22.23.3 respectively.
No application server or database was started by these inspections, and the
inspection containers were removed. This is binary preparation only: the
full backup still needs restoration inside this workspace, exact source/image
provenance verification, sequential application runs and full reconciliation.

### Full-backup capacity preflight

The exact retained SQL manifest reports 14,441,189,811 bytes. The existing
`openVerifiedBackup` streaming verifier completed on that file, but the new
restore preflight then rejected available C: capacity before starting any
restore. The subsequent point-in-time inspection found 26,820,005,888 free
bytes against a required 27,326,091,699 bytes (dump size plus 12 GiB reserve).
The D: drive reported 147,476,709,376 free bytes. These figures are dated
observations, not reserved capacity. No backup, operational volume, recovery
image or unrelated project was deleted to bypass the check. No successful
restore receipt was written. The existing 1 GiB tmpfs test workspace cannot
hold this full dataset; the next run needs a protected, disk-backed owned
test directory on a suitable drive, with a fresh capacity check immediately
before import and during streaming. Backup validity is not restore success.

### D: storage rejected after actual privacy check

A fresh empty owned test directory on D: was created and an owner/SYSTEM-only
ACL attempted. Independent inspection still reported Everyone access. Volume
inspection confirmed exFAT, which does not provide the required NTFS access
control. No SQL, credentials or restored data were copied there. The exact
owned empty directory was removed after checking its resolved path and that
it contained no entries. D: free capacity therefore does not establish safe
private storage. A protected NTFS-backed location or explicitly authorized
capacity cleanup is needed; do not format/convert a drive, discard retained
evidence or lower the 12 GiB reserve to bypass this boundary.

`scripts/Test-RehearsalStorage.ps1` now checks an existing real local test
directory for NTFS, protected owner/SYSTEM-only full-control ACLs and backup
bytes plus at least the unchanged 12 GiB reserve. It performs no deletion,
directory creation or ACL mutation. Actual execution against the protected C:
private directory rejected the full 14,441,189,811-byte restore requirement;
a one-byte synthetic sizing control passed the same filesystem/ACL checks.
That control is not clearance for the full restore. Read-only inventory found
the dominant local allocations are retained SQL backups and the existing full
restore; they were not removed. Publication and storage decisions still need
the user's explicit response; automatic goal continuations are not approval.

`scripts/Test-RehearsalStorage.tests.ps1` subsequently passed four actual
Windows controls: reject inherited ACLs, accept a protected tiny synthetic
capacity request, reject a reduced reserve and reject an excessive restore
size. Only fresh empty owned directories were used and removed. An initial
attempt to apply an Everyone ACL was rejected by Windows with a missing
SeSecurityPrivilege; no privilege escalation or shared-host change was made.
The final suite tests inherited-access rejection instead and does not claim
that the blocked Everyone-mutation case passed. Full-data capacity remains
insufficient and no full restore was started.
# Additional Failure-Path Verification

## Read-Only Test Image Inventory

Docker reported 86 VA-dashboard-prefixed image tags spanning 78 image IDs;
80 tags had no associated container. These are not 86 running dashboards and
unused does not mean safe to delete. The operational image remains in use.
The shared MySQL image has 150 associated containers across the host and must
not be treated as VA-only disposable material.

Potential review items include single-test image 81ddf8e35381 (displayed total
2.48 GB), controls fde0520c38f7 (7.88 GB) and full-data runtime 7ce3d117dd0b
(7.1 GB). The latter two are current verification/rollback preparation; they
must not be discarded casually. Dependency image c9ffd95a2dc0 (1.42 GB) is the
pinned test baseline. Displayed totals share layers and cannot be summed as
recoverable host disk space. No image, container, volume or backup was deleted.
Any approved cleanup must establish references and recoverability, then measure
actual protected host capacity again; it cannot substitute for the storage gate.

## Completed Combined Controls Run

After repairing the isolated test environment, all 54 controls passed together
with zero skips on Node 22.23.3, Vitest 4.1.11, TypeScript 5.9.3 and tsx 4.20.6.
The run covered supervisor, publication-ignore, rehearsal connection, read-only
grants, reader identity, reader provisioning and runtime version checks. The
first two attempts failed because the multi-runtime harness lacked the correct
library environment and then proc/device mounts; those failures were not ignored
or converted into passing tests. The final run used the production-runtime chroot
with Git and its required libraries, proc and device mounts inside one no-network
temporary container. SYS_ADMIN was added for those internal test mounts; this is
not a hardened production-container test. Current scripts, server/shared source
and ignore rules were copied from a read-only local source mount.

This closes the combined controls result, not full application rollback,
live-provider acceptance, all-source release verification or activation approval.

A local controls image was successfully built from the existing dual-runtime
image and the exact dependency image c9ffd95a2dc081125dfa2b5674c6015ddd499a557c236e501255ca75486cf426.
Its manifest list is fde0520c38f76d86a2cb4cae09c82c0d44eef0096d3bc6677906fb68b2c81d3f.
No controls were run in this image yet: the Docker inventory request stopped
responding while an unrelated project build was also present. Only the owned
inventory client was stopped; other project processes were left untouched.
The dashboard route returned HTTP 200 afterward. This proves route availability,
not container health, integration readiness or the missing pinned test result.

The reader-account unit suite now passes nine tests, including creation collision,
connection failure, disconnect failure and failed account cleanup. These are unit
checks, not additional full-dataset rollback evidence.

The Windows storage checker rejects reparse points in every ancestor directory,
so a junction cannot cause capacity to be attributed to the wrong drive. Five
Windows controls passed, including an actual junction-ancestor rejection. The
positive capacity control uses one backup byte; it does not clear the full restore.

The combined pinned Node 22 check ran 50 tests: 48 passed and two could not start
Git in the container. All three publication-ignore tests subsequently passed on
the Windows host. This is split-runtime evidence, not an all-green pinned run.
The temporary container was absent afterward and the operational image remained
healthy and unchanged. Full application rollback and production acceptance remain
unverified.

## Fresh Storage Recheck, 2026-10-13

The protected private rehearsal directory passed the current NTFS/ACL and
capacity check with 127,633,862,656 bytes free against the unchanged
27,326,091,699-byte restore-plus-reserve requirement. This removes the prior
capacity shortfall for that volume at the time of inspection; it does not
reserve the space or prove a restore or application rollback.

The existing restored MySQL data directory did not pass the same privacy gate:
its ACL still inherits write access from multiple account groups, including
CodexSandboxUsers. No ACL, data, database or production volume was changed.
No `mysqld.exe` process or listener on port 33317 was present during the check.
The full-data rehearsal remains paused until this exact isolated test-data tree
is securely restricted and its ownership is revalidated. Do not use the private
configuration directory's passing ACL as proof that the restored data directory
is protected.
