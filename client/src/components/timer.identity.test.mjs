import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import superjson from 'superjson';

const root = fileURLToPath(new URL('../../..', import.meta.url));
let browser, bundle;
before(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {httpLink} from '@trpc/client';
      import superjson from 'superjson';
      import {trpc} from '@/lib/trpc';
      import {Timer} from '@/components/Timer';
      import TimeTracker from '@/components/manus/TimeTracker';
      import {TodayView} from '@/pages/worker/WorkerOperator';
      import {TodayHoursChip} from '@/pages/manus/Home';
      import {WeeklyProgressDashboard} from '@/components/WeeklyProgressDashboard';
      const queries = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:3,retryDelay:1}}});
      const rpc = trpc.createClient({links:[httpLink({url:'/api/trpc',transformer:superjson})]});
      const root = createRoot(document.getElementById('root'));
      window.refreshTimer = () => queries.invalidateQueries();
      window.mountTimer = (kind, taskId='task-a', compact=false) => root.render(
        <trpc.Provider client={rpc} queryClient={queries}><QueryClientProvider client={queries}>
          {kind === 'rest' ? <Timer taskId={taskId} taskName="Task" compact={compact} estimatedHours={1}/> : kind === 'manus'
            ? <TimeTracker/> : kind === 'hours-chip' ? <TodayHoursChip/> : kind === 'weekly' ? <WeeklyProgressDashboard/>
              : <TodayView timeZone="UTC" onOpenPlan={()=>{}} onOpenDecisions={()=>{}}/>}
        </QueryClientProvider></trpc.Provider>);
    `, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': resolve(root, 'client/src'), '@shared': resolve(root, 'shared') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [{ name: 'record-user-notices', setup(builder) {
      builder.onResolve({ filter: /^sonner$/ }, () => ({ path: 'sonner', namespace: 'notices' }));
      builder.onLoad({ filter: /.*/, namespace: 'notices' }, () => ({ contents: `
        window.timerNotices=[];
        export const toast={success:message=>window.timerNotices.push({kind:'success',message}),
          error:message=>window.timerNotices.push({kind:'error',message})};
      ` }));
    } }],
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

const active = (id = 17, taskId = 'task-a') => ({ id, taskId, cardId: taskId, cardName: 'Task A', cardUrl: '#',
  startTime: new Date().toISOString(), startedAt: new Date(), vaId: 999, trackedUserId: 12 });
const rpcData = data => ({ result: { data: superjson.serialize(data) } });
const rpcError = code => ({ error: { json: { message: 'PRIVATE_DIAGNOSTIC_NOT_FOR_WORKER', code: -32009,
  data: { code, httpStatus: code === 'CONFLICT' ? 409 : 503 } } } });
function deferred() {
  let release;
  const promise = new Promise(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

async function fixture(kind, options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (options.clock) await page.clock.install();
  const calls = [], unexpected = [], pageErrors = [];
  const state = { active: options.active === undefined ? active() : options.active, totalMinutes: 0 };
  page.on('pageerror', error => pageErrors.push(error.message));
  const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://timer.test') { unexpected.push(url.origin); await route.abort(); return; }
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' });
      return;
    }
    const rpc = url.pathname.startsWith('/api/trpc/');
    const procedure = rpc ? url.pathname.slice('/api/trpc/'.length) : null;
    let input = request.postData() ? JSON.parse(request.postData()) : null;
    if (rpc && !input && url.searchParams.has('input')) input = JSON.parse(url.searchParams.get('input'));
    if (rpc && input) input = superjson.deserialize(input);
    const call = { path: url.pathname, procedure, input, method: request.method() };
    calls.push(call);
    if (await options.handle?.({ route, call, state, json })) return;
    if (url.pathname === '/api/time-tracking/active') {
      await json(route, { active: Boolean(state.active), entry: state.active }); return;
    }
    if (url.pathname.startsWith('/api/time-tracking/task/')) {
      await json(route, { totalMinutes: state.totalMinutes, complete: true, unresolvedEntryCount: 0 }); return;
    }
    if (url.pathname === '/api/time-tracking/start') {
      state.active = active(23, input.taskId);
      await json(route, { success: true, entry: state.active }); return;
    }
    if (['/api/time-tracking/stop', '/api/time-tracking/pause'].includes(url.pathname)) {
      const entry = state.active;
      state.active = null; state.totalMinutes = 5;
      await json(route, { success: true, entry, paused: url.pathname.endsWith('pause') }); return;
    }
    if (rpc) {
      const defaults = {
        'auth.me': { id: 12, openId: 'worker-12', name: 'Worker', role: 'worker' },
        'timer.getDateContext': { timezone: 'Africa/Nairobi', date: '2026-10-21', startDate: '2026-10-19', endDate: '2026-10-25' },
        'timer.getActive': state.active, 'timer.getDailySummary': [], 'timer.getWeeklyTotal': { totalHours: 0 },
        'timer.getWeeklyBreakdown': [], 'trello.weeklyHours': {}, 'settings.getDailyGoal': { hours: 9 },
        'operator.getWorkQueueContext': { cards: [{ cardId: 'task-a', cardName: 'Task A', cardUrl: '#', boardName: 'Board',
          listName: 'DOING', primaryState: 'doing', actionability: 'ready', priorityScore: 10, priorityTier: 'NORMAL',
          nextBestAction: 'Review the work', waitingReason: null, steps: [], evidenceSummary: { sources: [], forecast: null } }] },
        'trello.actionAlerts': { doingCards: [], onHoldCards: [], overdueCards: [] },
        'operator.getGoogleEvidenceStatus': { gmail: {}, drive: {} }, 'operator.getDailyPlan': {},
        'operator.getBrowserTabStatus': {},
      };
      if (procedure === 'operator.getManagerStatus') {
        await json(route, { error: { json: { code: -32003,
          message: 'Manager pilot requires an explicitly allowlisted worker, valid APTLSS_MANAGER_PILOT_WORKER_IDS, and APTLSS_MANAGER_SHADOW_ONLY=true.',
          data: { code: 'FORBIDDEN', httpStatus: 403 } } } }, 403); return;
      }
      if (procedure === 'timer.stop') {
        const entry = state.active; state.active = null;
        await json(route, rpcData(entry)); return;
      }
      if (procedure === 'timer.start') {
        state.active = active(23, input.cardId);
        await json(route, rpcData(state.active)); return;
      }
      if (Object.hasOwn(defaults, procedure)) { await json(route, rpcData(defaults[procedure])); return; }
    }
    unexpected.push(url.pathname);
    await route.abort();
  });
  await page.goto('http://timer.test/');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(({ kind, compact }) => window.mountTimer(kind, 'task-a', compact), { kind, compact: options.compact ?? false });
  return { page, calls, state, postCalls: () => calls.filter(call => call.method === 'POST'),
    async close() {
      await context.close();
      assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
    } };
}

for (const action of ['stop', 'pause']) {
  test(`REST ${action} submits the displayed canonical entry once, including rapid duplicate clicks`, async () => {
    const gate = deferred();
    const f = await fixture('rest', { handle: async ({ route, call, state, json }) => {
      if (call.path !== `/api/time-tracking/${action}`) return false;
      await gate.promise;
      const entry = state.active; state.active = null;
      await json(route, { success: true, entry }); return true;
    } });
    try {
      await expect(f.page.getByRole('button', { name: action === 'stop' ? 'Stop' : 'Pause', exact: true })).toBeEnabled();
      await f.page.evaluate(action => {
        const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim().toLowerCase() === action);
        button.click(); button.click();
      }, action);
      await expect.poll(() => f.postCalls().length).toBe(1);
      assert.deepEqual(f.postCalls()[0].input, { entryId: 17 });
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
      await expect(f.page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
      gate.release();
      await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
      assert.equal(f.postCalls().length, 1);
    } finally { gate.release(); await f.close(); }
  });
}

test('REST stale A stop refreshes B after 409 but never retries or claims success', async () => {
  const f = await fixture('rest', { handle: async ({ route, call, state, json }) => {
    if (call.path !== '/api/time-tracking/stop') return false;
    state.active = active(18);
    await json(route, { error: 'PRIVATE_DIAGNOSTIC_NOT_FOR_WORKER' }, 409); return true;
  } });
  try {
    await f.page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(f.page.getByRole('status').filter({ hasText: 'Timer status changed' })).toBeVisible();
    assert.deepEqual(f.postCalls().map(call => call.input), [{ entryId: 17 }]);
    assert.ok(f.calls.filter(call => call.path === '/api/time-tracking/active').length >= 2);
    assert.deepEqual(await f.page.evaluate(() => window.timerNotices), []);
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    await f.page.getByRole('button', { name: 'Reload timer status' }).click();
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    assert.equal(f.postCalls().length, 1);
    await expect(f.page.locator('body')).not.toContainText('PRIVATE_DIAGNOSTIC');
  } finally { await f.close(); }
});

test('REST cannot implicitly stop-and-switch to a different task', async () => {
  const f = await fixture('rest', { active: active(17, 'other-task') });
  try {
    await expect(f.page.getByRole('status').filter({ hasText: 'Stop it before starting this task' })).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
    assert.equal(f.postCalls().length, 0);
  } finally { await f.close(); }
});

test('REST rejects missing entry IDs with an honest reload action, including compact controls', async () => {
  const f = await fixture('rest', { compact: true, active: { ...active(), id: undefined } });
  try {
    await expect(f.page.getByRole('status').filter({ hasText: 'could not be identified' })).toBeVisible();
    await expect(f.page.getByTitle('Stop', { exact: true })).toBeDisabled();
    await expect(f.page.getByTitle('Pause', { exact: true })).toBeDisabled();
    assert.equal(f.postCalls().length, 0);
    f.state.active = active(21);
    await f.page.getByRole('button', { name: 'Reload timer status' }).click();
    await f.page.getByTitle('Stop', { exact: true }).click();
    await expect.poll(() => f.postCalls().length).toBe(1);
    assert.deepEqual(f.postCalls()[0].input, { entryId: 21 });
  } finally { await f.close(); }
});

test('REST failed status reads do not enable Start or invent an empty active timer', async () => {
  let unavailable = true;
  const f = await fixture('rest', { active: null, handle: async ({ route, call, json }) => {
    if (call.path !== '/api/time-tracking/active' || !unavailable) return false;
    await json(route, { error: 'private' }, 503); return true;
  } });
  try {
    await expect(f.page.getByRole('status').filter({ hasText: 'Timer status could not be loaded' })).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
    unavailable = false;
    await f.page.getByRole('button', { name: 'Reload timer status' }).click();
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    assert.equal(f.postCalls().length, 0);
  } finally { await f.close(); }
});

test('REST preserves the start result entry ID and disallows duplicate pending starts', async () => {
  const gate = deferred();
  const f = await fixture('rest', { active: null, handle: async ({ route, call, state, json }) => {
    if (call.path !== '/api/time-tracking/start') return false;
    await gate.promise; state.active = active(31);
    await json(route, { success: true, entry: state.active }); return true;
  } });
  try {
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    await f.page.evaluate(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Start'); button.click(); button.click(); });
    await expect.poll(() => f.postCalls().length).toBe(1);
    gate.release();
    await f.page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => f.postCalls().length).toBe(2);
    assert.deepEqual(f.postCalls()[1].input, { entryId: 31 });
  } finally { gate.release(); await f.close(); }
});

test('REST discards a late active read from a previously displayed task', async () => {
  const gate = deferred();
  let reads = 0;
  const f = await fixture('rest', { active: null, handle: async ({ route, call, json }) => {
    if (call.path !== '/api/time-tracking/active' || ++reads !== 1) return false;
    await gate.promise;
    await json(route, { active: true, entry: active(17, 'task-a') }); return true;
  } });
  try {
    await expect.poll(() => reads).toBe(1);
    await f.page.evaluate(() => window.mountTimer('rest', 'task-b'));
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    gate.release(); await f.page.waitForTimeout(50);
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    await f.page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(() => f.postCalls().length).toBe(1);
    assert.equal(f.postCalls()[0].input.taskId, 'task-b');
  } finally { gate.release(); await f.close(); }
});

test('REST mismatched acknowledgement never claims that the displayed timer stopped', async () => {
  const f = await fixture('rest', { handle: async ({ route, call, json }) => {
    if (call.path !== '/api/time-tracking/stop') return false;
    await json(route, { success: true, entry: active(999) }); return true;
  } });
  try {
    await f.page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(f.page.getByRole('status').filter({ hasText: 'change was not confirmed' })).toBeVisible();
    assert.equal((await f.page.evaluate(() => window.timerNotices)).length, 0);
    assert.deepEqual(f.postCalls()[0].input, { entryId: 17 });
  } finally { await f.close(); }
});

test('Manus stop retains entry A and card context through a B refresh and conflict; never auto-retries', async () => {
  const gate = deferred();
  const f = await fixture('manus', { handle: async ({ route, call, json }) => {
    if (call.procedure !== 'timer.stop') return false;
    await gate.promise; await json(route, rpcError('CONFLICT'), 409); return true;
  } });
  try {
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
    await f.page.evaluate(() => {
      for (const button of [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === 'Stop')) { button.click(); button.click(); }
    });
    await expect.poll(() => f.postCalls().length).toBe(1);
    assert.deepEqual(f.postCalls()[0].input, { entryId: 17, cardId: 'task-a' });
    f.state.active = { ...active(18), cardName: 'Replacement timer' };
    await f.page.evaluate(() => window.refreshTimer());
    await expect(f.page.getByText('Replacement timer', { exact: true })).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeDisabled();
    gate.release();
    await expect(f.page.getByRole('status').filter({ hasText: 'Timer status changed' })).toBeVisible();
    await f.page.waitForTimeout(80);
    assert.equal(f.postCalls().length, 1);
    assert.equal((await f.page.evaluate(() => window.timerNotices)).some(notice => notice.kind === 'success'), false);
    await expect(f.page.locator('body')).not.toContainText('PRIVATE_DIAGNOSTIC');
  } finally { gate.release(); await f.close(); }
});

test('Manus missing ID disables both Stop controls until the current entry is reloaded', async () => {
  const f = await fixture('manus', { active: { ...active(), id: undefined } });
  try {
    await expect(f.page.getByRole('status').filter({ hasText: 'could not be identified' })).toBeVisible();
    for (const button of await f.page.getByRole('button', { name: 'Stop', exact: true }).all()) await expect(button).toBeDisabled();
    assert.equal(f.postCalls().length, 0);
    f.state.active = active(25);
    await f.page.getByRole('button', { name: 'Reload timer status' }).click();
    await f.page.getByRole('button', { name: 'Stop', exact: true }).first().click();
    await expect.poll(() => f.postCalls().length).toBe(1);
    assert.deepEqual(f.postCalls()[0].input, { entryId: 25, cardId: 'task-a' });
  } finally { await f.close(); }
});

for (const ack of [null, { id: 999 }]) {
  test(`Manus refuses unmatched stop acknowledgement ${JSON.stringify(ack)}`, async () => {
    const f = await fixture('manus', { handle: async ({ route, call, json }) => {
      if (call.procedure !== 'timer.stop') return false;
      await json(route, rpcData(ack)); return true;
    } });
    try {
      await f.page.getByRole('button', { name: 'Stop', exact: true }).first().click();
      await expect(f.page.getByRole('status').filter({ hasText: 'stop was not confirmed' })).toBeVisible();
      assert.equal((await f.page.evaluate(() => window.timerNotices)).some(notice => notice.kind === 'success'), false);
      assert.equal(f.postCalls().length, 1);
    } finally { await f.close(); }
  });
}

test('Manus authentication/status read failure is visible, not a fake empty timer', async () => {
  const f = await fixture('manus', { handle: async ({ route, call, json }) => {
    if (call.procedure !== 'timer.getActive') return false;
    await json(route, rpcError('INTERNAL_SERVER_ERROR'), 503); return true;
  } });
  try {
    await expect(f.page.getByRole('status').filter({ hasText: 'Timer status could not be loaded' })).toBeVisible();
    await expect(f.page.locator('body')).not.toContainText('No timer running');
    assert.equal(f.postCalls().length, 0);
  } finally { await f.close(); }
});

test('Manus failed stop does not inherit automatic retries or print backend diagnostics', async () => {
  const f = await fixture('manus', { handle: async ({ route, call, json }) => {
    if (call.procedure !== 'timer.stop') return false;
    await json(route, rpcError('INTERNAL_SERVER_ERROR'), 503); return true;
  } });
  try {
    await f.page.getByRole('button', { name: 'Stop', exact: true }).first().click();
    await expect(f.page.getByRole('status').filter({ hasText: 'stop was not confirmed' })).toBeVisible();
    await f.page.waitForTimeout(80);
    assert.equal(f.postCalls().length, 1);
    await expect(f.page.locator('body')).not.toContainText('PRIVATE_DIAGNOSTIC');
  } finally { await f.close(); }
});

test('Worker Today start rejects implicit switching and refreshes a conflict without success', async () => {
  const f = await fixture('today', { active: null, handle: async ({ route, call, state, json }) => {
    if (call.procedure !== 'timer.start') return false;
    state.active = { ...active(50, 'task-b'), cardName: 'Already running task' };
    await json(route, rpcError('CONFLICT'), 409); return true;
  } });
  try {
    await expect(f.page.getByRole('button', { name: 'Start timer', exact: true })).toBeEnabled();
    await f.page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Start timer');
      button.click(); button.click();
    });
    await expect(f.page.getByRole('button', { name: 'Timer running on another task', exact: true })).toBeDisabled();
    assert.equal(f.postCalls().length, 1);
    const notices = await f.page.evaluate(() => window.timerNotices);
    assert.equal(notices.some(notice => notice.kind === 'success'), false);
    assert.equal(notices.some(notice => notice.message.includes('Stop the running timer')), true);
    await expect(f.page.locator('body')).not.toContainText('PRIVATE_DIAGNOSTIC');
  } finally { await f.close(); }
});

test('Worker Today requires an explicit identity-bound stop before another start', async () => {
  const f = await fixture('today');
  try {
    await expect(f.page.getByRole('button', { name: 'Timer running', exact: true })).toBeDisabled();
    await f.page.getByRole('button', { name: 'Stop timer', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Start timer', exact: true })).toBeEnabled();
    assert.deepEqual(f.postCalls().map(call => call.input), [{ entryId: 17, cardId: 'task-a' }]);
    await f.page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await expect.poll(() => f.postCalls().length).toBe(2);
    assert.equal(f.postCalls()[1].procedure, 'timer.start');
    assert.equal(f.postCalls()[1].input.cardId, 'task-a');
  } finally { await f.close(); }
});

for (const action of ['stop', 'pause']) {
  test(`REST matched ${action} clears A and elapsed time even when the refresh fails`, async () => {
    let acknowledged = false;
    const f = await fixture('rest', { active: { ...active(), startTime: new Date(Date.now() - 120_000).toISOString() },
      handle: async ({ route, call, json }) => {
        if (call.path === `/api/time-tracking/${action}`) {
          acknowledged = true;
          await json(route, { success: true, entry: active(17) }); return true;
        }
        if (acknowledged && call.path === '/api/time-tracking/active') {
          await json(route, { error: 'private' }, 503); return true;
        }
        return false;
      } });
    try {
      await expect(f.page.locator('.font-mono')).toContainText('02:');
      await f.page.getByRole('button', { name: action === 'stop' ? 'Stop' : 'Pause', exact: true }).click();
      await expect(f.page.getByRole('status').filter({ hasText: 'Timer status could not be loaded' })).toBeVisible();
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(f.page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
      await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
      await expect(f.page.locator('.font-mono')).toHaveText('00:00');
      await expect(f.page.getByText('Total Tracked').locator('..')).toHaveText('Total Tracked0m');
      await f.page.waitForTimeout(1100);
      await expect(f.page.locator('.font-mono')).toHaveText('00:00');
      assert.equal(f.postCalls().length, 1);
    } finally { await f.close(); }
  });

  test(`REST late matched ${action} ACK for A preserves refreshed B and its elapsed time`, async () => {
    const gate = deferred();
    let acknowledged = false;
    const f = await fixture('rest', { handle: async ({ route, call, json }) => {
      if (call.path === `/api/time-tracking/${action}`) {
        await gate.promise; acknowledged = true;
        await json(route, { success: true, entry: active(17) }); return true;
      }
      if (acknowledged && call.path === '/api/time-tracking/active') {
        await json(route, { error: 'private' }, 503); return true;
      }
      return false;
    } });
    try {
      await f.page.getByRole('button', { name: action === 'stop' ? 'Stop' : 'Pause', exact: true }).click();
      await expect.poll(() => f.postCalls().length).toBe(1);
      f.state.active = { ...active(18, 'task-b'), startTime: new Date(Date.now() - 300_000).toISOString() };
      await f.page.evaluate(() => window.mountTimer('rest', 'task-b'));
      await expect(f.page.locator('.font-mono')).toContainText('05:');
      gate.release();
      await expect(f.page.getByRole('status').filter({ hasText: 'Timer status could not be loaded' })).toBeVisible();
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
      await expect(f.page.locator('.font-mono')).toContainText('05:');
      await expect(f.page.getByText('Total Tracked').locator('..')).toHaveText('Total Tracked5m');
      assert.deepEqual(f.postCalls().map(call => call.input), [{ entryId: 17 }]);
    } finally { gate.release(); await f.close(); }
  });
}

for (const kind of ['manus', 'today']) {
  const stopName = kind === 'manus' ? 'Stop' : 'Stop timer';
  test(`${kind} matched stop ACK clears A before a failed active refresh, showing unknown status`, async () => {
    let acknowledged = false;
    const f = await fixture(kind, { handle: async ({ route, call, json }) => {
      if (call.procedure === 'timer.stop') {
        acknowledged = true;
        await json(route, rpcData(active(17))); return true;
      }
      if (acknowledged && call.procedure === 'timer.getActive') {
        await json(route, rpcError('INTERNAL_SERVER_ERROR'), 503); return true;
      }
      return false;
    } });
    try {
      await f.page.getByRole('button', { name: stopName, exact: true }).first().click();
      await expect(f.page.getByRole('status').filter({ hasText: 'status could not be loaded' })).toBeVisible();
      await expect(f.page.getByRole('button', { name: stopName, exact: true })).toHaveCount(0);
      await expect(f.page.locator('body')).not.toContainText('Timer still running');
      await expect(f.page.locator('body')).not.toContainText('Timer running for');
      await expect(f.page.locator('body')).not.toContainText('No timer running');
      if (kind === 'today') await expect(f.page.getByRole('button', { name: 'Start timer', exact: true })).toBeDisabled();
      assert.equal(f.postCalls().length, 1);
    } finally { await f.close(); }
  });

  test(`${kind} late matched ACK for A preserves already refreshed B through a failed refresh`, async () => {
    const gate = deferred();
    let acknowledged = false;
    const f = await fixture(kind, { handle: async ({ route, call, json }) => {
      if (call.procedure === 'timer.stop') {
        await gate.promise; acknowledged = true;
        await json(route, rpcData(active(17))); return true;
      }
      if (acknowledged && call.procedure === 'timer.getActive') {
        await json(route, rpcError('INTERNAL_SERVER_ERROR'), 503); return true;
      }
      return false;
    } });
    try {
      await f.page.getByRole('button', { name: stopName, exact: true }).first().click();
      await expect.poll(() => f.postCalls().length).toBe(1);
      f.state.active = { ...active(18, 'task-b'), cardName: 'Replacement B' };
      await f.page.evaluate(() => window.refreshTimer());
      await expect(f.page.getByText(kind === 'manus' ? 'Replacement B'
        : 'Timer running for Replacement B. Stop it before starting another task.', { exact: true })).toBeVisible();
      gate.release();
      await expect(f.page.getByRole('status').filter({ hasText: 'status could not be loaded' })).toBeVisible();
      await expect(f.page.getByRole('button', { name: stopName, exact: true }).first()).toBeDisabled();
      await expect(f.page.locator('body')).toContainText('Replacement B');
      assert.deepEqual(f.postCalls().map(call => call.input), [{ entryId: 17, cardId: 'task-a' }]);
    } finally { gate.release(); await f.close(); }
  });

  for (const failure of ['mismatched ACK', 'non-200']) {
    test(`${kind} ${failure} never clears A when subsequent reads fail`, async () => {
      let submitted = false;
      const f = await fixture(kind, { handle: async ({ route, call, json }) => {
        if (call.procedure === 'timer.stop') {
          submitted = true;
          await json(route, failure === 'non-200' ? rpcError('INTERNAL_SERVER_ERROR') : rpcData(active(999)),
            failure === 'non-200' ? 503 : 200); return true;
        }
        if (submitted && call.procedure === 'timer.getActive') {
          await json(route, rpcError('INTERNAL_SERVER_ERROR'), 503); return true;
        }
        return false;
      } });
      try {
        await f.page.getByRole('button', { name: stopName, exact: true }).first().click();
        await expect(f.page.getByRole('button', { name: stopName, exact: true }).first()).toBeDisabled();
        await expect.poll(async () => (await f.page.getByRole('status').allTextContents()).join(' ')).toMatch(/not confirmed|could not be loaded/);
        await expect(f.page.locator('body')).toContainText(kind === 'manus' ? 'Timer still running' : 'Timer running for Task A');
        assert.equal((await f.page.evaluate(() => window.timerNotices)).some(notice => notice.kind === 'success'), false);
        assert.equal(f.postCalls().length, 1);
      } finally { await f.close(); }
    });
  }
}

for (const action of ['stop', 'pause']) {
  for (const failure of ['mismatched ACK', 'non-200']) {
    test(`REST ${action} ${failure} preserves A and does not claim success`, async () => {
      const f = await fixture('rest', { handle: async ({ route, call, json }) => {
        if (call.path !== `/api/time-tracking/${action}`) return false;
        await json(route, { success: true, entry: active(failure === 'mismatched ACK' ? 999 : 17) },
          failure === 'non-200' ? 503 : 200); return true;
      } });
      try {
        await f.page.getByRole('button', { name: action === 'stop' ? 'Stop' : 'Pause', exact: true }).click();
        await expect(f.page.getByRole('status').filter({ hasText: 'change was not confirmed' })).toBeVisible();
        await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
        await expect(f.page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
        await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
        assert.equal((await f.page.evaluate(() => window.timerNotices)).some(notice => notice.kind === 'success'), false);
        assert.equal(f.postCalls().length, 1);
      } finally { await f.close(); }
    });
  }
}

for (const compact of [false, true]) {
  test(`REST incomplete history hides totals/progress but permits a known active stop (compact=${compact})`, async () => {
    const f = await fixture('rest', { compact, handle: async ({ route, call, json }) => {
      if (!call.path.startsWith('/api/time-tracking/task/')) return false;
      await json(route, { totalMinutes: 0, complete: false, unresolvedEntryCount: 2 }); return true;
    } });
    try {
      await expect(f.page.getByRole('status')).toContainText('History needs owner review');
      await expect(f.page.getByText('Progress vs Estimate')).toHaveCount(0);
      if (!compact) await expect(f.page.getByText('Total Tracked').locator('..')).toHaveText('Total TrackedUnavailable');
      const stop = compact ? f.page.getByTitle('Stop', { exact: true }) : f.page.getByRole('button', { name: 'Stop', exact: true });
      await expect(stop).toBeEnabled();
      await stop.click();
      await expect.poll(() => f.postCalls().length).toBe(1);
      assert.deepEqual(f.postCalls()[0].input, { entryId: 17 });
      await expect(f.page.getByRole('status')).toContainText('History needs owner review');
      await expect(compact ? f.page.getByTitle('Start Timer', { exact: true })
        : f.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    } finally { await f.close(); }
  });
}

for (const failure of ['HTTP 503', 'missing completeness']) {
  test(`REST ${failure} history is unavailable without blocking known active controls`, async () => {
    const f = await fixture('rest', { handle: async ({ route, call, json }) => {
      if (!call.path.startsWith('/api/time-tracking/task/')) return false;
      await json(route, { totalMinutes: 0 }, failure === 'HTTP 503' ? 503 : 200); return true;
    } });
    try {
      await expect(f.page.getByRole('status')).toContainText('History unavailable');
      await expect(f.page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
      await expect(f.page.getByText('Progress vs Estimate')).toHaveCount(0);
      await expect(f.page.getByText('Total Tracked').locator('..')).toContainText('Unavailable');
      await f.page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect.poll(() => f.postCalls().length).toBe(1);
      assert.deepEqual(f.postCalls()[0].input, { entryId: 17 });
    } finally { await f.close(); }
  });
}

test('REST pending history does not delay the active entry or claim zero progress', async () => {
  const gate = deferred();
  const f = await fixture('rest', { handle: async ({ route, call, json }) => {
    if (!call.path.startsWith('/api/time-tracking/task/')) return false;
    await gate.promise;
    await json(route, { totalMinutes: 0, complete: true, unresolvedEntryCount: 0 }); return true;
  } });
  try {
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(f.page.getByRole('status')).toContainText('Loading history');
    await expect(f.page.getByText('Progress vs Estimate')).toHaveCount(0);
    await expect(f.page.getByText('Total Tracked').locator('..')).toContainText('Unavailable');
    gate.release();
    await expect(f.page.getByText('Progress vs Estimate')).toBeVisible();
    await expect(f.page.getByText('Total Tracked').locator('..')).toHaveText('Total Tracked0m');
  } finally { gate.release(); await f.close(); }
});

for (const procedure of ['timer.getDailySummary', 'timer.getWeeklyTotal', 'timer.getWeeklyBreakdown']) {
  test(`Manus ${procedure} owner precondition hides history/progress and still allows canonical stop`, async () => {
    const f = await fixture('manus', { handle: async ({ route, call, json }) => {
      if (call.procedure !== procedure) return false;
      await json(route, rpcError('PRECONDITION_FAILED'), 412); return true;
    } });
    try {
      await expect(f.page.getByRole('status')).toHaveText('History needs owner review');
      await expect(f.page.getByText('This Week', { exact: true })).toHaveCount(0);
      await expect(f.page.getByText('No time tracked today yet.', { exact: true })).toHaveCount(0);
      await expect(f.page.locator('circle[cx="36"]')).toHaveCount(0);
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
      await f.page.getByRole('button', { name: 'Stop', exact: true }).first().click();
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(f.page.getByRole('status')).toHaveText('History needs owner review');
      await expect(f.page.getByText('No time tracked today yet.', { exact: true })).toHaveCount(0);
      assert.deepEqual(f.postCalls().map(call => call.input), [{ entryId: 17, cardId: 'task-a' }]);
      await expect(f.page.locator('body')).not.toContainText('PRIVATE_DIAGNOSTIC');
    } finally { await f.close(); }
  });
}

test('Manus loading history hides goal progress until the response arrives', async () => {
  const gate = deferred();
  const f = await fixture('manus', { handle: async ({ route, call, json }) => {
    if (call.procedure !== 'timer.getDailySummary') return false;
    await gate.promise; await json(route, rpcData([])); return true;
  } });
  try {
    await expect(f.page.getByRole('status')).toHaveText('Loading history...');
    await expect(f.page.locator('circle[cx="36"]')).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
    gate.release();
    await expect(f.page.getByText('This Week', { exact: true })).toBeVisible();
  } finally { gate.release(); await f.close(); }
});

test('Manus refetch failure hides previously cached totals instead of trusting stale history', async () => {
  let failed = false;
  const f = await fixture('manus', { handle: async ({ route, call, json }) => {
    if (call.procedure !== 'timer.getWeeklyTotal') return false;
    await json(route, failed ? rpcError('INTERNAL_SERVER_ERROR') : rpcData({ totalHours: 12 }), failed ? 503 : 200);
    return true;
  } });
  try {
    await expect(f.page.getByText('12h', { exact: true })).toBeVisible();
    failed = true;
    await f.page.evaluate(() => window.refreshTimer());
    await expect(f.page.getByRole('status')).toHaveText('History unavailable');
    await expect(f.page.getByText('12h', { exact: true })).toHaveCount(0);
    await expect(f.page.locator('circle[cx="36"]')).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
  } finally { await f.close(); }
});

for (const code of ['PRECONDITION_FAILED', 'INTERNAL_SERVER_ERROR']) {
  test(`Home hours chip ${code} does not present an empty history as 0h`, async () => {
    const f = await fixture('hours-chip', { handle: async ({ route, call, json }) => {
      if (call.procedure !== 'timer.getDailySummary') return false;
      await json(route, rpcError(code), code === 'PRECONDITION_FAILED' ? 412 : 503); return true;
    } });
    try {
      await expect(f.page.getByRole('status')).toHaveText(code === 'PRECONDITION_FAILED' ? 'History needs owner review' : 'History unavailable');
      await expect(f.page.locator('body')).not.toContainText('0h today');
      await expect(f.page.locator('body')).not.toContainText('PRIVATE_DIAGNOSTIC');
    } finally { await f.close(); }
  });
}

test('Home hours chip shows loading, then displays a confirmed empty history as zero', async () => {
  const gate = deferred();
  const f = await fixture('hours-chip', { handle: async ({ route, call, json }) => {
    if (call.procedure !== 'timer.getDailySummary') return false;
    await gate.promise; await json(route, rpcData([])); return true;
  } });
  try {
    await expect(f.page.getByRole('status')).toHaveText('Loading history...');
    await expect(f.page.locator('body')).not.toContainText('0h today');
    gate.release();
    await expect(f.page.getByText('0h today', { exact: true })).toBeVisible();
  } finally { gate.release(); await f.close(); }
});

for (const completeness of [false, undefined]) {
  test(`Mounted REST weekly progress rejects incomplete/unverified history (${completeness})`, async () => {
    const f = await fixture('weekly', { handle: async ({ route, call, json }) => {
      if (call.path === '/api/time-tracking/weekly-progress') {
        await json(route, { complete: completeness, unresolvedEntryCount: completeness === false ? 1 : undefined,
          actualHours: 0, actualMinutes: 0, dailyHours: {}, weeklyHoursMin: 55, weeklyHoursMax: 60 }); return true;
      }
      if (call.path === '/api/atis/timeline-tasks') { await json(route, { tasks: [] }); return true; }
      return false;
    } });
    try {
      await expect(f.page.getByRole('status')).toHaveText(completeness === false ? 'History needs owner review' : 'History unavailable');
      await expect(f.page.getByText('Completion Rate', { exact: true })).toHaveCount(0);
      await expect(f.page.getByText('Time evidence', { exact: true })).toHaveCount(0);
      await expect(f.page.locator('body')).not.toContainText('0h');
    } finally { await f.close(); }
  });
}

const historyProcedures = ['timer.getDailySummary', 'timer.getWeeklyTotal', 'timer.getWeeklyBreakdown'];

test('REST start ACK plus verified active A permits Stop while history hangs, without duplicate writes', async () => {
  const historyGate = deferred(), stopGate = deferred();
  let started = false, historyPending = false;
  const f = await fixture('rest', { active: null, handle: async ({ route, call, state, json }) => {
    if (call.path === '/api/time-tracking/start') {
      started = true; state.active = active(23);
      await json(route, { success: true, entry: state.active }); return true;
    }
    if (started && call.path.startsWith('/api/time-tracking/task/')) {
      historyPending = true;
      await historyGate.promise;
      await json(route, { totalMinutes: 0, complete: true, unresolvedEntryCount: 0 }); return true;
    }
    if (call.path === '/api/time-tracking/stop') {
      const entry = state.active;
      await stopGate.promise; state.active = null;
      await json(route, { success: true, entry }); return true;
    }
    return false;
  } });
  try {
    await f.page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(() => historyPending).toBe(true);
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(f.page.getByRole('status')).toHaveText('Loading history...');
    await f.page.evaluate(() => {
      const stop = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Stop');
      stop.click(); stop.click();
    });
    await expect.poll(() => f.postCalls().length).toBe(2);
    assert.deepEqual(f.postCalls()[1].input, { entryId: 23 });
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    stopGate.release();
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    await expect(f.page.getByRole('status')).toHaveText('Loading history...');
    assert.equal(f.postCalls().length, 2);
  } finally { historyGate.release(); stopGate.release(); await f.close(); }
});

test('REST start ACK does not bypass a failed active verification while history hangs', async () => {
  const historyGate = deferred();
  let started = false;
  const f = await fixture('rest', { active: null, handle: async ({ route, call, state, json }) => {
    if (call.path === '/api/time-tracking/start') {
      started = true; state.active = active(23);
      await json(route, { success: true, entry: state.active }); return true;
    }
    if (started && call.path === '/api/time-tracking/active') {
      await json(route, { error: 'private' }, 503); return true;
    }
    if (started && call.path.startsWith('/api/time-tracking/task/')) {
      await historyGate.promise;
      await json(route, { totalMinutes: 0, complete: true, unresolvedEntryCount: 0 }); return true;
    }
    return false;
  } });
  try {
    await f.page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(f.page.getByRole('status').filter({ hasText: 'Timer status could not be loaded' })).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    await expect(f.page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Reload timer status' })).toBeEnabled();
    assert.equal(f.postCalls().length, 1);
  } finally { historyGate.release(); await f.close(); }
});

for (const ancillary of ['date context', 'history']) {
  test(`Manus stop ACK settles while ${ancillary} hangs, preserving a stoppable verified replacement B`, async () => {
    const ancillaryGate = deferred(), stopGate = deferred();
    let stoppedA = false, ancillaryPending = false;
    const f = await fixture('manus', { handle: async ({ route, call, state, json }) => {
      if ((ancillary === 'date context' && call.procedure === 'timer.getDateContext')
        || (ancillary === 'history' && stoppedA && historyProcedures.includes(call.procedure))) {
        ancillaryPending = true;
        await ancillaryGate.promise;
        await json(route, rpcError('INTERNAL_SERVER_ERROR'), 503); return true;
      }
      if (call.procedure === 'timer.stop') {
        const entry = state.active;
        if (!stoppedA) {
          stoppedA = true;
          state.active = { ...active(18), cardName: 'Verified replacement B' };
        } else {
          await stopGate.promise; state.active = null;
        }
        await json(route, rpcData(entry)); return true;
      }
      return false;
    } });
    try {
      await f.page.getByRole('button', { name: 'Stop', exact: true }).first().click();
      await expect.poll(() => ancillaryPending).toBe(true);
      await expect(f.page.getByText('Verified replacement B', { exact: true })).toBeVisible();
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
      await f.page.evaluate(() => {
        const stop = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Stop');
        stop.click(); stop.click();
      });
      await expect.poll(() => f.postCalls().length).toBe(2);
      assert.deepEqual(f.postCalls().map(call => call.input), [
        { entryId: 17, cardId: 'task-a' }, { entryId: 18, cardId: 'task-a' },
      ]);
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeDisabled();
      stopGate.release();
      await expect(f.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      assert.equal(f.postCalls().length, 2);
    } finally { ancillaryGate.release(); stopGate.release(); await f.close(); }
  });
}

const dateContexts = [
  { timezone: 'America/Los_Angeles', date: '2026-10-18', startDate: '2026-10-12', endDate: '2026-10-18' },
  { timezone: 'Asia/Tokyo', date: '2026-10-19', startDate: '2026-10-19', endDate: '2026-10-25' },
];
for (const kind of ['manus', 'hours-chip']) {
  for (const dateContext of dateContexts) {
    test(`${kind} uses server ${dateContext.timezone} day/week at a Sunday/Monday boundary`, async () => {
      const f = await fixture(kind, { handle: async ({ route, call, json }) => {
        if (call.procedure !== 'timer.getDateContext') return false;
        await json(route, rpcData(dateContext)); return true;
      } });
      try {
        await expect.poll(() => f.calls.filter(call => call.procedure === 'timer.getDailySummary').length).toBe(1);
        assert.deepEqual(f.calls.find(call => call.procedure === 'timer.getDailySummary').input, { date: dateContext.date });
        if (kind === 'manus') {
          await expect(f.page.getByText('This Week', { exact: true })).toBeVisible();
          for (const procedure of ['timer.getWeeklyTotal', 'timer.getWeeklyBreakdown']) {
            assert.deepEqual(f.calls.find(call => call.procedure === procedure).input,
              { startDate: dateContext.startDate, endDate: dateContext.endDate });
          }
        }
      } finally { await f.close(); }
    });
  }

  for (const invalidContext of [null, { ...dateContexts[0], date: '2026-02-30' },
    { ...dateContexts[0], timezone: 'Not/AZone' }, { ...dateContexts[0], startDate: '2026-10-19' }]) {
    test(`${kind} unverified date context never starts history queries (${JSON.stringify(invalidContext)})`, async () => {
      const f = await fixture(kind, { handle: async ({ route, call, json }) => {
        if (call.procedure !== 'timer.getDateContext') return false;
        await json(route, rpcData(invalidContext)); return true;
      } });
      try {
        await expect.poll(() => f.calls.filter(call => call.procedure === 'timer.getDateContext').length).toBe(1);
        await expect(f.page.getByRole('status')).toHaveText('History unavailable');
        await f.page.waitForTimeout(50);
        assert.deepEqual(f.calls.filter(call => historyProcedures.includes(call.procedure)), []);
        if (kind === 'manus') {
          await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
          await expect(f.page.locator('circle[cx="36"]')).toHaveCount(0);
        } else await expect(f.page.locator('body')).not.toContainText('0h today');
      } finally { await f.close(); }
    });
  }

  test(`${kind} pending/failed date context does not invent a date or zero history`, async () => {
    const gate = deferred();
    const f = await fixture(kind, { handle: async ({ route, call, json }) => {
      if (call.procedure !== 'timer.getDateContext') return false;
      await gate.promise; await json(route, rpcError('INTERNAL_SERVER_ERROR'), 503); return true;
    } });
    try {
      await expect(f.page.getByRole('status')).toHaveText('History unavailable');
      assert.deepEqual(f.calls.filter(call => historyProcedures.includes(call.procedure)), []);
      if (kind === 'manus') {
        await f.page.getByRole('button', { name: 'Stop', exact: true }).first().click();
        await expect.poll(() => f.postCalls().length).toBe(1);
        assert.deepEqual(f.postCalls()[0].input, { entryId: 17, cardId: 'task-a' });
      }
      gate.release();
      await expect.poll(() => f.calls.filter(call => call.procedure === 'timer.getDateContext').length).toBe(1);
      await expect(f.page.getByRole('status')).toHaveText('History unavailable');
      assert.deepEqual(f.calls.filter(call => historyProcedures.includes(call.procedure)), []);
    } finally { gate.release(); await f.close(); }
  });

  test(`${kind} date-context refetch failure hides cached history`, async () => {
    let failed = false;
    const f = await fixture(kind, { handle: async ({ route, call, json }) => {
      if (call.procedure !== 'timer.getDateContext') return false;
      await json(route, failed ? rpcError('INTERNAL_SERVER_ERROR') : rpcData(dateContexts[0]), failed ? 503 : 200);
      return true;
    } });
    try {
      await expect(kind === 'manus' ? f.page.getByText('This Week', { exact: true })
        : f.page.getByText('0h today', { exact: true })).toBeVisible();
      failed = true;
      await f.page.evaluate(() => window.refreshTimer());
      await expect(f.page.getByRole('status')).toHaveText('History unavailable');
      await expect(f.page.getByText('0h today', { exact: true })).toHaveCount(0);
      await expect(f.page.getByText('This Week', { exact: true })).toHaveCount(0);
      if (kind === 'manus') await expect(f.page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
    } finally { await f.close(); }
  });

  test(`${kind} refreshes date context after 60 seconds and changes history keys across week rollover`, async () => {
    let context = dateContexts[0];
    const f = await fixture(kind, { clock: true, handle: async ({ route, call, json }) => {
      if (call.procedure !== 'timer.getDateContext') return false;
      await json(route, rpcData(context)); return true;
    } });
    try {
      await expect.poll(() => f.calls.filter(call => call.procedure === 'timer.getDailySummary').length).toBe(1);
      context = dateContexts[1];
      await f.page.clock.fastForward(60_001);
      await expect.poll(() => f.calls.filter(call => call.procedure === 'timer.getDateContext').length).toBeGreaterThanOrEqual(2);
      await expect.poll(() => f.calls.filter(call => call.procedure === 'timer.getDailySummary').at(-1)?.input).toEqual({ date: context.date });
      if (kind === 'manus') {
        for (const procedure of ['timer.getWeeklyTotal', 'timer.getWeeklyBreakdown']) {
          await expect.poll(() => f.calls.filter(call => call.procedure === procedure).at(-1)?.input)
            .toEqual({ startDate: context.startDate, endDate: context.endDate });
        }
      }
    } finally { await f.close(); }
  });
}
