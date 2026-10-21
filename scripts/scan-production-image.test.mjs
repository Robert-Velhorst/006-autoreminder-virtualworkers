import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_REPOSITORY, SCANNER, runtimeManifestDigest, scanProductionImage, scannerEnvironment, sha256, verifyScannerArchive } from './scan-production-image.mjs';

const imageId = `sha256:${'1'.repeat(64)}`;
const imageDigest = `sha256:${'2'.repeat(64)}`;
const leafDigest = `sha256:${'3'.repeat(64)}`;
const now = new Date('2026-10-21T01:00:00Z');
const imageType = 'application/vnd.oci.image.manifest.v1+json';
const descriptor = () => ({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', digest: imageDigest,
  manifests: [{ digest: leafDigest, mediaType: imageType, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${'4'.repeat(64)}`, mediaType: imageType, platform: { os: 'unknown', architecture: 'unknown' },
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': leafDigest } }] });
const report = () => ({ SchemaVersion: 2, ArtifactType: 'container_image', ArtifactName: 'image.tar', CreatedAt: now.toISOString(),
  Trivy: { Version: SCANNER.version }, Metadata: { ImageID: imageId, ImageConfig: { architecture: 'amd64', os: 'linux' }, OS: { Family: 'alpine', Name: '3.24.0' } },
  Results: [{ Target: 'image.tar (alpine 3.24.0)', Class: 'os-pkgs', Type: 'alpine', Packages: [{ ID: 'musl@1.2.5', Name: 'musl', Version: '1.2.5' }] },
    { Target: 'Node.js', Class: 'lang-pkgs', Type: 'node-pkg', Packages: ['express', 'pg', 'drizzle-orm'].map(Name =>
      ({ ID: `${Name}@5.0.0`, Name, Version: '5.0.0', FilePath: `app/node_modules/${Name}/package.json` })) }] });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'va-image-gate-test-'));
  const proofPath = join(root, 'proof.json');
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, '{"version":1,"exceptions":[]}');
  const state = { calls: [], descriptor: descriptor(), image: { Id: imageId, Os: 'linux', Architecture: 'amd64' },
    leaf: { schemaVersion: 2, mediaType: imageType, config: { digest: imageId } }, report: report(),
    database: { Version: 2, UpdatedAt: '2026-10-21T00:00:00Z', NextUpdate: '2026-10-21T06:00:00Z', DownloadedAt: now.toISOString() },
    version: `Version: ${SCANNER.version}\n`, scannerFailure: false, omitReport: false, omitDatabase: false, dockerFailure: false };
  const options = { temporaryRoot: root, policyPath, now: () => now, provisionScanner: async () => '/verified/trivy',
    run(command, args, options = {}) {
      state.calls.push({ command, args, options });
      if (command === 'docker') {
        if (state.dockerFailure) throw new Error('Docker unavailable');
        if (args.includes('--raw')) return JSON.stringify(state.leaf);
        if (args.includes('--format')) return JSON.stringify(state.descriptor);
        if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([state.image]);
        return '';
      }
      assert.equal(command, '/verified/trivy');
      if (args[0] === '--version') return state.version;
      if (state.scannerFailure) throw new Error('Scanner failed');
      if (!state.omitReport) writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(state.report));
      if (!state.omitDatabase) {
        const databaseDir = join(args[args.indexOf('--cache-dir') + 1], 'db');
        mkdirSync(databaseDir, { recursive: true });
        writeFileSync(join(databaseDir, 'metadata.json'), JSON.stringify(state.database));
      }
      return '';
    } };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, proofPath, policyPath, state, options, cleanup };
}

test('scans the immutable local image ID, verifies full coverage and writes a bound proof', async () => {
  const f = fixture();
  try {
    const proof = await scanProductionImage('va-dashboard:ci', f.proofPath, f.options);
    assert.equal(proof.passed, true);
    assert.equal(proof.imageId, imageId);
    assert.equal(proof.imageDigest, null);
    assert.equal(proof.summary.installedRuntimePackageCount, 3);
    assert.equal(proof.reportSha256, sha256(readFileSync(`${f.proofPath}.trivy.json`)));
    assert.equal(proof.policySha256, sha256(readFileSync(f.policyPath)));
    assert.equal(proof.databaseMetadataSha256, sha256(readFileSync(`${f.proofPath}.database.json`)));
    assert.equal(JSON.parse(readFileSync(f.proofPath)).sourceRef, 'va-dashboard:ci');
    const save = f.state.calls.find(call => call.command === 'docker' && call.args[1] === 'save');
    assert.equal(save.args.at(-1), imageId);
    const scan = f.state.calls.find(call => call.command === '/verified/trivy' && call.args[0] === 'image');
    for (const flag of ['--list-all-pkgs', '--ignore-unfixed=false', '--disable-telemetry']) assert.ok(scan.args.includes(flag));
    assert.equal(scan.args[scan.args.indexOf('--scanners') + 1], 'vuln');
    assert.equal(scan.args[scan.args.indexOf('--pkg-types') + 1], 'os,library');
    assert.equal(scan.args[scan.args.indexOf('--severity') + 1], 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL');
    assert.equal(scan.args[scan.args.indexOf('--input') + 1], 'image.tar');
    assert.equal(scan.args[scan.args.indexOf('--exit-code') + 1], '0');
    assert.equal(scan.options.timeout, 660_000);
    assert.ok(!readdirSync(f.root).some(name => name.startsWith('va-image-security-')));
  } finally { f.cleanup(); }
});

test('binds a registry index to the single scanned runtime configuration', async () => {
  const f = fixture();
  try {
    const source = `${IMAGE_REPOSITORY}@${imageDigest}`;
    const proof = await scanProductionImage(source, f.proofPath, f.options);
    assert.equal(proof.sourceRef, source);
    assert.equal(proof.imageDigest, imageDigest);
    assert.ok(f.state.calls.some(call => call.args.includes(`${IMAGE_REPOSITORY}@${leafDigest}`)));
    assert.ok(f.state.calls.some(call => call.args[0] === 'pull' && call.args.at(-1) === source));
  } finally { f.cleanup(); }
});

for (const [name, change] of [
  ['scanner error', f => { f.state.scannerFailure = true; }],
  ['missing report', f => { f.state.omitReport = true; }],
  ['missing database metadata', f => { f.state.omitDatabase = true; }],
  ['stale vulnerability database', f => { f.state.database.UpdatedAt = '2026-10-15T00:00:00Z'; }],
  ['wrong report identity', f => { f.state.report.Metadata.ImageID = `sha256:${'9'.repeat(64)}`; }],
  ['missing package coverage', f => { f.state.report.Results.pop(); }],
  ['unexpected scanner version', f => { f.state.version = 'Version: 0.69.4'; }],
  ['Docker error', f => { f.state.dockerFailure = true; }],
  ['wrong runtime platform', f => { f.state.image.Architecture = 'arm64'; }],
  ['unfixed high vulnerability', f => { f.state.report.Results[0].Vulnerabilities = [{ VulnerabilityID: 'CVE-2026-12345', PkgID: 'musl@1.2.5', PkgName: 'musl', InstalledVersion: '1.2.5', Severity: 'HIGH' }]; }],
]) test(`fails closed and removes a stale successful proof on ${name}`, async () => {
  const f = fixture();
  try {
    writeFileSync(f.proofPath, '{"passed":true}');
    change(f);
    await assert.rejects(scanProductionImage('va-dashboard:ci', f.proofPath, f.options));
    assert.ok(!readdirSync(f.root).includes('proof.json'));
    assert.ok(!readdirSync(f.root).some(name => name.endsWith('.partial') || name.startsWith('va-image-security-')));
  } finally { f.cleanup(); }
});

test('rejects a runtime configuration unrelated to the selected registry manifest', async () => {
  const f = fixture();
  try {
    f.state.leaf.config.digest = `sha256:${'9'.repeat(64)}`;
    await assert.rejects(scanProductionImage(`${IMAGE_REPOSITORY}@${imageDigest}`, f.proofPath, f.options), /identity/);
    assert.ok(!f.state.calls.some(call => call.args[1] === 'save'));
  } finally { f.cleanup(); }
});

test('does not inherit scanner override variables or provider credentials', () => {
  const clean = scannerEnvironment({ PATH: '/bin', HOME: '/home/runner', TRIVY_SKIP_FILES: '**', TRIVY_IGNORE_UNFIXED: 'true',
    GITHUB_TOKEN: 'synthetic', DATABASE_URL: 'synthetic', NODE_OPTIONS: '--require=untrusted', HTTPS_PROXY: 'https://proxy.example' });
  assert.deepEqual(clean, { PATH: '/bin', HOME: '/home/runner', HTTPS_PROXY: 'https://proxy.example' });
});

test('rejects wrong scanner archive checksums before extraction', () => {
  assert.throws(() => verifyScannerArchive(Buffer.from('not the verified scanner')), /checksum/);
});

test('accepts one runtime plus matching attestations and a direct manifest', () => {
  assert.equal(runtimeManifestDigest(descriptor(), imageDigest), leafDigest);
  assert.equal(runtimeManifestDigest({ schemaVersion: 2, mediaType: imageType, digest: imageDigest }, imageDigest), imageDigest);
});

for (const [name, change] of [
  ['extra runtime platform', d => { d.manifests.push({ digest: `sha256:${'5'.repeat(64)}`, mediaType: imageType, platform: { os: 'linux', architecture: 'arm64' } }); }],
  ['two amd64 images', d => { d.manifests.push({ ...d.manifests[0], digest: `sha256:${'5'.repeat(64)}` }); }],
  ['unrelated attestation', d => { d.manifests[1].annotations['vnd.docker.reference.digest'] = `sha256:${'5'.repeat(64)}`; }],
  ['unknown unchecked manifest', d => { delete d.manifests[1].annotations; }],
  ['wrong registry digest', d => { d.digest = `sha256:${'5'.repeat(64)}`; }],
  ['duplicate descriptor', d => { d.manifests.push(d.manifests[1]); }],
]) test(`rejects registry manifests with ${name}`, () => {
  const d = descriptor(); change(d);
  assert.throws(() => runtimeManifestDigest(d, imageDigest));
});

test('rejects mutable registry references and paths outside runner temporary storage before Docker', async () => {
  const f = fixture();
  try {
    await assert.rejects(scanProductionImage(`${IMAGE_REPOSITORY}:latest`, f.proofPath, f.options));
    await assert.rejects(scanProductionImage('va-dashboard:ci', join(f.root, '..', 'not-owned.json'), f.options));
    assert.equal(f.state.calls.length, 0);
  } finally { f.cleanup(); }
});

test('actual scanner CLI rejects mutable input before any external executable is available', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./scan-production-image.mjs', import.meta.url)),
      `${IMAGE_REPOSITORY}:latest`, f.proofPath], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: '', RUNNER_TEMP: f.root },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Only the local CI image or a pinned VA Dashboard registry digest/);
    assert.ok(!readdirSync(f.root).includes('proof.json'));
  } finally { f.cleanup(); }
});

test('actual scanner CLI cannot overwrite files outside its runner temporary root', () => {
  const f = fixture();
  try {
    const runner = join(f.root, 'runner'); mkdirSync(runner);
    const sentinel = join(f.root, 'retained.txt'); writeFileSync(sentinel, 'Retain this private fixture');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./scan-production-image.mjs', import.meta.url)),
      'va-dashboard:ci', sentinel], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: '', RUNNER_TEMP: runner },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside the runner temporary directory/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'Retain this private fixture');
    assert.ok(!result.stderr.includes('Retain this private fixture'));
  } finally { f.cleanup(); }
});
