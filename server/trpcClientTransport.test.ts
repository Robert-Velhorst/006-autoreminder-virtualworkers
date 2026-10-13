import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('tRPC browser transport', () => {
  it('uses one operation-aware API deadline while preserving caller cancellation', () => {
    const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

    expect(source).toContain('dashboardApiDeadline(input, init, window.location.origin)');
    expect(source).toContain('AbortSignal.timeout(deadline)');
    expect(source).toContain('AbortSignal.any([callerSignal, timeout])');
    expect(source).not.toContain('AbortSignal.timeout(TRPC_REQUEST_TIMEOUT_MS)');
  });
  it('does not couple unrelated dashboard reads into one blocking HTTP batch', () => {
    const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
    expect(source).toContain('httpLink({');
    expect(source).not.toContain('httpBatchLink({');
  });
});
