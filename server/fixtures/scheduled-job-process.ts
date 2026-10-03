import { closeDb } from "../db";
import { runScheduledJob } from "../scheduledJobRuntime";

let target: URL | undefined;
try { target = new URL(process.env.APTLSS_TEST_DATABASE_URL ?? ""); } catch { /* No credential values in errors. */ }
if (!target || target.protocol !== "mysql:" || target.search || target.hash
  || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  || !["/aptlss_test", "/recovery_test"].includes(target.pathname))
  throw new Error("Synthetic job process requires an explicit loopback test database");
if (process.env.DATABASE_URL !== process.env.APTLSS_TEST_DATABASE_URL || !process.send)
  throw new Error("Synthetic job process requires the exact isolated test database and IPC");
const jobKey = process.argv[2];
if (!/^job-runtime-test:[0-9a-f-]{36}$/.test(jobKey)) throw new Error("Synthetic job key required");
let release!: () => void;
const released = new Promise<void>(resolve => { release = resolve; });
process.on("message", async message => {
  if (message === "release") { release(); return; }
  if (message !== "start") return;
  try {
    const result = await runScheduledJob({ jobKey }, async () => {
      process.send!({ type: "work_started" });
      await released;
      return { recordsProcessed: 1, detail: "Synthetic callback; no external provider" };
    });
    process.send!({ type: "result", result });
  } catch {
    process.send!({ type: "error" }); process.exitCode = 1;
  } finally { await closeDb(); process.disconnect(); }
});
process.send({ type: "ready" });
