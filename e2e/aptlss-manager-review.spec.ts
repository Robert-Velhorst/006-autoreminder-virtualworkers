import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  createConnection,
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import superjson from "superjson";
import type { ManagerSnapshot } from "../shared/aptlssManager";

const password = "Review-test-fixture-only-2026!";

async function openLogin(page: Page) {
  const startupErrors: string[] = [];
  const onPageError = (error: Error) => startupErrors.push(error.message);
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") startupErrors.push(message.text());
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  let documentStatus: number | undefined;
  let contentSecurityPolicy: string | null = null;
  try {
    const document = await page.goto("/");
    documentStatus = document?.status();
    contentSecurityPolicy = await document?.headerValue("content-security-policy") ?? null;
    expect(document?.ok(), "Login document must load successfully").toBe(true);
    await expect(page).toHaveTitle("VA Task Dashboard");
    await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(startupErrors, "Login must render without browser errors").toEqual([]);
  } catch (cause) {
    throw new Error(`Login startup failed: ${JSON.stringify({ url: page.url(), documentStatus, contentSecurityPolicy, startupErrors })}`, { cause });
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

function testDatabase() {
  const raw = process.env.APTLSS_TEST_DATABASE_URL;
  if (!raw)
    throw new Error(
      "APTLSS_TEST_DATABASE_URL is required; operational DATABASE_URL fallback is forbidden."
    );
  const url = new URL(raw);
  if (
    url.protocol !== "mysql:" || url.search || url.hash ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/(?:aptlss_test|recovery_test)$/.test(url.pathname)
  )
    throw new Error(
      "Only an explicit loopback MySQL URL naming aptlss_test or recovery_test is allowed."
    );
  return raw;
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`founder review lifecycle through real API and MySQL at ${viewport.width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const db: Connection = await createConnection({
      uri: testDatabase(),
      timezone: "Z",
    });
    const prefix = `review-${randomUUID().slice(0, 20)}`,
      cardId = `${prefix}-card`;
    let workerId = 0,
      adminId = 0,
      evidenceId = 0,
      uncertain = false;
    let uncertainMutation: string | undefined;
    let uncertainCause: unknown;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const rows = async (query: string, values: unknown[] = []) =>
      (await db.execute<RowDataPacket[]>(query, values))[0];
    const insert = async (query: string, values: unknown[]) =>
      (await db.execute<ResultSetHeader>(query, values))[0].insertId;
    const mutate = async <T>(
      method: string,
      action: () => Promise<unknown>
    ): Promise<T> => {
      let settled = false;
      const completion = page
        .waitForResponse(
          response =>
            response.request().method() === "POST" &&
            decodeURIComponent(new URL(response.url()).pathname)
              .split("/api/trpc/")[1]
              ?.split(",")
              .includes(method),
          { timeout: 45_000 }
        )
        .then(async response => {
          const failure = await response.finished();
          if (failure) throw failure;
          settled = true;
          const body = await response.json();
          const methods = decodeURIComponent(new URL(response.url()).pathname)
            .split("/api/trpc/")[1]
            .split(",");
          const envelope = Array.isArray(body)
            ? body[methods.indexOf(method)]
            : body;
          expect(envelope.error, `${method} business result`).toBeUndefined();
          expect(response.ok()).toBe(true);
          return superjson.deserialize<T>(envelope.result.data);
        });
      // Observe rejected transport promises even if the triggering UI action fails.
      void completion.catch(() => {});
      try {
        await action();
        return await completion;
      } catch (error) {
        if (!settled) {
          uncertain = true;
          uncertainMutation = method;
          uncertainCause = error;
        }
        throw error;
      }
    };
    const capture = async (name: string) => {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth)
      ).toBeLessThanOrEqual(viewport.width);
      const path = info.outputPath(`${name}.png`);
      // Capture from the document origin so the existing sticky page header is
      // not composited halfway through a full-page image after form scrolling.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path, fullPage: true });
      await info.attach(name, { path, contentType: "image/png" });
    };
    try {
      const now = new Date(),
        observed = new Date(now.getTime() - 60_000);
      const offset = 12 - now.getUTCHours();
      const timezone =
        offset === 0
          ? "Etc/GMT"
          : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
      const hash = await bcrypt.hash(password, 10);
      workerId = await insert(
        "INSERT INTO users (id,openId,name,role,loginMethod,passwordHash) VALUES (?,?,?,?,?,?)",
        [Number(process.env.APTLSS_TEST_PILOT_WORKER_IDS!.split(",")[viewport.width === 1440 ? 3 : 4]), `${prefix}-worker`, `${prefix} Worker`, "worker", "local", hash]
      );
      adminId = await insert(
        "INSERT INTO users (openId,name,role,loginMethod,passwordHash) VALUES (?,?,?,?,?)",
        [`${prefix}-admin`, `${prefix} Admin`, "admin", "local", hash]
      );
      await db.execute(
        "INSERT INTO user_working_hours (userId,userOpenId,timezone,workingDays,workStartHour,workEndHour,enableBreaks) VALUES (?,?,?,?,9,18,0)",
        [workerId, `${prefix}-worker`, timezone, "0,1,2,3,4,5,6"]
      );
      await db.execute(
        "INSERT INTO aptlss_manager_state (vaId,enabled,intervalMinutes,mode,shadowStartedAt) VALUES (?,1,5,'shadow',?)",
        [workerId, new Date(now.getTime() - 10 * 86400000)]
      );
      const sourceText =
        "The delivery report is ready for internal review. Check the retained delivery report before preparing a reply.";
      await db.execute(
        "INSERT INTO aptlss_plans (vaId,cardId,cardName,cardUrl,boardName,listName,planJson,contextSnapshot) VALUES (?,?,?,?,?,?,?,?)",
        [
          workerId,
          cardId,
          "Review delivery report",
          "https://example.invalid/retained-delivery-report",
          "Review fixtures",
          "Doing",
          JSON.stringify({
            nextBestAction: "Review delivery report",
            planSummary: "Check the retained report.",
          }),
          JSON.stringify({
            id: cardId,
            name: "Review delivery report",
            desc: sourceText,
            dateLastActivity: observed.toISOString(),
          }),
        ]
      );
      await db.execute(
        "INSERT INTO card_states (vaId,cardId,cardName,state,listName,stateReason) VALUES (?,?,?,'DOING','Doing',?)",
        [
          workerId,
          cardId,
          "Review delivery report",
          "Internal source review is ready.",
        ]
      );
      await db.execute(
        "INSERT INTO aptlss_steps (vaId,cardId,stepNumber,title,estimatedMinutes,category,completionCriteria) VALUES (?,?,1,?,15,'internal_work',?)",
        [workerId, cardId, "Review delivery report", "Record report findings."]
      );
      evidenceId = await insert(
        "INSERT INTO workspace_evidence_items (source,sourceId,title,content,observedAt,modifiedAt,contentHash,active) VALUES ('google_drive',?,?,?,?,?,?,1)",
        [
          `${prefix}-source`,
          "Delivery report",
          sourceText,
          observed,
          observed,
          createHash("sha256").update(sourceText).digest("hex"),
        ]
      );
      await db.execute(
        "INSERT INTO aptlss_evidence_subject_links (evidenceId,vaId,subjectType,subjectId,relevanceScore,linkMethod,matchReason) VALUES (?,?,'card',?,100,'confirmed','Explicit review fixture')",
        [evidenceId, workerId, cardId]
      );
      await db.execute(
        "INSERT INTO workspace_evidence_links (evidenceId,cardId,relevanceScore,linkMethod,matchReason) VALUES (?,?,100,'manual','Explicit review fixture')",
        [evidenceId, cardId]
      );

      await openLogin(page);
      await page
        .getByLabel("Username", { exact: true })
        .fill(`${prefix}-admin`);
      await page.getByLabel("Password", { exact: true }).fill(password);
      const loginResponse = page.waitForResponse(response =>
        response.url().endsWith("/api/auth/login") && response.request().method() === "POST"
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const response = await loginResponse;
      expect(response.ok()).toBe(true);
      expect(await response.json()).toMatchObject({ success: true });
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      if (page.viewportSize()!.width < 768) {
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
        await page.getByRole("link", { name: "VA Management", exact: true }).click();
      } else await page.getByTitle("VA Management", { exact: true }).click();
      await expect(page).toHaveURL(/\/founder$/);
      await page.getByRole("tab", { name: "Manager review", exact: true }).click();
      const review = page.getByRole("region", {
        name: "APTLSS manager review",
        exact: true,
      });
      await expect(review).toBeVisible();
      await review
        .getByLabel("Review worker", { exact: true })
        .selectOption(String(workerId));
      const initial = await mutate<ManagerSnapshot>(
        "operator.runManagerForReview",
        () =>
          review.getByRole("button", { name: "Run shadow assessment" }).click()
      );
      expect(initial.runId).toBeGreaterThan(0);
      expect(initial.applied).toBe(false);
      const action = initial.actions.find(a => a.cardId === cardId && ["work", "verify", "follow_up"].includes(a.kind))!;
      expect(action).toBeDefined();
      const correctedTitle = "Review the retained report and note its sections";
      const correctedCompletion = "Record each finding with its report section number.";

      // Exercise the actual grouped SQL query with more than the removed 5,000-row cap.
      const [originalRun] = await rows(
        "SELECT * FROM aptlss_manager_runs WHERE id = ? AND vaId = ?",
        [initial.runId, workerId]
      );
      for (let batch = 0; batch < 10; batch++) {
        const copies = Array.from({ length: 510 }, () => [
          workerId,
          originalRun.trigger,
          originalRun.mode,
          originalRun.inputHash,
          originalRun.proposalHash,
          originalRun.snapshotJson,
          originalRun.createdAt,
        ]);
        await db.query(
          "INSERT INTO aptlss_manager_runs (vaId,`trigger`,mode,inputHash,proposalHash,snapshotJson,createdAt) VALUES ?",
          [copies]
        );
      }
      await review.getByRole("button", { name: "Refresh reviews" }).click();
      await expect(review.getByText("5101 matching assessments")).toBeVisible({ timeout: 30_000 });
      expect(
        await review
          .locator("summary")
          .filter({ hasText: /^Review run / })
          .count()
      ).toBe(1);
      const details = review
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: /^Review run / }) })
        .first();
      await details.locator("summary").first().click();
      await details
        .getByLabel("Verdict", { exact: true })
        .selectOption("incorrect");
      const correctionText =
        "Include the report section number with each internal finding.";
      await details
        .getByLabel("Correction or review notes")
        .fill(correctionText);
      await details
        .getByLabel("Review source", { exact: true })
        .fill("Reviewed retained delivery report");
      await details
        .getByRole("switch", { name: "Use as scoped reviewed guidance" })
        .click();
      await details.getByLabel("Guidance topic").fill("report-review");
      await details.getByLabel("Action condition").selectOption(action.kind);
      await details.getByRole("switch", { name: "Correct a future proposed step" }).click();
      await details.getByLabel("Step to correct").selectOption(action.id);
      await details.getByLabel("Corrected next step").fill(correctedTitle);
      await details.getByLabel("Done when").fill(correctedCompletion);
      const expiry = new Date(Date.now() + 7 * 86400000)
        .toISOString()
        .slice(0, 16);
      await details.getByLabel("Guidance expiry (local time)").fill(expiry);
      await details.getByRole("checkbox").first().check();
      await capture("scoped-correction-form");
      const saved = await mutate<{ correctionId: number }>(
        "operator.recordManagerReview",
        () => details.getByRole("button", { name: "Save review" }).click()
      );
      expect(saved.correctionId).toBeGreaterThan(0);
      const [stored] = await rows(
        "SELECT * FROM aptlss_manager_corrections WHERE id=? AND vaId=?",
        [saved.correctionId, workerId]
      );
      expect(stored.correction).toBe(correctionText);
      expect(stored.cardId).toBe(cardId);
      expect(JSON.parse(stored.conditionsJson).nextStep).toEqual({
        actionId: action.id, title: correctedTitle, completionCriteria: correctedCompletion,
      });
      expect(JSON.parse(stored.evidenceJson)[0].fingerprint).toMatch(
        /^[a-f0-9]{64}$/
      );
      const learned = await mutate<ManagerSnapshot>(
        "operator.runManagerForReview",
        () =>
          review.getByRole("button", { name: "Run shadow assessment" }).click()
      );
      expect(
        learned.actions.some(a =>
          a.reviewedGuidance?.some(g => g.id === saved.correctionId)
        )
      ).toBe(true);
      expect(learned.actions.find(a => a.id === action.id)).toMatchObject({
        kind: action.kind, blocked: action.blocked, title: correctedTitle,
        completionCriteria: correctedCompletion,
      });
      expect(learned.actions.filter(a => a.kind === "verify").length).toBe(
        initial.actions.filter(a => a.kind === "verify").length
      );
      const [learningRun] = await rows(
        "SELECT inputHash FROM aptlss_manager_runs WHERE id=?",
        [learned.runId]
      );
      const learnedSummary = review.locator("summary").filter({
        hasText: new RegExp(`^Review run ${learned.runId}(?:\\s|$)`),
      });
      await expect(learnedSummary).toBeVisible({ timeout: 30_000 });
      await learnedSummary.click();
      await expect(
        review
          .getByRole("heading", { name: "Reviewed guidance", exact: true })
          .first()
      ).toBeVisible();
      await capture("applied-reviewed-guidance");

      const savedGuidance = review.getByRole("region", {
        name: "Saved reviewed guidance",
      });
      await savedGuidance.locator("summary").first().click();
      await savedGuidance
        .getByLabel("Withdrawal reason")
        .fill("Report format changed; withdraw this condition.");
      await mutate("operator.revokeManagerCorrection", () =>
        savedGuidance.getByRole("button", { name: "Withdraw guidance" }).click()
      );
      const without = await mutate<ManagerSnapshot>(
        "operator.runManagerForReview",
        () =>
          review.getByRole("button", { name: "Run shadow assessment" }).click()
      );
      expect(without.actions.flatMap(a => a.reviewedGuidance ?? [])).toEqual(
        []
      );
      const [afterRevoke] = await rows(
        "SELECT inputHash FROM aptlss_manager_runs WHERE id=?",
        [without.runId]
      );
      expect(afterRevoke.inputHash).not.toBe(learningRun.inputHash);

      const [history] = await rows(
        "SELECT COUNT(*) n FROM aptlss_manager_runs WHERE vaId=?",
        [workerId]
      );
      const [reviewHistory] = await rows(
        "SELECT * FROM aptlss_manager_reviews WHERE id=?",
        [stored.reviewId]
      );
      await review
        .getByLabel("Trial change reason")
        .fill("Close the reviewed trial before implementing a new procedure.");
      page.once("dialog", dialog => dialog.accept());
      await mutate("operator.closeManagerTrial", () =>
        review.getByRole("button", { name: "Close trial", exact: true }).click()
      );
      await expect(
        review.getByRole("button", { name: "Run shadow assessment" })
      ).toBeDisabled();
      const [closed] = await rows(
        "SELECT enabled,mode FROM aptlss_manager_state WHERE vaId=?",
        [workerId]
      );
      expect(closed).toMatchObject({ enabled: 0, mode: "shadow" });
      await review
        .getByLabel("Trial change reason")
        .fill("Begin the revised procedure in a fresh shadow trial.");
      page.once("dialog", dialog => dialog.accept());
      await mutate("operator.restartManagerTrial", () =>
        review.getByRole("button", { name: "Restart shadow trial" }).click()
      );
      await expect(
        review.getByText("No assessment runs for this worker.")
      ).toBeVisible();
      await expect(
        review.getByRole("button", { name: "Enable active mode" })
      ).toHaveCount(0);
      expect(
        (
          await rows(
            "SELECT COUNT(*) n FROM aptlss_manager_runs WHERE vaId=?",
            [workerId]
          )
        )[0].n
      ).toBe(history.n);
      expect(
        (
          await rows("SELECT * FROM aptlss_manager_reviews WHERE id=?", [
            stored.reviewId,
          ])
        )[0]
      ).toEqual(reviewHistory);
      const events = await rows(
        "SELECT event,afterRunId FROM aptlss_manager_trial_events WHERE vaId=? ORDER BY id",
        [workerId]
      );
      expect(events.map(e => e.event)).toEqual(["closed", "started"]);
      expect(events[1].afterRunId).toBe(without.runId);
      const next = await mutate<ManagerSnapshot>(
        "operator.runManagerForReview",
        () =>
          review.getByRole("button", { name: "Run shadow assessment" }).click()
      );
      expect(next.runId).toBeGreaterThan(events[1].afterRunId);
      expect(next.policy.mode).toBe("shadow");
      await capture("restarted-shadow-trial");
      expect(errors).toEqual([]);
    } finally {
      try {
        if (!uncertain) {
          await db.beginTransaction();
          try {
            await db.execute("UPDATE aptlss_manager_queue_slots SET vaId=NULL,token=NULL,leaseUntil=NULL WHERE vaId=?", [workerId]);
            for (const table of [
              "aptlss_manager_corrections",
              "aptlss_manager_trial_events",
              "aptlss_manager_reviews",
              "aptlss_manager_runs",
              "aptlss_manager_updates",
              "aptlss_manager_queue",
              "aptlss_manager_queue_events",
              "aptlss_manager_state",
              "aptlss_steps",
              "card_states",
              "priority_scores",
              "aptlss_plans",
              "daily_plans",
              "app_settings",
            ]) {
              await db.execute(`DELETE FROM ${table} WHERE vaId=?`, [workerId]);
            }
            if (evidenceId) {
              const foreign = await rows(
                "SELECT id FROM aptlss_evidence_subject_links WHERE evidenceId=? AND vaId<>?",
                [evidenceId, workerId]
              );
              if (foreign.length)
                throw new Error(
                  "Fixture evidence linked to a different worker; retaining evidence."
                );
              await db.execute("DELETE FROM aptlss_evidence_subject_links WHERE evidenceId=? AND vaId=?", [evidenceId, workerId]);
              await db.execute(
                "DELETE FROM workspace_evidence_links WHERE evidenceId=? AND cardId=?",
                [evidenceId, cardId]
              );
              await db.execute(
                "DELETE FROM workspace_evidence_items WHERE id=? AND sourceId=?",
                [evidenceId, `${prefix}-source`]
              );
            }
            await db.execute("DELETE FROM user_working_hours WHERE userId=?", [
              workerId,
            ]);
            await db.execute(
              "DELETE FROM users WHERE id IN (?,?) AND openId LIKE ?",
              [workerId, adminId, `${prefix}-%`]
            );
            await db.commit();
          } catch (error) {
            await db.rollback();
            throw error;
          }
        }
      } finally {
        await db.end();
      }
      if (uncertain)
        throw new Error(
          `Fixture ${prefix} retained because ${uncertainMutation} did not settle. Stop the dedicated test server before cleanup.`,
          { cause: uncertainCause }
        );
    }
  });
}
