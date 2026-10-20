# Legacy Operator Data Transfer

This is a conditional recovery tool, not a production runtime backend or a proof that a legacy source exists. Keep all exports private. Preserve and verify a source backup before any import, and disable competing application writers for the reviewed maintenance window.

Export uses a consistent read-only legacy MySQL snapshot and refuses to overwrite an existing output file. Supply `LEGACY_MYSQL_DATABASE_URL` privately through the environment, not command arguments:

```sh
pnpm operator:data:export --out /private/operator-export.json
```

Only a complete single-worker export with retained worker/founder principal fingerprints is accepted by this tool. Exports with skipped tables, unsupported columns, missing identities or ambiguous ownership are rejected. Multi-worker sources and changed numeric IDs require a separately reviewed mapping/migration, not implicit reassignment. Do not relabel historical worker evidence to a replacement worker.

Set `TARGET_DATABASE_URL` privately for the intended PostgreSQL target. In production use `NODE_ENV=production` and verified TLS. Select the three distinct source-bound identities explicitly: `--worker-user-id` and `--founder-user-id` refer to `users.id`; `--worker-profile-id` refers to `va_profiles.id`. These are not interchangeable. For example, only after verifying user 2, founder 1 and profile 3, preview:

```sh
pnpm operator:data:import --in /private/operator-export.json --worker-user-id 2 --founder-user-id 1 --worker-profile-id 3 --dry-run
```

Import defaults to dry run. After reviewing source identity, target ownership, schema, and backup/rollback arrangements, explicitly use `--execute` to write. Existing records must match exactly; collisions are refused rather than overwritten. The transaction locks the relevant tables and repairs identity sequences without rewinding allocated IDs. Any insert, comparison or sequence-repair failure rolls back the transaction.

Finally reconcile every exported key and supplied column:

```sh
pnpm operator:data:reconcile --in /private/operator-export.json --worker-user-id 2 --founder-user-id 1 --worker-profile-id 3
```

Target row counts alone are not reconciliation. A successful dry run is not a completed import, and isolated synthetic integration tests do not establish acceptance of a real historical dataset. The source export and database backup must remain available until actual data reconciliation and rollback acceptance are complete.

The current private export format is `joyce-operator-export-v2`. Re-export older snapshots; do not edit their identity metadata manually. Global `app_settings` rows retain a null worker scope. Credential settings are excluded into an explicit omission manifest rather than replaced with null values. Such exports are incomplete for operational cutover: restore or reconnect credentials separately through a private approved channel. Importing the non-secret subset requires `--acknowledge-credential-omissions`; reports and exit status must continue to identify the outstanding restoration. Acknowledgement does not mean the credentials were restored.
