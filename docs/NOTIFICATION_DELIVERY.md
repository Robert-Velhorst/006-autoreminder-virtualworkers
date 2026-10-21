# Notification Delivery And Recovery

## Activation

`NOTIFICATIONS_ENABLED` must equal `true` before outbound notification providers
or automated notification delivery are enabled. The default remains disabled.
The digest scheduler is part of the application's existing background-worker
lifecycle; it does not require a second container. Recipient identity and
persisted preferences are checked independently of the global switch.

Routine digest and briefing email requires the recipient's persisted
`daily_digest` mode and `emailEnabled = 1`. Priority-only preferences do not
authorize routine email. In-app timer notices require the canonical founder's
persisted in-app preference, go to that account's notification history, and do
not use the external project-owner notification provider. Timer reconciliation
continues even when notifications are disabled or the notice cannot be stored.

Apply the canonical PostgreSQL migrations before using this application version.
The outbox migration adds nullable delivery metadata to existing `digest_jobs`
and introduces `digest_job_items` with unique notification membership and
restrictive foreign keys. Existing history is retained; legacy jobs do not gain
invented payloads, membership or delivery outcomes.

## Exact Batches

`notification_history` is the durable queue. The old destructive memory queue is
not a second delivery path. A recipient's daily window is prepared under the
existing database-clock scheduled-job lease. At most 100 queued notifications
enter a batch; older backlog remains eligible and overflow stays queued.

The recipient, rendered message, notification membership and payload hash are
recorded before a provider call. A dispatch marker is committed before external
I/O. Only the recorded members are marked sent after provider acceptance;
notifications queued during that call cannot join the email retrospectively.
The provider call is never made while holding the preparation transaction open.

Delivery phases have deliberately different meanings:

| Phase | Meaning |
| --- | --- |
| `prepared` | Recorded batch with no dispatch currently confirmed |
| `dispatching` | An external attempt may be in flight; its lease/status must be checked |
| `sent` | Provider acceptance or an explicitly recorded operator attestation |
| `not_sent` | The provider boundary confirms no send; bounded backoff may retry the same batch |
| `uncertain` | Delivery may have occurred; automatic resend is prohibited |
| `cancelled` | An explicitly reviewed replacement superseded this retained batch; not a delivery claim |

Provider acceptance is not proof of inbox delivery or reading. The supported
provider interface does not guarantee exactly-once inbox delivery. A timeout,
restart after a dispatch marker, lost lease or missing acknowledgement must not
be interpreted as proof that an email was not sent.

## Operator Recovery

Use **Settings > Maintenance > Digest recovery** as an administrator. Workers do
not receive this interface, frozen message details or reconciliation actions.
The backend independently restricts administration to the recipient's own
administrator account or their unambiguous canonical founder.

1. Refresh the current job state. A live dispatch cannot be reconciled.
2. Review the frozen recipient, message, attempt and exact membership against
   private provider records. A truncated preview is not the full message.
3. Record a review note and evidence reference. These are an operator
   attestation, not a fabricated provider receipt.
4. Record confirmed acceptance only when supported by that evidence. Authorizing
   another attempt requires explicit duplicate-risk acknowledgement; it records
   permission for a future attempt and does not itself send email.
5. Refresh after a timeout or conflict. A failed status read is not evidence that
   reconciliation failed, so never blindly resubmit a mutation.

Address changes do not silently rewrite an in-flight batch. A reviewed
replacement retains the old payload and audit record. Membership remains
exclusive. Historical jobs without trustworthy membership need a separate,
source-specific migration review; they cannot be made reliable by guessing IDs
or relabeling records as sent. No historical data import is currently approved.

The authenticated API exposes the same operations:

- `GET /api/notifications/digest-jobs/attention`
- `GET /api/notifications/digest-jobs/:id`
- `POST /api/notifications/digest-jobs/:id/reconcile`

The POST body requires `outcome` (`sent` or `retry`), `note`, and
`evidenceReference`; a retry also requires the applicable duplicate-risk
acknowledgement. A successful HTTP response alone is not confirmation: the
response must explicitly acknowledge a recorded reconciliation. Retained batch
membership prevents deleting a claimed notification's audit history; the API
returns a conflict instead of reporting successful deletion.

## Deployment And Rollback Boundary

The additive schema does not authorize a live cutover. Verify migrations,
concurrency, restart recovery, role boundaries, backups and the selected email
provider before enabling delivery. Current source/browser/native tests do not
prove live-provider or Hetzner acceptance.

Do not re-enable notifications on an older binary that does not understand the
outbox while retained batches exist. Preserve jobs, membership, leases, audit
records and backups; do not clear them to make a retry work. Database restoration
is a separate, explicitly authorized recovery operation. Legacy transfer tools
must pass their schema preflight with a reviewed mapping for the new metadata;
do not bypass a mismatch or manufacture historical membership.
