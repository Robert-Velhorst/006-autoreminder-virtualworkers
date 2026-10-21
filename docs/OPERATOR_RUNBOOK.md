# Operator Runbook

## Start Or Refresh

```powershell
docker compose --env-file .env up -d --build
pnpm run doctor
```

Production uses the configured HTTPS origin and trusted reverse proxy, not a
development tunnel. The application container binds to loopback on the host;
PostgreSQL and optional Redis are separately managed services. Verify readiness
and the previous immutable image before replacing a running application.
For an approved published release, follow [the deployment procedure](../DEPLOYMENT.md)
rather than rebuilding unrelated source on the production host.

## First Owner Access

1. On a fresh migrated database, first follow [pending-owner provisioning](OWNER_PROVISIONING.md).
2. Open **Set up owner access** and obtain the configured token from the private host environment or secret store. Never publish it.
3. Enter that token and choose a unique password of at least 12 characters.
4. Remove `OWNER_BOOTSTRAP_OPEN_ID` and `OWNER_BOOTSTRAP_TOKEN` from `.env`.
5. Restart the app and confirm normal owner login.

## Replace A Worker

1. Keep the previous worker profile for historical audit data.
2. Create an expiring invitation from the founder/admin surface.
3. Send the invitation link to the replacement worker through an approved
   channel.
4. The worker accepts it, chooses their credentials, and connects only their
   own Google, Trello, and browser evidence sources.
5. Assign cards and schedules to the new profile. Never bulk-relabel the old
   worker's evidence as belonging to the replacement.

## Incident Checks

1. Run `pnpm run doctor` and inspect `/api/health/ready`.
2. Review Settings > Maintenance for failed or overdue jobs.
3. Check provider setup state without exposing credential values.
4. Retry only idempotent jobs. Review external actions before retrying.
5. Back up the database before a repair migration.

For uncertain email outcomes, follow [notification delivery recovery](NOTIFICATION_DELIVERY.md).
Do not interpret a timeout as permission to resend or erase a retained batch.

## Verification Output Safety

Use the safety verifier's default `artifacts` and `test-results` destinations.
Its output-path environment overrides are trusted operator configuration, not a
filesystem sandbox. In particular, Playwright clears its configured output
directory before running: `APTLSS_BROWSER_OUTPUT_DIR` must designate disposable
test output only, never a source checkout, home directory, private configuration,
or backup directory. Report and attestation files may also be overwritten.

The historical review-index rehearsal is not a production migration command.
Its directory and backup-hash checks do not sandbox SQL or make untrusted backups
safe, and it may change a server-wide MySQL event-scheduler setting. Run it only
against a separately verified, dedicated rehearsal server, never a shared or
operational database service.

## Rollback

Do not automatically restore an older database snapshot when changing application
images: later worker activity and assessment history must remain intact. Keep the
current database, prior image, verified backup and incident logs recoverable.

Legacy application rollback is currently disabled by the pilot tooling. It must
not be bypassed with a generic refresh or deployment command. Before an image
switch is authorized, complete the isolated full-data backward/forward rehearsal
in [the shadow rollout guide](APTLSS_SHADOW_ROLLOUT.md) and the full-history
materialization checks in [assessment history storage](APTLSS_HISTORY_STORAGE.md).
Database restore is a separate disaster-recovery decision requiring explicit
authorization, reconciliation of later activity and demonstrated preservation.
Health/readiness alone does not prove data or binary compatibility.

The immutable Kamal delivery and Joyce pre-consolidation archive remain Git
recovery points; neither should be force-updated.
