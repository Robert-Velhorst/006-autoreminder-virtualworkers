import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { MANAGER_IMPLEMENTATION_VERSION, managerSafetyDigest } from "../server/aptlssManagerSafety";

const bundleHash = createHash("sha256").update(readFileSync("dist/index.js")).digest("hex");
writeFileSync("dist/aptlss-build.json", JSON.stringify({ version: MANAGER_IMPLEMENTATION_VERSION, digest: managerSafetyDigest(), bundleHash }, null, 2));
