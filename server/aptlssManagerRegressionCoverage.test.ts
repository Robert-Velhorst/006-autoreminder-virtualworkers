import { describe, expect, it } from "vitest";
import {
  APTLSS_REGRESSION_SUITE_FILES,
  evaluateAptlssRegressionCoverage,
  invalidAptlssRegressionSuiteRuns,
  MIN_APTLSS_REGRESSION_CASES,
  REQUIRED_APTLSS_REGRESSION_CASES,
  type AptlssRegressionEvidence,
} from "./aptlssManagerRegressionCoverage";

const evidenceFor = (
  file: string,
  ancestors: readonly string[],
  title: string,
  status = "passed"
): AptlssRegressionEvidence => ({
  file,
  ancestorTitles: [...ancestors],
  title,
  fullName: [...ancestors, title].join(" "),
  status,
});

const completeCatalogEvidence = (): AptlssRegressionEvidence[] => [
  ...REQUIRED_APTLSS_REGRESSION_CASES.map(testCase =>
    evidenceFor(testCase.file, testCase.ancestors, testCase.title)
  ),
  ...APTLSS_REGRESSION_SUITE_FILES.filter(
    file =>
      !REQUIRED_APTLSS_REGRESSION_CASES.some(testCase => testCase.file === file)
  ).map(file => evidenceFor(file, ["suite smoke"], "runs the required suite")),
];

describe("fixed APTLSS regression coverage", () => {
  it("requires 100 distinct concrete passing cases and exact scenario evidence", () => {
    const coverage = evaluateAptlssRegressionCoverage(
      completeCatalogEvidence()
    );

    expect(REQUIRED_APTLSS_REGRESSION_CASES.length).toBeGreaterThanOrEqual(
      MIN_APTLSS_REGRESSION_CASES
    );
    expect(coverage.ready).toBe(true);
    expect(coverage.cases).toHaveLength(
      REQUIRED_APTLSS_REGRESSION_CASES.length
    );
    expect(coverage.missingSuites).toEqual([]);
    expect(coverage.missingCases).toEqual([]);
    expect(coverage.missingScenarios).toEqual([]);
    expect(
      new Set(coverage.scenarioEvidence.map(item => item.category)).size
    ).toBe(9);
    expect(
      coverage.scenarioEvidence.every(item => item.fullName.length > 0)
    ).toBe(true);
  });

  it("does not let repeated assertions or unrelated unique names satisfy the case minimum", () => {
    const repeated = REQUIRED_APTLSS_REGRESSION_CASES[0];
    const filler: AptlssRegressionEvidence[] = Array.from(
      { length: 250 },
      (_, index) =>
        evidenceFor(
          "server/aptlssManagerEngine.test.ts",
          ["unrelated cases"],
          `unrelated passing assertion ${index}`
        )
    );
    const coverage = evaluateAptlssRegressionCoverage([
      ...Array.from({ length: 500 }, () =>
        evidenceFor(repeated.file, repeated.ancestors, repeated.title)
      ),
      ...filler,
    ]);

    expect(coverage.cases).toHaveLength(1);
    expect(coverage.ready).toBe(false);
    expect(coverage.missingCases.length).toBeGreaterThan(0);
  });

  it("does not let broad-keyword decoys satisfy a required scenario", () => {
    const missingScenario = REQUIRED_APTLSS_REGRESSION_CASES.find(
      testCase => testCase.scenario === "time zones and clock transitions"
    );
    expect(missingScenario).toBeDefined();
    const evidence = completeCatalogEvidence().filter(
      item =>
        !(
          item.file === missingScenario?.file &&
          item.title === missingScenario?.title
        )
    );
    evidence.push(
      evidenceFor(
        missingScenario!.file,
        missingScenario!.ancestors,
        "unrelated example mentions timezone, clock, due date and deadline"
      )
    );

    const coverage = evaluateAptlssRegressionCoverage(evidence);
    expect(coverage.ready).toBe(false);
    expect(coverage.missingScenarios).toEqual([
      "time zones and clock transitions",
    ]);
  });

  it("ignores failed, pending, malformed, and out-of-scope evidence", () => {
    const required = REQUIRED_APTLSS_REGRESSION_CASES[0];
    const good = evidenceFor(required.file, required.ancestors, required.title);
    const malformed = {
      ...good,
      fullName: "some other suite does not mention the exact case",
    };
    const outOfScope = evidenceFor(
      "server/aptlssManagerConflict.test.ts",
      required.ancestors,
      required.title
    );
    const coverage = evaluateAptlssRegressionCoverage([
      { ...good, status: "failed" },
      { ...good, status: "pending" },
      malformed,
      outOfScope,
    ]);

    expect(coverage.cases).toEqual([]);
    expect(coverage.ready).toBe(false);
    expect(coverage.missingSuites).toContain(required.file);
  });

  it("rejects missing or duplicated regression suite entries in the runner report", () => {
    expect(
      invalidAptlssRegressionSuiteRuns(APTLSS_REGRESSION_SUITE_FILES)
    ).toEqual([]);
    expect(
      invalidAptlssRegressionSuiteRuns([
        ...APTLSS_REGRESSION_SUITE_FILES,
        APTLSS_REGRESSION_SUITE_FILES[0],
      ])
    ).toEqual([APTLSS_REGRESSION_SUITE_FILES[0]]);

    const evidence = completeCatalogEvidence().filter(
      item => item.file !== "server/aptlssManagerModel.test.ts"
    );
    const coverage = evaluateAptlssRegressionCoverage(evidence);

    expect(coverage.missingSuites).toEqual([
      "server/aptlssManagerModel.test.ts",
    ]);
    expect(
      invalidAptlssRegressionSuiteRuns(
        APTLSS_REGRESSION_SUITE_FILES.filter(
          file => file !== "server/aptlssManagerModel.test.ts"
        )
      )
    ).toContain("server/aptlssManagerModel.test.ts");
    expect(coverage.ready).toBe(false);
  });
});
