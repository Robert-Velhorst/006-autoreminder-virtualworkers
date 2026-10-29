import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ trello: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => undefined }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: controls.trello }));
import router from './aptlss';

function app(role: string | null = 'admin') {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as any).user = role ? { id: 7, openId: 'synthetic-board-owner', role } : null;
    next();
  });
  value.use('/api', router);
  return value;
}

beforeEach(() => {
  controls.trello.mockReset();
  controls.trello.mockResolvedValue({ ok: true, json: async () => [] });
  vi.stubEnv('TRELLO_API_KEY', 'fixture-key');
  vi.stubEnv('TRELLO_TOKEN', 'fixture-token');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider request'); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('mounted Trello board identifier boundary', () => {
  for (const id of ['short', 'a'.repeat(7), 'a'.repeat(33), 'board/child', '../cards', 'board?query',
    'board#fragment', 'abcdefgh\r\n[forged]', 'abcdefgh\u001b[2J', 'abcdefgh%0a',
    'abcdefgh%2fchild', 'abcdefgh\u2028', ' abcdefgh', 'abcdefgh ', '__proto__']) {
    it(`rejects invalid identifiers before board effects: ${JSON.stringify(id)}`, async () => {
      const base = `/api/trello/boards/${encodeURIComponent(id)}`;
      for (const response of [await request(app()).get(`${base}/cards`),
        await request(app()).post(`${base}/cache/clear`)]) {
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Invalid Trello board ID' });
      }
      expect(controls.trello).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    });
  }

  it.each(['a1B2c3D4', 'a'.repeat(24), 'Z'.repeat(32)])('keeps supported identifier %s', async id => {
    const response = await request(app()).get(`/api/trello/boards/${id}/cards`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(controls.trello).toHaveBeenCalledWith(
      `https://api.trello.com/1/boards/${id}/cards?key=fixture-key&token=fixture-token&checklists=all&list=true&board=true`,
      undefined, expect.any(Object));
    await request(app()).post(`/api/trello/boards/${id}/cache/clear`).expect(200);
  });

  it('preserves cache hit and clear behavior for a valid board', async () => {
    const base = `/api/trello/boards/${'b'.repeat(24)}`;
    expect((await request(app()).get(`${base}/cards`)).headers['x-cache']).toBe('MISS');
    expect((await request(app()).get(`${base}/cards`)).headers['x-cache']).toBe('HIT');
    expect(controls.trello).toHaveBeenCalledTimes(1);
    await request(app()).post(`${base}/cache/clear`).expect(200);
    expect((await request(app()).get(`${base}/cards`)).headers['x-cache']).toBe('MISS');
    expect(controls.trello).toHaveBeenCalledTimes(2);
  });

  it('retains explicit refresh bypass and does not cache provider failures', async () => {
    const base = `/api/trello/boards/${'d'.repeat(24)}`;
    await request(app()).get(`${base}/cards`).expect(200);
    await request(app()).get(`${base}/cards?refresh=true`).expect(200);
    expect(controls.trello).toHaveBeenCalledTimes(2);
    controls.trello.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Board not found' });
    await request(app()).get(`${base}/cards?refresh=true`).expect(404);
    expect((await request(app()).get(`${base}/cards`)).headers['x-cache']).toBe('HIT');
    expect(controls.trello).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid identifiers even when provider credentials are unavailable', async () => {
    vi.stubEnv('TRELLO_API_KEY', '');
    vi.stubEnv('TRELLO_TOKEN', '');
    const base = `/api/trello/boards/${encodeURIComponent('abcdefgh\nforged')}`;
    await request(app()).get(`${base}/cards`).expect(400);
    await request(app()).post(`${base}/cache/clear`).expect(400);
    expect(controls.trello).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each([null, 'worker', 'user'])('retains authentication before effects for %s', async role => {
    const base = `/api/trello/boards/${'c'.repeat(24)}`;
    await request(app(role)).get(`${base}/cards`).expect(role ? 403 : 401);
    await request(app(role)).post(`${base}/cache/clear`).expect(role ? 403 : 401);
    expect(controls.trello).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
