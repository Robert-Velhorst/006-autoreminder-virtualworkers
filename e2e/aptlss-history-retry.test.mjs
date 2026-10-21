import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

let browser;
let bundle;
before(async () => {
  const root = resolve(import.meta.dirname, '..');
  const result = await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import Page from '@/pages/APTLSSManagement';
      import {LoadingQueueProvider} from '@/contexts/LoadingQueueContext';
      import {Toaster} from 'sonner';
      createRoot(document.getElementById('root')).render(<LoadingQueueProvider><Page/><Toaster/></LoadingQueueProvider>);
    ` },
    plugins: [{ name: 'unrelated-panels', setup(api) {
      api.onResolve({ filter: /\/components\/(GoalInterviewDialog|AresConfigurationPanel)$/ }, args => ({ path: args.path, namespace: 'panels' }));
      api.onLoad({ filter: /.*/, namespace: 'panels' }, () => ({ contents: 'export const GoalInterviewDialog=()=>null; export const AresConfigurationPanel=()=>null;', loader: 'js' }));
    } }],
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': resolve(root, 'client/src'), '@shared': resolve(root, 'shared') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

async function fixture(t, response) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let posts = 0, historyReads = 0;
  let release;
  const held = new Promise(resolvePromise => { release = resolvePromise; });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://localhost:4198') { errors.push('Unexpected external request'); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
    if (url.pathname === '/api/aptlss/history/job-a/retry') {
      assert.equal(request.method(), 'POST'); posts++;
      if (response.hold) await held;
      if (response.abort) return route.abort('failed');
      return route.fulfill({ status: response.status ?? 200, ...(response.raw !== undefined
        ? { contentType: 'text/plain', body: response.raw } : { json: response.body }) });
    }
    if (url.pathname === '/api/aptlss/history') {
      historyReads++;
      return route.fulfill({ json: [{ id: 'job-a', status: 'completed_with_errors', totalCards: 4, completedCards: 0, failedCards: 4, createdAt: '2026-10-21T12:00:00Z' }] });
    }
    if (['/api/trello/workspaces', '/api/trello/boards', '/api/aptlss/scheduled'].includes(url.pathname)) return route.fulfill({ json: [] });
    errors.push(`Unexpected request ${request.method()} ${url.pathname}`); return route.abort();
  });
  await page.goto('http://localhost:4198/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('tab', { name: /History/ }).click();
  const retry = page.getByRole('button', { name: 'Retry 4 Failed Items' });
  await expect(retry).toBeVisible();
  t.after(() => assert.deepEqual(errors, []));
  return { page, retry, posts: () => posts, reads: () => historyReads, release };
}

for (const status of [403, 409]) test(`HTTP ${status} shows its actual error, not no-items or success`, async t => {
  const f = await fixture(t, { status, body: { error: 'Job authority changed; review before retrying.' } });
  await f.retry.click();
  await expect(f.page.getByText('Job authority changed; review before retrying.')).toBeVisible();
  await expect(f.page.getByText(/No items to retry|Retrying \d|Retry results:/)).toHaveCount(0);
  assert.equal(f.posts(), 1); assert.equal(f.reads(), 1);
});

test('in-flight retry cannot be submitted twice; mixed completed response reports disjoint counts and application', async t => {
  const f = await fixture(t, { hold: true, body: { success: true, itemsToRetry: 4, completed: 3, failed: 1, needsReview: 1,
    results: [{ success: true, appliedToTrello: true }, { success: true, appliedToTrello: false }, { success: true, appliedToTrello: false }, { success: false }] } });
  await f.retry.evaluate(button => { button.click(); button.click(); });
  await expect(f.retry).toBeDisabled(); assert.equal(f.posts(), 1);
  await expect(f.page.getByText(/Retry results:|Retrying \d/)).toHaveCount(0);
  f.release();
  await expect(f.page.getByText('Retry results: 2 completed without review, 1 need review, 1 failed. 1 applied to Trello.')).toBeVisible();
  await expect(f.retry).toBeEnabled();
  await expect.poll(f.reads).toBe(2); assert.equal(f.posts(), 1);
});

test('all failed response is not reported as retry success', async t => {
  const f = await fixture(t, { body: { success: true, itemsToRetry: 4, completed: 0, failed: 4, needsReview: 0, results: [{ success: false }] } });
  await f.retry.click();
  await expect(f.page.getByText('Retry results: 0 completed without review, 0 need review, 4 failed. 0 applied to Trello.')).toBeVisible();
  await expect(f.page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
});

test('successful legacy response uses completed counts without inventing application', async t => {
  const f = await fixture(t, { body: { success: true, itemsToRetry: 4, completed: 4, failed: 0 } });
  await f.retry.click();
  await expect(f.page.getByText('Retry results: 4 completed, 0 failed. Review status not reported.')).toBeVisible();
  await expect(f.page.getByText(/completed without review|0 need review|applied to Trello|Retrying \d/)).toHaveCount(0);
  await expect(f.page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
});

test('legacy review status stays unknown even when explicit application flags are available', async t => {
  const f = await fixture(t, { body: { success: true, itemsToRetry: 4, completed: 4, failed: 0,
    results: Array.from({ length: 4 }, () => ({ success: true, appliedToTrello: true })) } });
  await f.retry.click();
  await expect(f.page.getByText('Retry results: 4 completed, 0 failed. Review status not reported. 4 applied to Trello.')).toBeVisible();
  await expect(f.page.getByText(/completed without review|0 need review/)).toHaveCount(0);
});

for (const needsReview of [null, -1, 1.5, 5, '0']) test(`rejects present invalid review count ${JSON.stringify(needsReview)}`, async t => {
  const f = await fixture(t, { body: { success: true, itemsToRetry: 4, completed: 4, failed: 0, needsReview } });
  await f.retry.click();
  await expect(f.page.getByText('Retry outcome unknown. Server work may have started. Check History before submitting another retry.')).toBeVisible();
  await expect(f.page.getByText(/Retry results:/)).toHaveCount(0);
  assert.equal(f.posts(), 1);
});

test('explicit server no-items message remains informational', async t => {
  const f = await fixture(t, { body: { message: 'No failed items to retry' } });
  await f.retry.click();
  await expect(f.page.getByText('No failed items to retry')).toBeVisible();
  await expect(f.page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
});

for (const response of [{ abort: true }, { raw: 'not json' }, { body: { success: true, itemsToRetry: 4, completed: 4, failed: 4 } }]) {
  test(`unknown ${response.abort ? 'network' : response.raw ? 'JSON' : 'count'} outcome never retries automatically or claims no-items/completion`, async t => {
    const f = await fixture(t, response);
    await f.retry.click();
    await expect(f.page.getByText('Retry outcome unknown. Server work may have started. Check History before submitting another retry.')).toBeVisible();
    await expect(f.retry).toBeEnabled();
    await f.page.clock.install(); await f.page.clock.fastForward(60000);
    assert.equal(f.posts(), 1);
    await expect(f.page.getByText(/No items to retry|No failed items to retry|Retry results:|Retrying \d/)).toHaveCount(0);
  });
}
