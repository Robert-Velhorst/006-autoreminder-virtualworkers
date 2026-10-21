import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { MANAGER_IMPLEMENTATION_VERSION, MANAGER_RUNTIME_TOOL_BUNDLES, managerSafetyDigest } from "../server/aptlssManagerSafety";

const bundleHash = createHash("sha256").update(readFileSync("dist/index.js")).digest("hex");
const sourceCollectorPackageHash = createHash("sha256")
  .update(readFileSync("client/public/downloads/worker-browser-collector.zip"))
  .digest("hex");
const collectorPackageHash = createHash("sha256")
  .update(readFileSync("dist/public/downloads/worker-browser-collector.zip"))
  .digest("hex");
if (sourceCollectorPackageHash !== collectorPackageHash)
  throw new Error("The production browser collector does not match its reviewed source package.");
const toolBundleHashes = Object.fromEntries(MANAGER_RUNTIME_TOOL_BUNDLES.map(file => [file,
  createHash("sha256").update(readFileSync(file)).digest("hex")]));
writeFileSync("dist/aptlss-build.json", JSON.stringify({ version: MANAGER_IMPLEMENTATION_VERSION, digest: managerSafetyDigest(), bundleHash, collectorPackageHash, toolBundleHashes }, null, 2));
