# Locked-runtime source tests - 2026-10-02

## Verified source and runtime

- Frozen verification copy: 1,082 files, inventory digest `c1d984c1b45ffc921ef33d89f2a30a362986a943350a9126449d8830f734a37a`.
- Exact inventory: `artifacts/locked-source-tests-20261002-attempt2/source.json`.
- Dependency image: `sha256:c9ffd95a2dc081125dfa2b5674c6015ddd499a557c236e501255ca75486cf426`.
- Runtime preflight confirmed Node 22.23.3, Vitest 4.1.11, TypeScript 5.9.3 and tsx 4.20.6.
- TypeScript check exited zero.
- Vitest: 3,169 passed, zero failed, 206 skipped/pending, 304 result files. JSON report retained alongside the inventory.
- Separate Node tests: 25 passed, zero failed, no skips (diagnostics, browser response classification, supervisor and release runtime validation).
- Execution receipt exited zero. No external network, provider credentials or production database were supplied.
- One temporary container used; subsequent Docker inspection confirmed it removed and the unchanged operational dashboard healthy.

## Boundaries

### Subsequent supervisor shutdown check

The supervisor now retains its ownership lease when shutdown is not confirmed;
only successful shutdown releases the matching owner's lease. The changed
supervisor and its test were overlaid on the frozen verification copy and
tested in the same pinned dependency image with networking disabled. Runtime
preflight confirmed Node 22.23.3 / Vitest 4.1.11 / TypeScript 5.9.3 / tsx 4.20.6.
All 11 supervisor tests passed, with no skips and command exit zero. Independent
Docker inspection confirmed the temporary container absent and the original
operational image still healthy. This is a focused follow-up, not a rerun of
the full ordinary suite or proof of installed Windows supervision.

This is source-test acceptance using the pinned dependency image, not a fresh dependency installation or a newly built application release. The frozen paths derive from the previous release inventory plus the new host-supervision scripts; this does not inventory every untracked workspace file. No deployment, push or remote CI run occurred. Skipped integration tests are not passing tests. Real-provider acceptance, full restored-data old/new binary rollback, official CLI descendant cleanup, installed Windows supervision and human shadow acceptance remain open.

The first preparation attempt rejected an environment-template path before launching a container. Its partial directory was not overwritten; the corrected attempt permits only `.env*.example` templates and retains the successful receipt separately.
