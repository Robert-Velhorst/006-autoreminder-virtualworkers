import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { dockerRunner, POLICY_PATH, promoteScannedImage, REPOSITORY } from './promote-scanned-image.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;
const runtimeDigest = `sha256:${'c'.repeat(64)}`;
const sourceRef = `${REPOSITORY}@${digest}`;
const now = new Date('2026-10-21T12:00:00.000Z');
const imageType = 'application/vnd.oci.image.manifest.v1+json';
const sha = value => createHash('sha256').update(value).digest('hex');
function databaseMetadata(at) {
  const time = new Date(at).getTime();
  return { Version: 2, UpdatedAt: new Date(time - 60 * 60_000).toISOString(),
    DownloadedAt: new Date(time - 60_000).toISOString(), NextUpdate: new Date(time + 60 * 60_000).toISOString() };
}
function fixture() {
  const tempRoot = resolve(tmpdir(), 'isolated-promotion-fixture');
  const input = { repository: REPOSITORY, builtDigest: digest, releaseTag: 'v1.2.3', isPrerelease: 'false', proofPath: join(tempRoot, 'image-security-release.json') };
  const report = Buffer.from(JSON.stringify({ Metadata: { ImageID: imageId }, Results: [] }));
  const policy = Buffer.from(JSON.stringify({ version: 1 }));
  const database = Buffer.from(JSON.stringify(databaseMetadata(now)));
  const proof = { version: 1, passed: true, sourceRef, imageId, imageDigest: digest, platform: 'linux/amd64',
    scanner: { name: 'trivy', version: '0.76.0', archiveSha256: 'e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7' },
    reportSha256: sha(report), databaseMetadataSha256: sha(database), policySha256: sha(policy), scannedAt: now.toISOString(), summary: { passed: true } };
  const runtime = { mediaType: imageType, digest: runtimeDigest, platform: { os: 'linux', architecture: 'amd64' } };
  const state = { proof, report, policy, database, calls: [], evaluations: [], reads: [], mutate: () => {},
    manifest: { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [runtime,
      { mediaType: imageType, digest: `sha256:${'d'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': runtimeDigest } }] },
    image: { Id: imageId, Os: 'linux', Architecture: 'amd64', RepoDigests: [sourceRef] },
    runtimeManifest: { schemaVersion: 2, mediaType: imageType, config: { digest: imageId } },
    promotedDigest: digest,
  };
  const dependencies = {
    tempRoot,
    now: () => now,
    readArtifact(path, maximum) {
      state.reads.push(path);
      if (path === input.proofPath) return Buffer.from(JSON.stringify(state.proof));
      if (path === `${input.proofPath}.trivy.json`) return state.report;
      if (path === `${input.proofPath}.database.json`) {
        assert.equal(maximum, 1024 * 1024);
        if (state.database === null) throw new Error('Missing database artifact');
        return state.database;
      }
      if (path === POLICY_PATH) return state.policy;
      throw new Error('Unexpected artifact path');
    },
    evaluatePolicy(raw, currentPolicy, options) {
      state.evaluations.push({ raw, currentPolicy, options });
      assert.equal(raw.Metadata.ImageID, options.imageId);
      assert.equal(options.now.toISOString(), now.toISOString());
      assert.deepEqual(options.databaseMetadata, JSON.parse(state.database));
      return { passed: true };
    },
    runDocker(args) {
      state.calls.push(args);
      if (args.includes('--raw')) return JSON.stringify(args[3] === sourceRef ? state.manifest : state.runtimeManifest);
      if (args[0] === 'pull') return '';
      if (args[0] === 'image') { state.mutate(); return JSON.stringify(state.image); }
      if (args[2] === 'create') return '';
      if (args.includes('--format')) return `${args[3] === sourceRef ? digest : state.promotedDigest}\n`;
      throw new Error('Unexpected Docker invocation');
    },
  };
  return { input, state, dependencies };
}
const mutations = state => state.calls.filter(args => args[2] === 'create');

function completeReport(createdAt) {
  return { SchemaVersion: 2, ArtifactType: 'container_image', CreatedAt: createdAt,
    Trivy: { Version: '0.76.0' }, Metadata: { ImageID: imageId, OS: { Family: 'alpine', Name: '3.24.0', EOSL: false } },
    Results: [
      { Target: 'alpine', Class: 'os-pkgs', Type: 'alpine', Packages: [{ ID: 'musl', Name: 'musl', Version: '1.2.5' }] },
      { Target: 'Node.js', Class: 'lang-pkgs', Type: 'node-pkg', Packages: ['express', 'pg', 'drizzle-orm'].map(Name => ({
        ID: Name, Name, Version: '1.2.3', FilePath: `app/node_modules/${Name}/package.json`,
      })) },
    ] };
}

test('uses the actual policy evaluator by default and binds its report config identity', async () => {
  const { input, state, dependencies } = fixture();
  delete dependencies.evaluatePolicy;
  state.report = Buffer.from(JSON.stringify(completeReport(now.toISOString())));
  state.policy = readFileSync(POLICY_PATH);
  state.proof.reportSha256 = sha(state.report); state.proof.policySha256 = sha(state.policy);
  await promoteScannedImage(input, dependencies);
  assert.equal(mutations(state).length, 1);
  state.calls.length = 0;
  const wrong = completeReport(now.toISOString()); wrong.Metadata.ImageID = runtimeDigest;
  state.report = Buffer.from(JSON.stringify(wrong)); state.proof.reportSha256 = sha(state.report);
  await assert.rejects(promoteScannedImage(input, dependencies), /INVALID_REPORT_IDENTITY/);
  assert.equal(state.calls.length, 0);
});

for (const [label, alter] of [
  ['unsupported database version', value => { value.Version = 1; }],
  ['stale database update', value => { value.UpdatedAt = new Date(now.getTime() - 49 * 60 * 60_000).toISOString(); }],
  ['stale database download', value => { value.DownloadedAt = new Date(now.getTime() - 61 * 60_000).toISOString(); }],
  ['expired database', value => { value.NextUpdate = now.toISOString(); }],
  ['future database update', value => { value.UpdatedAt = new Date(now.getTime() + 6 * 60_000).toISOString(); }],
  ['future database download', value => { value.DownloadedAt = new Date(now.getTime() + 6 * 60_000).toISOString(); }],
  ['missing database timestamp', value => { delete value.DownloadedAt; }],
]) {
  test(`actual policy rejects hash-bound ${label} before Docker`, async () => {
    const { input, state, dependencies } = fixture();
    delete dependencies.evaluatePolicy;
    state.report = Buffer.from(JSON.stringify(completeReport(now.toISOString())));
    state.policy = readFileSync(POLICY_PATH);
    state.proof.reportSha256 = sha(state.report); state.proof.policySha256 = sha(state.policy);
    const metadata = databaseMetadata(now); alter(metadata);
    state.database = Buffer.from(JSON.stringify(metadata)); state.proof.databaseMetadataSha256 = sha(state.database);
    await assert.rejects(promoteScannedImage(input, dependencies));
    assert.equal(state.calls.length, 0);
  });
}

test('promotes the exact scanned immutable index with attestations, without annotation or new build', async () => {
  const { input, state, dependencies } = fixture();
  const result = await promoteScannedImage(input, dependencies);
  assert.deepEqual(mutations(state), [[
    'buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${REPOSITORY}:v1.2.3`, '--tag', `${REPOSITORY}:latest`, sourceRef,
  ]]);
  assert.equal(result.sourceRef, sourceRef);
  assert.equal(result.imageId, imageId);
  assert.deepEqual(state.calls.slice(-2).map(args => args[3]), result.tags);
  assert.equal(state.evaluations.length, 2);
  assert.equal(state.reads.filter(path => path === POLICY_PATH).length, 2);
  assert.equal(state.reads.filter(path => path === `${input.proofPath}.database.json`).length, 2);
  assert.deepEqual(state.calls.find(args => args[0] === 'pull'), ['pull', '--platform', 'linux/amd64', sourceRef]);
  assert.ok(state.calls.some(args => args[3] === `${REPOSITORY}@${runtimeDigest}` && args.includes('--raw')));
});

for (const [label, path] of [
  ['relative filename', () => 'image-security-release.json'],
  ['traversal', root => `${root}/../image-security-release.json`],
  ['same-directory traversal alias', root => `${root}/sub/../image-security-release.json`],
  ['sibling-prefix directory', root => `${root}-other/image-security-release.json`],
  ['unrelated secret path', root => join(root, '.env')],
  ['different filename', root => join(root, 'scan.json')],
  ['encoded traversal', root => `${root}/%2e%2e/image-security-release.json`],
  ['opposite separator alias', root => `${root}${process.platform === 'win32' ? '/' : '\\'}image-security-release.json`],
]) {
  test(`rejects ${label} before reading any artifact or invoking Docker`, async () => {
    const { input, state, dependencies } = fixture();
    input.proofPath = path(dependencies.tempRoot);
    await assert.rejects(promoteScannedImage(input, dependencies), /canonical release artifact/);
    assert.equal(state.reads.length, 0);
    assert.equal(state.calls.length, 0);
  });
}

for (const root of ['', '.', 'relative/directory']) {
  test(`rejects missing or relative trusted temporary root ${JSON.stringify(root)} before reads`, async () => {
    const { input, state, dependencies } = fixture(); dependencies.tempRoot = root;
    await assert.rejects(promoteScannedImage(input, dependencies), /absolute trusted RUNNER_TEMP/);
    assert.equal(state.reads.length, 0); assert.equal(state.calls.length, 0);
  });
}

test('rc promotion never writes or inspects latest', async () => {
  const { input, state, dependencies } = fixture();
  input.releaseTag = 'v2.0.0-rc.1'; input.isPrerelease = 'true';
  const result = await promoteScannedImage(input, dependencies);
  assert.deepEqual(result.tags, [`${REPOSITORY}:v2.0.0-rc.1`]);
  assert.equal(state.calls.flat().some(value => value.includes(':latest')), false);
});

test('accepts a single-image manifest without wrapping it in a new index', async () => {
  const { input, state, dependencies } = fixture();
  state.manifest = { schemaVersion: 2, mediaType: imageType, config: { digest: imageId } };
  await promoteScannedImage(input, dependencies);
  assert.ok(mutations(state)[0].includes('--prefer-index=false'));
});

for (const [key, value] of [
  ['repository', `${REPOSITORY}/other`], ['repository', 'ghcr.io/other/image'],
  ['builtDigest', `sha256:${'A'.repeat(64)}`], ['builtDigest', 'latest'],
  ['releaseTag', 'latest'], ['releaseTag', 'v1.2.3;touch /tmp/no'], ['releaseTag', '$(id)'],
  ['releaseTag', '--tag=elsewhere'], ['releaseTag', 'v01.2.3'], ['releaseTag', 'v1.2.3+build'],
  ['releaseTag', 'v1.2.3-beta.1'], ['releaseTag', 'v1.2.3-rc.01'], ['releaseTag', 'v1.2.3-rc.1'],
  ['isPrerelease', 'TRUE'], ['isPrerelease', 'true'], ['proofPath', ''],
]) {
  test(`rejects invalid ${key}: ${value} before any Docker command`, async () => {
    const { input, state, dependencies } = fixture();
    input[key] = value;
    await assert.rejects(promoteScannedImage(input, dependencies));
    assert.equal(state.calls.length, 0);
  });
}

for (const [label, alter] of [
  ['missing proof', s => { s.proof = null; }], ['failed proof', s => { s.proof.passed = false; }],
  ['nonboolean pass', s => { s.proof.passed = 'true'; }], ['version', s => { s.proof.version = 2; }],
  ['mutable source', s => { s.proof.sourceRef = `${REPOSITORY}:candidate`; }],
  ['different digest', s => { s.proof.imageDigest = runtimeDigest; }],
  ['missing registry digest', s => { s.proof.imageDigest = null; }],
  ['config id', s => { s.proof.imageId = 'invalid'; }], ['platform', s => { s.proof.platform = 'linux/arm64'; }],
  ['scanner version', s => { s.proof.scanner.version = '0.75.0'; }], ['scanner hash', s => { s.proof.scanner.archiveSha256 = '0'.repeat(64); }],
  ['stale proof', s => { s.proof.scannedAt = new Date(now.getTime() - 3_600_001).toISOString(); }],
  ['future proof', s => { s.proof.scannedAt = new Date(now.getTime() + 1).toISOString(); }],
  ['invalid date', s => { s.proof.scannedAt = 'today'; }],
  ['changed report', s => { s.report = Buffer.from('{}'); }], ['changed policy', s => { s.policy = Buffer.from('{}'); }],
  ['missing database metadata', s => { s.database = null; }],
  ['missing database hash', s => { delete s.proof.databaseMetadataSha256; }],
  ['uppercase database hash', s => { s.proof.databaseMetadataSha256 = s.proof.databaseMetadataSha256.toUpperCase(); }],
  ['changed database metadata', s => { s.database = Buffer.from('{}'); }],
  ['failed summary', s => { s.proof.summary.passed = false; }],
]) {
  test(`rejects ${label} before Docker`, async () => {
    const { input, state, dependencies } = fixture(); alter(state);
    await assert.rejects(promoteScannedImage(input, dependencies));
    assert.equal(state.calls.length, 0);
  });
}

test('policy failures cannot be bypassed by a passing proof', async () => {
  const { input, state, dependencies } = fixture();
  dependencies.evaluatePolicy = () => { throw new Error('Unaccepted vulnerability'); };
  await assert.rejects(promoteScannedImage(input, dependencies));
  assert.equal(state.calls.length, 0);
});

for (const [label, alter] of [
  ['extra runtime', s => { s.manifest.manifests.push({ ...s.manifest.manifests[0], platform: { os: 'linux', architecture: 'arm64' } }); }],
  ['duplicate runtime', s => { s.manifest.manifests.push({ ...s.manifest.manifests[0] }); }],
  ['unrelated attestation', s => { s.manifest.manifests[1].annotations['vnd.docker.reference.digest'] = imageId; }],
  ['unknown unchecked image', s => { delete s.manifest.manifests[1].annotations; }],
  ['wrong candidate config', s => { s.image.Id = runtimeDigest; }], ['wrong pulled platform', s => { s.image.Architecture = 'arm64'; }],
  ['missing candidate digest', s => { s.image.RepoDigests = []; }],
  ['unsupported source', s => { s.manifest.mediaType = 'unrecognized'; }],
  ['runtime leaf config mismatch', s => { s.runtimeManifest.config.digest = runtimeDigest; }],
  ['nested runtime index', s => { s.runtimeManifest = s.manifest; }],
]) {
  test(`rejects ${label} before tag mutation`, async () => {
    const { input, state, dependencies } = fixture(); alter(state);
    await assert.rejects(promoteScannedImage(input, dependencies));
    assert.equal(mutations(state).length, 0);
  });
}

test('evidence modified during candidate inspection fails the final pre-mutation validation', async () => {
  const { input, state, dependencies } = fixture();
  state.mutate = () => { state.report = Buffer.from('{}'); };
  await assert.rejects(promoteScannedImage(input, dependencies));
  assert.equal(mutations(state).length, 0);
});

test('database metadata modified during candidate inspection prevents promotion', async () => {
  const { input, state, dependencies } = fixture();
  state.mutate = () => { state.database = Buffer.from('{}'); };
  await assert.rejects(promoteScannedImage(input, dependencies), /metadata hash/);
  assert.equal(mutations(state).length, 0);
});

test('a policy failure on final re-evaluation prevents mutation', async () => {
  const { input, state, dependencies } = fixture();
  const evaluate = dependencies.evaluatePolicy;
  dependencies.evaluatePolicy = (...args) => { if (state.evaluations.length) throw new Error('Policy changed'); return evaluate(...args); };
  await assert.rejects(promoteScannedImage(input, dependencies));
  assert.equal(mutations(state).length, 0);
});

test('reports a promoted-tag digest mismatch as failure, without claiming success or rebuilding', async () => {
  const { input, state, dependencies } = fixture(); state.promotedDigest = runtimeDigest;
  await assert.rejects(promoteScannedImage(input, dependencies), /tags may already have changed/);
  assert.equal(mutations(state).length, 1);
});

test('Docker transport uses execFileSync argv, never a shell, and bounded resources', () => {
  const calls = [];
  const run = dockerRunner((...args) => { calls.push(args); return 'ok'; });
  const argv = ['buildx', 'imagetools', 'inspect', sourceRef];
  assert.equal(run(argv), 'ok');
  assert.equal(calls[0][0], 'docker'); assert.deepEqual(calls[0][1], argv);
  assert.equal(calls[0][2].shell, false); assert.equal(calls[0][2].timeout, 120_000);
  assert.equal(calls[0][2].maxBuffer, 16 * 1024 * 1024);
  assert.throws(() => dockerRunner(() => { throw new Error('private provider output'); })(argv), /Bounded Docker command failed/);
});

test('actual Node CLI validates disk proof and current policy with Docker subprocess transport mocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-cli-'));
  try {
    const { input, state } = fixture();
    const proofPath = join(dir, 'image-security-release.json');
    const commandLog = join(dir, 'docker-calls.jsonl');
    const transportPath = join(dir, 'transport.json');
    const preload = join(dir, 'mock-docker.mjs');
    const createdAt = new Date().toISOString();
    const report = JSON.stringify(completeReport(createdAt));
    state.proof.scannedAt = createdAt; state.proof.reportSha256 = sha(report);
    const metadata = JSON.stringify(databaseMetadata(createdAt));
    state.proof.databaseMetadataSha256 = sha(metadata);
    state.proof.policySha256 = sha(readFileSync(POLICY_PATH));
    writeFileSync(proofPath, JSON.stringify(state.proof));
    writeFileSync(`${proofPath}.trivy.json`, report);
    writeFileSync(`${proofPath}.database.json`, metadata);
    writeFileSync(transportPath, JSON.stringify({ sourceRef, digest, manifest: state.manifest, runtimeManifest: state.runtimeManifest, image: state.image, commandLog }));
    writeFileSync(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { readFileSync, appendFileSync } from 'node:fs';
      const fixture = JSON.parse(readFileSync(${JSON.stringify(transportPath)}, 'utf8'));
      cp.execFileSync = (file, args, options) => {
        if (file !== 'docker' || options.shell !== false || options.timeout !== 120000) throw new Error('Unexpected transport');
        appendFileSync(fixture.commandLog, JSON.stringify(args) + '\\n');
        if (args.includes('--raw')) return JSON.stringify(args[3] === fixture.sourceRef ? fixture.manifest : fixture.runtimeManifest);
        if (args[0] === 'image') return JSON.stringify(fixture.image);
        if (args[0] === 'pull' || args[2] === 'create') return '';
        if (args.includes('--format')) return fixture.digest + '\\n';
        throw new Error('Unexpected Docker command');
      };
      syncBuiltinESMExports();
    `);
    const script = fileURLToPath(new URL('./promote-scanned-image.mjs', import.meta.url));
    const args = ['--import', pathToFileURL(preload).href, script, REPOSITORY, digest, input.releaseTag, input.isPrerelease, proofPath];
    const cliOptions = { cwd: dir, encoding: 'utf8', timeout: 15_000, env: { ...process.env, RUNNER_TEMP: dir } };
    const result = spawnSync(process.execPath, args, cliOptions);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sourceRef, sourceRef);
    const calls = readFileSync(commandLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call[2] === 'create').length, 1);
    assert.equal(calls.find(call => call[2] === 'create').at(-1), sourceRef);
    assert.deepEqual(calls.slice(-2).map(call => call[3]), [`${REPOSITORY}:v1.2.3`, `${REPOSITORY}:latest`]);
    rmSync(commandLog);
    const alternate = join(dir, 'other-proof.json');
    writeFileSync(alternate, JSON.stringify(state.proof));
    writeFileSync(`${alternate}.trivy.json`, report); writeFileSync(`${alternate}.database.json`, metadata);
    for (const untrusted of [alternate, 'image-security-release.json', `${dir}/sub/../image-security-release.json`, `${dir}-sibling/image-security-release.json`, join(dir, '.env')]) {
      const denied = spawnSync(process.execPath, [...args.slice(0, -1), untrusted], cliOptions);
      assert.equal(denied.status, 1);
      assert.equal(existsSync(commandLog), false, 'Noncanonical argv proof path must not reach Docker');
    }
    state.proof.reportSha256 = '0'.repeat(64); writeFileSync(proofPath, JSON.stringify(state.proof));
    const rejected = spawnSync(process.execPath, args, cliOptions);
    assert.equal(rejected.status, 1);
    assert.equal(existsSync(commandLog), false, 'Invalid evidence must not reach even mocked Docker');
    state.proof.reportSha256 = sha(report);
    const oversized = Buffer.alloc(1024 * 1024 + 1, ' ');
    state.proof.databaseMetadataSha256 = sha(oversized);
    writeFileSync(proofPath, JSON.stringify(state.proof)); writeFileSync(`${proofPath}.database.json`, oversized);
    const oversizedResult = spawnSync(process.execPath, args, cliOptions);
    assert.equal(oversizedResult.status, 1);
    assert.equal(existsSync(commandLog), false, 'Oversized database metadata must not reach Docker');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const gitBash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
test('actual bash wrapper forwards all arguments literally to Node', { skip: !existsSync(gitBash) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-wrapper-'));
  try {
    const record = join(dir, 'record.mjs');
    writeFileSync(record, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const quoted = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    writeFileSync(join(dir, 'node'), `#!/usr/bin/env bash\nexec ${quoted(process.execPath)} ${quoted(record)} "$@"\n`, { mode: 0o755 });
    const script = fileURLToPath(new URL('./promote-scanned-image.sh', import.meta.url)).replaceAll('\\', '/');
    const args = [REPOSITORY, digest, 'v1.2.3;$(echo not-executed)', 'false', 'proof with spaces.json'];
    const result = spawnSync(gitBash, [script, ...args], { encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    const forwarded = JSON.parse(result.stdout.trim());
    assert.match(forwarded[0], /\/scripts\/promote-scanned-image\.mjs$/);
    assert.deepEqual(forwarded.slice(1), args);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
