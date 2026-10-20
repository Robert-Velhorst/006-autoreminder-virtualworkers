import { describe, expect, it } from "vitest";
import { assertIntegrationDatabase, MYSQL_INTEGRATION_SUITES, verifyIntegrationReport } from "./run-mysql-integration.mjs";

const evidence = () => ({ success: true, numFailedTests: 0, numPendingTests: 0,
  numPassedTests: MYSQL_INTEGRATION_SUITES.length, numTotalTests: MYSQL_INTEGRATION_SUITES.length, testResults: MYSQL_INTEGRATION_SUITES.map(name => ({
    name: `/repo/${name}`, status: "passed", assertionResults: [{ status: "passed" }],
  })),
});

describe("explicit historical MySQL evidence gate", () => {
  it.each([undefined, "", "mysql://secret:private@remote/recovery_test", "mysql://root:private@localhost/production",
    "mysql://root:private@127.0.0.1/recovery_test?option=true", "mysql://root:private@localhost/recovery_test#fragment",
    "https://localhost/recovery_test", "postgresql://test:private@127.0.0.1/recovery_test"])("rejects unsafe or missing test targets without disclosing credentials", raw => {
    expect(() => assertIntegrationDatabase(raw)).toThrow(/explicit loopback/);
    try { assertIntegrationDatabase(raw); } catch (error) { expect(error.message).not.toMatch(/private|secret:/); }
  });
  it.each(["127.0.0.1", "localhost", "[::1]"])("accepts explicit %s test targets", host => {
    expect(() => assertIntegrationDatabase(`mysql://test:test@${host}:3306/recovery_test`)).not.toThrow();
  });
  it("requires every actual integration suite and consistent assertion totals", () => {
    expect(verifyIntegrationReport(evidence())).toEqual({ suites: MYSQL_INTEGRATION_SUITES.length, tests: MYSQL_INTEGRATION_SUITES.length });
  });
  it.each(["skipped", "pending", "failed"])("rejects a %s assertion even when the report claims success", status => {
    const report = evidence(); report.testResults[0].assertionResults[0].status = status;
    expect(() => verifyIntegrationReport(report)).toThrow();
  });
  it("rejects absent, empty, duplicate and misleading evidence", () => {
    const missing = evidence(); missing.testResults.pop();
    const empty = evidence(); empty.testResults[0].assertionResults = [];
    const duplicate = evidence(); duplicate.testResults[1] = duplicate.testResults[0];
    const misleading = evidence(); misleading.numTotalTests++;
    const skipped = evidence(); skipped.numPendingTests++;
    for (const report of [missing, empty, duplicate, misleading, skipped, {}])
      expect(() => verifyIntegrationReport(report)).toThrow();
  });
});
