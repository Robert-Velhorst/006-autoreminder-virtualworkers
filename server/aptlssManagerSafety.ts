import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const MANAGER_IMPLEMENTATION_VERSION = "joyce-shadow-1";
const sourceDigests = new Map<string, { stamp: string; digest: string }>();

export function managerSafetyDigest(root = process.cwd()) {
  // Production images contain compiled artifacts, not the source checkout.
  if (!existsSync(resolve(root, "server"))) {
    const manifest = JSON.parse(readFileSync(resolve(root, "dist/aptlss-build.json"), "utf8"));
    const bundleHash = createHash("sha256").update(readFileSync(resolve(root, "dist/index.js"))).digest("hex");
    if (manifest.version !== MANAGER_IMPLEMENTATION_VERSION || !/^[a-f0-9]{64}$/.test(manifest.digest) || manifest.bundleHash !== bundleHash) throw new Error("APTLSS build identity is missing or does not match the running bundle.");
    return manifest.digest as string;
  }
  const sourceFiles = (directory: string): string[] => readdirSync(resolve(root, directory), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? sourceFiles(`${directory}/${entry.name}`)
      : /\.(?:ts|tsx|css|json|sql)$/.test(entry.name) ? [`${directory}/${entry.name}`] : []);
  const files = [
    ...sourceFiles("server"), ...sourceFiles("shared"), ...sourceFiles("client/src"), ...sourceFiles("drizzle"),
    "scripts/verify-aptlss-safety.ts", "scripts/seal-aptlss-build.ts",
    "scripts/run-manager-codex.ts", "scripts/Start-ManagerCodex.ps1",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "drizzle.config.ts", "vitest.config.ts",
    "playwright.aptlss.config.ts", "e2e/aptlss-manager.spec.ts", "e2e/aptlss-manager-live.spec.ts", "e2e/aptlss-manager-review.spec.ts", "scripts/start-aptlss-test-server.ts",
  ].sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const path = resolve(root,file), stat = statSync(path, { bigint: true });
    const stamp = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    let cached = sourceDigests.get(path);
    if (!cached || cached.stamp !== stamp) {
      cached = { stamp, digest: createHash("sha256").update(readFileSync(path,"utf8").replace(/\r\n/g,"\n")).digest("hex") };
      sourceDigests.set(path,cached);
    }
    digest.update(file).update(cached.digest);
  }
  return digest.digest("hex");
}

export function managerSafetyVerified() {
  try {
    const proof = JSON.parse(readFileSync(resolve(process.env.APTLSS_SAFETY_ATTESTATION || "artifacts/aptlss-safety.json"), "utf8"));
    return proof.version === MANAGER_IMPLEMENTATION_VERSION && proof.digest === managerSafetyDigest()
      && proof.scope === "shadow-pilot" && proof.activeModeVerified === false
      && proof.success === true && proof.regressionTests >= 100 && proof.mysqlIntegration === true && proof.browserIntegration === true;
  } catch { return false; }
}
