import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledJobLeaseLostError } from '../scheduledJobRuntime';

const messages = [{ role: 'user' as const, content: 'Fixture prompt' }];
const result = { choices: [{ message: { content: 'Fixture response' } }] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', 'fixture-only-dispatch-key');
  vi.stubEnv('OPENAI_MODEL', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('LLM completion dispatch boundary', () => {
  it('does not even discover models for an already cancelled caller', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { invokeLLM } = await import('./llm');
    await expect(invokeLLM({ messages, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves native AbortError during %s completion rather than classifying it as provider failure', async completion => {
    const failure = new DOMException('Fixture cancellation', 'AbortError');
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!completion || init?.method === 'POST') throw failure;
      return new Response(JSON.stringify({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { invokeLLM } = await import('./llm');
    await expect(invokeLLM({ messages })).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(completion ? 2 : 1);
  });

  it.each(['lease', 'abort', 'guard-read'])('propagates %s guard failure after deferred discovery without a completion POST', async kind => {
    const entered = deferred(), release = deferred();
    const failure = kind === 'lease' ? new ScheduledJobLeaseLostError()
      : kind === 'abort' ? new DOMException('Fixture cancellation', 'AbortError') : new Error('Fixture guard unavailable');
    const fetchMock = vi.fn(async () => {
      entered.resolve(); await release.promise;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5-mini' }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { invokeLLM } = await import('./llm');
    const guard = vi.fn(async () => { throw failure; });
    const pending = invokeLLM({ messages, beforeDispatch: guard });
    const rejected = expect(pending).rejects.toBe(failure);
    await entered.promise;
    expect(guard).not.toHaveBeenCalled();
    release.resolve(); await rejected;
    expect(guard).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rechecks the caller signal after the awaited guard', async () => {
    const controller = new AbortController();
    const failure = new DOMException('Fixture cancellation', 'AbortError');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const { invokeLLM } = await import('./llm');
    await expect(invokeLLM({ messages, signal: controller.signal,
      beforeDispatch: async () => { controller.abort(failure); } })).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts model discovery without falling back to a completion', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const failure = new DOMException('Fixture cancellation', 'AbortError');
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      entered.resolve();
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { invokeLLM } = await import('./llm');
    const pending = invokeLLM({ messages, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(failure);
    await entered.promise; controller.abort(failure); await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves successful callers with optional guard=%s and forwards cancellation to POST', async guarded => {
    const controller = new AbortController();
    const events: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      events.push(init?.method === 'POST' ? 'post' : 'models');
      return new Response(JSON.stringify(init?.method === 'POST' ? result : { data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { invokeLLM } = await import('./llm');
    expect(await invokeLLM({ messages, ...(guarded ? { signal: controller.signal,
      beforeDispatch: async () => { events.push('guard'); } } : {}) })).toEqual(result);
    expect(events).toEqual(guarded ? ['models', 'guard', 'post'] : ['models', 'post']);
    if (guarded) {
      const signal = fetchMock.mock.calls[1][1]!.signal!;
      controller.abort(); expect(signal.aborted).toBe(true);
    }
    const payload = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
    expect(payload).not.toHaveProperty('beforeDispatch');
    expect(payload).not.toHaveProperty('signal');
  });

  it('propagates caller cancellation after dispatch without another attempt', async () => {
    const controller = new AbortController();
    const failure = new ScheduledJobLeaseLostError();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { controller.abort(failure); throw failure; }
      return new Response(JSON.stringify({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { invokeLLM } = await import('./llm');
    await expect(invokeLLM({ messages, signal: controller.signal })).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
