import { resolve } from "node:path";
import { startCodexManagerRunner } from "../server/aptlssManagerCodexRunner";

const executable = process.env.APTLSS_CODEX_EXECUTABLE;
if (!executable) throw new Error("Set APTLSS_CODEX_EXECUTABLE to the installed official Codex executable.");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
await startCodexManagerRunner(resolve(".local/pilot/codex-queue"), resolve(".local/pilot/codex-private"), executable, controller.signal);
