import { expect, test, type Page } from "@playwright/test";
import superjson from "superjson";

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
      mode?: "shadow" | "active";
      queued?: boolean;
    } = {}
  ) {
    const calls: Array<{ method: string; input: any }> = [];
    let proofResolved = false;
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
    };
    const snapshot = {
      version: 1,
      runId: 101,
      trigger: "manual",
      assessedAt: at,
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
      const results = methods.map((method, index) => {
        const input = inputs[index]
          ? superjson.deserialize(inputs[index])
          : undefined;
        calls.push({ method, input });
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
            cards: options.proof
              ? [
                  {
                    cardId: "card-1",
                    cardName: "Verify delivery",
                    cardUrl: "https://example.invalid/source",
                    boardName: "Work",
                    listName: "Doing",
                    nextBestAction: "Verify retained facts",
                    planSummary: "Check source",
                    primaryState: "DOING",
                    stateReason: "Check source",
                    actionability: "actionable",
                    priorityScore: 50,
                    priorityTier: "HIGH",
                    confidenceScore: null,
                    confidenceReason: null,
                    recommendations: [],
                    uncertainties: [],
                    steps: [],
                    waitingReason: null,
                    evidenceSummary: {
                      sources: [],
                      issues: [],
                      forecast: null,
                      confidenceProfile: null,
                    },
                  },
                ]
              : [],
          };
        if (method === "operator.getCardEvidence")
          value = options.proof
            ? [
                {
                  id: 900,
                  source: "google_drive",
                  kind: "record",
                  title: "Retained payment confirmation",
                  content: "Invoice alpha is paid.",
                  summary: null,
                  observedAt: at,
                  modifiedAt: at,
                },
                {
                  id: 901,
                  source: "communication",
                  kind: "worker_assertion",
                  title: "Unverified worker claim",
                  content: "Invoice alpha is paid.",
                  summary: null,
                  observedAt: at,
                  modifiedAt: at,
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
        if (method === "operator.getDailyPlan") value = { schedule: proposal };
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
            policy: snapshot.policy,
            checkedAt: at,
            lastSuccessfulAt: at,
            queue: options.queued ? { state: "pending", requestedAt: at, availableAt: at, attempts: 2, lastError: "Assessment retry scheduled", completedAt: null } : null,
            error: options.unavailable ? "Source refresh failed" : undefined,
            gate,
          };
        if (
          method === "operator.runManager" ||
          method === "operator.submitManagerUpdate" ||
          method === "operator.runManagerForReview"
        )
          value = snapshot;
        if (method === "operator.getManagerReviewInbox") {
          const vaId = (input as { vaId?: number } | undefined)?.vaId;
          value = {
            workers: [
              { id: 2, name: "Worker One" },
              { id: 3, name: "Worker Two" },
            ],
            workerId: vaId ?? null,
            mode: options.mode,
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
        if (
          method === "operator.recordManagerReview" ||
          method === "operator.setManagerMode"
        )
          value = { success: true };
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

  for (const width of [1280, 390]) test(`focused questions preserve source comparison at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { snapshot } = await managerFixture(page, "worker");
    (snapshot.interventions as unknown[]).push({ id: "conflict", cardId: "card-1", severity: "urgent", title: "Verify deadline", explanation: "Sources disagree", question: "Which deadline applies now?", safeAction: "Verify before continuing", evidenceIds: ["e-1"], verification: {
      issues: [{ id: "conflict", severity: "urgent", title: "Verify deadline", question: "Which deadline applies now?", explanation: "Sources disagree", evidenceIds: ["e-1"] }, { id: "approval", severity: "attention", title: "Approval", question: "Who approved the change?", explanation: "Approval is missing", evidenceIds: ["e-1"] }],
      passages: [{ evidenceId: "e-1", source: "gmail", kind: "source", quote: "Delivery due on September 7", sender: "Client", sourceDate: snapshot.assessedAt, effectiveFrom: null }, { evidenceId: "e-2", source: "worker_update", kind: "worker", quote: "Delivery moved to September 9", sender: "Worker", sourceDate: snapshot.assessedAt, effectiveFrom: null }],
    } });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await manager.getByRole("button", { name: "Review context" }).click();
    await expect(manager.getByText("Delivery due on September 7")).toBeVisible();
    await expect(manager.getByText("Delivery moved to September 9")).toBeVisible();
    await expect(manager.getByText("Worker statement", { exact: true })).toBeVisible();
    await expect(manager.getByText("Who approved the change?", { exact: true })).not.toBeVisible();
    await manager.getByText("Other open questions (1)", { exact: true }).click();
    await expect(manager.getByText("Who approved the change?", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`focused-questions-${width}.png`), fullPage: true });
  });

  test("selected context card and pending processing remain explicit", async ({ page }) => {
    const { snapshot, calls } = await managerFixture(page, "worker", { queued: true });
    snapshot.cards.push({ id: "card-2", name: "Second task", url: "https://trello.com/c/second", board: "Work", list: "Doing" });
    (snapshot.interventions as unknown[]).push({ id: "urgent-first", cardId: "card-1", severity: "urgent", title: "First task conflict", explanation: "First issue", question: "Which date applies to first task?", safeAction: "Verify", evidenceIds: [] }, { id: "second-question", cardId: "card-2", severity: "attention", title: "Second task context", explanation: "Second issue", question: "Who approved second task?", safeAction: "Verify", evidenceIds: [] });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByText("Assessment queued", { exact: true })).toBeVisible();
    await manager.getByRole("button", { name: "Review context" }).click();
    await manager.getByLabel("Context card").selectOption("card-2");
    await expect(manager.getByText("Who approved second task?", { exact: true })).toBeVisible();
    await expect(manager.getByText("Which date applies to first task?", { exact: true })).not.toBeVisible();
    await manager.getByLabel("What changed in reality?").fill("The second task needs source verification.");
    await manager.getByRole("button", { name: "Submit context" }).click();
    await expect.poll(() => calls.some(c => c.method === "operator.submitManagerUpdate" && c.input.cardId === "card-2" && c.input.interventionId === "second-question")).toBe(true);
  });

  test("worker can disclose evidence and submit context without an intervention", async ({
    page,
  }, testInfo) => {
    const { calls } = await managerFixture(page, "worker");
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByText("Shadow", { exact: true })).toBeVisible();
    await expect(manager.getByText(/Fallback polling/)).toBeVisible();
    await expect(manager.getByText(/Last successful data/)).toBeVisible();
    await manager.getByRole("button", { name: "Review context" }).click();
    await expect(
      manager.getByText("Delivery reported in card comment")
    ).toBeVisible();
    await expect(manager.locator("time").first()).toHaveAttribute("datetime");
    await expect(
      manager.getByText("Receipt not independently verified")
    ).toBeVisible();
    await manager
      .getByLabel("What changed in reality?")
      .fill("Receipt confirmed in the linked card today.");
    await manager.getByRole("button", { name: "Submit context" }).click();
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
    await manager.getByText("Proposed plan", { exact: true }).click();
    await expect(manager.getByText("Check the source record")).toBeVisible();
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

  test("retains last successful assessment and context when the latest check fails", async ({
    page,
  }) => {
    await managerFixture(page, "worker", { unavailable: true });
    await page.goto("/worker");
    const manager = page.getByRole("region", { name: "APTLSS work manager" });
    await expect(manager.getByText("Source refresh failed")).toBeVisible();
    await manager.getByRole("button", { name: "Review context" }).click();
    await expect(manager.getByLabel("What changed in reality?")).toBeVisible();
    await expect(
      manager.getByText("Delivery reported in card comment")
    ).toBeVisible();
  });

  test("admin selects a worker, reviews a run and cannot activate an ineligible gate", async ({
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
    ).toBeDisabled();
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

  test("worker schedule sends only own enabled and interval settings", async ({
    page,
  }) => {
    const { calls } = await managerFixture(page, "worker");
    await page.goto("/worker/settings");
    await expect(page.getByText("Shadow", { exact: true })).toBeVisible();
    await page.getByLabel("Assessment interval").fill("9");
    await page.getByLabel("Continuous guidance").click();
    await page.getByRole("button", { name: "Save manager schedule" }).click();
    await expect(page.getByText("APTLSS manager schedule saved")).toBeVisible();
    expect(
      calls.find(call => call.method === "operator.updateManagerPolicy")?.input
    ).toEqual({ enabled: false, intervalMinutes: 9 });
    expect(
      calls.some(call => call.method === "operator.setManagerMode")
    ).toBeFalsy();
  });

  test("eligible admin activation requires confirmation and targets selected worker", async ({
    page,
  }) => {
    const { calls } = await managerFixture(page, "admin", { eligible: true });
    await page.goto("/founder");
    await page.getByRole("tab", { name: "Manager review" }).click();
    await page.getByLabel("Review worker").selectOption("3");
    const active = page.getByRole("button", { name: "Enable active mode" });
    await expect(active).toBeEnabled();
    page.once("dialog", dialog => dialog.accept());
    await active.click();
    await expect(page.getByText("Manager mode saved")).toBeVisible();
    expect(
      calls.find(call => call.method === "operator.setManagerMode")?.input
    ).toEqual({ vaId: 3, mode: "active" });
  });

  test("active worker mode cannot be mislabeled as a shadow assessment", async ({
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
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Enable active mode" })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Set shadow mode" })
    ).toBeEnabled();
    await page.getByRole("button", { name: "Run active assessment" }).click();
    await expect(
      page.getByText("Assessment applied to active plan")
    ).toBeVisible();
    expect(
      calls.find(call => call.method === "operator.runManagerForReview")?.input
    ).toEqual({ vaId: 2 });
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
    await expect(
      page.getByText("Realtime connected", { exact: true })
    ).toBeVisible();
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
    ).toBeVisible();
  });

  test("manager generated daily plan does not show uncalibrated confidence as zero percent", async ({
    page,
  }) => {
    await managerFixture(page, "worker");
    await page.goto("/worker/plan");
    await expect(page.getByText("Uncalibrated", { exact: true })).toBeVisible();
    await expect(page.getByText("0%", { exact: true })).toHaveCount(0);
  });

  test("fallback polling refreshes manager status without a socket event", async ({
    page,
  }) => {
    await page.clock.install();
    const { calls } = await managerFixture(page, "worker");
    await page.goto("/worker");
    await expect(
      page.getByText(/Fallback polling every 60 seconds/)
    ).toBeVisible();
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
      .getByLabel("Verification explanation")
      .fill("Payment verified against the retained record.");
    await expect(
      followup.getByRole("button", { name: "Verify source and resolve" })
    ).toBeDisabled();
    await followup
      .getByRole("button", { name: "Save note (keep open)" })
      .click();
    await expect(
      page.getByText("Note saved; conflict remains open")
    ).toBeVisible();
    await expect(followup).toBeVisible();
    await followup
      .getByLabel("Verification explanation")
      .fill("Payment verified against the retained record.");
    await expect(
      followup.getByLabel("Proof source").locator('option[value="901"]')
    ).toHaveCount(0);
    await followup.getByLabel("Proof source").selectOption("900");
    await followup.getByLabel("Exact source quote").fill("An invented quote");
    await expect(
      followup.getByRole("button", { name: "Verify source and resolve" })
    ).toBeDisabled();
    await followup
      .getByLabel("Exact source quote")
      .fill("Invoice alpha is paid.");
    await followup
      .getByRole("button", { name: "Verify source and resolve" })
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
});
