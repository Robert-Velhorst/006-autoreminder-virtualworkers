# Operator Runbook

## Start Or Refresh

```powershell
pnpm docker:public
pnpm run doctor
```

The public URL is stored in `.local/public-dashboard.json`. The local fallback
is `http://127.0.0.1:3025`.

The refresh intentionally takes ngrok offline while the app container is
replaced, then restores it only after local health succeeds. A short connection
interruption is expected; an `ERR_NGROK_8012` upstream-error page is not.

## First Owner Access

1. Open the login page and choose **Set up owner access**.
2. Read the ignored `.local/owner-bootstrap-token.txt` on the host.
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

## Rollback

Stop the current app, retain its logs, restore the prior image and database
snapshot together, then run health/readiness checks before reopening traffic.
The immutable Kamal delivery and Joyce pre-consolidation archive remain Git
recovery points; neither should be force-updated.
