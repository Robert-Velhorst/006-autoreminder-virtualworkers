import { expect, test, type Page, type TestInfo } from "@playwright/test";
import superjson from "superjson";

test.skip(process.env.APTLSS_UI_ONLY !== "true", "Digest contracts require the intercepted UI-only fixture.");
const root = "/api/notifications/digest-jobs";
const at = "2026-10-21T10:00:00.000Z";
const attentionJob = (id = 51, deliveryPhase: string | null = "uncertain") => ({ id, userOpenId: "synthetic-owned-worker", deliveryPhase, status: "failed",
  notificationCount: 2, attemptCount: 1, attemptedAt: at, nextAttemptAt: null, completedAt: null, reconciledAt: null,
  reason: "delivery_requires_reconciliation" });
const frozenText = '<img src="https://provider.invalid/pixel" onerror="window.digestInjected=true">\n<script>window.digestInjected=true</script>\nFrozen notification content';

async function fixture(page: Page, baseURL: string, info: TestInfo, role: "admin" | "worker" = "admin") {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const expectedFixtureErrors: string[] = [];
  const model = { attentionStatus: 200, detailStatus: 200, postStatus: 200, jobs: [attentionJob()],
    postResult: { state: "skipped", reason: "Same frozen batch authorized for retry; no send attempted", reconciled: true, reconciliationOutcome: "retry" } as { state: string; reason: string; reconciled?: boolean; reconciliationOutcome?: string },
    delayAttention: false, delayDetail: false, truncated: false, integrityVerified: true, actorOpenId: "synthetic-admin" };
  let release: (() => void) | undefined;
  let releaseDetail: (() => void) | undefined;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Socket/HMR connections are deliberately blocked; worker background reads are explicitly denied.
    if (text.includes("Failed to load resource") || text.startsWith("[vite] failed to connect to websocket")
      || text.startsWith("Failed to send error to Vite server:") || text.startsWith("[WebSocket] Connection error:")
      || (role === "worker" && text.startsWith("[API Query Error] TRPCClientError: Unavailable"))
      || /^\[API Query Error\] Error: Digest (administration is not permitted|status or reconciliation is unavailable|review is not permitted)/.test(text)) expectedFixtureErrors.push(text);
    else consoleErrors.push(text);
  });
  await page.clock.install();
  await page.routeWebSocket("**/*", socket => socket.close());
  const origin = new URL(baseURL).origin;
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(`external ${url.origin}`); return route.abort(); }
    if (url.pathname.startsWith("/socket.io") || url.pathname.startsWith("/ws")) return route.abort();
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__local-preview/")) {
      if (request.method() === "GET") return route.continue();
      unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
    }
    calls.push({ method: request.method(), path: url.pathname, body: request.postData() ? JSON.parse(request.postData()!) : null });
    if (url.pathname.startsWith("/api/trpc/")) {
      const methods = decodeURIComponent(url.pathname.split("/api/trpc/")[1]).split(",");
      const data: Record<string, unknown> = {
        "auth.me": { id: model.actorOpenId === "synthetic-admin" ? 1 : 2, openId: model.actorOpenId, name: "Browser User", email: null, role },
        "maintenance.status": [],
        "operator.getContext": { displayName: "Browser Worker", timezone: "UTC" },
        "system.health": { status: "ok" },
      };
      const results = methods.map(method => {
        if (method in data) return { result: { data: superjson.serialize(data[method]) } };
        // Worker route background reads are denied, never delegated to the server.
        if (role === "worker" && /^(operator|trello|timer)\./.test(method)) return { error: superjson.serialize({ message: "Unavailable", code: -32003, data: { code: "FORBIDDEN", httpStatus: 403 } }) };
        unexpected.push(method);
        return { result: { data: superjson.serialize(null) } };
      });
      return route.fulfill({ json: url.searchParams.has("batch") ? results : results[0] });
    }
    if (url.pathname === `${root}/attention`) {
      if (model.delayAttention) await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ status: model.attentionStatus, json: model.attentionStatus === 200 ? { jobs: model.jobs } : { error: model.attentionStatus === 403 ? "Digest administration is not permitted" : "Digest status or reconciliation is unavailable" } });
    }
    if (url.pathname === `${root}/51` && request.method() === "GET") {
      if (model.delayDetail) await new Promise<void>(resolve => { releaseDetail = resolve; });
      return route.fulfill({ status: model.detailStatus, json: model.detailStatus === 200 ? { job: {
      id: 51, recipientEmail: model.actorOpenId === "synthetic-admin" ? "frozen@example.invalid" : "other-admin@example.invalid", subject: "Frozen digest subject", text: frozenText,
      textTruncated: model.truncated, integrityVerified: model.integrityVerified,
      notificationIds: [11, 12], deliveryPhase: model.jobs[0]?.deliveryPhase ?? "uncertain", attemptCount: 1, attemptedAt: at, payloadHash: "synthetic-payload-hash",
    } } : { error: "Digest review is not permitted" } });
    }
    if (url.pathname === `${root}/51/reconcile` && request.method() === "POST") return route.fulfill({ status: model.postStatus, json: model.postStatus === 200 ? model.postResult : { error: "Digest cannot be reconciled in its current state. Review active work and delivery evidence." } });
    const rest: Record<string, unknown> = {
      "/api/notifications/unread-count": { unreadCount: 0 }, "/api/notifications": { notifications: [] },
      "/__local-preview/status": { available: false }, "/api/auth/owner-bootstrap/status": { available: false },
      "/api/trello-webhook/status": { status: null }, "/api/trello-webhook/list": { webhooks: [] },
      "/api/trello-webhook/analytics": {},
      "/api/chatbot/analytics": { totalConversations: 0, totalCommands: {}, avgResponseTimeMs: 0,
        totalCheckins: 0, totalResponses: 0, overallResponseRate: 0, avgCheckinResponseMinutes: 0,
        activeWorkers: 0, activeCards: 0, topCommands: [] },
      "/api/trello-boards": { boards: [] },
    };
    if (url.pathname in rest) return route.fulfill({ json: rest[url.pathname] });
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { error: "Unconfigured UI fixture" } });
  });
  const open = async () => {
    await page.goto("/settings");
    if (role === "admin") {
      await page.getByRole("tab", { name: "Maintenance", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Digest recovery", exact: true })).toBeVisible();
    } else await expect(page).toHaveURL(/\/worker$/);
  };
  const review = async () => { await page.getByRole("button", { name: "Review digest #51", exact: true }).click(); await expect(page.getByText("frozen@example.invalid", { exact: true })).toBeVisible(); };
  const fields = async (outcome: "retry" | "sent" = "retry") => {
    await page.getByRole("combobox", { name: "Outcome", exact: true }).click();
    await page.getByRole("option", { name: outcome === "retry" ? "Authorize another attempt" : "Sent confirmed", exact: true }).click();
    await page.getByLabel("Review note").fill("  Reviewed delivery evidence carefully.  ");
    await page.getByLabel("Evidence reference").fill("  ticket-123  ");
  };
  const posts = () => calls.filter(call => call.method === "POST");
  const reads = () => calls.filter(call => call.path === `${root}/attention`);
  const proof = async (name: string) => {
    const dialog = page.getByRole("dialog");
    const surface = await dialog.count() ? dialog : page.locator('section[aria-labelledby="digest-recovery-heading"]');
    await expect(surface).toBeVisible();
    expect(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const box = await surface.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    if (await dialog.count()) {
      // Normal flow content must not overlap, including inside the scrollable mobile dialog.
      const blocks = await dialog.evaluate(el => Array.from(el.children).filter(child => getComputedStyle(child).position !== "absolute").map(child => {
        const rect = child.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
      }));
      for (let index = 1; index < blocks.length; index++) expect(blocks[index].top).toBeGreaterThanOrEqual(blocks[index - 1].bottom - 1);
    }
    await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
    await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: "image/png" });
  };
  const verify = async () => {
    expect(unexpected, "All API/provider requests intercepted").toEqual([]);
    expect(errors, "No uncaught browser errors or framework overlay").toEqual([]);
    expect(consoleErrors, "No unexpected console errors").toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await info.attach("intercepted-api-calls", { body: JSON.stringify(calls, null, 2), contentType: "application/json" });
    await info.attach("expected-fixture-console", { body: JSON.stringify(expectedFixtureErrors, null, 2), contentType: "application/json" });
  };
  return { model, calls, posts, reads, open, review, fields, proof, verify, release: () => release?.(), releaseDetail: () => releaseDetail?.() };
}

test("worker redirected away from admin settings never requests digest attention", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info, "worker");
  await f.open();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.clock.runFor(31_000);
  expect(f.reads()).toHaveLength(0);
  expect(f.posts()).toHaveLength(0);
  await expect(page.getByText("Digest recovery", { exact: true })).toHaveCount(0);
  await f.verify();
});

for (const status of [403, 503]) test(`attention GET ${status} is visible, not a fake empty list, and supports manual refresh`, async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  f.model.attentionStatus = status;
  await f.open();
  await expect(page.getByRole("alert")).toContainText("Cannot confirm digest attention");
  await expect(page.getByText("No digest jobs need attention.", { exact: true })).toHaveCount(0);
  expect(f.reads()).toHaveLength(1);
  await f.proof(`attention-${status}`);
  f.model.attentionStatus = 200;
  await page.getByRole("button", { name: "Refresh digest attention" }).click();
  await expect(page.getByRole("button", { name: "Review digest #51" })).toBeVisible();
  expect(f.posts()).toHaveLength(0);
  await f.verify();
});

test("required trimmed fields and duplicate acknowledgement gate one explicit POST; 409 retains inputs without retry", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  f.model.postStatus = 409;
  await f.open(); await f.review();
  const submit = page.getByRole("button", { name: "Record reconciliation", exact: true });
  await expect(submit).toBeDisabled();
  await f.fields();
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByLabel("Review note").fill("         x ");
  await expect(submit).toBeDisabled();
  await page.getByLabel("Review note").fill("  Reviewed delivery evidence carefully.  ");
  await page.getByLabel("Evidence reference").fill("  x  ");
  await expect(submit).toBeDisabled();
  await page.getByLabel("Evidence reference").fill("  ticket-123  ");
  await submit.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Digest cannot be reconciled");
  await expect(page.getByLabel("Review note")).toHaveValue("  Reviewed delivery evidence carefully.  ");
  await expect(page.getByLabel("Evidence reference")).toHaveValue("  ticket-123  ");
  // Virtual time must not outrun the intercepted response body or reload it mid-read.
  for (let poll = 0; poll < 2; poll++) {
    const reads = f.reads().length;
    const response = page.waitForResponse(response => new URL(response.url()).pathname === `${root}/attention`);
    await page.clock.runFor(15_100);
    const completed = await response;
    expect(completed.status()).toBe(200);
    expect(await completed.finished()).toBeNull();
    await expect(page.locator('button[aria-label="Refresh digest attention"]')).toBeEnabled();
    expect(f.reads()).toHaveLength(reads + 1);
    expect(f.posts()).toHaveLength(1);
  }
  await page.clock.runFor(800);
  expect(f.posts()).toHaveLength(1);
  expect(f.posts()[0].body).toEqual({ outcome: "retry", note: "Reviewed delivery evidence carefully.", evidenceReference: "ticket-123", acknowledgeDuplicateRisk: true });
  await f.proof("conflict-inputs-retained");
  await page.reload();
  await page.getByRole("tab", { name: "Maintenance", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Digest recovery", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review digest #51", exact: true })).toBeVisible();
  expect(f.posts()).toHaveLength(1);
  await f.verify();
});

for (const width of [1440, 390]) test(`frozen plain text and responsive review at ${width}px; successful retry records no send claim`, async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const f = await fixture(page, baseURL!, info);
  f.model.jobs.push(attentionJob(52, "prepared"), attentionJob(53, "unrecognized"));
  await f.open();
  await expect(page.getByRole("button", { name: /Review digest #5[23]/ })).toHaveCount(0);
  await f.proof(`attention-${width}`);
  await f.review();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("pre")).toHaveText(frozenText);
  await expect(dialog.locator("img, script, iframe")).toHaveCount(0);
  expect(await page.evaluate(() => "digestInjected" in window)).toBe(false);
  await f.fields(); await page.getByRole("checkbox").check();
  await dialog.getByRole("heading").scrollIntoViewIfNeeded();
  await f.proof(`review-${width}`);
  if (width === 390) {
    await page.getByRole("button", { name: "Record reconciliation", exact: true }).scrollIntoViewIfNeeded();
    await f.proof("review-mobile-submit");
  }
  const reads = f.reads().length;
  await page.getByRole("button", { name: "Record reconciliation", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("A future attempt is authorized; no email delivery is confirmed");
  await expect.poll(() => f.reads().length).toBeGreaterThan(reads);
  expect(f.posts()).toHaveLength(1);
  await f.verify();
});

test("sent attestation requires explicit evidence; skipped result is never presented as recorded", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  f.model.postResult = { state: "skipped", reason: "Digest already finalized" };
  await f.open(); await f.review(); await f.fields("sent");
  await page.getByRole("button", { name: "Record reconciliation", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Reconciliation was not confirmed");
  expect(f.posts()).toHaveLength(1);
  f.model.postResult = { state: "sent", reason: "", reconciled: true, reconciliationOutcome: "sent" };
  await page.getByRole("button", { name: "Record reconciliation", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("not a provider-verified receipt");
  expect(f.posts()).toHaveLength(2);
  await f.verify();
});

test("15 second attention polling has no overlapping GET and never POSTs", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  await f.open();
  await expect(page.getByRole("button", { name: "Review digest #51" })).toBeVisible();
  f.model.delayAttention = true;
  await page.clock.runFor(15_100);
  await expect.poll(() => f.reads().length).toBe(2);
  await page.clock.runFor(5_000);
  expect(f.reads()).toHaveLength(2);
  await expect(page.getByRole("button", { name: "Refresh digest attention" })).toBeDisabled();
  f.model.delayAttention = false;
  f.release();
  await expect(page.getByRole("button", { name: "Refresh digest attention" })).toBeEnabled();
  expect(f.posts()).toHaveLength(0);
  await f.verify();
});

test("live dispatch and historical membership cannot reconcile; only expired dispatch offers review", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  f.model.jobs = [
    { ...attentionJob(51, "dispatching"), reason: "dispatch_in_progress" },
    { ...attentionJob(52, null), reason: "legacy_membership_unverified" },
    { ...attentionJob(53, "dispatching"), reason: "delivery_requires_reconciliation" },
  ];
  await f.open();
  await expect(page.getByText("Requires private migration review.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Review digest #5[12]/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review digest #53", exact: true })).toBeVisible();
  expect(f.posts()).toHaveLength(0);
  await f.proof("live-dispatch-and-legacy-restricted");
  await f.verify();
});

test("truncated preview warns and definitely unsent job cannot be attested as sent", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  f.model.truncated = true;
  f.model.jobs = [attentionJob(51, "not_sent")];
  await f.open(); await f.review();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Preview is incomplete");
  await page.getByRole("combobox", { name: "Outcome", exact: true }).click();
  await expect(page.getByRole("option", { name: "Sent confirmed", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(f.posts()).toHaveLength(0);
  await f.proof("truncated-preview-warning");
  await f.verify();
});

test("review GET failure remains visible and supports explicit reload without POST", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  f.model.detailStatus = 403;
  await f.open();
  await page.getByRole("button", { name: "Review digest #51", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Digest review is not permitted");
  await expect(page.getByRole("button", { name: "Record reconciliation", exact: true })).toHaveCount(0);
  f.model.detailStatus = 200;
  await page.getByRole("button", { name: "Reload review", exact: true }).click();
  await expect(page.getByText("frozen@example.invalid", { exact: true })).toBeVisible();
  expect(f.posts()).toHaveLength(0);
  await f.verify();
});

test("false or mismatched machine acknowledgement never claims reconciliation was recorded", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  await f.open(); await f.review(); await f.fields();
  await page.getByRole("checkbox").check();
  const submit = page.getByRole("button", { name: "Record reconciliation", exact: true });
  for (const result of [
    { state: "skipped", reason: "Same frozen batch authorized for retry; no send attempted" },
    { state: "skipped", reason: "", reconciled: false, reconciliationOutcome: "retry" },
    { state: "sent", reason: "", reconciled: true, reconciliationOutcome: "sent" },
  ]) {
    f.model.postResult = result;
    await submit.click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Reconciliation was not confirmed");
    await expect(page.getByRole("status")).toHaveCount(0);
  }
  await page.clock.runFor(31_000);
  expect(f.posts()).toHaveLength(3);
  await expect(page.getByLabel("Evidence reference")).toHaveValue("  ticket-123  ");
  await f.verify();
});

test("switching authenticated admins exposes neither prior attention nor frozen review data", async ({ page, baseURL }, info) => {
  const f = await fixture(page, baseURL!, info);
  await f.open(); await f.review();
  await expect(page.getByText("frozen@example.invalid", { exact: true })).toBeVisible();
  await page.clock.runFor(50_000);
  f.model.actorOpenId = "synthetic-other-admin";
  f.model.jobs = [{ ...attentionJob(), userOpenId: "synthetic-other-owned-worker" }];
  f.model.delayAttention = true;
  await page.clock.runFor(10_100);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Loading digest attention", { exact: true })).toBeVisible();
  await expect(page.getByText("synthetic-owned-worker", { exact: true })).toHaveCount(0);
  await expect(page.getByText("frozen@example.invalid", { exact: true })).toHaveCount(0);
  f.model.delayAttention = false;
  f.release();
  await expect(page.getByText("synthetic-other-owned-worker", { exact: true })).toBeVisible();
  f.model.delayDetail = true;
  await page.getByRole("button", { name: "Review digest #51", exact: true }).click();
  await expect(page.getByText("Loading frozen digest", { exact: true })).toBeVisible();
  await expect(page.getByText("frozen@example.invalid", { exact: true })).toHaveCount(0);
  f.model.delayDetail = false;
  f.releaseDetail();
  await expect(page.getByText("other-admin@example.invalid", { exact: true })).toBeVisible();
  expect(f.posts()).toHaveLength(0);
  await f.verify();
});
