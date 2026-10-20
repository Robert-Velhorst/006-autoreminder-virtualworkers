import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('client API transport deadline', () => {
  it('bounds all same-origin API fetches while preserving caller cancellation', () => {
    const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const API_REQUEST_TIMEOUT_MS = TRPC_REQUEST_TIMEOUT_MS;');
    expect(source).toContain("return url.origin === window.location.origin && url.pathname.startsWith('/api/')");
    expect(source).toContain('const requestSignal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;');
    expect(source).toContain('globalThis.fetch = fetchDashboardApiWithDeadline;');
  });
});
