import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startCodexManagerRunner } from "../server/aptlssManagerCodexRunner";
import { startCodexLlmRunner } from "../server/codexLlmRunner";
import { resolveCodexBridgePaths } from "../shared/codex-bridge-paths.mjs";

type StartRunner = (queue: string, work: string, executable: string, signal: AbortSignal) => Promise<unknown>;

export async function runCodexBridge(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  runners: { manager: StartRunner; llm: StartRunner } = {
    manager: startCodexManagerRunner, llm: startCodexLlmRunner,
  },
) {
  signal.throwIfAborted();
  const executable = env.APTLSS_CODEX_EXECUTABLE;
  if (!executable) throw new Error("APTLSS_CODEX_EXECUTABLE must select the installed official Codex executable.");
  const { queue, managerWork, llmWork } = resolveCodexBridgePaths(env);
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const start = (runner: StartRunner, root: string, work: string) => Promise.resolve()
    .then(() => runner(root, work, executable, controller.signal))
    .finally(() => controller.abort());
  try {
    const results = await Promise.allSettled([
      start(runners.manager, queue, managerWork),
      start(runners.llm, join(queue, "llm-v1"), llmWork),
    ]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (!signal.aborted) throw new Error("Codex bridge runner stopped unexpectedly.");
  } finally {
    controller.abort();
    signal.removeEventListener("abort", stop);
  }
}

async function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    console.log("Private Codex bridge: configure APTLSS_CODEX_EXECUTABLE, APTLSS_CODEX_QUEUE_DIR, APTLSS_CODEX_PRIVATE_DIR and APTLSS_CODEX_LLM_PRIVATE_DIR. No API key is used.");
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  const message = (value: unknown) => {
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "aptlss-supervisor-stop") stop();
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.once("disconnect", stop); process.on("message", message);
  try { await runCodexBridge(process.env, controller.signal); }
  finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    process.removeListener("disconnect", stop); process.removeListener("message", message);
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Codex bridge stopped. Inspect private runner status before restarting."); process.exitCode = 1; });
}
