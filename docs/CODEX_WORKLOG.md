# Implementation Worklog

## Consolidation

- Restored and preserved the developer platform and migration lineage.
- Integrated one canonical worker operator instead of nesting the old portal.
- Retained profile-specific history while removing product-level identity
  assumptions.

## Production Wiring

- Added worker invitations, evidence isolation, reminder orchestration, HAI,
  maintenance schedules, reply lifecycle, Google evidence, browser evidence,
  and one-time owner access.
- Hardened route ownership, scheduled job authentication, Trello card access,
  webhook verification, retry behavior, and provider truthfulness.
- Added container startup, migration execution, MySQL/Redis health, ngrok
  public runtime, graceful shutdown, and diagnostics.

## Verification Evidence

Exact current-run results belong in `FINAL_VERIFICATION_REPORT.md`; this file
records implementation history and must not be used to claim a later build is
still passing.

## 2026-08-15 External-Action Hardening

- Removed the unconditional Trello chatbot notification bypass. Automated
  comments require `NOTIFICATIONS_ENABLED=true` and make no provider request
  while disabled.
- Hardened operator-side Trello writes with credentials and card-access checks,
  provider-confirmed audit history, and truthful UI feedback.
- Removed the unused per-worker Trello comment-token setting and its stored
  value. The dashboard never read that token for a write, so retaining it
  created an unsafe, misleading secret store. Migration `0039` deletes legacy
  values while server-managed integration credentials remain the only posting
  path.
- Rebuilt the Docker image and verified the active local and public health and
  readiness endpoints after the change.
- Added a restrictive Content Security Policy and HTTPS-only HSTS response
  header. The public worker login route was checked after redeployment and
  still passed its Chromium browser smoke test.
- Unified local account, worker invitation, and founder-managed worker
  password creation behind one 12-character minimum.
