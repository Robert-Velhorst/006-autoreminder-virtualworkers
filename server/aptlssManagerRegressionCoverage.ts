export const APTLSS_REGRESSION_SUITE_FILES = [
  "server/aptlssManagerEngine.test.ts",
  "server/aptlssManagerPlan.test.ts",
  "server/aptlssManagerPlanImpactUi.test.ts",
  "server/aptlssManagerModel.test.ts",
  "server/aptlssManagerFacts.test.ts",
  "server/aptlssManagerGate.test.ts",
] as const;

export const MIN_APTLSS_REGRESSION_CASES = 100;

type RegressionScenario =
  | "ambiguous language and questions"
  | "negations and polarity"
  | "changed agreements and revisions"
  | "source conflicts"
  | "missing evidence and context"
  | "deadlines and due dates"
  | "dependencies"
  | "breaks and working hours"
  | "time zones and clock transitions";

type RegressionCaseDefinition = {
  file: (typeof APTLSS_REGRESSION_SUITE_FILES)[number];
  ancestors: readonly string[];
  title: string;
  scenario?: RegressionScenario;
};

// This exact-name manifest prevents arbitrary tests and duplicated results from
// satisfying the local gate's minimum-case and scenario requirements.
export const REQUIRED_APTLSS_REGRESSION_CASES: readonly RegressionCaseDefinition[] =
  [
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "compares worker deadlines and completion against structured card facts",
      scenario: "deadlines and due dates",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not count duplicate samples or partial entries as completed whole tasks",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not invert negated assertions into positive claims: Approval is pending.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not invert negated assertions into positive claims: De factuur is niet betaald.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not invert negated assertions into positive claims: Invoice is unpaid.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not invert negated assertions into positive claims: Nog geen akkoord.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not invert negated assertions into positive claims: Task not completed.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not invert negated assertions into positive claims: Werk niet afgerond.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "does not let a late ingestion timestamp or newest worker message erase a dated contradiction",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "exposes absent and stale evidence without inventing calibrated confidence",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "honors cross-card dependencies even when the dependent card is urgent",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: Approval is pending. / The client approved it.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: De factuur is nog niet betaald. / De factuur is betaald.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: Deadline: 2026-09-05. / Deadline is now 2026-09-10.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: Het werk is nog niet afgerond. / Het werk is afgerond.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: Invoice has not been paid. / I paid the invoice.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: Nog geen akkoord ontvangen. / De klant heeft akkoord gegeven.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: Status: ON-HOLD. / Status: DOING.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "interrupts consequential source/worker contradictions: The task is not completed. / The task is completed.",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        'interrupts cycles or missing dependencies without offering unsafe work: ["2"]',
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        'interrupts cycles or missing dependencies without offering unsafe work: ["missing"]',
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "invalid dates cannot silently release waiting or masquerade as fresh evidence",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "keeps an open founder-decision step non-executable until an outcome is recorded",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "keeps estimates provisional with fewer than three comparable completions",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "keeps IDs bounded and stable across clock changes and unrelated cards",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "keeps only the exactly reported work step open until its source-backed state changes",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "keeps sequential work blocked after a rejected decision when no explicit edge exists",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "keeps work blocked when a completed founder decision was rejected",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "labels a notification with unknown contents as a source check, not a proved contradiction",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "learns robust step durations only from comparable completed uninterrupted samples",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "makes overdue follow-ups actionable but never sends or assumes the dependency resolved",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title: "prepares externally consequential steps as drafts: Mail de klant",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "prepares externally consequential steps as drafts: Pay the invoice",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "prepares externally consequential steps as drafts: Send the client an email",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "prepares externally consequential steps as drafts: Submit the application",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title: "ranks urgent due first, then ON-HOLD, DOING, TODO for equal risk",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "rejects invalid or timezone-ambiguous clock input: 2026-02-30T10:00:00Z",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "rejects invalid or timezone-ambiguous clock input: 2026-09-04T10:00:00",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "rejects invalid or timezone-ambiguous clock input: 2026-09-04T25:00:00Z",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title: "rejects invalid or timezone-ambiguous clock input: garbage",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "reports bounded-input truncation instead of claiming complete coverage",
      scenario: "missing evidence and context",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "retains waiting follow-up timing and drafts communication for review only",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "returns deterministic chronological open work without mutating the input",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "topologically orders explicit dependencies before imposing chronological sequence",
      scenario: "dependencies",
    },
    {
      file: "server/aptlssManagerEngine.test.ts",
      ancestors: ["assessManagerContext"],
      title:
        "withholds every executable action when collection explicitly reports incomplete work coverage",
    },
    {
      file: "server/aptlssManagerFacts.test.ts",
      ancestors: ["provenance, scope, revisions and reliability"],
      title:
        "accepts explicit dated same-source revisions while retaining historical provenance",
      scenario: "changed agreements and revisions",
    },
    {
      file: "server/aptlssManagerFacts.test.ts",
      ancestors: ["fixed language and claim regressions"],
      title:
        "does not convert uncertainty or instructions into facts: Is the invoice paid?",
      scenario: "ambiguous language and questions",
    },
    {
      file: "server/aptlssManagerFacts.test.ts",
      ancestors: ["fixed language and claim regressions"],
      title:
        "does not invert subject negation into a positive fact: No invoice was paid.",
      scenario: "negations and polarity",
    },
    {
      file: "server/aptlssManagerFacts.test.ts",
      ancestors: ["provenance, scope, revisions and reliability"],
      title:
        "only dated authoritative human resolution can supersede conflicting cross-source records",
      scenario: "source conflicts",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "accepts an actually done dependency absent from current actions",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "accepts completed source steps without rescheduling them",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "accepts done step evidence even when the dependency action id changed",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["reconcileManagerPlan"],
      title:
        "allows verification but not normal execution for blocked actions or blocked cards",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "blocks changes when a running timer has no retained block instead of inventing free time",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "card-only timer fallback selects one block, not all future blocks",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "checks cross-card source completion (false)",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "checks cross-card source completion (true)",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "clips and respects after shift breaks",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "clips and respects before shift breaks",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "clips and respects current break breaks",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "clips and respects exact boundary breaks",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "compares deadline movement and a retained-plan alternative using exact input references",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "counts all actual overlap pairs including nested preserved intervals",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "detects a same-day timezone change that moves a retained slot past its deadline",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "diffs from the latest saved blocks when an older proposal is stale and schedule inputs change",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "discloses inherited unknown estimates without blanket-blocking safe additions",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not borrow an unrelated same-card step estimate for an explicit timer",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not churn when persisted JSON object keys have a different order",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "does not claim precise deadline timing from a legacy baseline without timezone metadata",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not claim today's future work completed from a different card's step",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "does not compare another day's slots as today's baseline or fabricate a keep-plan option",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not consider a preserved active dependency completed",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not consider a preserved planned dependency completed",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not consider a preserved skipped dependency completed",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not count touching blocks as overlapping",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not count zero-duration preserved markers as overlaps",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not create a slot when merged breaks cover the entire shift",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not create duplicate blocks for duplicate action ids",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "does not hide unscheduled steps behind an earlier completed block on the same card",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not infer a timer association from null card and plan-block ids",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not invent a spring-forward clock time or shorten the estimated duration",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["manager planning impact preflight"],
      title:
        "does not manufacture deadlines or historical completion from a planned dependency",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["reconcileManagerPlan"],
      title: "does not mutate any input",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not present assessment scores as calibrated plan confidence",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not propose new work when the explicit timer block id is missing",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not propose new work when the timer points to a future plan block",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not protect another card with the same numeric step id",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not reserve extra time for a completed timer-linked block",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not reuse yesterday's blocks across a local date rollover",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["reconcileManagerPlan"],
      title: "does not schedule a -5-minute action estimate",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["reconcileManagerPlan"],
      title: "does not schedule a 0-minute action estimate",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not schedule after the end of the shift",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not schedule new work against an unusable active timer block (different card)",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not schedule new work against an unusable active timer block (invalid interval)",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not schedule new work against an unusable active timer block (skipped)",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not schedule next month today",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not schedule next year today",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title:
        "does not schedule the same source step twice under different action ids",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not schedule tomorrow local today",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not schedule tomorrow UTC today",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["reconcileManagerPlan"],
      title:
        "fits whole durations around overlapping breaks without reversing supplied order",
      scenario: "breaks and working hours",
    },
    {
      file: "server/aptlssManagerPlan.test.ts",
      ancestors: ["planning reliability regressions"],
      title: "does not schedule work at an ambiguous fall-back clock time",
      scenario: "time zones and clock transitions",
    },
  ];

export type AptlssRegressionEvidence = {
  file?: unknown;
  ancestorTitles?: unknown;
  title?: unknown;
  fullName?: unknown;
  status?: unknown;
};

export type AptlssRegressionCase = {
  file: string;
  ancestorTitles: string[];
  title: string;
  fullName: string;
};

export type AptlssRegressionCoverage = {
  cases: AptlssRegressionCase[];
  missingSuites: string[];
  missingCases: string[];
  missingScenarios: string[];
  scenarioEvidence: Array<{
    category: RegressionScenario;
    file: string;
    fullName: string;
  }>;
  ready: boolean;
};

const requiredSuiteSet = new Set<string>(APTLSS_REGRESSION_SUITE_FILES);
const caseIdentity = (file: string, fullName: string) => `${file}\0${fullName}`;
const requiredCases = new Map<string, RegressionCaseDefinition>();
for (const testCase of REQUIRED_APTLSS_REGRESSION_CASES) {
  const fullName = [...testCase.ancestors, testCase.title].join(" ");
  const id = caseIdentity(testCase.file, fullName);
  if (!requiredCases.has(id)) requiredCases.set(id, testCase);
}

export function invalidAptlssRegressionSuiteRuns(
  reportedFiles: readonly string[]
): string[] {
  return APTLSS_REGRESSION_SUITE_FILES.filter(
    file =>
      reportedFiles.filter(reportedFile => reportedFile === file).length !== 1
  );
}

export function evaluateAptlssRegressionCoverage(
  evidence: AptlssRegressionEvidence[]
): AptlssRegressionCoverage {
  const passedSuites = new Set<string>();
  const matchedCases = new Map<string, AptlssRegressionCase>();

  for (const item of evidence) {
    if (
      typeof item.file !== "string" ||
      !requiredSuiteSet.has(item.file) ||
      item.status !== "passed" ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      typeof item.fullName !== "string" ||
      !Array.isArray(item.ancestorTitles) ||
      item.ancestorTitles.length === 0 ||
      !item.ancestorTitles.every(
        (ancestor): ancestor is string =>
          typeof ancestor === "string" && Boolean(ancestor.trim())
      )
    ) {
      continue;
    }

    const ancestorTitles = item.ancestorTitles as string[];
    const expectedFullName = [...ancestorTitles, item.title].join(" ");
    if (item.fullName !== expectedFullName) continue;

    passedSuites.add(item.file);
    const id = caseIdentity(item.file, item.fullName);
    if (!requiredCases.has(id)) continue;
    matchedCases.set(id, {
      file: item.file,
      ancestorTitles,
      title: item.title,
      fullName: item.fullName,
    });
  }

  const cases = [...matchedCases.values()].sort((a, b) =>
    caseIdentity(a.file, a.fullName).localeCompare(
      caseIdentity(b.file, b.fullName)
    )
  );
  const matchedIds = new Set(matchedCases.keys());
  const missingCases = [...requiredCases.entries()]
    .filter(([id]) => !matchedIds.has(id))
    .map(
      ([, testCase]) =>
        `${testCase.file} :: ${[...testCase.ancestors, testCase.title].join(" ")}`
    );
  const scenarioEvidence = REQUIRED_APTLSS_REGRESSION_CASES.flatMap(
    testCase => {
      if (!testCase.scenario) return [];
      const fullName = [...testCase.ancestors, testCase.title].join(" ");
      if (!matchedIds.has(caseIdentity(testCase.file, fullName))) return [];
      return [{ category: testCase.scenario, file: testCase.file, fullName }];
    }
  );
  const evidencedScenarios = new Set(
    scenarioEvidence.map(item => item.category)
  );
  const requiredScenarios = new Set(
    REQUIRED_APTLSS_REGRESSION_CASES.flatMap(testCase =>
      testCase.scenario ? [testCase.scenario] : []
    )
  );
  const missingSuites = APTLSS_REGRESSION_SUITE_FILES.filter(
    file => !passedSuites.has(file)
  );
  const missingScenarios = [...requiredScenarios].filter(
    category => !evidencedScenarios.has(category)
  );
  const catalogIsValid =
    REQUIRED_APTLSS_REGRESSION_CASES.length >= MIN_APTLSS_REGRESSION_CASES &&
    requiredCases.size === REQUIRED_APTLSS_REGRESSION_CASES.length &&
    requiredScenarios.size === 9;

  return {
    cases,
    missingSuites: [...missingSuites],
    missingCases,
    missingScenarios,
    scenarioEvidence,
    ready:
      catalogIsValid &&
      cases.length >= MIN_APTLSS_REGRESSION_CASES &&
      missingCases.length === 0 &&
      missingSuites.length === 0 &&
      missingScenarios.length === 0,
  };
}
