# APTLSS shadow-pilot integration

This source integration retains the manager/evidence/reminder feature work while preserving main's canonical PostgreSQL pool, verified TLS, current dependency pins, public-origin checks, webhook validation and deployment configuration.

The original MySQL pilot history remains in Git for provenance. Its historical verification reports do not prove acceptance of this PostgreSQL integration. New PostgreSQL schema/migration and query acceptance, browser behavior, provider permissions and activation must be verified independently. No live provider action, deployment or user database migration was performed by this consolidation task.

Current validation is in progress; this document is not a production acceptance declaration.

## October 21 Consolidation Follow-Up

The consolidated candidate contains current main's router dependency update. Six local development snapshots are preserved by verified `archive/local-progress-20261020/*` tags; superseded proxy and release-security commits are also preserved by `archive/consolidation-20261021/*` tags. Tags preserve exact history, not deployment acceptance. Private configurations and database archives are deliberately not published to this public repository.

Functional comparison found that the old evidence-engine, shared-PostgreSQL, and retired-ingress branches are superseded by the candidate rather than safe to merge wholesale. In particular, historical MySQL runtime/deployment definitions must not replace the canonical PostgreSQL implementation. The missing evidence-load failure/retry UI and PostgreSQL proof-field validation have been ported. Production database completeness checks are retained alongside verified TLS. CI intentionally retains `ubuntu-latest` with pinned application tools; an older fork's OS runner pin is not a missing product feature.

Verification boundaries:

- Node 26.12.0 / frozen pnpm 12.14.0 installation; full local ordinary run: 3,413 passing tests, 213 environment skips. These skips do not prove database or provider behavior.
- The 80 intercepted-API browser contract scenarios pass locally, including the evidence-failure recovery regression. They do not prove live provider access or persistence.
- Focused parsing, DOM status-message, and production-configuration tests pass. The actual PostgreSQL owner test initially exposed a fixture DDL parameterization error; the fixture is repaired, but the new hosted database run remains required.
- A disposable localhost PostgreSQL 18.6 instance subsequently passed all 22 owner/transfer ownership and transaction tests, plus 20 transfer utility tests, with no skips in those focused runs. This also exposed and repaired an ambiguous sequence-query parameter type and a missing fixture enum. The transfer tool now refuses principal/content collisions, defaults to dry run, uses exact keyed reconciliation, and repairs sequences transactionally. See [the transfer procedure](OPERATOR_DATA_TRANSFER.md); no private dataset was imported.
- Required hosted CI, final-image acceptance, data-transfer/restore acceptance, and final exact-head security analysis remain merge/release gates. Do not use an older green run to approve a newer commit.

The production environment has the owner's requested self-approval and administrator-bypass settings. No Hetzner SSH deployment secrets are configured. The target host, domain and app-specific database still need authoritative verification. No production deployment or stable-release acceptance is claimed.

### Full Local PostgreSQL Follow-Up

After independent review, transfer v2 was corrected to distinguish user IDs from profile IDs and to preserve global settings. Credentials now have an explicit omission manifest and require separate private restoration; acknowledged data-only imports do not report complete success. The one-time owner bootstrap only issues a session after winning the conditional password update.

The final local full run on Node 26.12.0 / PostgreSQL 18.6 passed **3,654 tests in 327 files**, with **22 explicitly skipped tests in three files**, in 101.77 seconds. All canonical migrations applied; parity was exact for 136 tables with no missing/extra columns. The focused transfer utility run passed another 23 tests. The earlier 80-browser contract run remains valid only for the UI contract scope, not live providers. The temporary database used synthetic fixtures and memory-backed storage, never an operator database.

The original 17 obsolete local branch heads are now local archive tags; their entire histories were first verified reachable from remote archives/main/candidate refs. Old worktrees remain detached at the same exact commits, preserving files and private configuration. The current common checkout retains only local main and the consolidation workbranch until required exact-head checks allow the PR merge. Other independent clones remain separate and must not be silently overwritten.

These receipts do not establish real legacy-data reconciliation, restored credentials, target-host acceptance or the required five-working-day/100-reviewed-proposal shadow trial. Keep automatic planning in shadow mode until its separate acceptance criteria are met.

Hosted PostgreSQL 18.6 has applied the appended migration chain and passed complete runtime table/column parity. A first real database test run passed 3,467 assertions and exposed remaining fixture/transfer compatibility issues; those corrections are committed for a fresh run. Final database, browser, source-attestation and container gates remain required before merge. The dependency audit reports no known vulnerabilities after the selector-parser patch.
