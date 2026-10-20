import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import superjson from "superjson";
import type { ManagerPlanImpact } from "../shared/aptlssManagerPlanImpact";

test.describe("APTLSS CONTRACT fixtures (intercepted API)", () => {
  const browserErrors = new WeakMap<Page, string[]>();

  // Contract fixtures isolate UI checks from provider calls and database mutations.
  // Live authorization, persistence and room isolation are separate integration checks.
  async function managerFixture(
    page: Page,
    role: "worker" | "admin",
    options: {
      unavailable?: boolean;
      eligible?: boolean;
      realtime?: boolean;
      reviewed?: boolean;
      proof?: boolean;
      evidenceUnavailable?: boolean;
      waiting?: boolean;
      calibration?: boolean;
      sourceCheck?: boolean;
      mode?: "shadow" | "active";
      queued?: boolean;
      assessmentDelayMs?: number;
      reassessWorkerUpdate?: boolean;
      queueCards?: Array<Record<string, unknown>>;
      planningImpact?: ManagerPlanImpact;
      savedPlan?: Record<string, unknown> | null;
      savedPlanVersion?: string;
      dailyPlanEditable?: boolean;
      googleStatus?: Record<string, unknown>;
        founderDecisions?: boolean;
        founderNotification?: boolean;
    } = {}
  ) {
    const calls: Array<{ method: string; input: any }> = [];
    let proofResolved = false;
    let founderDecisionRecorded = false;
    let founderDecisionDeferred = false;
    let founderDecisionDueAt: string | null = null;
    let founderDeadlineSource: string | null = null;
    const at = new Date(Date.now() - 120_000).toISOString();
    const proposal = {
      version: 2,
      dateKey: at.slice(0, 10),
      generatedAt: at,
      blocks: [
        {
          id: "block-1",
          startTime: "10:00",
          endTime: "10:20",
          cardId: "card-1",
          cardName: "Verify delivery",
          action: "Check the source record",
          status: "planned",
          flags: [],
          notes: "",
          priority: "HIGH",
        },
      ],
      robertItems: [],
      unscheduledCards: [],
      planHealth: {
        confidence: 0,
        scheduledMinutes: 20,
        availableMinutes: 480,
        overlaps: 0,
        gaps: 460,
      },
      constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
      auditTrail: [
        {
          at,
          action: "APTLSS manager reconciliation",
          detail: "Shadow proposal",
        },
      ],
      planningImpact: options.planningImpact,
    };
    const snapshot = {
      version: 1,
      runId: 101,
      trigger: "manual",
      assessedAt: at,
      executionReady: true,
      policy: { enabled: true, intervalMinutes: 5, mode: "shadow" },
      nextCheckAt: null,
      cards: [
        {
          id: "card-1",
          name: "Verify delivery",
          url: "https://trello.com/c/example",
          board: "Work",
          list: "Doing",
        },
      ],
      assessments: [
        {
          cardId: "card-1",
          state: "doing",
          explanation: "Delivery reported; receipt remains unverified.",
          confidence: 0,
          uncertainties: [],
          evidenceIds: ["e-1"],
          actions: [],
          reliability: {
            coverage: "partial",
            freshness: "current",
            conflicts: "none_detected",
            support: "reported",
            calibrated: false,
            reasons: ["Receipt not independently verified"],
          },
        },
      ],
      actions: [],
      interventions: [],
      sourceGaps: [],
      changes: [],
      evidence: [
        {
          id: "e-1",
          cardId: "card-1",
          source: "trello",
          text: "Delivery reported in card comment",
          observedAt: at,
          url: "https://trello.com/c/example",
          kind: "source",
        },
      ],
      proposal,
      planVersion: "v-review-1",
      applied: false,
      timing: {
        samples: 0,
        withinRange: 0,
        meanAbsoluteErrorMinutes: null,
        waitingMinutes: 0,
        interruptedMinutes: 0,
      },
    };
    const gate = {
      eligible: options.eligible ?? false,
      reasons: options.eligible ? [] : ["More reviewed working days required"],
      reviewed: 2,
      correct: 2,
      workingDays: 1,
      unreviewedUrgent: 0,
      critical: 0,
      safetyVerified: false,
    };
    let managerSocket:
      | { send: (data: string) => void; close: () => void }
      | undefined;
    await page.routeWebSocket("**/ws/**", socket => {
      if (!options.realtime) {
        socket.close();
        return;
      }
      managerSocket = socket;
      socket.send(
        `0${JSON.stringify({ sid: "fixture-engine", upgrades: [], pingInterval: 25000, pingTimeout: 20000 })}`
      );
      socket.onMessage(message => {
        if (message === "40") socket.send('40{"sid":"fixture-manager"}');
        if (message === "2") socket.send("3");
      });
    });
    await page.route("**/ws/**", route => route.abort());
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/trpc/")) {
        if (options.founderNotification && url.pathname === "/api/notifications/unread-count") {
          await route.fulfill({ json: { unreadCount: 1 } });
          return;
        }
        if (options.founderNotification && url.pathname === "/api/notifications") {
          await route.fulfill({ json: { notifications: [{
            id: 91, title: "Founder decision due soon", content: "A decision is needed: approve the delivery follow-up.",
            notificationType: "task_due_soon", taskId: "founder-decision:51:71:due_soon", taskName: null,
            dueDate: at, channel: "in_app", deliveryStatus: "sent", isRead: 0, createdAt: at,
          }] } });
          return;
        }
        await route.fulfill({ json: [] });
        return;
      }
      const methods = decodeURIComponent(
        url.pathname.split("/api/trpc/")[1]
      ).split(",");
      const raw =
        route.request().method() === "GET"
          ? url.searchParams.get("input")
          : route.request().postData();
      const inputs = JSON.parse(raw || "{}");
      if (options.assessmentDelayMs && methods.some(method => ["operator.runManager", "operator.submitManagerUpdate", "operator.runManagerForReview"].includes(method))) {
        await new Promise(resolve => setTimeout(resolve, options.assessmentDelayMs));
      }
      const results = methods.map((method, index) => {
        const envelope = url.searchParams.has("batch") ? inputs[index] : inputs;
        const input = envelope && "json" in envelope
          ? superjson.deserialize(envelope)
          : undefined;
        calls.push({ method, input });
        if (method === "operator.getCardEvidence" && options.evidenceUnavailable) {
          return { error: superjson.serialize({ message: "Synthetic retained source unavailable", code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: method } }) };
        }
        let value: unknown = null;
        if (method === "auth.me")
          value = {
            id: role === "admin" ? 1 : 2,
            openId: role,
            name: "Test Operator",
            email: "test@example.invalid",
            role,
          };
        if (method === "operator.getContext")
          value = {
            displayName: "Test Operator",
            founderName: "Robert",
            timezone: "UTC",
            workingDays: [1, 2, 3, 4, 5],
            breaks: [],
            workStartTime: "09:00",
            workEndTime: "18:00",
          };
        if (method === "system.health") value = { runtime: "unified-node" };
        if (method === "trello.actionAlerts")
          value = { onHoldCards: [], doingCards: [], overdueCards: [] };
        if (method === "operator.getWorkQueueContext")
          value = {
            cards: options.queueCards ?? (options.proof
              ? [
                  {
                    cardId: "card-1",
                    cardName: "Verify delivery",
                    cardUrl: "https://example.invalid/source",
                    trelloCache: options.sourceCheck ? {
                      cachedAt: at,
                      expiresAt: new Date(Date.now() - 60_000).toISOString(),
                    } : null,
                    boardName: "Work",
                    listName: options.waiting ? "ON-HOLD" : "Doing",
                    nextBestAction: "Verify retained facts",
                    planSummary: "PRIVATE_PLAN_SUMMARY_SENTINEL",
                    primaryState: "DOING",
                    stateReason: "PRIVATE_STATE_REASON_SENTINEL",
                    actionability: "actionable",
                    priorityScore: 50,
                    priorityTier: "HIGH",
                    confidenceScore: 98,
                    confidenceReason: "PRIVATE_CONFIDENCE_REASON_SENTINEL",
                    recommendations: ["PRIVATE_RECOMMENDATION_SENTINEL"],
                    uncertainties: ["PRIVATE_UNCERTAINTY_SENTINEL"],
                    steps: [],
                    waitingReason: null,
                    evidenceSummary: {
                      sources: options.sourceCheck ? [{ key: "gmail", label: "Gmail", count: 1, status: "linked", detail: "1 linked email" }] : [],
                      issues: options.calibration ? [
                        { id: "forecast-calibration", title: "The remaining-time forecast needs calibration", detail: "P50 8h P90 14h", resolution: "Plan against P90", severity: "high" },
                        { id: "private-assessment", title: "PRIVATE_ISSUE_TITLE_SENTINEL", detail: "PRIVATE_ISSUE_DETAIL_SENTINEL", resolution: "PRIVATE_ISSUE_RESOLUTION_SENTINEL", severity: "high" },
                      ] : [],
                      forecast: null,
                      confidenceProfile: { targetScore: 90, ceiling: 80, gapToTarget: 10, dimensions: {}, blockers: ["PRIVATE_CONFIDENCE_BLOCKER_SENTINEL"] },
                    },
                  },
                ]
              : []),
          };
        if (method === "operator.getCardEvidence")
          value = options.proof
            ? [
                {
                  id: "evidence:900",
                  evidenceId: 900,
                  source: "google_drive",
                  role: "source",
                  title: "Retained payment confirmation",
                  content: "Invoice alpha is paid.",
                  sourceUrl: "https://drive.google.com/file/d/example",
                  observedAt: at,
                  modifiedAt: at,
                  metadataJson: "PRIVATE_AI_THOUGHT_SENTINEL",
                  contentHash: "PRIVATE_CONTENT_HASH_SENTINEL",
                  contentNote: "File details only; open the Drive file to review its contents.",
                  statusLabel: null,
                },
                {
                  id: "evidence:901",
                  evidenceId: null,
                  source: "communication",
                  role: "worker_update",
                  title: "Unverified worker claim",
                  content: "I checked the supplier ledger against the receipt.",
                  sourceUrl: null,
                  observedAt: at,
                  modifiedAt: at,
                  contentNote: null,
                  statusLabel: null,
                },
                {
                  id: "email:902",
                  evidenceId: null,
                  source: "gmail",
                  role: "source_preview",
                  title: "A portal message is ready",
                  content: "From: clerk@example.test\n\nOpen the portal to read the message.",
                  sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-902",
                  observedAt: at,
                  modifiedAt: null,
                  contentNote: "Portal notice only; open the email to read the underlying correspondence.",
                  statusLabel: "Pending review",
                  suggestedNextAction: "PRIVATE_AI_ACTION_SENTINEL",
                  llmSummary: "PRIVATE_AI_SUMMARY_SENTINEL",
                },
                {
                  id: "decision:903",
                  evidenceId: null,
                  source: "decision_outcome",
                  role: "reviewed_resolution",
                  title: "Decision outcome",
                  content: "Robert approved the documented next step.",
                  sourceUrl: null,
                  observedAt: at,
                  modifiedAt: null,
                  contentNote: null,
                  statusLabel: "Approved",
                  decisionPrompt: "PRIVATE_DECISION_PROMPT_SENTINEL",
                  recommendedDecision: "PRIVATE_AI_RECOMMENDATION_SENTINEL",
                },
              ]
            : [];
        if (method === "operator.getVerificationFollowups")
          value =
            options.proof && !proofResolved
              ? [
                  {
                    id: 700,
                    conflictId: 800,
                    cardId: "card-1",
                    title: "Verify conflicting work evidence",
                    question: "Which payment record resolves this conflict?",
                  },
                ]
              : [];
        if (method === "operator.getGoogleEvidenceStatus")
          value = options.googleStatus ?? (options.sourceCheck ? {
            credentialsReady: true,
            gmail: { enabled: true, lastSyncedAt: new Date(Date.now() - 120 * 60_000).toISOString(), intervalMinutes: 30 },
            drive: { enabled: true, lastSyncedAt: null, intervalMinutes: 30 },
          } : null);
        if (method === "operator.resolveVerificationFollowup") {
          const proof = input as {
            sourceEvidenceId?: number;
            sourceQuote?: string;
          };
          proofResolved =
            proof.sourceEvidenceId === 900 &&
            proof.sourceQuote === "Invoice alpha is paid.";
          value = {
            followupId: 700,
            requiresEvidence: !proofResolved,
            resolvedAt: proofResolved ? at : null,
          };
        }
        if (method === "operator.getDailyPlan") value = options.savedPlan === null ? null : { schedule: options.savedPlan ?? proposal, planVersion: options.savedPlanVersion ?? "v-review-1" };
        if (method === "operator.getDailyPlanEditingPolicy") value = { editable: options.dailyPlanEditable ?? true };
        if (method === "operator.getBrowserTabPolicy")
          value = {
            enabled: true,
            maxOpenTabs: 5,
            warningMinutesBeforeEnd: 30,
            staleAfterMinutes: 10,
            includePinnedTabs: false,
          };
        if (method === "operator.getManagerStatus")
          value = {
            snapshot,
            expectedRunId: snapshot.runId,
            policy: snapshot.policy,
            checkedAt: at,
            lastSuccessfulAt: at,
            queue: options.queued ? { state: "pending", requestedAt: at, availableAt: at, attempts: 2, lastError: "Assessment retry scheduled", completedAt: null } : null,
            error: options.unavailable ? "Source refresh failed" : undefined,
            gate,
          };
        if (method === "operator.reportManagerActionCompletion")
          value = { reportId: 55, alreadyRecorded: false, reassessed: true, assessmentRunId: 102, applied: false };
        if (
          method === "operator.runManager" ||
          method === "operator.submitManagerUpdate" ||
          method === "operator.runManagerForReview"
        ) {
          if (method === "operator.submitManagerUpdate" && options.reassessWorkerUpdate) {
            snapshot.runId = 102;
            (snapshot.interventions as unknown[]).splice(0, snapshot.interventions.length);
            (snapshot.interventions as unknown[]).push({
              id: "reassessed-source-check",
              cardId: "card-1",
              issueKind: "reported_difference",
              severity: "attention",
              title: "The receipt is still unverified",
              explanation: "The worker could not open the original receipt; delivery must remain unconfirmed.",
              question: "Can Robert provide an accessible copy of the receipt?",
              safeAction: "Keep the delivery status unchanged and request access to the original receipt.",
              evidenceIds: ["worker-update-1"],
            });
            snapshot.evidence.push({
              id: "worker-update-1",
              cardId: "card-1",
              source: "worker_update",
              kind: "worker",
              text: "Cannot access the original receipt; it is in the vendor portal.",
              observedAt: new Date().toISOString(),
              metadata: { truthClass: "worker_report" },
            });
          }
          value = snapshot;
        }
        if (method === "operator.getManagerReviewInbox") {
          const vaId = (input as { vaId?: number } | undefined)?.vaId;
          value = {
            workers: [
              { id: 2, name: "Worker One" },
              { id: 3, name: "Worker Two" },
            ],
            workerId: vaId ?? null,
            mode: options.mode ?? "shadow",
            entries: vaId
              ? [
                  {
                    runId: 101,
                    vaId,
                    createdAt: at,
                    snapshot,
                    review: options.reviewed
                      ? {
                          verdict: "correct",
                          critical: false,
                          correction: "",
                          source: "Verified source record",
                        }
                      : null,
                  },
                ]
              : [],
            gate,
          };
        }
        if (method === "operator.getFounderDecisionInbox")
          value = { items: options.founderDecisions && !founderDecisionRecorded ? [{
            stepId: 51,
            vaId: 2,
            cardId: "card-1",
            cardName: "Verify delivery",
            cardUrl: "https://trello.com/c/example",
            boardName: "Work",
            stepTitle: "Approve the delivery follow-up",
            workerName: "Worker One",
            tier: "HIGH",
            taskDueAt: null,
            decisionDueAt: founderDecisionDueAt,
            deadlineSource: founderDeadlineSource,
            isDeferred: founderDecisionDeferred,
            deferralReason: founderDecisionDeferred ? founderDeadlineSource?.replace(/^Deferred:\s*/i, "") ?? null : null,
            escalation: founderDecisionDueAt ? "decision_due_soon" : "high_priority_no_deadline",
            owner: "founder",
            riskIfSkipped: "The customer may not receive an answer.",
            completionCriteria: "Founder records the approved follow-up.",
            createdAt: at,
          }] : [] };
        if (method === "operator.recordFounderDecisionOutcome") {
          founderDecisionRecorded = true;
          value = { id: 61, cardId: "card-1", resolvedAt: at, reassessmentQueued: true };
        }
        if (method === "operator.setFounderDecisionDeadline") {
          founderDecisionDueAt = (input as { dueAt: string | null }).dueAt;
          founderDeadlineSource = (input as { source: string }).source;
          founderDecisionDeferred = false;
          value = { revisionId: 71, changed: true };
        }
        if (method === "operator.deferFounderDecision") {
          const deferInput = input as { dueAt: string; reason: string };
          founderDecisionDueAt = deferInput.dueAt;
          founderDeadlineSource = `Deferred: ${deferInput.reason}`;
          founderDecisionDeferred = true;
          value = { revisionId: 72, changed: true };
        }
        if (method === "aptlss.getDecisionQueue") value = { items: options.founderDecisions ? [{
          stepId: 51, cardId: "card-1", cardName: "Verify delivery",
          cardUrl: "https://trello.com/c/example", stepIndex: 1,
          stepTitle: "Approve the delivery follow-up", tier: "HIGH",
        }] : [] };
        if (method === "operator.getDecisionHistory") value = [];
        if (method === "operator.recordManagerReview")
          value = { recorded: true, revertedToShadow: !!(input as { critical?: boolean }).critical, correctionId: null };
        if (method === "operator.setManagerMode") value = { success: true };
        return { result: { data: superjson.serialize(value) } };
      });
      await route.fulfill({
        json: url.searchParams.has("batch") ? results : results[0],
      });
    });
    return {
      calls,
      snapshot,
      emitManagerUpdate: () =>
        managerSocket?.send(
          '42["aptlss:manager-updated",{"runId":102,"assessedAt":"2026-09-04T10:00:00Z","urgent":true}]'
        ),
      disconnect: () => managerSocket?.close(),
    };
  }

  async function expectAccessible(page: Page, label: string, scope?: string) {
    let axe = new AxeBuilder({ page }).withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
    ]);
    if (scope) axe = axe.include(scope);
    const results = await axe.analyze();
    const violations = results.violations.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      nodes: violation.nodes.map(node => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
      })),
    }));
    await test.info().attach(`${label}-accessibility.json`, {
      body: JSON.stringify(violations, null, 2),
      contentType: "application/json",
    });
    expect(violations, `${label} WCAG 2.2 AA violations`).toEqual([]);
  }

  test.beforeEach(async ({ page }, testInfo) => {
    const errors: string[] = [];
    browserErrors.set(page, errors);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      // Disconnected-socket fixtures deliberately exercise transport failure.
      if (
        message.type() === "error" &&
        !/WebSocket|net::ERR_FAILED|net::ERR_CONNECTION_CLOSED/.test(
          message.text()
        )
      )
        errors.push(message.text());
    });
    await page.addInitScript(
      theme => localStorage.setItem("theme", theme),
      testInfo.project.name.includes("light") ? "light" : "dark"
    );
  });

  test.afterEach(async ({ page }) => {
    expect(browserErrors.get(page) ?? []).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });

  for (const width of [1280, 390]) test(`founder records a decision in the dedicated inbox at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await managerFixture(page, "admin", { founderDecisions: true });
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Decisions" }).click();
    const inbox = page.getByRole("region", { name: "Founder decision inbox" });
    await expect(inbox.getByText("Worker One · Work", { exact: true })).toBeVisible();
    await expect(inbox.getByText("No task deadline recorded", { exact: false })).toBeVisible();
    await expect(inbox.getByRole("link", { name: "Open source card" })).toHaveAttribute("href", "https://trello.com/c/example");
    await page.screenshot({ path: testInfo.outputPath(`founder-decisions-open-${width}.png`), fullPage: true });
    const localDue = await page.evaluate(() => {
      const date = new Date(Date.now() + 60 * 60_000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    await inbox.getByLabel("Decision deadline").fill(localDue);
    await inbox.getByLabel("Source or reason").fill("Linked card deadline confirmed by founder");
    await inbox.getByRole("button", { name: "Save deadline" }).click();
    await expect(inbox.getByText("Decision due:", { exact: false })).toBeVisible();
    await expect(inbox.getByText("Decision due soon", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Decisions 1/ })).toBeVisible();
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("button", { name: /founder decision or task deadline needs attention/ }).click();
    await expect(inbox.getByText("Decision due:", { exact: false })).toBeVisible();
    await expect(inbox.getByRole("button", { name: "Clear deadline" })).toBeDisabled();
    await inbox.getByLabel("Reason for withdrawing this deadline").fill("Source date was corrected by the founder");
    await expect(inbox.getByRole("button", { name: "Clear deadline" })).toBeEnabled();
    expect(calls.some(call => call.method === "operator.setFounderDecisionDeadline" && call.input.vaId === 2 && call.input.stepId === 51 && call.input.source === "Linked card deadline confirmed by founder")).toBe(true);
    const finalDecision = inbox.getByRole("button", { name: "Choose approve or reject" });
    await expect(finalDecision).toBeDisabled();
    await inbox.getByRole("button", { name: "Approve", exact: true }).click();
    await inbox.getByLabel("Reason and source checked").fill("Approved after checking the linked delivery record.");
    await inbox.getByRole("button", { name: "Record approval" }).click();
    await expect(inbox.getByText("No founder decisions are waiting.")).toBeVisible();
    expect(calls.some(call => call.method === "operator.recordFounderDecisionOutcome" && call.input.vaId === 2 && call.input.stepId === 51 && call.input.disposition === "approved")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`founder-decisions-${width}.png`), fullPage: true });
  });

  for (const width of [1280, 390]) test(`founder can defer without closing a decision at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await managerFixture(page, "admin", { founderDecisions: true });
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Decisions" }).click();
    const inbox = page.getByRole("region", { name: "Founder decision inbox" });
    const localDue = await page.evaluate(() => {
      const date = new Date(Date.now() + 2 * 60 * 60_000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    await inbox.getByLabel("Decision deadline").fill(localDue);
    await inbox.getByLabel("Source or reason").fill("Waiting for the source record");
    await inbox.getByRole("button", { name: "Defer decision to this date" }).click();
    await expect(inbox.getByText("Decision deferred", { exact: false })).toBeVisible();
    await expect(inbox.getByText(/Deferred · review/)).toBeVisible();
    await expect(inbox.getByRole("button", { name: "Record approval" })).toHaveCount(0);
    await expect(inbox.getByRole("button", { name: "Choose approve or reject" })).toBeDisabled();
    expect(calls.some(call => call.method === "operator.deferFounderDecision"
      && call.input.vaId === 2 && call.input.stepId === 51
      && call.input.reason === "Waiting for the source record"
      && call.input.dueAt === new Date(localDue).toISOString())).toBe(true);
    expect(calls.some(call => call.method === "operator.recordFounderDecisionOutcome")).toBe(false);
  });

  for (const width of [1280, 390]) test(`founder notification opens the decision inbox at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await managerFixture(page, "admin", { founderDecisions: true, founderNotification: true });
    await page.goto("/founder");
    await page.getByRole("button", { name: "Notifications" }).click();
    await page.getByRole("button", { name: /A decision is needed: approve the delivery follow-up/ }).click();
    await expect(page).toHaveURL(/\/founder\?tab=founder-decisions$/);
    await expect(page.getByRole("region", { name: "Founder decision inbox" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Decisions" })).toHaveAttribute("data-state", "active");
  });

  test("worker sees a founder-owned hold without a decision control or model recommendation", async ({ page }) => {
    await managerFixture(page, "worker", { founderDecisions: true });
    await page.goto("/worker/decisions");
    await expect(page.getByText("This step remains on hold.", { exact: false })).toBeVisible();
    await expect(page.getByText("Decision owner: Robert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Record decision" })).toHaveCount(0);
    await expect(page.getByText("AI recommendation", { exact: false })).toHaveCount(0);
  });

  for (const width of [1280, 390]) test(`focused questions preserve source comparison at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { snapshot } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({ id: "conflict", cardId: "card-1", issueKind: "conflicting_claims", severity: "urgent", title: "Verify deadline", explanation: "Sources disagree", question: "Which deadline applies now?", safeAction: "Verify before continuing", evidenceIds: ["e-1"], verification: {
      issues: [{ id: "conflict", severity: "urgent", title: "Verify deadline", question: "Which deadline applies now?", explanation: "Sources disagree", evidenceIds: ["e-1"] }, { id: "approval", severity: "attention", title: "Approval", question: "Who approved the change?", explanation: "Approval is missing", evidenceIds: ["e-1"] }],
      passages: [{ evidenceId: "e-1", source: "gmail", kind: "source", quote: "Delivery due on September 7", sender: "Client", sourceDate: snapshot.assessedAt, effectiveFrom: null }, { evidenceId: "e-2", source: "worker_update", kind: "worker", quote: "Delivery moved to September 9", sender: "Worker", sourceDate: snapshot.assessedAt, effectiveFrom: null }],
      comparisons: [{ subject: "card-1", topic: "deadline",
        left: { evidenceId: "e-1", value: "September 7", quote: "Delivery due on September 7", source: "gmail", kind: "source", sender: "Client", sourceDate: snapshot.assessedAt, url: "https://mail.google.com/mail/u/0/#all/example" },
        right: { evidenceId: "e-2", value: "September 9", quote: "Delivery moved to September 9", source: "worker_update", kind: "worker", sender: "Worker", sourceDate: snapshot.assessedAt, url: null } }],
    } });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();
    const comparison = manager.getByRole("region", { name: "Conflicting statements" });
    await expect(comparison.getByRole("heading", { name: "What differs" })).toBeVisible();
    await expect(comparison.getByText("Delivery due on September 7")).toBeVisible();
    await expect(comparison.getByText("Delivery moved to September 9")).toBeVisible();
    await expect(comparison.getByText("Worker report", { exact: true })).toBeVisible();
    await expect(comparison.getByRole("link", { name: "Open cited source" })).toBeVisible();
    await expect(manager.getByText("Original passages (2)")).toBeVisible();
    await expect(manager.getByText("Who approved the change?", { exact: true })).not.toBeVisible();
    await expect(manager.getByText("Other questions to resolve (1)", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`focused-questions-${width}.png`), fullPage: true });
  });

  test("an unspecified conflict gives a reading task instead of comparing message metadata", async ({ page }) => {
    const { snapshot, calls } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({ id: "unknown", cardId: "card-1", severity: "urgent", title: "Resolve conflict before continuing", explanation: "Conflicting evidence requires verification", question: "Which unknown applies now?", safeAction: "Verify", evidenceIds: ["e-1"], verification: { issues: [], passages: [
      { evidenceId: "e-1", source: "gmail", kind: "source", quote: "From: sender@example.com", sender: "sender@example.com", sourceDate: snapshot.assessedAt, effectiveFrom: null },
      { evidenceId: "e-1", source: "gmail", kind: "source", quote: "Status: pending", sender: "sender@example.com", sourceDate: snapshot.assessedAt, effectiveFrom: null },
      { evidenceId: "e-1", source: "gmail", kind: "source", quote: "A message is waiting in your portal.", sender: "sender@example.com", sourceDate: snapshot.assessedAt, effectiveFrom: null },
    ] } });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByRole("heading", { name: "Read the full correspondence" })).toBeVisible();
    await expect(manager.getByText("What does the message ask you to do, and does it include a deadline?", { exact: true })).toBeVisible();
    await expect(manager.getByText("Resolve conflict before continuing", { exact: true })).not.toBeVisible();
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();
    await expect(manager.getByText("A message is waiting in your portal.", { exact: true })).toBeVisible();
    await expect(manager.getByText("Status: pending", { exact: true })).not.toBeVisible();
    await expect(manager.getByText("Message metadata (2)", { exact: true })).toHaveCount(0);
    await expect(manager.getByLabel("Source preview", { exact: true })).toHaveCount(1);
    expect(calls.some(call => call.method === "operator.submitManagerUpdate")).toBe(false);
  });

  test("missing evidence is not described as a message preview or a confirmed conflict", async ({ page }) => {
    const { snapshot } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({
      id: "missing-source",
      cardId: "card-1",
      issueKind: "source_check",
      severity: "attention",
      title: "Check the original source",
      explanation: "The source is not attached.",
      question: "Where can the original source be found?",
      safeAction: "Ask the task owner where to find the source, or report that you cannot access it.",
      evidenceIds: [],
      verification: { issues: [], passages: [], comparisons: [] },
    });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();

    const evidence = manager.getByLabel("Verification evidence comparison");
    await expect(evidence).toContainText("No source is attached to this check.");
    await expect(evidence).toContainText("There are no source statements to compare, so this is not a confirmed conflict.");
    await expect(evidence).not.toContainText(/message preview/i);
    await expect(evidence.getByRole("region", { name: "Conflicting statements" })).toHaveCount(0);
  });

  test("worker does not see an empty original-passages disclosure when comparisons already contain quotes", async ({ page }) => {
    const { snapshot } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({
      id: "quoted-conflict",
      cardId: "card-1",
      issueKind: "conflicting_claims",
      severity: "attention",
      title: "Check the due date",
      explanation: "The retained records show different due dates.",
      question: "Which date is confirmed by the original source?",
      safeAction: "Open the cited message and confirm the current due date.",
      evidenceIds: ["email-1", "email-2"],
      verification: {
        issues: [],
        passages: [],
        comparisons: [{
          subject: "card-1",
          topic: "deadline",
          left: { evidenceId: "email-1", value: "September 7", quote: "Delivery is due September 7.", source: "gmail", kind: "source", sender: "Client", sourceDate: snapshot.assessedAt, url: "https://mail.google.com/mail/u/0/#all/first" },
          right: { evidenceId: "email-2", value: "September 9", quote: "The delivery date is now September 9.", source: "gmail", kind: "source", sender: "Client", sourceDate: snapshot.assessedAt, url: "https://mail.google.com/mail/u/0/#all/second" },
        }],
      },
    });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();

    const comparison = manager.getByRole("region", { name: "Conflicting statements" });
    await expect(comparison.getByText("Delivery is due September 7.")).toBeVisible();
    await expect(comparison.getByText("The delivery date is now September 9.")).toBeVisible();
    await expect(manager.getByText("Original passages (0)", { exact: true })).toHaveCount(0);
  });

  test("the manager's urgent task is not repeated as another primary task", async ({ page }) => {
    const queueCard = (cardId: string, cardName: string, listName: string) => ({
      cardId, cardName, cardUrl: `https://trello.com/c/${cardId}`, boardName: "Work", listName,
      nextBestAction: "Review the source", planSummary: null, primaryState: listName,
      stateReason: null, actionability: "actionable", priorityScore: 50,
      priorityTier: "HIGH", confidenceScore: null, confidenceReason: null,
      recommendations: [], uncertainties: [], steps: [], waitingReason: null,
      evidenceSummary: { sources: [], issues: [], forecast: null, confidenceProfile: null },
    });
    const { snapshot } = await managerFixture(page, "worker", { queueCards: [queueCard("card-1", "Verify delivery", "DOING"), queueCard("card-2", "Prepare report", "DOING")] });
    (snapshot.interventions as unknown[]).push({ id: "check-source", cardId: "card-1", issueKind: "source_check", severity: "attention", title: "Check the original source before continuing", explanation: "Source is incomplete", question: "What does the source request?", safeAction: "Read the full source", evidenceIds: ["e-1"] });
    await page.goto("/worker");
    await expect(page.getByRole("heading", { name: "Check the original source" })).toBeVisible();
    await expect(page.getByText("Other work you can continue", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Prepare report" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Verify delivery" })).toHaveCount(0);
    await page.getByRole("button", { name: /Doing second/ }).click();
    await page.getByRole("button", { name: /Verify delivery/ }).click();
    await expect(page.getByRole("button", { name: "Start timer", exact: true })).toBeDisabled();
  });

  test("task details use the manager's executable action instead of the first unfinished checklist step", async ({ page }) => {
    const queueCard = (cardId: string, cardName: string) => ({
      cardId, cardName, cardUrl: `https://trello.com/c/${cardId}`, boardName: "Work", listName: "DOING",
      nextBestAction: "Execute the highest-priority open step", planSummary: null, primaryState: "DOING",
      stateReason: null, actionability: "actionable", priorityScore: 50, priorityTier: "HIGH",
      confidenceScore: null, confidenceReason: null, recommendations: [], uncertainties: [], waitingReason: null,
      steps: [
        { id: 1, stepNumber: 1, title: "Wait for the permit", status: "pending", category: "review", requiresRobert: false, completionCriteria: "Permit is recorded", riskIfSkipped: null },
        { id: 2, stepNumber: 2, title: "Review independent records", status: "pending", category: "review", requiresRobert: false, completionCriteria: "Records are matched", riskIfSkipped: null },
      ],
      evidenceSummary: { sources: [], issues: [], forecast: null, confidenceProfile: null },
    });
    const { snapshot } = await managerFixture(page, "worker", {
      queueCards: [queueCard("case-1", "Case one"), queueCard("case-2", "Case two")],
    });
    (snapshot.actions as unknown[]).push(
      { id: "blocked-step", cardId: "case-1", title: "Wait for the permit", stepIds: [1], blocked: true, reason: "The permit is not recorded.", completionCriteria: "Permit is recorded" },
      { id: "ready-step", cardId: "case-1", title: "Review independent records", stepIds: [2], blocked: false, reason: "This independent step is ready.", completionCriteria: "Records are matched", minutes: { low: 5, likely: 10, high: 15, samples: 2, basis: "Observed work" }, where: "Work board", kind: "work", dependsOn: [], evidenceIds: [], notBefore: null, priority: 40, draft: null },
    );

    const managerResponsePromise = page.waitForResponse(response => response.url().includes("operator.getManagerStatus"));
    await page.goto("/worker");
    const managerResponse = await managerResponsePromise;
    const managerPayload = await managerResponse.text();
    expect(managerPayload).toContain("Review independent records");
    await page.getByRole("button", { name: /Doing second/ }).click();
    await page.getByRole("button", { name: "Case one", exact: true }).click();
    const inspector = page.getByRole("dialog");
    const nextSection = inspector.getByText("Exactly next", { exact: true }).locator("..");
    await expect(nextSection).toContainText("Review independent records");
    await expect(nextSection).not.toContainText("Wait for the permit");
    const taskSteps = inspector.getByText("Task steps", { exact: true }).locator("..");
    await expect(taskSteps).toContainText("Waiting");
    await expect(taskSteps).toContainText("Ready");
    await expect(taskSteps).toContainText("The permit is not recorded.");
  });

  test("the next task shows a source, completion condition and evidence-based time range", async ({ page }) => {
    await managerFixture(page, "worker", { queueCards: [{
      cardId: "card-1", cardName: "Verify delivery", cardUrl: "https://trello.com/c/example",
      boardName: "Work", listName: "DOING", nextBestAction: "Check the receipt",
      planSummary: null, primaryState: "DOING", stateReason: null, actionability: "actionable",
      priorityScore: 50, priorityTier: "HIGH", confidenceScore: null, confidenceReason: null,
      recommendations: [], uncertainties: [], waitingReason: null,
      steps: [{ id: 1, stepNumber: 1, title: "Check receipt", status: "pending", category: "review", requiresRobert: false, completionCriteria: "Receipt linked to the card", riskIfSkipped: null }],
      evidenceSummary: { sources: [], issues: [], forecast: { p50Minutes: 20, p90Minutes: 35, sampleSize: 4, uncertainty: null }, confidenceProfile: null },
    }] });
    await page.goto("/worker");
    await expect(page.getByText(/Done when: Receipt linked to the card/)).toBeVisible();
    await expect(page.getByText(/Working estimate:.*20 min to 35 min/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open source card" })).toHaveAttribute("href", "https://trello.com/c/example");
  });

  test("Evidence shows current Google sync health instead of treating an old sync as connected", async ({ page }) => {
    const recentSuccess = new Date(Date.now() - 5 * 60_000).toISOString();
    const staleSuccess = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await managerFixture(page, "worker", {
      googleStatus: {
        credentialsReady: true,
        gmail: { enabled: true, intervalMinutes: 30, lastSyncedAt: recentSuccess, lastError: "Google access was rejected." },
        drive: { enabled: true, intervalMinutes: 30, lastSyncedAt: staleSuccess, lastError: null },
      },
    });
    await page.goto("/worker/evidence");

    await expect(page.getByText("Gmail sync", { exact: true })).toBeVisible();
    await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
    await expect(page.getByText("Google Drive metadata", { exact: true })).toBeVisible();
    await expect(page.getByText("Check due", { exact: true })).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Google access needs to be reconnected\. Open Google settings, reconnect Google, then sync again\./)).toBeVisible();
  });

  test("selected context card and pending processing remain explicit", async ({ page }) => {
    const { snapshot, calls } = await managerFixture(page, "worker", { queued: true });
    snapshot.cards.push({ id: "card-2", name: "Second task", url: "https://trello.com/c/second", board: "Work", list: "Doing" });
    (snapshot.interventions as unknown[]).push({ id: "urgent-first", cardId: "card-1", issueKind: "reported_difference", severity: "urgent", title: "First task conflict", explanation: "First issue", question: "Which date applies to first task?", safeAction: "Verify", evidenceIds: [] }, { id: "second-question", cardId: "card-2", issueKind: "conflicting_claims", severity: "attention", title: "Second task context", explanation: "Second issue", question: "Who approved second task?", safeAction: "Verify", evidenceIds: [] });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByText("System status", { exact: true })).toHaveCount(0);
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();
    await manager.getByLabel("Related task").selectOption("card-2");
    await expect(manager.getByText("Which source is authoritative, and from what date does that information apply?", { exact: true })).toBeVisible();
    await expect(manager.getByText("Which date applies to first task?", { exact: true })).not.toBeVisible();
    await manager.getByLabel("What did you confirm?").fill("The second task needs source verification.");
    await manager.getByRole("button", { name: "Send answer to APTLSS" }).click();
    await expect.poll(() => calls.some(c => c.method === "operator.submitManagerUpdate" && c.input.cardId === "card-2" && c.input.interventionId === "second-question")).toBe(true);
  });

  test("worker answer triggers reassessment without treating a report as proof", async ({ page }) => {
    const { snapshot, calls } = await managerFixture(page, "worker", { reassessWorkerUpdate: true });
    (snapshot.interventions as unknown[]).push({
      id: "initial-receipt-check",
      cardId: "card-1",
      issueKind: "reported_difference",
      severity: "attention",
      title: "The delivery date needs checking",
      explanation: "The task reports delivery, but the receipt has not been verified.",
      question: "Can you open the receipt and confirm its date?",
      safeAction: "Open the original receipt before confirming delivery.",
      evidenceIds: ["e-1"],
    });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByText("What changed, and which cited source confirms the current information?", { exact: true })).toBeVisible();
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();
    await manager.getByLabel("Result", { exact: true }).selectOption("Cannot access source");
    await manager.getByLabel("Document or location checked (optional)").fill("Vendor portal receipt");
    await manager.getByLabel("What did you confirm?").fill("Cannot access the original receipt; it is in the vendor portal.");
    await manager.getByRole("button", { name: "Send answer to APTLSS" }).click();

    await expect.poll(() => calls.find(call => call.method === "operator.submitManagerUpdate")?.input.interventionId).toBe("initial-receipt-check");
    expect(calls.find(call => call.method === "operator.submitManagerUpdate")?.input.requestKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await expect(manager.getByText("Your update was saved for review.", { exact: false })).toBeVisible();
    await expect(manager.getByText("What changed, and which cited source confirms the current information?", { exact: true })).toBeVisible();
    await expect(manager.getByText("Can Robert provide an accessible copy of the receipt?", { exact: true })).toHaveCount(0);
    await expect(manager.getByText("Can you open the receipt and confirm its date?", { exact: true })).toHaveCount(0);
    await expect(manager.getByText("Full technical assessment", { exact: true })).toHaveCount(0);
  });

  test("worker can inspect linked source excerpts and submit context without an intervention", async ({
    page,
  }, testInfo) => {
    const { calls, snapshot } = await managerFixture(page, "worker");
    snapshot.evidence.push(
      {
        id: "email-preview-1",
        cardId: "card-1",
        source: "gmail",
        text: "The message points to a delivery receipt.",
        observedAt: new Date().toISOString(),
        url: "https://mail.google.com/mail/u/0/#all/example",
        kind: "source",
        metadata: { sourceRecordId: "thread-7", contentScope: "message_preview" },
      },
      {
        id: "email-preview-2",
        cardId: "card-1",
        source: "gmail",
        text: "Open the linked portal correspondence for the full request.",
        observedAt: new Date().toISOString(),
        url: "javascript:alert(1)",
        kind: "source",
        metadata: { sourceRecordId: "thread-7", contentScope: "message_preview" },
      },
    );
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByRole("heading", { name: "Work guidance" })).toBeVisible();
    await expect(manager.getByText(/Fallback polling/)).not.toBeVisible();
    await expect(manager.getByText("System status", { exact: true })).toHaveCount(0);
    await manager.getByRole("button", { name: "Show task details" }).click();
    const evidence = manager.getByRole("region", { name: "Evidence for this task" });
    await expect(evidence.getByText("Gmail", { exact: true })).toBeVisible();
    await expect(evidence.getByText("Preview only", { exact: true })).toBeVisible();
    await expect(evidence.locator("a[href='https://mail.google.com/mail/u/0/#all/example']")).toHaveCount(1);
    await expect(evidence.getByText("Other excerpts (1)", { exact: true })).toBeVisible();
    await evidence.getByText("Other excerpts (1)", { exact: true }).click();
    await expect(evidence.getByText("Open the linked portal correspondence for the full request.", { exact: true })).toBeVisible();
    await expect(evidence.locator("a[href^='javascript:']")).toHaveCount(0);
    await expect(manager.getByText("Full technical assessment", { exact: true })).toHaveCount(0);
    await manager
      .getByLabel("What changed in reality?")
      .fill("Receipt confirmed in the linked card today.");
    await manager.getByRole("button", { name: "Send answer to APTLSS" }).click();
    await expect(
      page.getByText("Proposal assessed; active plan unchanged")
    ).toBeVisible();
    expect(
      calls.some(
        call =>
          call.method === "operator.submitManagerUpdate" &&
          call.input.cardId === "card-1"
      )
    ).toBeTruthy();
    await expect(manager.getByText("Proposed plan", { exact: true })).toHaveCount(0);
    await expect(manager.getByText(/\d+%/)).toHaveCount(0);
    const bounds = await manager.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("worker-context.png"),
      fullPage: true,
    });
  });

  for (const width of [1440, 390]) test(`worker guidance uses a readable ${width}px layout`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { snapshot } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({
      id: "guidance-layout",
      cardId: "card-1",
      severity: "urgent",
      title: "The deadline needs verification",
      explanation: "The source record and the reported update contain different dates.",
      question: "Which date is confirmed by the current source?",
      safeAction: "Open the cited record and check the date before continuing.",
      evidenceIds: [],
    });

    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    const fields = manager.getByTestId("manager-guidance-fields");
    const problem = await fields.getByTestId("manager-guidance-problem").boundingBox();
    const question = await fields.getByTestId("manager-guidance-question").boundingBox();
    const action = await fields.getByTestId("manager-guidance-action").boundingBox();
    expect(problem).not.toBeNull();
    expect(question).not.toBeNull();
    expect(action).not.toBeNull();

    if (width >= 1280) {
      expect(Math.abs(problem!.y - question!.y)).toBeLessThan(2);
      expect(Math.abs(question!.y - action!.y)).toBeLessThan(2);
      expect(problem!.x).toBeLessThan(question!.x);
      expect(question!.x).toBeLessThan(action!.x);
    } else {
      expect(problem!.y).toBeLessThan(question!.y);
      expect(question!.y).toBeLessThan(action!.y);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });

  test("worker task checks do not expose forecast calibration", async ({ page }) => {
    await managerFixture(page, "worker", { proof: true, calibration: true });
    await page.goto("/worker");
    await page.getByRole("button", { name: "Open details", exact: true }).click();
    await expect(page.getByText("The remaining-time forecast needs calibration", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/No material uncertainty remains/)).toHaveCount(0);
    for (const internalDetail of [
      "PRIVATE_PLAN_SUMMARY_SENTINEL",
      "PRIVATE_STATE_REASON_SENTINEL",
      "PRIVATE_CONFIDENCE_REASON_SENTINEL",
      "PRIVATE_RECOMMENDATION_SENTINEL",
      "PRIVATE_UNCERTAINTY_SENTINEL",
      "PRIVATE_ISSUE_TITLE_SENTINEL",
      "PRIVATE_ISSUE_DETAIL_SENTINEL",
      "PRIVATE_ISSUE_RESOLUTION_SENTINEL",
      "PRIVATE_CONFIDENCE_BLOCKER_SENTINEL",
    ]) await expect(page.getByText(internalDetail, { exact: true })).toHaveCount(0);
  });

  test("worker completion reports retain evidence and leave the step open", async ({ page }) => {
    const { snapshot, calls } = await managerFixture(page, "worker");
    snapshot.actions.push({
      id: "action-card-1-1",
      cardId: "card-1",
      title: "Verify delivery",
      where: "https://trello.com/c/example",
      kind: "work",
      stepIds: [1],
      dependsOn: [],
      minutes: { low: 5, likely: 10, high: 20 },
      reason: "This is the next open step.",
      completionCriteria: "The receipt is recorded on the card.",
      evidenceIds: ["e-1"],
      notBefore: null,
      blocked: false,
      priority: 1,
      draft: null,
    });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Report step done" }).click();
    await manager.getByLabel("Source for verification").selectOption("e-1");
    await manager.getByLabel("What did you complete?").fill("I recorded the receipt reference on the Trello card.");
    await manager.getByRole("button", { name: "Submit completion report" }).click();

    await expect(page.getByText("Completion report saved. The step remains open until its source confirms the result.", { exact: true })).toBeVisible();
    await expect(manager.getByRole("heading", { name: "Continue the recorded work step", exact: true })).toBeVisible();
    await expect(manager.getByLabel("Current manager instruction").getByText("Verify delivery", { exact: true })).toBeVisible();
    await expect(manager.getByRole("button", { name: "Report step done" })).toBeVisible();
    const call = calls.find(item => item.method === "operator.reportManagerActionCompletion");
    expect(call?.input).toMatchObject({
      cardId: "card-1",
      actionId: "action-card-1-1",
      detail: "I recorded the receipt reference on the Trello card.",
      sourceEvidenceId: "e-1",
    });
    expect(call?.input.requestKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(calls.some(item => item.method === "operator.syncCheckItem")).toBe(false);
  });

  for (const width of [1280, 390]) test(`worker case file stays clear and readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await managerFixture(page, "worker", { proof: true, calibration: true });
    await page.goto("/worker");
    await page.getByRole("button", { name: "Open details", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Case file" })).toBeVisible();
    await expect(dialog.getByText("Original source", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Email preview", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Your update", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Retained payment confirmation", { exact: true })).toBeVisible();
    await expect(dialog.getByText("A portal message is ready", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Pending review", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Portal notice only; open the email to read the underlying correspondence.", { exact: true })).toBeVisible();
    const decisionRecord = dialog.locator("article").filter({ hasText: "Decision outcome" });
    await decisionRecord.getByText("Read saved text", { exact: true }).click();
    await expect(decisionRecord.getByText("Robert approved the documented next step.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Open original" }).first()).toHaveAttribute("href", "https://drive.google.com/file/d/example");
    await dialog.getByText("Read saved text", { exact: true }).first().click();
    await expect(dialog.getByText("Invoice alpha is paid.", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/PRIVATE_AI_THOUGHT_SENTINEL|PRIVATE_AI_ACTION_SENTINEL|PRIVATE_AI_SUMMARY_SENTINEL|PRIVATE_DECISION_PROMPT_SENTINEL|PRIVATE_AI_RECOMMENDATION_SENTINEL|PRIVATE_CONTENT_HASH_SENTINEL|PRIVATE_ISSUE_DETAIL_SENTINEL/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((dialogBox?.x ?? width) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: testInfo.outputPath(`worker-case-file-${width}.png`) });
  });

  for (const width of [1280, 390]) test(`worker sees source-check times and safe next actions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await managerFixture(page, "worker", { proof: true, sourceCheck: true });
    await page.goto("/worker");
    await page.getByRole("button", { name: "Open details", exact: true }).click();
    await expect(page.getByText("Source checks", { exact: true })).toBeVisible();
    await expect(page.getByText("Check overdue", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Cached copy saved:", { exact: false })).toBeVisible();
    await expect(page.getByText("Worker account last synced:", { exact: false })).toBeVisible();
    await expect(page.getByText("Next: Open the original email and verify it before replying or filing.")).toBeVisible();
    await expect(page.getByText("No additional checks are listed.", { exact: false })).toHaveCount(0);
    await expect.poll(async () => (await page.getByRole("dialog").boundingBox())?.x ?? width).toBeLessThan(width === 390 ? 10 : 800);
    await page.screenshot({ path: testInfo.outputPath(`source-check-${width}.png`) });
  });

  test("typing retains the urgent question for the selected task", async ({ page }) => {
    const { snapshot, calls } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push(
      { id: "ordinary", cardId: "card-1", issueKind: "reported_difference", severity: "attention", title: "Check address", explanation: "Address unclear", question: "Which address?", safeAction: "Check source", evidenceIds: [] },
      { id: "urgent", cardId: "card-1", issueKind: "conflicting_claims", severity: "urgent", title: "Check deadline", explanation: "Dates disagree", question: "Which deadline?", safeAction: "Check source", evidenceIds: [] }
    );
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();
    await expect(manager.getByText("Which source is authoritative, and from what date does that information apply?", { exact: true })).toBeVisible();
    await manager.getByLabel("What did you confirm?").fill("The source confirms Friday.");
    await expect(manager.getByText("Which source is authoritative, and from what date does that information apply?", { exact: true })).toBeVisible();
    await expect(manager.getByText("Which deadline?", { exact: true })).toHaveCount(0);
    await manager.getByRole("button", { name: "Send answer to APTLSS" }).click();
    await expect.poll(() => calls.find(call => call.method === "operator.submitManagerUpdate")?.input.interventionId).toBe("urgent");
  });

  test("source loading failure stays distinct from absent evidence and can be retried", async ({ page }) => {
    const options = { proof: true, evidenceUnavailable: true };
    await managerFixture(page, "worker", options);
    await page.goto("/worker");
    await page.getByRole("button", { name: "Open details", exact: true }).click();
    const inspector = page.getByRole("dialog");
    await inspector.getByRole("button", { name: /Raw linked evidence/ }).click();
    await expect(inspector.getByRole("alert").filter({ hasText: "Source details could not be loaded" })).toBeVisible();
    await expect(inspector.getByText("No graph-linked evidence has been retained for this card yet.")).toHaveCount(0);
    options.evidenceUnavailable = false;
    await inspector.getByRole("button", { name: "Retry loading sources" }).click();
    await expect(inspector.getByText("Retained payment confirmation", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Source details could not be loaded.", { exact: false })).toHaveCount(0);
    const errors = browserErrors.get(page) ?? [];
    expect(errors.some(error => error.includes("Synthetic retained source unavailable"))).toBe(true);
    browserErrors.set(page, errors.filter(error => !error.includes("Synthetic retained source unavailable")));
  });

  test("waiting task cannot start a timer through task details", async ({ page }) => {
    const { calls } = await managerFixture(page, "worker", { proof: true, waiting: true });
    await page.goto("/worker");
    await expect(page.getByRole("button", { name: "Waiting - review first", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Open details", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start timer", exact: true })).toBeDisabled();
    expect(calls.some(call => call.method === "timer.start")).toBe(false);
  });

  test("incomplete work coverage pauses task execution with a clear instruction", async ({ page }) => {
    const { snapshot, calls } = await managerFixture(page, "worker", { proof: true });
    snapshot.executionReady = false;
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByText("Wait before starting a task", { exact: true })).toBeVisible();
    await expect(manager.getByText(/The full work list has not been checked\. Do not start a task yet\./)).toBeVisible();
    await expect(manager.getByText("Ready for next step", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No task is recommended yet" })).toBeVisible();
    await expect(page.getByText("These tasks are not ranked until the full work list is checked.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Doing second/ }).click();
    await page.getByRole("button", { name: "Verify delivery", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start timer", exact: true })).toBeDisabled();
    expect(calls.some(call => call.method === "timer.start")).toBe(false);
    await expect(page.getByText(/technical assessment|semantic review|AI review/i)).toHaveCount(0);
  });

  test("switching tasks clears the entire result draft", async ({ page }) => {
    const { snapshot } = await managerFixture(page, "worker");
    snapshot.cards.push({ id: "card-2", name: "Second task", url: "https://trello.com/c/second", board: "Work", list: "Doing" });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Show task details" }).click();
    await manager.getByLabel("Result", { exact: true }).selectOption("No action needed");
    await manager.getByLabel("Deadline stated in the source (optional)").fill("2026-09-25");
    await manager.getByLabel("Document or location checked (optional)").fill("Portal correspondence");
    await manager.getByLabel("Related task").selectOption("card-2");
    await expect(manager.getByLabel("Result", { exact: true })).toHaveValue("Update");
    await expect(manager.getByLabel("Deadline stated in the source (optional)")).toHaveValue("");
    await expect(manager.getByLabel("Document or location checked (optional)")).toHaveValue("");
  });

  test("successful submission resets result type for the next update", async ({ page }) => {
    await managerFixture(page, "worker");
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Show task details" }).click();
    await manager.getByLabel("Result", { exact: true }).selectOption("No action needed");
    await manager.getByLabel("What changed in reality?").fill("Source confirms no response is needed.");
    await manager.getByRole("button", { name: "Send answer to APTLSS" }).click();
    await expect(manager.getByText(/Your update was saved for review/)).toBeVisible();
    await expect(manager.getByLabel("Result", { exact: true })).toHaveValue("Update");
  });

  test("structured worker result preserves deadline and requires review", async ({ page }) => {
    const { calls } = await managerFixture(page, "worker");
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Show task details" }).click();
    await manager.getByLabel("Result", { exact: true }).selectOption("Action needed");
    await manager.getByLabel("Deadline stated in the source (optional)").fill("2026-09-25");
    await manager.getByLabel("Source you checked (optional)").selectOption("e-1");
    await manager.getByLabel("Document or location checked (optional)").fill("Client correspondence");
    await manager.getByLabel("What changed in reality?").fill("The client's email requests the revised document.");
    await manager.getByRole("button", { name: "Send answer to APTLSS" }).click();
    await expect(manager.getByText(/Your update was saved for review/)).toBeVisible();
    expect(calls.find(call => call.method === "operator.submitManagerUpdate")?.input).toMatchObject({
      detail: "The client's email requests the revised document.", outcome: "Action needed",
      deadlineDate: "2026-09-25", sourceEvidenceId: "e-1", sourceDescription: "Client correspondence",
    });
  });

  test("retains last successful assessment and context when the latest check fails", async ({
    page,
  }) => {
    await managerFixture(page, "worker", { unavailable: true });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByText("Work guidance could not be refreshed")).toBeVisible();
    await expect(manager.getByText(/Try again shortly\. You can continue with unrelated work\./)).toBeVisible();
    await expect(manager.getByText("Source refresh failed", { exact: true })).toHaveCount(0);
    await expect(manager.getByText("No action is waiting for you", { exact: true })).toBeVisible();
    await manager.getByRole("button", { name: "Show task details" }).click();
    await expect(manager.getByText("Full technical assessment", { exact: true })).toHaveCount(0);
    await expect(manager.getByText("Delivery reported in card comment", { exact: true })).toBeVisible();
    await expect(manager.getByLabel("What changed in reality?")).toBeVisible();
    await expect(manager.getByLabel("Related task")).toHaveValue("card-1");
  });

  test("admin selects a worker, reviews a run and has no active controls", async ({
    page,
  }, testInfo) => {
    const { calls } = await managerFixture(page, "admin");
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("2");
    await expect(
      page.getByText("More reviewed working days required")
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Enable active mode" })
    ).toHaveCount(0);
    await page.getByText("Review run 101", { exact: true }).click();
    await page.getByLabel("Verdict").selectOption("insufficient");
    await page
      .getByLabel("Correction or review notes")
      .fill("Verify receipt before acting.");
    await page
      .getByLabel("Review source")
      .fill("Linked card comment, reviewed today");
    const bounds = await page
      .getByRole("region", { name: "APTLSS manager review" })
      .boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("founder-review.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.getByRole("button", { name: "Save review" }).click();
    await expect(page.getByText("Manager review saved")).toBeVisible();
    expect(
      calls.some(
        call =>
          call.method === "operator.recordManagerReview" &&
          call.input.vaId === 2 &&
          call.input.runId === 101 &&
          call.input.verdict === "insufficient"
      )
    ).toBeTruthy();
    await page.getByRole("button", { name: "Run shadow assessment" }).click();
    await expect(page.getByText("Shadow proposal assessed")).toBeVisible();
    await page.getByLabel("Review worker").selectOption("3");
    await expect
      .poll(
        () =>
          calls
            .filter(call => call.method === "operator.getManagerReviewInbox")
            .at(-1)?.input.vaId
      )
      .toBe(3);
  });

  test("scoped review guidance form stays within a narrow mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await managerFixture(page, "admin");
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("2");
    await page.getByText("Review run 101", { exact: true }).click();
    await page.getByLabel("Verdict").selectOption("incorrect");
    await page.getByLabel("Correction or review notes").fill("Check the source before choosing the follow-up.");
    await page.getByLabel("Review source").fill("Reviewed retained source record");
    await page.getByRole("switch", { name: "Use as scoped reviewed guidance" }).click();
    const topic = page.getByLabel("Guidance topic");
    await topic.fill("source-review_1");
    expect(
      await topic.evaluate(element => (element as HTMLInputElement).validity.valid)
    ).toBe(true);
    await page.getByLabel("Guidance expiry (local time)").fill(
      new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16)
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`manager result notification meets WCAG contrast in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(value => localStorage.setItem("theme", value), theme);
      await managerFixture(page, "admin");
      await page.goto("/founder");
      await page.getByRole("tab", { name: "Manager review" }).click();
      await page.getByLabel("Review worker").selectOption("2");
      await page.getByRole("button", { name: "Run shadow assessment" }).click();
      await expect(page.getByText("Shadow proposal assessed")).toBeVisible();
      await expectAccessible(
        page,
        `manager-result-notification-${theme}`,
        "[data-sonner-toaster]"
      );
    });
  }

  for (const width of [1280, 390]) test(`confirmed review stays read-only while inbox refresh is delayed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await managerFixture(page, "admin");
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("2");
    await page.getByText("Review run 101", { exact: true }).click();
    await page.getByLabel("Verdict").selectOption("insufficient");
    await page.getByLabel("Correction or review notes").fill("Verify receipt before acting.");
    await page.getByLabel("Review source").fill("Linked card comment, reviewed today");
    let blockedRefreshes = 0;
    let release!: () => void;
    const heldRefresh = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/api\/trpc\/[^?]*operator\.getManagerReviewInbox/, async route => {
      blockedRefreshes++;
      await heldRefresh;
      await route.fallback();
    });
    try {
      await page.getByRole("button", { name: "Save review" }).click();
      await expect(page.getByText("Manager review saved")).toBeVisible();
      await expect.poll(() => blockedRefreshes).toBeGreaterThan(0);
      await expect(page.getByText("Recorded review (read-only)")).toBeVisible();
      await expect(page.getByText("Reviewed: insufficient", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Verdict")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Save review" })).toHaveCount(0);
      expect(calls.filter(call => call.method === "operator.recordManagerReview")).toHaveLength(1);
    } finally {
      release();
    }
  });

  test("an unconfirmed review remains editable and preserves the entered notes", async ({ page }) => {
    await managerFixture(page, "admin");
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("2");
    await page.getByText("Review run 101", { exact: true }).click();
    await page.getByLabel("Correction or review notes").fill("Verify receipt before acting.");
    await page.getByLabel("Review source").fill("Linked card comment, reviewed today");
    await page.route(/\/api\/trpc\/[^?]*operator\.recordManagerReview/, route => route.fulfill({
      json: { result: { data: superjson.serialize({ recorded: false, revertedToShadow: false, correctionId: null }) } },
    }));
    await page.getByRole("button", { name: "Save review" }).click();
    await expect(page.getByText("Review could not be confirmed.")).toBeVisible();
    await expect(page.getByText("Manager review saved")).toHaveCount(0);
    await expect(page.getByText("Recorded review (read-only)")).toHaveCount(0);
    await expect(page.getByLabel("Verdict")).toBeEnabled();
    await expect(page.getByLabel("Correction or review notes")).toHaveValue("Verify receipt before acting.");
    await expect(page.getByLabel("Review source")).toHaveValue("Linked card comment, reviewed today");
    await expect(page.getByRole("button", { name: "Save review" })).toBeEnabled();
  });

  for (const width of [1280, 390]) test(`founder sees a compact plan change comparison at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const impact: ManagerPlanImpact = {
      version: 1, assessedAt: "2026-09-04T08:00:00Z", dateKey: "2026-09-04", timezone: "Europe/Amsterdam",
      baseline: "same_day_plan", scheduleChanged: true, requiresReview: false,
      planChanges: [
        { kind: "moved", blockId: "block-1", cardName: "Verify delivery", before: { startTime: "09:00", endTime: "09:20" }, after: { startTime: "10:00", endTime: "10:20" }, reason: "Source verification takes priority.", assumptionIds: [] },
        { kind: "removed", blockId: "old-block", cardName: "Prepare reply", before: { startTime: "11:00", endTime: "11:30" }, after: null, reason: "The source has not been checked.", assumptionIds: [] },
      ],
      availabilityChanged: false, assumptions: [], deadlines: [], dependencies: [], risks: [], limitations: [],
      buffer: { before: null, after: { unallocatedMinutes: 30, largestWindowMinutes: 30, additionalHighEstimateMinutes: null, afterHighEstimatesMinutes: null, minimumKnownDeficitMinutes: 0, unknownEstimateBlockIds: [] }, unallocatedDeltaMinutes: null, reservations: [], assumptionIds: [] },
      protectedBlocks: [{ blockId: "active-block", reasons: ["active_timer"], preservedExactly: true, assumptionIds: [] }],
      alternative: { kind: "keep_current_plan", available: true, blockIds: ["old-block"], deadlineRiskCardIds: [], dependencyRiskActionIds: [], buffer: null, limitation: "Retained plan has not been revalidated." },
    };
    const { snapshot } = await managerFixture(page, "admin", { planningImpact: impact });
    snapshot.proposal!.unscheduledCards = Array.from({ length: 12 }, (_, index) => ({
      cardId: `protected-task-${index + 1}`,
      cardName: `Protected open task ${index + 1}`,
      reason: "This is a protected non-working day.",
    }));
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("2");
    await page.getByText("Review run 101", { exact: true }).click();
    await page.getByText("Proposed plan", { exact: true }).click();
    await expect(page.getByText(/Today is a protected non-working day\. 12 tasks remain open/)).toBeVisible();
    await page.getByText("Show affected tasks (12)", { exact: true }).click();
    await expect(page.getByText("Protected open task 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Protected open task 5", { exact: true })).toBeVisible();
    await expect(page.getByText("Protected open task 6", { exact: true })).not.toBeVisible();
    await page.getByText("Show 7 more tasks", { exact: true }).click();
    await expect(page.getByText("Protected open task 12", { exact: true })).toBeVisible();
    await expect(page.getByText("This is a protected non-working day.", { exact: true })).toHaveCount(0);
    const plan = page.getByLabel("Planning impact");
    await expect(plan.locator("summary").first()).toContainText("2 block changes proposed");
    await plan.locator("summary").first().click();
    await expect(plan.getByText("Moved: Verify delivery")).toBeVisible();
    await expect(plan.getByText("Not scheduled: Prepare reply")).toBeVisible();
    await expect(plan.getByText("The active day plan has not changed.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await plan.screenshot({ path: testInfo.outputPath(`plan-diff-${width}.png`) });
  });

  for (const width of [1280, 390]) test(`worker sees suggested changes without replacing the saved agenda at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const dateKey = new Date().toISOString().slice(0, 10);
    const impact: ManagerPlanImpact = {
      version: 1, assessedAt: new Date().toISOString(), dateKey, timezone: "UTC",
      baseline: "same_day_plan", scheduleChanged: true, requiresReview: true,
      planChanges: [
        { kind: "moved", blockId: "block-1", cardName: "Verify delivery", before: { startTime: "09:00", endTime: "09:20" }, after: { startTime: "10:00", endTime: "10:20" }, reason: "Source verification takes priority.", assumptionIds: [] },
        { kind: "removed", blockId: "old-block", cardName: "Prepare reply", before: { startTime: "11:00", endTime: "11:30" }, after: null, reason: "The source has not been checked.", assumptionIds: [] },
      ],
      availabilityChanged: false, assumptions: [], deadlines: [], dependencies: [], risks: [], limitations: [],
      buffer: { before: null, after: { unallocatedMinutes: 30, largestWindowMinutes: 30, additionalHighEstimateMinutes: null, afterHighEstimatesMinutes: null, minimumKnownDeficitMinutes: 0, unknownEstimateBlockIds: [] }, unallocatedDeltaMinutes: null, reservations: [], assumptionIds: [] },
      protectedBlocks: [{ blockId: "active-block", reasons: ["active_timer"], preservedExactly: true, assumptionIds: [] }],
      alternative: { kind: "keep_current_plan", available: true, blockIds: ["old-block"], deadlineRiskCardIds: [], dependencyRiskActionIds: [], buffer: null, limitation: "Retained plan has not been revalidated." },
    };
    await managerFixture(page, "worker", { planningImpact: impact, savedPlan: {
      version: 2, dateKey, generatedAt: new Date().toISOString(),
      blocks: [{ id: "old-block", startTime: "11:00", endTime: "11:30", cardId: "saved-card", cardName: "Existing agenda task", action: "Continue recorded work", status: "planned", priority: "HIGH" }],
      constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
      planHealth: { confidence: 0, scheduledMinutes: 30, availableMinutes: 480, overlaps: 0, gaps: 450 },
      robertItems: [], unscheduledCards: [], auditTrail: [],
    } });
    await page.goto("/worker");
    await expect(page.getByText("2 suggested changes to review")).toBeVisible();
    await page.goto("/worker/plan");
    const suggestion = page.getByRole("region", { name: "Suggested changes to your day" });
    await expect(suggestion.getByText("Your agenda below is still the plan to follow.", { exact: false })).toBeVisible();
    await expect(suggestion.getByText("Verify delivery")).toBeVisible();
    await expect(suggestion.getByText("Prepare reply")).toBeVisible();
    await expect(suggestion.getByText("Not applied")).toBeVisible();
    await expect(page.getByText("Existing agenda task")).toBeVisible();
    await expect(page.getByText("Full technical assessment")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`worker-plan-suggestion-${width}.png`), fullPage: true });
  });

  for (const width of [1280, 390]) for (const theme of ["dark", "light"] as const) test(`pilot worker understands why the agenda is read-only at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("theme", value), theme);
    await managerFixture(page, "worker", { dailyPlanEditable: false, savedPlan: null });
    await page.goto("/worker/plan");

    await expect(page.getByRole("heading", { name: "Plan My Day", exact: true })).toBeVisible();
    await expect(page.getByText("Agenda changes are paused", { exact: true })).toBeVisible();
    await expect(page.getByText("No agenda is saved yet. Contact Robert to set today's schedule.", { exact: true })).toBeVisible();
    await expect(page.getByText("No saved plan", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /generate plan|regenerate plan/i })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expectAccessible(page, `pilot-plan-${width}-${theme}`);
    await page.screenshot({ path: testInfo.outputPath(`pilot-read-only-agenda-${width}-${theme}.png`), fullPage: true });
  });

  test("worker does not act on a suggestion for an older plan version", async ({ page }) => {
    const dateKey = new Date().toISOString().slice(0, 10);
    const impact: ManagerPlanImpact = {
      version: 1, assessedAt: new Date().toISOString(), dateKey, timezone: "UTC",
      baseline: "same_day_plan", scheduleChanged: true, requiresReview: false,
      planChanges: [{ kind: "moved", blockId: "old-block", cardName: "Outdated proposal task", before: { startTime: "09:00", endTime: "09:30" }, after: { startTime: "10:00", endTime: "10:30" }, reason: "Earlier reason.", assumptionIds: [] }],
      assumptions: [], deadlines: [], dependencies: [], risks: [], limitations: [],
      buffer: { before: null, after: { unallocatedMinutes: null, largestWindowMinutes: null, additionalHighEstimateMinutes: null, afterHighEstimatesMinutes: null, minimumKnownDeficitMinutes: 0, unknownEstimateBlockIds: [] }, unallocatedDeltaMinutes: null, reservations: [], assumptionIds: [] },
      protectedBlocks: [], alternative: { kind: "keep_current_plan", available: true, blockIds: [], deadlineRiskCardIds: [], dependencyRiskActionIds: [], buffer: null, limitation: "" },
    };
    await managerFixture(page, "worker", { planningImpact: impact, savedPlanVersion: "newer-plan-version" });
    await page.goto("/worker/plan");
    const suggestion = page.getByRole("region", { name: "Suggested changes to your day" });
    await expect(suggestion.getByText("no longer matches", { exact: false })).toBeVisible();
    await expect(suggestion.getByText("Outdated proposal task")).toHaveCount(0);
  });

  test("worker cannot enter admin manager review", async ({ page }) => {
    const { calls } = await managerFixture(page, "worker");
    await page.goto("/founder");
    await expect(page).toHaveURL(/\/worker$/);
    await expect(page.getByRole("tab", { name: "Manager review" })).toHaveCount(
      0
    );
    expect(
      calls.some(call => call.method === "operator.getManagerReviewInbox")
    ).toBeFalsy();
  });

  test("worker can view manager schedule but cannot change it", async ({
    page,
  }) => {
    const { calls } = await managerFixture(page, "worker");
    await page.goto("/worker/settings");
    const managerSchedule = page.getByRole("region", {
      name: "Manager schedule",
    });
    await expect(managerSchedule).toBeVisible();
    await expect(
      managerSchedule.getByText("Suggestions only", { exact: true })
    ).toBeVisible();
    await expect(
      managerSchedule.getByRole("status").filter({ hasText: "Automatic-check status is unavailable." })
    ).toBeVisible();
    await expect(
      managerSchedule.getByText("Check interval: every 5 minutes.", { exact: true })
    ).toBeVisible();
    await expect(
      managerSchedule.getByText(
        "Schedule changes are managed by your founder or admin.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(managerSchedule.getByLabel("Assessment interval")).toHaveCount(0);
    await expect(managerSchedule.getByLabel("Continuous guidance")).toHaveCount(0);
    await expect(
      managerSchedule.getByRole("button", { name: "Save manager schedule" })
    ).toHaveCount(0);
    expect(
      calls.some(call => call.method === "operator.updateManagerPolicy")
    ).toBeFalsy();
    expect(calls.some(call => call.method === "operator.setManagerMode")).toBeFalsy();
  });

  test("worker connection health identifies a failed provider separately from a healthy one", async ({ page }) => {
    const recentSync = new Date(Date.now() - 5 * 60_000).toISOString();
    await managerFixture(page, "worker", {
      googleStatus: {
        credentialsReady: true,
        clientConfigured: true,
        connectionMode: "worker",
        setupMessage: null,
        settings: {
          gmail: { enabled: true, intervalMinutes: 60, lookbackDays: 30 },
          drive: { enabled: true, intervalMinutes: 180, lookbackDays: 30, folderId: null },
          lastGmailSyncAt: recentSync,
          lastDriveSyncAt: recentSync,
          lastGmailError: "Google access was rejected. Reconnect the Google credentials.",
          lastDriveError: null,
          lastError: "Google access was rejected. Reconnect the Google credentials.",
        },
        gmail: {
          enabled: true,
          lastSyncedAt: recentSync,
          lastError: "Google access was rejected. Reconnect the Google credentials.",
          intervalMinutes: 60,
          hasRetainedEvidence: true,
        },
        drive: {
          enabled: true,
          lastSyncedAt: recentSync,
          lastError: null,
          intervalMinutes: 180,
          folderScoped: false,
          hasRetainedEvidence: true,
        },
        lastError: "Google access was rejected. Reconnect the Google credentials.",
      },
    });
    await page.goto("/worker/settings");
    await expect(page.getByText("Connection health", { exact: true })).toBeVisible();
    await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
    await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
    await expect(page.getByText("Google Drive", { exact: true })).toBeVisible();
    await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
    await expect(page.getByText("Google access needs to be reconnected.", { exact: false })).toBeVisible();
    await expectAccessible(page, "worker-connection-health");
  });

  test("eligible admin still cannot activate the shadow pilot", async ({
    page,
  }) => {
    const { calls } = await managerFixture(page, "admin", { eligible: true });
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("3");
    await expect(page.getByRole("button", { name: "Enable active mode" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Set shadow mode" })).toHaveCount(0);
    await page.getByRole("button", { name: "Run shadow assessment" }).click();
    await expect(page.getByText("Shadow proposal assessed")).toBeVisible();
    expect(
      calls.some(call => call.method === "operator.setManagerMode")
    ).toBe(false);
  });

  test("an unexpected active policy pauses assessment instead of executing it", async ({
    page,
  }) => {
    const { calls, snapshot } = await managerFixture(page, "admin", {
      eligible: true,
      mode: "active",
    });
    snapshot.policy.mode = "active";
    snapshot.applied = true;
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("2");
    await expect(
      page.getByText("Current mode: Active", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Run shadow assessment" })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Enable active mode" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Set shadow mode" })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run active assessment" })).toHaveCount(0);
    expect(
      calls.some(call => call.method === "operator.runManagerForReview")
    ).toBe(false);
  });

  test("saved reviews are immutable and show their source", async ({
    page,
  }) => {
    await managerFixture(page, "admin", { reviewed: true });
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("2");
    await page.getByText("Review run 101", { exact: true }).click();
    await expect(page.getByLabel("Verdict")).toBeDisabled();
    await expect(page.getByLabel("Review source")).toHaveValue(
      "Verified source record"
    );
    await expect(page.getByRole("button", { name: "Save review" })).toHaveCount(
      0
    );
  });

  test("manager socket event refreshes status and disconnection exposes polling fallback", async ({
    page,
  }) => {
    const fixture = await managerFixture(page, "worker", { realtime: true });
    await page.goto("/worker");
    await expect(page.getByText("System status", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Realtime connected", { exact: true })
    ).toHaveCount(0);
    const count = fixture.calls.filter(
      call => call.method === "operator.getManagerStatus"
    ).length;
    fixture.emitManagerUpdate();
    await expect
      .poll(
        () =>
          fixture.calls.filter(
            call => call.method === "operator.getManagerStatus"
          ).length
      )
      .toBeGreaterThan(count);
    fixture.disconnect();
    await expect(
      page.getByText(/Fallback polling every 60 seconds/)
    ).toHaveCount(0);
  });

  test("a delayed Trello read does not hold the manager status hostage", async ({ page }) => {
    await managerFixture(page, "worker");
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/trpc/**", async route => {
      if (new URL(route.request().url()).pathname.includes("trello.actionAlerts")) await delayed;
      await route.fallback();
    });
    try {
      await page.goto("/worker");
      await expect(page.getByRole("heading", { name: "Work guidance" })).toBeVisible({ timeout: 5000 });
    } finally {
      release();
    }
  });

  test("worker plan shows the saved agenda without uncalibrated confidence percentages", async ({
    page,
  }) => {
    await managerFixture(page, "worker");
    await page.goto("/worker/plan");
    await expect(page.getByText("Today’s agenda", { exact: true })).toBeVisible();
    await expect(page.getByText("Uncalibrated", { exact: true })).toHaveCount(0);
    await expect(page.getByText("0%", { exact: true })).toHaveCount(0);
  });

  test("worker guidance gives the operational issue, question, and next step without AI internals", async ({ page }) => {
    const { snapshot } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({
      id: "private-ai-guidance",
      cardId: "card-1",
      issueKind: "conflicting_claims",
      severity: "attention",
      title: "PRIVATE_AI_TITLE_SENTINEL",
      explanation: "PRIVATE_AI_REASONING_SENTINEL",
      question: "PRIVATE_AI_QUESTION_SENTINEL",
      safeAction: "PRIVATE_AI_ACTION_SENTINEL",
      evidenceIds: [],
      aiReasoning: "PRIVATE_INTERNAL_REASONING_SENTINEL",
      model: "PRIVATE_INTERVENTION_MODEL_SENTINEL",
      tokenUsage: { promptTokens: 987654, completionTokens: 123456, totalTokens: 1111110 },
      rawDiagnostic: "PRIVATE_INTERVENTION_DIAGNOSTIC_SENTINEL",
    });
    Object.assign(snapshot, {
      semanticReview: {
        success: false,
        failureKind: "quota",
        attemptedAt: new Date().toISOString(),
        retryAfter: new Date().toISOString(),
        failures: 1,
        sourceHash: "test",
        provider: "PRIVATE_AI_PROVIDER_SENTINEL",
        model: "PRIVATE_MODEL_NAME_SENTINEL",
        tokens: { prompt: 987654, completion: 123456, total: 1111110 },
        reasoning: "PRIVATE_SEMANTIC_REASONING_SENTINEL",
        rawDiagnostic: "PRIVATE_RAW_TECHNICAL_DIAGNOSTIC_SENTINEL: ECONNRESET",
        attempts: [{ effort: "high", outcome: "rejected", reason: "PRIVATE_ATTEMPT_REASONING_SENTINEL", durationMs: 10 }],
      },
    });
    await page.goto("/worker");
    const instruction = page.getByRole("status", { name: "Current manager instruction" });
    await expect(instruction).toBeVisible();
    const fields = instruction.getByTestId("manager-guidance-fields");
    await expect(fields.getByTestId("manager-guidance-problem")).toContainText("Compare the cited sources");
    await expect(fields.getByTestId("manager-guidance-problem")).toContainText("The cited sources disagree about information needed for this task.");
    await expect(fields.getByTestId("manager-guidance-question")).toContainText("Which source is authoritative, and from what date does that information apply?");
    await expect(fields.getByTestId("manager-guidance-action")).toContainText("Compare the cited sources and record which information applies and from when.");
    await expect(page.getByText("This advice has not been fully checked. Verify the source before acting.", { exact: true })).not.toBeVisible();
    await expect(page.getByText("AI API credit exhausted", { exact: true })).not.toBeVisible();
    await expect(page.getByText(/Automatic retry:/)).not.toBeVisible();
    await expect(page.getByText("System status", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Full technical assessment", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/technical assessment|semantic review|AI review/i)).toHaveCount(0);
    const renderedText = await page.locator("body").innerText();
    for (const internalDetail of [
      "PRIVATE_AI_TITLE_SENTINEL",
      "PRIVATE_AI_REASONING_SENTINEL",
      "PRIVATE_INTERNAL_REASONING_SENTINEL",
      "PRIVATE_AI_QUESTION_SENTINEL",
      "PRIVATE_AI_ACTION_SENTINEL",
      "PRIVATE_INTERVENTION_MODEL_SENTINEL",
      "PRIVATE_AI_PROVIDER_SENTINEL",
      "PRIVATE_MODEL_NAME_SENTINEL",
      "987654",
      "123456",
      "1111110",
      "PRIVATE_SEMANTIC_REASONING_SENTINEL",
      "PRIVATE_ATTEMPT_REASONING_SENTINEL",
      "PRIVATE_INTERVENTION_DIAGNOSTIC_SENTINEL",
      "PRIVATE_RAW_TECHNICAL_DIAGNOSTIC_SENTINEL",
      "ECONNRESET",
    ]) expect(renderedText).not.toContain(internalDetail);
  });

  test("subscription connection identifies adaptive Luna and the actual used levels", async ({ page }) => {
    const { snapshot } = await managerFixture(page, "worker");
    Object.assign(snapshot, { semanticReview: { provider: "codex-subscription", success: false, attemptedAt: new Date().toISOString(), retryAfter: new Date().toISOString(), failures: 1, sourceHash: "test", attempts: [{effort:"low",outcome:"context_review",reason:"chronology",durationMs:10},{effort:"medium",outcome:"rejected",durationMs:10}] } });
    await page.goto("/worker");
    await expect(page.getByText("System status", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/AI: Codex subscription|Last review:|No paid API fallback/)).toHaveCount(0);
    await expect(page.getByText(/OpenAI API credit is exhausted/)).toHaveCount(0);
  });

  for (const role of ["worker", "admin"] as const) {
    for (const width of [1280, 390]) {
      for (const theme of ["dark", "light"] as const) {
        test(`${role} primary screen has no axe WCAG 2.2 AA violations at ${width}px ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await page.addInitScript(value => localStorage.setItem("theme", value), theme);
          await managerFixture(page, role, { founderDecisions: role === "admin" });
          await page.goto(role === "worker" ? "/worker" : "/founder");
          if (role === "admin") {
            await page.getByRole("tab", { name: "Decisions" }).click();
            await expect(page.getByRole("region", { name: "Founder decision inbox" })).toBeVisible();
          } else {
            await expect(page.getByRole("region", { name: "APTLSS work manager" })).toBeVisible();
          }
          await expectAccessible(page, `${role}-${width}-${theme}`);
        });
      }
    }
  }

  for (const width of [1440, 390]) for (const theme of ["dark", "light"]) test(`compact coach separates attention from diagnostics at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("theme", value), theme);
    const { snapshot, calls } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({ id: "missing", cardId: "card-1", issueKind: "missing_dependency", severity: "urgent", title: "Missing dependency", explanation: "Dependency missing:2 is not available.", question: "What evidence or prior step satisfies this dependency?", safeAction: "Provide the missing dependency before execution.", evidenceIds: [] });
    Object.assign(snapshot, { semanticReview: { provider: "codex-subscription", success: true, attempts: [{ effort: "low", outcome: "accepted", durationMs: 10 }] } });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByRole("heading", { name: "Confirm the required earlier step" })).toBeVisible();
    await expect(manager.getByText("Verify delivery", { exact: true })).toBeVisible();
    await expect(manager.getByText("Which completed step or source record confirms this requirement?", { exact: true })).toBeVisible();
    await expect(manager.getByText(/Dependency missing:2/)).toHaveCount(0);
    await expect(manager.getByText(/AI: Codex subscription/)).not.toBeVisible();
    await expect(manager.getByText(/Last check:/)).not.toBeVisible();
    const bounds = await manager.boundingBox();
    expect(bounds!.height).toBeLessThan(width > 600 ? 560 : 680);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`compact-coach-${width}-${theme}.png`), fullPage: true });
    await expect(manager.getByText("System status", { exact: true })).toHaveCount(0);
    await expect(manager.getByText(/AI: Codex subscription/)).not.toBeVisible();
    await manager.getByRole("button", { name: "Show evidence and answer" }).click();
    await expect(manager.getByText(/Dependency missing:2/)).toHaveCount(0);
    await expect(manager.getByLabel("What did you confirm?")).toBeVisible();
    await manager.getByRole("button", { name: "Hide answer and evidence" }).click();
    await expect(manager.getByLabel("What did you confirm?")).not.toBeVisible();
    expect(calls.filter(call => call.method === "operator.submitManagerUpdate" || call.method === "operator.runManager")).toHaveLength(0);
  });

  test("a manager assessment can finish after the ordinary 30-second API deadline", async ({ page }) => {
    test.setTimeout(50_000);
    await managerFixture(page, "worker", { assessmentDelayMs: 31_000 });
    await page.goto("/worker");
    const run = page.getByRole("button", { name: "Reassess now" });
    await run.click();
    await expect(run).toBeDisabled();
    await expect(page.getByText("Proposal assessed; active plan unchanged", { exact: true })).toBeVisible({ timeout: 40_000 });
    await expect(run).toBeEnabled();
  });

  test("changed question preserves draft and requires review before sending", async ({ page }) => {
    const { snapshot, calls, emitManagerUpdate } = await managerFixture(page, "worker", { realtime: true });
    const question = { id: "original", cardId: "card-1", issueKind: "conflicting_claims", severity: "urgent", title: "Check deadline", explanation: "Dates disagree", question: "Which deadline applies?", safeAction: "Check source", evidenceIds: [] };
    (snapshot.interventions as unknown[]).push(question);
    await page.goto("/worker");
    await page.getByRole("button", { name: "Show evidence and answer" }).click();
    await page.getByLabel("What did you confirm?").fill("The deadline is Friday.");
    await expect(page.getByRole("button", { name: "Send answer to APTLSS" })).toBeEnabled();
    const reads = calls.filter(call => call.method === "operator.getManagerStatus").length;
    emitManagerUpdate();
    await expect.poll(() => calls.filter(call => call.method === "operator.getManagerStatus").length).toBeGreaterThan(reads);
    await expect(page.getByRole("button", { name: "Send answer to APTLSS" })).toBeEnabled();
    question.question = "Who approved this deadline?";
    emitManagerUpdate();
    await expect(page.getByText("The instruction changed while you were writing.", { exact: false })).toBeVisible();
    await expect(page.getByText("Which source is authoritative, and from what date does that information apply?", { exact: true })).toBeVisible();
    await expect(page.getByText("Who approved this deadline?", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send answer to APTLSS" })).toBeDisabled();
    await expect(page.getByLabel("What did you confirm?")).toHaveValue("The deadline is Friday.");
    await page.getByLabel("What did you confirm?").fill("Friday, according to the source.");
    await expect(page.getByRole("button", { name: "Send answer to APTLSS" })).toBeDisabled();
    expect(calls.filter(call => call.method === "operator.submitManagerUpdate")).toHaveLength(0);
    await page.getByRole("button", { name: "I have reviewed the updated instruction" }).click();
    await expect(page.getByRole("button", { name: "Send answer to APTLSS" })).toBeEnabled();
  });

  test("pending generation shows elapsed time without invented completion", async ({ page }) => {
    await page.clock.install();
    await managerFixture(page, "worker");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/trpc/**", async route => {
      if (route.request().url().includes("operator.generateDailyPlan")) await held;
      await route.fallback();
    });
    try {
      await page.goto("/worker/plan");
      await page.getByRole("button", { name: "Regenerate plan" }).click();
      await expect(page.getByText(/completion estimate unavailable/)).toBeVisible();
      await page.clock.fastForward(15_000);
      await expect(page.getByText(/15s elapsed/)).toBeVisible();
      await expect(page.getByText(/% complete|1s left/)).toHaveCount(0);
    } finally { release(); }
  });

  test("fallback polling refreshes manager status without a socket event", async ({
    page,
  }) => {
    await page.clock.install();
    const { calls } = await managerFixture(page, "worker");
    await page.goto("/worker");
    await expect(page.getByText("System status", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(/Fallback polling every 60 seconds/)
    ).toHaveCount(0);
    const count = calls.filter(
      call => call.method === "operator.getManagerStatus"
    ).length;
    await page.clock.fastForward(60_001);
    await expect
      .poll(
        () =>
          calls.filter(call => call.method === "operator.getManagerStatus")
            .length
      )
      .toBeGreaterThan(count);
  });

  test("conflict resolution requires a retained source quote and notes stay open", async ({
    page,
  }) => {
    const { calls } = await managerFixture(page, "worker", { proof: true });
    await page.goto("/worker");
    await page
      .getByRole("button", { name: "Open details", exact: true })
      .click();
    const followup = page.getByRole("form", {
      name: "Verify conflicting work evidence",
    });
    await followup
      .getByLabel("What did you find?")
      .fill("Payment verified against the retained record.");
    await expect(
      followup.getByRole("button", { name: "Save verification and close" })
    ).toBeDisabled();
    await followup
      .getByRole("button", { name: "Save note; keep open" })
      .click();
    await expect(
      page.getByText("Note saved; conflict remains open")
    ).toBeVisible();
    await expect(followup).toBeVisible();
    await followup
      .getByLabel("What did you find?")
      .fill("Payment verified against the retained record.");
    await expect(
      followup.getByLabel("Which original source confirms it?").locator('option[value="901"]')
    ).toHaveCount(0);
    await followup.getByLabel("Which original source confirms it?").selectOption("900");
    await followup.getByLabel("Exact sentence from the source").fill("An invented quote");
    await expect(
      followup.getByRole("button", { name: "Save verification and close" })
    ).toBeDisabled();
    await followup
      .getByLabel("Exact sentence from the source")
      .fill("Invoice alpha is paid.");
    await followup
      .getByRole("button", { name: "Save verification and close" })
      .click();
    await expect(
      page.getByText("Verification follow-up resolved")
    ).toBeVisible();
    expect(
      calls
        .filter(call => call.method === "operator.resolveVerificationFollowup")
        .at(-1)?.input
    ).toMatchObject({
      followupId: 700,
      sourceEvidenceId: 900,
      sourceQuote: "Invoice alpha is paid.",
    });
  });

  test("a running timer keeps another task's start action unavailable and points back to the timed task", async ({ page }) => {
    const { calls } = await managerFixture(page, "worker", {
      queueCards: [{
        cardId: "selected-card",
        cardName: "Selected work",
        cardUrl: "https://trello.com/c/selected-card",
        boardName: "Work",
        listName: "DOING",
        primaryState: "IN_PROGRESS",
        actionability: "actionable",
        priorityScore: 50,
        priorityTier: "HIGH",
        nextBestAction: "Review the next document",
        waitingReason: null,
        steps: [],
        evidenceSummary: { sources: [], forecast: null },
      }],
    });
    await page.route("**/api/trpc/timer.getActive*", route => route.fulfill({
      json: { result: { data: superjson.serialize({
        id: 77,
        taskId: "active-card",
        cardId: "active-card",
        cardName: "Existing timed task",
        cardUrl: "https://trello.com/c/active-card",
        startTime: new Date(Date.now() - 10 * 60_000),
        startedAt: new Date(Date.now() - 10 * 60_000),
      }) } },
    }));
    await page.goto("/worker");

    const timerNotice = page.getByRole("status").filter({ hasText: "Timer already running for Existing timed task" });
    await expect(timerNotice).toContainText("Continue on that task");
    await expect(timerNotice).toContainText("This selected task has not been started");
    await expect(timerNotice.getByRole("link", { name: "Open running task" })).toHaveAttribute("href", "https://trello.com/c/active-card");
    await expect(page.getByRole("button", { name: "Timer running on another task", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "Open details", exact: true }).click();
    const inspector = page.getByRole("dialog");
    await expect(
      inspector.getByRole("status").filter({ hasText: "Timer already running for Existing timed task" })
    ).toContainText("Existing timed task");
    await expect(inspector.getByRole("button", { name: "Timer running on another task", exact: true })).toBeDisabled();
    expect(calls.filter(call => call.method === "timer.start")).toHaveLength(0);
  });
});
