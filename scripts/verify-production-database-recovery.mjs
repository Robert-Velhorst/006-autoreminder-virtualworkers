import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { chromium } from "@playwright/test";
import mysql from "mysql2/promise";
import superjson from "superjson";

assert.equal(process.env.PRODUCTION_RUNTIME_FIXTURE, "isolated-owned");
const mode = process.argv[2] || "outage";
assert(["outage", "cold"].includes(mode));
const database = new URL(process.env.PRODUCTION_RUNTIME_DATABASE_URL || "");
assert.equal(database.protocol, "mysql:");
assert.equal(database.hostname, "va-runtime-mysql");
assert.equal(database.port, "3306");
assert.equal(database.pathname, "/recovery_test");
assert.equal(database.search + database.hash, "");
const upstream = "http://va-runtime-app-cold-after:3000";
const origin = "https://127.0.0.1:3443";
const output = process.env.PRODUCTION_RUNTIME_REPORT_DIRECTORY || "artifacts/production-runtime-mysql-outage-20261001";
assert.match(output, /^artifacts\/production-runtime-[a-zA-Z0-9-]+$/);
mkdirSync(output, { recursive: true });
const checks = [];
let before, after, cookie;
let browser, context, page, beforeUptime, outageUptime, afterUptime;
const browserChecks = [];
const connections = new Set();
const proxy = createServer({
  key: readFileSync(".local/production-runtime-rehearsal/server.key"),
  cert: readFileSync(".local/production-runtime-rehearsal/server.crt"),
}, (req, res) => {
  const forwarded = httpRequest({ hostname: "va-runtime-app-cold-after", port: 3000, path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-proto": "https" } }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  forwarded.on("error", () => { res.writeHead(502); res.end("Isolated upstream unavailable"); });
  req.pipe(forwarded);
});
proxy.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
const startedAt = new Date().toISOString();

async function request(path, { method = "GET", body, session = cookie } = {}) {
  const response = await fetch(upstream + path, {
    method, signal: AbortSignal.timeout(12000),
    headers: { Origin: origin, "x-forwarded-proto": "https", ...(session ? { Cookie: session } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  return { status: response.status, json, cookie: response.headers.get("set-cookie"), retryAfter: response.headers.get("retry-after") };
}
async function check(name, operation) {
  try { await operation(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}
async function waitFor(path, predicate) {
  const deadline = Date.now() + 90000;
  do {
    try { const response = await request(path); if (predicate(response)) return response; }
    catch { /* A dependency transition can briefly interrupt the owned app. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error("Owned dependency transition deadline exceeded");
}
async function snapshot() {
  const db = await mysql.createConnection(database.toString());
  try {
    const [users] = await db.query("SELECT id,openId FROM users ORDER BY id");
    assert.deepEqual(users.map(row => row.id), [190001001, 190001002, 190001003, 190001004, 190001005]);
    assert(users.every(row => row.openId.startsWith("production-runtime-fixture-")), "Unowned account refused");
    const [[ledger]] = await db.query("SELECT COUNT(*) AS total FROM __drizzle_migrations");
    assert.equal(Number(ledger.total), 54);
    const [tables] = await db.query("SHOW TABLES");
    const hash = createHash("sha256");
    let records = 0;
    for (const table of tables.map(row => Object.values(row)[0]).sort()) {
      assert.match(table, /^[a-zA-Z0-9_]+$/);
      const [rows] = await db.query(`SELECT * FROM \`${table}\``);
      const serialized = rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row)
        .filter(([key]) => table !== "users" || !["lastSignedIn", "updatedAt"].includes(key))
        .sort(([a], [b]) => a.localeCompare(b))))).sort();
      hash.update(JSON.stringify([table, serialized])); records += rows.length;
    }
    return { digest: hash.digest("hex"), tables: tables.length, records, users: users.length, migrations: Number(ledger.total) };
  } finally { await db.end(); }
}
async function login() {
  const response = await request("/api/auth/login", { method: "POST", session: undefined,
    body: { username: "production-runtime-fixture-worker", password: "Runtime-rehearsal-fixture-only-2026!" } });
  assert.equal(response.status, 200); assert.equal(response.json.success, true);
  assert(response.cookie); cookie = response.cookie.split(";")[0];
}
async function assertIdentity() {
  const response = await request("/api/trpc/auth.me");
  assert.equal(response.status, 200);
  const user = superjson.deserialize(response.json.result.data);
  assert.equal(user.id, 190001003); assert.equal(user.role, "worker");
}
async function startBrowser() {
  await new Promise(resolve => proxy.listen(3443, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1365, height: 900 } });
  // Secure cookies are tested over an isolated TLS proxy, never against live data.
  if (cookie) {
    const separator = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin, secure: true, httpOnly: true, sameSite: "Lax" }]);
  }
  page = await context.newPage();
  page.on("pageerror", error => browserChecks.push({ type: "pageerror", message: error.message }));
  await page.goto(origin + "/worker");
}
async function assertUnavailablePage() {
  await page.getByRole("heading", { name: "Dashboard temporarily unavailable" }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Try again", exact: true }).count(), 1);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.locator("body").evaluate(el => el.scrollWidth <= window.innerWidth), true);
  assert.equal(browserChecks.length, 0);
}

try {
  if (mode === "outage") {
    before = await snapshot();
    await waitFor("/api/health/ready", response => response.status === 200 && response.json.ready);
    await login(); await assertIdentity();
    writeFileSync(".local/production-runtime-rehearsal/mysql-outage-session-cookie", cookie, { mode: 0o600 });
    beforeUptime = (await request("/api/health")).json.uptime;
    await startBrowser();
    await page.getByRole("heading", { name: "Today", exact: true }).waitFor({ timeout: 20000 });
    console.log(JSON.stringify({ checkpoint: "session-ready-for-owned-mysql-stop" }));
  } else {
    assert.match(process.env.PRODUCTION_DB_EXPECTED_DIGEST || "", /^[a-f0-9]{64}$/);
    cookie = readFileSync(".local/production-runtime-rehearsal/mysql-outage-session-cookie", "utf8");
    assert.match(cookie, /^[a-zA-Z0-9_-]+=[a-zA-Z0-9_.-]+$/);
    await startBrowser();
  }
  await waitFor("/api/health/ready", response => response.status === 503 && response.json.ready === false);
  await check("database outage preserves app liveness", async () => {
    const response = await request("/api/health/live"); assert.equal(response.status, 200); assert.equal(response.json.alive, true);
  });
  await check("database outage reports unhealthy while Redis stays connected", async () => {
    const response = await request("/api/health");
    assert.equal(response.status, 503); assert.equal(response.json.database, "disconnected"); assert.equal(response.json.redis, "connected");
    outageUptime = response.json.uptime;
  });
  if (mode === "outage") await check("valid session receives temporary-unavailability instead of a false logout", async () => {
    const response = await request("/api/trpc/auth.me");
    assert.equal(response.status, 503); assert.equal(response.cookie, null);
    assert.equal(response.json.error.json.data.code, "SERVICE_UNAVAILABLE");
  });
  await check("password login reports a temporary outage without issuing or clearing a session", async () => {
    const response = await request("/api/auth/login", { method: "POST", session: undefined,
      body: { username: "production-runtime-fixture-worker", password: "Runtime-rehearsal-fixture-only-2026!" } });
    assert.equal(response.status, 503); assert.equal(response.cookie, null);
    assert.equal(response.retryAfter, "5");
    assert(!JSON.stringify(response.json).match(/SELECT|passwordHash|Runtime-rehearsal-fixture-only/));
  });
  if (mode === "outage") await check("authenticated mutations fail closed during database outage", async () => {
    const response = await request("/api/time-tracking/start", { method: "POST", body: { taskId: "mysql-outage-fixture-only" } });
    assert.equal(response.status, 503); assert.equal(response.cookie, null);
  });
  if (mode === "outage") await check("worker page stays mounted during a failed periodic session check", async () => {
    await page.getByRole("alert").filter({ hasText: "Connection interrupted" }).waitFor({ timeout: 75000 });
    assert.equal(await page.getByRole("heading", { name: "Today", exact: true }).count(), 1);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    await page.screenshot({ path: `${output}/worker-session-preserved.png` });
  });
  await check("first-load outage shows recovery instead of a misleading login on desktop", async () => {
    await page.reload(); await assertUnavailablePage();
    await page.screenshot({ path: `${output}/worker-unavailable-desktop.png` });
  });
  await check("first-load outage has a usable recovery button and no overflow on mobile", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await assertUnavailablePage();
    const response = page.waitForResponse(response => response.url().includes("/api/trpc/") && response.request().method() === "GET");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    assert.equal((await response).status(), 503);
    await assertUnavailablePage();
    await page.screenshot({ path: `${output}/worker-unavailable-mobile.png` });
  });
  console.log(JSON.stringify({ checkpoint: "outage-observed-ready-for-owned-mysql-start" }));
  await check("database recovery restores readiness without application replacement", async () => {
    await waitFor("/api/health/ready", response => response.status === 200 && response.json.ready);
    afterUptime = (await request("/api/health")).json.uptime;
    assert(afterUptime > outageUptime && (beforeUptime === undefined || outageUptime > beforeUptime));
  });
  await check("worker identity remains correct after database recovery", async () => {
    await assertIdentity();
  });
  await check("worker returns to the dashboard automatically with the original cookie", async () => {
    await page.getByRole("heading", { name: "Today", exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByRole("heading", { name: "Dashboard temporarily unavailable" }).count(), 0);
    const restored = (await context.cookies()).find(item => cookie.startsWith(item.name + "="));
    assert(restored && `${restored.name}=${restored.value}` === cookie);
    assert.equal(browserChecks.length, 0);
    await page.screenshot({ path: `${output}/worker-recovered-mobile.png` });
  });
  await check("original fixture records and migration lineage survive database recovery", async () => {
    after = await snapshot();
    assert.equal(after.digest, before?.digest ?? process.env.PRODUCTION_DB_EXPECTED_DIGEST);
  });
} finally {
  if (browser) await browser.close();
  for (const connection of connections) connection.destroy();
  if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
  const report = { imageId: process.env.PRODUCTION_RUNTIME_IMAGE_ID, mode, startedAt, completedAt: new Date().toISOString(),
    scope: "owned-production-image-database-recovery", realProvidersVerified: false, before, after,
    applicationUptime: { before: beforeUptime, outage: outageUptime, after: afterUptime }, browserChecks,
    passed: checks.length > 0 && checks.every(check => check.passed), checks };
  writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(check => !check.passed), report: `${output}/results.json` }));
  if (!report.passed) process.exitCode = 1;
}
