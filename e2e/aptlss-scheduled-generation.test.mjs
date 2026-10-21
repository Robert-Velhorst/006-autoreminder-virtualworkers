import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

let browser, bundle, styles;
const hash = 'a'.repeat(64), changedHash = 'b'.repeat(64);
const card = (id, selected = true) => ({ id, name: `Business card ${id}`, desc: '', idBoard: 'board1', idList: 'list1', hasAPTLSS: false, selected });
const scheduled = (id, status) => ({ id, status, cardIds: '["cardA","cardB"]', scheduledTime: '2026-10-20T12:00:00Z', createdBy: 'synthetic-admin' });
const jobs = () => [scheduled('legacy', 'awaiting_approval'), scheduled('pending', 'pending'), scheduled('running', 'running'), scheduled('completed', 'completed')];
const approval = (id = 'legacy', extra = {}) => ({ jobId: id, status: id === 'legacy' ? 'awaiting_approval' : 'pending', cardIds: ['cardA', 'cardB'],
  settings: { applyToTrello: true, skipExisting: false, validateBeforeGenerate: true, replaceExisting: false, minimumConfidence: 75, maxRetries: 2 },
  scheduledTime: '2026-10-20T12:00:00Z', expectedSnapshotHash: hash, approvedSessionEpoch: 'private-epoch-must-not-render',
  progress: { completed: 1, needsReview: 1, failed: 0, outcomeUnknown: 1 }, ...extra });

before(async () => {
  const root = resolve(import.meta.dirname, '..');
  const require = createRequire(createRequire(resolve(root, 'package.json')).resolve('@tailwindcss/vite'));
  const { compile } = await import(pathToFileURL(require.resolve('@tailwindcss/node')).href);
  const { Scanner } = await import(pathToFileURL(require.resolve('@tailwindcss/oxide')).href);
  const compiler = await compile(await readFile(resolve(root, 'client/src/index.css'), 'utf8'), { base: resolve(root, 'client/src'), onDependency() {} });
  styles = compiler.build(new Scanner({ sources: [{ base: resolve(root, 'client/src'), pattern: '**/*.{tsx,ts}', negated: false }] }).scan());
  const result = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import Page from '@/pages/APTLSSManagement';
    import {LoadingQueueProvider} from '@/contexts/LoadingQueueContext'; import {Toaster} from '@/components/ui/sonner';
    import {ThemeProvider} from '@/contexts/ThemeContext'; import {TooltipProvider} from '@/components/ui/tooltip';
    createRoot(document.getElementById('root')).render(<ThemeProvider defaultTheme="dark" switchable><LoadingQueueProvider><TooltipProvider><Toaster/><Page/></TooltipProvider></LoadingQueueProvider></ThemeProvider>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    plugins: [{ name: 'unrelated-panels', setup(api) {
      api.onResolve({ filter: /\/components\/(GoalInterviewDialog|AresConfigurationPanel)$/ }, args => ({ path: args.path, namespace: 'panels' }));
      api.onLoad({ filter: /.*/, namespace: 'panels' }, () => ({ resolveDir: root, loader: 'tsx', contents: `
        import React from 'react'; export const AresConfigurationPanel=()=>null;
        export const GoalInterviewDialog=({open,onComplete,onOpenChange})=>open?<button onClick={()=>{onComplete(window.syntheticInterviewGoal??{goal:'Only card A goal',successCriteria:['Verified A']});onOpenChange(false);}}>Synthetic interview complete</button>:null;
      ` }));
    } }], alias: { '@': resolve(root, 'client/src'), '@shared': resolve(root, 'shared') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', colorScheme: options.theme ?? 'light', timezoneId: 'Europe/Amsterdam', viewport: { width: options.width ?? 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [], calls = [];
  const state = { jobs: jobs(), preview: approval(), previews: 0, listStatus: 200, listReads: 0, created: new Map() };
  let release;
  const held = new Promise(resolvePromise => { release = resolvePromise; });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== 'http://localhost:4197') { errors.push('Unexpected external request'); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
    const method = req.method(), body = req.postData() ? JSON.parse(req.postData()) : undefined;
    calls.push({ path: url.pathname, method, body });
    if (url.pathname === '/api/aptlss/scheduled' && method === 'GET') { state.listReads++; return route.fulfill({ status: state.listStatus, json: state.listStatus === 200 ? state.jobs : { error: 'Schedule access denied' } }); }
    if (/\/scheduled\/[^/]+\/approval$/.test(url.pathname)) {
      if (method === 'GET') { state.previews++; return route.fulfill({ json: { approval: state.preview } }); }
      if (options.hold) await held;
      if (options.approvalAbort) return route.abort('failed');
      if (options.conflict && calls.filter(call => call.method === 'POST').length === 1) {
        state.preview = approval('legacy', { expectedSnapshotHash: changedHash, cardIds: ['cardC'], settings: { applyToTrello: false, minimumConfidence: 80 } });
        return route.fulfill({ status: 409, json: { error: 'Scheduled inputs changed' } });
      }
      if (options.approvalStatus) return route.fulfill({ status: options.approvalStatus, json: { error: 'Approval authority changed' } });
      state.jobs[0].status = 'pending'; return route.fulfill({ json: { success: true, jobId: 'legacy' } });
    }
    if (url.pathname === '/api/aptlss/schedule') {
      if (options.hold) await held;
      if (options.createStatus) return route.fulfill({ status: options.createStatus, json: { error: 'Schedule authority changed' } });
      assert.match(body.requestKey, /^[a-f0-9-]{36}$/);
      const prior = state.created.get(body.requestKey);
      if (prior && JSON.stringify(prior.body) !== JSON.stringify(body)) return route.fulfill({ status: 409, json: { error: 'Different input for request key' } });
      if (!prior) {
        const id = `new-job-${state.created.size}`;
        state.created.set(body.requestKey, { body, id });
        state.jobs.unshift({ id, status: 'pending', cardIds: JSON.stringify(body.cardIds), scheduledTime: body.scheduledTime });
      }
      if (options.createAbort) return route.abort('failed');
      const saved = state.created.get(body.requestKey);
      return route.fulfill({ json: { success: true, jobId: saved.id, replayed: !!prior, status: state.jobs.find(job => job.id === saved.id).status } });
    }
    if (/\/scheduled\/[^/]+$/.test(url.pathname) && method === 'DELETE') {
      if (options.hold) await held;
      if (options.cancelAbort) return route.abort('failed');
      const id = url.pathname.split('/').at(-1); state.jobs.find(job => job.id === id).status = 'cancelled';
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === '/api/aptlss/generate-batch') return route.fulfill({ status: 403, json: { error: 'Synthetic test boundary' } });
    if (['/api/trello/workspaces', '/api/trello/boards', '/api/aptlss/history'].includes(url.pathname)) return route.fulfill({ json: [] });
    errors.push(`Unexpected request ${method} ${url.pathname}`); return route.abort();
  });
  await page.goto('http://localhost:4197/');
  await page.evaluate(({ cards, theme, goal }) => { localStorage.setItem('aptlss_loaded_cards', JSON.stringify(cards)); localStorage.setItem('theme', theme); window.syntheticInterviewGoal = goal; },
    { cards: options.cards ?? [card('cardA'), card('cardB')], theme: options.theme ?? 'light', goal: options.goal });
  await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: bundle });
  t.after(() => assert.deepEqual(errors, []));
  const scheduledTab = async () => { await page.getByRole('tab', { name: 'Scheduled', exact: true }).click(); await expect(page.getByRole('table')).toBeVisible(); };
  const create = async () => { await page.getByRole('tab', { name: /Cards/ }).click(); await page.getByRole('button', { name: /Schedule selected/ }).click(); return page.getByRole('dialog'); };
  const review = async () => { await scheduledTab(); await page.getByRole('button', { name: 'Review / reapprove' }).first().click(); const dialog = page.getByRole('dialog'); await expect(dialog.getByText('2 cards', { exact: true })).toBeVisible(); return dialog; };
  const approveForm = async (dialog, time = '2099-10-21T15:30') => { await dialog.getByLabel(/Future run time/).fill(time); await dialog.getByRole('checkbox').check(); };
  return { page, state, calls, options, create, review, scheduledTab, approveForm, release,
    remount: async () => { await page.reload(); await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: bundle }); },
    posts: () => calls.filter(call => call.method === 'POST'), deletes: () => calls.filter(call => call.method === 'DELETE') };
}

test('scheduled tab retains on-hold status, shows scoped rows, and limits actions to pending/awaiting approval', async t => {
  const f = await fixture(t); await f.scheduledTab();
  await expect(f.page.getByRole('cell', { name: 'Awaiting approval', exact: true })).toHaveCount(1);
  await expect(f.page.getByRole('button', { name: 'Cancel schedule', exact: true })).toHaveCount(2);
  await expect(f.page.getByRole('button', { name: 'Review / reapprove' })).toHaveCount(2);
  assert.equal(f.posts().length, 0); assert.equal(f.deletes().length, 0);
  assert.ok(f.calls.every(call => !call.path.includes('other-owner')));
});

test('create requires explicit review, displays resolved timezone, sends only selected cards and whitelisted settings once', async t => {
  const f = await fixture(t, { hold: true }); const dialog = await f.create();
  await expect(dialog.getByText('Business card cardA')).toBeVisible();
  await expect(dialog.getByText('Validation threshold (uncalibrated)')).toBeVisible();
  await expect(dialog.getByText('70/100')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Approve schedule' })).toBeDisabled();
  assert.equal(f.posts().length, 0);
  await f.approveForm(dialog);
  await expect(dialog.getByText(/2099-10-21T13:30:00.000Z/)).toBeVisible();
  await expect(dialog.getByText(/GMT\+02:00/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve schedule' }).evaluate(button => { button.click(); button.click(); });
  await expect(dialog.getByRole('button', { name: 'Approve schedule' })).toBeDisabled();
  await expect.poll(() => f.posts().length).toBe(1);
  assert.match(f.posts()[0].body.requestKey, /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.posts()[0].body, { requestKey: f.posts()[0].body.requestKey, cardIds: ['cardA', 'cardB'], scheduledTime: '2099-10-21T13:30:00.000Z', settings: { skipExisting: true, validateBeforeGenerate: true } });
  f.release(); await expect(dialog).toHaveCount(0); await f.scheduledTab(); await expect(f.page.getByRole('cell', { name: 'Scheduled', exact: true })).toHaveCount(2);
});

test('past and nonexistent Amsterdam wall times cannot be approved; ambiguous autumn time shows its exact offset', async t => {
  const f = await fixture(t); const dialog = await f.create();
  for (const time of ['2000-01-01T12:00', '2027-03-28T02:30']) {
    await f.approveForm(dialog, time); await expect(dialog.getByText('Choose a valid time in the future.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Approve schedule' })).toBeDisabled(); assert.equal(f.posts().length, 0);
  }
  await dialog.getByLabel(/Future run time/).fill('2027-10-31T02:30');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await expect(dialog.getByText(/2027-10-31T00:30:00.000Z/)).toBeVisible();
  await expect(dialog.getByText(/GMT\+02:00/)).toBeVisible();
});

test('reopening an unsubmitted draft after changing selected cards reviews the new selection', async t => {
  const f = await fixture(t); let dialog = await f.create(); await expect(dialog.getByText('2 cards', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await f.page.getByRole('button', { name: 'Deselect All', exact: true }).click();
  await f.page.getByRole('tabpanel').getByRole('checkbox').first().check(); dialog = await f.create();
  await expect(dialog.getByText('1 card', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Business card cardB', { exact: true })).toHaveCount(0); assert.equal(f.posts().length, 0);
});

test('legacy reapproval is GET-only until checked with a new future time; excludes epoch/raw proof from display', async t => {
  const f = await fixture(t, { hold: true }); const dialog = await f.review();
  await expect(dialog.getByText(/Prior results: 1 completed, 1 need review, 0 failed, 1 unknown outcomes/)).toBeVisible();
  await expect(dialog.getByText(/private-epoch|expectedSnapshotHash|"applyToTrello"/)).toHaveCount(0);
  await expect(dialog.getByLabel(/Future run time/)).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Approve new run time' })).toBeDisabled(); assert.equal(f.posts().length, 0);
  await f.approveForm(dialog); await dialog.getByRole('button', { name: 'Approve new run time' }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => f.posts().length).toBe(1);
  assert.deepEqual(f.posts()[0].body, { expectedSnapshotHash: hash, scheduledTime: '2099-10-21T13:30:00.000Z' });
  f.release(); await expect(dialog).toHaveCount(0);
});

test('409 refreshes frozen preview and resets review/time, without automatically reposting', async t => {
  const f = await fixture(t, { conflict: true }); const dialog = await f.review(); await f.approveForm(dialog);
  await dialog.getByRole('button', { name: 'Approve new run time' }).click();
  await expect(dialog.getByText('cardC', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/This job changed/)).toBeVisible(); await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await expect(dialog.getByLabel(/Future run time/)).toHaveValue(''); assert.equal(f.posts().length, 1); assert.equal(f.state.previews, 2);
  await f.approveForm(dialog); await dialog.getByRole('button', { name: 'Approve new run time' }).click();
  await expect(dialog).toHaveCount(0); assert.equal(f.posts()[1].body.expectedSnapshotHash, changedHash);
});

for (const action of ['create', 'approval', 'cancel']) test(`${action} network outcome is unknown, never successful or automatically replayed`, async t => {
  const f = await fixture(t, { [`${action}Abort`]: true });
  let dialog;
  if (action === 'create') { dialog = await f.create(); await f.approveForm(dialog); await dialog.getByRole('button', { name: 'Approve schedule' }).click(); }
  else if (action === 'approval') { dialog = await f.review(); await f.approveForm(dialog); await dialog.getByRole('button', { name: 'Approve new run time' }).click(); }
  else { await f.scheduledTab(); await f.page.getByRole('button', { name: 'Cancel schedule', exact: true }).first().click(); dialog = f.page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Confirm cancellation' }).click(); }
  await expect(dialog.getByText(/Outcome unknown\. Server work may have been saved/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: action === 'create' ? 'Approve schedule' : action === 'approval' ? 'Approve new run time' : 'Confirm cancellation' })).toBeDisabled();
  await f.page.clock.install(); await f.page.clock.fastForward(60000);
  assert.equal(f.posts().length + f.deletes().length, 1);
});

for (const recoveredStatus of ['completed', 'cancelled', 'running']) test(`ambiguous creation recovers ${recoveredStatus} using the identical key and frozen payload after close/reopen`, async t => {
  const f = await fixture(t, { createAbort: true }); let dialog = await f.create(); await f.approveForm(dialog);
  await dialog.getByRole('button', { name: 'Approve schedule' }).click();
  await expect(dialog.getByText(/An explicit retry will reuse/)).toBeVisible();
  const original = f.posts()[0].body;
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('aptlss-schedule:pending-request:v1')), original.requestKey);
  await dialog.getByRole('button', { name: 'Close and reload scheduled jobs' }).click(); dialog = await f.create();
  await expect(dialog.getByLabel(/Future run time/)).toHaveValue('2099-10-21T15:30');
  await expect(dialog.getByRole('button', { name: 'Retry exact schedule request' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Check scheduled jobs', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry exact schedule request' })).toBeEnabled();
  f.options.createAbort = false;
  f.state.jobs.find(job => job.id === 'new-job-0').status = recoveredStatus;
  await dialog.getByRole('button', { name: 'Retry exact schedule request' }).evaluate(button => { button.click(); button.click(); });
  await expect(dialog).toHaveCount(0);
  await expect(f.page.getByText(`Existing schedule recovered: ${recoveredStatus.charAt(0).toUpperCase() + recoveredStatus.slice(1)}.`)).toBeVisible();
  assert.equal(f.posts().length, 2); assert.deepEqual(f.posts()[1].body, original); assert.equal(f.state.created.size, 1);
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('aptlss-schedule:pending-request:v1')), null);
});

test('remount never forgets unknown creation: successful GET and explicit acknowledgement precede a new draft key', async t => {
  const f = await fixture(t, { createAbort: true }); let dialog = await f.create(); await f.approveForm(dialog);
  await dialog.getByRole('button', { name: 'Approve schedule' }).click(); await expect(dialog.getByText(/An explicit retry will reuse/)).toBeVisible();
  const original = f.posts()[0].body; await f.remount(); dialog = await f.create();
  await expect(dialog.getByText(/original draft is no longer in memory/)).toBeVisible();
  await expect(dialog.getByLabel(/Future run time/)).toHaveCount(0); assert.equal(f.posts().length, 1);
  await dialog.getByRole('button', { name: 'Check scheduled jobs', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Start a different draft' })).toBeDisabled();
  await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Start a different draft' }).click();
  await f.approveForm(dialog, '2099-10-22T15:30'); f.options.createAbort = false;
  await dialog.getByRole('button', { name: 'Approve schedule' }).click(); await expect(dialog).toHaveCount(0);
  assert.equal(f.posts().length, 2); assert.notEqual(f.posts()[1].body.requestKey, original.requestKey);
  assert.equal(f.posts()[1].body.scheduledTime, '2099-10-22T13:30:00.000Z');
});

test('cancel is explicit, deduplicated, and retains cancelled history', async t => {
  const f = await fixture(t, { hold: true }); await f.scheduledTab();
  await f.page.getByRole('button', { name: 'Cancel schedule', exact: true }).first().click(); assert.equal(f.deletes().length, 0);
  const dialog = f.page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Confirm cancellation' }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => f.deletes().length).toBe(1); await expect(dialog.getByRole('button', { name: 'Confirm cancellation' })).toBeDisabled();
  f.release(); await expect(dialog).toHaveCount(0); await expect(f.page.getByRole('cell', { name: 'Cancelled', exact: true })).toHaveCount(1);
});

test('HTTP errors remain actionable and do not claim scheduling success; list denial hides stale actions', async t => {
  const f = await fixture(t, { createStatus: 403 }); const dialog = await f.create(); await f.approveForm(dialog);
  await dialog.getByRole('button', { name: 'Approve schedule' }).click(); await expect(dialog.getByText('Schedule authority changed')).toBeVisible();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await f.scheduledTab(); f.state.listStatus = 403; await f.page.getByRole('button', { name: 'Reload scheduled jobs' }).click();
  await expect(f.page.getByText('Schedule access denied')).toBeVisible(); await expect(f.page.getByRole('button', { name: 'Review / reapprove' })).toHaveCount(0);
});

test('one-card interview context is not silently sent for other cards or a multi-card batch', async t => {
  const f = await fixture(t); await f.page.getByRole('tab', { name: /Cards/ }).click();
  await f.page.getByTitle('Start Goal Interview').first().click(); await f.page.getByRole('button', { name: 'Synthetic interview complete' }).click();
  let dialog = await f.create(); await expect(dialog.getByText('Business goal and success criteria')).toHaveCount(0);
  await f.approveForm(dialog); await dialog.getByRole('button', { name: 'Approve schedule' }).click(); await expect(dialog).toHaveCount(0);
  await f.page.getByRole('button', { name: 'Deselect All', exact: true }).click();
  // Card A is the first card checkbox after the filter controls.
  await f.page.getByRole('tabpanel').getByRole('checkbox').first().check();
  dialog = await f.create();
  await expect(dialog.getByText('Only card A goal')).toBeVisible(); await expect(dialog.getByText('MUST NOT DISPLAY')).toHaveCount(0);
  await f.approveForm(dialog); await dialog.getByRole('button', { name: 'Approve schedule' }).click(); await expect(dialog).toHaveCount(0);
  assert.equal(f.posts()[0].body.settings.clarifiedGoal, undefined); assert.equal(f.posts()[1].body.settings.clarifiedGoal.goal, 'Only card A goal');
  assert.ok(f.posts().every(call => !('scheduledJobs' in call.body.settings) && !('autoReminder' in call.body.settings) && !('batchSize' in call.body.settings)));
});

test('immediate generation also excludes schedule/history state and unrelated clarified context', async t => {
  const f = await fixture(t); await f.page.getByRole('tab', { name: /Cards/ }).click();
  await f.page.getByTitle('Start Goal Interview').first().click(); await f.page.getByRole('button', { name: 'Synthetic interview complete' }).click();
  await f.page.getByRole('button', { name: 'Generate (2)', exact: true }).click();
  await expect.poll(() => f.posts().length).toBe(1);
  assert.deepEqual(f.posts()[0].body.settings, { skipExisting: true, validateBeforeGenerate: true });
});

async function goalDialog(t, mode, goal) {
  const f = await fixture(t, { goal, cards: [card('cardA')] });
  let dialog;
  if (mode === 'create') {
    await f.page.getByRole('tab', { name: /Cards/ }).click();
    await f.page.getByTitle('Start Goal Interview').click();
    await f.page.getByRole('button', { name: 'Synthetic interview complete' }).click();
    dialog = await f.create();
  } else {
    f.state.preview.settings.clarifiedGoal = goal;
    dialog = await f.review();
  }
  return { ...f, dialog, submit: dialog.getByRole('button', { name: mode === 'create' ? 'Approve schedule' : 'Approve new run time', exact: true }) };
}

for (const mode of ['create', 'reapprove']) test(`business goal ${mode} faithfully shows objective and nested hours before approval`, async t => {
  const goal = { objective: 'Review interview claims', constraints: { hours: 2, urgent: false, budget: null }, successCriteria: ['Verified outcome'] };
  const f = await goalDialog(t, mode, goal);
  await expect(f.dialog.getByText('Review interview claims', { exact: true })).toBeVisible();
  await expect(f.dialog.locator('dt').filter({ hasText: /^hours$/ }).locator('..').getByText('2', { exact: true })).toBeVisible();
  await expect(f.dialog.getByText('false', { exact: true })).toBeVisible();
  await expect(f.dialog.getByText('Not provided (null)', { exact: true })).toBeVisible();
  await expect(f.dialog.getByText('Verified outcome', { exact: true })).toBeVisible();
  await expect(f.submit).toBeDisabled(); assert.equal(f.posts().length, 0);
  await f.approveForm(f.dialog); await f.submit.click(); await expect(f.dialog).toHaveCount(0);
  assert.equal(f.posts().length, 1);
  if (mode === 'create') assert.deepEqual(f.posts()[0].body.settings.clarifiedGoal, goal);
});

const blockedGoals = [
  ['unsupported root', true],
  ['truncated text', { objective: 'x'.repeat(8001) }],
  ['excess depth', { a: { b: { c: { d: { hours: 2 } } } } }],
  ['excess entries', { constraints: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`field${i}`, i])) }],
  ['total text budget', { objective: 'a'.repeat(5000), constraints: 'b'.repeat(5000), deliverable: 'c'.repeat(5000) }],
  ['total node budget', { constraints: Array.from({ length: 40 }, (_, i) => ({ hours: i, active: true, limit: null })) }],
  ['unsupported long key', { ['key'.repeat(34)]: 'Important business constraint' }],
  ['excluded technical thoughts', { objective: 'Review interview claims', constraints: { hours: 2 }, thoughts: 'MUST NOT DISPLAY' }],
];
for (const mode of ['create', 'reapprove']) for (const [name, goal] of blockedGoals) {
  test(`business goal ${mode} blocks ${name} rather than approving hidden or truncated inputs`, async t => {
    const f = await goalDialog(t, mode, goal);
    await expect(f.dialog.getByText(/Approval blocked: goal details cannot be fully reviewed here/)).toBeVisible();
    await expect(f.dialog.getByText('MUST NOT DISPLAY')).toHaveCount(0);
    await f.approveForm(f.dialog);
    await expect(f.submit).toBeDisabled();
    assert.equal(f.posts().length, 0);
  });
}

for (const theme of ['light', 'dark']) for (const width of [390, 1280]) test(`settled ${theme} scheduled UI at ${width}px has unobscured keyboard-reachable CTAs with app providers`, async t => {
  const f = await fixture(t, { width, theme }); await f.scheduledTab();
  assert.equal(await f.page.locator('html').evaluate(element => element.classList.contains('dark')), theme === 'dark');
  const evidence = {};
  const visibleCta = async (dialog, name) => {
    const cta = dialog.getByRole('button', { name, exact: true });
    await expect(cta).toBeEnabled();
    const proof = await cta.evaluate(button => {
      const rect = button.getBoundingClientRect();
      // Probe the painted center and edges, not the transparent corners of pill buttons.
      const midX = (rect.left + rect.right) / 2, midY = (rect.top + rect.bottom) / 2;
      const points = [[rect.left + 8, midY], [rect.right - 8, midY], [midX, rect.top + 4], [midX, rect.bottom - 4], [midX, midY]];
      return { withinViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
        unobscured: points.every(([x, y]) => button.contains(document.elementFromPoint(x, y))) };
    });
    assert.deepEqual(proof, { withinViewport: true, unobscured: true });
    await dialog.getByLabel(/Future run time/).focus();
    let reached = false;
    for (let i = 0; i < 8; i++) { await f.page.keyboard.press('Tab'); if (await cta.evaluate(button => button === document.activeElement)) { reached = true; break; } }
    assert.equal(reached, true); await expect(cta).toBeFocused();
    return { ...proof, keyboardReachable: reached, bounds: await cta.boundingBox() };
  };
  const settle = async () => {
    await f.page.bringToFront();
    await expect(f.page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 12000 });
  };
  const capture = async (name, element) => {
    const bounds = await element.boundingBox();
    const overflow = await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    const path = join(tmpdir(), `va-scheduled-generation-${name}-${theme}-${width}.png`);
    assert.equal(overflow, false); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await f.page.screenshot({ path }); evidence[name] = { path, theme, viewport: { width, height: 900 }, bounds, documentOverflow: overflow };
  };
  const bootDialog = await f.review(); await f.approveForm(bootDialog);
  evidence.bootToastCTA = { ...(await visibleCta(bootDialog, 'Approve new run time')), toastCount: await f.page.locator('[data-sonner-toast]').count() };
  await bootDialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close', exact: true }).click();
  await settle();
  await capture('table', f.page.getByRole('table').locator('..'));
  const dialog = await f.review();
  await f.approveForm(dialog);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
  for (const button of await dialog.getByRole('button').all()) {
    assert.equal(await button.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
  }
  const reviewCta = await visibleCta(dialog, 'Approve new run time');
  await settle();
  await capture('review', dialog);
  evidence.review.cta = reviewCta;
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close', exact: true }).click();
  const create = await f.create(); await f.approveForm(create);
  const createCta = await visibleCta(create, 'Approve schedule');
  await settle();
  await capture('create', create);
  evidence.create.cta = createCta;
  const boundsPath = join(tmpdir(), `va-scheduled-generation-layout-${theme}-${width}.json`);
  await writeFile(boundsPath, JSON.stringify(evidence, null, 2));
  t.diagnostic(`Layout evidence: ${boundsPath}`);
});
