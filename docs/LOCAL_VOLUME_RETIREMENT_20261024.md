# Local Legacy Test Volume Inventory

This record covers only the 21 volumes attributed to **006 - VA Dashboard**
in the operator's 24 October 2026 Docker inventory. Other repository groups,
shared Docker infrastructure, server databases and production data are out
of scope. The original creating chat is not proven by the attribution.

## What Is Preserved Here

`local-volume-retirement-20261024.json` records exact volume identities,
observed database directories, archive sizes and SHA-256 checksums, plus the
retirement state. This metadata is not a database backup or imported app data.
The databases are historical MySQL test/rehearsal instances named
`aptlss_test`, `recovery_test` or `aptlss_pilot_rehearsal`. The application
continues to use PostgreSQL; these volumes are not runtime dependencies.

No database rows, database files, accounts, passwords, certificates, private
configuration or raw data manifests belong in this repository or a public
GitHub release. Full physical archives and detailed per-file manifests are
retained privately by the operator, outside the repository.

## Preservation And Removal Gates

1. Re-inspect each exact volume and refuse any active or stopped container
   reference. Do not infer disposability from an anonymous name or age.
2. Mount one volume read-only into a network-disabled temporary helper.
   Archive every regular file, directory and symlink with ownership/mode
   metadata. Refuse unexpected database directories or special files.
3. Read the complete compressed archive back. Match every member, regular
   file size and SHA-256, ownership/mode and symlink target against the source
   manifest. Recheck source bytes and metadata. Hash the finished archive
   again from the host. A partial archive is not accepted.
4. Keep archives and manifests in an access-restricted local backup folder.
   Verify copied archives again before relying on a different drive.
5. Publish and read back the safe inventory and recovery instructions on
   GitHub before removal. This does not authorize publishing private data.
6. Obtain the operator's scoped removal confirmation, recheck archive hashes
   and exact-volume consumers, then use individual `docker volume rm`
   commands without force. Never run a global volume/system prune.
7. Record actual outcomes separately from pending or skipped targets. Do not
   restart Docker or other apps to reclaim host VHDX space without approval.

## Recovery

Each private `<volume-id>.tar.gz` archive has a matching
`<volume-id>.verified.json` manifest and an archive SHA-256 in the public
inventory. Keep the detailed manifest private: it contains every retained
file path and checksum. First verify the archive hash and member hashes.

For recovery, create a **new isolated volume**, never overwrite a current
application volume. Inspect archive paths, types and link targets before
extracting. Restore the full datadir, preserving numeric ownership and
permissions. Establish the original compatible MySQL version before booting
it, keep it off all public networks and supply credentials privately. These
physical archives are not PostgreSQL dumps and must not be passed to
`pg_restore`. Use the existing reviewed migration tooling only after a
separate source/recovery validation if data transfer is actually required.

Archive byte/member verification is recorded; a successful MySQL boot,
logical SQL restore or PostgreSQL import is **not** implied. Do not delete
the retained private archives merely because the old Docker volumes are gone.

## Storage Accounting

The source report estimates approximately 9.46 GB across these 21 volumes.
The JSON records exact logical source bytes and compressed archive bytes.
The completed preservation contains 9,461,158,747 logical source bytes in
376,685,923 compressed archive bytes (approximately 3.98%). All 21 archives
passed the complete member/source checks. After the operator explicitly
confirmed removal of exactly these 21 volumes, every archive checksum and
source file was checked again, together with volume creation identity and
zero container references. All 21 volumes were then removed individually,
without force. Final inventory changed from 346 to 325 volumes: no unrelated
volume disappeared and the running-container set remained unchanged. All
private archives were retained and their SHA-256 checks revalidated after
removal. The JSON records each actual removal time and preserved archive hash.

No Docker restart, global prune or VHDX compaction was performed. Windows
free space did not show a corresponding immediate increase; this operation
reclaimed Docker-internal volume storage, not an observed 9.46 GB host-disk
shrink. Keep the private archives and do not compact Docker while other apps
are in use without separate approval.

The private copies remain on access-controlled local storage. The operator's
removable exFAT drive cannot enforce those access controls, so no plaintext
database copy was placed there. An encrypted copy with a separately tested
key-recovery route would be required before using such media for backups.

Logical sizes are not a promise of immediate Windows free-space recovery.
Deleting Docker volumes frees space within Docker's disk; shrinking its VHDX
may require a separately approved interruption. No VHDX is directly deleted.

Bridge and Joyce-pilot activation, production deployment and provider
reauthorization are not part of this maintenance operation.
