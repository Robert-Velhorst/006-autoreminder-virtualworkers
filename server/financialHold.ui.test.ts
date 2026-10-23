import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({ availability: vi.fn(), financialQuery: vi.fn() }));
vi.mock('@/lib/trpc', () => ({ trpc: {
  payment: { availability: { useQuery: mocks.availability }, getCurrentCycle: { useQuery: mocks.financialQuery }, getAllCycles: { useQuery: mocks.financialQuery } },
  payLog: { getByWeek: { useQuery: mocks.financialQuery }, getAll: { useQuery: mocks.financialQuery } },
  useUtils: mocks.financialQuery,
} }));
vi.mock('@/_core/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin' } }) }));
import WeeklyPayCalculator from '../client/src/pages/manus/WeeklyPayCalculator';
import PaymentTracker from '../client/src/pages/manus/PaymentTracker';
import { FinancialFeatureGate } from '../client/src/components/FinancialFeatureGate';

afterEach(() => vi.clearAllMocks());
describe('financial UI hold', () => {
  it.each([
    { isSuccess: true, isFetching: false, data: { enabled: false } },
    { isSuccess: false, isFetching: true },
    { isSuccess: false, isFetching: false, data: { enabled: true } },
    { isSuccess: true, isFetching: true, data: { enabled: false } },
    { isSuccess: true, isFetching: false, fetchStatus: 'paused', data: { enabled: true } },
    { isSuccess: true, isFetching: false },
  ])('withholds both financial subtrees for unavailable state %j', state => {
    mocks.availability.mockReturnValue(state);
    for (const component of [WeeklyPayCalculator, PaymentTracker]) {
      const html = renderToStaticMarkup(createElement(component));
      expect(html).toContain('Pay and payments paused');
      expect(html).not.toMatch(/\$|90\.00|Projected|<svg|<button|Pay History|Mark as Paid|Pay Trend/);
    }
    expect(mocks.financialQuery).not.toHaveBeenCalled();
  });

  it('mounts children only after a successful enabled response', () => {
    mocks.availability.mockReturnValue({ isSuccess: true, isFetching: false, data: { enabled: true } });
    expect(renderToStaticMarkup(createElement(FinancialFeatureGate, { children: 'enabled-child' }))).toBe('enabled-child');
  });

  it('preserves the mounted child and unsaved form state through a positive background refetch', async () => {
    const { build } = await import('esbuild');
    const { chromium } = await import('@playwright/test');
    const { resolve } = await import('node:path');
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(), loader: 'tsx', contents: `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { FinancialFeatureGate } from './client/src/components/FinancialFeatureGate';
          window.mounts = 0;
          window.unmounts = 0;
          function Form() {
            const [note, setNote] = useState('');
            useEffect(() => { window.mounts++; return () => { window.unmounts++; }; }, []);
            return <textarea aria-label="Unsaved note" value={note} onChange={event => setNote(event.target.value)} />;
          }
          const root = createRoot(document.getElementById('root'));
          window.setAvailability = value => {
            window.availability = value;
            root.render(<FinancialFeatureGate><Form /></FinancialFeatureGate>);
          };
        `,
      },
      bundle: true, write: false, format: 'iife', jsx: 'automatic',
      alias: { '@shared': resolve('shared') },
      plugins: [{
        name: 'availability-stub',
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/trpc$/ }, () => ({ path: 'trpc', namespace: 'availability-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'availability-stub' }, () => ({
            contents: 'export const trpc = { payment: { availability: { useQuery: () => window.availability } } };',
          }));
        },
      }],
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route('**/*', route => route.abort());
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const setAvailability = (state: Record<string, unknown>) => page.evaluate(value => {
        (window as any).setAvailability(value);
      }, state);
      await setAvailability({ isSuccess: true, isFetching: false, data: { enabled: true } });
      const input = page.getByRole('textbox', { name: 'Unsaved note' });
      await input.fill('Do not lose this unsaved note');
      await page.evaluate(() => { (window as any).originalInput = document.querySelector('textarea'); });

      for (const isFetching of [true, false, true, false]) {
        await setAvailability({ isSuccess: true, isFetching, data: { enabled: true } });
        // Wait for the corresponding React commit, including a possible unmount.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await input.inputValue()).toBe('Do not lose this unsaved note');
        expect(await page.getByRole('status').count()).toBe(0);
        expect(await page.evaluate(() => ({
          sameInput: document.querySelector('textarea') === (window as any).originalInput,
          mounts: (window as any).mounts, unmounts: (window as any).unmounts,
        }))).toEqual({ sameInput: true, mounts: 1, unmounts: 0 });
      }

      await setAvailability({ isSuccess: true, isFetching: false, data: { enabled: false } });
      await page.getByRole('status').waitFor();
      expect(await input.count()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
