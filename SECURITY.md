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

## Response and disclosure

Reports are reviewed on a best-effort basis. No response or remediation timeframe is guaranteed. Coordinate any public disclosure with the maintainers so users have a reasonable opportunity to receive a fix.
