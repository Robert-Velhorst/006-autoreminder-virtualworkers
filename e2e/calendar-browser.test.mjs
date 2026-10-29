import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

let browser, bundle;
before(async () => {
  const root = resolve(import.meta.dirname, '..');
  const result = await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Calendar as PrimaryCalendar } from '@/components/ui/calendar';
      import { Calendar as ManusCalendar } from '@/components/manus/ui/calendar';
      function Demo({ Calendar, id }) {
        const [selected, setSelected] = React.useState(undefined);
        return <section data-testid={id}>
          <Calendar mode="single" defaultMonth={new Date(2026, 9, 1)} selected={selected} onSelect={setSelected}/>
          <output data-testid={id + '-selection'}>{selected ? selected.toLocaleDateString('en-US') : 'none'}</output>
        </section>;
      }
      createRoot(document.getElementById('root')).render(<><Demo Calendar={PrimaryCalendar} id="primary"/><Demo Calendar={ManusCalendar} id="manus"/></>);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': resolve(root, 'client/src'), '@shared': resolve(root, 'shared') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

for (const id of ['primary', 'manus']) test(`${id} calendar selects a day and navigates months`, async t => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    if (route.request().url() === 'http://localhost:4197/') {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    }
    errors.push('Unexpected external request');
    return route.abort();
  });
  await page.goto('http://localhost:4197/');
  await page.addScriptTag({ content: bundle });
  const calendar = page.getByTestId(id);
  await expect(calendar.locator('table.w-full.border-collapse')).toHaveCount(1);
  await expect(calendar.getByText('October 2026', { exact: true })).toBeVisible();
  await calendar.locator('button[data-day="10/15/2026"]').click();
  await expect(page.getByTestId(id + '-selection')).toHaveText('10/15/2026');
  await calendar.locator('button.rdp-button_next').click();
  await expect(calendar.getByText('November 2026', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
});
