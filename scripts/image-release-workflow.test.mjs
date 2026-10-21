import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

// These are source-wiring tripwires, not a YAML interpreter or a substitute
// for an actual scanned candidate, PostgreSQL acceptance and promotion run.
function ordered(source, values) {
  let previous = -1;
  for (const value of values) {
    const next = source.indexOf(value, previous + 1);
    assert.ok(next > previous, `Missing or out-of-order release prerequisite: ${value}`);
    previous = next;
  }
}

for (const name of ['ci.yml', 'publish-container.yml']) {
  test(`${name} retains isolated native database prerequisites and locked source checks`, () => {
    const source = read(name);
    assert.doesNotMatch(source, /^(?:<<<<<<<|=======|>>>>>>>)/m);
    for (const key of ['DATABASE_URL', 'APTLSS_TEST_DATABASE_URL', 'OWNER_PROVISIONING_TEST_DATABASE_URL']) {
      assert.match(source, new RegExp(`^      ${key}: postgresql:[^\\r\\n]+/recovery_test\\?sslmode=disable\\r?$`, 'm'));
    }
    assert.match(source, /APTLSS_TEST_DISABLE_BACKGROUND_JOBS: "true"/);
    assert.match(source, /NOTIFICATIONS_ENABLED: "false"/);
    ordered(source, ['pnpm install --frozen-lockfile', 'scripts/verify-native-test-fixture.mjs', 'drizzle-kit migrate']);
  });
}

test('release tests the immutable scanned candidate before attestation and promotion', () => {
  const source = read('publish-container.yml');
  ordered(source, ['name: Build and push candidate image', 'scripts/scan-production-image.sh',
    'scripts/verify-production-image.mjs', 'scripts/verify-postgres-production-image.mjs',
    'name: Attest image provenance', 'scripts/promote-scanned-image.sh']);
  for (const helper of ['scan-production-image.sh', 'verify-production-image.mjs', 'verify-postgres-production-image.mjs']) {
    assert.match(source, new RegExp(`${helper.replaceAll('.', '\\.')} "\\$IMAGE_REPOSITORY@\\$BUILD_DIGEST"`));
  }
  assert.match(source, /platforms: linux\/amd64/);
  assert.match(source, /tags: \$\{\{ steps\.image\.outputs\.repository \}\}:candidate-/);
  assert.doesNotMatch(source, /value=latest|va-dashboard:release-check/);
  assert.match(source, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(source, /BUILD_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.doesNotMatch(source, /continue-on-error:\s*(?:true|\$\{\{)/);
});

test('the ordinary test command retains both current-main and image-security Node contracts', () => {
  const command = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test;
  for (const file of ['e2e/api-rate-window.test.mjs', 'operator-data-transfer-utils.test.mjs', 'verify-postgres-production-image.test.mjs',
    'image-vulnerability-policy.test.mjs', 'scan-production-image.test.mjs', 'promote-scanned-image.test.mjs',
    'image-release-workflow.test.mjs', 'deployment/hetzner/production-gate.test.mjs',
    'deployment/hetzner/deploy-script.test.mjs', 'deployment/hetzner/deploy-script.integration.test.mjs']) {
    assert.ok(command.includes(file), `Required executable contract was dropped: ${file}`);
  }
});

test('CI retains one built image for scanning, runtime and configured PostgreSQL checks', () => {
  const source = read('ci.yml');
  assert.equal((source.match(/docker build --tag va-dashboard:ci/g) ?? []).length, 1);
  assert.match(source, /scan-production-image\.sh va-dashboard:ci/);
  assert.match(source, /verify-postgres-production-image\.mjs va-dashboard:ci/);
  ordered(source, ['docker build --tag va-dashboard:ci', 'scripts/scan-production-image.sh', 'scripts/verify-postgres-production-image.mjs']);
  for (const guard of ['client/src/components/timer.identity.test.mjs', 'scripts/verify-aptlss-safety.ts',
    'e2e/financial-ui.config.ts', 'e2e/atis-analysis-ui.config.ts',
    'Verify PostgreSQL backup and isolated restore', 'Verify migration metadata matches the schema']) {
    assert.ok(source.includes(guard), `Current-main verification was lost: ${guard}`);
  }
});

for (const [name, suffix] of [['ci.yml', 'ci'], ['publish-container.yml', 'release']]) {
  const source = read(name);
  const gate = source.slice(source.indexOf('      - name: Verify configured PostgreSQL'));
  const script = gate.match(/node --input-type=module -e '([\s\S]*?)^\s*'\s*$/m)?.[1];
  for (const defect of ['none', 'failed', 'cleanup missing', 'wrong image', 'missing receipt',
    ...(suffix === 'release' ? ['wrong source', 'wrong digest'] : [])]) {
    test(`${name} executes actual receipt validation and rejects ${defect}`, () => {
      assert.ok(script, 'Actual workflow receipt-validation script must exist');
      const root = mkdtempSync(join(tmpdir(), 'va-release-receipt-'));
      try {
        const artifacts = join(root, 'artifacts', 'image-security');
        mkdirSync(artifacts, { recursive: true });
        const repository = 'ghcr.io/robert-velhorst/006-autoreminder-virtualworkers';
        const digest = `sha256:${'a'.repeat(64)}`;
        const imageId = `sha256:${'b'.repeat(64)}`;
        const receipt = { passed: defect !== 'failed', cleanupConfirmed: defect !== 'cleanup missing',
          imageId: defect === 'wrong image' ? `sha256:${'c'.repeat(64)}` : imageId };
        const scan = { imageId, sourceRef: defect === 'wrong source' ? `${repository}:latest` : `${repository}@${digest}`,
          imageDigest: defect === 'wrong digest' ? `sha256:${'d'.repeat(64)}` : digest };
        if (defect !== 'missing receipt') {
          writeFileSync(join(artifacts, `postgres-image-${suffix}.json`), JSON.stringify(receipt));
        }
        writeFileSync(join(artifacts, `image-security-${suffix}.json`), JSON.stringify(scan));
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: root, encoding: 'utf8', timeout: 10000,
          env: { ...process.env, IMAGE_REPOSITORY: repository, BUILD_DIGEST: digest },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status === 0, defect === 'none', `Unexpected gate result for ${defect}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
