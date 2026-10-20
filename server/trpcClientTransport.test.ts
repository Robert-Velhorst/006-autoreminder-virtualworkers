import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('tRPC browser transport', () => {
  it('bounds batched API requests while preserving caller cancellation', () => {
    const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const TRPC_REQUEST_TIMEOUT_MS = 30_000;');
    expect(source).toContain('AbortSignal.any([init.signal, timeout])');
    expect(source).toContain('signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout');
  });
});
