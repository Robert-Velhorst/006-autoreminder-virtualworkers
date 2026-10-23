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
direct versions match the recorded stable targets. The test runs pass 5,011
Vitest cases and 315 Node cases, with 473 and three existing skips respectively.

The Home and digest browser workflows pass 18 cases. An isolated fixture renders
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
