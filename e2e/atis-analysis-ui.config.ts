import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
export default defineConfig({
  testDir: import.meta.dirname, testMatch: "atis-analysis-ui.spec.ts", workers: 1, fullyParallel: false, timeout: 30_000,
  outputDir: join(tmpdir(), "va-atis-analysis-ui", "results"), reporter: [["list"]],
  use: { serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
