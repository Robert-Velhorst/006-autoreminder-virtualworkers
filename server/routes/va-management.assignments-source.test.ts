import express from 'express';
import request from 'supertest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atisBoards, atisCards, taskAssignments } from '../../drizzle/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), fetchWithRetry: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: mocks.fetchWithRetry }));
vi.mock('../services/trello-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('../services/websocket', () => ({ websocketService: { emitToUser: vi.fn() } }));
import router from './va-management';

const boardA = '5abbe4b7ddc1b351ef961414';
const boardB = '5abbe4b7ddc1b351ef961415';
const otherBoard = '5abbe4b7ddc1b351ef961416';
const workspace = '5abbe4b7ddc1b351ef961417';
const unavailable = {
  error: 'Trello assignments are unavailable. Retry after checking the Trello connection.',
  code: 'TRELLO_ASSIGNMENTS_UNAVAILABLE',
};

function app(role?: string) {
  const app = express();
  app.use((req, _res, next) => {
    if (role) Object.assign(req, { user: { id: 7, openId: 'fixture-admin', role } });
    next();
  });
  app.use('/api/va', router);
  return app;
}

function database() {
  const conditions: unknown[] = [];
  const joins: Array<{ table: unknown; condition: unknown }> = [];
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        innerJoin: (value: unknown, condition: unknown) => { joins.push({ table: value, condition }); return query; },
        leftJoin: (value: unknown, condition: unknown) => { joins.push({ table: value, condition }); return query; },
        where: (value: unknown) => { conditions.push(value); return query; },
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
          const rows = table === atisBoards ? [{ trelloId: otherBoard }]
            : table === atisCards ? [{
              id: 1, trelloId: 'test-card', name: 'Authorized task',
              boardId: 1, boardName: 'Source board', listName: 'Doing',
            }] : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    }),
  };
  return { db, conditions, joins };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function healthySource() {
  mocks.fetchWithRetry.mockResolvedValueOnce(ok([{ id: boardA }]))
    .mockResolvedValueOnce(ok([{ id: workspace }]))
    .mockResolvedValueOnce(ok([{ id: boardA }, { id: boardB }, { id: otherBoard, prefs: { isTemplate: true } }]));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TRELLO_API_KEY', 'fixture-key&encoded');
  vi.stubEnv('TRELLO_TOKEN', 'fixture-token&encoded');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('founder assignment source access', () => {
  it.each([[undefined, 401], ['worker', 403], ['user', 403]] as const)(
    'denies %s before database or provider access', async (role, status) => {
      const response = await request(app(role)).get('/api/va/assignments');
      expect(response.status).toBe(status);
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    },
  );

  it('distinguishes a database outage from Trello access', async () => {
    mocks.getDb.mockResolvedValue(null);
    const response = await request(app('admin')).get('/api/va/assignments');
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('Database not available');
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it.each(['TRELLO_API_KEY', 'TRELLO_TOKEN'])('fails closed without %s', async key => {
    const { db } = database();
    mocks.getDb.mockResolvedValue(db);
    vi.stubEnv(key, '  ');
    const response = await request(app('admin')).get('/api/va/assignments');
    expect(response.status).toBe(503);
    expect(response.body).toEqual(unavailable);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 502])('does not fall back to local boards after provider HTTP %s', async status => {
    const { db } = database();
    mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockResolvedValue({ ok: false, status, json: async () => ({ error: 'fixture upstream secret' }) });
    const response = await request(app('admin')).get('/api/va/assignments');
    expect(response.status).toBe(503);
    expect(response.body).toEqual(unavailable);
    expect(db.select).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('fixture upstream secret');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['retry-after']).toBe('5');
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['network', 'timeout', 'body read'])('does not expose cached cards after %s failure', async failure => {
    const { db } = database();
    mocks.getDb.mockResolvedValue(db);
    if (failure === 'body read') mocks.fetchWithRetry.mockResolvedValue({ ok: true, json: async () => { throw new Error('secret body failure'); } });
    else mocks.fetchWithRetry.mockRejectedValue(new Error('secret transport failure'));
    const response = await request(app('admin')).get('/api/va/assignments');
    expect(response.status).toBe(503);
    expect(response.body).toEqual(unavailable);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([null, {}, [null], [{}], [{ id: 123 }], [{ id: '' }], [{ id: '../boards/private' }]])(
    'rejects malformed provider inventory %j rather than treating it as empty', async body => {
      const { db } = database();
      mocks.getDb.mockResolvedValue(db);
      mocks.fetchWithRetry.mockResolvedValue(ok(body));
      const response = await request(app('admin')).get('/api/va/assignments');
      expect(response.status).toBe(503);
      expect(response.body).toEqual(unavailable);
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it.each(['organizations', 'workspace boards'])('does not publish a partial inventory when %s is unavailable', async stage => {
    const { db } = database();
    mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockResolvedValueOnce(ok([{ id: boardA }]));
    if (stage === 'workspace boards') mocks.fetchWithRetry.mockResolvedValueOnce(ok([{ id: workspace }]));
    mocks.fetchWithRetry.mockResolvedValue({ ok: false, status: 503 });
    const response = await request(app('admin')).get('/api/va/assignments');
    expect(response.status).toBe(503);
    expect(response.body).toEqual(unavailable);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns a genuine empty list only after all provider inventories succeeded', async () => {
    const { db } = database();
    mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockResolvedValue(ok([]));
    const response = await request(app('admin')).get('/api/va/assignments');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('preserves member and workspace boards, deduplicates them and retains founder-scoped joins', async () => {
    const { db, conditions, joins } = database();
    mocks.getDb.mockResolvedValue(db);
    healthySource();
    const response = await request(app('admin')).get('/api/va/assignments');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ cardName: 'Authorized task', taskId: 'test-card', status: 'unassigned' })]);
    const dialect = new MySqlDialect();
    const cardQuery = dialect.sqlToQuery(conditions[0] as any);
    expect(cardQuery.params).toEqual([0, boardA, boardB]);
    const assignmentJoin = joins.find(join => join.table === taskAssignments)!;
    expect(dialect.sqlToQuery(assignmentJoin.condition as any).params).toEqual([7]);
    const urls = mocks.fetchWithRetry.mock.calls.map(([url]) => new URL(url));
    expect(urls.map(url => url.pathname)).toEqual(['/1/members/me/boards', '/1/members/me/organizations', `/1/organizations/${workspace}/boards`]);
    for (const url of urls) {
      expect(url.searchParams.get('key')).toBe('fixture-key&encoded');
      expect(url.searchParams.get('token')).toBe('fixture-token&encoded');
    }
    const signals = mocks.fetchWithRetry.mock.calls.map(([, init, options]) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe('error');
      expect(options.maxRetries).toBe(0);
      return init.signal;
    });
    expect(new Set(signals).size).toBe(1);
  });

  it('recovers on a later verified request without reusing failed access', async () => {
    const { db } = database();
    mocks.getDb.mockResolvedValue(db);
    mocks.fetchWithRetry.mockRejectedValueOnce(new Error('fixture connection unavailable'));
    const first = await request(app('admin')).get('/api/va/assignments');
    expect(first.status).toBe(503);
    expect(db.select).not.toHaveBeenCalled();
    healthySource();
    const second = await request(app('admin')).get('/api/va/assignments');
    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(1);
  });
});
