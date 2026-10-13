# Google Evidence Setup

The worker portal can collect read-only Gmail and Google Drive metadata as
evidence for the worker queue, communication compliance, and APTLSS. It never
sends, archives, labels, moves, or deletes Gmail messages, and it never edits
Google Drive files.

## Prerequisites

1. In the Google Cloud project that owns the integration, enable the Gmail API
   and Google Drive API.
2. Configure the OAuth consent screen for the users who will connect their
   accounts.
3. Create an OAuth 2.0 **Web application** client.
4. Add the following authorized redirect URI for the current public tunnel:

   ```text
   https://joyce-va-dashboard-006.ngrok.app/api/google-evidence/callback
   ```

   Replace this URL with the stable production domain before production
   cutover. A changed ngrok domain must also be changed in Google Cloud. The
   app derives the public origin from `PUBLIC_URL`, `WEBHOOK_BASE_URL`, or the
   already configured `TRELLO_WEBHOOK_CALLBACK_URL`; configure at least one of
   these in production.
5. Add the client values to the ignored `.env` file. Do not add them to Git:

   ```dotenv
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

6. Rebuild/restart the app:

   ```powershell
   docker compose --env-file .env.db.local --env-file .env up -d --build app
   ```

## Worker Connection

1. Sign in as the worker.
2. Open **Worker Settings** and select **Connect Google** under Google evidence
   intake.
3. Complete Google consent. The app requests only:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/drive.metadata.readonly`
4. Set the Gmail and Drive intervals and optional Drive folder in Worker
   Settings, then select **Sync now**.

The refresh token is encrypted with the application `JWT_SECRET` and stored
per worker. The worker can disconnect at any time; disconnecting removes the
locally stored token but does not revoke the grant in Google. Revoke the grant
from the Google Account security page when that is required.

## Verification

After connecting, Worker Settings must show a connected Google account and the
last successful sync time for each enabled source. The Evidence screen must
show Google source status and source-backed records. Review matching evidence
before any manual Trello action; a Gmail or Drive sync has no Trello side
effect.

## Boundaries

- The Gmail and Drive connectors available inside Codex are separate
  read-only tools. They cannot and must not be reused as runtime credentials
  for this application.
- `GOOGLE_REFRESH_TOKEN` is an optional server fallback for controlled service
  deployments. Normal worker setup uses the per-worker OAuth connection.
- The public OAuth callback requires HTTPS. Do not use a loopback redirect URI
  for a deployed app.
