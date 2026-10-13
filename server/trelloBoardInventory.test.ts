import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchVerifiedTrelloBoardIds, TrelloBoardInventoryUnavailableError } from './trelloBoardInventory';

const board = '5abbe4b7ddc1b351ef961414';
const workspace = '5abbe4b7ddc1b351ef961417';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('verified Trello inventory transport', () => {
  it('uses the shared deadline, rejects redirects and keeps credentials in encoded query fields', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(json([{ id: board }])).mockResolvedValueOnce(json([{ id: workspace }]))
      .mockResolvedValueOnce(json([{ id: board, prefs: null }]));
    expect(await fetchVerifiedTrelloBoardIds('fixture&key=1', 'fixture&token=2')).toEqual([board]);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(new Set(fetchMock.mock.calls.map(([, init]) => init.signal)).size).toBe(1);
    for (const [url, init] of fetchMock.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('key')).toBe('fixture&key=1');
      expect(parsed.searchParams.get('token')).toBe('fixture&token=2');
      expect(init.redirect).toBe('error');
    }
  });
  it.each([401, 403, 429, 500, 502])('does not retry provider HTTP %s during an interactive request', async status => {
    fetchMock.mockResolvedValue(json({ error: 'private provider diagnostics' }, status));
    await expect(fetchVerifiedTrelloBoardIds('fixture-key', 'fixture-token')).rejects.toThrow(TrelloBoardInventoryUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([[{ id: workspace, prefs: { isTemplate: 'false' } }], [{ id: 'not-a-workspace' }]])(
    'rejects malformed workspace data %j before constructing its board request', async workspaces => {
      fetchMock.mockResolvedValueOnce(json([{ id: board }])).mockResolvedValueOnce(json(workspaces));
      await expect(fetchVerifiedTrelloBoardIds('fixture-key', 'fixture-token')).rejects.toThrow(TrelloBoardInventoryUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it('sanitizes a credential-bearing transport exception', async () => {
    fetchMock.mockRejectedValue(new Error('https://api.trello.com/?token=private-value'));
    try { await fetchVerifiedTrelloBoardIds('fixture-key', 'fixture-token'); expect.fail('Expected unavailable'); }
    catch (error) {
      expect(error).toBeInstanceOf(TrelloBoardInventoryUnavailableError);
      expect(String(error)).not.toContain('private-value');
      expect((error as Error).cause).toBeUndefined();
    }
  });
  it.each(['fetch', 'response body'])('aborts slow %s and never returns a partial inventory', async stage => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    fetchMock.mockImplementation(async (_url, init) => {
      const pending = () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
      if (stage === 'fetch') return pending();
      return { ok: true, json: pending };
    });
    const result = expect(fetchVerifiedTrelloBoardIds('fixture-key', 'fixture-token')).rejects.toThrow(TrelloBoardInventoryUnavailableError);
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects a completed JSON read if the shared deadline already expired', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockResolvedValue({ ok: true, json: async () => { controller.abort(); return [{ id: board }]; } });
    await expect(fetchVerifiedTrelloBoardIds('fixture-key', 'fixture-token')).rejects.toThrow(TrelloBoardInventoryUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
