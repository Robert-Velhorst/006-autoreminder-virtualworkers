import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MYSQL_INTEGRATION_SUITES = [
  "server/aptlssManagerIntegration.test.ts",
  "server/aptlssManagerQueueIntegration.test.ts",
  "server/aptlssManagerReviewIndexIntegration.test.ts",
  "server/googleEvidence.integration.test.ts",
  "server/reminderOrchestration.integration.test.ts",
  "server/scheduledJobRuntime.integration.test.ts",
  "server/routes/manus-trello-aptlss-checklist.integration.test.ts",
  "scripts/operational-record-fingerprint.integration.test.mjs",
  "scripts/full-data-rollback-checkpoint.integration.test.mjs",
];

export function assertIntegrationDatabase(raw) {
  let url;
  try { url = new URL(raw); } catch { /* Report no credential values. */ }
  if (!url || url.protocol !== "mysql:" || url.search || url.hash
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !["/aptlss_test", "/recovery_test"].includes(url.pathname)) {
    throw new Error("Set APTLSS_TEST_DATABASE_URL to an explicit loopback MySQL test database named aptlss_test or recovery_test.");
  }
}

export function verifyIntegrationReport(report) {
  if (report?.success !== true || !Array.isArray(report.testResults)
    || report.testResults.length !== MYSQL_INTEGRATION_SUITES.length
    || report.numFailedTests !== 0 || report.numPendingTests !== 0) {
    throw new Error("MySQL integration evidence is incomplete, failed, or skipped.");
  }
  let tests = 0;
  for (const file of MYSQL_INTEGRATION_SUITES) {
    const suites = report.testResults.filter(result => {
      const name = String(result.name ?? "").replaceAll("\\", "/");
      return name === file || name.endsWith(`/${file}`);
    });
    if (suites.length !== 1 || suites[0].status !== "passed"
      || !Array.isArray(suites[0].assertionResults) || !suites[0].assertionResults.length
      || suites[0].assertionResults.some(test => test.status !== "passed")) {
      throw new Error(`Missing or unsuccessful MySQL integration suite: ${file}`);
    }
    tests += suites[0].assertionResults.length;
  }
  if (report.numPassedTests !== tests || report.numTotalTests !== tests) {
    throw new Error("MySQL integration test totals do not match executed assertions.");
  }
  return { suites: MYSQL_INTEGRATION_SUITES.length, tests };
}

function run() {
  const url = process.env.APTLSS_TEST_DATABASE_URL;
  assertIntegrationDatabase(url);
  mkdirSync("artifacts", { recursive: true });
  const directory = mkdtempSync(resolve("artifacts/mysql-integration-"));
  const reportPath = resolve(directory, "results.json");
  const result = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run",
    ...MYSQL_INTEGRATION_SUITES, "--no-file-parallelism", "--maxWorkers=1",
    "--reporter=json", `--outputFile=${reportPath}`], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, APTLSS_TEST_DATABASE_URL: url,
      NOTIFICATIONS_ENABLED: "false", REMINDER_WORKER_ENABLED: "false",
      BRIEFING_SCHEDULER_ENABLED: "false", APTLSS_MANAGER_SCHEDULER: "false",
      OPENAI_API_KEY: "", TRELLO_API_KEY: "", TRELLO_TOKEN: "" },
  });
  if (result.status !== 0) throw new Error("MySQL integration tests failed; release remains blocked.");
  const verified = verifyIntegrationReport(JSON.parse(readFileSync(reportPath, "utf8")));
  console.log(JSON.stringify({ ...verified, passed: true, report: reportPath }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
