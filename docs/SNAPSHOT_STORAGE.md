# Lossless Manager Snapshot Storage

## Scope

Only `aptlss_manager_runs.snapshotJson` uses the versioned storage codec. Run IDs,
timestamps, worker ownership, proposal hashes, previous plans, reviews, checks,
and all other records remain unchanged. No retention rule deletes history.
The physical PostgreSQL column remains `text`; no schema rewrite is needed.

The Drizzle custom type encodes writes and decodes typed reads. Small snapshots,
ordinary legacy text, and unusual legacy projection shapes remain uncompressed.
Raw PostgreSQL clients bypass the custom type and must explicitly use
`encodeManagerSnapshotStorage` / `decodeManagerSnapshotStorage`.

## Integrity And Compatibility

An envelope contains Brotli-compressed original UTF-8 bytes, their length and
SHA-256, and the version/codec. Decoding returns the original string, not JSON
reserialized from an object. Whitespace, member order, and repeated keys are
preserved. Decompression has a declared-size allocation ceiling and a 32 MiB
absolute bound. Unsupported versions, corruption, trailing input, invalid UTF-8,
and mismatched projections fail closed.

SQL-visible projections preserve the existing generated `reviewDigest` and
`reviewUrgent` columns and the timing reader's `managerTimingPredictions` result.
The decoder independently checks those projections against the full payload.
Projection data is not a replacement for the original snapshot.

## Import And Acceptance

The MySQL importer hashes original row values, encodes snapshots for insertion,
and decodes target snapshots before full-row reconciliation. Counts alone are
not acceptance. Generated review values must also reconcile; they must not be
inserted as ordinary writable columns. Import batches and verification reads
must remain bounded for multi-megabyte source records.

Legacy schema upgrades use explicit manifests in `mysqlPostgresTransferCore.ts`:
four `reply_threads` column aliases retain the old Joyce-named values under their
worker-neutral names; collisions are refused. Thirty known added columns are
checked for exact type, nullability and default, and their expected initial
values participate in row reconciliation. Known new feature tables must be
empty; if a table already exists in the source, its rows are copied rather than
skipped. Unknown columns, tables or generated expressions remain errors. This
does not invent worker ownership or scheduled-job approvals for legacy records.

Before production import, require:

- Original backup retained and verified, with no edits to the source database.
- Every snapshot round-trips byte-for-byte; every source row and relationship
  reconciles against PostgreSQL, including generated review values.
- Actual PostgreSQL tests for generated columns, timing queries, typed/nested/
  aliased reads, writes, and returning values.
- Physical PostgreSQL size, WAL, image pull/extraction, growth and rollback
  headroom measured on the existing host. A compressed archive's size does not
  establish production capacity.
- Existing deployment, provenance, TLS, authentication and operator gates pass.

## Rollback

Do not roll an encoded database back to an older application that lacks this
codec: it would mistake the envelope for a normal snapshot. Preserve the last
codec-aware image as the application rollback target. To return to a pre-codec
application, first materialize and reconcile every decoded original string in a
separate adequately sized database, then perform the normal verified cutover.
Do not rewrite or vacuum a live shared database merely to reclaim space.

Private exports and original recovery archives are not release artifacts and
must never be committed, uploaded to CI, or included in public packages.
