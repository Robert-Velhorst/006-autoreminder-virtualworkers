# Historical Credential Remediation

## Incident Boundary

The current application uses PostgreSQL and optional Redis. It does not require
the historical database credentials flagged in earlier repository revisions.
Removing a credential from the current tree does not revoke it or remove it
from Git history.

The incident references are GitHub secret-scanning
[alert 1](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/security/secret-scanning/1)
and [alert 4](https://github.com/Robert-Velhorst/006-autoreminder-virtualworkers/security/secret-scanning/4).
Their earlier locations were `AutoReminder_Deployment_Guide.md` and
`Backend/.env`, respectively. Never reproduce the credential values in this
repository, logs, issues, releases or chat.

The owner explicitly declined deletion of the related shared database user.
Preserve that account. This document does not authorize deleting it, changing
its password or permissions, or interrupting another application's connection.

## Remaining Remediation

1. Establish which services still consume the exposed credential. Record only
   service names, environments, secret references and verification dates;
   keep passwords and complete connection strings in a protected secret store.
2. Obtain owner approval for a scoped replacement or revocation after the
   consumer inventory is complete. Unknown consumers are not evidence that
   the credential is unused.
3. For an approved replacement, migrate each required consumer to a separate
   least-privilege credential through its protected configuration. Verify real
   required reads and writes before retiring the old credential.
4. Independently verify that the exposed credential no longer authenticates,
   without publishing it or entering it into untrusted tools. Preserve the
   verification result, date and affected service names, not the credential.
5. Only then resolve the corresponding GitHub alerts with the accurate reason.
   A passing build, PostgreSQL cutover, source deletion or unavailable provider
   session is not proof of revocation.

## Completion Record

| Requirement | Status |
| --- | --- |
| Historical provider removed from current application and deployment | Current source uses PostgreSQL |
| Every remaining credential consumer identified | Not verified |
| Owner-approved replacement or revocation completed | Not verified; deletion declined |
| Exposed credential independently proven invalid | Not verified |
| Required consumers healthy after remediation | Not verified |
| GitHub alerts resolved accurately | Not completed |

Review live GitHub and provider state before updating this record. Do not mark
the incident complete merely because the retired provider is no longer part of
VA Dashboard.
