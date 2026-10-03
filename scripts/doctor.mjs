import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse } from "dotenv";

const asJson = process.argv.includes("--json");
const root = process.cwd();
const checks = [];

function add(name, status, detail) {
  checks.push({ name, status, detail });
}

async function readEnv(file) {
  try {
    const content = await readFile(path.join(root, file), "utf8");
    return parse(content);
  } catch {
    return {};
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

const env = { ...await readEnv(".env"), ...process.env };
const managerProvider = env.APTLSS_MANAGER_PROVIDER?.trim() || "codex-subscription";
const providerValid = managerProvider === "codex-subscription" || managerProvider === "openai-api";
add("config:APTLSS_MANAGER_PROVIDER", providerValid ? "ok" : "error",
  providerValid ? managerProvider : "must be codex-subscription or openai-api");
const required = [
  ["DATABASE_URL"],
  ["JWT_SECRET"],
  ["TRELLO_API_KEY", "TrelloAPIKey"],
  ["TRELLO_TOKEN", "TrelloAPIToken"],
  ...(managerProvider === "openai-api" ? [["OPENAI_API_KEY"]] : []),
];
for (const aliases of required) {
  const configured = aliases.some(name => Boolean(env[name]?.trim()));
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
