# Legacy Operator Data Transfer

This is a conditional recovery tool, not a production runtime backend or a proof that a legacy source exists. Keep all exports private. Preserve and verify a source backup before any import, and disable competing application writers for the reviewed maintenance window.

Export uses a consistent read-only legacy MySQL snapshot and refuses to overwrite an existing output file. Supply `LEGACY_MYSQL_DATABASE_URL` privately through the environment, not command arguments:

```sh
pnpm operator:data:export --out /private/operator-export.json
```

Only a complete single-worker export with retained worker/founder principal fingerprints is accepted by this tool. Exports with skipped tables, unsupported columns, missing identities or ambiguous ownership are rejected. Multi-worker sources and changed numeric IDs require a separately reviewed mapping/migration, not implicit reassignment. Do not relabel historical worker evidence to a replacement worker.

Set `TARGET_DATABASE_URL`, `OPERATOR_IMPORT_WORKER_ID`, and `OPERATOR_IMPORT_FOUNDER_ID` privately for the intended PostgreSQL target. In production use `NODE_ENV=production` and verified TLS. First preview:

```sh
pnpm operator:data:import --in /private/operator-export.json --dry-run
```

Import defaults to dry run. After reviewing source identity, target ownership, schema, and backup/rollback arrangements, explicitly use `--execute` to write. Existing records must match exactly; collisions are refused rather than overwritten. The transaction locks the relevant tables and repairs identity sequences without rewinding allocated IDs. Any insert, comparison or sequence-repair failure rolls back the transaction.

Finally reconcile every exported key and supplied column:

```sh
pnpm operator:data:reconcile --in /private/operator-export.json
```

Target row counts alone are not reconciliation. A successful dry run is not a completed import, and isolated synthetic integration tests do not establish acceptance of a real historical dataset. The source export and database backup must remain available until actual data reconciliation and rollback acceptance are complete.
