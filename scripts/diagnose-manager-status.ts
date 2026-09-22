import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";

// Inspect the live worker's read path without tokens, source text, or writes.
const container = JSON.parse(execFileSync("docker", ["inspect", "joyce-work-schedule-app-1"], { encoding: "utf8", timeout: 15000 }))[0];
const env = Object.fromEntries(container.Config.Env.map((item: string) => {
  const index = item.indexOf("="); return [item.slice(0, index), item.slice(index + 1)];
}));
const url = new URL(env.DATABASE_URL);
url.hostname = "127.0.0.1"; url.port = "3307";
process.env.DATABASE_URL = url.href;
process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = "2";
process.env.APTLSS_MANAGER_SHADOW_ONLY = "true";
const connection = await mysql.createConnection(url.href);
try {
  await connection.query("SET SESSION MAX_EXECUTION_TIME=20000");
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  await connection.beginTransaction();
  const [counts] = await connection.query("SELECT COUNT(*) AS runs, SUM(appliedPlanHash IS NOT NULL) AS appliedRuns, COUNT(DISTINCT proposalHash) AS proposals FROM aptlss_manager_runs WHERE vaId=2");
  console.log(JSON.stringify({ history: counts }));
  const start = performance.now();
  if (process.argv.includes("--gate")) {
    const { getManagerGate } = await import("../server/aptlssManagerReviewService");
    const gate = await getManagerGate(2, drizzle(connection) as any);
    console.log(JSON.stringify({ gateMs: Math.round(performance.now() - start), reviewed: gate.reviewed, eligible: gate.eligible }));
  } else {
    const { getManagerStatus } = await import("../server/aptlssManagerService");
    const { closeDb } = await import("../server/db");
    try {
      const status = await getManagerStatus(2);
      console.log(JSON.stringify({ statusMs: Math.round(performance.now() - start), mode: status.policy.mode,
        runId: status.snapshot?.runId, responseBytes: Buffer.byteLength(JSON.stringify(status)) }));
    } finally { await closeDb(); }
  }
} catch (error) {
  console.log(JSON.stringify({ failed: true, code: (error as any).cause?.code ?? (error as any).code ?? "status-read-failed" }));
  process.exitCode = 1;
} finally {
  await connection.rollback();
  await connection.end();
}
