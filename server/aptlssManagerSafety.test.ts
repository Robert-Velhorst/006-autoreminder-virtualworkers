import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { managerSafetyDigest, managerSafetyVerified, MANAGER_IMPLEMENTATION_VERSION } from "./aptlssManagerSafety";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aptlss-build-test-")); folders.push(root);
  mkdirSync(join(root, "dist/public/downloads"), { recursive: true });
  writeFileSync(join(root, "dist/index.js"), "test bundle");
  const collector = Buffer.from([0, 255, 1, 128, 42]);
  writeFileSync(join(root, "dist/public/downloads/worker-browser-collector.zip"), collector);
  const manifest = {
    version: MANAGER_IMPLEMENTATION_VERSION,
    digest: "a".repeat(64),
    bundleHash: createHash("sha256").update("test bundle").digest("hex"),
    collectorPackageHash: createHash("sha256").update(collector).digest("hex"),
  };
  writeFileSync(join(root, "dist/aptlss-build.json"), JSON.stringify(manifest));
  return { root, manifest };
}
function prepareSourceTree(root: string) {
  for (const dir of ["server","shared","client/src","drizzle","drizzle-postgres-v1","browser-extension","client/public/downloads"]) mkdirSync(join(root,dir),{recursive:true});
  writeFileSync(join(root,"client/public/downloads/worker-browser-collector.zip"), Buffer.from([1, 2, 3]));
  writeFileSync(join(root,"browser-extension/service-worker.js"), "initial worker");
  const files=["scripts/verify-aptlss-safety.ts","scripts/seal-aptlss-build.ts","scripts/package-browser-collector.ps1","scripts/aptlss-pilot-compose.mjs","scripts/aptlss-pilot-validation.mjs","scripts/run-manager-codex.ts","scripts/Start-ManagerCodex.ps1","package.json","pnpm-lock.yaml","pnpm-workspace.yaml","drizzle.config.ts","vitest.config.ts","Dockerfile","docker-compose.yml","deployment/shadow-pilot.yml","deployment/codex-subscription.yml","playwright.aptlss.config.ts","e2e/aptlss-manager.spec.ts","e2e/aptlss-manager-live.spec.ts","e2e/aptlss-manager-review.spec.ts","scripts/start-aptlss-test-server.ts"];
  for (const file of files) { mkdirSync(dirname(join(root,file)),{recursive:true}); writeFileSync(join(root,file),"fixture\r\n"); }
  for (const file of ["e2e/api-rate-window.mjs", "e2e/api-rate-window.test.mjs"]) writeFileSync(join(root, file), "fixture\r\n");
  mkdirSync(join(root,"drizzle/contracts"),{recursive:true});
  writeFileSync(join(root,"drizzle/contracts/generate-pilot-snapshot.mjs"),"export const snapshotSource = true;\r\n");
}
it("identifies a source-free production bundle using its verified build manifest", () => {
  const { root, manifest } = fixture(); expect(managerSafetyDigest(root)).toBe(manifest.digest);
});
it("rejects a changed production bundle", () => {
  const { root } = fixture(); writeFileSync(join(root, "dist/index.js"), "modified bundle");
  expect(() => managerSafetyDigest(root)).toThrow("does not match");
});
it("rejects a changed production browser collector package", () => {
  const { root } = fixture();
  writeFileSync(join(root, "dist/public/downloads/worker-browser-collector.zip"), Buffer.from([0, 255, 1, 128, 43]));
  expect(() => managerSafetyDigest(root)).toThrow("does not match");
});
it("rejects an unsealed production build", () => {
  const { root } = fixture(); rmSync(join(root, "dist/aptlss-build.json"));
  expect(() => managerSafetyDigest(root)).toThrow();
});
it("rejects a manifest from another reliability implementation", () => {
  const { root, manifest } = fixture(); writeFileSync(join(root, "dist/aptlss-build.json"), JSON.stringify({ ...manifest, version: "old" }));
  expect(() => managerSafetyDigest(root)).toThrow("does not match");
});
it("updates source identity immediately when a dependency changes", () => {
  const { root } = fixture();
  prepareSourceTree(root);
  const first=managerSafetyDigest(root);
  expect(managerSafetyDigest(root)).toBe(first);
  writeFileSync(join(root,"shared/workerTime.ts"),"changed behavior");
  expect(managerSafetyDigest(root)).not.toBe(first);
  const changed=managerSafetyDigest(root);
  writeFileSync(join(root,"package.json"),"fixture\n");
  expect(managerSafetyDigest(root)).toBe(changed);
  writeFileSync(join(root,"shared/workerTime.ts"),"new changed behavior");
  expect(managerSafetyDigest(root)).not.toBe(changed);
  const extensionChanged = managerSafetyDigest(root);
  writeFileSync(join(root,"browser-extension/service-worker.js"),"changed collector behavior");
  expect(managerSafetyDigest(root)).not.toBe(extensionChanged);
  const packageChanged = managerSafetyDigest(root);
  writeFileSync(join(root,"client/public/downloads/worker-browser-collector.zip"), Buffer.from([1, 2, 4]));
  expect(managerSafetyDigest(root)).not.toBe(packageChanged);
});
it("includes executable module extensions in source identity", () => {
  const { root } = fixture();
  prepareSourceTree(root);
  const first = managerSafetyDigest(root);
  writeFileSync(join(root,"drizzle/contracts/generate-pilot-snapshot.mjs"),"export const snapshotSource = false;\n");
  expect(managerSafetyDigest(root)).not.toBe(first);
});
it("includes live-browser rate-window pacing in source identity", () => {
  const { root } = fixture();
  prepareSourceTree(root);
  const first = managerSafetyDigest(root);
  const pacing = join(root, "e2e/api-rate-window.mjs");
  writeFileSync(pacing, "export const changedPacing = true;\n");
  expect(managerSafetyDigest(root)).not.toBe(first);
  rmSync(pacing);
  expect(() => managerSafetyDigest(root)).toThrow();
});
it("includes the rollout validation dependency in source identity", () => {
  const { root } = fixture();
  prepareSourceTree(root);
  const first = managerSafetyDigest(root);
  const validation = join(root, "scripts/aptlss-pilot-validation.mjs");
  writeFileSync(validation, "export const rollbackAllowed = true;\n");
  expect(managerSafetyDigest(root)).not.toBe(first);
  rmSync(validation);
  expect(() => managerSafetyDigest(root)).toThrow();
});
it("detects same-size source changes even when modification time is restored", () => {
  const { root } = fixture();
  prepareSourceTree(root);
  const file = join(root, "shared/workerTime.ts");
  writeFileSync(file, "export const minutes = 10;\n");
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(file, timestamp, timestamp);
  const original = statSync(file);
  const first = managerSafetyDigest(root);
  writeFileSync(file, "export const minutes = 20;\n");
  utimesSync(file, timestamp, timestamp);
  expect(statSync(file).size).toBe(original.size);
  expect(statSync(file).mtimeMs).toBe(original.mtimeMs);
  expect(managerSafetyDigest(root)).not.toBe(first);
});
it("fails closed when a source tree contains a symbolic-link directory", () => {
  const { root } = fixture();
  prepareSourceTree(root);
  const target = join(root,"linked-source");
  mkdirSync(target);
  writeFileSync(join(target,"untracked.ts"),"export const changed = true;\n");
  symlinkSync(target, join(root,"server","linked-source"), process.platform === "win32" ? "junction" : "dir");
  expect(() => managerSafetyDigest(root)).toThrow(/source identity cannot include symbolic links/);
});
it("includes PostgreSQL migration bytes in the reviewed source identity", () => {
  const { root } = fixture();
  prepareSourceTree(root);
  const before = managerSafetyDigest(root);
  writeFileSync(join(root, "drizzle-postgres-v1/0001.sql"), "ALTER TABLE example ADD COLUMN checked boolean;\n");
  expect(managerSafetyDigest(root)).not.toBe(before);
});

it("requires a numeric integer count in the safety attestation", () => {
  const { root } = fixture();
  const attestationPath = join(root,"attestation.json");
  const previousPath = process.env.APTLSS_SAFETY_ATTESTATION;
  const workingDirectory = vi.spyOn(process, "cwd").mockReturnValue(root);
  const digest = managerSafetyDigest();
  const proof = {
    version: MANAGER_IMPLEMENTATION_VERSION,
    digest,
    scope: "shadow-pilot",
    activeModeVerified: false,
    success: true,
    regressionTests: 100,
    postgresIntegration: true,
    browserIntegration: true,
  };
  try {
    process.env.APTLSS_SAFETY_ATTESTATION = attestationPath;
    writeFileSync(attestationPath, JSON.stringify(proof));
    expect(managerSafetyVerified()).toBe(true);
    writeFileSync(attestationPath, JSON.stringify({ ...proof, regressionTests: "100" }));
    expect(managerSafetyVerified()).toBe(false);
    writeFileSync(attestationPath, JSON.stringify({ ...proof, regressionTests: 100.5 }));
    expect(managerSafetyVerified()).toBe(false);
  } finally {
    workingDirectory.mockRestore();
    if (previousPath === undefined) delete process.env.APTLSS_SAFETY_ATTESTATION;
    else process.env.APTLSS_SAFETY_ATTESTATION = previousPath;
  }
});
