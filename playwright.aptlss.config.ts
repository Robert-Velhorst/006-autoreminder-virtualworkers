import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /aptlss-manager(?:-live|-review)?\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: "test-results/aptlss-browser.json" }]],
  use: { baseURL: "http://127.0.0.1:3035", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "node node_modules/tsx/dist/cli.mjs scripts/start-aptlss-test-server.ts", url: "http://127.0.0.1:3035/api/health", reuseExistingServer: false, timeout: 120_000 },
});
