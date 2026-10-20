import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  MANAGER_IMPLEMENTATION_VERSION,
  managerSafetyDigest,
} from "../server/aptlssManagerSafety";
import {
  APTLSS_REGRESSION_SUITE_FILES,
  evaluateAptlssRegressionCoverage,
  invalidAptlssRegressionSuiteRuns,
} from "../server/aptlssManagerRegressionCoverage";
import { hasMinimumLiveBrowserSpecs } from "./aptlss-pilot-validation.mjs";

const url = process.env.APTLSS_TEST_DATABASE_URL;
if (!url) throw new Error("An explicit APTLSS_TEST_DATABASE_URL is required.");
requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === "production");
mkdirSync(resolve("artifacts"), { recursive: true });
const digest = managerSafetyDigest();
const report = resolve(
  process.env.APTLSS_SAFETY_TEST_REPORT ||
    "artifacts/aptlss-safety-results.json"
);
const browserReport = resolve(
  process.env.APTLSS_BROWSER_REPORT_PATH || "test-results/aptlss-browser.json"
);
const browserOutputDir = process.env.APTLSS_BROWSER_OUTPUT_DIR
  ? resolve(process.env.APTLSS_BROWSER_OUTPUT_DIR)
  : undefined;
const attestation = resolve(
  process.env.APTLSS_SAFETY_ATTESTATION_PATH || "artifacts/aptlss-safety.json"
);
mkdirSync(dirname(report), { recursive: true });
mkdirSync(dirname(browserReport), { recursive: true });
if (browserOutputDir) mkdirSync(browserOutputDir, { recursive: true });
const vitest = resolve("node_modules/vitest/vitest.mjs");
const result = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    "server/aptlssManager",
    "server/aptlssEvidenceGraph",
    "server/browserCollectorPackage.test.ts",
    "server/dbLifecycle.test.ts",
    "server/workerOperatorContextTransaction.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url,
      APTLSS_TEST_DATABASE_URL: url,
      OPENAI_API_KEY: "",
      APTLSS_MANAGER_MODEL: "",
    },
  }
);
if (result.status !== 0)
  throw new Error(
    "Safety checks failed; no acceptance attestation was written."
  );
const parsed = JSON.parse(readFileSync(report, "utf8"));
const integrationFiles = [
  "server/aptlssManagerIntegration.test.ts",
  "server/aptlssManagerQueueIntegration.test.ts",
];
const normalizedPath = (value: string) =>
  value.replaceAll("\\", "/").toLowerCase();
const reportContainsFile = (reportedName: string, expectedFile: string) => {
  const reported = normalizedPath(reportedName);
  const expected = expectedFile.toLowerCase();
  return reported === expected || reported.endsWith(`/${expected}`);
};
const successful = (r: { assertionResults: Array<{ status: string }> }) =>
  r.assertionResults.length > 0 &&
  r.assertionResults.every(a => a.status === "passed");
const regressionResults = parsed.testResults.filter((r: { name: string }) =>
  APTLSS_REGRESSION_SUITE_FILES.some(file => reportContainsFile(r.name, file))
);
const regressionEvidence = regressionResults.flatMap(
  (r: {
    name: string;
    assertionResults: Array<{
      ancestorTitles?: unknown;
      fullName?: unknown;
      status?: unknown;
      title?: unknown;
    }>;
  }) => {
    const file = APTLSS_REGRESSION_SUITE_FILES.find(expected =>
      reportContainsFile(r.name, expected)
    );
    return file
      ? r.assertionResults.map(assertion => ({ ...assertion, file }))
      : [];
  }
);
const regressionCoverage = evaluateAptlssRegressionCoverage(regressionEvidence);
const reportedRegressionFiles = regressionResults.flatMap(r => {
  const file = APTLSS_REGRESSION_SUITE_FILES.find(expected =>
    reportContainsFile(r.name, expected)
  );
  return file ? [file] : [];
});
const invalidRegressionSuites = invalidAptlssRegressionSuiteRuns(
  reportedRegressionFiles
);
const regressionSuitesComplete =
  invalidRegressionSuites.length === 0 &&
  regressionResults.length === APTLSS_REGRESSION_SUITE_FILES.length;
const integrationResults = parsed.testResults.filter((r: { name: string }) =>
  integrationFiles.some(file => reportContainsFile(r.name, file))
);
const integrationSuitesComplete =
  integrationResults.length === integrationFiles.length &&
  integrationFiles.every(
    file =>
      integrationResults.filter(r => reportContainsFile(r.name, file))
        .length === 1
  );
if (
  !parsed.success ||
  parsed.numPendingTests ||
  !regressionSuitesComplete ||
  !regressionCoverage.ready ||
  !integrationSuitesComplete ||
  !parsed.testResults.every(successful) ||
  digest !== managerSafetyDigest()
) {
  throw new Error(
    `Incomplete or changed local safety evidence; no attestation was written. ` +
      `Matched ${regressionCoverage.cases.length} exact regression cases; ` +
      `invalid suites: ${invalidRegressionSuites.join(", ") || regressionCoverage.missingSuites.join(", ") || "none"}; ` +
      `missing named cases: ${regressionCoverage.missingCases.length}; ` +
      `missing scenarios: ${regressionCoverage.missingScenarios.join(", ") || "none"}.`
  );
}
const browser = spawnSync(
  process.execPath,
  [
    resolve("node_modules/@playwright/test/cli.js"),
    "test",
    "--config=playwright.aptlss.config.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url,
      APTLSS_TEST_DATABASE_URL: url,
      APTLSS_BROWSER_REPORT_PATH: browserReport,
      ...(browserOutputDir
        ? { APTLSS_BROWSER_OUTPUT_DIR: browserOutputDir }
        : {}),
    },
  }
);
if (browser.status !== 0)
  throw new Error(
    "Browser safety checks failed; no acceptance attestation was written."
  );
const browserResults = JSON.parse(readFileSync(browserReport, "utf8"));
if (
  browserResults.stats.unexpected ||
  browserResults.stats.skipped ||
  !hasMinimumLiveBrowserSpecs(browserResults) ||
  digest !== managerSafetyDigest()
)
  throw new Error(
    "Incomplete or changed browser safety evidence; no acceptance attestation was written."
  );
writeFileSync(
  attestation,
  JSON.stringify(
    {
      version: MANAGER_IMPLEMENTATION_VERSION,
      digest,
      scope: "shadow-pilot",
      activeModeVerified: false,
      success: true,
      regressionTests: regressionCoverage.cases.length,
      regressionCases: regressionCoverage.cases,
      regressionScenarioEvidence: regressionCoverage.scenarioEvidence,
      postgresIntegration: true,
      browserIntegration: true,
      operationalTrial: {
        verified: false,
        requiredWorkingDays: 5,
        requiredHumanReviewedProposals: 100,
      },
      verifiedAt: new Date().toISOString(),
    },
    null,
    2
  )
);
console.log(
  `Local shadow-safety gate passed: ${regressionCoverage.cases.length} exact named regression cases, real PostgreSQL and browser integration. ` +
    "It does not verify the separate five-working-day, 100-human-reviewed-proposal operational trial. Active mode remains unverified."
);
