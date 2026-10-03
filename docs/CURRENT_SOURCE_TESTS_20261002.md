# Current working source verification - 2026-10-02

The current, unfrozen working tree was checked after the subscription connection recovery. This is not a new sealed release or a deployment approval.

## Results

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit`, exit 0.
- Ordinary Vitest suite: `node node_modules/vitest/vitest.mjs run --no-file-parallelism --reporter=json --outputFile=.local/current-full-test-20261002.json`, exit 0.
- 304 result files; 3,166 passed, zero failed, 206 pending/skipped, 3,372 total.
- Report SHA-256: `0f55a05bb303c756e3314dc6fbc60caaabb293c30ecb07f03a336bf5d4255758`.
- The test process used `NODE_ENV=test`, with `DATABASE_URL` and `APTLSS_TEST_DATABASE_URL` empty. No production database connection was supplied.

## Limits

Subsequent runtime inspection found local Node 25.2.1 and Vitest 2.1.9, while
the release lock records Vitest 4.1.11 and CI targets Node 22. Consequently this
ordinary run is local development evidence only, not final release-toolchain
acceptance. The runner/supervisor changes made after this run also require a
new full-source run. `verify-release-test-runtime.mjs` now rejects this local
mismatch, and both CI jobs require that check. Its five mismatch-detection
tests passed; the actual local preflight correctly exited 1. No dependency
installation or remote CI execution was performed for this inspection.

Skipped tests are not successful verification. This ordinary test run does not replace opt-in isolated MySQL integration tests, compiled browser acceptance, live provider acceptance, restored-data binary rollback, target-host restart supervision or the human-reviewed shadow trial. It does not prove that the operational image matches the working source. No application deployment, commit or push was performed.
