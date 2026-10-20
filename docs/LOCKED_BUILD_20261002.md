# Locked source production build - 2026-10-02

Built the same 1,082-file copy used by `LOCKED_SOURCE_TESTS_20261002.md`, inventory
digest `c1d984c1b45ffc921ef33d89f2a30a362986a943350a9126449d8830f734a37a`.
Every inventoried file hash was rechecked before launching the build.

The fixed dependency image and Node 22.23.3 / Vitest 4.1.11 / TypeScript 5.9.3 /
tsx 4.20.6 preflight passed. `npm run build` completed Vite, esbuild and the
APTLSS seal step with exit zero. Output and receipts are retained under
`artifacts/locked-build-20261002`. Independent hashing of the exported server
bundle and browser collector confirmed both match `dist/aptlss-build.json`.

Vite reported a frontend chunk larger than 500 kB; it is a performance warning,
not a build failure. The single temporary build container had network disabled
and no production database or provider configuration. It was removed after
completion; the original operational dashboard remained healthy.

This is build evidence, not a newly packaged Docker application image, runtime
acceptance, deployment, remote CI or provider consent. The latest packaged
image remains the previous reconnect candidate until a replacement image is
actually built and inspected. Host-supervision and external acceptance gates
remain open.
