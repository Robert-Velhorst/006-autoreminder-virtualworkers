import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

if (process.env.APTLSS_UI_ONLY === "true") {
  // Contract browser fixtures intercept every API call. Never start the backend.
  const [{ createServer }, { default: react }, { default: tailwindcss }] = await Promise.all([
    import("vite"), import("@vitejs/plugin-react"), import("@tailwindcss/vite"),
  ]);
  const server = await createServer({
    configFile: false,
    root: resolve("client"),
    envDir: false,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": resolve("client/src"), "@shared": resolve("shared"), "@assets": resolve("attached_assets") } },
    server: { host: "127.0.0.1", port: Number(process.env.APTLSS_TEST_PORT || "3036"), strictPort: true },
  });
  await server.listen();
  server.printUrls();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void server.close().then(() => process.exit(0)); });
} else {
const url = process.env.APTLSS_TEST_DATABASE_URL;
if (!url) throw new Error("Set APTLSS_TEST_DATABASE_URL to an isolated test database.");
const database = new URL(url);
if (database.protocol !== "mysql:" || database.search || database.hash || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || !/^\/(?:aptlss_test|recovery_test)$/.test(database.pathname)) throw new Error("Only an explicit loopback MySQL URL naming aptlss_test or recovery_test is allowed.");
const fixtureIds = process.env.APTLSS_TEST_PILOT_WORKER_IDS?.split(",") ?? [];
if (fixtureIds.length !== 5 || new Set(fixtureIds).size !== 5 || fixtureIds.some(id => !/^\d+$/.test(id) || Number(id) < 100_000_000 || Number(id) > 200_001_000)) throw new Error("Run via playwright.aptlss.config.ts with five isolated fixture worker IDs.");
const port = process.env.APTLSS_TEST_PORT || "3035";
if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error("APTLSS_TEST_PORT must be a valid TCP port.");
// Do not inherit the operator's provider credentials into browser acceptance tests.
const env = { ...process.env };
if (existsSync(".env")) for (const key of Object.keys(parse(readFileSync(".env")))) env[key] = "";
for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|REDIS|SMTP|OAUTH|WEBHOOK/.test(key.toUpperCase())) env[key] = "";
Object.assign(env, { NODE_ENV: "development", DATABASE_URL: url, PORT: port, HOST: "127.0.0.1", LOCAL_AUTH_BYPASS: "false", APTLSS_MANAGER_SCHEDULER: "false", NOTIFICATIONS_ENABLED: "false", JWT_SECRET: "aptlss-isolated-browser-tests-only-not-for-production", VITE_APP_ID: "aptlss-test" });
// Cookie-authenticated browser sockets need the exact isolated dashboard origin.
// Never inherit the operator's production origins or outbound webhook base URL.
Object.assign(env, { LOCAL_ACCESS_ORIGINS: `http://127.0.0.1:${port}`, PUBLIC_URL: "", APP_URL: "", VITE_FRONTEND_URL: "", WEBHOOK_BASE_URL: "" });
Object.assign(env, { APTLSS_MANAGER_PILOT_WORKER_IDS: fixtureIds.join(","), APTLSS_MANAGER_SHADOW_ONLY: "true" });
const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "server/_core/index.ts"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 1));
}
