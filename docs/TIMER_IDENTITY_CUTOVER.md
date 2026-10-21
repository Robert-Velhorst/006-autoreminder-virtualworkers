# Timer Identity Cutover

Unknown non-void active legacy timers intentionally block readiness and new timer
creation. Do not delete them, disable the unique index, infer ownership from an
alias, or fabricate a stop time to clear readiness.

## Operator Procedure

Keep the application offline for this maintenance operation. Preserve a verified
backup and review the original source records first. The database connection must
have TRIGGER privilege on time_entries; an application role or custom GUC is not
authorization. The supplied actor must be a current administrator.

The CLI loads no environment file. Configure DATABASE_URL privately. Production
requires NODE_ENV=production and verified PostgreSQL TLS. Nonproduction accepts
only the existing isolated loopback test database policy. Never put credentials
in an evidence reference or command transcript.

Run with the installed TypeScript runner:

```sh
node --import tsx scripts/review-timer-identity.ts report
node --import tsx scripts/review-timer-identity.ts resolve-close \
  --entry-id 55 --tracked-user-id 1002 --tracked-profile-id 12 \
  --actor-user-id 1001 --expected-founder-id 1001 \
  --expected-legacy-va-id 12 --expected-profile-id null \
  --end-time 2026-10-01T09:37:00Z \
  --reason 'Actual stop verified against operator record' \
  --evidence-reference operator-record:closure-55
```

IDs and timestamps above are synthetic examples, not defaults. Supply the exact
before-state legacy alias and profile (literal null where absent), the reviewed
account/profile and original founder, actual UTC stop time, reason and non-secret
source reference. A null target profile must be explicit, not guessed. End time
must be at or after the original start and not in the future.

The command is a dry run unless --execute is added. Review its proposal, then
repeat with --execute only after operator approval. For duplicates, ordinary
resolve may retain one genuine active timer; resolve-close atomically resolves
and closes the explicitly identified duplicate without occupying an active slot.
It does not choose which timer should remain active.

Execution commits two audit events (identity_resolution and legacy_timer_closed)
and one row update together. Audit includes the original identity, tenant, task,
card, precise start/end and durations, actor, reason, source and transaction ID.
Evidence is human attestation, not provider-verified proof. Identical replay is a
no-op; changed evidence or before-state conflicts. This service appends audit
events; it does not claim protection against a database administrator altering
the database itself.

## Accounting Boundary

Original legacy alias, founder, task/card, start, durationSeconds,
durationMinutes, notes, source and updatedAt remain unchanged. Only reviewed
canonical identity and the supplied stop time change. Existing recorded seconds
take precedence over recorded minutes; only when both are absent does the
existing duration helper derive elapsed time from actual start/end. No recorded
duration is replaced or financial row repriced.

Paid founder cycles, overlapping paid worker weekly logs, and locked day reviews
reject recovery. SHARE table locks serialize concurrent settlement writes until
the recovery transaction completes. A settlement committed first is checked;
one committed afterward sees the already recovered timer. Never clear paid flags
or review locks to force recovery. Settled or contradictory records require a
separate authorized financial reconciliation, outside this command.

Identity completeness/readiness is not approval of payroll, invoice amounts, or
the accuracy of historical recorded durations. Review accounting separately when
recorded duration disagrees with attested elapsed time.

## Acceptance

Repeat the report and readiness check after each executed recovery. Review exact
row preservation and both events. Native acceptance covers duplicate recovery,
idempotent replay, mismatched evidence, restricted role refusal, audit rollback,
paid/locked overlap, concurrent settlement blocking and timestamp decoding.
These are isolated fixture tests gated by APTLSS_TEST_DATABASE_URL; their presence
is not evidence of execution or production data approval.
