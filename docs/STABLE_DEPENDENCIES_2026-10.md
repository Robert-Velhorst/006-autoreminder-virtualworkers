# Stable dependency migration — October 2026

The 23 October update checks all 119 direct package entries against npm's stable
`latest` metadata and locks those versions. It changes or adds 68 declarations,
removes the obsolete bcrypt type stub and TypeScript 5 compatibility alias, and
checks 15 override packages against their current stable releases. Node 26.12.1
is the minimum runtime; the container and CI runtime files match that baseline.

## Application migrations

- Express 5 handlers infer named route parameters from their literal routes.
  Shared card-analysis handlers explicitly reject non-string path parameters.
  Development and production SPA fallbacks use pathless middleware instead of
  the removed `"*"` route syntax. Shell responses use an explicit asset root.
- Cookie 2 uses `parseCookie`. The old ambient declaration for the removed
  `parse` export is deleted, so future changes are checked against shipped types.
- Recharts 3 wrappers use the tooltip and legend content types. DayPicker 10 uses
  `month_grid`. Resizable Panels 4 uses `Group`, `Separator`, `orientation`, and
  explicit percentage strings to retain the previous equal-width layout.
- Lucide's removed Trello brand icon is replaced with a generic columns icon.
- The background-work source assertion uses current Babel parser/types packages
  because TypeScript 7 no longer exposes the former JavaScript compiler API.
  Its branch and callback assertions are retained. Bridge fixtures select
  synthetic authentication homes without changing production path confinement.

The obsolete Tailwind/nanoid override is removed. Other override targets include
current Mermaid, path-to-regexp, UUID, ws, qs and esbuild releases. pnpm recorded
seven exact-version release-age exclusions while resolving the requested newest
stable releases; the audit thresholds and install-script allow-list are unchanged.

## Verification and limits

Under Node 26.12.1 and pnpm 12.14.0: TypeScript checking, frozen lock verification,
the production build, and the complete dependency audit pass. All 119 installed
direct versions match the recorded stable targets. The test runs pass 5,373
Vitest cases and 316 Node cases, with 474 and three skips respectively. These
results include main `5034569911de03bf6ce55b73d3c9fa877c017b13`, preserving its
financial feature gates and Hetzner/PostgreSQL preparation. Under Python 3.15.1,
43 offline deployment-contract tests pass; three Linux-only tests are skipped.

The Home, digest and financial browser workflows pass 28 cases. An isolated fixture renders
the actual calendar, chart and resizable-panel components at 1440 and 390 pixels;
date selection, legend/tooltip content and panel resizing pass without page or
console errors. This fixture uses no backend or provider. Real static middleware
serves the built shell at root/nested paths and preserves hashed-asset caching.

The actual Redis service passes cache, TTL, pub/sub and shutdown checks against
a disposable Redis 8.10.2 container with ioredis 6.0.0. It uses synthetic values,
binds only to loopback, and is removed afterward.

The build retains its existing bundle-size warning. These checks do not establish
live PostgreSQL migration, provider, account, image-publication or deployment
acceptance, nor prove that all upstream transitive dependencies are current.

## 24 October main reconciliation

Integrate main `81230f4bbabda2bfa79b1f920917aff4919bf4cb` without discarding its
PostgreSQL backup/host preparation, transport, financial controls, deployment
directives or development Vite request protections. Keep the newer migration
pins for ws and Zod; retain the development template rate limiter after Vite's
module middleware and the production refusal, using Express 5-compatible
middleware registration rather than the obsolete unnamed wildcard.

The lock initially exposed GHSA-27r3-jxmh-p828 in body-parser 2.3.0. Resolve
2.4.0 within Express's declared range and add only that exact version to the
existing release-age exclusions. The complete lock audits with zero known
findings; no advisory or audit threshold is waived. Update pnpm to public
stable 12.15.0 and use the npm-published SHA-512 converted to Corepack's
hexadecimal hash format. Both the package-manager and project YAML documents
are retained; the manager lock now also resolves 12.15.0.

Frozen lock consistency, manifest/YAML parsing, the resolved Vite source AST
and whitespace checks pass. Dependency installation used ignored lifecycle
scripts; no global package manager was installed or changed. No local app
suite, build, live service/database/provider or deployment was run for this
new source. Existing main test cases are preserved; none were authored or
relaxed for this reconciliation. Prior local and hosted results above remain
historical. Fresh hosted CI must qualify the new merged source head.
