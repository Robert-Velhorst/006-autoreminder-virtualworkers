# Implementation Checkpoints

## Canonical Baseline

- Developer delivery: `5a04e6a`, preserved by immutable tag and archive branch.
- Consolidated branch: `main`.
- Developer migrations through `0027` are authoritative.
- Operator migrations start at `0028` and remain additive.

## Current Recovery Points

- Previous Joyce-only application: `archive/joyce-operator-current-2026-07-29`.
- Exact developer delivery: `archive/kamal-platform-delivery-2026-07-28`.
- Runtime state: ignored `.local/public-dashboard.json`.
- Owner bootstrap secret: ignored `.local/owner-bootstrap-token.txt`.

## Resume Rules

Read `git status` before editing. Do not restore deleted legacy tests or revert
unrelated dirty files without ownership evidence. Run the full acceptance gate
after schema, authentication, provider, scheduler, or routing changes.

