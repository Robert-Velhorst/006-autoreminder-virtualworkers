import { join } from 'node:path';
import { startCodexLlmRunner } from '../server/codexLlmRunner';
import { resolveCodexBridgePaths } from '../shared/codex-bridge-paths.mjs';

const executable = process.env.APTLSS_CODEX_EXECUTABLE;
if (!executable) throw new Error('APTLSS_CODEX_EXECUTABLE must select the installed official Codex executable.');
const controller = new AbortController();
const stop = () => controller.abort();
const onMessage = (message: unknown) => {
  if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'aptlss-supervisor-stop') stop();
};
process.once('SIGINT',stop); process.once('SIGTERM',stop);
process.on('message',onMessage); process.once('disconnect',stop);
try {
  const { queue, llmWork } = resolveCodexBridgePaths(process.env);
  await startCodexLlmRunner(join(queue,'llm-v1'),llmWork,executable,controller.signal);
}
finally {
  process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
  process.removeListener('message',onMessage); process.removeListener('disconnect',stop);
  if (process.connected) process.disconnect();
}
