import { expect, type ConsoleMessage, type Locator, type Page, type TestInfo } from "@playwright/test";
import { test as browserTest } from "./aptlss-browser-fixtures";
import { ApiRateWindow } from "./api-rate-window.mjs";
import AxeBuilder from "@axe-core/playwright";
import { isDisabledProviderResponse, TRELLO_CREDENTIALS_MISSING_MESSAGE, UNLINKED_TRELLO_MESSAGE, UNLINKED_TRELLO_PATH } from "./disabled-provider-response.mjs";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { openFixtureDatabase, fixtureInsert, type FixtureDatabase } from "./isolated-postgres-fixtures";
import { requireIsolatedPostgresTestDatabase } from "../shared/isolatedPostgresTestDatabase.mjs";
import superjson from "superjson";
import type { ManagerSnapshot } from "../shared/aptlssManager";
import { dateKeyInTimeZone } from "../shared/workerTime";

// Isolated application acceptance: real login, persisted evidence and business APIs.
// No routes are intercepted. Providers are disabled; this is not live-provider proof.
const PASSWORD = "Aptlss-browser-fixture-only-2026!";
type MutationState = { pending: Set<Promise<void>>; uncertain: boolean };
const mutationsByPage = new WeakMap<Page, MutationState>();
const controlledRealtimeOutages = new WeakSet<Page>();
const apiRateWindow = new ApiRateWindow();
const test = browserTest.extend<{ rateWindow: void }>({
  rateWindow: [async ({ page }, use) => {
    const wait = apiRateWindow.waitMilliseconds();
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    page.on("response", response => {
      if (new URL(response.url()).origin === new URL(test.info().project.use.baseURL!).origin) {
        apiRateWindow.observe(response.headers());
      }
    });
    await use();
  }, { auto: true, timeout: 65_000 }],
});

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
  let requestObserved = false;
  let resolveDispatch!: () => void;
  let rejectDispatch!: (error: Error) => void;
  const dispatched = new Promise<void>((resolve, reject) => {
    resolveDispatch = resolve;
    rejectDispatch = reject;
  });
  let resolveResponse!: (response: import("@playwright/test").Response) => void;
  const response = new Promise<import("@playwright/test").Response>(resolve => {
    resolveResponse = resolve;
  });
  const matchesRequest = (request: import("@playwright/test").Request) =>
    request.method() === "POST" &&
    decodeURIComponent(new URL(request.url()).pathname)
      .split("/api/trpc/")[1]
      ?.split(",")
      .includes(method);
  const onRequest = (request: import("@playwright/test").Request) => {
    if (matchesRequest(request)) {
      requestObserved = true;
      resolveDispatch();
    }
  };
  const onResponse = (result: import("@playwright/test").Response) => {
    if (!matchesRequest(result.request())) return;
    page.off("request", onRequest);
    page.off("response", onResponse);
    resolveResponse(result);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  // Observe the complete body, not just response headers or an early database row.
  const completion = dispatched.then(() => bounded(
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
  )).catch(error => {
    if (requestObserved && !transportSettled) state.uncertain = true;
    page.off("request", onRequest);
    page.off("response", onResponse);
    throw error;
  });
  const observed = completion
    .then(
      () => {},
      () => {}
    )
    .finally(() => state.pending.delete(observed));
  state.pending.add(observed);
  try {
    await action();
    if (!requestObserved) {
      await bounded(dispatched, `${method} did not dispatch a request within 30 seconds`);
    }
  } catch (error) {
    if (!requestObserved) {
      transportSettled = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      rejectDispatch(error instanceof Error ? error : new Error(String(error)));
      await completion.catch(() => undefined);
      throw error;
    }
    await completion;
    throw error;
  }
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
    unlinkedQueryErrors: string[];
    missingCredentialQueryErrors: string[];
  }
>();

function isolatedDatabaseUrl() {
  const raw = process.env.APTLSS_TEST_DATABASE_URL;
  if (!raw)
    throw new Error(
      "Set APTLSS_TEST_DATABASE_URL; DATABASE_URL fallback is forbidden."
    );
  requireIsolatedPostgresTestDatabase(raw, process.env.NODE_ENV === "production");
  return raw;
}

async function openLogin(page: Page) {
  const startupErrors: string[] = [];
  const failedRequests: string[] = [];
  const onPageError = (error: Error) => startupErrors.push(error.message);
  const onRequestFailed = (request: Request) => {
    if (/\/api\//.test(new URL(request.url()).pathname))
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`);
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") startupErrors.push(message.text());
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  let documentStatus: number | undefined;
  let contentSecurityPolicy: string | null = null;
  try {
    const loginForm = page.getByLabel("Username", { exact: true });
    if (!(await loginForm.isVisible().catch(() => false))) {
      const document = await page.goto("/");
      documentStatus = document?.status();
      contentSecurityPolicy = await document?.headerValue("content-security-policy") ?? null;
      expect(document?.ok(), "Login document must load successfully").toBe(true);
    }
    await expect(page).toHaveTitle("VA Task Dashboard");
    await expect(loginForm).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(startupErrors, "Login must render without browser errors").toEqual([]);
  } catch (cause) {
    throw new Error(`Login startup failed: ${JSON.stringify({ url: page.url(), documentStatus, contentSecurityPolicy, startupErrors, failedRequests })}`, { cause });
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("requestfailed", onRequestFailed);
  }
}

async function login(page: Page, username: string, role: "worker" | "admin") {
  await openLogin(page);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  const hitTest = await signIn.evaluate(button => {
    const rect = button.getBoundingClientRect();
    const targets = document.elementsFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return {
      url: location.href,
      body: {
        inlinePointerEvents: document.body.style.pointerEvents,
        computedPointerEvents: getComputedStyle(document.body).pointerEvents,
        inert: document.body.inert,
        ariaHidden: document.body.getAttribute("aria-hidden"),
      },
      htmlPointerEvents: getComputedStyle(document.documentElement).pointerEvents,
      receivesPointer: targets.some(target => button.contains(target)),
      targets: targets.slice(0, 6).map(target => ({
        tag: target.tagName,
        id: target.id,
        className: typeof target.className === "string" ? target.className : "",
        role: target.getAttribute("role"),
        pointerEvents: getComputedStyle(target).pointerEvents,
      })),
      openDialogs: Array.from(document.querySelectorAll("[role=dialog], [data-slot=sheet-overlay]"))
        .map(target => ({ tag: target.tagName, className: (target as HTMLElement).className })),
    };
  });
  if (!hitTest.receivesPointer)
    throw new Error(`Sign-in is covered by another page layer: ${JSON.stringify(hitTest)}`);
  const response = page.waitForResponse(
    response =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST"
  );
  await signIn.click();
  const loginResponse = await response;
  expect(loginResponse.ok()).toBeTruthy();
  expect(await loginResponse.json()).toMatchObject({ success: true });
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

async function focusByTab(page: Page, control: Locator) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const candidates = page.locator(selector);
  const { firstTabStop, tabStops } = await candidates.evaluateAll(elements => {
    let firstTabStop = -1;
    let tabStops = 0;
    for (const [index, element] of elements.entries()) {
      const style = getComputedStyle(element);
      if (!(element instanceof HTMLElement) || element.tabIndex < 0 ||
          style.visibility === "hidden" || style.display === "none" ||
          element.getClientRects().length === 0 || element.matches(":disabled") ||
          element.closest("[inert], [aria-hidden='true']")) continue;
      if (firstTabStop < 0) firstTabStop = index;
      tabStops += 1;
    }
    return { firstTabStop, tabStops };
  });
  if (firstTabStop < 0) throw new Error("The page has no visible keyboard tab stops");
  await candidates.nth(firstTabStop).focus();
  if (await control.evaluate(element => element === document.activeElement)) return;
  const maxAttempts = Math.max(80, tabStops * 3);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await control.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  const target = await control.evaluate(element => ({
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 100),
    tabIndex: (element as HTMLElement).tabIndex,
  }));
  const active = await page.evaluate(() => {
    const element = document.activeElement;
    return element instanceof HTMLElement ? {
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 100),
    } : null;
  });
  throw new Error(`Control could not be reached with sequential Tab navigation after ${maxAttempts} attempts (${tabStops} visible candidates); target=${JSON.stringify(target)}; active=${JSON.stringify(active)}`);
}

async function activateByKeyboard(page: Page, control: Locator) {
  await focusByTab(page, control);
  await expect(control).toBeFocused();
  await page.keyboard.press("Enter");
}

async function assertAccessibility(page: Page, testInfo: TestInfo, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = results.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    nodes: violation.nodes.map(node => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary,
      checks: node.any.map(check => ({ id: check.id, data: check.data })),
    })),
  }));
  await testInfo.attach(`${label}-accessibility.json`, {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json",
  });
  expect(violations, `${label} WCAG 2.2 AA violations`).toEqual([]);
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
    unlinkedQueryErrors: [] as string[],
    missingCredentialQueryErrors: [] as string[],
  };
  errorsByPage.set(page, errors);
  page.on("request", request => {
    const resource = new URL(request.url());
    const dashboard = new URL(test.info().project.use.baseURL!);
    if (/^https?:$/.test(resource.protocol) && resource.origin !== dashboard.origin)
      errors.unexpected.push(`Unexpected external browser resource: ${resource.origin}${resource.pathname}`);
  });
  page.on("pageerror", error => errors.unexpected.push(error.message));
  page.on("response", response => {
    if (
      !(disabledProviderPaths.has(new URL(response.url()).pathname) || new URL(response.url()).pathname === UNLINKED_TRELLO_PATH) ||
      ![412, 500, 503].includes(response.status())
    )
      return;
    errors.providerChecks.push(
      (async () => {
        try {
          const body = await response.json();
          if (isDisabledProviderResponse(new URL(response.url()).pathname, response.status(), body)) {
            errors.verifiedProviderUrls.add(response.url());
            errors.expected.push(`${response.url()}: verified fixture integration precondition`);
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
    if (controlledRealtimeOutages.has(page) && /^\[WebSocket\] (?:FixtureDatabase|Reconnection) error: Error: timeout(?:\n|$)/.test(message.text())) {
      errors.expected.push(message.text());
      return;
    }
    if (
      /Failed to load resource: the server responded with a status of (412|500|503)\b/.test(message.text()) &&
      message.location().url &&
      (disabledProviderPaths.has(new URL(message.location().url).pathname) || new URL(message.location().url).pathname === UNLINKED_TRELLO_PATH)
    ) {
      errors.resourceErrors.push({
        text: message.text(),
        url: message.location().url,
      });
      return;
    }
    if (message.text().startsWith(`[API Query Error] TRPCClientError: ${UNLINKED_TRELLO_MESSAGE}\n`)) {
      errors.unlinkedQueryErrors.push(message.text());
      return;
    }
    if (message.text().startsWith(`[API Query Error] TRPCClientError: ${TRELLO_CREDENTIALS_MISSING_MESSAGE}\n`)) {
      errors.missingCredentialQueryErrors.push(message.text());
      return;
    }
    errors.unexpected.push(message.text());
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
  const trelloResponseVerified = [...errors.verifiedProviderUrls].some(url => new URL(url).pathname === UNLINKED_TRELLO_PATH);
  (trelloResponseVerified ? errors.expected : errors.unexpected).push(...errors.unlinkedQueryErrors);
  (trelloResponseVerified ? errors.expected : errors.unexpected).push(...errors.missingCredentialQueryErrors);
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
    pilotIndex: 0,
    theme: "dark",
    viewport: { width: 1440, height: 1000 },
  },
  {
    name: "desktop-light",
    pilotIndex: 1,
    theme: "light",
    viewport: { width: 1440, height: 1000 },
  },
  {
    name: "mobile-light",
    pilotIndex: 2,
    theme: "light",
    viewport: { width: 390, height: 844 },
  },
] as const) {
  test.describe.serial(`APTLSS LIVE ${scenario.name}`, () => {
    let db: FixtureDatabase | undefined;
    let seeded = false;
    const mutationStates: MutationState[] = [];
    let workerId = 0,
      otherId = 0,
      adminId = 0,
      profileId = 0,
      latestRunId = 0;
    let prefix = "",
      cardId = "",
      baseline = "";
    const cardName = `Review delivery report (${scenario.name})`;
    const insert = async (sql: string, values: unknown[]) =>
      fixtureInsert(db!, sql, values);
    const rows = async (sql: string, values: unknown[]) =>
      (await db!.query(sql, values)).rows;
    const latest = async () => {
      const [row] = await rows(
        "SELECT id, \"snapshotJson\" FROM aptlss_manager_runs WHERE \"vaId\" = $1 ORDER BY id DESC LIMIT 1",
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
        "SELECT \"scheduleJson\" FROM daily_plans WHERE \"vaId\" = $1",
        [workerId]
      );
      expect(row.scheduleJson).toBe(baseline);
    };

    test.beforeAll(async ({ browser }) => {
      // API health can precede Vite's first client compilation. Verify the real
      // entry screen before timing the authenticated business workflow.
      const entry = await browser.newPage();
      try {
        await openLogin(entry);
      } finally {
        await entry.close();
      }
      db = await openFixtureDatabase(isolatedDatabaseUrl());
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
      await db.query("BEGIN");
      try {
        workerId = await insert(
          "INSERT INTO users (id,\"openId\",name,role,\"loginMethod\",\"passwordHash\") VALUES ($1,$2,$3,$4,$5,$6)",
          [
            Number(process.env.APTLSS_TEST_PILOT_WORKER_IDS!.split(",")[scenario.pilotIndex + test.info().retry * 5]),
            `${prefix}-worker`,
            `${prefix} Worker`,
            "worker",
            "local",
            passwordHash,
          ]
        );
        otherId = await insert(
          "INSERT INTO users (\"openId\",name,role,\"loginMethod\",\"passwordHash\") VALUES ($1,$2,$3,$4,$5)",
          [
            `${prefix}-other`,
            `${prefix} Other`,
            "worker",
            "local",
            passwordHash,
          ]
        );
        adminId = await insert(
          "INSERT INTO users (\"openId\",name,role,\"loginMethod\",\"passwordHash\") VALUES ($1,$2,$3,$4,$5)",
          [`${prefix}-admin`, `${prefix} Admin`, "admin", "local", passwordHash]
        );
        profileId = await insert(
          "INSERT INTO va_profiles (\"userId\",\"founderId\",name,timezone,status) VALUES ($1,$2,$3,$4,$5)",
          [workerId, adminId, `${prefix} Worker`, timezone, "active"]
        );
        await db.query(
          "INSERT INTO task_assignments (\"taskId\",\"vaId\",\"founderId\",\"assignedBy\",status) VALUES ($1,$2,$3,$4,$5)",
          [cardId, profileId, adminId, adminId, "assigned"]
        );
        await db.query(
          "INSERT INTO user_working_hours (\"userId\",\"userOpenId\",timezone,\"workingDays\",\"workStartHour\",\"workEndHour\",\"enableBreaks\") VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [workerId, `${prefix}-worker`, timezone, "0,1,2,3,4,5,6", 9, 18, 0]
        );
        await db.query(
          "INSERT INTO aptlss_manager_state (\"vaId\",enabled,\"intervalMinutes\",mode) VALUES ($1,TRUE,5,$2), ($3,FALSE,17,$4)",
          [workerId, "shadow", otherId, "shadow"]
        );
        await db.query(
          "INSERT INTO aptlss_plans (\"vaId\",\"cardId\",\"cardName\",\"cardUrl\",\"boardName\",\"listName\",\"planJson\") VALUES ($1,$2,$3,$4,$5,$6,$7)",
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
        await db.query(
          "INSERT INTO card_states (\"vaId\",\"cardId\",\"cardName\",state,\"listName\",\"stateReason\") VALUES ($1,$2,$3,$4,$5,$6)",
          [
            workerId,
            cardId,
            cardName,
            "DOING",
            "Doing",
            "Review the current delivery report.",
          ]
        );
        await db.query(
          "INSERT INTO priority_scores (\"vaId\",\"cardId\",score,tier) VALUES ($1,$2,50,$3)",
          [workerId, cardId, "HIGH"]
        );
        await db.query(
          "INSERT INTO aptlss_steps (\"vaId\",\"cardId\",\"stepNumber\",title,\"estimatedMinutes\",category,\"completionCriteria\") VALUES ($1,$2,1,$3,15,$4,$5)",
          [
            workerId,
            cardId,
            "Check delivery report",
            "internal_work",
            "Record the checked source and current delivery status.",
          ]
        );
        await db.query(
          "INSERT INTO daily_plans (\"vaId\",\"dateKey\",\"scheduleJson\",\"totalScheduledMinutes\") VALUES ($1,$2,$3,15)",
          [workerId, dateKey, baseline]
        );
        await db.query("COMMIT");
        seeded = true;
      } catch (error) {
        await db.query("ROLLBACK");
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
        await db.query("BEGIN");
        try {
          // Only this fixture's exact source ID and this fixture user's assertions.
          const evidence = await rows(
            "SELECT id FROM workspace_evidence_items WHERE \"sourceId\" IN ($1,$2) OR \"sourceId\" LIKE $3 OR \"sourceId\" LIKE $4",
            [`${prefix}-source`, `${prefix}-conflict-source`, `worker-assertion:${workerId}:%`, `verified-conflict-resolution:${workerId}:%`]
          );
          for (const table of [
            "aptlss_verification_followups",
            "aptlss_evidence_conflicts",
            "founder_decision_deadlines",
            "decision_outcomes",
          ])
            await db.query(`DELETE FROM ${table} WHERE "vaId" IN ($1,$2)`, [
              workerId,
              otherId,
            ]);
          for (const item of evidence) {
            const foreign = await rows(
              "SELECT id FROM aptlss_evidence_subject_links WHERE \"evidenceId\" = $1 AND \"vaId\" NOT IN ($2,$3)",
              [item.id, workerId, otherId]
            );
            if (foreign.length)
              throw new Error(
                "Refusing to remove fixture evidence linked to another worker."
              );
            await db.query(
              "DELETE FROM workspace_evidence_items WHERE id = $1",
              [item.id]
            );
          }
          // Foreign-key cascades remove only revisions and links of owned sources.
          await db.query(
            "UPDATE aptlss_manager_queue_slots SET \"vaId\" = NULL, token = NULL, \"leaseUntil\" = NULL WHERE \"vaId\" IN ($1,$2)",
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
            await db.query(`DELETE FROM ${table} WHERE "vaId" IN ($1,$2)`, [
              workerId,
              otherId,
            ]);
          await db.query("DELETE FROM task_assignments WHERE \"vaId\" = $1", [profileId]);
          await db.query("DELETE FROM va_profiles WHERE id = $1", [profileId]);
          await db.query("DELETE FROM user_working_hours WHERE \"userId\" = $1", [
            workerId,
          ]);
          await db.query("DELETE FROM users WHERE id IN ($1,$2,$3)", [
            workerId,
            otherId,
            adminId,
          ]);
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
      } finally {
        try {
          const { stopManagerScheduler } = await import("../server/aptlssManagerService");
          await stopManagerScheduler();
          const { closeDb } = await import("../server/db");
          await closeDb();
        } finally {
          await db.end();
        }
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
      const managerEvents: Array<{ runId: number; urgent: boolean }> = [];
      let authenticatedConnections = 0;
      page.on("websocket", socket => {
        if (!/^\/ws\/?$/.test(new URL(socket.url()).pathname)) return;
        socket.on("framereceived", frame => {
          const payload = String(frame.payload);
          if (!payload.startsWith("42[")) return;
          const event = JSON.parse(payload.slice(2));
          if (event[0] === "aptlss:manager-updated") managerEvents.push(event[1]);
          if (event[0] === "authenticated" && event[1]?.success === true) authenticatedConnections++;
        });
      });
      await login(page, `${prefix}-worker`, "worker");
      const manager = page.getByRole("region", { name: "APTLSS work manager" });
      await expect(manager.getByRole("alert").getByText("Wait before starting a task", { exact: true })).toBeVisible();
      await expect(manager.getByText(/The full work list has not been checked\./)).toBeVisible();
      const initialResponse = await mutateThroughUi<{ applied: boolean }>(
        page,
        "operator.runManager",
        () => activateByKeyboard(page, manager.getByRole("button", { name: "Reassess now" }))
      );
      const initial = (await latest())!;
      expect(initial.runId).toBeGreaterThan(0);
      expect(initialResponse.applied).toBe(false);
      expect(initial.applied).toBe(false);
      await assertUnchanged();

      const observed = new Date(Date.now() - 1000);
      const sourceText =
        "Review delivery report against the retained source record.";
      const hash = createHash("sha256").update(sourceText).digest("hex");
      await db!.query("BEGIN");
      try {
        const sourceId = await insert(
          "INSERT INTO workspace_evidence_items (source,\"sourceId\",title,content,\"sourceUrl\",\"observedAt\",\"modifiedAt\",\"contentHash\",active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)",
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
        await db!.query(
          "INSERT INTO aptlss_evidence_subject_links (\"evidenceId\",\"vaId\",\"subjectType\",\"subjectId\",\"relevanceScore\",\"linkMethod\",\"matchReason\") VALUES ($1,$2,$3,$4,100,$5,$6)",
          [
            sourceId,
            workerId,
            "card",
            cardId,
            "confirmed",
            "Explicit isolated fixture source link",
          ]
        );
        await db!.query(
          "INSERT INTO workspace_evidence_links (\"evidenceId\",\"cardId\",\"relevanceScore\",\"linkMethod\",\"matchReason\") VALUES ($1,$2,100,$3,$4)",
          [sourceId, cardId, "manual", "Explicit isolated fixture source link"]
        );
        await db!.query(
          "UPDATE aptlss_plans SET \"contextSnapshot\" = $1 WHERE \"vaId\" = $2 AND \"cardId\" = $3",
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
        await db!.query("COMMIT");
      } catch (error) {
        await db!.query("ROLLBACK");
        throw error;
      }
      const sourcedResponse = await mutateThroughUi<{ applied: boolean }>(
        page,
        "operator.runManager",
        () => activateByKeyboard(page, manager.getByRole("button", { name: "Reassess now" }))
      );
      const sourced = (await latest())!;
      expect(sourced.runId).toBeGreaterThan(initial.runId);
      expect(sourcedResponse.applied).toBe(false);
      expect(
        sourced.evidence.some(item => item.text.includes(sourceText))
      ).toBe(true);
      expect(sourced.interventions).toHaveLength(0);
      await expect.poll(() => managerEvents.some(event => event.runId === sourced.runId && event.urgent === false), {
        message: "The authenticated worker receives the persisted assessment over the real websocket",
      }).toBe(true);
      const semanticGap = /^Semantic review (?:unavailable\b|is waiting for its bounded retry window; changed source context has not been semantically reviewed\.$)/;
      expect(sourced.semanticReview?.success).toBe(false);
      expect(sourced.sourceGaps).toContainEqual(expect.stringMatching(semanticGap));
      const contextToggle = manager
        .getByRole("button")
        .filter({
          hasText: /(?:Show|Hide) (?:evidence and answer|task details|answer and evidence)/,
        })
        .first();
      await expect(contextToggle).toBeVisible();
      if ((await contextToggle.getAttribute("aria-expanded")) !== "true") {
        await activateByKeyboard(page, contextToggle);
      }
      const citedSources = manager.getByRole("region", {
        name: "Evidence for this task",
      });
      await expect(
        citedSources.getByText(sourceText, { exact: false }).first()
      ).toBeVisible();
      await expect(
        citedSources.getByRole("link", { name: "Open full source" })
      ).toHaveAttribute("href", "https://example.invalid/retained-source");
      await expect(
        manager.getByText(/Full technical assessment|AI review|semantic review/i)
      ).toHaveCount(0);
      await expect(manager.locator("time").first()).toHaveAttribute("datetime");
      const update = `Review delivery report against the source record. Checked by ${prefix}.`;
      const updateField = manager.getByLabel(/What (?:changed in reality|did you confirm)\?/, { exact: true });
      await focusByTab(page, updateField);
      await updateField.pressSequentially(update);
      const updatedResponse = await mutateThroughUi<{ applied: boolean }>(
        page,
        "operator.submitManagerUpdate",
        () => activateByKeyboard(page, manager.getByRole("button", { name: "Send answer to APTLSS" }))
      );
      const assessmentToast = page.getByText("Proposal assessed; active plan unchanged").last();
      await expect(assessmentToast).toBeVisible();
      await expect(
        assessmentToast.locator("xpath=ancestor::*[@data-sonner-toast][1]")
      ).toHaveCSS("opacity", "1");
      const updated = (await latest())!;
      expect(updated.runId).toBeGreaterThan(sourced.runId);
      expect(updatedResponse.applied).toBe(false);
      await expect.poll(() => managerEvents.some(event => event.runId === updated.runId), {
        message: "The worker update produces a realtime notification for its new persisted assessment",
      }).toBe(true);
      if (process.env.APTLSS_TEST_TRANSPORT_RECOVERY === "true") {
        const beforeReconnect = authenticatedConnections;
        expect(beforeReconnect).toBeGreaterThan(0);
        const refreshed = page.waitForResponse(response =>
          response.ok() && decodeURIComponent(new URL(response.url()).pathname)
            .split("/api/trpc/")[1]?.split(",").includes("operator.getManagerStatus"),
          { timeout: 30_000 });
        const disconnect = await page.request.post("/__fixture__/disconnect-websockets", {
          headers: { "x-fixture-control": "owned-loopback" },
        });
        expect(disconnect.ok()).toBe(true);
        expect((await disconnect.json()).disconnected).toBeGreaterThan(0);
        await expect.poll(() => authenticatedConnections, { timeout: 30_000,
          message: "The real worker websocket reauthenticates after transport interruption",
        }).toBeGreaterThan(beforeReconnect);
        const recoveredResponse = await refreshed;
        expect(await recoveredResponse.finished()).toBeNull();
        const recoveredBody = await recoveredResponse.json();
        const recoveredMethods = decodeURIComponent(new URL(recoveredResponse.url()).pathname)
          .split("/api/trpc/")[1].split(",");
        const recoveredEnvelope = Array.isArray(recoveredBody)
          ? recoveredBody[recoveredMethods.indexOf("operator.getManagerStatus")]
          : recoveredBody;
        expect(recoveredEnvelope.error).toBeUndefined();
        const recoveredStatus = superjson.deserialize<{ expectedRunId?: number }>(recoveredEnvelope.result.data);
        expect(recoveredStatus.expectedRunId).toBe(updated.runId);
        expect((await latest())!.runId).toBe(updated.runId);
        await assertUnchanged();
      }
      expect(updated.semanticReview?.success).toBe(false);
      expect(updated.sourceGaps).toContainEqual(expect.stringMatching(semanticGap));
      await expect(
        manager.getByText(/Full technical assessment|AI review|semantic review/i)
      ).toHaveCount(0);
      latestRunId = updated.runId;
      expect(updated.policy.mode).toBe("shadow");
      expect(updated.applied).toBe(false);
      expect(updated.proposal?.version).toBe(2);
      expect(updated.proposal?.planningImpact?.baseline).toBe("same_day_plan");
      expect(updated.proposal?.planningImpact?.scheduleChanged).toBe(true);
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
            "SELECT detail FROM aptlss_manager_updates WHERE \"vaId\" = $1",
            [workerId]
          )
        ).some(row => row.detail === update)
      ).toBe(true);
      await assertUnchanged();
      await expect(assessmentToast).toHaveCount(0);
      await expect(manager.getByText(/technical assessment|AI review|semantic review/i)).toHaveCount(0);
      await expect(manager.getByText(/\d+%/)).toHaveCount(0);
      await assertAccessibility(page, testInfo, `${scenario.name}-worker-today`);
      if (page.viewportSize()!.width < 768) {
        await activateByKeyboard(page, page.getByRole("button", { name: "Open navigation" }));
        await expect(
          page.getByRole("dialog", { name: "Worker navigation" })
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: /Today/ }).first()
        ).toBeFocused();
      }
      await activateByKeyboard(page, page.getByRole("button", { name: /Plan My Day/ }).first());
      await expect(page).toHaveURL(/\/worker\/plan$/);
      await expect(page.getByRole("heading", { name: "Plan My Day", exact: true })).toBeVisible();
      const suggestion = page.getByRole("region", { name: "Suggested changes to your day" });
      await expect(suggestion).toBeVisible();
      await expect(suggestion.getByText("Not applied", { exact: true })).toBeVisible();
      await expect(suggestion.getByText(/These changes are suggestions only/)).toBeVisible();
      await expect(suggestion.getByText(/Review delivery report/, { exact: false }).first()).toBeVisible();
      await assertUnchanged();
      await expect(page.getByText(/technical assessment|AI review|semantic review/i)).toHaveCount(0);
      await assertAccessibility(page, testInfo, `${scenario.name}-worker-plan`);
      await capture(page, testInfo, `${scenario.name}-worker-plan-suggestion`);

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
      const managerSchedule = page.getByRole("region", {
        name: "Manager schedule",
      });
      await expect(managerSchedule).toBeVisible();
      await expect(
        managerSchedule.getByText("Suggestions only", { exact: true })
      ).toBeVisible();
      await expect(
        managerSchedule.getByText("Check interval: every 5 minutes.", {
          exact: true,
        })
      ).toBeVisible();
      await expect(managerSchedule.getByRole("status")).toHaveText(
        "Automatic checks are not running on this server. Contact your supervisor."
      );
      await expect(managerSchedule.getByText("Checks run every 5 minutes.", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Assessment interval")).toHaveCount(0);
      const forbiddenPolicyUpdate = await page.request.post(
        "/api/trpc/operator.updateManagerPolicy",
        {
          data: superjson.serialize({
            vaId: workerId,
            enabled: false,
            intervalMinutes: 9,
          }),
        }
      );
      expect(forbiddenPolicyUpdate.status()).toBe(403);
      const [own] = await rows(
        "SELECT enabled,\"intervalMinutes\",mode FROM aptlss_manager_state WHERE \"vaId\" = $1",
        [workerId]
      );
      const [other] = await rows(
        "SELECT enabled,\"intervalMinutes\",mode FROM aptlss_manager_state WHERE \"vaId\" = $1",
        [otherId]
      );
      expect({ enabled: Number(own.enabled), intervalMinutes: own.intervalMinutes, mode: own.mode }).toEqual({
        enabled: 1,
        intervalMinutes: 5,
        mode: "shadow",
      });
      expect({
        enabled: Number(other.enabled),
        intervalMinutes: other.intervalMinutes,
        mode: other.mode,
      }).toEqual({ enabled: 0, intervalMinutes: 17, mode: "shadow" });
    });

    test("admin review persists and activation is forbidden by shadow-only deployment", async ({
      page,
    }, testInfo) => {
      await login(page, `${prefix}-admin`, "admin");
      await page.getByRole("tab", { name: "Manager review" }).click();
      await page.getByLabel("Review worker").selectOption(String(workerId));
      await expect(
        page.getByRole("button", { name: "Enable active mode" })
      ).toHaveCount(0);
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
        "SELECT \"vaId\",\"reviewerId\",verdict,critical FROM aptlss_manager_reviews WHERE \"runId\" = $1",
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
      expect(activation.status()).toBe(403);
      await mutateThroughUi(page, "operator.runManagerForReview", () =>
        page.getByRole("button", { name: "Run shadow assessment" }).click()
      );
      await expect(page.getByText("Shadow proposal assessed")).toBeVisible();
      await assertUnchanged();
      const [state] = await rows(
        "SELECT mode FROM aptlss_manager_state WHERE \"vaId\" = $1",
        [workerId]
      );
      expect(state.mode).toBe("shadow");
      await expect(
        page.getByLabel("Review worker").locator(`option[value="${otherId}"]`)
      ).toHaveCount(0);
      const outsidePilot = await page.request.get(
        "/api/trpc/operator.getManagerReviewInbox",
        { params: { input: JSON.stringify(superjson.serialize({ vaId: otherId })) } }
      );
      expect(outsidePilot.status()).toBe(403);
    });

    test("founder approval unlocks the follow-up on worker reassessment without changing the plan", async ({
      page,
    }, testInfo) => {
      const [prerequisite] = await rows(
        "SELECT id FROM aptlss_steps WHERE \"vaId\" = $1 AND \"cardId\" = $2 AND \"stepNumber\" = 1",
        [workerId, cardId]
      );
      expect(prerequisite).toBeDefined();
      const decisionTitle = `Approve the source-checked follow-up (${scenario.name})`;
      const followUpTitle = `Prepare approved follow-up (${scenario.name})`;
      const followUpCriteria = "The follow-up is prepared for worker review";
      await db!.query("BEGIN");
      let followUpId = 0;
      try {
        await db!.query(
          "UPDATE aptlss_steps SET title = $1, \"requiresRobert\" = TRUE, \"recommendedDecision\" = $2 WHERE id = $3 AND \"vaId\" = $4",
          [decisionTitle, "Approve the source-checked follow-up", prerequisite.id, workerId]
        );
        followUpId = await insert(
          "INSERT INTO aptlss_steps (\"vaId\",\"cardId\",\"stepNumber\",title,\"estimatedMinutes\",category,\"blockedBy\",\"completionCriteria\") VALUES ($1,$2,2,$3,15,$4,$5,$6)",
          [workerId, cardId, followUpTitle, "internal_work", "Step 1", followUpCriteria]
        );
        await db!.query("COMMIT");
      } catch (error) {
        await db!.query("ROLLBACK");
        throw error;
      }

      await login(page, `${prefix}-worker`, "worker");
      const manager = page.getByRole("region", { name: "APTLSS work manager" });
      const initialResponse = await mutateThroughUi<{ applied: boolean }>(
        page,
        "operator.runManager",
        () => manager.getByRole("button", { name: "Reassess now" }).click()
      );
      const before = (await latest())!;
      expect(initialResponse.applied).toBe(false);
      const heldAction = before.actions.find(action => action.stepIds.includes(followUpId));
      expect(heldAction).toMatchObject({ blocked: true });
      expect(await rows(
        "SELECT status,\"requiresRobert\" FROM aptlss_steps WHERE id = $1 AND \"vaId\" = $2",
        [prerequisite.id, workerId]
      )).toMatchObject([{ status: "open", requiresRobert: true }]);
      await assertUnchanged();

      if (page.viewportSize()!.width < 768)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
      await login(page, `${prefix}-admin`, "admin");
      await page.getByRole("tab", { name: "Decisions" }).click();
      const inbox = page.getByRole("region", { name: "Founder decision inbox" });
      const decisionItem = inbox
        .getByRole("button")
        .filter({ hasText: decisionTitle });
      await expect(decisionItem).toHaveCount(1);
      await decisionItem.click();
      const finalDecision = inbox.getByRole("group", { name: "Final decision" });
      await finalDecision.getByRole("button", { name: "Approve", exact: true }).click();
      await inbox.getByLabel("Reason and source checked").fill(
        "Approved after reviewing the linked source in this isolated test."
      );
      const outcome = await mutateThroughUi<{ reassessmentQueued: boolean }>(
        page,
        "operator.recordFounderDecisionOutcome",
        () => inbox.getByRole("button", { name: "Record approval" }).click()
      );
      expect(outcome.reassessmentQueued).toBe(true);
      await expect(inbox.getByText("No founder decisions are waiting.")).toBeVisible();

      const [queued] = await rows(
        "SELECT state,\"trigger\" FROM aptlss_manager_queue WHERE \"vaId\" = $1",
        [workerId]
      );
      expect(queued).toMatchObject({ state: "pending", trigger: "decision_outcome" });
      await assertUnchanged();

      if (page.viewportSize()!.width < 768)
        await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await page.getByText(`${prefix} Admin`, { exact: true }).click();
      await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
      await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
      await login(page, `${prefix}-worker`, "worker");
      await page.goto("/worker");
      const workerManager = page.getByRole("region", { name: "APTLSS work manager" });
      const reassessment = await mutateThroughUi<{ applied: boolean }>(
        page,
        "operator.runManager",
        () => workerManager.getByRole("button", { name: "Reassess now" }).click()
      );
      const after = (await latest())!;
      expect(reassessment.applied).toBe(false);
      expect(after.runId).toBeGreaterThan(before.runId);
      expect(after.applied).toBe(false);
      expect(after.policy.mode).toBe("shadow");
      expect(after.actions.some(action => action.stepIds.includes(Number(prerequisite.id)))).toBe(false);
      expect(after.actions.find(action => action.stepIds.includes(followUpId))).toMatchObject({
        blocked: false,
        completionCriteria: followUpCriteria,
      });
      expect(await rows(
        "SELECT status FROM aptlss_steps WHERE id = $1 AND \"vaId\" = $2",
        [prerequisite.id, workerId]
      )).toMatchObject([{ status: "complete" }]);
      await assertUnchanged();

      await expect(
        workerManager.getByText("Continue the recorded work step", { exact: true })
      ).toBeVisible();
      await expect(workerManager.getByText(/technical assessment|AI review|semantic review/i)).toHaveCount(0);
      await expect(page.getByText(`Next step: ${followUpTitle}`, { exact: true })).toBeVisible();
      await expect(page.getByText(followUpCriteria, { exact: false }).first()).toBeVisible();
      await page.getByRole("button", { name: "Open details", exact: true }).click();
      const inspector = page.getByRole("dialog");
      const approvedStep = inspector.getByRole("group", { name: `Step 1: ${decisionTitle}`, exact: true });
      await expect(approvedStep.getByText("Done", { exact: true })).toBeVisible();
      await expect(approvedStep.getByText(/Waiting for founder decision|Deferred/)).toHaveCount(0);
      await expect(approvedStep.getByText("Decision", { exact: true })).toHaveCount(0);
      const nextSection = inspector.getByText("Exactly next", { exact: true }).locator("..");
      await expect(nextSection).toContainText(followUpTitle);
      await assertAccessibility(page, testInfo, `${scenario.name}-worker-after-founder-decision`);
      await capture(page, testInfo, `${scenario.name}-worker-after-founder-decision`);
      await assertUnchanged();
    });

    test("a retained invoice conflict produces an urgent worker notification and blocks dependent work", async ({ page }, testInfo) => {
      const missedEvent = process.env.APTLSS_TEST_MISSED_EVENT === "true";
      if (missedEvent) test.setTimeout(150_000);
      let authenticatedConnections = 0;
      const events: Array<{ runId: number; urgent: boolean }> = [];
      page.on("websocket", socket => {
        if (!/^\/ws\/?$/.test(new URL(socket.url()).pathname)) return;
        socket.on("framereceived", frame => {
          const payload = String(frame.payload);
          if (!payload.startsWith("42[")) return;
          const event = JSON.parse(payload.slice(2));
          if (event[0] === "aptlss:manager-updated") events.push(event[1]);
          if (event[0] === "authenticated" && event[1]?.success === true) authenticatedConnections++;
        });
      });
      await login(page, `${prefix}-worker`, "worker");
      if (missedEvent) {
        await expect.poll(() => authenticatedConnections).toBeGreaterThan(0);
        controlledRealtimeOutages.add(page);
        const paused = await page.request.post("/__fixture__/pause-realtime", { headers: { "x-fixture-control": "owned-loopback" } });
        expect(paused.ok()).toBe(true);
        expect(await paused.json()).toMatchObject({ paused: true });
      }
      const retained: number[] = [];
      let conflictId = 0;
      let followupId = 0;
      const verificationTitle = `${prefix} Verify invoice A-12`;
      const observed = new Date(Date.now() - 60_000);
      await db!.query("BEGIN");
      try {
        for (const [index, content] of ["Invoice A-12 is unpaid.", "Invoice A-12 is paid."].entries()) {
          const contentHash = createHash("sha256").update(content).digest("hex");
          const metadata = JSON.stringify({ sourceDate: observed.toISOString() });
          const evidenceId = await insert(
            "INSERT INTO workspace_evidence_items (\"vaId\",source,\"sourceId\",kind,title,content,\"sourceUrl\",\"observedAt\",\"modifiedAt\",\"contentHash\",\"metadataJson\",active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)",
            [workerId, "trello", index ? `worker-assertion:${workerId}:${prefix}-conflict-${index}` : `${prefix}-conflict-source`, index ? "worker_assertion" : "record", "Retained invoice status", content, "https://example.invalid/invoice", observed, observed, contentHash, metadata]);
          retained.push(evidenceId);
          await insert("INSERT INTO aptlss_evidence_revisions (\"evidenceId\",\"truthClass\",content,\"contentHash\",\"observedAt\",\"metadataJson\") VALUES ($1,$2,$3,$4,$5,$6)",
            [evidenceId, index ? "worker_assertion" : "source_record", content, contentHash, observed, metadata]);
          await insert("INSERT INTO aptlss_evidence_subject_links (\"evidenceId\",\"vaId\",\"subjectType\",\"subjectId\",\"relevanceScore\",\"linkMethod\",\"matchReason\") VALUES ($1,$2,$3, $4,100,$5,$6)",
            [evidenceId, workerId, "card", cardId, "confirmed", "Owned contradictory invoice fixture"]);
          await insert("INSERT INTO workspace_evidence_links (\"evidenceId\",\"cardId\",\"relevanceScore\",\"linkMethod\",\"matchReason\") VALUES ($1,$2,100,$3,$4)",
            [evidenceId, cardId, "manual", "Owned contradictory invoice fixture"]);
        }
        conflictId = await insert("INSERT INTO aptlss_evidence_conflicts (\"vaId\",\"sourceEvidenceId\",\"assertedEvidenceId\",status) VALUES ($1,$2,$3,$4)",
          [workerId, retained[0], retained[1], "needs_verification"]);
        followupId = await insert("INSERT INTO aptlss_verification_followups (\"vaId\",\"cardId\",\"conflictId\",title,question,status) VALUES ($1,$2,$3,$4,$5,$6)",
          [workerId, cardId, conflictId, verificationTitle, "Is invoice A-12 paid or unpaid? Check the original record.", "open"]);
        if (process.env.APTLSS_TEST_AUTOMATIC_WORKFLOW === "true") {
          await db!.query("INSERT INTO aptlss_manager_queue (\"vaId\",state,generation,priority,\"trigger\") VALUES ($1,'pending',1,100,'conflict') ON CONFLICT (\"vaId\") DO UPDATE SET generation=aptlss_manager_queue.generation+1, priority=100, \"trigger\"='conflict', state=CASE WHEN aptlss_manager_queue.state='leased' THEN 'leased' ELSE 'pending' END, \"availableAt\"=CURRENT_TIMESTAMP(3)", [workerId]);
        }
        await db!.query("COMMIT");
      } catch (error) { await db!.query("ROLLBACK"); throw error; }
      const manager = page.getByRole("region", { name: "APTLSS work manager" });
      if (process.env.APTLSS_TEST_AUTOMATIC_WORKFLOW === "true") {
        await expect.poll(async () => (await latest())?.interventions.some(item => item.cardId === cardId && item.severity === "urgent"), { timeout: 30_000 }).toBe(true);
      } else {
        await mutateThroughUi(page, "operator.runManager", () => activateByKeyboard(page, manager.getByRole("button", { name: "Reassess now" })));
      }
      const assessed = (await latest())!;
      expect(assessed.interventions).toEqual(expect.arrayContaining([
        expect.objectContaining({ cardId, severity: "urgent" }),
      ]));
      const dependent = assessed.actions.filter(action => action.cardId === cardId && action.kind === "work");
      expect(dependent.length).toBeGreaterThan(0);
      expect(dependent.every(action => action.blocked)).toBe(true);
      if (missedEvent) {
        expect(events.some(event => event.runId === assessed.runId)).toBe(false);
        await expect(manager.getByRole("alert").first()).toContainText("Conflicting facts", { timeout: 75_000 });
        expect(events.some(event => event.runId === assessed.runId)).toBe(false);
        const beforeRecovery = authenticatedConnections;
        const resumed = await page.request.post("/__fixture__/resume-realtime", { headers: { "x-fixture-control": "owned-loopback" } });
        expect(resumed.ok()).toBe(true);
        await resumed.json();
        await expect.poll(() => authenticatedConnections, { timeout: 30_000 }).toBeGreaterThan(beforeRecovery);
        controlledRealtimeOutages.delete(page);
      } else {
        await expect.poll(() => events.some(event => event.runId === assessed.runId && event.urgent)).toBe(true);
        await expect(manager.getByRole("alert").first()).toBeVisible();
      }
      await expect(manager.getByText(/Full technical assessment|AI review|semantic review/i)).toHaveCount(0);
      expect(assessed.applied).toBe(false);
      latestRunId = assessed.runId;
      await assertUnchanged();
      await capture(page, testInfo, `${scenario.name}-urgent-retained-conflict`);
      await page.getByRole("button", { name: "Open related task", exact: true }).click();
      const inspector = page.getByRole("dialog");
      const verification = inspector.getByRole("form", { name: verificationTitle, exact: true });
      await expect(verification).toBeVisible();
      await verification.getByLabel("What did you find?", { exact: true }).fill("I think it is unpaid, but have not verified the source yet.");
      await expect(verification.getByRole("button", { name: "Save verification and close", exact: true })).toBeDisabled();
      await mutateThroughUi(page, "operator.resolveVerificationFollowup", () => verification.getByRole("button", { name: "Save note; keep open", exact: true }).click());
      expect(await rows("SELECT status FROM aptlss_evidence_conflicts WHERE id = $1 AND \"vaId\" = $2", [conflictId, workerId])).toMatchObject([{ status: "needs_verification" }]);
      expect(await rows("SELECT status FROM aptlss_verification_followups WHERE id = $1 AND \"vaId\" = $2", [followupId, workerId])).toMatchObject([{ status: "open" }]);
      await assertUnchanged();
      await verification.getByLabel("What did you find?", { exact: true }).fill("The original retained record confirms invoice A-12 is unpaid.");
      await verification.getByLabel("Which original source confirms it?", { exact: true }).selectOption(String(retained[0]));
      await verification.getByLabel("Exact sentence from the source", { exact: true }).fill("Invoice A-12 is unpaid.");
      await mutateThroughUi(page, "operator.resolveVerificationFollowup", () => verification.getByRole("button", { name: "Save verification and close", exact: true }).click());
      expect(await rows("SELECT status FROM aptlss_evidence_conflicts WHERE id = $1 AND \"vaId\" = $2", [conflictId, workerId])).toMatchObject([{ status: "resolved" }]);
      expect(await rows("SELECT status FROM aptlss_verification_followups WHERE id = $1 AND \"vaId\" = $2", [followupId, workerId])).toMatchObject([{ status: "resolved" }]);
      const resolved = (await latest())!;
      expect(resolved.runId).toBeGreaterThan(assessed.runId);
      expect(resolved.policy.mode).toBe("shadow");
      expect(resolved.applied).toBe(false);
      await expect(verification).toHaveCount(0);
      await assertUnchanged();
      await capture(page, testInfo, `${scenario.name}-verified-conflict-resolved`);
    });
  });
}
