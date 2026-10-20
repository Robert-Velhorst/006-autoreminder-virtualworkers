import { closeDb } from "../db";
import { runScheduledJob } from "../scheduledJobRuntime";

import { requireIsolatedPostgresTestDatabase } from "../../shared/isolatedPostgresTestDatabase.mjs";
requireIsolatedPostgresTestDatabase(process.env.APTLSS_TEST_DATABASE_URL, process.env.NODE_ENV === "production");
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
  } finally { await closeDb(); process.disconnect?.(); }
});
process.send!({ type: "ready" });
