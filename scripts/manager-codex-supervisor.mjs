import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCodexBridgePaths } from '../shared/codex-bridge-paths.mjs';

export function healthyHeartbeat(heartbeat, started, now = Date.now()) {
  const at = Date.parse(heartbeat?.at);
  return Number.isFinite(at) && at >= started && now - at <= 15_000 && at - now <= 5000 &&
    heartbeat.model === 'gpt-5.6-luna' && heartbeat.route === 'luna-adaptive-v1' &&
    Array.isArray(heartbeat.efforts) && heartbeat.efforts.join(',') === 'low,medium,high';
}

export function healthyLlmHeartbeat(heartbeat, started, now = Date.now()) {
  return heartbeat?.version === 1 && healthyHeartbeat({ ...heartbeat, route: 'luna-adaptive-v1' }, started, now) &&
    heartbeat?.protocol === 'generic-luna-v1';
}

export function bridgeLaunchArgs(root, moduleDirectory, exists = existsSync) {
  const bundled = resolve(moduleDirectory, 'run-codex-bridge.js');
  return exists(bundled) ? [bundled] : ['--import', 'tsx', resolve(root, 'scripts/run-codex-bridge.ts')];
}

export async function releaseSupervisorLease(lock, owner, shutdownConfirmed) {
  if (!shutdownConfirmed) return;
  if (await readFile(lock, 'utf8').catch(() => '') === owner) await unlink(lock);
}

export async function supervise({ launch, wait, signal, report = () => {}, now = Date.now, shutdownTimeoutMs = 15_000,
  health, healthIntervalMs = 5000, startupGraceMs = 15_000 }) {
  let failures = 0;
  while (!signal.aborted) {
    const started = now();
    const child = launch();
    let shutdownTimer;
    let rejectShutdown;
    let healthTimer;
    let checking = false;
    let finished = false;
    const stop = () => {
      if (shutdownTimer) return;
      shutdownTimer = setTimeout(() => rejectShutdown(new Error('Owned runner did not confirm shutdown; no replacement was launched')), shutdownTimeoutMs);
      if (child.connected && typeof child.send === 'function') {
        child.send({ type: 'aptlss-supervisor-stop' }, error => { if (error) rejectShutdown(error); });
      } else child.kill('SIGTERM');
    };
    try {
      await new Promise((done, reject) => {
        rejectShutdown = reject;
        child.once('error', reject);
        child.once('exit', done);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        if (health) healthTimer = setInterval(async () => {
          if (checking || finished || shutdownTimer || now() - started < startupGraceMs) return;
          checking = true;
          try {
            const healthy = await health(started);
            if (!healthy && !finished && !shutdownTimer) {
              report({ event: 'runner-heartbeat-unavailable' });
              stop();
            }
          } catch {
            if (!finished && !shutdownTimer) { report({ event: 'runner-heartbeat-unavailable' }); stop(); }
          } finally { checking = false; }
        }, healthIntervalMs);
      });
    } finally {
      finished = true;
      clearInterval(healthTimer);
      clearTimeout(shutdownTimer);
      signal.removeEventListener('abort', stop);
    }
    if (signal.aborted) break;
    failures = now() - started >= 60_000 ? 1 : failures + 1;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6));
    report({ event: 'runner-exited', retryAfterMs: delay });
    await wait(delay, signal);
  }
}

async function main() {
  if (!process.env.APTLSS_CODEX_EXECUTABLE) throw new Error('APTLSS_CODEX_EXECUTABLE is required');
  const { root, queue, managerWork: privateDir, llmWork: llmPrivateDir } = resolveCodexBridgePaths(process.env);
  const alive = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  for (const directory of [privateDir, llmPrivateDir]) {
    try {
      if (alive(Number((await readFile(resolve(directory, 'runner.lock'), 'utf8')).trim()))) {
        throw new Error('An existing runner is active; no takeover is permitted');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  // Never steal a supervisor lease, even when it looks stale; operator review is required.
  const lock = resolve(privateDir, 'supervisor.lock');
  const owner = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  await writeFile(lock, owner, { flag: 'wx', mode: 0o600 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let shutdownConfirmed = false;
  try {
    await supervise({
      signal: controller.signal,
      launch: () => spawn(process.execPath, bridgeLaunchArgs(root, import.meta.dirname), {
        cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
          ...process.env, APTLSS_CODEX_BRIDGE_ROOT: root, APTLSS_CODEX_QUEUE_DIR: queue,
          APTLSS_CODEX_PRIVATE_DIR: privateDir, APTLSS_CODEX_LLM_PRIVATE_DIR: llmPrivateDir,
        },
      }),
      report: event => process.stdout.write(`${JSON.stringify(event)}\n`),
      health: async started => healthyHeartbeat(JSON.parse(await readFile(resolve(queue, 'heartbeat.json'), 'utf8')), started) &&
        healthyLlmHeartbeat(JSON.parse(await readFile(resolve(queue, 'llm-v1/heartbeat.json'), 'utf8')), started),
      wait: (ms, signal) => new Promise(done => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
        const timer = setTimeout(finish, ms);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      }),
    });
    shutdownConfirmed = true;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await releaseSupervisorLease(lock, owner, shutdownConfirmed);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
