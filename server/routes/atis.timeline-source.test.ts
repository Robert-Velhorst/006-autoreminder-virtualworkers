import express from 'express';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atisBoards, atisCards } from '../../drizzle/schema.postgres';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), fetchWithRetry: vi.fn(), analyze: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: mocks.fetchWithRetry }));
vi.mock('../services/atis-understanding', () => ({
  processCardUnderstanding: mocks.analyze, processAllCardsUnderstanding: vi.fn(), getUnderstandingStats: vi.fn(),
}));
vi.mock('../services/trello-checklist-sync', () => ({ createChecklistSyncService: vi.fn() }));
vi.mock('../services/attachment-extractor', () => ({ createAttachmentExtractor: vi.fn() }));
vi.mock('../services/chatbot-extractor', () => ({ createChatbotExtractor: vi.fn() }));
import router from './atis';

const board = '5abbe4b7ddc1b351ef961414';
const workspace = '5abbe4b7ddc1b351ef961417';
const unavailable = {
  error: 'Trello work queue is unavailable. Retry after checking the Trello connection.',
  code: 'TRELLO_BOARD_ACCESS_UNAVAILABLE',
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
function app(role?: string) {
  const app = express();
  app.use((req, _res, next) => {
    if (role) Object.assign(req, { user: { id: 7, role } });
    next();
  });
  app.use('/api/atis', router);
  return app;
}
function database(localBoards = true, storedChecklist: string | null = JSON.stringify([{ step: 'Check source' }, { step: 'Prepare draft' }])) {
  const conditions: unknown[] = [];
  const db = {
    select: vi.fn((projection?: any) => {
      let table: unknown;
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        leftJoin: () => query,
        where: (value: unknown) => { conditions.push(value); return query; },
        orderBy: () => query, limit: () => query, offset: () => query,
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
          const rows = table === atisBoards ? (localBoards ? [{ id: 11, trelloId: board, name: 'Verified board' }] : [])
            : table === atisCards ? (projection?.count ? [{ count: 1 }] : [{
              id: 12, trelloId: '5abbe4b7ddc1b351ef961419', name: 'Verified task',
              boardId: 11, listName: 'Doing', understandingId: 13,
              aptlssChecklist: storedChecklist,
            }]) : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    }),
    insert: vi.fn(() => { throw new Error('Timeline GET attempted a database write'); }),
    update: vi.fn(() => { throw new Error('Timeline GET attempted a database write'); }),
    delete: vi.fn(() => { throw new Error('Timeline GET attempted a database write'); }),
  };
  return { db, conditions };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TRELLO_API_KEY', 'fixture-key'); vi.stubEnv('TRELLO_TOKEN', 'fixture-token');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('ATIS timeline verified source access', () => {
  it.each([[undefined, 401], ['worker', 403], ['user', 403]] as const)(
    'denies %s before database or source access', async (role, status) => {
      const response = await request(app(role)).get('/api/atis/timeline-tasks');
      expect(response.status).toBe(status);
      expect(mocks.getDb).not.toHaveBeenCalled(); expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    },
  );
  it.each(['TRELLO_API_KEY', 'TRELLO_TOKEN'])('fails closed with missing %s', async key => {
    const { db } = database(); mocks.getDb.mockResolvedValue(db); vi.stubEnv(key, ' ');
    const response = await request(app('admin')).get('/api/atis/timeline-tasks');
    expect(response.status).toBe(503); expect(response.body).toEqual(unavailable);
    expect(db.select).not.toHaveBeenCalled(); expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500, 502])('does not expose stored tasks after HTTP %s', async status => {
    const { db } = database(); mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockResolvedValue({ ok: false, status });
    const response = await request(app('admin')).get('/api/atis/timeline-tasks');
    expect(response.status).toBe(503); expect(response.body).toEqual(unavailable);
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['retry-after']).toBe('5');
    expect(db.select).not.toHaveBeenCalled(); expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.analyze).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled();
  });
  it.each([null, {}, [null], [{}], [{ id: '../boards/private' }]])('rejects malformed inventory %j', async body => {
    const { db } = database(); mocks.getDb.mockResolvedValue(db); mocks.fetchWithRetry.mockResolvedValue(ok(body));
    const response = await request(app('admin')).get('/api/atis/timeline-tasks');
    expect(response.status).toBe(503); expect(response.body).toEqual(unavailable);
    expect(db.select).not.toHaveBeenCalled(); expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it.each(['organizations', 'workspace boards'])('rejects incomplete %s without using cached rows', async stage => {
    const { db } = database(); mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockResolvedValueOnce(ok([{ id: board }]));
    if (stage === 'workspace boards') mocks.fetchWithRetry.mockResolvedValueOnce(ok([{ id: workspace }]));
    mocks.fetchWithRetry.mockRejectedValue(new Error('fixture private transport diagnostics'));
    const response = await request(app('admin')).get('/api/atis/timeline-tasks');
    expect(response.status).toBe(503); expect(response.body).toEqual(unavailable);
    expect(db.select).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled();
  });
  it('preserves genuinely empty inventory and caller pagination', async () => {
    const { db } = database(); mocks.getDb.mockResolvedValue(db); mocks.fetchWithRetry.mockResolvedValue(ok([]));
    const response = await request(app('admin')).get('/api/atis/timeline-tasks?limit=20&offset=5&filter=all');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scheduled: [], overflow: [], pagination: { total: 0, limit: 20, offset: 5, hasMore: false }, filters: { filter: 'all' } });
    expect(db.select).not.toHaveBeenCalled(); expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(2);
  });
  it('does not fall back to unrelated local boards when verified boards are not yet ingested', async () => {
    const { db, conditions } = database(false); mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockResolvedValueOnce(ok([{ id: board }])).mockResolvedValueOnce(ok([]));
    const response = await request(app('admin')).get('/api/atis/timeline-tasks');
    expect(response.status).toBe(200); expect(response.body.scheduled).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(conditions[0] as any).params).toEqual([board]);
  });
  it('scopes both returned tasks and pagination totals to verified board IDs', async () => {
    const { db, conditions } = database(); mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockResolvedValueOnce(ok([{ id: board }])).mockResolvedValueOnce(ok([]));
    const response = await request(app('admin')).get('/api/atis/timeline-tasks?filter=all');
    expect(response.status).toBe(200); expect(response.body.scheduled).toHaveLength(1);
    expect(response.body.scheduled[0]).toMatchObject({ name: 'Verified task', boardName: 'Verified board' });
    expect(response.body.pagination.total).toBe(1);
    const queries = conditions.map(condition => new PgDialect().sqlToQuery(condition as any));
    expect(queries.map(query => query.params)).toEqual([[board], [0, 11], [0, 11]]);
    expect(mocks.analyze).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing checklist', stored: null, required: 1 },
    { label: 'empty stored checklist', stored: '[]', required: 1 },
    { label: 'valid one-step result', stored: JSON.stringify([{ step: 'Read the message' }]), required: 0 },
  ])('keeps repeated and concurrent reads passive for $label', async ({ stored, required }) => {
    const { db } = database(true, stored); mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockImplementation(async (input: string) => {
      const url = new URL(input);
      return ok(url.pathname === '/1/members/me/boards' ? [{ id: board }] : []);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const application = app('admin');
    const responses = await Promise.all(Array.from({ length: 3 }, () => request(application).get('/api/atis/timeline-tasks?filter=all')));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    expect(responses.map(response => response.body.analysisRequiredCount)).toEqual([required, required, required]);
    await request(application).get('/api/atis/timeline-tasks?filter=all').expect(200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
  });
});
