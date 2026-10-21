import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ScheduledJobLeaseLostError } from '../scheduledJobRuntime';
import { codexLlmFixture } from '../test/codexLlmFixture';
import { invokeLLM } from './llm';

const messages = [{ role: 'user' as const, content: 'Fixture prompt' }];
const fixtures: Array<Awaited<ReturnType<typeof codexLlmFixture>>> = [];
async function fixture(plan: Parameters<typeof codexLlmFixture>[0] = {}) {
  const f = await codexLlmFixture(plan); fixtures.push(f); return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('subscription LLM dispatch ownership boundary', () => {
  it('does not publish anything for an already cancelled caller', async () => {
    const f = await fixture(), controller = new AbortController();
    controller.abort();
    await expect(invokeLLM({ messages, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(await f.calls()).toEqual([]);
    expect(await readdir(join(f.root,'requests'))).toEqual([]);
  });

  it.each(['lease', 'abort', 'guard-read'])('propagates %s guard failure after deferred subscription readiness without a completion', async kind => {
    const f = await fixture({ holdLogin: true });
    const failure = kind === 'lease' ? new ScheduledJobLeaseLostError()
      : kind === 'abort' ? new DOMException('Fixture cancellation','AbortError') : new Error('Fixture guard unavailable');
    let revoked = false;
    const guard = vi.fn(async () => { if (revoked) throw failure; });
    const pending = invokeLLM({ messages,beforeDispatch: guard });
    const rejected = expect(pending).rejects.toBe(failure);
    await f.waitFile('login-ready');
    revoked = true; await f.release('allow-login'); await rejected;
    expect(guard).toHaveBeenCalledTimes(2); // publication and post-readiness dispatch
    expect(await f.calls()).toEqual([]);
  });

  it('rechecks the caller signal after the awaited dispatch guard', async () => {
    const f = await fixture(), controller = new AbortController();
    const failure = new DOMException('Fixture cancellation','AbortError');
    let checks = 0;
    await expect(invokeLLM({ messages,signal: controller.signal,beforeDispatch: async () => {
      if (++checks === 2) controller.abort(failure);
    } })).rejects.toBe(failure);
    expect(await f.calls()).toEqual([]);
  });

  it('cancels readiness and removes transport rather than dispatching after delayed login', async () => {
    const f = await fixture({ holdLogin: true }), controller = new AbortController();
    const pending = invokeLLM({ messages,signal: controller.signal });
    const rejected = expect(pending).rejects.toHaveProperty('name','AbortError');
    await f.waitFile('login-ready');
    controller.abort(); await rejected;
    expect(await readdir(join(f.root,'requests'))).toEqual([]);
    expect(await f.calls()).toEqual([]);
  });

  it.each([false,true])('preserves successful callers with optional guard=%s without any API fetch', async guarded => {
    const f = await fixture(), guard = vi.fn(async () => {}), fetchMock = vi.fn();
    vi.stubGlobal('fetch',fetchMock);
    const result = await invokeLLM({ messages,...(guarded ? { beforeDispatch: guard } : {}) });
    expect(result.choices[0].message.content).toBe('Fixture response');
    expect(await f.calls()).toHaveLength(1); expect(fetchMock).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledTimes(guarded ? 3 : 0);
  });

  it('propagates cancellation after dispatch without another attempt and terminates the owned CLI child', async () => {
    const f = await fixture({ turns: [{ hold: true }] }), controller = new AbortController();
    const failure = new ScheduledJobLeaseLostError();
    const pending = invokeLLM({ messages,signal: controller.signal });
    const rejected = expect(pending).rejects.toHaveProperty('name','AbortError');
    await f.waitFile('calls.jsonl');
    const pid = (await f.calls())[0].pid;
    controller.abort(failure); await rejected;
    await vi.waitFor(() => expect(() => process.kill(pid,0)).toThrow(),{ timeout: 5000 });
    expect(await f.calls()).toHaveLength(1);
  });

  it('rejects a revoked result even after its CLI completion succeeds', async () => {
    const f = await fixture(), failure = new ScheduledJobLeaseLostError();
    let checks = 0;
    await expect(invokeLLM({ messages,beforeDispatch: async () => { if (++checks === 3) throw failure; } })).rejects.toBe(failure);
    expect(await f.calls()).toHaveLength(1);
  });
});
