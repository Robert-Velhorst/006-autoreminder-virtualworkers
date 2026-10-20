import { expect, test, type Page, type TestInfo } from "@playwright/test";
import superjson from "superjson";
import type { AtisOperation } from "../client/src/lib/atis-operation";

test.skip(process.env.APTLSS_UI_ONLY !== "true", "Intercepted Home contracts run only through the UI-only fixture configuration.");

type Call = { method: string; path: string; body: unknown };
const op = (kind: AtisOperation["kind"], state: AtisOperation["state"] = "running"): AtisOperation => ({
  id: kind === "sync" ? 41 : 42, kind, state,
  ...(state === "completed" ? { result: kind === "sync"
    ? { totalBoards: 2, totalCards: 7, newBoards: 1, newCards: 3 }
    : { processed: 7, failed: 0 } } : {}),
});

async function homeFixture(page: Page, baseURL: string, info: TestInfo) {
  const origin = new URL(baseURL).origin;
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const model = { active: [] as AtisOperation[], sync: op("sync"), analysis: op("understanding"),
    analysisConflict: false, statusUnavailable: false };
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-21T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-21T12:00:00Z"));
  // No socket or cross-origin HTTP request may reach a provider/backend.
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || url.pathname.startsWith("/ws")) return route.abort();
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/__local-preview/status") {
      if (request.method() === "GET") return route.continue();
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    const path = url.pathname + url.search;
    calls.push({ method: request.method(), path, body: request.postData() ? JSON.parse(request.postData()!) : null });
    if (url.pathname.startsWith("/api/trpc/")) {
      const methods = decodeURIComponent(url.pathname.split("/api/trpc/")[1]).split(",");
      const results = methods.map(method => {
        if (method !== "auth.me") unexpected.push(method);
        return { result: { data: superjson.serialize(method === "auth.me" ? {
          id: 1, openId: "synthetic-home-admin", name: "Browser Admin", email: null, role: "admin",
        } : null) } };
      });
      return route.fulfill({ json: url.searchParams.has("batch") ? results : results[0] });
    }
    if (url.pathname === "/api/atis/operations/active") return route.fulfill({ json: { operations: model.active } });
    if (/^\/api\/atis\/operations\/(41|42)$/.test(url.pathname)) {
      if (model.statusUnavailable) return route.fulfill({ status: 503, json: { error: "Synthetic status read unavailable" } });
      return route.fulfill({ json: { operation: url.pathname.endsWith("/41") ? model.sync : model.analysis } });
    }
    if (url.pathname === "/api/atis/sync" && request.method() === "POST") return route.fulfill({ status: 202, json: { operation: model.sync } });
    if (url.pathname === "/api/atis/understanding/process" && request.method() === "POST") {
      return route.fulfill({ status: model.analysisConflict ? 409 : 202, json: {
        operation: model.analysis,
        ...(model.analysisConflict ? { requestedNotStarted: true, error: "A different request is running. This request was not started." } : {}),
      } });
    }
    if (url.pathname === "/api/atis/timeline-tasks") return route.fulfill({ json: {
      scheduled: [], overflow: [], metrics: { totalScheduled: 0, totalScheduledMinutes: 0 },
    } });
    if (url.pathname === "/api/atis/task-types") return route.fulfill({ json: [] });
    if (url.pathname === "/api/notifications/unread-count") return route.fulfill({ json: { unreadCount: 0 } });
    if (url.pathname === "/api/notifications") return route.fulfill({ json: { notifications: [] } });
    if (url.pathname === "/api/time-tracking/weekly-progress") return route.fulfill({ json: {
      weekStart: "2026-10-19", weekEnd: "2026-10-25", actualHours: 0, actualMinutes: 0,
      weeklyHoursMin: 0, weeklyHoursMax: 40, dailyHoursMin: 0, dailyHoursMax: 8,
      dailyHours: {}, progressPercent: 0, onTrack: true, status: "on_track",
    } });
    if (url.pathname === "/__local-preview/status" || url.pathname === "/api/auth/owner-bootstrap/status") return route.fulfill({ json: { available: false } });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { error: "Unconfigured browser fixture" } });
  });
  const posts = () => calls.filter(call => call.method === "POST");
  const queueReads = () => calls.filter(call => call.path === "/api/atis/timeline-tasks?filter=all");
  const successToasts = page.locator('[data-sonner-toast][data-type="success"]');
  const status = page.getByRole("status", { name: "Sync and analysis status" });
  const tick = () => page.clock.runFor(2_100);
  const flush = () => page.clock.runFor(100);
  const ready = async () => {
    await expect.poll(async () => {
      await page.clock.runFor(100);
      return page.getByRole("heading", { name: "Workload Timeline" }).count();
    }).toBe(1);
    await expect(page.getByRole("heading", { name: "Workload Timeline" })).toBeVisible();
  };
  const open = async () => {
    await page.goto("/");
    await ready();
    await expect(page.getByRole("heading", { name: "No tasks scheduled" })).toBeVisible();
  };
  const proof = async (name: string) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
    await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: "image/png" });
  };
  return { calls, model, posts, queueReads, successToasts, status, tick, flush, ready, open, proof,
    verify: async () => {
      expect(errors, "No uncaught browser errors").toEqual([]);
      expect(unexpected, "Every API request is explicitly intercepted").toEqual([]);
      await info.attach("synthetic-api-calls", { body: JSON.stringify(calls, null, 2), contentType: "application/json" });
    } };
}

test.describe("Admin Home async ATIS browser contracts (intercepted API, no database)", () => {
  test("202 stays pending, prevents duplicate starts, and refreshes only after each confirmed completion", async ({ page, baseURL }, info) => {
    const fixture = await homeFixture(page, baseURL!, info);
    await fixture.open();
    const sync = page.getByRole("button", { name: "Sync from Trello", exact: true });
    await expect(sync).toBeEnabled();
    const reads = fixture.queueReads().length;
    await sync.click();
    await expect(fixture.status).toContainText("Trello sync is running on the server");
    await expect(page.getByRole("button", { name: "Syncing from Trello" })).toBeDisabled();
    await fixture.tick();
    await expect(fixture.successToasts).toHaveCount(0);
    expect(fixture.posts()).toHaveLength(1);
    expect(fixture.queueReads()).toHaveLength(reads);
    await fixture.proof("sync-pending-no-success");
    fixture.model.sync = op("sync", "completed");
    await fixture.tick();
    await expect(fixture.status).toContainText("Card analysis is running on the server");
    await fixture.flush();
    await expect.poll(() => fixture.queueReads().length).toBe(reads + 1);
    expect(fixture.posts().map(call => call.path)).toEqual(["/api/atis/sync", "/api/atis/understanding/process"]);
    await expect(fixture.successToasts).toContainText(["Synced 2 boards and 7 cards from Trello"]);
    await expect(page.getByRole("button", { name: "Syncing from Trello" })).toBeDisabled();
    expect(fixture.posts()[1].body).toEqual({ limit: 50 });
    fixture.model.analysis = op("understanding", "completed");
    await fixture.tick();
    await expect(fixture.status).toContainText("Card analysis completed");
    await fixture.flush();
    await expect.poll(() => fixture.queueReads().length).toBe(reads + 2);
    await expect(sync).toBeEnabled();
    await expect(fixture.successToasts).toHaveCount(2);
    await expect(fixture.successToasts.filter({ hasText: "Synced 2 boards and 7 cards from Trello" })).toBeVisible();
    await expect(fixture.successToasts.filter({ hasText: "AI analyzed 7 cards" })).toBeVisible();
    expect(fixture.posts()).toHaveLength(2);
    await fixture.proof("analysis-completed-refreshed");
    await fixture.verify();
  });

  test("reload observes an existing sync without POSTing or automatically chaining new analysis", async ({ page, baseURL }, info) => {
    const fixture = await homeFixture(page, baseURL!, info);
    fixture.model.active = [op("sync")];
    await fixture.open();
    await expect(fixture.status).toContainText("Trello sync is running");
    await page.reload();
    await fixture.ready();
    await expect(fixture.status).toContainText("Trello sync is running");
    await fixture.tick();
    expect(fixture.posts()).toHaveLength(0);
    await expect(fixture.successToasts).toHaveCount(0);
    fixture.model.sync = op("sync", "completed");
    await fixture.tick();
    await expect(fixture.status).toContainText("Trello sync completed");
    await expect(page.getByRole("button", { name: "Analyze synced cards" })).toBeEnabled();
    expect(fixture.posts()).toHaveLength(0);
    await fixture.proof("reload-observes-no-post");
    await fixture.verify();
  });

  test("409 differing analysis request never produces a false success, refresh or duplicate chain", async ({ page, baseURL }, info) => {
    const fixture = await homeFixture(page, baseURL!, info);
    fixture.model.analysisConflict = true;
    fixture.model.sync = op("sync", "completed");
    await fixture.open();
    await page.getByRole("button", { name: "Sync from Trello", exact: true }).click();
    const alert = page.getByRole("alert", { name: "Sync and analysis status" });
    await expect(alert).toContainText("Your request was not started");
    await fixture.flush();
    await expect.poll(() => fixture.posts().length).toBe(2);
    await expect.poll(() => fixture.successToasts.count()).toBe(1); // Only the genuinely completed sync.
    const reads = fixture.queueReads().length;
    await fixture.tick();
    expect(fixture.posts()).toHaveLength(2);
    expect(fixture.queueReads()).toHaveLength(reads);
    fixture.model.analysis = op("understanding", "completed");
    await page.getByRole("button", { name: "Check status", exact: true }).click();
    await expect(fixture.status).toContainText("Your different request was not started");
    expect(fixture.queueReads()).toHaveLength(reads);
    await expect(page.getByText("AI analyzed 7 cards", { exact: true })).toHaveCount(0);
    expect(fixture.posts()).toHaveLength(2);
    await fixture.proof("conflict-not-this-request-success");
    await fixture.verify();
  });

  test("reload retains interruption and sends recovery acknowledgement only after an explicit click", async ({ page, baseURL }, info) => {
    const fixture = await homeFixture(page, baseURL!, info);
    fixture.model.active = [op("sync", "interrupted")];
    await fixture.open();
    await page.reload();
    await fixture.ready();
    const alert = page.getByRole("alert", { name: "Sync and analysis status" });
    await expect(alert).toContainText("Completion is unverified");
    await expect(alert).toContainText("Operation #41");
    expect(fixture.posts()).toHaveLength(0);
    await expect(fixture.successToasts).toHaveCount(0);
    const reads = fixture.queueReads().length;
    await fixture.tick();
    expect(fixture.queueReads()).toHaveLength(reads);
    fixture.model.sync = op("sync");
    await page.getByRole("button", { name: "Acknowledge interruption and restart sync" }).click();
    await expect(fixture.status).toContainText("Trello sync is running");
    expect(fixture.posts()).toHaveLength(1);
    expect(fixture.posts()[0].body).toEqual({ acknowledgeInterruptedOperationId: 41 });
    await fixture.proof("explicit-interruption-recovery");
    await fixture.verify();
  });

  test("status read errors remain unconfirmed without retrying starts or claiming server failure", async ({ page, baseURL }, info) => {
    const fixture = await homeFixture(page, baseURL!, info);
    await fixture.open();
    await page.getByRole("button", { name: "Sync from Trello", exact: true }).click();
    await expect(fixture.status).toContainText("Trello sync is running");
    fixture.model.statusUnavailable = true;
    await fixture.tick();
    const alert = page.getByRole("alert", { name: "Sync and analysis status" });
    await expect(alert).toContainText("Cannot confirm the server operation status");
    await expect(alert).not.toContainText("failed");
    await expect(page.getByRole("button", { name: "Syncing from Trello" })).toBeDisabled();
    await expect(fixture.successToasts).toHaveCount(0);
    const reads = fixture.queueReads().length;
    await fixture.tick();
    expect(fixture.posts()).toHaveLength(1);
    expect(fixture.queueReads()).toHaveLength(reads);
    await fixture.proof("read-error-unconfirmed-not-failed");
    await fixture.verify();
  });
});
