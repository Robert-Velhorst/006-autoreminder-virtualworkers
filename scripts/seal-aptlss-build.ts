import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { MANAGER_IMPLEMENTATION_VERSION, managerSafetyDigest } from "../server/aptlssManagerSafety";

const bundleHash = createHash("sha256").update(readFileSync("dist/index.js")).digest("hex");
const sourceCollectorPackageHash = createHash("sha256")
  .update(readFileSync("client/public/downloads/worker-browser-collector.zip"))
  .digest("hex");
const collectorPackageHash = createHash("sha256")
  .update(readFileSync("dist/public/downloads/worker-browser-collector.zip"))
  .digest("hex");
if (sourceCollectorPackageHash !== collectorPackageHash)
  throw new Error("The production browser collector does not match its reviewed source package.");
writeFileSync("dist/aptlss-build.json", JSON.stringify({ version: MANAGER_IMPLEMENTATION_VERSION, digest: managerSafetyDigest(), bundleHash, collectorPackageHash }, null, 2));
