# Branch Consolidation Record

## Canonical References

- Exact Kamal delivery: `5a04e6a`
- Immutable delivery tag: `delivery/kamal-platform-2026-07-28`
- Checkout-ready delivery archive: `archive/kamal-platform-delivery-2026-07-28`
- Consolidated product: `main`
- Joyce-only rollback: `backup/joyce-overwrite-2026-07-29`

Kamal authored `5a04e6a` on 28 July 2026. Its tree object is
`4577bd1d959b3aceeb348093be2167dd3e9e5631`. The recovery checkpoint before
additive integration has the same tree object.

## Audit Result

The following branches contain no commit that is absent from the consolidated
recovery history:

- `main`
- `archive/joyce-operator-current-2026-07-29`
- `consolidation/joyce-operator`
- `codex/port-joyce-operator`

Their relevant capabilities were compared during recovery. Compatible Joyce
features were integrated under `/worker`; replacement shells, conflicting
migrations, provider-specific AI routing, unsafe extension installation, and
unapproved external actions were rejected deliberately.

## Retired Legacy Line

`auto-reminder-structured` is a separate 2025 application, not Kamal's final
platform. It used a split frontend/backend architecture and included automatic
Trello, email, SMS, and WhatsApp reminder jobs. It also tracked populated
credentials in `Backend/.env`.

For that reason:

1. Its source is not merged into the consolidated application.
2. Its remote branch is removed after the verified main cutover.
3. Credentials formerly committed on that branch must be considered exposed
   and rotated at their providers.
4. The current approval-gated notification and maintenance systems remain the
   supported replacement.

## Main Cutover

On 30 July 2026, `main` advanced by a normal fast-forward from `549b932` to
`2a675cd`. GitHub records recovery pull request #1 as merged. The temporary
`recovery/restore-developer-platform`, `consolidation/joyce-operator`, and
`auto-reminder-structured` remote branches were then removed.

Future work starts from `main`. It may advance only to a commit that:

- descends from the preserved Joyce snapshot;
- contains the exact Kamal delivery in history;
- passed the repository CI gate;
- passed clean-database migration and parity checks;
- retains both delivery and rollback references.

No history rewrite or force push is used.
