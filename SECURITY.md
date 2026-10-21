# Security Policy

## Supported versions

Security fixes are made against the latest release and the current default branch. Older releases may not receive backported fixes; upgrade to a current release before reporting an issue as unresolved.

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, personal data, or exploit details in a public issue or pull request. Use GitHub's **Report a vulnerability** feature on this repository to submit a private report. Include the affected version or commit, impact, reproduction steps, and any mitigations you know. Avoid including live secrets or real user data in the report.

The maintainers will acknowledge a report as soon as reasonably possible and coordinate disclosure after a fix or mitigation is available. Do not test against systems or accounts that you do not own or have permission to assess.

## Credential exposure

If a credential is committed, assume it is compromised even after removing it from the current branch. Revoke or rotate it with the provider, check its use, remove it from active configuration, and then request closure of the corresponding GitHub secret-scanning alert. Rewriting Git history alone does not revoke a credential.

## Deployment security

Deployments should use HTTPS, least-privilege provider credentials, private database/cache networks, restricted administrative accounts, backups, and the current supported container image. Never publish `.env` files, database dumps, tokens, or runtime state as package assets.

The [Container Image Security contract](docs/IMAGE_SECURITY.md) requires exact-artifact scanning, fail-closed HIGH/CRITICAL decisions including unfixed findings, and approved exact-scoped exceptions lasting no more than 30 days. Its default exception list is empty; documentation is not proof of a passing release gate or a production deployment.

## Output boundaries

Use the shared CSV serializer for exports and escape untrusted email-template
text before delivery. See [Output Safety](docs/OUTPUT_SAFETY.md) for structured
link rules, regression scope and the remaining spreadsheet/mail-client
acceptance boundary. Rendering safety does not replace recipient consent or
authorization checks.

## Worker Session Lifecycle

The optional external login must follow [OAuth Login State](docs/OAUTH_LOGIN_STATE.md):
server-owned initiation, an expiring browser-bound single-use database record,
validated callback configuration and sanitized provider errors. Google consent
controls do not substitute for this separate login flow.

See [Worker Session Lifecycle](docs/WORKER_SESSION_LIFECYCLE.md) for persisted
session invalidation, atomic offboarding, guarded realtime delivery and the
required migration/cutover acceptance. Older binaries must be drained, not left
serving alongside this security contract. Database restoration also requires
session-invalidation review.

## Response and disclosure

Reports are reviewed on a best-effort basis. No response or remediation timeframe is guaranteed. Coordinate any public disclosure with the maintainers so users have a reasonable opportunity to receive a fix.
