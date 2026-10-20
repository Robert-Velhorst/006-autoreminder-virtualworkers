import { expect, test, type Page, type TestInfo } from "@playwright/test";
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
import { dateKeyInTimeZone } from "../shared/workerTime";

// LIVE acceptance: real login, persisted evidence and real business APIs.
// No routes are intercepted; providers must be disabled by the test server.
const PASSWORD = "Aptlss-browser-fixture-only-2026!";
type MutationState = { pending: Set<Promise<void>>; uncertain: boolean };
const mutationsByPage = new WeakMap<Page, MutationState>();

async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function mutateThroughUi<T>(
  page: Page,
  method: string,
  action: () => Promise<unknown>
): Promise<T> {
  const state = mutationsByPage.get(page)!;
  let transportSettled = false;
  const response = page.waitForResponse(
    response =>
      response.request().method() === "POST" &&
      decodeURIComponent(new URL(response.url()).pathname)
        .split("/api/trpc/")[1]
        ?.split(",")
        .includes(method),
    { timeout: 30_000 }
  );
  // Observe the complete body, not just response headers or an early database row.
  const completion = bounded(
    (async () => {
      const result = await response;
      const failure = await result.finished();
      if (failure) throw failure;
      transportSettled = true;
      const body = await result.json();
      await test.info().attach(`${method}-response`, {
        body: JSON.stringify({ status: result.status(), body }, null, 2),
        contentType: "application/json",
      });
      expect(result.ok(), `${method} HTTP response`).toBe(true);
      const methods = decodeURIComponent(new URL(result.url()).pathname)
        .split("/api/trpc/")[1]
        .split(",");
      const envelope = Array.isArray(body)
        ? body[methods.indexOf(method)]
        : body;
      expect(envelope.error, `${method} business error`).toBeUndefined();
      expect(envelope.result?.data, `${method} result`).toBeDefined();
      return superjson.deserialize<T>(envelope.result.data);
    })(),
    `${method} did not complete within 30 seconds`
  ).catch(error => {
    if (!transportSettled) state.uncertain = true;
    throw error;
  });
  const observed = completion
    .then(
      () => {},
      () => {}
    )
    .finally(() => state.pending.delete(observed));
  state.pending.add(observed);
  await action();
  return completion;
}

const disabledProviderPaths = new Set([
  "/api/va/assignments",
  "/api/trello/tasks",
  "/api/atis/timeline-tasks",
]);
const errorsByPage = new WeakMap<
  Page,
  {
    unexpected: string[];
    expected: string[];
    providerChecks: Promise<void>[];
    verifiedProviderUrls: Set<string>;
    resourceErrors: { text: string; url: string }[];
  }
>();

function isolatedDatabaseUrl() {
  const raw = process.env.APTLSS_TEST_DATABASE_URL;
  if (!raw)
    throw new Error(
      "Set APTLSS_TEST_DATABASE_URL; DATABASE_URL fallback is forbidden."
    );
  const url = new URL(raw);
  if (
    url.protocol !== "mysql:" || url.search || url.hash ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/(?:aptlss_test|recovery_test)$/.test(url.pathname)
  ) {
    throw new Error(
      "Live APTLSS fixtures require an explicit loopback MySQL URL naming aptlss_test or recovery_test."
    );
  }
  return raw;
}

async function login(page: Page, username: string, role: "worker" | "admin") {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  const response = page.waitForResponse(
    response =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST"
  );
  await page.locator('button[type="submit"]').click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  if (role === "worker") await expect(page).toHaveURL(/\/worker$/);
  else {
    if (page.viewportSize()!.width < 768) {
      await page.getByRole("button", { name: "Open menu", exact: true }).click();
      await page.getByRole("link", { name: "VA Management", exact: true }).click();
    } else await page.getByTitle("VA Management", { exact: true }).click();
    await expect(page).toHaveURL(/\/founder$/);
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(
    page.getByText("An unexpected error occurred.", { exact: true })
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeEach(async ({ page }) => {
  mutationsByPage.set(page, { pending: new Set(), uncertain: false });
  const errors = {
    unexpected: [] as string[],
    expected: [] as string[],
    providerChecks: [] as Promise<void>[],
    verifiedProviderUrls: new Set<string>(),
    resourceErrors: [] as { text: string; url: string }[],
  };
  errorsByPage.set(page, errors);
  page.on("pageerror", error => errors.unexpected.push(error.message));
  page.on("response", response => {
    if (
      !disabledProviderPaths.has(new URL(response.url()).pathname) ||
      response.status() !== 500
    )
      return;
    errors.providerChecks.push(
      (async () => {
        try {
          const body = await response.json();
          if (body.error === "Trello credentials not configured") {
            errors.verifiedProviderUrls.add(response.url());
            errors.expected.push(`${response.url()}: ${body.error}`);
          } else
            errors.unexpected.push(
              `${response.url()} failed: ${JSON.stringify(body)}`
            );
        } catch (error) {
          errors.unexpected.push(
            `Could not verify disabled-provider response: ${String(error)}`
          );
        }
      })()
    );
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (
      message
        .text()
        .includes(
          "Failed to load resource: the server responded with a status of 500"
        ) &&
      message.location().url &&
      disabledProviderPaths.has(new URL(message.location().url).pathname)
    ) {
      errors.resourceErrors.push({
        text: message.text(),
        url: message.location().url,
      });
      return;
    }
    // Keep explicitly expected disabled-provider errors in the report.
    const expected =
      /Trello (?:API )?credentials not configured|Failed to load resource: the server responded with a status of 412/.test(
        message.text()
      );
    (expected ? errors.expected : errors.unexpected).push(message.text());
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const mutations = mutationsByPage.get(page)!;
  await bounded(
    Promise.all(mutations.pending),
    "Mutations did not settle before page teardown"
  );
  expect(
    mutations.uncertain,
    "Server mutation completion is uncertain; fixture cleanup is blocked"
  ).toBe(false);
  const errors = errorsByPage.get(page)!;
  await page.waitForLoadState("networkidle");
  await Promise.all(errors.providerChecks);
  for (const error of errors.resourceErrors) {
    (errors.verifiedProviderUrls.has(error.url)
      ? errors.expected
      : errors.unexpected
    ).push(`${error.url}: ${error.text}`);
  }
  await testInfo.attach("browser-console", {
    body: JSON.stringify(
      { unexpected: errors.unexpected, expected: errors.expected },
      null,
      2
    ),
    contentType: "application/json",
  });
  expect(errors.unexpected).toEqual([]);
});

for (const scenario of [
  {
    name: "desktop-dark",
    theme: "dark",
    viewport: { width: 1440, height: 1000 },
  },
  {
    name: "desktop-light",
    theme: "light",
    viewport: { width: 1440, height: 1000 },
  },
  {
    name: "mobile-light",
    theme: "light",
    viewport: { width: 390, height: 844 },
  },
] as const) {
  test.describe.serial(`APTLSS LIVE ${scenario.name}`, () => {
    let db: Connection | undefined;
    let seeded = false;
    const mutationStates: MutationState[] = [];
    let workerId = 0,
      otherId = 0,
      adminId = 0,
      latestRunId = 0;
    let prefix = "",
      cardId = "",
      baseline = "";
    const cardName = `Review delivery report (${scenario.name})`;
    const insert = async (sql: string, values: unknown[]) =>
      (await db!.execute<ResultSetHeader>(sql, values))[0].insertId;
    const rows = async (sql: string, values: unknown[]) =>
      (await db!.execute<RowDataPacket[]>(sql, values))[0];
    const latest = async () => {
      const [row] = await rows(
        "SELECT id, snapshotJson FROM aptlss_manager_runs WHERE vaId = ? ORDER BY id DESC LIMIT 1",
        [workerId]
      );
      return row
        ? ({
            ...JSON.parse(row.snapshotJson),
            runId: row.id,
          } as ManagerSnapshot)
        : null;
    };
    const assertUnchanged = async () => {
      const [row] = await rows(
        "SELECT scheduleJson FROM daily_plans WHERE vaId = ?",
        [workerId]
      );
      expect(row.scheduleJson).toBe(baseline);
    };

    test.beforeAll(async ({ browser }) => {
      // API health can precede Vite's first client compilation. Verify the real
      // entry screen before timing the authenticated business workflow.
      const entry = await browser.newPage();
      try {
        await entry.goto("/");
        await expect(entry.getByLabel("Username", { exact: true })).toBeVisible();
      } finally {
        await entry.close();
      }
      db = await createConnection({
        uri: isolatedDatabaseUrl(),
        timezone: "Z",
      });
      prefix = `aptlss-ui-${randomUUID().slice(0, 18)}`;
      cardId = `${prefix}-card`;
      const now = new Date();
      // Real timezone with a daytime working window, independent of host hour.
      const offset = 12 - now.getUTCHours();
      const timezone =
        offset === 0
          ? "Etc/GMT"
          : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
      const dateKey = dateKeyInTimeZone(now, timezone);
      baseline = JSON.stringify({
        version: 2,
        dateKey,
        generatedAt: now.toISOString(),
        blocks: [
          {
            id: `${prefix}-protected`,
            startTime: "09:00",
            endTime: "09:15",
            cardId,
            cardName,
            cardUrl: "https://example.invalid/retained-source",
            boardName: "Isolated acceptance",
            listName: "Doing",
            action: "Retain completed work",
            stepIds: [],
            priority: "MEDIUM",
            score: 10,
            state: "DONE",
            status: "done",
            notes: "Fixture baseline",
            flags: [],
          },
        ],
        robertItems: [],
        unscheduledCards: [],
        planHealth: {
          confidence: 0,
          scheduledMinutes: 15,
          availableMinutes: 540,
          overlaps: 0,
          gaps: 525,
        },
        constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
        auditTrail: [
          {
            at: now.toISOString(),
            action: "APTLSS manager reconciliation",
            detail: "Retained fixture baseline",
          },
        ],
      });
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      await db.beginTransaction();
      try {
        workerId = await insert(
          "INSERT INTO users (openId,name,role,loginMethod,passwordHash) VALUES (?,?,?,?,?)",
          [
            `${prefix}-worker`,
            `${prefix} Worker`,
            "worker",
            "local",
            passwordHash,
          ]
        );
        otherId = await insert(
          "INSERT INTO users (openId,name,role,loginMethod,passwordHash) VALUES (?,?,?,?,?)",
          [
            `${prefix}-other`,
            `${prefix} Other`,
            "worker",
            "local",
            passwordHash,
          ]
        );
        adminId = await insert(
          "INSERT INTO users (openId,name,role,loginMethod,passwordHash) VALUES (?,?,?,?,?)",
          [`${prefix}-admin`, `${prefix} Admin`, "admin", "local", passwordHash]
        );
        await db.execute(
          "INSERT INTO user_working_hours (userId,userOpenId,timezone,workingDays,workStartHour,workEndHour,enableBreaks) VALUES (?,?,?,?,?,?,?)",
          [workerId, `${prefix}-worker`, timezone, "0,1,2,3,4,5,6", 9, 18, 0]
        );
        await db.execute(
          "INSERT INTO aptlss_manager_state (vaId,enabled,intervalMinutes,mode) VALUES (?,1,5,?), (?,0,17,?)",
          [workerId, "shadow", otherId, "shadow"]
        );
        await db.execute(
          "INSERT INTO aptlss_plans (vaId,cardId,cardName,cardUrl,boardName,listName,planJson) VALUES (?,?,?,?,?,?,?)",
          [
            workerId,
            cardId,
            cardName,
            "https://example.invalid/retained-source",
            "Isolated acceptance",
            "Doing",
            JSON.stringify({
              nextBestAction: "Check delivery report",
              planSummary: "Review the retained source.",
            }),
          ]
        );
        await db.execute(
          "INSERT INTO card_states (vaId,cardId,cardName,state,listName,stateReason) VALUES (?,?,?,?,?,?)",
          [
            workerId,
            cardId,
            cardName,
            "DOING",
            "Doing",
            "Review the current delivery report.",
          ]
        );
        await db.execute(
          "INSERT INTO priority_scores (vaId,cardId,score,tier) VALUES (?,?,50,?)",
          [workerId, cardId, "HIGH"]
        );
        await db.execute(
          "INSERT INTO aptlss_steps (vaId,cardId,stepNumber,title,estimatedMinutes,category,completionCriteria) VALUES (?,?,1,?,15,?,?)",
          [
            workerId,
            cardId,
            "Check delivery report",
            "internal_work",
            "Record the checked source and current delivery status.",
          ]
        );
        await db.execute(
          "INSERT INTO daily_plans (vaId,dateKey,scheduleJson,totalScheduledMinutes) VALUES (?,?,?,15)",
          [workerId, dateKey, baseline]
        );
        await db.commit();
        seeded = true;
      } catch (error) {
        await db.rollback();
        throw error;
      }
    });

    test.afterAll(async () => {
      if (!db) return;
      try {
        if (!seeded) return;
        if (
          mutationStates.some(
            state => state.pending.size > 0 || state.uncertain
          )
        ) {
          throw new Error(
            `Retaining fixture ${prefix}: a server mutation may still be running. Stop the dedicated server before manual cleanup.`
          );
        }
        await db.beginTransaction();
        try {
          // Only this fixture's exact source ID and this fixture user's assertions.
          const evidence = await rows(
            "SELECT id FROM workspace_evidence_items WHERE sourceId = ? OR sourceId LIKE ?",
            [`${prefix}-source`, `worker-assertion:${workerId}:%`]
          );
          for (const table of [
            "aptlss_verification_followups",
            "aptlss_evidence_conflicts",
          ])
            await db.execute(`DELETE FROM ${table} WHERE vaId IN (?,?)`, [
              workerId,
              otherId,
            ]);
          for (const item of evidence) {
            const foreign = await rows(
              "SELECT id FROM aptlss_evidence_subject_links WHERE evidenceId = ? AND vaId NOT IN (?,?)",
              [item.id, workerId, otherId]
            );
            if (foreign.length)
              throw new Error(
                "Refusing to remove fixture evidence linked to another worker."
              );
            await db.execute(
              "DELETE FROM workspace_evidence_items WHERE id = ?",
              [item.id]
            );
          }
          // Foreign-key cascades remove only revisions and links of owned sources.
          await db.execute(
            "UPDATE aptlss_manager_queue_slots SET vaId = NULL, token = NULL, leaseUntil = NULL WHERE vaId IN (?,?)",
            [workerId, otherId]
          );
          for (const table of [
            "aptlss_manager_queue_events",
            "aptlss_manager_queue",
            "aptlss_manager_reviews",
            "aptlss_manager_runs",
            "aptlss_manager_updates",
            "aptlss_manager_state",
            "aptlss_steps",
            "card_states",
            "priority_scores",
            "aptlss_plans",
            "daily_plans",
            "app_settings",
          ])
            await db.execute(`DELETE FROM ${table} WHERE vaId IN (?,?)`, [
              workerId,
              otherId,
            ]);
          await db.execute("DELETE FROM user_working_hours WHERE userId = ?", [
            workerId,
          ]);
          await db.execute("DELETE FROM users WHERE id IN (?,?,?)", [
            workerId,
            otherId,
            adminId,
          ]);
          await db.commit();
        } catch (error) {
          await db.rollback();
          throw error;
        }
      } finally {
        await db.end();
      }
    });

    test.beforeEach(async ({ page }) => {
      mutationStates.push(mutationsByPage.get(page)!);
      await page.setViewportSize(scenario.viewport);
      await page.addInitScript(
        theme => localStorage.setItem("theme", theme),
        scenario.theme
      );
    });

    test("new evidence and worker update retain a shadow proposal and unchanged daily plan", async ({
      page,
    }, testInfo) => {
      await login(page, `${prefix}-worker`, "worker");
      const manager = page.getByRole("region", { name: "APTLSS work manager" });
      await expect(manager.getByText("Shadow", { exact: true })).toBeVisible();
      const initialResponse = await mutateThroughUi<ManagerSnapshot>(
        page,
        "operator.runManager",
        () => manager.getByRole("button", { name: "Reassess now" }).click()
      );
      const initial = (await latest())!;
      expect(initial.runId).toBeGreaterThan(0);
      expect(initial.runId).toBe(initialResponse.runId);
      expect(initial.applied).toBe(false);
      await assertUnchanged();

      const observed = new Date(Date.now() - 1000);
      const sourceText =
        "Review delivery report against the retained source record.";
      const hash = createHash("sha256").update(sourceText).digest("hex");
      await db!.beginTransaction();
      try {
        const sourceId = await insert(
          "INSERT INTO workspace_evidence_items (source,sourceId,title,content,sourceUrl,observedAt,modifiedAt,contentHash,active) VALUES (?,?,?,?,?,?,?,?,1)",
          [
            "google_drive",
            `${prefix}-source`,
            "Review delivery report",
            sourceText,
            "https://example.invalid/retained-source",
            observed,
            observed,
            hash,
          ]
        );
        await db!.execute(
          "INSERT INTO aptlss_evidence_subject_links (evidenceId,vaId,subjectType,subjectId,relevanceScore,linkMethod,matchReason) VALUES (?,?,?,?,100,?,?)",
          [
            sourceId,
            workerId,
            "card",
            cardId,
            "confirmed",
            "Explicit isolated fixture source link",
          ]
        );
        await db!.execute(
          "INSERT INTO workspace_evidence_links (evidenceId,cardId,relevanceScore,linkMethod,matchReason) VALUES (?,?,100,?,?)",
          [sourceId, cardId, "manual", "Explicit isolated fixture source link"]
        );
        await db!.execute(
          "UPDATE aptlss_plans SET contextSnapshot = ? WHERE vaId = ? AND cardId = ?",
          [
            JSON.stringify({
              id: cardId,
              name: cardName,
              desc: sourceText,
              dateLastActivity: observed.toISOString(),
            }),
            workerId,
            cardId,
          ]
        );
        await db!.commit();
      } catch (error) {
        await db!.rollback();
        throw error;
      }
      const sourcedResponse = await mutateThroughUi<ManagerSnapshot>(
        page,
        "operator.runManager",
        () => manager.getByRole("button", { name: "Reassess now" }).click()
      );
      const sourced = (await latest())!;
      expect(sourced.runId).toBeGreaterThan(initial.runId);
      expect(sourced.runId).toBe(sourcedResponse.runId);
      expect(
        sourced.evidence.some(item => item.text.includes(sourceText))
      ).toBe(true);
      expect(sourced.interventions).toHaveLength(0);
      await manager.getByRole("button", { name: "Review context" }).click();
      await expect(
        manager
          .getByRole("region", { name: "Cited sources" })
          .getByText(sourceText, { exact: false })
          .first()
      ).toBeVisible();
      await expect(manager.locator("time").first()).toHaveAttribute("datetime");
      await expect(
        manager.getByText(/Semantic review unavailable/)
      ).toBeVisible();
      const update = `Review delivery report against the source record. Checked by ${prefix}.`;
      await manager.getByLabel("What changed in reality?").fill(update);
      const updatedResponse = await mutateThroughUi<ManagerSnapshot>(
        page,
        "operator.submitManagerUpdate",
        () => manager.getByRole("button", { name: "Submit context" }).click()
      );
      await expect(
        page.getByText("Proposal assessed; active plan unchanged").last()
      ).toBeVisible();
      const updated = (await latest())!;
      expect(updated.runId).toBeGreaterThan(sourced.runId);
      expect(updated.runId).toBe(updatedResponse.runId);
      latestRunId = updated.runId;
      expect(updated.policy.mode).toBe("shadow");
      expect(updated.applied).toBe(false);
      expect(updated.proposal?.version).toBe(2);
      expect(
        updated.proposal?.blocks.some(
          block => block.id === `${prefix}-protected` && block.status === "done"
        )
      ).toBe(true);
      expect(
        updated.evidence.some(
          item => item.kind === "worker" && item.text.includes(update)
        )
      ).toBe(true);
      expect(
        updated.evidence.some(
          item => item.kind === "source" && item.text.includes(sourceText)
        )
      ).toBe(true);
      expect(
        (
          await rows(
            "SELECT detail FROM aptlss_manager_updates WHERE vaId = ?",
            [workerId]
          )
        ).some(row => row.detail === update)
      ).toBe(true);
      await assertUnchanged();
      await manager.getByText("Proposed plan", { exact: true }).click();
      await expect(
        manager.getByText(/Not applied to the active plan/)
      ).toBeVisible();
      await expect(manager.getByText(/\d+%/)).toHaveCount(0);
      await expect(manager.getByText(/Last successful data:/)).toBeVisible();
      await expect(
        manager.getByText(
          /Realtime connected|Fallback polling every 60 seconds/
        )
      ).toBeVisible();
      await capture(page, testInfo, `${scenario.name}-worker-shadow`);

      const forbidden = await page.request.get(
        "/api/trpc/operator.getManagerReviewInbox",
        {
          params: {
            input: JSON.stringify(superjson.serialize({ vaId: workerId })),
          },
        }
      );
      expect(forbidden.ok()).toBe(false);
      await page.waitForLoadState("networkidle");
      await page.goto("/founder");
      await expect(page).toHaveURL(/\/worker$/);
      await page.waitForLoadState("networkidle");
      await page.goto("/worker/settings");
      await expect(page.getByText("Shadow", { exact: true })).toBeVisible();
      await page.getByLabel("Assessment interval").fill("9");
      await mutateThroughUi(page, "operator.updateManagerPolicy", () =>
        page.getByRole("button", { name: "Save manager schedule" }).click()
      );
      await expect(
        page.getByText("APTLSS manager schedule saved")
      ).toBeVisible();
      const [own] = await rows(
        "SELECT intervalMinutes,mode FROM aptlss_manager_state WHERE vaId = ?",
        [workerId]
      );
      const [other] = await rows(
        "SELECT enabled,intervalMinutes,mode FROM aptlss_manager_state WHERE vaId = ?",
        [otherId]
      );
      expect({ intervalMinutes: own.intervalMinutes, mode: own.mode }).toEqual({
        intervalMinutes: 9,
        mode: "shadow",
      });
      expect({
        enabled: Number(other.enabled),
        intervalMinutes: other.intervalMinutes,
        mode: other.mode,
      }).toEqual({ enabled: 0, intervalMinutes: 17, mode: "shadow" });
    });

    test("admin review persists and activation is blocked by the actual gate", async ({
      page,
    }, testInfo) => {
      await login(page, `${prefix}-admin`, "admin");
      await page.getByRole("tab", { name: "Manager review" }).click();
      await page.getByLabel("Review worker").selectOption(String(workerId));
      await expect(
        page.getByRole("button", { name: "Enable active mode" })
      ).toBeDisabled();
      const details = page.locator("details").filter({
        has: page
          .locator("summary")
          .getByText(`Review run ${latestRunId}`, { exact: true }),
      });
      await details.locator("summary").first().click();
      await details.getByLabel("Verdict").selectOption("insufficient");
      await details
        .getByLabel("Correction or review notes")
        .fill("Verify source completeness before active reconciliation.");
      await details
        .getByLabel("Review source")
        .fill(`${prefix}-source; local browser acceptance record`);
      await capture(page, testInfo, `${scenario.name}-founder-review`);
      await mutateThroughUi(page, "operator.recordManagerReview", () =>
        details.getByRole("button", { name: "Save review" }).click()
      );
      await expect(page.getByText("Manager review saved")).toBeVisible();
      const [review] = await rows(
        "SELECT vaId,reviewerId,verdict,critical FROM aptlss_manager_reviews WHERE runId = ?",
        [latestRunId]
      );
      expect({
        vaId: review.vaId,
        reviewerId: review.reviewerId,
        verdict: review.verdict,
        critical: Number(review.critical),
      }).toEqual({
        vaId: workerId,
        reviewerId: adminId,
        verdict: "insufficient",
        critical: 0,
      });
      await expect(details.getByLabel("Verdict")).toBeDisabled();
      await expect(
        details.getByRole("button", { name: "Save review" })
      ).toHaveCount(0);
      const activation = await page.request.post(
        "/api/trpc/operator.setManagerMode",
        { data: superjson.serialize({ vaId: workerId, mode: "active" }) }
      );
      expect(activation.ok()).toBe(false);
      await mutateThroughUi(page, "operator.runManagerForReview", () =>
        page.getByRole("button", { name: "Run shadow assessment" }).click()
      );
      await expect(page.getByText("Shadow proposal assessed")).toBeVisible();
      await assertUnchanged();
      const [state] = await rows(
        "SELECT mode FROM aptlss_manager_state WHERE vaId = ?",
        [workerId]
      );
      expect(state.mode).toBe("shadow");
      await page.getByLabel("Review worker").selectOption(String(otherId));
      await expect(
        page.getByText("No assessment runs for this worker.")
      ).toBeVisible();
      await expect(
        page.getByText(`Review run ${latestRunId}`, { exact: true })
      ).toHaveCount(0);
    });
  });
}
