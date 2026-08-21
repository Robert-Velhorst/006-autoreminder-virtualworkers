# APTLSS Shared Evidence Engine Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Build a shared, source-linked APTLSS intelligence layer that turns operational evidence and free-text updates into auditable assessments, targeted questions, and safe internal replanning in the worker portal.

**Architecture:** Extend the existing workspace evidence, APTLSS assessment, waiting-reason, feedback, and daily-plan records with additive, versioned provenance. A deterministic first-pass interpreter and bounded model-assisted enrichment produce evidence relations and assessments; a scheduler reconciles only unfinished future blocks. The worker timeline remains the execution surface and gains a right-side evidence inspector plus free-text preview and confirmation.

**Tech Stack:** TypeScript, React, Vite, Express, tRPC, Drizzle ORM, MySQL, Vitest, Playwright, existing OpenAI provider adapter, existing Trello/Gmail/Drive connectors.

**Spec:** docs/superpowers/specs/2026-08-21-aptlss-shared-evidence-engine-design.md

## Global Constraints

- Keep the developer migration lineage additive after migration 0031; do not modify an existing migration.
- Existing source systems remain canonical. APTLSS stores references and normalized, bounded snapshots.
- APTLSS may update internal assessments and future schedule blocks only. It must not post, move, archive, send, pay, or externally complete anything.
- Keep completed blocks and the active timer/active block unchanged during replanning.
- Source-confirmed evidence takes precedence over worker-confirmed, derived, and unverified conclusions.
- Missing, stale, unavailable, or contradictory evidence must reduce confidence or create a conflict.
- Audit every evidence read/write, interpretation confirmation/correction, assessment generation and schedule change.
- The worker view keeps the complete timeline and uses a right-side inspector for detail.
- Preserve current role, organization and tenant boundaries. Shared worker visibility does not remove authentication or audit requirements.
- Redact credentials, authorization headers, cookies and provider secrets before persistence or model invocation.
- Work in an isolated feature worktree and do not stage unrelated dirty files from the current checkout.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| drizzle/0032_aptlss_evidence_graph.sql | Additive graph, assessment provenance, exception verification, plan-change audit and indexes. |
| drizzle/schema.ts | Drizzle definitions and inferred types for new additive tables. |
| server/aptlssEvidenceGraph.ts | Normalize, deduplicate, link and audit typed evidence. |
| server/aptlssAssessmentEngine.ts | Compute factorized confidence, conflicts, gaps and recommendations. |
| server/aptlssFreeText.ts | Produce preview candidates and persist worker confirmation/correction. |
| server/aptlssOutcomeLearning.ts | Persist verified outcome feedback and bounded calibration signals. |
| server/operatorDailyPlan.ts | Reconcile future blocks and preserve causal plan audit. |
| server/operatorRouter.ts | tRPC read, preview, confirm, reassess and replan contract. |
| client/src/components/worker/AptlssEvidenceInspector.tsx | Evidence, confidence, conflict and history inspector. |
| client/src/components/worker/AptlssUpdateComposer.tsx | Worker free-text preview and confirmation flow. |
| client/src/components/worker/AptlssTimelineBlock.tsx | Compact and active timeline blocks. |
| client/src/pages/worker/WorkerOperator.tsx | Timeline orchestration and query invalidation. |
| e2e/aptlss-evidence-flow.spec.ts | Non-mutating browser regression. |

## Task 1: Establish an Isolated, Reviewable Baseline

**Files:** Create a feature worktree and branch named feat/aptlss-shared-evidence-engine. Copy only the approved specification and plan into that worktree if not committed. Do not modify the existing dirty checkout.

**Interfaces:** Consumes committed main, the approved spec and this plan. Produces an isolated branch with no accidental staging of unrelated dirty files.

- [ ] **Step 1: Record current branch, HEAD and porcelain status without changing files.**

~~~powershell
git branch --show-current
git rev-parse HEAD
git status --short
~~~

Expected: existing dirty work remains untouched.

- [ ] **Step 2: Create the feature worktree from committed main.**

~~~powershell
git worktree add ..\joyce-work-schedule-aptlss -b feat/aptlss-shared-evidence-engine main
~~~

Expected: git status is empty in the new worktree.

- [ ] **Step 3: Copy the approved spec and plan only, then compare their content.**

~~~powershell
git diff --no-index -- docs\superpowers\specs\2026-08-21-aptlss-shared-evidence-engine-design.md ..\joyce-work-schedule-aptlss\docs\superpowers\specs\2026-08-21-aptlss-shared-evidence-engine-design.md
~~~

- [ ] **Step 4: Run existing APTLSS regression tests.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssWaitingReason.test.ts server/aptlssWorkQueue.test.ts server/operatorMigration.test.ts
~~~

- [ ] **Step 5: Commit only the specification and plan.**

~~~powershell
git add -- docs/superpowers/specs/2026-08-21-aptlss-shared-evidence-engine-design.md docs/superpowers/plans/2026-08-21-aptlss-shared-evidence-engine.md
git commit -m "docs: define APTLSS shared evidence engine"
~~~

## Task 2: Add Additive Evidence Graph Persistence

**Files:** Create drizzle/0032_aptlss_evidence_graph.sql, server/aptlssEvidenceGraph.ts and server/aptlssEvidenceGraph.test.ts. Modify drizzle/schema.ts and drizzle/meta/_journal.json.

**Interfaces:** Consumes workspaceEvidenceItems, workspaceEvidenceLinks and authenticated worker context. Produces upsertAptlssEvidence, linkAptlssEvidence, getAptlssEvidenceForCard and appendAptlssEvidenceAudit.

- [ ] **Step 1: Write failing graph tests.**

~~~ts
it("deduplicates a source item by scope, source, and source id", async () => {
  await upsertAptlssEvidence(input);
  await upsertAptlssEvidence({ ...input, summary: "new summary" });
  expect(await getAptlssEvidenceForCard(input.scopeId, input.cardId)).toHaveLength(1);
});

it("does not return another tenant's evidence", async () => {
  await upsertAptlssEvidence({ ...input, scopeId: tenantA });
  expect(await getAptlssEvidenceForCard(tenantB, input.cardId)).toEqual([]);
});
~~~

- [ ] **Step 2: Run tests and verify they fail before implementation.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssEvidenceGraph.test.ts
~~~

- [ ] **Step 3: Add migration and Drizzle definitions.**

Create additive rows for evidence revisions, typed subject relations, worker exceptions, verification checks and evidence audit. Index scope plus subject, observed time and verification status. Keep existing workspace evidence tables unchanged.

- [ ] **Step 4: Implement bounded evidence graph functions.**

~~~ts
export type AptlssEvidenceInput = {
  scopeId: number;
  actorId: number;
  source: "trello" | "gmail" | "google_drive" | "communication" | "time" | "worker_update";
  sourceId: string;
  observedAt: Date;
  truthClass: "source_confirmed" | "worker_confirmed" | "derived" | "unverified";
  summary: string;
  rawReference: string | null;
};

export async function upsertAptlssEvidence(input: AptlssEvidenceInput): Promise<AptlssEvidenceRecord>;
export async function linkAptlssEvidence(input: {
  evidenceId: number;
  scopeId: number;
  subjectType: "card" | "project" | "decision" | "waiting_reason" | "schedule_block";
  subjectId: string;
  method: "source_native" | "deterministic" | "model_confirmed" | "worker_confirmed";
  confidence: number;
}): Promise<void>;
~~~

Use one transaction for revision plus audit. Bound summaries, reject secret-like values and scope every query.

- [ ] **Step 5: Run graph, parity and migration checks.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssEvidenceGraph.test.ts
npx.cmd pnpm@11.19.0 run db:verify-parity
npx.cmd pnpm@11.19.0 run db:migrate
~~~

- [ ] **Step 6: Commit the graph.**

~~~powershell
git add -- drizzle/0032_aptlss_evidence_graph.sql drizzle/meta/_journal.json drizzle/schema.ts server/aptlssEvidenceGraph.ts server/aptlssEvidenceGraph.test.ts
git commit -m "feat: add APTLSS evidence graph"
~~~

## Task 3: Build Assessment, Conflict and Confidence Logic

**Files:** Create server/aptlssAssessmentEngine.ts and server/aptlssAssessmentEngine.test.ts. Modify server/aptlssDb.ts and server/aptlssAuditDb.ts.

**Interfaces:** Consumes graph records, existing plans, steps, states, scores and waiting reasons. Produces assessAptlssSubject, AssessmentResult, AssessmentConflict and AssessmentQuestion.

- [ ] **Step 1: Write failing tests for staleness and conflicts.**

~~~ts
it("lowers confidence when evidence is stale or missing", async () => {
  const result = await assessAptlssSubject(staleEvidenceInput);
  expect(result.confidence.freshness).toBeLessThan(100);
  expect(result.confidence.band).not.toBe("high");
});

it("creates a conflict when newer source evidence contradicts an active waiting reason", async () => {
  const result = await assessAptlssSubject(conflictingInput);
  expect(result.conflicts).toContainEqual(expect.objectContaining({ type: "source_conflict" }));
  expect(result.questions).toHaveLength(1);
});
~~~

- [ ] **Step 2: Run the test and verify it fails.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssAssessmentEngine.test.ts
~~~

- [ ] **Step 3: Implement deterministic assessment with bounded model enrichment.**

~~~ts
export type AssessmentResult = {
  subject: { type: "card"; id: string };
  primaryState: string;
  nextAction: string;
  confidence: {
    score: number;
    band: "high" | "medium" | "low" | "conflict";
    coverage: number;
    corroboration: number;
    freshness: number;
    consistency: number;
    calibration: number;
    explanation: string;
  };
  evidenceIds: number[];
  conflicts: AssessmentConflict[];
  questions: AssessmentQuestion[];
  recommendations: string[];
};
~~~

Calculate deterministic facts first. Give a model only redacted, minimal source summaries; save model output as derived evidence, never source-confirmed.

- [ ] **Step 4: Persist immutable assessment provenance.**

Store factor breakdown, evidence IDs, questions, conflicts, recommendations, context hash, trigger and engine version as a new snapshot. Never overwrite an older assessment snapshot.

- [ ] **Step 5: Run assessment regression tests and commit.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssAssessmentEngine.test.ts server/aptlssWaitingReason.test.ts server/aptlssWorkQueue.test.ts
git add -- server/aptlssAssessmentEngine.ts server/aptlssAssessmentEngine.test.ts server/aptlssDb.ts server/aptlssAuditDb.ts
git commit -m "feat: assess APTLSS work from linked evidence"
~~~

## Task 4: Add Free-Text Preview, Confirmation and Exception Verification

**Files:** Create server/aptlssFreeText.ts and server/aptlssFreeText.test.ts. Modify server/aptlssWaitingReason.ts and server/aptlssWaitingReasonDb.ts.

**Interfaces:** Consumes worker text, authorized graph candidate lookup, waiting-reason interpreter and assessment engine. Produces previewWorkerUpdate, confirmWorkerUpdate and recordWorkerException.

- [ ] **Step 1: Write failing tests for linking, ambiguity and no external mutation.**

~~~ts
it("returns a preview without mutating external systems", async () => {
  const result = await previewWorkerUpdate({ text: "Waiting for the client to send the invoice", scopeId, actorId });
  expect(result.candidates[0]).toMatchObject({ subjectType: "card" });
  expect(trelloMutation).not.toHaveBeenCalled();
});

it("requires explicit selection when several cards are equally plausible", async () => {
  const result = await previewWorkerUpdate(ambiguousInput);
  expect(result.requiresConfirmation).toBe(true);
  expect(result.selectedSubject).toBeNull();
});
~~~

- [ ] **Step 2: Run the test and verify it fails.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssFreeText.test.ts
~~~

- [ ] **Step 3: Implement preview-only interpretation.**

~~~ts
export type WorkerUpdatePreview = {
  originalText: string;
  candidates: Array<{ subjectType: "card" | "project" | "waiting_reason"; subjectId: string; score: number; reason: string }>;
  selectedSubject: { subjectType: "card" | "project" | "waiting_reason"; subjectId: string } | null;
  interpretation: WaitingReasonInterpretation | null;
  assessment: AssessmentResult | null;
  requiresConfirmation: boolean;
};
~~~

Preview does not create source-confirmed evidence. Confirmation stores original text, approved relation and correction reason. A contradiction with stronger evidence creates one verification follow-up.

- [ ] **Step 4: Run tests and commit.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssFreeText.test.ts server/aptlssWaitingReason.test.ts
git add -- server/aptlssFreeText.ts server/aptlssFreeText.test.ts server/aptlssWaitingReason.ts server/aptlssWaitingReasonDb.ts
git commit -m "feat: preview and confirm APTLSS worker updates"
~~~

## Task 5: Persist Outcome Feedback and Calibration

**Files:** Create server/aptlssOutcomeLearning.ts and server/aptlssOutcomeLearning.test.ts. Modify the additive migration and drizzle/schema.ts.

**Interfaces:** Consumes immutable assessment versions, confirmed/verified evidence and decision outcomes. Produces recordAssessmentOutcome, getCalibrationSignal and getAssessmentHistory.

- [ ] **Step 1: Write a failing immutability test.**

~~~ts
it("records a verified outcome without rewriting the original assessment", async () => {
  const before = await getAssessmentHistory(scopeId, cardId);
  await recordAssessmentOutcome({ assessmentId: before[0].id, verdict: "partial", actorId, verifiedEvidenceIds: [evidenceId] });
  const after = await getAssessmentHistory(scopeId, cardId);
  expect(after).toHaveLength(2);
  expect(after[0].confidenceScore).toBe(before[0].confidenceScore);
});
~~~

- [ ] **Step 2: Implement additive outcome and bounded calibration persistence.**

Store assessment version, evidence set, prediction, worker response, verified result, verdict, recorder and resolved time. Return neutral calibration until an explicit minimum sample size is met. Never copy raw secrets into aggregate learning records.

- [ ] **Step 3: Run tests and commit.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/aptlssOutcomeLearning.test.ts server/aptlssAssessmentEngine.test.ts
git add -- drizzle/0032_aptlss_evidence_graph.sql drizzle/schema.ts server/aptlssOutcomeLearning.ts server/aptlssOutcomeLearning.test.ts
git commit -m "feat: calibrate APTLSS from verified outcomes"
~~~

## Task 6: Reconcile Future Plans Safely

**Files:** Modify server/operatorDailyPlan.ts and server/operatorRouter.ts. Create server/operatorDailyPlan.test.ts and server/operatorRouter.test.ts.

**Interfaces:** Consumes AssessmentResult, existing OperatorDailyPlanPayload and active timer state. Produces replanOperatorRemainingDay and getPlanChangeHistory.

- [ ] **Step 1: Write failing preservation/order tests.**

~~~ts
it("preserves completed and active blocks while replanning future work", async () => {
  const result = await replanOperatorRemainingDay({ vaId, dateKey, now: "10:10", activeBlockId: "active", completedBlockIds: ["done"], assessmentIds: [assessmentId], actorId });
  expect(result.blocks.find((block) => block.id === "done")?.status).toBe("done");
  expect(result.blocks.find((block) => block.id === "active")?.status).toBe("active");
});

it("orders equal-priority work ON-HOLD, then DOING, then TO-DO", async () => {
  expect(result.blocks.map((block) => block.state)).toEqual(["ON_HOLD", "DOING", "TODO"]);
});
~~~

- [ ] **Step 2: Implement future-only replanning.**

~~~ts
export async function replanOperatorRemainingDay(input: {
  vaId: number;
  dateKey: string;
  now: string;
  completedBlockIds: string[];
  activeBlockId: string | null;
  assessmentIds: number[];
  actorId: number;
}): Promise<OperatorDailyPlanPayload>;
~~~

Keep historical/active blocks, honor working hours and protected breaks, prevent overlap, use existing ON-HOLD/DOING/TO-DO rank and append an audit entry naming assessment/evidence trigger. Do not call external clients.

- [ ] **Step 3: Add tRPC contract and tests.**

Add previewWorkerUpdate, confirmWorkerUpdate, getAssessmentHistory, getPlanChangeHistory and replanRemainingDay under operator. Use the existing worker authorization procedure; database absence returns PRECONDITION_FAILED.

- [ ] **Step 4: Run tests and commit.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run server/operatorDailyPlan.test.ts server/operatorRouter.test.ts server/operatorDailyPlanQueryContract.test.ts server/aptlssRouteSecurity.test.ts
git add -- server/operatorDailyPlan.ts server/operatorDailyPlan.test.ts server/operatorRouter.ts server/operatorRouter.test.ts
git commit -m "feat: replan APTLSS work from evidence"
~~~

## Task 7: Build Timeline, Inspector and Free-Text Worker Flow

**Files:** Create client/src/components/worker/AptlssEvidenceInspector.tsx, AptlssUpdateComposer.tsx and AptlssTimelineBlock.tsx. Modify client/src/pages/worker/WorkerOperator.tsx. Create WorkerOperator.test.tsx.

**Interfaces:** Consumes operator daily-plan, work-queue, preview/confirm/replan procedures. Produces full-day progressive-reveal timeline and right-side inspector.

- [ ] **Step 1: Write failing UI tests.**

~~~tsx
it("keeps the timeline visible when an evidence inspector opens", async () => {
  render(<PlanView />);
  await userEvent.click(screen.getByRole("button", { name: /prepare client decision brief/i }));
  expect(screen.getByRole("heading", { name: /day timeline/i })).toBeVisible();
  expect(screen.getByRole("complementary", { name: /evidence inspector/i })).toBeVisible();
});

it("does not enable confirmation until the worker accepts or corrects the preview", async () => {
  render(<AptlssUpdateComposer card={card} />);
  await userEvent.type(screen.getByLabelText(/what changed/i), "Waiting for client reply");
  await userEvent.click(screen.getByRole("button", { name: /assess update/i }));
  expect(screen.getByRole("button", { name: /confirm update/i })).toBeDisabled();
});
~~~

- [ ] **Step 2: Extract focused UI components.**

Show all blocks but expand only the active block. Give compact blocks one primary action. Keep confidence coverage, conflicts, plan health and free-text entry in a narrow signal rail. Use a right-side Sheet/resizable panel so the timeline stays visible.

- [ ] **Step 3: Implement preview/confirmation and degraded states.**

Call operator.previewWorkerUpdate for explicit text and show source candidates, confidence, conflicts and one question. Call operator.confirmWorkerUpdate only after explicit choice. Invalidate only plan, work queue and selected-card queries. Explain source/provider/database gaps without sample data or unavailable actions.

- [ ] **Step 4: Run UI tests and commit.**

~~~powershell
npx.cmd pnpm@11.19.0 vitest run client/src/pages/worker/WorkerOperator.test.tsx
npx.cmd pnpm@11.19.0 check
git add -- client/src/pages/worker/WorkerOperator.tsx client/src/pages/worker/WorkerOperator.test.tsx client/src/components/worker/AptlssEvidenceInspector.tsx client/src/components/worker/AptlssUpdateComposer.tsx client/src/components/worker/AptlssTimelineBlock.tsx
git commit -m "feat: add APTLSS evidence timeline workflow"
~~~

## Task 8: Document, Verify and Publish a Draft Pull Request

**Files:** Create docs/APTLSS_EVIDENCE_OPERATIONS.md and e2e/aptlss-evidence-flow.spec.ts. Modify README.md only for a concise operational link.

**Interfaces:** Consumes completed server/client behavior. Produces operator guidance, release evidence and a draft pull request targeting main.

- [ ] **Step 1: Document normal and degraded operation.**

Explain evidence classes, confidence bands, conflict resolution, worker exceptions, plan-change history, provider/source outages and external action boundary. Include no credentials or personal raw evidence.

- [ ] **Step 2: Add a non-mutating browser flow.**

~~~ts
test("worker can inspect evidence and preview an update without external mutation", async ({ page }) => {
  await page.goto("/worker/plan");
  await page.getByRole("button", { name: /open evidence/i }).first().click();
  await expect(page.getByRole("complementary", { name: /evidence inspector/i })).toBeVisible();
  await page.getByLabel(/what changed/i).fill("Waiting for a verified client reply");
  await page.getByRole("button", { name: /assess update/i }).click();
  await expect(page.getByText(/source-linked interpretation/i)).toBeVisible();
});
~~~

- [ ] **Step 3: Run full local checks.**

~~~powershell
npx.cmd pnpm@11.19.0 check
npx.cmd pnpm@11.19.0 test
npx.cmd pnpm@11.19.0 build
npx.cmd pnpm@11.19.0 test:e2e
npx.cmd pnpm@11.19.0 run db:verify-parity
npx.cmd pnpm@11.19.0 audit --prod --audit-level=high
~~~

- [ ] **Step 4: Run Browser and Computer desktop/mobile QA.**

Check the authenticated worker timeline, inspector, conflict, free-text preview, provider/database degraded states, no overflow, no error overlay and no unintended external mutation.

- [ ] **Step 5: Run security diff review.**

Review every changed source and migration file against the exact feature branch diff. Validate reportable findings before remediation and report unavailable coverage as a release gate.

- [ ] **Step 6: Commit documentation/tests, push and create draft PR.**

~~~powershell
git add -- docs/APTLSS_EVIDENCE_OPERATIONS.md e2e/aptlss-evidence-flow.spec.ts README.md
git commit -m "docs: document APTLSS evidence operations"
git push -u origin feat/aptlss-shared-evidence-engine
gh pr create --base main --head feat/aptlss-shared-evidence-engine --draft --title "feat: add shared APTLSS evidence engine"
~~~

Inspect GitHub and CircleCI checks. If CircleCI fails, identify the first failing job and step, classify the cause, patch only that cause, run focused validation and push the fix.

## Plan Self-Review

- Evidence graph and audit: Task 2.
- Confidence, conflicts and evidence gaps: Task 3.
- Free-text update, correction and exception verification: Task 4.
- Outcome learning without historical rewrites: Task 5.
- Future-only replanning with ON-HOLD/DOING/TO-DO ordering: Task 6.
- Full timeline plus right-side inspector: Task 7.
- Degraded states, browser QA, security review, CI and PR: Task 8.
- Dirty-worktree protection: Task 1.

No task performs an external action during assessment, planning, test or browser verification.


