import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import superjson from 'superjson';
import { weeklyPayRevision } from '../shared/financialRevision';

const root = resolve(import.meta.dirname, '..');
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {httpLink} from '@trpc/client';
      import superjson from 'superjson';
      import {trpc} from '@/lib/trpc';
      import WeeklyPayCalculator from '@/pages/manus/WeeklyPayCalculator';
      import Home from '@/pages/manus/Home';
      import {ThemeProvider} from '@/contexts/ThemeContext';
      import {TooltipProvider} from '@/components/ui/tooltip';
      const queries = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
      const rpc = trpc.createClient({links:[httpLink({url:'/api/trpc',transformer:superjson})]});
      const root = createRoot(document.getElementById('root'));
      function CalculatorHarness({initialWorker}) {
        const [worker,setWorker]=useState(initialWorker);
        return <><label>Financial worker<select aria-label="Financial worker" value={worker??''}
          onChange={event=>setWorker(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="">No worker</option><option value="1002">Worker A</option><option value="1003">Worker B</option>
        </select></label><WeeklyPayCalculator vaId={worker}/></>;
      }
      window.refreshFinancial = () => queries.invalidateQueries();
      window.mountFinancial = (view,initialWorker) => root.render(
        <React.StrictMode><trpc.Provider client={rpc} queryClient={queries}><QueryClientProvider client={queries}>
          <ThemeProvider defaultTheme="light"><TooltipProvider>
            {view==='home' ? <Home/> : <CalculatorHarness initialWorker={initialWorker}/>}
          </TooltipProvider></ThemeProvider>
        </QueryClientProvider></trpc.Provider></React.StrictMode>);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': resolve(root, 'client/src'), '@shared': resolve(root, 'shared') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  });
  bundle = result.outputFiles[0].text;
});

type Call = { procedure: string; method: string; input: any };
const saved = (vaId: number, meritM1: number, notes: string) => ({
  id: vaId + 10000, vaId, founderId: 1, paymentCycleId: null,
  meritM1, meritM2: 0, meritM3: 0, meritStreak: 0,
  demeritD1: 0, demeritD2: 0, demeritD3: 0, demeritD4: 0, demeritD5: 0, demeritD6: 0,
  demeritD7: 0, demeritD8: 0, demeritD9: 0, demeritD10: 0, demeritD11: 0,
  notes, weekStart: '2026-10-19', weekEnd: '2026-10-25', projectedPay: String(90 + 5 * meritM1),
});

async function fixture(page: Page, info: TestInfo, role: 'admin' | 'worker' = 'admin') {
  const origin = 'http://financial.test';
  const calls: Call[] = []; const unexpected: string[] = []; const errors: string[] = [];
  const state = { records: new Map<number, any>([[1002, saved(1002, 2, 'Worker A saved note')]]),
    holdWorkerB: false, releaseWorkerB: () => {}, holdSaveA: false, releaseSaveA: () => {} };
  let releaseB: () => void;
  const heldB = new Promise<void>(resolvePromise => { releaseB = resolvePromise; });
  state.releaseWorkerB = () => { state.holdWorkerB = false; releaseB(); };
  let releaseSaveA: () => void;
  const heldSaveA = new Promise<void>(resolvePromise => { releaseSaveA = resolvePromise; });
  state.releaseSaveA = () => { state.holdSaveA = false; releaseSaveA(); };
  const user = { id: role === 'admin' ? 1 : 1002, role, openId: `synthetic-financial-${role}`, name: 'Synthetic Financial User' };
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') });
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(`external ${url.origin}`); return route.abort(); }
    if (url.pathname === '/' && request.method() === 'GET') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' });
    }
    if (url.pathname.startsWith('/ws')) return route.fulfill({ status: 503, json: { error: 'Synthetic sockets disabled' } });
    if (url.pathname === '/api/va/worker/profile') return route.fulfill({ json: null });
    if (!url.pathname.startsWith('/api/trpc/')) { unexpected.push(url.pathname); return route.abort(); }
    const procedure = decodeURIComponent(url.pathname.slice('/api/trpc/'.length));
    const raw = request.postData() ?? url.searchParams.get('input');
    const input = raw ? superjson.deserialize(JSON.parse(raw)) : undefined;
    calls.push({ procedure, input, method: request.method() });
    const fulfill = (value: unknown) => route.fulfill({ json: { result: { data: superjson.serialize(value) } } });
    if (procedure === 'auth.me') return fulfill(user);
    if (procedure === 'payLog.getByWeek') {
      if ((input as any)?.vaId === 1003 && state.holdWorkerB) await heldB;
      return fulfill(state.records.get((input as any)?.vaId ?? user.id) ?? null);
    }
    if (procedure === 'payLog.getAll') return fulfill([]);
    if (procedure === 'payLog.upsert') {
      if ((input as any).vaId === 1002 && state.holdSaveA) await heldSaveA;
      const values = input as Record<string, any>;
      const previous = state.records.get(values.vaId) ?? null;
      const hasRevision = Object.hasOwn(values, 'expectedRevision')
        && (values.expectedRevision === null || typeof values.expectedRevision === 'string');
      if (!hasRevision || values.expectedRevision !== weeklyPayRevision(previous)) {
        const status = hasRevision ? 409 : 400;
        return route.fulfill({ status, json: { error: superjson.serialize({
          message: hasRevision ? 'The saved week changed; reload before saving.' : 'An expected revision is required.',
          code: hasRevision ? -32009 : -32600,
          data: { code: hasRevision ? 'CONFLICT' : 'BAD_REQUEST', httpStatus: status, path: procedure },
        }) } });
      }
      const { expectedRevision: _revision, ...submitted } = values;
      const updated = { ...saved(values.vaId, values.meritM1, values.notes ?? ''), ...previous, ...submitted };
      state.records.set(values.vaId, updated);
      return fulfill(updated);
    }
    const defaults: Record<string, unknown> = {
      'timer.getDateContext': { timezone: 'UTC', date: '2026-10-21', startDate: '2026-10-19', endDate: '2026-10-25' },
      'timer.getDailySummary': [], 'timer.getActive': null,
      'trello.weeklyHours': { totalHours: 0, targetHours: 40, dailyHours: [] }, 'trello.recentUpdates': [],
      'trello.actionAlerts': { noDueDateCards: [], overdueCards: [], doingCards: [], onHoldCards: [], dueTodayCards: [] },
      'streak.get': null, 'compliance.getHistory': [], 'compliance.getRollingAvg': { avg: 0 },
      'settings.getReplyMonitorBadge': { enabled: false }, 'settings.getSchedule': null,
      'settings.getDailyGoal': { hours: 8 }, 'replyMonitor.getPendingThreads': [],
      'replyMonitor.getActiveVagueFlags': [], 'replyMonitor.getActiveUnsignedFlags': [],
      'emailInbox.getPendingCount': { count: 0 }, 'aptlss.getPendingFollowUps': [],
      'aptlss.getDecisionQueue': { items: [] },
      'aptlss.getAllPriorityScores': [], 'aptlss.getAllCardStates': [],
      'aptlss.getPolicies': [], 'aptlss.getRepairQueue': [],
      'cardSnooze.getSnoozedIds': { cardIds: [] }, 'onHoldChecks.getByDate': [],
    };
    if (request.method() === 'GET' && Object.hasOwn(defaults, procedure)) return fulfill(defaults[procedure]);
    unexpected.push(`${request.method()} ${procedure}`);
    return route.fulfill({ status: 503, json: { error: 'Unconfigured synthetic request' } });
  });
  await page.goto(origin);
  await page.addScriptTag({ content: bundle });
  const open = async (view = 'calculator', vaId?: number) => {
    await page.evaluate(({ view, vaId }) => (window as any).mountFinancial(view, vaId), { view, vaId });
    if (view === 'calculator') await expect(page.getByRole('heading', { name: 'Weekly Pay Calculator', exact: true })).toBeVisible();
  };
  const verify = async () => {
    expect(errors, 'No uncaught browser errors').toEqual([]);
    expect(unexpected, 'Every API/provider request is intercepted').toEqual([]);
    await info.attach('synthetic-financial-calls', { body: JSON.stringify(calls, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('financial-state.png'), fullPage: true });
  };
  return { state, calls, open, verify, writes: () => calls.filter(call => call.method !== 'GET'),
    saves: () => calls.filter(call => call.procedure === 'payLog.upsert') };
}

function firstMerit(page: Page) {
  const row = page.getByText('Realized Financial Opportunity', { exact: true }).locator('..');
  return { plus: row.getByRole('button', { name: '+', exact: true }), value: row.getByRole('button', { name: '+', exact: true }).locator('..').locator('span') };
}

test('switching workers clears unsaved counts and notes and saves only the selected vaId', async ({ page }, info) => {
  const f = await fixture(page, info);
  await f.open('calculator', 1002);
  await expect(page.getByRole('textbox')).toHaveValue('Worker A saved note');
  await expect(firstMerit(page).value).toHaveText('2');
  await firstMerit(page).plus.click();
  await page.getByRole('textbox').fill('Unsaved Worker A private draft');
  await page.getByRole('combobox', { name: 'Financial worker' }).selectOption('1003');
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(firstMerit(page).value).toHaveText('0');
  await expect.poll(() => f.calls.some(call => call.procedure === 'payLog.getByWeek' && call.input?.vaId === 1003)).toBe(true);
  await page.getByRole('button', { name: 'Save Week Log' }).click();
  await expect.poll(() => f.saves().length).toBe(1);
  expect(f.saves()[0].input).toMatchObject({ vaId: 1003, meritM1: 0, notes: '' });
  expect(f.state.records.get(1002)).toMatchObject({ meritM1: 2, notes: 'Worker A saved note' });
  await page.getByRole('combobox', { name: 'Financial worker' }).selectOption('1002');
  await expect(page.getByRole('textbox')).toHaveValue('Worker A saved note');
  await expect(firstMerit(page).value).toHaveText('2');
  await f.verify();
});

test('a delayed selected-worker read loads that worker data without restoring a previous draft', async ({ page }, info) => {
  const f = await fixture(page, info);
  f.state.records.set(1003, saved(1003, 1, 'Worker B saved note'));
  f.state.holdWorkerB = true;
  try {
    await f.open('calculator', 1002);
    await expect(page.getByRole('textbox')).toHaveValue('Worker A saved note');
    await page.getByRole('textbox').fill('Do not leak this A draft');
    await page.getByRole('combobox', { name: 'Financial worker' }).selectOption('1003');
    await expect(page.getByRole('textbox')).toHaveValue('');
    await expect(firstMerit(page).value).toHaveText('0');
    f.state.releaseWorkerB();
    await expect(page.getByRole('textbox')).toHaveValue('Worker B saved note');
    await expect(firstMerit(page).value).toHaveText('1');
    await page.getByRole('button', { name: 'Save Week Log' }).click();
    await expect.poll(() => f.saves().length).toBe(1);
    expect(f.saves()[0].input).toMatchObject({ vaId: 1003, meritM1: 1, notes: 'Worker B saved note' });
    await f.verify();
  } finally { f.state.releaseWorkerB(); }
});

test('worker calculator is read-only even when mounted with a target worker', async ({ page }, info) => {
  const f = await fixture(page, info, 'worker');
  await f.open('calculator', 1002);
  await expect(page.getByText('Worker A saved note', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Week Log' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(f.writes()).toEqual([]);
  await f.verify();
});

test('save cannot overwrite an existing worker log before its delayed read finishes', async ({ page }, info) => {
  const f = await fixture(page, info);
  f.state.records.set(1003, saved(1003, 3, 'Existing Worker B financial evidence'));
  f.state.holdWorkerB = true;
  try {
    await f.open('calculator', 1002);
    await expect(page.getByRole('textbox')).toHaveValue('Worker A saved note');
    await page.getByRole('combobox', { name: 'Financial worker' }).selectOption('1003');
    await expect.poll(() => f.calls.some(call => call.procedure === 'payLog.getByWeek' && call.input?.vaId === 1003)).toBe(true);
    await expect(page.getByRole('textbox')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Save Week Log' }), 'Do not replace unread financial evidence with empty defaults').toBeDisabled();
    expect(f.saves()).toEqual([]);
    f.state.releaseWorkerB();
    await expect(page.getByRole('textbox')).toHaveValue('Existing Worker B financial evidence');
    await expect(page.getByRole('button', { name: 'Save Week Log' })).toBeEnabled();
    await f.verify();
  } finally { f.state.releaseWorkerB(); }
});

test('an admin calculator without an explicit worker cannot save', async ({ page }, info) => {
  const f = await fixture(page, info);
  await f.open();
  await expect(page.getByText('No notes for this week.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Week Log' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(f.writes()).toEqual([]);
  await f.verify();
});

test('an in-flight Worker A save cannot contaminate Worker B draft or save identity', async ({ page }, info) => {
  const f = await fixture(page, info);
  f.state.records.set(1003, saved(1003, 1, 'Worker B saved note'));
  f.state.holdSaveA = true;
  try {
    await f.open('calculator', 1002);
    await expect(page.getByRole('textbox')).toHaveValue('Worker A saved note');
    await firstMerit(page).plus.click();
    await page.getByRole('textbox').fill('Worker A submitted edit');
    await page.getByRole('button', { name: 'Save Week Log' }).click();
    await expect.poll(() => f.saves().length).toBe(1);
    expect(f.saves()[0].input).toMatchObject({ vaId: 1002, meritM1: 3, notes: 'Worker A submitted edit' });
    await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    await page.getByRole('combobox', { name: 'Financial worker' }).selectOption('1003');
    await expect(page.getByRole('textbox')).toHaveValue('Worker B saved note');
    await expect(firstMerit(page).value).toHaveText('1');
    await firstMerit(page).plus.click();
    await page.getByRole('textbox').fill('Worker B independent draft');
    f.state.releaseSaveA();
    await expect.poll(() => f.state.records.get(1002)?.notes).toBe('Worker A submitted edit');
    await expect(page.getByRole('textbox')).toHaveValue('Worker B independent draft');
    await expect(firstMerit(page).value).toHaveText('2');
    await page.getByRole('button', { name: 'Save Week Log' }).click();
    await expect.poll(() => f.saves().length).toBe(2);
    expect(f.saves()[1].input).toMatchObject({ vaId: 1003, meritM1: 2, notes: 'Worker B independent draft' });
    expect(f.state.records.get(1002)).toMatchObject({ vaId: 1002, meritM1: 3, notes: 'Worker A submitted edit' });
    await f.verify();
  } finally { f.state.releaseSaveA(); }
});

test('actual Home renders and refetches an absent pay log without creating financial records', async ({ page }, info) => {
  const f = await fixture(page, info);
  await f.open('home');
  await expect(page.getByText('Not recorded', { exact: true })).toBeVisible();
  await expect.poll(() => f.calls.filter(call => call.procedure === 'payLog.getByWeek').length).toBeGreaterThan(0);
  const reads = f.calls.filter(call => call.procedure === 'payLog.getByWeek').length;
  await page.evaluate(() => (window as any).refreshFinancial());
  await expect.poll(() => f.calls.filter(call => call.procedure === 'payLog.getByWeek').length).toBeGreaterThan(reads);
  expect(f.writes()).toEqual([]);
  await f.verify();
});

test('a stale draft cannot overwrite committed D1 or silently adopt a refreshed revision', async ({ page }, info) => {
  const f = await fixture(page, info);
  const originalRevision = weeklyPayRevision(f.state.records.get(1002));
  await f.open('calculator', 1002);
  await expect(page.getByRole('textbox')).toHaveValue('Worker A saved note');
  await firstMerit(page).plus.click();
  await page.getByRole('textbox').fill('Unsaved merit evidence');
  const committed = { ...f.state.records.get(1002), demeritD1: 2, notes: 'Committed D1 evidence from another writer' };
  f.state.records.set(1002, committed);
  const reads = () => f.calls.filter(call => call.procedure === 'payLog.getByWeek' && call.input?.vaId === 1002).length;
  const beforeRefresh = reads();
  await page.evaluate(() => (window as any).refreshFinancial());
  await expect.poll(reads).toBeGreaterThan(beforeRefresh);
  await expect(page.getByRole('textbox')).toHaveValue('Unsaved merit evidence');
  await expect(firstMerit(page).value).toHaveText('3');
  const rejected = page.waitForResponse(response => response.url().includes('/payLog.upsert') && response.status() === 409);
  await page.getByRole('button', { name: 'Save Week Log' }).click();
  await rejected;
  await expect(page.getByRole('alert')).toContainText('This week changed');
  await expect(page.getByRole('button', { name: 'Save Week Log' })).toBeDisabled();
  expect(f.saves()).toHaveLength(1);
  expect(f.saves()[0].input).toMatchObject({ vaId: 1002, expectedRevision: originalRevision, meritM1: 3, demeritD1: 0 });
  expect(f.state.records.get(1002)).toEqual(committed);
  const afterConflict = reads();
  await page.evaluate(() => (window as any).refreshFinancial());
  await expect.poll(reads).toBeGreaterThan(afterConflict);
  await expect(page.getByRole('textbox')).toHaveValue('Unsaved merit evidence');
  await expect(page.getByRole('button', { name: 'Save Week Log' })).toBeDisabled();
  expect(f.saves()).toHaveLength(1);
  await page.getByRole('button', { name: 'Reload saved week' }).click();
  await expect(page.getByRole('textbox')).toHaveValue(committed.notes);
  await expect(firstMerit(page).value).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Save Week Log' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save Week Log' }).click();
  await expect.poll(() => f.saves().length).toBe(2);
  expect(f.saves()[1].input).toMatchObject({ vaId: 1002, expectedRevision: weeklyPayRevision(committed),
    meritM1: 2, demeritD1: 2, notes: committed.notes });
  expect(f.state.records.get(1002)).toMatchObject({ demeritD1: 2, notes: committed.notes });
  await f.verify();
});
