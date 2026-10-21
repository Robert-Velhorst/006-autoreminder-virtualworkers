import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve("scripts/doctor.mjs");
const baseline = "DATABASE_URL=postgresql://fixture:unused@localhost/recovery_test?sslmode=disable\nJWT_SECRET=fixture-secret\nTRELLO_API_KEY=fixture-key\nTRELLO_TOKEN=fixture-token\n";

async function doctor(content, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "va-doctor-"));
  const server = createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  let child;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await writeFile(path.join(directory, ".env"), content);
    const url = `http://127.0.0.1:${server.address().port}/health`;
    // Do not inherit operator configuration or provider credentials.
    child = spawn(process.execPath, [script, "--json"], {
      cwd: directory, windowsHide: true,
      timeout: 15_000,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
        DASHBOARD_HEALTH_URL: url, DASHBOARD_READY_URL: url, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(stderr, "");
    assert.equal(exit.signal, null);
    return { code: exit.code, report: JSON.parse(stdout), stdout };
  } finally {
    if (child?.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert(path.basename(directory).startsWith("va-doctor-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("doctor accepts default subscription mode without an API key", async () => {
  const result = await doctor(baseline);
  assert.equal(result.code, 0);
  assert.equal(result.report.ok, true);
  assert(!result.report.checks.some(check => check.name === "config:OPENAI_API_KEY"));
});

test("doctor rejects explicit paid API routing even with an empty key", async () => {
  const result = await doctor(baseline + 'APTLSS_MANAGER_PROVIDER="openai-api"\nOPENAI_API_KEY="   "\n');
  assert.equal(result.code, 1);
  assert(result.report.checks.some(check => check.name === "config:APTLSS_MANAGER_PROVIDER" && check.status === "error"));
});

test("doctor rejects paid routing with configured credentials without exposing them", async () => {
  const result = await doctor(baseline + "APTLSS_MANAGER_PROVIDER=openai-api\nOPENAI_API_KEY=fixture-private-api-value\n");
  assert.equal(result.code, 1);
  assert(!result.stdout.includes("fixture-private-api-value"));
});

test("doctor never treats a configured queue as live account acceptance", async () => {
  const result = await doctor(baseline + 'APTLSS_CODEX_QUEUE_DIR=/private/fixture-queue\n');
  assert.equal(result.code, 0);
  assert(result.report.checks.some(check => check.name === 'config:subscription-bridge'
    && check.status === 'warning' && /require verification/.test(check.detail)));
  assert(!result.stdout.includes('/private/fixture-queue'));
});

test("doctor rejects blank required settings instead of counting their names", async () => {
  const result = await doctor('DATABASE_URL=\nJWT_SECRET=" "\nTRELLO_API_KEY=\nTRELLO_TOKEN=\n');
  assert.equal(result.code, 1);
  assert.equal(result.report.checks.filter(check => check.status === "error").length, 4);
});

test("doctor respects process overrides including an explicitly cleared setting", async () => {
  const result = await doctor(baseline + "APTLSS_MANAGER_PROVIDER=openai-api\nOPENAI_API_KEY=fixture-private-api-value\n",
    { APTLSS_MANAGER_PROVIDER: "codex-subscription", TRELLO_TOKEN: "" });
  assert.equal(result.code, 1);
  assert(result.report.checks.some(check => check.name === "config:TRELLO_TOKEN" && check.status === "error"));
  assert(!result.report.checks.some(check => check.name === "config:OPENAI_API_KEY"));
});

test("doctor rejects unknown provider without exposing its value", async () => {
  const result = await doctor(baseline + "APTLSS_MANAGER_PROVIDER=fixture-private-invalid-provider\n");
  assert.equal(result.code, 1);
  assert(result.report.checks.some(check => check.name === "config:APTLSS_MANAGER_PROVIDER" && check.status === "error"));
  assert(!result.stdout.includes("fixture-private-invalid-provider"));
});
