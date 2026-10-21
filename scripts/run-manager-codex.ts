import { startCodexManagerRunner } from "../server/aptlssManagerCodexRunner";
import { resolveCodexBridgePaths } from "../shared/codex-bridge-paths.mjs";

const executable = process.env.APTLSS_CODEX_EXECUTABLE;
if (!executable) throw new Error("Set APTLSS_CODEX_EXECUTABLE to the installed official Codex executable.");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const onMessage = (message: unknown) => {
  if (message && typeof message === "object" &&
      (message as { type?: unknown }).type === "aptlss-supervisor-stop") controller.abort();
};
const onDisconnect = () => controller.abort();
process.on("message", onMessage);
process.once("disconnect", onDisconnect);
try {
  const { queue, managerWork } = resolveCodexBridgePaths(process.env);
  await startCodexManagerRunner(queue, managerWork, executable, controller.signal);
} finally {
  process.removeListener("message", onMessage);
  process.removeListener("disconnect", onDisconnect);
  if (process.connected) process.disconnect();
}
