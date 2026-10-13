import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { io } from "socket.io-client";
import { chromium } from "@playwright/test";
import superjson from "superjson";

// This utility is deliberately confined to the separately owned rehearsal network.
assert.equal(process.env.PRODUCTION_RUNTIME_FIXTURE, "isolated-owned");
const harnessHash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const mode = process.argv[2] || "verify";
assert(["verify", "seed", "restart-session", "cold-redis", "route-matrix"].includes(mode));
const oversightRecovery = process.env.PRODUCTION_RUNTIME_OVERSIGHT_RECOVERY === "true";
if (oversightRecovery) assert.equal(mode, "route-matrix");
const database = new URL(process.env.PRODUCTION_RUNTIME_DATABASE_URL || "");
assert.equal(database.protocol, "mysql:");
assert.equal(database.hostname, "va-runtime-mysql");
assert.equal(database.port, "3306");
assert.equal(database.pathname, "/recovery_test");
assert.equal(database.search + database.hash, "");
const base = "https://127.0.0.1:3443";
const upstreamHost = process.env.PRODUCTION_RUNTIME_UPSTREAM || "va-runtime-app";
assert(["va-runtime-app", "va-runtime-app-recovery", "va-runtime-app-cold-after"].includes(upstreamHost));
if (mode === "cold-redis") assert.equal(upstreamHost, "va-runtime-app-cold-after");
const peer = "http://va-runtime-app-recovery:3000";
const output = process.env.PRODUCTION_RUNTIME_REPORT_DIRECTORY || "artifacts/production-runtime-20261001";
assert.match(output, /^artifacts\/production-runtime-[a-zA-Z0-9-]+$/);
const password = "Runtime-rehearsal-fixture-only-2026!";
const accounts = [
  { id: 190001001, key: "admin", role: "admin" },
  { id: 190001002, key: "founder", role: "admin" },
  { id: 190001003, key: "worker", role: "worker" },
  { id: 190001004, key: "other-worker", role: "worker" },
  { id: 190001005, key: "pending", role: "user" },
];
const username = key => `production-runtime-fixture-${key}`;
const db = await mysql.createConnection(database.toString());

if (mode === "seed") {
  try {
    const [[count]] = await db.query("SELECT COUNT(*) AS total FROM users");
    assert.equal(Number(count.total), 0, "Only a fresh fixture database may be seeded");
    const [[ledger]] = await db.query("SELECT COUNT(*) AS total FROM __drizzle_migrations");
    assert.equal(Number(ledger.total), 54);
    await db.beginTransaction();
    const hash = await bcrypt.hash(password, 10);
    for (const account of accounts) await db.execute(
      "INSERT INTO users (id,openId,name,role,passwordHash,loginMethod) VALUES (?,?,?,?,?,'local')",
      [account.id, username(account.key), `Runtime ${account.key}`, account.role, hash]
    );
    for (const account of accounts.filter(account => account.role === "worker")) await db.execute(
      "INSERT INTO va_profiles (id,userId,founderId,name,timezone,status) VALUES (?,?,?,?,?,'active')",
      [account.id, account.id, 190001002, `Runtime ${account.key}`, "UTC"]
    );
    for (const key of ["google_evidence", "trello_commitments", "communication_evidence", "eod_compliance", "weekly_analysis", "aptlss_queue", "webhook_sync", "database_preload"])
      await db.execute("INSERT INTO maintenance_job_settings (jobKey,enabled,intervalMinutes) VALUES (?,false,60)", [key]);
    await db.commit();
    console.log(JSON.stringify({ seeded: true, accounts: accounts.length, maintenanceDisabled: true }));
  } catch (error) { await db.rollback(); throw error; }
  finally { await db.end(); }
  process.exit(0);
}

const [[inventory]] = await db.query("SELECT COUNT(*) AS total FROM users WHERE openId LIKE 'production-runtime-fixture-%'");
const [[allUsers]] = await db.query("SELECT COUNT(*) AS total FROM users");
assert.equal(Number(inventory.total), accounts.length);
assert.equal(Number(allUsers.total), accounts.length, "Refusing unowned accounts");
mkdirSync(output, { recursive: true });
const matrixOutput = `${output}/route-matrix`;
// A matrix run owns a fresh directory; never replace another run's evidence.
if (mode === "route-matrix") mkdirSync(matrixOutput);
const checks = [];
const sockets = new Set();
const proxyConnections = new Set();
let coldRecovery;
let browser;
let routeMatrix;
const proxy = createServer({
  key: readFileSync(".local/production-runtime-rehearsal/server.key"),
  cert: readFileSync(".local/production-runtime-rehearsal/server.crt"),
}, (req, res) => {
  const upstream = httpRequest({ hostname: upstreamHost, port: 3000, path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-proto": "https" } }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end("Isolated upstream unavailable"); });
  req.pipe(upstream);
});
proxy.on("connection", socket => {
  proxyConnections.add(socket);
  socket.once("close", () => proxyConnections.delete(socket));
});
proxy.on("upgrade", (req, socket, head) => {
  const upstream = httpRequest({ hostname: upstreamHost, port: 3000, path: req.url,
    headers: { ...req.headers, "x-forwarded-proto": "https" } });
  upstream.on("upgrade", (response, backend, backendHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
      Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n\r\n");
    if (head.length) backend.write(head);
    if (backendHead.length) socket.write(backendHead);
    backend.pipe(socket); socket.pipe(backend);
    socket.on("close", () => backend.destroy());
    backend.on("close", () => socket.destroy());
    socket.on("error", () => backend.destroy());
    backend.on("error", () => socket.destroy());
  });
  upstream.on("error", () => socket.destroy());
  upstream.on("response", response => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
      Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n\r\n");
    response.pipe(socket);
  });
  upstream.end();
});

function request(path, { cookie, origin = base, method = "GET", body } = {}, address = base) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (address === base ? httpsRequest : httpRequest)(address + path, { rejectUnauthorized: false, method,
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json; try { json = JSON.parse(text); } catch { /* Static assets are not JSON. */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("Fixture request deadline exceeded")));
    req.on("error", reject);
    req.end(payload);
  });
}
function data(response) { return superjson.deserialize(response.json.result.data); }
async function check(name, operation) {
  try { await operation(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}
function connect(cookie, origin = base, address = base) {
  return new Promise(resolve => {
    const socket = io(address, { path: "/ws", transports: ["websocket"], rejectUnauthorized: false,
      extraHeaders: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      timeout: 6000, reconnection: false, forceNew: true });
    sockets.add(socket);
    const deadline = setTimeout(() => { socket.disconnect(); resolve({ accepted: false, reason: "deadline" }); }, 7000);
    socket.once("authenticated", () => { clearTimeout(deadline); resolve({ accepted: true, socket }); });
    socket.once("connect_error", error => { clearTimeout(deadline); socket.disconnect(); resolve({ accepted: false, reason: error.message }); });
  });
}

// These expectations follow App.tsx and the restored page components, not the
// shared shell. Admin uses the empty admin account, never the populated founder.
const matrixRoutes = [
  { key: "admin", path: "/", heading: "Workload Timeline", level: 2, ui: ["button", "View Weekly Schedule"] },
  { key: "admin", path: "/founder", heading: "Virtual Worker Management", ui: ["heading", "No Virtual Workers Yet"] },
  { key: "admin", path: "/aptlss", heading: "APTLSS Management", ui: ["tab", "Workspaces"] },
  { key: "admin", path: "/settings", heading: "Settings", ui: ["tab", "Integration & Automation"] },
  { key: "admin", path: "/calendar", heading: "Calendar", ui: ["button", "Month"] },
  { key: "admin", path: "/advanced-scheduling", heading: "Advanced Scheduling", ui: ["tab", "Batch Queue"] },
  { key: "admin", path: "/atis-phases", heading: "ATIS Phases Analysis", ui: ["button", "Start Analysis"] },
  { key: "admin", path: "/robert", heading: "Admin Oversight Dashboard", ui: ["text", "Decisions, risks, and exceptions requiring your attention"] },
  { key: "admin", path: "/command-center", heading: "Priority Command Center", ui: ["heading", "All Clear"] },
  { key: "admin", path: "/admin", heading: "Admin Monitor", ui: ["heading", "Sync Health (Last 24h)"] },
  { key: "worker", path: "/worker", heading: "Today", ui: ["button", "Toggle theme"] },
  { key: "worker", path: "/worker/plan", heading: "Plan My Day", ui: ["text", /^(Agenda changes are paused|No saved plan|Plan could not be loaded|Plan access could not be checked)$/] },
  { key: "worker", path: "/worker/decisions", heading: "Decisions", ui: ["text", "Awaiting founder"] },
  { key: "worker", path: "/worker/evidence", heading: "Evidence", ui: ["text", "Connected sources"] },
  { key: "worker", path: "/worker/reminders", heading: "Reminders", ui: ["button", "Refresh reminders"] },
  { key: "worker", path: "/worker/settings", heading: "Settings", ui: ["text", "Browser organization"] },
];
const matrixViewports = [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }];
const matrixThemes = ["dark", "light"];

function matrixDiagnostics() {
  return { pageErrors: 0, consoleErrorCount: 0, consoleWarningCount: 0, externalRequests: 0, blockedRedirects: 0, blockedMutations: 0, assetErrors: 0, apiErrors: [], apiErrorCount: 0, completedApiRequests: 0 };
}
function matrixApiError(evidence, path, kind, status) {
  evidence.apiErrorCount++;
  // Do not persist response bodies, query strings, credentials, or browser logs.
  if (evidence.apiErrors.length < 50) evidence.apiErrors.push({ path, kind, ...(status === undefined ? {} : { status }) });
}
function observeMatrixPage(page, evidence) {
  const pending = new Set(), inspections = new Set();
  page.on("pageerror", () => evidence.pageErrors++);
  page.on("console", message => {
    // Count diagnostics without persisting possibly private console payloads.
    if (message.type() === "error") evidence.consoleErrorCount++;
    if (message.type() === "warning") evidence.consoleWarningCount++;
  });
  page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/")) pending.add(req); });
  page.on("requestfinished", req => {
    if (pending.delete(req)) evidence.completedApiRequests++;
  });
  page.on("requestfailed", req => {
    pending.delete(req);
    const address = new URL(req.url());
    if (address.origin !== base) return; // Already recorded by the fail-closed guard.
    if (address.pathname.startsWith("/api/")) matrixApiError(evidence, address.pathname, "request-failed");
    else if (req.resourceType() !== "document") evidence.assetErrors++;
  });
  page.on("response", response => {
    const address = new URL(response.url());
    if (address.origin !== base) return;
    if (!address.pathname.startsWith("/api/")) {
      if (response.status() >= 400 && response.request().resourceType() !== "document") evidence.assetErrors++;
      return;
    }
    const inspection = (async () => {
      if (response.status() >= 400) matrixApiError(evidence, address.pathname, "http-error", response.status());
      else if ((response.headers()["content-type"] || "").includes("application/json")) {
        const body = await response.json();
        for (const item of Array.isArray(body) ? body : [body]) {
          const payload = item?.result?.data ? superjson.deserialize(item.result.data) : item;
          if (item?.error || payload?.error || payload?.success === false)
            matrixApiError(evidence, address.pathname, "application-error", response.status());
        }
      }
    })().catch(() => matrixApiError(evidence, address.pathname, "unreadable-response", response.status()));
    inspections.add(inspection);
    void inspection.finally(() => inspections.delete(inspection));
  });
  return async () => {
    const deadline = Date.now() + 35000;
    // A finite observation window also covers deferred effects; do not wait for
    // networkidle on pages with polling and authenticated WebSockets.
    await page.waitForTimeout(1000);
    while ((pending.size || inspections.size) && Date.now() < deadline) await page.waitForTimeout(100);
    if (pending.size || inspections.size) {
      evidence.pendingApiPaths = [...new Set([...pending].map(req => new URL(req.url()).pathname))];
      matrixApiError(evidence, "/api/", "observation-deadline");
    }
  };
}
function renderedMatrixTheme() {
  const root = getComputedStyle(document.documentElement), body = getComputedStyle(document.body);
  return { selected: localStorage.getItem("theme"), dark: document.documentElement.classList.contains("dark"),
    backgroundToken: root.getPropertyValue("--background").trim(), bodyBackground: body.backgroundColor, bodyColor: body.color };
}
async function matrixIdentity(context, key) {
  const response = await context.request.get(`${base}/api/trpc/auth.me`, { timeout: 5000, maxRedirects: 0 });
  assert.equal(response.status(), 200);
  const user = data({ json: await response.json() }), account = accounts.find(item => item.key === key);
  assert.equal(user.id, account.id); assert.equal(user.role, account.role);
  return { id: account.id, role: account.role };
}
async function runRouteMatrix() {
  routeMatrix = { name: "restored-routes-owned-fixture-v4", expectedCases: 64, adminCases: 40, workerCases: 24,
    limits: { totalBrowserMs: 1200000, navigationMs: 35000, actionMs: 5000, apiObservationMs: 35000, apiErrorsPerRecord: 50 },
    themeSelection: "worker UI toggle, then clear cookies and sign in as admin for admin cases; no DOM or storage theme injection",
    scope: "isolated empty-admin and missing-work-sources worker UI only; no provider acceptance, model prompts, or execution", setups: [] };
  for (const route of matrixRoutes) for (const viewport of matrixViewports) for (const theme of matrixThemes) checks.push({
    name: `route-matrix ${route.key} ${route.path} ${viewport.name} ${theme}`,
    caseId: `${route.key}-${route.path === "/" ? "home" : route.path.slice(1).replaceAll("/", "-")}-${viewport.name}-${theme}`,
    key: route.key, path: route.path, viewport, theme, passed: false, status: "not-run",
  });
  const selection = process.env.PRODUCTION_RUNTIME_MATRIX_CASES;
  if (selection !== undefined) {
    const ids = JSON.parse(selection);
    assert(Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string"));
    assert.equal(new Set(ids).size, ids.length);
    assert(ids.every(id => checks.some(item => item.caseId === id)), "Unknown matrix case");
    const selected = checks.filter(item => ids.includes(item.caseId));
    checks.splice(0, checks.length, ...selected);
    routeMatrix.selectedCases = ids;
  }
  routeMatrix.fullMatrix = checks.length === 64;
  routeMatrix.expectedCases = checks.length;
  routeMatrix.adminCases = checks.filter(item => item.key === "admin").length;
  routeMatrix.workerCases = checks.filter(item => item.key === "worker").length;
  if (oversightRecovery) {
    assert(checks.every(item => item.key === "admin" && item.path === "/robert"), "Fault injection is confined to oversight recovery cases");
    routeMatrix.oversightRecovery = "controlled GET failure, then retry against the real isolated backend";
  }
  const deadline = Date.now() + routeMatrix.limits.totalBrowserMs;
  const watchdog = setTimeout(() => { void browser?.close().catch(() => {}); }, routeMatrix.limits.totalBrowserMs);
  try {
    browser = await chromium.launch({ headless: true, timeout: 30000 });
    for (const key of ["admin", "worker"]) for (const viewport of matrixViewports) for (const theme of matrixThemes) {
      const cases = checks.filter(item => item.key === key && item.viewport.name === viewport.name && item.theme === theme);
      if (!cases.length) continue;
      const setup = { key, viewport: viewport.name, theme, ...matrixDiagnostics(), passed: false };
      routeMatrix.setups.push(setup);
      let context, currentEvidence = setup, loginAllowed = false, injectOversightFailure = false, stage = "context";
      try {
        assert(Date.now() < deadline, "Matrix deadline exhausted");
        context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme, serviceWorkers: "block" });
        context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(35000);
        await context.route("**/*", async route => {
          const req = route.request(), address = new URL(req.url());
          if (address.origin !== base || (req.isNavigationRequest() && !matrixRoutes.some(item => item.path === address.pathname))) {
            currentEvidence.externalRequests++; await route.abort("blockedbyclient"); return;
          }
          if (!["GET", "HEAD"].includes(req.method()) && !(loginAllowed && req.method() === "POST" && address.pathname === "/api/auth/login")) {
            currentEvidence.blockedMutations++; await route.abort("blockedbyclient"); return;
          }
          if (injectOversightFailure && address.pathname.startsWith("/api/trpc/")
            && address.pathname.slice("/api/trpc/".length).split(",").includes("aptlss.getRisksAndExceptions")) {
            await route.abort("failed"); return;
          }
          // HTTP routing may only see the first request in a redirect chain.
          // Refuse redirects before the browser can follow an unguarded target.
          try {
            const response = await route.fetch({ maxRedirects: 0, timeout: address.pathname.startsWith("/api/") ? 35000 : 15000 });
            if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
              currentEvidence.blockedRedirects++; await route.abort("blockedbyclient"); return;
            }
            await route.fulfill({ response });
          } catch { await route.abort("failed").catch(() => {}); }
        });
        // Intercept before connecting, including WebSockets which HTTP routing
        // does not cover. Only the fixed local fixture may receive traffic.
        assert.equal(typeof context.routeWebSocket, "function", "WebSocket routing support is required");
        await context.routeWebSocket("**", socket => {
          if (new URL(socket.url()).origin !== base.replace("https:", "wss:")) {
            currentEvidence.externalRequests++; socket.close(); return;
          }
          socket.connectToServer();
        });
        const page = await context.newPage(), settle = observeMatrixPage(page, setup);
        const signIn = async accountKey => {
          await page.goto(`${base}/worker`, { waitUntil: "domcontentloaded" });
          await page.getByLabel("Username", { exact: true }).fill(username(accountKey));
          await page.getByLabel("Password", { exact: true }).fill(password);
          loginAllowed = true;
          try {
            const login = page.waitForResponse(response => response.url() === `${base}/api/auth/login` && response.request().method() === "POST");
            await page.getByRole("button", { name: "Sign in", exact: true }).click();
            const response = await login;
            assert.equal(await response.finished(), null); assert.equal(response.status(), 200);
            assert.equal((await response.json()).success, true);
            // The login form schedules a redirect after 500ms. Observe it before
            // navigating again so it cannot overwrite a matrix route.
            await page.waitForURL(key === "admin" && accountKey === "admin" ? `${base}/` : `${base}/worker`, { timeout: 15000 });
            await page.getByLabel("Username", { exact: true }).waitFor({ state: "hidden" });
            await matrixIdentity(context, accountKey);
          } finally { loginAllowed = false; }
        };
        stage = "worker-login-and-theme";
        await signIn("worker");
        await page.getByRole("heading", { name: "Today", exact: true, level: 1 }).waitFor();
        const initial = await page.evaluate(renderedMatrixTheme);
        const toggle = page.getByRole("button", { name: "Toggle theme", exact: true });
        const opposite = initial.dark ? "light" : "dark";
        await toggle.click();
        await page.waitForFunction(value => localStorage.getItem("theme") === value && document.documentElement.classList.contains("dark") === (value === "dark"), opposite);
        const switched = await page.evaluate(renderedMatrixTheme);
        assert.notEqual(initial.bodyBackground, switched.bodyBackground);
        assert.notEqual(initial.bodyColor, switched.bodyColor);
        if (opposite !== theme) {
          await toggle.click();
          await page.waitForFunction(value => localStorage.getItem("theme") === value && document.documentElement.classList.contains("dark") === (value === "dark"), theme);
        }
        setup.themeProof = await page.evaluate(renderedMatrixTheme);
        assert.equal(setup.themeProof.selected, theme); assert.equal(setup.themeProof.dark, theme === "dark");
        assert(setup.themeProof.backgroundToken); assert.notEqual(setup.themeProof.bodyBackground, "rgba(0, 0, 0, 0)");
        if (key === "admin") {
          stage = "admin-login-and-empty-workspace";
          await settle();
          await page.goto("about:blank");
          await context.clearCookies(); // Preserve only the UI-selected theme, not the worker session.
          await signIn("admin");
          const workers = await context.request.get(`${base}/api/va/vas`, { timeout: 5000, maxRedirects: 0 });
          assert.equal(workers.status(), 200); assert.deepEqual(await workers.json(), []);
        }
        setup.identity = await matrixIdentity(context, key);
        await settle(); await page.close();
        assert.equal(setup.pageErrors + setup.externalRequests + setup.blockedRedirects + setup.blockedMutations + setup.assetErrors, 0);
        setup.passed = true;
        for (const item of cases) {
          currentEvidence = item;
          Object.assign(item, matrixDiagnostics());
          let routePage, caseStage = "navigation";
          try {
            assert(Date.now() < deadline, "Matrix deadline exhausted");
            routePage = await context.newPage();
            const observe = observeMatrixPage(routePage, item);
            injectOversightFailure = oversightRecovery;
            const response = await routePage.goto(base + item.path, { waitUntil: "domcontentloaded" });
            assert(response); item.navigationStatus = response.status(); assert.equal(item.navigationStatus, 200);
            caseStage = "role-and-route";
            item.identity = await matrixIdentity(context, key);
            const route = matrixRoutes.find(route => route.path === item.path && route.key === key);
            caseStage = "page-header";
            const heading = routePage.getByRole("heading", { name: route.heading, exact: true, level: route.level || 1 });
            await heading.waitFor({ timeout: 35000 }); assert(await heading.isVisible());
            caseStage = "settled-api";
            await observe();
            caseStage = "route-specific-ui";
            const sourcePath = item.path === "/" ? "/api/atis/timeline-tasks" : item.path === "/calendar" ? "/api/trello/tasks" : null;
            const sourceFailed = sourcePath && item.apiErrors.some(error => error.path === sourcePath);
            const recoveryHeading = item.path === "/" ? "Work queue unavailable" : "Calendar unavailable";
            const ui = sourceFailed
              ? routePage.getByRole("heading", { name: recoveryHeading, exact: true })
              : route.ui[0] === "text" ? routePage.getByText(route.ui[1], { exact: true }) : routePage.getByRole(route.ui[0], { name: route.ui[1], exact: true });
            await ui.first().waitFor({ timeout: 35000 }); assert(await ui.first().isVisible());
            item.expectedHeading = route.heading; item.expectedUI = sourceFailed ? recoveryHeading : String(route.ui[1]);
            caseStage = "settled-render";
            if (item.path === "/robert") {
              if (oversightRecovery) {
                const unavailable = routePage.getByRole("alert").filter({ has: routePage.getByText("Risks and exceptions unavailable", { exact: true }) });
                await unavailable.waitFor({ timeout: 35000 });
                assert.equal(await routePage.getByText("No risks or exceptions returned", { exact: true }).count(), 0);
                const retry = unavailable.getByRole("button", { name: "Retry risks and exceptions", exact: true });
                assert(await retry.isEnabled());
                item.failureScreenshot = `${matrixOutput}/${item.caseId}-unavailable.png`;
                await routePage.screenshot({ path: item.failureScreenshot, fullPage: true, timeout: 5000 });
                injectOversightFailure = false;
                await retry.click();
                await routePage.getByText("No risks or exceptions returned", { exact: true }).waitFor({ timeout: 35000 });
                await unavailable.waitFor({ state: "hidden", timeout: 35000 });
                await observe();
                const refresh = routePage.getByRole("button", { name: "Refresh", exact: true });
                assert(await refresh.isEnabled());
                await refresh.click(); await observe();
                assert.equal(await routePage.getByRole("alert").count(), 0);
                item.recovery = { initialFailureVisible: true, emptySuccessSuppressed: true,
                  retryClicked: true, realBackendRecovered: true, allQueriesRefreshed: true };
              }
              await routePage.getByText("No risks or exceptions returned", { exact: true }).waitFor({ timeout: 35000 });
              assert(await routePage.getByText("Source coverage and live work status are not confirmed by this result.", { exact: true }).isVisible());
              assert.equal(await routePage.getByText(/working autonomously|all work can proceed|all active work is progressing|answered all questions/i).count(), 0);
              item.oversightPresentation = { status: "empty-stored-snapshot", operationalClearanceClaimed: false };
            }
            // A visible header is not proof that the initial data view finished.
            if (sourceFailed) {
              const alert = routePage.getByRole("alert").filter({ has: routePage.getByRole("heading", { name: recoveryHeading, exact: true }) });
              assert.equal(await alert.count(), 1);
              const retry = alert.getByRole("button", { name: "Try again", exact: true });
              assert(await retry.isVisible()); assert(await retry.isEnabled());
              assert.equal(await routePage.getByRole("heading", { name: "No tasks scheduled", exact: true }).count(), 0);
              if (item.path === "/calendar") assert.equal(await routePage.getByRole("button", { name: "Month", exact: true }).count(), 0);
              item.sourcePresentation = { status: "unavailable", path: sourcePath, persistentAlert: true, retryAvailable: true, emptySuccessSuppressed: true };
            } else if (item.path === "/") {
              await routePage.getByRole("heading", { name: "No tasks scheduled", exact: true }).waitFor({ timeout: 35000 });
            }
            const skeletons = routePage.locator('[data-slot="skeleton"]');
            for (const skeleton of await skeletons.all()) assert.equal(await skeleton.isVisible(), false);
            if (item.path === "/admin") {
              const webhookUnknown = routePage.getByText(/^(Webhook status unavailable\. Trello could not be checked; activity and registered count are unknown\.|Trello credentials not configured\. Webhook health has not been checked\.)$/);
              assert(await webhookUnknown.isVisible());
              assert.equal(await routePage.getByText("Inactive", { exact: true }).count(), 0);
              assert.equal(await routePage.getByText("0 webhooks registered", { exact: true }).count(), 0);
              item.webhookPresentation = { status: "unknown-in-network-isolated-fixture", falseInactiveSuppressed: true };
            }
            item.contentSettled = true;
            assert.equal(routePage.url(), base + item.path);
            assert.equal(await routePage.getByLabel("Username", { exact: true }).isVisible(), false);
            assert.equal(await routePage.getByRole("heading", { name: /^(404|Page Not Found|Access Restricted|Access Pending|Dashboard temporarily unavailable|Something went wrong)$/i }).count(), 0);
            item.renderedTheme = await routePage.evaluate(renderedMatrixTheme);
            assert.deepEqual(item.renderedTheme, setup.themeProof);
            item.layout = await routePage.evaluate(() => ({ viewport: document.documentElement.clientWidth,
              document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
            assert(item.layout.document <= item.layout.viewport + 1 && item.layout.body <= item.layout.viewport + 1);
            if (item.path === "/worker") {
              caseStage = "missing-sources-execution-hold";
              const hold = routePage.getByText(/^(No task is recommended yet|No trusted work item yet|Wait before starting a task)$/);
              await hold.first().waitFor();
              const timers = routePage.getByRole("button", { name: /^Start timer$/ });
              for (const timer of await timers.all()) assert.equal(await timer.isEnabled(), false);
              item.execution = { status: "blocked-missing-work-sources", observedHold: await hold.first().innerText(), executed: false };
            }
            caseStage = "screenshot";
            item.screenshot = `${matrixOutput}/${item.caseId}.png`;
            await routePage.screenshot({ path: item.screenshot, fullPage: true, timeout: 5000 });
            caseStage = "browser-safeguards";
            assert.equal(item.pageErrors + item.externalRequests + item.blockedRedirects + item.blockedMutations + item.assetErrors, 0);
            item.passed = true; item.status = item.apiErrorCount || setup.apiErrorCount ? "degraded" : "passed";
          } catch {
            item.error = `Matrix assertion failed at ${caseStage}`; item.status = "failed";
            if (routePage && !routePage.isClosed()) {
              item.observedHeadings = await routePage.getByRole("heading").allTextContents().catch(() => []);
              item.layout = await routePage.evaluate(() => ({ viewport: document.documentElement.clientWidth,
                document: document.documentElement.scrollWidth, body: document.body.scrollWidth })).catch(() => null);
              const failurePath = `${matrixOutput}/${item.caseId}-failed.png`;
              try { await routePage.screenshot({ path: failurePath, fullPage: true, timeout: 5000 }); item.screenshot = failurePath; }
              catch { item.screenshotUnavailable = true; }
            }
          }
          finally {
            try { await routePage?.close(); }
            catch { item.passed = false; item.status = "failed"; item.error = "Matrix page cleanup failed"; }
          }
        }
      } catch {
        setup.error = `Matrix setup failed at ${stage}`;
        for (const item of cases.filter(item => item.status === "not-run")) { item.status = "failed"; item.error = setup.error; }
      } finally {
        try { await context?.close(); }
        catch { setup.passed = false; setup.error = "Matrix context cleanup failed"; }
      }
    }
  } finally { clearTimeout(watchdog); }
}

try {
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(3443, "127.0.0.1", resolve); });
  if (mode === "route-matrix") {
    await runRouteMatrix();
  } else {
  if (mode === "cold-redis") {
    let same, other, before;
    await check("cold startup remains live but not ready without configured Redis", async () => {
      const deadline = Date.now() + 45000;
      let response;
      do {
        response = await request("/api/health/live");
        if (response.status === 200 && response.json?.alive === true) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      assert.equal(response.status, 200); assert.equal(response.json.alive, true);
      before = await request("/api/health");
      assert.equal(before.status, 503);
      assert.equal(before.json.database, "connected"); assert.equal(before.json.redis, "disconnected");
      const ready = await request("/api/health/ready");
      assert.equal(ready.status, 503); assert.equal(ready.json.ready, false);
    });
    if (!checks.at(-1).passed) throw new Error("Cold-start dependency state was not observed");
    let workerCookie;
    await check("worker sockets authenticate before Redis becomes available", async () => {
      for (const key of ["worker", "other-worker"]) {
        const response = await request("/api/auth/login", { method: "POST", body: { username: username(key), password } });
        assert.equal(response.status, 200); assert.equal(response.json.success, true);
        const cookie = response.headers["set-cookie"][0].split(";")[0];
        const connection = await connect(cookie);
        assert.equal(connection.accepted, true);
        if (key === "worker") { same = connection; workerCookie = cookie; }
        else other = connection;
      }
    });
    if (!checks.at(-1).passed) throw new Error("Pre-recovery worker sockets were not established");
    await check("cold-start local worker delivery remains scoped while Redis is unavailable", async () => {
      const sender = await connect(workerCookie);
      assert.equal(sender.accepted, true);
      let leaked = false, eventDeadline;
      const observeOther = () => { leaked = true; };
      other.socket.on("task:completed", observeOther);
      const received = new Promise((resolve, reject) => {
        eventDeadline = setTimeout(() => reject(new Error("Offline local event deadline exceeded")), 5000);
        same.socket.once("task:completed", resolve);
      });
      try {
        sender.socket.emit("task:complete", { taskId: "offline-local-fixture-only", workerId: 190001004 });
        assert.equal((await received).taskId, "offline-local-fixture-only");
        await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(leaked, false);
      } finally {
        clearTimeout(eventDeadline); sender.socket.disconnect(); other.socket.off("task:completed", observeOther);
      }
    });
    if (!checks.at(-1).passed) throw new Error("Offline local delivery was not verified");
    const socketId = same.socket.id;
    let disconnected = false;
    same.socket.once("disconnect", () => { disconnected = true; });
    await check("cold-start app recovers without restarting or replacing existing sockets", async () => {
      const started = Date.now(), deadline = started + 90000;
      console.log(JSON.stringify({ checkpoint: "sockets-ready-for-owned-redis-start" }));
      let recovered;
      do {
        const ready = await request("/api/health/ready");
        if (ready.status === 200 && ready.json?.ready === true) { recovered = await request("/api/health"); break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert(recovered, "Configured Redis did not recover within 90 seconds");
      assert.equal(recovered.status, 200); assert.equal(recovered.json.redis, "connected");
      assert(recovered.json.uptime >= before.json.uptime, "Application restarted during dependency recovery");
      assert.equal(same.socket.connected, true); assert.equal(same.socket.id, socketId); assert.equal(disconnected, false);
      coldRecovery = { checkpointToReadyMs: Date.now() - started, uptimeBefore: before.json.uptime,
        uptimeAfter: recovered.json.uptime, sameSocketRetained: true };
    });
    if (!checks.at(-1).passed) throw new Error("Cross-process acceptance stopped after recovery failure");
    await check("the independent Redis publisher process is ready before cross-process delivery", async () => {
      const deadline = Date.now() + 45000;
      do {
        const health = await request("/api/health", {}, peer);
        if (health.status === 200 && health.json?.redis === "connected") return;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      throw new Error("Independent publisher did not recover");
    });
    if (!checks.at(-1).passed) throw new Error("Cross-process acceptance stopped after publisher failure");
    await check("restored Redis delivers cross-process events to pre-existing worker sockets without leakage", async () => {
      const sender = await connect(workerCookie, base, peer);
      assert.equal(sender.accepted, true);
      let leaked = false, messages = 0, eventDeadline;
      other.socket.on("task:completed", () => { leaked = true; });
      const received = new Promise((resolve, reject) => {
        eventDeadline = setTimeout(() => reject(new Error("Cross-process event deadline exceeded")), 5000);
        same.socket.on("task:completed", message => { messages++; resolve(message); });
      });
      try {
        sender.socket.emit("task:complete", { taskId: "cold-recovery-fixture-only", workerId: 190001004 });
        assert.equal((await received).taskId, "cold-recovery-fixture-only");
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(messages, 1); assert.equal(leaked, false); assert.equal(disconnected, false);
      } finally { clearTimeout(eventDeadline); sender.socket.disconnect(); }
    });
    same.socket.disconnect(); other.socket.disconnect();
  }
  await check("production startup reaches readiness within 45 seconds", async () => {
    const deadline = Date.now() + 45000;
    do {
      const response = await request("/api/health/ready");
      if (response.status === 200 && response.json?.ready === true) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw new Error("Production startup did not reach readiness");
  });
  if (!checks[0].passed) throw new Error("Dependent acceptance stopped after startup failure");
  await check("production health with MySQL and authenticated Redis", async () => {
    const response = await request("/api/health");
    assert.equal(response.status, 200); assert.equal(response.json.status, "healthy");
    assert.equal(response.json.database, "connected"); assert.equal(response.json.redis, "connected");
    assert.equal((await request("/api/health/ready")).json.ready, true);
  });
  await check("strict CSP and HTTPS headers", async () => {
    const response = await request("/"); assert.equal(response.status, 200);
    const csp = response.headers["content-security-policy"];
    assert.match(csp, /script-src 'self'(?:;|$)/); assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.match(response.headers["strict-transport-security"], /max-age=31536000/);
  });
  await check("anonymous protected API rejection", async () => {
    assert.equal(data(await request("/api/trpc/auth.me")), null);
    assert.equal((await request("/api/va/vas")).status, 401);
    assert.equal((await request("/api/trpc/operator.getContext")).status, 401);
  });
  const cookies = {};
  for (const account of accounts) await check(`password session and cookie: ${account.key}`, async () => {
    const response = await request("/api/auth/login", { method: "POST", body: { username: username(account.key), password } });
    assert.equal(response.status, 200); assert.equal(response.json.success, true);
    const header = response.headers["set-cookie"][0];
    assert.match(header, /; Secure/); assert.match(header, /; HttpOnly/); assert.match(header, /; SameSite=Lax/);
    cookies[account.key] = header.split(";")[0];
    const user = data(await request("/api/trpc/auth.me", { cookie: cookies[account.key] }));
    assert.equal(user.id, account.id); assert.equal(user.role, account.role);
  });
  if (mode === "restart-session") await check("an existing signed session survives an observed application restart", async () => {
    const before = await request("/api/health");
    assert.equal(before.status, 200);
    assert(cookies.worker, "Worker login must succeed before the restart");
    console.log(JSON.stringify({ checkpoint: "session-ready-for-owned-restart" }));
    const deadline = Date.now() + 90000;
    let unavailable = false, recovered = false;
    do {
      let ready;
      try { ready = await request("/api/health/ready"); }
      catch { ready = { status: 0 }; }
      if (ready.status !== 200) unavailable = true;
      if (unavailable && ready.status === 200 && ready.json?.ready === true) {
        const health = await request("/api/health");
        assert(health.json.uptime < before.json.uptime, "An outage alone is not restart evidence");
        recovered = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    assert(unavailable && recovered, "No complete owned restart observed within the deadline");
    const response = await request("/api/trpc/auth.me", { cookie: cookies.worker });
    assert.equal(response.status, 200);
    assert.equal(data(response).id, 190001003);
    assert.equal(data(response).role, "worker");
  });
  await check("worker identity is bound to its own profile", async () => {
    for (const key of ["worker", "other-worker"]) {
      const response = await request("/api/trpc/operator.getContext", { cookie: cookies[key] });
      assert.equal(response.status, 200); assert.equal(data(response).userId, accounts.find(account => account.key === key).id);
    }
  });
  await check("worker and pending account cannot read administrative APIs", async () => {
    for (const key of ["worker", "pending"]) {
      assert.equal((await request("/api/va/vas", { cookie: cookies[key] })).status, 403);
      assert.equal((await request("/api/trpc/operator.getManagerReviewInbox", { cookie: cookies[key] })).status, 403);
    }
  });
  await check("founder workspace isolation between separate admin-role accounts", async () => {
    const own = await request("/api/va/vas", { cookie: cookies.founder });
    const other = await request("/api/va/vas", { cookie: cookies.admin });
    assert.equal(own.status, 200); assert.equal(other.status, 200);
    assert.equal(own.json.length, 2); assert.equal(other.json.length, 0);
  });
  await check("cross-site cookie mutation is rejected", async () => {
    const response = await request("/api/trpc/auth.logout", { cookie: cookies.worker, origin: "https://untrusted.invalid", method: "POST", body: { json: null } });
    assert.equal(response.status, 403);
    assert.equal(data(await request("/api/trpc/auth.me", { cookie: cookies.worker })).id, 190001003);
  });
  await check("anonymous WebSocket is rejected", async () => {
    const result = await connect(); assert.equal(result.accepted, false);
    assert.equal(result.reason, "Authentication required");
  });
  await check("trusted authenticated WebSocket connects", async () => {
    const result = await connect(cookies.worker); assert.equal(result.accepted, true); result.socket.disconnect();
  });
  await check("untrusted WebSocket origin is rejected with a valid session", async () => {
    const result = await connect(cookies.worker, "https://untrusted.invalid");
    if (result.accepted) result.socket.disconnect();
    assert.equal(result.accepted, false); assert.equal(result.reason, "websocket error");
  });
  await check("worker broadcasts stay inside the authenticated worker room", async () => {
    const sender = await connect(cookies.worker), same = await connect(cookies.worker), other = await connect(cookies["other-worker"]);
    assert(sender.accepted && same.accepted && other.accepted);
    let leaked = false; other.socket.on("task:completed", () => { leaked = true; });
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Same-worker event deadline exceeded")), 3000);
      same.socket.once("task:completed", message => { clearTimeout(timer); resolve(message); });
    });
    sender.socket.emit("task:complete", { taskId: "fixture-only", workerId: 190001004 });
    assert.equal((await received).taskId, "fixture-only");
    await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(leaked, false);
    for (const connection of [sender, same, other]) connection.socket.disconnect();
  });
  browser = await chromium.launch({ headless: true });
  for (const scenario of [
    { key: "worker", path: "/worker", heading: "Today", width: 1440 },
    { key: "worker", path: "/worker", heading: "Today", width: 390 },
    { key: "founder", path: "/founder", heading: "Virtual Worker Management", width: 1440 },
    { key: "admin", path: "/admin", heading: "Admin Monitor", width: 1440 },
  ]) await check(`compiled HTTPS browser: ${scenario.key} ${scenario.width}px`, async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: scenario.width, height: 900 } });
    try {
      const page = await context.newPage(), errors = [];
      page.on("pageerror", () => errors.push("unhandled browser exception"));
      page.on("request", req => {
        const address = new URL(req.url());
        if (/^https?:$/.test(address.protocol) && address.origin !== base) errors.push("unexpected external browser request");
      });
      await page.goto(base + scenario.path);
      await page.getByLabel("Username", { exact: true }).fill(username(scenario.key));
      await page.getByLabel("Password", { exact: true }).fill(password);
      const login = page.waitForResponse(response => response.url() === base + "/api/auth/login" && response.request().method() === "POST");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const response = await login;
      assert.equal(await response.finished(), null);
      assert.equal(response.status(), 200); assert.equal((await response.json()).success, true);
      await page.goto(base + scenario.path);
      await page.getByRole("heading", { name: scenario.heading, exact: true }).waitFor({ timeout: 15000 });
      assert(await page.getByRole("heading", { name: scenario.heading, exact: true }).isVisible());
      assert.equal(await page.getByLabel("Username", { exact: true }).isVisible(), false);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      await page.screenshot({ path: `${output}/${scenario.key}-${scenario.width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  }
} finally {
  for (const socket of sockets) socket.disconnect();
  await browser?.close();
  // Server.close does not close upgraded sockets; terminate only this fixture's
  // connections after all assertions and browser work have completed.
  for (const socket of proxyConnections) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
  await db.end();
  if (routeMatrix) {
    routeMatrix.completedCases = checks.filter(check => check.status !== "not-run").length;
    routeMatrix.uiPassed = checks.length === routeMatrix.expectedCases && checks.every(check => check.passed) &&
      routeMatrix.setups.length === new Set(checks.map(item => `${item.key}-${item.viewport.name}-${item.theme}`)).size && routeMatrix.setups.every(setup => setup.passed);
    routeMatrix.degraded = checks.some(check => check.apiErrorCount > 0) || routeMatrix.setups.some(setup => setup.apiErrorCount > 0);
    routeMatrix.coverageStatus = !routeMatrix.uiPassed ? "failed" : routeMatrix.degraded ? "degraded" : "passed-isolated-ui-only";
  }
  const report = { imageId: process.env.PRODUCTION_RUNTIME_IMAGE_ID, harnessHash, upstreamHost, mode,
    passed: checks.length > 0 && checks.every(check => check.passed) && (!routeMatrix || (routeMatrix.uiPassed && !routeMatrix.degraded)),
    scope: "configured-production-image-in-isolated-rehearsal", realProvidersVerified: false,
    tls: "ephemeral-self-signed-fixture-only", ...(coldRecovery ? { coldRecovery, peer } : {}), ...(routeMatrix ? { routeMatrix } : {}), checks };
  const reportPath = mode === "route-matrix" ? `${matrixOutput}/results.json` : `${output}/results.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(check => !check.passed), report: reportPath }));
  if (!report.passed) process.exitCode = routeMatrix?.uiPassed && routeMatrix.degraded ? 2 : 1;
}
