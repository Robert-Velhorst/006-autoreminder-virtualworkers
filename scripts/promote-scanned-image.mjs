import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMAGE_REPOSITORY, IMAGE_POLICY_PATH, SCANNER, runtimeManifestDigest, sha256 } from './scan-production-image.mjs';

export const REPOSITORY = IMAGE_REPOSITORY;
export const POLICY_PATH = IMAGE_POLICY_PATH;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);

function check(condition, message) { if (!condition) throw new Error(message); }
function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`Invalid ${label} JSON`); }
}
const hash = sha256;
function readArtifact(path, maximum) {
  check(statSync(path).isFile() && statSync(path).size <= maximum, 'Scan artifact is unavailable or too large');
  const data = readFileSync(path);
  check(data.length <= maximum, 'Scan artifact is too large');
  return data;
}

export function dockerRunner(execute = execFileSync) {
  return args => {
    try {
      return execute('docker', args, {
        encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { throw new Error('Bounded Docker command failed; promotion is not confirmed'); }
  };
}

function validateShape(manifest, imageId, registryDigest) {
  // Share the scanner's exact single-runtime/attestation policy.
  const runtimeDigest = runtimeManifestDigest({ ...manifest, digest: registryDigest }, registryDigest);
  if (IMAGE_TYPES.has(manifest.mediaType)) {
    check(manifest.config?.digest === imageId, 'Source manifest config differs from scanned image');
  }
  return runtimeDigest;
}

export async function promoteScannedImage(input, dependencies = {}) {
  check(input.repository === REPOSITORY, 'Repository is not authorized for promotion');
  check(typeof input.builtDigest === 'string' && DIGEST.test(input.builtDigest), 'Invalid build digest');
  const tag = typeof input.releaseTag === 'string'
    ? /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$/.exec(input.releaseTag) : null;
  check(tag && input.releaseTag.length <= 128, 'Release tag must be stable or rc semantic version');
  check(input.isPrerelease === 'true' || input.isPrerelease === 'false', 'Prerelease flag must be true or false');
  const prerelease = input.isPrerelease === 'true';
  check(Boolean(tag[4]) === prerelease, 'Release tag and prerelease flag disagree');
  check(typeof input.proofPath === 'string' && input.proofPath.length > 0, 'A scan proof path is required');

  const read = dependencies.readArtifact ?? readArtifact;
  const run = dependencies.runDocker ?? dockerRunner();
  const now = dependencies.now ?? (() => new Date());
  const sourceRef = `${REPOSITORY}@${input.builtDigest}`;
  // No caller-controlled policy path or CLI bypass of the pinned evaluator.
  const evaluate = dependencies.evaluatePolicy
    ?? (await import('./image-vulnerability-policy.mjs')).evaluateImageVulnerabilityReport;
  check(typeof evaluate === 'function', 'Image vulnerability evaluator is unavailable');

  function validateProof() {
    const proof = parseJson(read(input.proofPath, 1024 * 1024), 'scan proof');
    check(proof?.version === 1 && proof.passed === true, 'A passing version-one scan proof is required');
    check(proof.sourceRef === sourceRef && proof.imageDigest === input.builtDigest, 'Scan proof does not bind the build source digest');
    check(DIGEST.test(proof.imageId) && proof.platform === 'linux/amd64', 'Scan proof image identity or platform is invalid');
    check(proof.scanner?.name === SCANNER.name && proof.scanner.version === SCANNER.version
      && proof.scanner.archiveSha256 === SCANNER.archiveSha256, 'Scan proof scanner pin is invalid');
    const scannedAt = Date.parse(proof.scannedAt);
    const age = now().getTime() - scannedAt;
    check(typeof proof.scannedAt === 'string' && Number.isFinite(scannedAt)
      && new Date(scannedAt).toISOString() === proof.scannedAt && age >= 0 && age <= 60 * 60_000,
    'Scan proof is stale, future-dated or has an invalid timestamp');
    const reportData = read(`${input.proofPath}.trivy.json`, 32 * 1024 * 1024);
    const databaseData = read(`${input.proofPath}.database.json`, 1024 * 1024);
    const policyData = read(POLICY_PATH, 1024 * 1024);
    check(HASH.test(proof.reportSha256) && hash(reportData) === proof.reportSha256, 'Raw scan report hash differs from proof');
    check(HASH.test(proof.databaseMetadataSha256) && hash(databaseData) === proof.databaseMetadataSha256, 'Scanner database metadata hash differs from proof');
    check(HASH.test(proof.policySha256) && hash(policyData) === proof.policySha256, 'Current policy hash differs from proof');
    const result = evaluate(parseJson(reportData, 'scan report'), parseJson(policyData, 'image policy'), {
      imageId: proof.imageId, now: now(), databaseMetadata: parseJson(databaseData, 'scanner database metadata'),
    });
    check(result?.passed === true && proof.summary?.passed === true, 'Image vulnerability policy did not pass');
    return proof;
  }

  const proof = validateProof();
  const inspectDigest = reference => String(run(['buildx', 'imagetools', 'inspect', reference, '--format', '{{.Manifest.Digest}}'])).trim();
  check(inspectDigest(sourceRef) === input.builtDigest, 'Source registry digest could not be verified');
  const runtimeDigest = validateShape(parseJson(run(['buildx', 'imagetools', 'inspect', sourceRef, '--raw']), 'source manifest'), proof.imageId, input.builtDigest);
  if (runtimeDigest !== input.builtDigest) {
    const leaf = parseJson(run(['buildx', 'imagetools', 'inspect', `${REPOSITORY}@${runtimeDigest}`, '--raw']), 'runtime manifest');
    check(leaf?.schemaVersion === 2 && IMAGE_TYPES.has(leaf.mediaType) && leaf.config?.digest === proof.imageId,
      'Runtime leaf config differs from scanned image');
  }
  run(['pull', '--platform', 'linux/amd64', sourceRef]);
  const image = parseJson(run(['image', 'inspect', sourceRef, '--format', '{{json .}}']), 'source image');
  check(image?.Id === proof.imageId && image.Os === 'linux' && image.Architecture === 'amd64'
    && Array.isArray(image.RepoDigests) && image.RepoDigests.includes(sourceRef), 'Candidate config, platform or registry identity differs from scan proof');

  // Re-read proof, raw evidence and current policy after all awaited preflight work.
  check(validateProof().imageId === image.Id, 'Scan proof changed during candidate verification');
  const tags = [`${REPOSITORY}:${input.releaseTag}`, ...prerelease ? [] : [`${REPOSITORY}:latest`]];
  run(['buildx', 'imagetools', 'create', '--prefer-index=false', ...tags.flatMap(value => ['--tag', value]), sourceRef]);
  for (const promoted of tags) {
    check(inspectDigest(promoted) === input.builtDigest, 'Promoted tag digest differs from scanned source; tags may already have changed');
  }
  return { promoted: true, sourceRef, imageId: proof.imageId, tags };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(process.argv.length === 7, 'Usage: promote-scanned-image REPOSITORY BUILD_DIGEST RELEASE_TAG IS_PRERELEASE SCAN_PROOF_JSON');
    const [repository, builtDigest, releaseTag, isPrerelease, proofPath] = process.argv.slice(2);
    console.log(JSON.stringify(await promoteScannedImage({ repository, builtDigest, releaseTag, isPrerelease, proofPath })));
  } catch {
    console.error('Scanned-image promotion failed; release tags are not confirmed. Check the local proof and candidate identity.');
    process.exitCode = 1;
  }
}
