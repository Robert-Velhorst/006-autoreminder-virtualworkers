import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const asJson = process.argv.includes("--json");
const root = process.cwd();
const checks = [];

function add(name, status, detail) {
  checks.push({ name, status, detail });
}

async function readEnvNames(file) {
  try {
    const content = await readFile(path.join(root, file), "utf8");
    return new Set(
      content
        .split(/\r?\n/)
        .map(line => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function checkUrl(name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    add(name, response.ok ? "ok" : "error", `${response.status} ${url}`);
  } catch (error) {
    add(name, "error", `${url}: ${error instanceof Error ? error.message : "unavailable"}`);
  }
}

const envNames = await readEnvNames(".env");
const required = [
  ["DATABASE_URL"],
  ["JWT_SECRET"],
  ["TRELLO_API_KEY", "TrelloAPIKey"],
  ["TRELLO_TOKEN", "TrelloAPIToken"],
  ["OPENAI_API_KEY"],
];
for (const aliases of required) {
  const configured = aliases.some(name => envNames.has(name) || Boolean(process.env[name]));
  add(`config:${aliases[0]}`, configured ? "ok" : "error", configured ? "configured" : "missing");
}

await checkUrl("health", process.env.DASHBOARD_HEALTH_URL || "http://127.0.0.1:3025/api/health");
await checkUrl("readiness", process.env.DASHBOARD_READY_URL || "http://127.0.0.1:3025/api/health/ready");

try {
  const state = JSON.parse((await readFile(path.join(root, ".local", "public-dashboard.json"), "utf8")).replace(/^\uFEFF/, ""));
  if (state?.healthUrl) await checkUrl("public-health", state.healthUrl);
} catch {
  add("public-health", "warning", "No recorded public tunnel; local operation remains available");
}

const failed = checks.filter(check => check.status === "error");
if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks }, null, 2)}\n`);
} else {
  for (const check of checks) process.stdout.write(`${check.status.toUpperCase().padEnd(7)} ${check.name}: ${check.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? "Doctor passed" : `Doctor found ${failed.length} blocking issue(s)`}.\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
