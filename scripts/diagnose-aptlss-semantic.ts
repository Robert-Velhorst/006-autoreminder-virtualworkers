import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

// One read-only assessment diagnostic; no manager run, review or plan is saved.
const container = JSON.parse(execFileSync("docker", ["inspect", "joyce-work-schedule-app-1"], { encoding: "utf8" }))[0];
for (const item of container.Config.Env as string[]) {
  const index = item.indexOf("=");
  const key = item.slice(0, index);
  if (["OPENAI_API_KEY", "OPENAI_MODEL", "APTLSS_MANAGER_MODEL", "DATABASE_URL"].includes(key)) process.env[key] = item.slice(index + 1);
}
const url = new URL(process.env.DATABASE_URL!);
url.hostname = "127.0.0.1";
url.port = "3307";
process.env.DATABASE_URL = url.href;
process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = "2";
process.env.APTLSS_MANAGER_SHADOW_ONLY = "true";
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await fetchOriginal(input, init);
  if (String(input) === "https://api.openai.com/v1/responses") {
    const data = await response.clone().json() as any;
    mkdirSync(".local/pilot", { recursive: true });
    writeFileSync(".local/pilot/semantic-diagnostic.json", JSON.stringify({ request: JSON.parse(String(init?.body)), response: data }));
    console.log(JSON.stringify({ providerHttpStatus: response.status,
      model: JSON.parse(String(init?.body)).model,
      errorCode: data.error?.code, errorType: data.error?.type,
      errorParam: data.error?.param, status: data.status,
      outputTypes: data.output?.map((item: any) => item.type) }));
  }
  return response;
};
try {
  const { getDb, closeDb } = await import("../server/db");
  try {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const { collectManagerInput } = await import("../server/aptlssManagerService");
    const { assessManagerContext } = await import("../server/aptlssManagerEngine");
    const { enrichManagerResult } = await import("../server/aptlssManagerModel");
    const input = await collectManagerInput(db, 2, new Date());
    let success = false;
    const result = await enrichManagerResult(input, assessManagerContext(input), value => { success = value; });
    console.log(JSON.stringify({ semanticSuccess: success, diagnostic: result.sourceGaps.filter(g => /^(Semantic|Unverified model)/i.test(g)) }));
  } finally { await closeDb(); }
} catch {
  console.error("Diagnostic unavailable; no raw provider or database error was printed.");
  process.exitCode = 1;
}
