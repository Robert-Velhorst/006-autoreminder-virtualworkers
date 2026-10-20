import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const url = process.env.APTLSS_TEST_DATABASE_URL;
if (!url) throw new Error("Set APTLSS_TEST_DATABASE_URL to an isolated test database.");
const database = new URL(url);
if (database.protocol !== "mysql:" || database.search || database.hash || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || !/^\/(?:aptlss_test|recovery_test)$/.test(database.pathname)) throw new Error("Only an explicit loopback MySQL URL naming aptlss_test or recovery_test is allowed.");
// Do not inherit the operator's provider credentials into browser acceptance tests.
const env = { ...process.env };
if (existsSync(".env")) for (const key of Object.keys(parse(readFileSync(".env")))) env[key] = "";
for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|REDIS|SMTP|OAUTH|WEBHOOK/.test(key)) env[key] = "";
Object.assign(env, { NODE_ENV: "development", DATABASE_URL: url, PORT: process.env.APTLSS_TEST_PORT || "3035", HOST: "127.0.0.1", LOCAL_AUTH_BYPASS: "false", APTLSS_MANAGER_SCHEDULER: "false", NOTIFICATIONS_ENABLED: "false", JWT_SECRET: "aptlss-isolated-browser-tests-only-not-for-production", VITE_APP_ID: "aptlss-test" });
const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "server/_core/index.ts"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 1));
