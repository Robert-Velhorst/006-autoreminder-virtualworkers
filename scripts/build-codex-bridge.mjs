import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

await build({
  entryPoints: [
    'scripts/run-codex-bridge.ts',
    'scripts/run-manager-codex.ts',
    'scripts/run-codex-llm.ts',
    'scripts/manager-codex-supervisor.mjs',
  ],
  platform: 'node', bundle: true, format: 'esm', outdir: 'dist/bridge',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

const parent = resolve(tmpdir());
const temporary = mkdtempSync(join(parent, 'va-codex-bridge-package-'));
let cleanupAllowed = true;
try {
  for (const file of ['run-codex-bridge.js', 'run-manager-codex.js', 'run-codex-llm.js', 'manager-codex-supervisor.js']) {
    copyFileSync(join('dist/bridge', file), join(temporary, file));
  }
  const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const probe = (file, args) => spawnSync(process.execPath, [join(temporary, file), ...args], {
    cwd: temporary, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
  });
  const help = probe('run-codex-bridge.js', ['--help']);
  assert.equal(help.error, undefined, 'Bundled bridge help did not finish');
  assert.equal(help.status, 0, 'Bundled bridge requires source or external dependencies');
  assert.match(help.stdout, /Private Codex bridge/);
  for (const file of ['run-codex-bridge.js', 'run-manager-codex.js', 'run-codex-llm.js', 'manager-codex-supervisor.js']) {
    const result = probe(file, []);
    assert.equal(result.error, undefined, 'Unconfigured bridge must reject without authentication');
    assert.equal(result.status, 1, 'Unconfigured bridge must fail before starting provider work');
    assert.match(result.stderr, file === 'run-codex-bridge.js' ? /Codex bridge stopped/ : /APTLSS_CODEX_EXECUTABLE/);
  }
  // Empty queues prove transport startup/shutdown, not authentication or inference.
  const child = spawn(process.execPath, [join(temporary, 'run-codex-bridge.js')], {
    cwd: temporary, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...env, NODE_ENV: 'production', APTLSS_CODEX_EXECUTABLE: 'must-not-execute' },
  });
  let closed = false;
  const exited = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', code => { closed = true; done(code); });
  });
  void exited.catch(() => {});
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (closed) break;
      try {
        const manager = JSON.parse(readFileSync(join(temporary, '.local/pilot/codex-queue/heartbeat.json'), 'utf8'));
        const llm = JSON.parse(readFileSync(join(temporary, '.local/pilot/codex-queue/llm-v1/heartbeat.json'), 'utf8'));
        assert.equal(manager.model, 'gpt-5.6-luna'); assert.equal(manager.route, 'luna-adaptive-v1');
        assert.equal(llm.version, 1); assert.equal(llm.protocol, 'generic-luna-v1');
        ready = true; break;
      } catch { await delay(50); }
    }
    assert(ready, 'Source-free combined bridge did not start both transport protocols');
    child.send({ type: 'aptlss-supervisor-stop' });
    let timer;
    try {
      assert.equal(await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Source-free bridge shutdown was not confirmed')), 5000);
      })]), 0);
    } finally { clearTimeout(timer); }
    for (const file of ['.local/pilot/codex-private/runner.lock', '.local/pilot/codex-llm-private/runner.lock', '.local/pilot/codex-queue/llm-v1/runner.lock']) {
      assert(!existsSync(join(temporary, file)), 'Source-free bridge retained an owned runner lock after shutdown');
    }
  } finally {
    if (!closed) { child.kill(); await exited.catch(() => {}); }
    cleanupAllowed = closed;
  }
} finally {
  const target = resolve(temporary);
  assert(target.startsWith(parent + sep) && basename(target).startsWith('va-codex-bridge-package-'));
  if (cleanupAllowed) rmSync(target, { recursive: true, force: true });
}
