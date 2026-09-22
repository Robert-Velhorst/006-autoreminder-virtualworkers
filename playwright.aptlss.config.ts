import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomInt } from "node:crypto";

const uiOnly = process.env.APTLSS_UI_ONLY === "true";
// Allocate distinct fixture IDs before the child server starts. The live specs
// insert these exact IDs only into the separately guarded disposable database.
if (!uiOnly && !process.env.APTLSS_TEST_PILOT_WORKER_IDS) {
  const base = randomInt(10_000_000, 20_000_000) * 10;
  process.env.APTLSS_TEST_PILOT_WORKER_IDS = Array.from({ length: 5 }, (_, index) => base + index * 100).join(",");
}
const port = process.env.APTLSS_TEST_PORT || (uiOnly ? "3036" : "3035");
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("Invalid APTLSS_TEST_PORT");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: uiOnly ? /aptlss-manager\.spec\.ts/ : /aptlss-manager(?:-live|-review)?\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: uiOnly ? join(tmpdir(), "aptlss-shadow-ui", "browser.json") : "test-results/aptlss-browser.json" }]],
  ...(uiOnly ? { outputDir: join(tmpdir(), "aptlss-shadow-ui", "results") } : {}),
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "node node_modules/tsx/dist/cli.mjs scripts/start-aptlss-test-server.ts", url: uiOnly ? baseURL : `${baseURL}/api/health`, env: { APTLSS_TEST_PORT: port }, reuseExistingServer: false, timeout: 120_000 },
});
