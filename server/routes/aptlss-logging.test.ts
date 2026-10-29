import express from 'express';
import request from 'supertest';
import { format } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';

const controls = vi.hoisted(() => ({ db: undefined as any, trello: vi.fn(), fetchCard: vi.fn(), generate: vi.fn(), batch: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: controls.trello }));
vi.mock('../services/aptlss-generation', () => ({ fetchAptlssSourceCard: controls.fetchCard, generateAptlssForCard: controls.generate }));
vi.mock('../services/aptlss-scheduled-generation', () => ({ approvalSnapshotHash: vi.fn(), executeAptlssGenerationBatch: controls.batch }));
import router from './aptlss';

const actor = { id: 7, openId: 'synthetic-founder', role: 'admin', sessionEpoch: '1' };
const privateText = 'synthetic-private-detail\r\nforged\x1b[2J\u2028';
const card = { id: privateText, name: 'Synthetic card', desc: 'Read the report and record what action is needed.' };

function app(role: string | null = 'admin') {
  const instance = express().use(express.json());
  instance.use((req, _res, next) => { (req as any).user = role ? { ...actor, role } : null; next(); });
  return instance.use('/api', router);
}

function expectPrivateLogs() {
  const calls = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls];
  expect(calls.length).toBeGreaterThan(0);
  for (const args of calls) {
    const line = format(...args);
    expect(line).not.toContain('synthetic-private-detail');
    expect(line).not.toContain('forged');
    expect(line).not.toMatch(/[\r\n\x1b\u2028\u2029]/);
    expect(args.some(arg => arg instanceof Error)).toBe(false);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  controls.db = timerTestDatabase(new Map([[users, [{ ...actor }]]])).db;
  controls.generate.mockResolvedValue({ success: true });
  controls.batch.mockResolvedValue({ success: true, results: [] });
  vi.stubEnv('TRELLO_API_KEY', 'synthetic-key');
  vi.stubEnv('TRELLO_TOKEN', 'synthetic-token');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('board provider failure log boundary', () => {
  for (const status of [401, 403, 404, 429, 500]) {
    it.each([false, true])(`keeps status ${status} mapping and private provider text (text failure=%s)`, async textFailure => {
      const provider = new Response(privateText, { status, statusText: 'Provider error' });
      if (textFailure) {
        Object.defineProperty(provider, 'statusText', { value: privateText });
        vi.spyOn(provider, 'text').mockRejectedValue(new Error(privateText));
      }
      const cancel = vi.spyOn(provider.body!, 'cancel');
      controls.trello.mockResolvedValue(provider);
      const response = await request(app()).get('/api/trello/boards/abcdefgh/cards?forceRefresh=true');
      expect(response.status).toBe(status === 403 ? 401 : status);
      const errors: Record<number, string> = {
        401: 'Unauthorized - Invalid Trello credentials', 403: 'Unauthorized - Invalid Trello credentials',
        404: 'Board not found', 429: 'Rate limited by Trello - please try again later', 500: 'Failed to fetch cards from Trello',
      };
      expect(response.body).toEqual({ error: errors[status] });
      expect(response.headers['x-cache']).toBeUndefined();
      expect(console.error).toHaveBeenCalledWith('Trello API error fetching board cards:', status);
      expect(cancel).toHaveBeenCalledOnce();
      expect(provider.bodyUsed).toBe(true);
      expectPrivateLogs();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  it('preserves status mapping when cancelling an unused error body rejects', async () => {
    const provider = new Response(privateText, { status: 404 });
    vi.spyOn(provider.body!, 'cancel').mockRejectedValue(new Error(privateText));
    controls.trello.mockResolvedValue(provider);
    const response = await request(app()).get('/api/trello/boards/abcdefgh/cards?forceRefresh=true');
    expect(response.status).toBe(404);
    expectPrivateLogs();
  });

  it.each([new Error(privateText), privateText])('keeps transport rejection details private: %j', async error => {
    controls.trello.mockRejectedValue(error);
    const response = await request(app()).get('/api/trello/boards/abcdefgh/cards?forceRefresh=true');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to fetch cards from Trello' });
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Error fetching cards');
    expectPrivateLogs();
  });
});

describe('manual generation log boundary', () => {
  it.each([privateText, { clarifiedGoal: privateText }, [privateText], null])('preserves service inputs without logging ID/settings %j', async settings => {
    const response = await request(app()).post('/api/aptlss/generate').send({ cardData: card, settings });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(controls.generate).toHaveBeenCalledWith(card, {
      ...(settings && typeof settings === 'object' ? settings : {}), applyToTrello: false,
    }, expect.objectContaining({ assertOwnership: expect.any(Function), signal: expect.any(AbortSignal) }));
    expect(console.log).toHaveBeenCalledWith('Generating APTLSS');
    expectPrivateLogs();
    expect(controls.fetchCard).not.toHaveBeenCalled();
  });

  it.each([new Error(privateText), privateText])('keeps generation rejection details private: %j', async error => {
    controls.generate.mockRejectedValue(error);
    const response = await request(app()).post('/api/aptlss/generate').send({ cardData: card });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to generate APTLSS. Retry shortly or check the service configuration.' });
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Error generating APTLSS');
    expectPrivateLogs();
  });

  it('keeps source-fetch rejection details private without starting generation', async () => {
    controls.fetchCard.mockRejectedValue(new Error(privateText));
    const response = await request(app()).post('/api/aptlss/generate').send({ cardId: 'abcdefgh' });
    expect(response.status).toBe(500);
    expect(controls.generate).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Error generating APTLSS');
    expectPrivateLogs();
  });

  it('keeps an outer batch failure private while preserving the response', async () => {
    controls.batch.mockRejectedValue(new Error(privateText));
    const response = await request(app()).post('/api/aptlss/generate-batch').send({ cardIds: ['abcdefgh'] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to batch generate APTLSS' });
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Error in batch generation');
    expectPrivateLogs();
  });

  it('preserves successful batch input, item failure results and owner identity', async () => {
    const result = { success: true, results: [{ cardId: 'abcdefgh', success: false, error: 'Synthetic item failure' }] };
    controls.batch.mockResolvedValue(result);
    const settings = { clarifiedGoal: privateText };
    const response = await request(app()).post('/api/aptlss/generate-batch').send({ cardIds: ['abcdefgh'], settings });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(controls.batch).toHaveBeenCalledWith(expect.objectContaining({ cardIds: ['abcdefgh'], settings, createdBy: actor.openId }));
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([null, 'worker'])('keeps role %s out of generation before service effects', async role => {
    for (const endpoint of ['generate', 'generate-batch']) {
      const response = await request(app(role)).post(`/api/aptlss/${endpoint}`).send({ cardData: card, cardIds: ['abcdefgh'] });
      expect(response.status).toBe(role ? 403 : 401);
    }
    expect(controls.generate).not.toHaveBeenCalled();
    expect(controls.batch).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
