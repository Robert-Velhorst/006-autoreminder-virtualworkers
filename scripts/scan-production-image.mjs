import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateImageVulnerabilityReport } from './image-vulnerability-policy.mjs';

export const SCANNER = Object.freeze({
  name: 'trivy', version: '0.76.0',
  archiveSha256: 'e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7',
});
export const IMAGE_REPOSITORY = 'ghcr.io/robert-velhorst/006-autoreminder-virtualworkers';
export const IMAGE_POLICY_PATH = fileURLToPath(new URL('../security/image-vulnerability-exceptions.json', import.meta.url));
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const indexTypes = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const manifestTypes = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Image security command failed: ${commandName}`);
  return result.stdout;
}

export function runtimeManifestDigest(descriptor, expectedDigest) {
  if (!descriptor || descriptor.schemaVersion !== 2 || descriptor.digest !== expectedDigest || !digestPattern.test(expectedDigest)) {
    throw new Error('Registry descriptor does not match the selected image digest');
  }
  if (manifestTypes.has(descriptor.mediaType)) return expectedDigest;
  if (!indexTypes.has(descriptor.mediaType) || !Array.isArray(descriptor.manifests) || descriptor.manifests.length > 16) {
    throw new Error('Unsupported registry image descriptor');
  }
  const runtime = descriptor.manifests.filter(item => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64');
  if (runtime.length !== 1 || !digestPattern.test(runtime[0].digest) || !manifestTypes.has(runtime[0].mediaType)) {
    throw new Error('Exactly one linux/amd64 runtime image must be scanned');
  }
  const seen = new Set();
  for (const item of descriptor.manifests) {
    if (!digestPattern.test(item.digest) || seen.has(item.digest)) throw new Error('Invalid or duplicate registry manifest');
    seen.add(item.digest);
    if (item === runtime[0]) {
      if (item.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' || item.platform.variant) {
        throw new Error('Invalid runtime platform descriptor');
      }
      continue;
    }
    if (item.platform?.os !== 'unknown' || item.platform?.architecture !== 'unknown'
      || !manifestTypes.has(item.mediaType)
      || item.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest'
      || item.annotations?.['vnd.docker.reference.digest'] !== runtime[0].digest) {
      throw new Error('Image index includes an unchecked runtime platform or unrelated manifest');
    }
  }
  return runtime[0].digest;
}

export function scannerEnvironment(environment = process.env) {
  const allowed = ['PATH', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries(allowed.filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]]));
}

export function verifyScannerArchive(bytes) {
  if (sha256(bytes) !== SCANNER.archiveSha256) throw new Error('Scanner download checksum mismatch');
}

async function installScanner(directory, run = command, request = fetch) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Pinned image scanner requires Linux x64');
  const url = `https://github.com/aquasecurity/trivy/releases/download/v${SCANNER.version}/trivy_${SCANNER.version}_Linux-64bit.tar.gz`;
  const response = await request(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 256 * 1024 * 1024) {
    throw new Error('Verified scanner download is unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Scanner download has no body');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256 * 1024 * 1024) throw new Error('Scanner download exceeds the size limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const archive = Buffer.concat(chunks);
  verifyScannerArchive(archive);
  const archivePath = join(directory, 'scanner.tar.gz');
  writeFileSync(archivePath, archive, { flag: 'wx', mode: 0o600 });
  run('tar', ['-xzf', archivePath, '-C', directory, 'trivy']);
  const binary = join(directory, 'trivy');
  chmodSync(binary, 0o700);
  return binary;
}

function readBounded(path) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > 64 * 1024 * 1024) {
    throw new Error('Image security report or policy is missing or oversized');
  }
  return readFileSync(path);
}

export async function scanProductionImage(imageRef, proofPath, {
  run = command, provisionScanner = installScanner, temporaryRoot = process.env.RUNNER_TEMP,
  policyPath = IMAGE_POLICY_PATH, now = () => new Date(),
} = {}) {
  const registryPrefix = `${IMAGE_REPOSITORY}@`;
  const imageDigest = imageRef?.startsWith(registryPrefix) ? imageRef.slice(registryPrefix.length) : null;
  if (imageRef !== 'va-dashboard:ci' && (!imageDigest || !digestPattern.test(imageDigest))) {
    throw new Error('Only the local CI image or a pinned VA Dashboard registry digest can be scanned');
  }
  if (!isAbsolute(proofPath ?? '') || !isAbsolute(temporaryRoot ?? '')) throw new Error('Absolute report and runner temporary paths are required');
  const target = resolve(proofPath);
  const withinRunner = relative(resolve(temporaryRoot), target);
  if (!withinRunner || withinRunner.startsWith('..') || isAbsolute(withinRunner)) throw new Error('Scan reports must remain inside the runner temporary directory');
  mkdirSync(dirname(target), { recursive: true });
  // An old successful proof must not survive an interrupted or failed new scan.
  rmSync(target, { force: true });
  const rawPath = `${target}.trivy.json`;
  rmSync(rawPath, { force: true });
  const databasePath = `${target}.database.json`;
  rmSync(databasePath, { force: true });
  const work = mkdtempSync(join(resolve(temporaryRoot), 'va-image-security-'));
  const partial = `${target}.${randomUUID()}.partial`;
  try {
    let leaf;
    if (imageDigest) {
      const descriptor = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', imageRef]));
      const runtimeDigest = runtimeManifestDigest(descriptor, imageDigest);
      leaf = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${IMAGE_REPOSITORY}@${runtimeDigest}`]));
      if (leaf.schemaVersion !== 2 || !manifestTypes.has(leaf.mediaType) || !digestPattern.test(leaf.config?.digest)) {
        throw new Error('Runtime manifest lacks a valid image configuration digest');
      }
      run('docker', ['pull', '--platform', 'linux/amd64', imageRef]);
    }
    const images = JSON.parse(run('docker', ['image', 'inspect', imageRef]));
    const image = Array.isArray(images) && images.length === 1 ? images[0] : null;
    if (!image || !digestPattern.test(image.Id) || image.Os !== 'linux' || image.Architecture !== 'amd64'
      || (leaf && leaf.config.digest !== image.Id)) throw new Error('Selected runtime image identity or platform does not match');
    const archivePath = join(work, 'image.tar');
    run('docker', ['image', 'save', '--output', archivePath, image.Id]);
    const scannerPath = await provisionScanner(work, run);
    const environment = scannerEnvironment();
    const version = run(scannerPath, ['--version'], { env: environment });
    if (!/^Version:\s*0\.76\.0\s*$/m.test(version)) throw new Error('Unexpected scanner executable version');
    const configPath = join(work, 'empty-config.json');
    const ignorePath = join(work, 'empty-ignore');
    writeFileSync(configPath, '{}', { flag: 'wx' });
    writeFileSync(ignorePath, '', { flag: 'wx' });
    run(scannerPath, ['image', '--config', configPath, '--cache-dir', join(work, 'cache'),
      '--input', 'image.tar', '--scanners', 'vuln', '--pkg-types', 'os,library',
      '--severity', 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL', '--ignore-unfixed=false',
      '--ignorefile', ignorePath, '--list-all-pkgs', '--disable-telemetry',
      '--exit-code', '0', '--format', 'json', '--output', rawPath, '--timeout', '10m'],
    { env: environment, cwd: work, timeout: 660_000 });
    const rawBytes = readBounded(rawPath);
    const databaseBytes = readBounded(join(work, 'cache', 'db', 'metadata.json'));
    writeFileSync(databasePath, databaseBytes, { flag: 'wx', mode: 0o600 });
    const policyBytes = readBounded(policyPath);
    const timestamp = now();
    const summary = evaluateImageVulnerabilityReport(JSON.parse(rawBytes), JSON.parse(policyBytes), {
      imageId: image.Id, now: timestamp, databaseMetadata: JSON.parse(databaseBytes),
    });
    if (summary?.passed !== true) throw new Error('Image vulnerability policy did not pass');
    const proof = { version: 1, passed: true, sourceRef: imageRef, imageId: image.Id, imageDigest,
      platform: 'linux/amd64', scanner: SCANNER, reportSha256: sha256(rawBytes),
      databaseMetadataSha256: sha256(databaseBytes), policySha256: sha256(policyBytes), scannedAt: timestamp.toISOString(), summary };
    writeFileSync(partial, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(partial, target);
    return proof;
  } finally {
    rmSync(partial, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Expected image reference and absolute proof path');
    const proof = await scanProductionImage(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ passed: true, sourceRef: proof.sourceRef, imageId: proof.imageId, summary: proof.summary }));
  } catch (error) { console.error(`Image vulnerability gate failed: ${error.message}`); process.exitCode = 1; }
}
