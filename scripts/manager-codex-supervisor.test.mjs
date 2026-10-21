import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { bridgeLaunchArgs, healthyHeartbeat, healthyLlmHeartbeat, supervise, releaseSupervisorLease } from './manager-codex-supervisor.mjs';
import { resolveCodexBridgePaths } from '../shared/codex-bridge-paths.mjs';

test('relative bridge paths are canonicalized against one explicit workspace before child launch', () => {
  const root = resolve('mock-codex-workspace');
  const paths = resolveCodexBridgePaths({ APTLSS_CODEX_BRIDGE_ROOT: root, APTLSS_CODEX_QUEUE_DIR: 'queue',
    APTLSS_CODEX_PRIVATE_DIR: 'private/manager', APTLSS_CODEX_LLM_PRIVATE_DIR: 'private/conversations' });
  assert.deepEqual(paths, { root, queue: join(root, 'queue'), managerWork: join(root, 'private/manager'), llmWork: join(root, 'private/conversations') });
});

test('private execution directories cannot overlap the whole shared queue or each other', () => {
  const base = { APTLSS_CODEX_BRIDGE_ROOT: resolve('mock-codex-workspace'), APTLSS_CODEX_QUEUE_DIR: 'queue',
    APTLSS_CODEX_PRIVATE_DIR: 'manager-private', APTLSS_CODEX_LLM_PRIVATE_DIR: 'llm-private' };
  for (const overrides of [
    { APTLSS_CODEX_PRIVATE_DIR: 'queue' }, { APTLSS_CODEX_LLM_PRIVATE_DIR: 'queue/sibling' },
    { APTLSS_CODEX_PRIVATE_DIR: 'queue/llm-v1' }, { APTLSS_CODEX_QUEUE_DIR: 'manager-private/queue' },
    { APTLSS_CODEX_LLM_PRIVATE_DIR: 'manager-private' }, { APTLSS_CODEX_LLM_PRIVATE_DIR: 'manager-private/nested' },
  ]) assert.throws(() => resolveCodexBridgePaths({ ...base, ...overrides }), /must be separate/);
});

test('explicit or default Codex authentication cannot enter the shared transport', () => {
  const root = resolve('mock-codex-workspace');
  const base = { APTLSS_CODEX_BRIDGE_ROOT: root, APTLSS_CODEX_QUEUE_DIR: 'queue',
    APTLSS_CODEX_PRIVATE_DIR: 'manager-private', APTLSS_CODEX_LLM_PRIVATE_DIR: 'llm-private' };
  assert.throws(() => resolveCodexBridgePaths({ ...base, CODEX_HOME: join(root, 'queue/auth') }), /authentication must remain outside/);
  assert.throws(() => resolveCodexBridgePaths({ ...base, HOME: join(root, 'queue/home') }), /authentication must remain outside/);
  assert.throws(() => resolveCodexBridgePaths({ ...base, CODEX_HOME: root }), /authentication must remain outside/);
  assert.throws(() => resolveCodexBridgePaths({ ...base, CODEX_HOME: 'relative-auth' }), /home paths must be absolute/);
  assert.doesNotThrow(() => resolveCodexBridgePaths({ ...base, CODEX_HOME: join(root, 'authentication') }));
});

test('missing authentication descendants beneath an outside junction cannot enter the queue', async () => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'va-bridge-auth-alias-'));
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    await mkdir(join(root, 'queue'));
    await symlink(join(root, 'queue'), join(root, 'outside-auth-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveCodexBridgePaths({ APTLSS_CODEX_BRIDGE_ROOT: root,
      APTLSS_CODEX_QUEUE_DIR: 'queue', APTLSS_CODEX_PRIVATE_DIR: 'manager-private',
      APTLSS_CODEX_LLM_PRIVATE_DIR: 'llm-private', CODEX_HOME: join(root, 'outside-auth-alias/missing/auth'),
    }), /authentication must remain outside/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    const target = resolve(root);
    assert(target.startsWith(parent + sep) && basename(target).startsWith('va-bridge-auth-alias-'));
    await rm(target, { recursive: true, force: true });
  }
});

test('source-free supervisor selects the bundled entry without a compiler or source paths', () => {
  const root = resolve('mock-bridge');
  const directory = resolve(root, 'dist/bridge');
  assert.deepEqual(bridgeLaunchArgs(root, directory, () => true), [resolve(directory, 'run-codex-bridge.js')]);
  assert.deepEqual(bridgeLaunchArgs(root, directory, () => false), ['--import', 'tsx', resolve(root, 'scripts/run-codex-bridge.ts')]);
});

test('generic heartbeat must independently prove its protocol, model, efforts and freshness', () => {
  const now = Date.now();
  const heartbeat = { version: 1, at: new Date(now).toISOString(), model: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high'], protocol: 'generic-luna-v1' };
  assert.equal(healthyLlmHeartbeat(heartbeat, now - 1000, now), true);
  for (const defect of [{ version: undefined }, { version: 2 }, { protocol: 'manager-only' }, { model: 'different-model' }, { efforts: ['high'] }, { at: new Date(now - 20_000).toISOString() }]) {
    assert.equal(healthyLlmHeartbeat({ ...heartbeat, ...defect }, now - 1000, now), false);
  }
});

test('supervisor lease remains after unconfirmed shutdown and never removes another owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aptlss-supervisor-lease-'));
  const lock = join(directory, 'supervisor.lock');
  try {
    await writeFile(lock, 'owner');
    await releaseSupervisorLease(lock, 'owner', false);
    assert.equal(await readFile(lock, 'utf8'), 'owner');
    await releaseSupervisorLease(lock, 'other-owner', true);
    assert.equal(await readFile(lock, 'utf8'), 'owner');
    await releaseSupervisorLease(lock, 'owner', true);
    await assert.rejects(readFile(lock, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('crash retries back off and never overlap children', async () => {
  const controller = new AbortController();
  const delays = [];
  let running = 0;
  await supervise({ signal: controller.signal,
    launch() {
      assert.equal(running, 0);
      running++;
      const child = new EventEmitter();
      queueMicrotask(() => { running--; child.emit('exit', 1); });
      return child;
    },
    async wait(ms) { delays.push(ms); if (delays.length === 8) controller.abort(); },
  });
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('stop terminates only owned child and does not restart', async () => {
  const controller = new AbortController();
  let launches = 0;
  let kills = 0;
  await supervise({ signal: controller.signal,
    launch() {
      launches++;
      const child = new EventEmitter();
      child.kill = signal => { assert.equal(signal, 'SIGTERM'); kills++; queueMicrotask(() => child.emit('exit', 0)); };
      queueMicrotask(() => controller.abort());
      return child;
    },
    async wait() { assert.fail('no retry after shutdown'); },
  });
  assert.equal(launches, 1);
  assert.equal(kills, 1);
});

test('process launch failure is surfaced instead of silently looping', async () => {
  const controller = new AbortController();
  await assert.rejects(supervise({ signal: controller.signal,
    launch() { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('launch failed'))); return child; },
    async wait() { assert.fail('launch failure must be surfaced'); },
  }), /launch failed/);
});

test('real local child exits are restarted without provider access', async () => {
  const controller = new AbortController();
  let launches = 0;
  const children = [];
  await supervise({ signal: controller.signal,
    launch() {
      launches++;
      const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { windowsHide: true, stdio: 'ignore', env: {} });
      children.push(child);
      return child;
    },
    async wait() { if (launches === 2) controller.abort(); },
  });
  assert.equal(launches, 2);
  assert.ok(children.every(child => child.exitCode === 7));
});

test('IPC stop permits real child cleanup before supervisor finishes', async () => {
  const controller = new AbortController();
  let child;
  await supervise({ signal: controller.signal,
    launch() {
      child = spawn(process.execPath, ['-e', 'process.on("message", m => { if(m.type === "aptlss-supervisor-stop") { process.exitCode=0; process.disconnect(); } }); process.send("ready");'],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
      child.once('message', () => controller.abort());
      return child;
    },
    async wait() { assert.fail('shutdown must not restart'); },
  });
  assert.equal(child.exitCode, 0);
});

test('unconfirmed shutdown fails closed without launching a replacement', async () => {
  const controller = new AbortController();
  let launches = 0;
  await assert.rejects(supervise({ signal: controller.signal, shutdownTimeoutMs: 10,
    launch() {
      launches++;
      const child = new EventEmitter();
      child.connected = true;
      child.send = () => {};
      queueMicrotask(() => controller.abort());
      return child;
    },
    async wait() { assert.fail('no retry'); },
  }), /did not confirm shutdown/);
  assert.equal(launches, 1);
});

for (const stopMode of ['message', 'disconnect']) {
test(`real runner handles IPC ${stopMode} and removes its private lease`, { timeout: 20_000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const directory = await mkdtemp(join(tmpdir(), 'aptlss-runner-ipc-'));
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(root, 'node_modules/tsx/dist/loader.mjs')).href, resolve(root, 'scripts/run-manager-codex.ts')], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, APTLSS_CODEX_EXECUTABLE: 'must-not-execute' },
  });
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code)); });
  const lease = join(directory, '.local/pilot/codex-private/runner.lock');
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      if (child.exitCode !== null) break;
      try {
        await readFile(join(directory, '.local/pilot/codex-queue/heartbeat.json'), 'utf8');
        ready = true;
        break;
      } catch { await sleep(100); }
    }
    assert.ok(ready, 'isolated real runner must publish a heartbeat');
    assert.ok(Number((await readFile(lease, 'utf8')).trim()) > 0);
    if (stopMode === 'message') child.send({ type: 'aptlss-supervisor-stop' });
    else child.disconnect();
    assert.equal(await exited, 0);
    await assert.rejects(readFile(lease, 'utf8'), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
}

test('heartbeat rejects stale, previous-run, future and wrong-route signals', () => {
  const now = Date.now();
  const good = { at: new Date(now).toISOString(), model: 'gpt-5.6-luna', route: 'luna-adaptive-v1', efforts: ['low', 'medium', 'high'] };
  assert.equal(healthyHeartbeat(good, now - 100, now), true);
  assert.equal(healthyHeartbeat({ ...good, at: new Date(now - 20_000).toISOString() }, now - 30_000, now), false);
  assert.equal(healthyHeartbeat(good, now + 1, now), false);
  assert.equal(healthyHeartbeat({ ...good, at: new Date(now + 6000).toISOString() }, now, now), false);
  assert.equal(healthyHeartbeat({ ...good, route: 'other' }, now, now), false);
});

test('unhealthy child must exit before a replacement can start', async () => {
  const controller = new AbortController();
  let active = 0;
  let launches = 0;
  await supervise({ signal: controller.signal, startupGraceMs: 0, healthIntervalMs: 5,
    launch() {
      assert.equal(active, 0);
      launches++; active++;
      const child = new EventEmitter();
      child.connected = true;
      child.send = message => {
        assert.equal(message.type, 'aptlss-supervisor-stop');
        setTimeout(() => { active--; child.emit('exit', 0); }, 5);
      };
      return child;
    },
    health: async () => false,
    async wait() { if (launches === 2) controller.abort(); },
  });
  assert.equal(launches, 2);
  assert.equal(active, 0);
});
