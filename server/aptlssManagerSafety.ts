import { confinedLocalPath } from "../shared/local-filesystem-policy.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const MANAGER_IMPLEMENTATION_VERSION = "joyce-shadow-3";
export const MANAGER_RUNTIME_TOOL_BUNDLES = [
  "dist/tools/reanalyze_all.js",
  "dist/tools/reanalyze_active_placeholders.js",
  "dist/bridge/run-codex-bridge.js",
  "dist/bridge/run-manager-codex.js",
  "dist/bridge/run-codex-llm.js",
  "dist/bridge/manager-codex-supervisor.js",
] as const;

function fileDigest(path: string) {
  const contents = readFileSync(path);
  const normalized = path.endsWith(".zip")
    ? contents
    : Buffer.from(contents.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(normalized).digest("hex");
}

export function managerSafetyDigest(root = process.cwd()) {
  // Production images contain compiled artifacts, not the source checkout.
  if (!existsSync(resolve(root, "server"))) {
    const manifest = JSON.parse(readFileSync(resolve(root, "dist/aptlss-build.json"), "utf8"));
    const bundleHash = createHash("sha256").update(readFileSync(resolve(root, "dist/index.js"))).digest("hex");
    const collectorPackageHash = createHash("sha256")
      .update(readFileSync(resolve(root, "dist/public/downloads/worker-browser-collector.zip")))
      .digest("hex");
    const toolsValid = manifest.toolBundleHashes && typeof manifest.toolBundleHashes === "object"
      && Object.keys(manifest.toolBundleHashes).length === MANAGER_RUNTIME_TOOL_BUNDLES.length
      && MANAGER_RUNTIME_TOOL_BUNDLES.every(file => existsSync(resolve(root, file))
        && /^[a-f0-9]{64}$/.test(manifest.toolBundleHashes[file])
        && createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex") === manifest.toolBundleHashes[file]);
    if (
      manifest.version !== MANAGER_IMPLEMENTATION_VERSION ||
      !/^[a-f0-9]{64}$/.test(manifest.digest) ||
      manifest.bundleHash !== bundleHash ||
      !/^[a-f0-9]{64}$/.test(manifest.collectorPackageHash) ||
      manifest.collectorPackageHash !== collectorPackageHash || !toolsValid
    ) throw new Error("APTLSS build identity is missing or does not match the running bundle and browser collector.");
    return manifest.digest as string;
  }
  const sourceFiles = (directory: string): string[] => readdirSync(resolve(root, directory), { withFileTypes: true })
    .flatMap(entry => {
      const file = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`APTLSS source identity cannot include symbolic links: ${file}`);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|css|html|json|sql)$/.test(entry.name) ? [file] : [];
    });
  const files = [
    ...sourceFiles("server"), ...sourceFiles("shared"), ...sourceFiles("client/src"), ...sourceFiles("drizzle"), ...sourceFiles("drizzle-postgres-v1"), ...sourceFiles("browser-extension"),
    "client/public/downloads/worker-browser-collector.zip",
    "scripts/verify-aptlss-safety.ts", "scripts/seal-aptlss-build.ts",
    "scripts/package-browser-collector.ps1", "scripts/aptlss-pilot-compose.mjs",
    "scripts/aptlss-pilot-validation.mjs",
    "scripts/run-manager-codex.ts", "scripts/Start-ManagerCodex.ps1",
    "scripts/run-codex-bridge.ts", "scripts/run-codex-llm.ts",
    "scripts/build-codex-bridge.mjs", "scripts/manager-codex-supervisor.mjs",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "drizzle.config.ts", "vitest.config.ts",
    "Dockerfile", "docker-compose.yml", "deployment/shadow-pilot.yml", "deployment/codex-subscription.yml",
    "playwright.aptlss.config.ts", "e2e/aptlss-manager.spec.ts", "e2e/aptlss-manager-live.spec.ts", "e2e/aptlss-manager-review.spec.ts", "scripts/start-aptlss-test-server.ts",
    "e2e/api-rate-window.mjs", "e2e/api-rate-window.test.mjs",
  ].sort();
  const digest = createHash("sha256");
  for (const file of files) {
    // Metadata can stay equal across same-size writes on coarse filesystems.
    digest.update(file).update(fileDigest(resolve(root, file)));
  }
  return digest.digest("hex");
}

export function managerSafetyVerified() {
  try {
    const proof = JSON.parse(readFileSync(confinedLocalPath(process.env.APTLSS_SAFETY_ATTESTATION || "artifacts/aptlss-safety.json"), "utf8"));
    return proof.version === MANAGER_IMPLEMENTATION_VERSION && proof.digest === managerSafetyDigest()
      && proof.scope === "shadow-pilot" && proof.activeModeVerified === false
      && proof.success === true && Number.isSafeInteger(proof.regressionTests) && proof.regressionTests >= 100
      && proof.postgresIntegration === true && proof.browserIntegration === true;
  } catch { return false; }
}
