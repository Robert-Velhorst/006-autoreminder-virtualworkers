import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('client API transport deadline', () => {
  it('bounds all same-origin API fetches while preserving caller cancellation', () => {
    const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
    const deadlines = readFileSync(new URL('../client/src/lib/api-deadline.ts', import.meta.url), 'utf8');

    expect(deadlines).toContain('export const API_REQUEST_TIMEOUT_MS = 30_000;');
    expect(deadlines).toContain('url.origin !== origin || !url.pathname.startsWith("/api/")');
    expect(source).toContain('dashboardApiDeadline(input, init, window.location.origin)');
    expect(source).toContain('const requestSignal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;');
    expect(source).toContain('input instanceof Request ? input.signal : undefined');
    expect(source).toContain('globalThis.fetch = fetchDashboardApiWithDeadline;');
  });
});
