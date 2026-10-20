import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAptlssPilotOperationAllowed,
  assertAptlssResumeConfiguration,
  assertSingleAptlssPilotWorkerId,
  hasMinimumLiveBrowserSpecs,
  isAptlssImageSafetyProofValid,
} from "./aptlss-pilot-validation.mjs";

const image = "va-dashboard:shadow-pilot-test";
const proofDirectory = path.resolve(".local/pilot/proof");

function validResumeConfiguration() {
  return {
    image,
    proofDirectory,
    pilotWorkerId: 2,
    imageDetails: { Id: "sha256:verified-image" },
    container: {
      Image: "sha256:verified-image",
      Config: {
        Image: image,
        Env: [
          "NODE_ENV=production",
          "LOCAL_AUTH_BYPASS=false",
          "APTLSS_MANAGER_PILOT_WORKER_IDS=2",
          "APTLSS_MANAGER_SHADOW_ONLY=true",
          "APTLSS_MANAGER_SCHEDULER=true",
          "APTLSS_SAFETY_ATTESTATION=/app/pilot-proof/aptlss-safety.json",
        ],
      },
      Mounts: [
        {
          Type: "bind",
          Source: proofDirectory,
          Destination: "/app/pilot-proof",
          ReadOnly: true,
        },
      ],
    },
  };
}

function validImageProof() {
  const verified = {
    version: "2026.09.26",
    digest: "safety-digest",
    bundleValid: true,
    collectorPackageValid: true,
  };
  return {
    proof: {
      success: true,
      scope: "shadow-pilot",
      activeModeVerified: false,
      postgresIntegration: true,
      browserIntegration: true,
      regressionTests: 100,
      version: verified.version,
      digest: verified.digest,
    },
    verified,
  };
}

function browserReport({ liveSpecs = 3, expected = 3, liveFile = "e2e/aptlss-manager-live.spec.ts" } = {}) {
  return {
    stats: { expected },
    suites: [
      {
        file: liveFile,
        specs: [],
        suites: [
          {
            title: "test.describe.serial",
            specs: Array.from({ length: liveSpecs }, (_, index) => ({ title: `live ${index + 1}` })),
          },
        ],
      },
    ],
  };
}

describe("APTLSS pilot operation preflight", () => {
  it.each(["check", "stop", "resume", "migrate", "deploy"])("leaves %s available for its existing validation", mode => {
    expect(assertAptlssPilotOperationAllowed(mode)).toBe(true);
  });

  it.each([undefined, "", "ROLLBACK", "unknown", null])("rejects an unknown operation %s", mode => {
    expect(() => assertAptlssPilotOperationAllowed(mode)).toThrow("Unknown rollout operation");
  });

  it("refuses legacy rollback even with otherwise valid shadow-image proof", () => {
    const { proof, verified } = validImageProof();
    expect(isAptlssImageSafetyProofValid(proof, verified)).toBe(true);
    expect(() => assertAptlssPilotOperationAllowed("rollback", { proof, verified })).toThrow(/legacy rollback is disabled.*full-data compatibility and rollback rehearsal/i);
  });

  it("does not accept caller-supplied compatibility claims or a force override", () => {
    expect(() => assertAptlssPilotOperationAllowed("rollback", {
      force: true,
      allowLegacyRollback: true,
      proof: { success: true, fullDataCompatibility: true, rollbackRehearsal: true },
    })).toThrow(/legacy rollback is disabled/i);
  });

  it.each([undefined, "184", "1,2"])("blocks the rollback CLI before file or Docker access with worker selection %s", workerId => {
    const composeScript = fileURLToPath(new URL("./aptlss-pilot-compose.mjs", import.meta.url));
    const validationScript = fileURLToPath(new URL("./aptlss-pilot-validation.mjs", import.meta.url));
    const env = {
      PATH: "",
      PILOT_IMAGE: "fixture:legacy-image",
      PILOT_PROOF_DIRECTORY: path.join(os.tmpdir(), "untrusted-rollback-proof"),
      PILOT_CODEX_SUBSCRIPTION: "true",
      APTLSS_ALLOW_LEGACY_ROLLBACK: "true",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(workerId === undefined ? {} : { APTLSS_MANAGER_PILOT_WORKER_IDS: workerId }),
    };
    // Only module reads are allowed; runtime/secrets reads and all child execution are denied.
    const result = spawnSync(process.execPath, [
      "--permission",
      `--allow-fs-read=${composeScript}`,
      `--allow-fs-read=${validationScript}`,
      composeScript,
      "rollback",
      "--force",
      "--proof",
      JSON.stringify({ success: true, fullDataCompatibility: true, rollbackRehearsal: true }),
    ], { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/legacy rollback is disabled.*full-data compatibility and rollback rehearsal/i);
    expect(result.stderr).not.toMatch(/ERR_ACCESS_DENIED|ENOENT|Docker .*operation failed|exactly one positive numeric worker ID/i);
  });
});

describe("APTLSS pilot resume validation", () => {
  it.each([undefined, "", "0", "-1", "1,2", "1.5", "9007199254740992"])("rejects invalid single-worker selection %s", workerId => {
    expect(() => assertSingleAptlssPilotWorkerId(workerId)).toThrow(/exactly one positive numeric worker ID/i);
  });

  it("accepts an explicitly selected worker without depending on a worker name", () => {
    expect(assertSingleAptlssPilotWorkerId("184")).toBe(184);
  });

  it("accepts the matching production shadow container and read-only proof mount", () => {
    expect(assertAptlssResumeConfiguration(validResumeConfiguration())).toBe(true);
  });

  it("validates a different worker ID without depending on a person name", () => {
    const config = validResumeConfiguration();
    config.pilotWorkerId = 184;
    config.container.Config.Env[2] = "APTLSS_MANAGER_PILOT_WORKER_IDS=184";
    expect(assertAptlssResumeConfiguration(config)).toBe(true);
  });

  it.each([
    ["the selected image", config => { config.container.Config.Image = "different-image"; }],
    ["the inspected image ID", config => { config.container.Image = "sha256:other-image"; }],
    ["the shadow-only setting", config => { config.container.Config.Env[3] = "APTLSS_MANAGER_SHADOW_ONLY=false"; }],
    ["the local-auth setting", config => { config.container.Config.Env[1] = "LOCAL_AUTH_BYPASS=true"; }],
    ["the worker scope", config => { config.container.Config.Env[2] = "APTLSS_MANAGER_PILOT_WORKER_IDS=3"; }],
    ["the proof mount mode", config => { config.container.Mounts[0].ReadOnly = false; }],
    ["the proof mount source", config => { config.container.Mounts[0].Source = path.resolve(".local/other-proof"); }],
  ])("rejects a mismatch in %s", (_label, mutate) => {
    const config = validResumeConfiguration();
    mutate(config);
    expect(() => assertAptlssResumeConfiguration(config)).toThrow(/refusing to resume/i);
  });
});

describe("APTLSS image safety proof validation", () => {
  it("accepts an integer regression count and matching build version", () => {
    const { proof, verified } = validImageProof();
    expect(isAptlssImageSafetyProofValid(proof, verified)).toBe(true);
  });

  it("rejects legacy MySQL-only acceptance proof", () => {
    const { proof, verified } = validImageProof();
    const { postgresIntegration, ...legacyProof } = proof;
    expect(postgresIntegration).toBe(true);
    expect(isAptlssImageSafetyProofValid({ ...legacyProof, mysqlIntegration: true }, verified)).toBe(false);
  });

  it.each([false, undefined, "true", 1])("requires explicit PostgreSQL acceptance, not %s or a legacy fallback", postgresIntegration => {
    const { proof, verified } = validImageProof();
    expect(isAptlssImageSafetyProofValid({ ...proof, postgresIntegration, mysqlIntegration: true }, verified)).toBe(false);
  });

  it("rejects proof from a different build version", () => {
    const { proof, verified } = validImageProof();
    proof.version = "2026.09.25";
    expect(isAptlssImageSafetyProofValid(proof, verified)).toBe(false);
  });

  it.each([100.5, "100", Number.MAX_SAFE_INTEGER + 1])("rejects non-integer or unsafe regression count %s", count => {
    const { proof, verified } = validImageProof();
    proof.regressionTests = count;
    expect(isAptlssImageSafetyProofValid(proof, verified)).toBe(false);
  });
});

describe("APTLSS live browser evidence threshold", () => {
  it("accepts three live specs", () => {
    const report = browserReport();
    expect(report.suites[0].specs).toHaveLength(0);
    expect(report.suites[0].suites[0].specs).toHaveLength(3);
    expect(hasMinimumLiveBrowserSpecs(report)).toBe(true);
  });

  it("rejects fewer than three live specs even when other expected tests pass", () => {
    expect(hasMinimumLiveBrowserSpecs(browserReport({ liveSpecs: 2, expected: 8 }))).toBe(false);
  });

  it("rejects a report whose total expected count is below three", () => {
    expect(hasMinimumLiveBrowserSpecs(browserReport({ liveSpecs: 3, expected: 2 }))).toBe(false);
  });

  it("rejects reports without exactly one live suite", () => {
    expect(hasMinimumLiveBrowserSpecs(browserReport({ liveFile: "e2e/aptlss-manager.spec.ts" }))).toBe(false);
  });
});
