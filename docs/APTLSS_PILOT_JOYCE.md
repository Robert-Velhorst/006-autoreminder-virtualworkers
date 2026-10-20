# Joyce Shadow Pilot

## Selection

Robert selected Joyce as the pilot worker on 2026-09-05. This selects an existing
worker; it does not authorize active autonomous planning, external messages,
replacement of the canonical platform, or fabricated acceptance reviews.

Read-only checks against the operational database confirmed:

- User ID: 2; display name: Joyce; role: worker.
- Worker profile ID: 1; founder ID: 1; profile status: active.
- Time zone: Africa/Nairobi; working days: Monday through Saturday.
- Assigned operator records: 49 APTLSS plans, 312 steps, 7 daily plans, 0 email tasks.

These counts are a point-in-time observation, not evidence of source freshness or
of completed work. Identity and assignments must be revalidated at pilot startup.
No worker account, credentials, assignment, or operational policy was modified.

## Status: Selected, Not Started

The dashboard health endpoint returned HTTP 200 with connected MySQL and Redis
after an initial timeout. There is no manager-state row for Joyce. The operational
manager-state table lacks the new shadow/active mode fields.

The tested reliability implementation is in the separate
`feat/aptlss-shared-evidence-engine` worktree. The current main worktree contains
additional unpublished changes which must be preserved. Its migration lineage
differs from the reliability branch: main uses 0032 for worker invitations and
0033 for durable reminder orchestration; the reliability branch uses those
numbers for evidence graph and manager additions. The operational database has
47 migration records. Journal length alone does not establish migration identity.

Do not apply the feature branch migration journal to this database, replace the
running application with the feature build, or use the disposable test database
as Joyce's live pilot environment.

## Required Before Startup

1. Reconcile actual applied migration hashes with both worktrees and preserve the
   current platform's schema and capability lineage.
2. Adapt reliability additions into new additive migrations after the canonical
   lineage; retain all overlapping columns, tables, and history.
3. Back up and restore the operational database into a separate rehearsal target;
   verify the adapted migrations, preserved records, and rollback procedure there.
4. Re-run safety, authentication, worker isolation, build, and browser checks on
   the consolidated source. The previous feature-branch attestation does not
   certify a different consolidated build.
5. Make the verified consolidated version available through the existing worker
   portal, then explicitly select Joyce in shadow mode only. Verify that no
   executing plan or external system changes during a real assessment.

## Acceptance

Start the trial clock only after actual controlled availability and a genuine
assessment. Robert reviews all urgent conflicts and at least 100 distinct real
proposals across at least five working days. Record the actual review, correction,
and supporting source; never import test fixture reviews or backdate observations.

Active mode remains gated by the criteria in [APTLSS reliability](APTLSS_RELIABILITY.md).
Joyce's pilot selection alone does not satisfy those criteria.
