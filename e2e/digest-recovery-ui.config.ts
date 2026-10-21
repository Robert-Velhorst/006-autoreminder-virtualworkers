import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixtureConfig from "../playwright.aptlss.config";

if (process.env.APTLSS_UI_ONLY !== "true") throw new Error("Digest UI contracts require APTLSS_UI_ONLY=true; no database fixtures are permitted.");
const webServer = fixtureConfig.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error("Expected the existing single UI fixture server.");

export default defineConfig({
  ...fixtureConfig,
  testDir: import.meta.dirname,
  testMatch: "digest-recovery.spec.ts",
  webServer: { ...webServer, cwd: join(import.meta.dirname, "..") },
  outputDir: join(tmpdir(), "va-digest-recovery-ui", "results"),
  reporter: [["list"], ["json", { outputFile: join(tmpdir(), "va-digest-recovery-ui", "report.json") }]],
  use: { ...fixtureConfig.use, serviceWorkers: "block", trace: "on" },
});
