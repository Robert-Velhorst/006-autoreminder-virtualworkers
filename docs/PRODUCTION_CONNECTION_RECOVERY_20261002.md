# Operational Codex connection recovery - 2026-10-02

## Verified

- The operational container has database, JWT, Trello, Google and Codex queue configuration present. Values were not disclosed.
- The checkout-only doctor reported missing local configuration; this does not establish missing configuration in the operational container.
- The existing host runner was stopped and its container-visible heartbeat was stale (91,348 seconds at the initial observation).
- `codex.exe login status` confirmed ChatGPT sign-in. The queue contained only its heartbeat JSON file, with no pending requests.
- Restarted the existing host runner using its established Node/tsx entry point, hidden window and private diagnostic directory. No directory permissions or account configuration were changed.
- The host process remained running. Both host and operational container observed a fresh heartbeat (one second old), model `gpt-5.6-luna`, route `luna-adaptive-v1`, efforts `low,medium,high`.
- Operational `/health` returned HTTP 200 after recovery.

## Limits

No synthetic live AI request was submitted. Fresh heartbeat proves transport readiness, not acceptance or correctness of an AI assessment. No paid API fallback, provider write, deployment replacement or additional Docker container was introduced. Automatic startup/restart supervision and the remaining production acceptance gates are still open.
