import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn() }) }));
vi.mock('../client/src/App', () => ({ default: () => null }));
vi.mock('../client/src/lib/trpc', () => ({ trpc: { Provider: () => null, createClient: () => ({}) } }));

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

describe('actual dashboard fetch abort behavior', () => {
  const origin = 'https://dashboard.example';
  let responseDelay: number;
  let forwardedSignal: AbortSignal | undefined;
  let fetchCalls: number;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    responseDelay = 35_000;
    fetchCalls = 0;
    forwardedSignal = undefined;
    // Node's native AbortSignal.timeout uses internal timers. Substitute only
    // its timer source; main.tsx still selects/composes the real abort signals.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    vi.stubGlobal('window', { location: { origin } });
    vi.stubGlobal('document', { getElementById: () => ({}) });
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++;
      forwardedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        const signal = forwardedSignal;
        if (signal?.aborted) { reject(signal.reason); return; }
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve(Response.json({ success: true }));
        }, responseDelay);
        signal?.addEventListener('abort', abort, { once: true });
      });
    });
    // Import the production wrapper itself; never reimplement its routing or
    // AbortSignal.any logic in the regression test. Rendering is mocked above.
    await import('../client/src/main');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('still aborts ordinary dashboard requests at 30 seconds', async () => {
    const pending = globalThis.fetch('/api/atis/stats').catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).name).toBe('TimeoutError');
    expect(forwardedSignal?.aborted).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  it.each(['/api/atis/sync', '/api/atis/understanding/process'])('preserves an explicit caller abort for POST %s', async path => {
    const caller = new AbortController();
    const reason = new Error('Caller cancelled');
    const pending = globalThis.fetch(path, { method: 'POST', signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(reason);
    expect(await pending).toBe(reason);
    expect(forwardedSignal?.reason).toBe(reason);
    expect(fetchCalls).toBe(1);
  });

  it('preserves Request cancellation, pre-aborts and an explicit init signal override', async () => {
    const caller = new AbortController();
    const request = new Request(`${origin}/api/atis/sync`, { method: 'POST', signal: caller.signal });
    const reason = new Error('Request cancelled');
    const pending = globalThis.fetch(request).catch(error => error);
    caller.abort(reason);
    expect(await pending).toBe(reason);
    expect(await globalThis.fetch(request).catch(error => error)).toBe(reason);

    const override = new AbortController();
    responseDelay = 10_000;
    const overridden = globalThis.fetch(request, { signal: override.signal });
    expect(forwardedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await overridden).ok).toBe(true);
  });
});
