import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { managerSafetyDigest, MANAGER_IMPLEMENTATION_VERSION } from "./aptlssManagerSafety";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aptlss-build-test-")); folders.push(root);
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.js"), "test bundle");
  const manifest = { version: MANAGER_IMPLEMENTATION_VERSION, digest: "a".repeat(64), bundleHash: createHash("sha256").update("test bundle").digest("hex") };
  writeFileSync(join(root, "dist/aptlss-build.json"), JSON.stringify(manifest));
  return { root, manifest };
}
it("identifies a source-free production bundle using its verified build manifest", () => {
  const { root, manifest } = fixture(); expect(managerSafetyDigest(root)).toBe(manifest.digest);
});
it("rejects a changed production bundle", () => {
  const { root } = fixture(); writeFileSync(join(root, "dist/index.js"), "modified bundle");
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
it("invalidates cached source identity immediately when a dependency changes", () => {
  const { root } = fixture();
  for (const dir of ["server","shared","client/src","drizzle"]) mkdirSync(join(root,dir),{recursive:true});
  const files=["scripts/verify-aptlss-safety.ts","scripts/seal-aptlss-build.ts","scripts/run-manager-codex.ts","scripts/Start-ManagerCodex.ps1","package.json","pnpm-lock.yaml","pnpm-workspace.yaml","drizzle.config.ts","vitest.config.ts","playwright.aptlss.config.ts","e2e/aptlss-manager.spec.ts","e2e/aptlss-manager-live.spec.ts","e2e/aptlss-manager-review.spec.ts","scripts/start-aptlss-test-server.ts"];
  for (const file of files) { mkdirSync(dirname(join(root,file)),{recursive:true}); writeFileSync(join(root,file),"fixture\r\n"); }
  const first=managerSafetyDigest(root);
  expect(managerSafetyDigest(root)).toBe(first);
  writeFileSync(join(root,"shared/workerTime.ts"),"changed behavior");
  expect(managerSafetyDigest(root)).not.toBe(first);
  const changed=managerSafetyDigest(root);
  writeFileSync(join(root,"package.json"),"fixture\n");
  expect(managerSafetyDigest(root)).toBe(changed);
  writeFileSync(join(root,"shared/workerTime.ts"),"new changed behavior");
  expect(managerSafetyDigest(root)).not.toBe(changed);
});
