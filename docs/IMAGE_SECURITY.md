# Container Image Security

## Status And Scope

This document describes the inspected implementation for production gap #8:
scanning the exact application container artifact before release promotion.
Source inspection is not proof that the gate has passed in CI, on protected
`main`, or for an actual release; verify the exact revision's workflow results.
Documentation, dependency audits, static code checks, secret scans, SBOMs,
provenance attestations, and runtime smoke tests do not establish that this
image-vulnerability gate has run or passed. They remain separate controls.

The wrapper requests OS and library vulnerability scanning of the final image
with all package inventory included. The policy requires Alpine OS inventory
and installed, non-development `express`, `pg`, and `drizzle-orm` npm packages
under `/app/node_modules/`. These are concrete coverage checks, not proof that
every possible dependency was recognized by the scanner.

The scanner wrapper, report policy and promotion helper form one acceptance
path. This document does not independently authorize a publication or deployment.

## Runtime Tooling Boundary

The first hosted scan (run `39555172591`) correctly rejected 18 HIGH findings:
four in the base image's npm dependencies and fourteen in the native TypeScript
compiler's embedded Go dependencies. None was suppressed or excepted.

The final Docker stage removes npm/npx and Yarn; build/install stages retain
their tools. Scoped pnpm overrides remove only the TypeScript compiler peer
from tRPC's three compiled runtime packages. TypeScript 7 remains an explicit
development dependency for type checking. The lockfile is generated with pinned
pnpm 12.14.0, without editing installed package payloads or scanner inventory.

The final-image verifier requires npm/Yarn and all TypeScript compiler packages
to be absent, then loads tRPC's server, Express adapter, client and React entry points.
The same image must still pass the unchanged vulnerability policy and configured
PostgreSQL acceptance. Source changes and local mocked tests alone do not prove
that the corrected image has passed those hosted checks.

At source `192a4dc`, hosted run `39556533820` passed the unchanged image policy
and runtime/configured PostgreSQL image checks for config ID
`sha256:b80aeca4ed6e86a0070c5c2c608a90320bc824f0e0ac44b0907c5f2596d3a28c`.
Its retained report covers 633 packages, zero HIGH/CRITICAL findings and zero
exceptions. It still reported MEDIUM `CVE-2026-85091` in Alpine `zlib` 1.3.2-r0,
with a fixed package at 1.3.2-r1. The final Docker stage now refreshes zlib from
the base distribution's repository. A fresh exact-image receipt is required;
the earlier passing receipt does not cover this new candidate.

## Pinned Scanner And Fail-Closed Policy

[`scan-production-image.mjs`](../scripts/scan-production-image.mjs) downloads
the Linux x64 Trivy 0.76.0 distribution from its version-specific release URL,
checks its archive SHA-256 against the embedded `SCANNER.archiveSha256`, then
extracts and runs its binary. It checks the reported executable version too.
There is no separate extracted-binary checksum pin. A runtime-downloaded
checksum is not used as the trust anchor. Unsupported runner platforms,
archive mismatches, and unexpected executable versions fail. The workflows
use commit-pinned actions rather than a floating Trivy action or tool image.

Each invocation creates a fresh temporary work/cache directory and explicit
empty scanner config/ignore files. The scanner environment is allowlisted:
path/home, proxy settings, and certificate paths. Inherited `TRIVY_*` overrides
and registry/provider credential environment variables are not passed to the
scanner. Registry authentication remains with the host Docker commands; Trivy
scans the locally saved image archive. The work/cache directory is removed
after the attempt.

The wrapper requests an unfiltered structured report, all severity levels,
`--ignore-unfixed=false`, and `--list-all-pkgs`. Trivy's finding exit code is
zero so the separate policy evaluator can inspect the complete report. This
does not mean findings are accepted: the wrapper fails if evaluation rejects
any unsuppressed HIGH or CRITICAL finding, including one without a fix.

The inspected wrapper and
[`image-vulnerability-policy.mjs`](../scripts/image-vulnerability-policy.mjs)
reject:

- A scanner error, timeout, unavailable database update, or scan omitting the
  required inventory.
- A missing, empty, malformed, unsupported, or internally inconsistent report.
- A report older than one hour or more than five minutes in the future, or
  invalid report timestamps. The report requires schema version 2, artifact
  type `container_image`, and Trivy version 0.76.0.
- A report whose `Metadata.ImageID` differs from the inspected Docker config
  ID. The wrapper separately checks registry manifest/config identity and
  `linux/amd64` platform. A matching mutable tag alone is insufficient.
- Missing OS-package or npm-package inventory, even when the report contains
  no HIGH or CRITICAL findings. An absent result section, an empty inventory,
  or an unsupported package ecosystem is not a clean scan.
- Any unsuppressed HIGH or CRITICAL finding, whether fixed or unfixed.
- Missing, malformed, expired, overbroad, or otherwise invalid exception policy.

The scanner's actual `cache/db/metadata.json` supplies DB freshness evidence;
the Trivy JSON report does not embed these fields. Acceptance requires
`Version = 2`, `UpdatedAt` no older than 48 hours, `NextUpdate` strictly after
now, and `DownloadedAt` no older than one hour, with at most five minutes of
future-clock tolerance for update/download timestamps. The copied database
metadata is hashed into the proof and checked again at promotion. A fresh
cache alone is not proof of DB freshness.

The full report and package inventory, not a console summary or empty findings
array, supply the evaluator's identity and coverage inputs. See the official
[Trivy reporting documentation](https://www.trivy.dev/docs/latest/guide/configuration/reporting/).

Trivy's finding exit code is zero so the complete report can be evaluated with
the explicit exception policy. This does not make findings acceptable: the Node
evaluator exits unsuccessfully for every unapproved HIGH/CRITICAL finding. A
nonzero scanner execution status also fails the workflow before any proof is
written. The report is retained for seven days even when evaluation fails.

## Exception Contract

The explicit repository policy is
[`security/image-vulnerability-exceptions.json`](../security/image-vulnerability-exceptions.json),
currently `{ "version": 1, "exceptions": [] }`. No exceptions are accepted.
Missing or invalid policy fails; there is no fallback to a scanner ignore file.

The evaluator requires exactly these exception fields:

- `vulnerabilityId`, `packageName`, `installedVersion`, `target`, `type`, and
  `imageId`: exact finding scope, including the image config ID. There are no
  separate repository or platform exception fields; the wrapper binds those
  image properties. Wildcard scope values are rejected.
- `owner`, `reason`, and `approvalReference`: nonempty accountability/rationale
  metadata. The evaluator validates these strings, not the external approval
  decision itself; human review of an exception remains separate.
- `createdAt` and `expiresAt`: valid timestamps with creation no later than
  now, expiry strictly after now, and a positive lifetime of at most 30 days.
  Comparisons use absolute time; renewal requires a new reviewed approval.

Missing/unknown fields, invalid types/dates, excessive lifetime, duplicate
exceptions, and exceptions not matching a current HIGH/CRITICAL finding are
rejected. The raw report is not rewritten to remove excepted findings; the
proof records the policy hash and summary counts.
Do not put credentials, personal data, or private exploit details in approvals
or reports published with the repository.

## CI Artifact Flow

1. CI builds `va-dashboard:ci` and passes it to the scanner wrapper.
2. The wrapper inspects its config ID/platform and exports that ID to a local
   archive. It scans this archive, without rebuilding. The current proof does
   not include a tar-file checksum.
3. The evaluator checks report config ID, freshness, package coverage, and
   exception policy. It does not directly bind the report to a Git commit.
4. A rejected evaluation fails the wrapper and the workflow step. Raw report
   output remains at the requested runner path if scanning produced it;
   early failures can leave no raw report. A passing proof is written only
   after successful evaluation, and an old proof is removed before a new scan.
5. CI retains its runtime-default/dependency checks and runs the build-integrity
   and fail-closed startup helper against the same `va-dashboard:ci` image.
   It then runs the [configured PostgreSQL image acceptance harness](POSTGRES_IMAGE_ACCEPTANCE.md)
   against that image, without rebuilding. The workflow requires a passing
   receipt, confirmed cleanup, and a receipt image ID equal to the scan proof's
   image ID. It attempts to retain `postgres-image-ci.json` with the scan
   evidence for seven days. A history of passing source tests is not a substitute
   for this configured-image check.

A local Docker config ID and a registry manifest digest are different
identifiers. The proof's `sourceRef` is an image reference, not a source-code
revision. Release workflow build labels/provenance carry commit evidence
separately; the scan proof does not assert direct report-to-commit binding.
The CI scan does not substitute for scanning the separately built release.

## Release Artifact Flow

1. The release workflow builds once for `linux/amd64`, with SBOM/provenance,
   and pushes a unique candidate tag only.
2. It scans `repository@sha256:...` from the build output. The wrapper accepts
   a single runtime manifest, or an index containing exactly one linux/amd64
   runtime and related attestation descriptors; unchecked platforms fail.
3. After the scan and runtime integrity/fail-closed startup check, the workflow
   runs `verify-postgres-production-image.mjs` with the exact same
   `repository@BUILD_DIGEST`. The scanner has already pulled that digest; the
   harness resolves it to a config ID and starts the application by that ID.
   Its isolated fixture checks verified PostgreSQL TLS, canonical migrations,
   a least-privilege application role, readiness, password login, safe identity,
   active profile access, offboarding and stale-session rejection. The workflow
   requires `passed: true`, `cleanupConfirmed: true`, and an image ID matching
   the scan proof; it also checks the proof's source reference and build digest.
   It attempts to retain `postgres-image-release.json` with the scan evidence.
   Native fixture URL validation remains before the source migration/test suite;
   the configured-image harness owns a separate disposable database and does
   not reuse those service URLs or production data.
4. Only after both image checks and receipt validation pass does the workflow
   run the provenance attestation step for that digest, then invoke promotion. The promotion
   helper does not independently verify the external attestation; workflow
   ordering supplies that prerequisite.
5. [`promote-scanned-image.mjs`](../scripts/promote-scanned-image.mjs) rechecks
   the proof, raw report, database metadata and policy hashes, evaluator
   decision, manifest/config identity, and platform. It reads only the canonical
   `image-security-release.json` evidence files under the repository's fixed,
   ignored `artifacts/image-security/` directory, derived from the script's
   location rather than an environment-variable path;
   arbitrary command-line file paths are rejected. Proof age is limited to one hour and future-dated
   proofs are rejected. It promotes without rebuilding, with `latest` only
   for a stable, non-prerelease release.
6. Promotion resolves the final tags and checks their equality with the scanned
   digest. A mismatch fails, but tags may already have changed: this is not a
   transactional rollback guarantee and the artifact is not accepted on error.

Promotion uses the single scanned digest, preserving its index/attestation
shape rather than constructing a new build. Docker documents index copying and
the `--prefer-index=false` option for preserving a single-manifest source format;
verify equality rather than assuming a retag operation preserves the digest.
See [Docker imagetools create](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/).

A candidate may exist publicly before the scan completes or after it fails.
It is not an accepted release. Scan or attestation failure prevents the workflow
from reaching final release/`latest` promotion. A later promotion error can
leave changed tags, but still does not establish acceptance or authorize
deployment as a workaround. This flow gates release
acceptance, not initial candidate publication. Configured-image acceptance or
cleanup failure also prevents attestation/promotion. A published GitHub release page
alone is not evidence that its container passed this flow.

## Evidence And Remaining Acceptance

On success, the proof records `sourceRef`, config ID, optional registry
digest, platform, scanner version/archive checksum, raw-report SHA-256, policy
SHA-256, database-metadata SHA-256, `scannedAt`, and evaluator summary counts.
It does not record a Git revision, tar checksum or scan start/end pair. Failed
attempts emit an error and no passing proof; they are not guaranteed a complete
report. Both workflows attempt to retain the proof, raw report and copied DB
metadata for seven days, including when policy evaluation fails. Actual upload
success still requires inspection of that run's artifacts; an early scanner
failure may produce no files. Protect reports/logs and exclude credentials.

The separate configured-PostgreSQL receipt records the image ID, migration/hash,
schema count, named synthetic checks, `cleanupConfirmed: true`, and
`providerAcceptance: false`. The workflow checks its image ID against the scan
proof before continuing. An early or failed harness invocation can leave no
complete receipt; logs and a partial/empty file are not acceptance. The receipt
does not establish public HTTPS, browser-cookie behavior, provider access, or
deployment. Neither fixture uses operational data.

Remaining acceptance checks include demonstrating that an unfixed
HIGH/CRITICAL finding blocks, scanner/database failure blocks,
malformed/stale/wrong-image reports block,
missing OS or npm coverage blocks, and invalid/expired/over-30-day exceptions
block. A clean, complete matching artifact should pass without exceptions.
Failure evidence must remain available without creating a production claim.

Historical local scan previews, old reports, and pre-integration CI results
are not this new gate. Exact-head integration checks are still required,
followed by verification on protected `main` and proof from an actual release:
candidate digest, scan decision, attestation, and final tag equality. Do not
mark production gap #8 closed solely because these docs or local tests exist.
Image acceptance does not prove deployment, live-provider delivery, backup
restoration, or operator acceptance. Continue to follow
[Production Cutover](PRODUCTION_CUTOVER.md) and the root
[Security Policy](../SECURITY.md).
