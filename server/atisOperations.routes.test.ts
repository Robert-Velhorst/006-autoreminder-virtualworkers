import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn(), active: vi.fn(), card: vi.fn(), batch: vi.fn(),
  outcome: vi.fn(), db: vi.fn(), fetch: vi.fn(), preview: vi.fn(), confirm: vi.fn(), analysis: vi.fn(), limit: vi.fn() }));
vi.mock('./atisOperations', async original => ({ ...await original<typeof import('./atisOperations')>(),
  startAtisOperation: mocks.start, getAtisOperation: mocks.get, getActiveAtisOperations: mocks.active }));
vi.mock('./atisAnalysisAdmission', async original => ({ ...await original<typeof import('./atisAnalysisAdmission')>(),
  createAtisAnalysisPreview: mocks.preview, confirmAtisAnalysisPreview: mocks.confirm, getAtisAnalysisJob: mocks.analysis }));
vi.mock('./db', () => ({ getDb: mocks.db }));
vi.mock('./services/atis-understanding', () => ({ processCardUnderstanding: mocks.card,
  processCardUnderstandingOutcome: mocks.outcome, processAllCardsUnderstanding: mocks.batch, getUnderstandingStats: vi.fn() }));
vi.mock('./utils/retry', () => ({ fetchWithRetry: mocks.fetch }));
vi.mock('./services/redis', () => ({ getRedis: () => null, isRedisAvailable: () => false }));
vi.mock('./middleware/rate-limiter', async original => ({ ...await original<typeof import('./middleware/rate-limiter')>(),
  atisRateLimiter: (req: unknown, res: unknown, next: () => void) => mocks.limit(req, res, next) }));
import router from './routes/atis';
import { AtisOperationRecoveryRequired, AtisOperationRequestConflict } from './atisOperations';
import { AtisAnalysisAdmissionError } from './atisAnalysisAdmission';
import { ScheduledJobLeaseLostError } from './scheduledJobRuntime';

const id = '00000000-0000-4000-8000-000000000001';
const preview = { id, expiresAt: '2026-10-21T12:10:00Z', matched: 1, total: 1, remaining: 0, cards: [{ id: 3, name: 'Retained card' }] };
const analysis = { id, state: 'queued', matched: 1, total: 1, remaining: 0, processed: 0, generated: 0,
  fallback: 0, missing: 0, failed: 0, uncertain: 0, pending: 1, items: [{ cardId: 3, cardName: 'Retained card', state: 'pending' }] };
const operation = { id: 12, kind: 'sync' as const, state: 'running' as const };
const paths = ['/understanding/process', '/understanding/reprocess-failed', '/understanding/reprocess/3', '/understanding/reanalyze-all'];
const confirmation = { phase: 'confirm', previewId: id, requestKey: 'request-1' };
function app(role?: string, userId = 2) {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => { if (role) Object.assign(req, { user: { id: userId, role } }); next(); });
  server.use('/api/atis', router); return server;
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TRELLO_API_KEY', 'test-key'); vi.stubEnv('TRELLO_TOKEN', 'test-token');
  mocks.limit.mockImplementation((_req, _res, next) => next());
  mocks.preview.mockResolvedValue(preview); mocks.confirm.mockResolvedValue(analysis);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('ATIS analysis preview/confirm HTTP contract', () => {
  it.each([undefined, 'worker'])('preserves admin authority on every start and poll (%s)', async role => {
    for (const path of [...paths, '/understanding/preview']) {
      expect((await request(app(role)).post('/api/atis' + path).send({})).status).toBe(role ? 403 : 401);
    }
    for (const path of ['/operations/active', '/operations/12', '/understanding/analyses/' + id]) {
      expect((await request(app(role)).get('/api/atis' + path)).status).toBe(role ? 403 : 401);
    }
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.analysis).not.toHaveBeenCalled(); expect(mocks.limit).not.toHaveBeenCalled();
  });

  it.each([
    [paths[0], {}, { mode: 'pending', limit: 100 }],
    [paths[0], { phase: 'preview', cardId: 3 }, { mode: 'single', cardId: 3, limit: 1 }],
    [paths[1], {}, { mode: 'low_confidence', limit: 50 }],
    [paths[2], { interviewGoal: 'Check source', interviewDeliverable: 'Checked report', interviewSuccessCriteria: ['Cite original'] },
      { mode: 'single', cardId: 3, limit: 1, guidance: { goal: 'Check source', deliverable: 'Checked report', successCriteria: ['Cite original'] } }],
    [paths[3], { boardId: '12', limit: 25, afterCardId: 5 }, { mode: 'reanalyze', boardId: 12, limit: 25, afterCardId: 5 }],
    [paths[3], { forceAll: true }, { mode: 'reanalyze', forceAll: true, limit: 100 }],
    [paths[3], { cardIds: [4, 3] }, { mode: 'reanalyze', cardIds: [3, 4], limit: 100 }],
  ])('maps %s preview input %j without invoking providers', async (path, body, selection) => {
    const response = await request(app('admin')).post('/api/atis' + path).send(body).expect(200);
    expect(response.body).toEqual({ preview }); expect(response.headers['cache-control']).toBe('no-store');
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(2, selection);
    expect(mocks.limit).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
    for (const action of [mocks.card, mocks.batch, mocks.outcome, mocks.start, mocks.fetch]) expect(action).not.toHaveBeenCalled();
  });

  it('accepts explicit bounded selections including active placeholders', async () => {
    const selection = { mode: 'active_placeholders', boardId: 12, afterCardId: 0, limit: 20, guidance: { goal: 'Review' } };
    await request(app('admin')).post('/api/atis/understanding/preview').send({ selection }).expect(200, { preview });
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(2, selection);
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it.each(paths)('confirms the frozen preview only through %s and returns durable analysis identity', async path => {
    await request(app('admin')).post('/api/atis' + path)
      .send({ ...confirmation, acknowledgeInterruptedOperationId: 12 }).expect(202, { analysis });
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(2, id, { requestKey: 'request-1', acknowledgeInterruptedOperationId: 12 });
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.limit).toHaveBeenCalledOnce();
    expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.batch).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'bad' }, { phase: null }, { cardId: 0 }, { cardId: '3' }, { limit: 0 }, { limit: 101 }, { limit: '10' },
    { limit: 1.5 }, { boardId: '12garbage' }, { cardIds: [] }, { cardIds: [1, 1] }, { cardIds: [1, '2'] },
    { cardIds: '1,2' }, { forceAll: 'false' }, { minConfidence: -1 }, { minConfidence: 101 }, { minConfidence: 1.5 },
    { forceAll: true, boardId: 1 }, { cardIds: [1], boardId: 2 }, { cardId: 3, cardIds: [3] },
    { interviewGoal: 'x'.repeat(4001) }, { interviewSuccessCriteria: [1] }, { interviewSuccessCriteria: ['x'.repeat(501)] },
  ])('rejects malformed or ambiguous selection %j without widening to all cards', async body => {
    await request(app('admin')).post('/api/atis/understanding/reanalyze-all').send(body).expect(400);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.limit).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'confirm' }, { phase: 'confirm', previewId: id }, { ...confirmation, requestKey: '' },
    { ...confirmation, requestKey: 'x'.repeat(129) }, { ...confirmation, requestKey: ' spaced ' },
    { ...confirmation, previewId: 'bad-id' }, { ...confirmation, boardId: 99 }, { ...confirmation, cardIds: [99] },
    { ...confirmation, acknowledgeInterruptedOperationId: 0 },
  ])('rejects invalid confirmation %j before dispatch', async body => {
    await request(app('admin')).post('/api/atis/understanding/process').send(body).expect(400);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '3junk', '1.5', '9007199254740992'])('rejects invalid path ID %s for preview and confirm', async cardId => {
    for (const body of [{}, confirmation]) {
      await request(app('admin')).post('/api/atis/understanding/reprocess/' + cardId).send(body).expect(400);
    }
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'REQUEST_CONFLICT'], [409, 'EXPIRED'], [409, 'RECOVERY_REQUIRED'], [503, 'UNAVAILABLE'],
  ] as const)('propagates typed confirmation refusal %s/%s without exposing private failures', async (status, code) => {
    mocks.confirm.mockRejectedValue(new AtisAnalysisAdmissionError(status, code));
    const response = await request(app('admin')).post('/api/atis/understanding/process').send(confirmation).expect(status);
    expect(response.body.code).toBe(code); expect(response.body.analysis).toBeUndefined();
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.card).not.toHaveBeenCalled();
  });

  it('returns the same analysis for an identical confirmation replay without reselecting cards', async () => {
    const server = app('admin');
    for (let i = 0; i < 2; i++) await request(server).post('/api/atis/understanding/process').send(confirmation).expect(202, { analysis });
    expect(mocks.confirm).toHaveBeenCalledTimes(2); expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });

  it('scopes status to the current admin and never starts or reselects work while polling', async () => {
    mocks.analysis.mockResolvedValueOnce({ ...analysis, state: 'interrupted' }).mockResolvedValueOnce(null);
    await request(app('admin')).get('/api/atis/understanding/analyses/' + id).expect(200, { analysis: { ...analysis, state: 'interrupted' } });
    await request(app('admin', 9)).get('/api/atis/understanding/analyses/' + id).expect(404);
    expect(mocks.analysis.mock.calls).toEqual([[2, id], [9, id]]);
    mocks.analysis.mockRejectedValue(new Error('Private database credentials'));
    const response = await request(app('admin')).get('/api/atis/understanding/analyses/' + id).expect(503);
    expect(JSON.stringify(response.body)).not.toContain('Private');
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('charges only confirmations against the actual three-per-minute limiter', async () => {
    const actual = await vi.importActual<typeof import('./middleware/rate-limiter')>('./middleware/rate-limiter');
    mocks.limit.mockImplementation(actual.atisRateLimiter);
    const server = app('admin', 987654);
    for (let i = 0; i < 5; i++) await request(server).post('/api/atis/understanding/process').send({}).expect(200);
    for (let i = 0; i < 3; i++) await request(server).post('/api/atis/understanding/process').send(confirmation).expect(202);
    const refused = await request(server).post('/api/atis/understanding/process').send(confirmation).expect(429);
    expect(refused.body.limit).toBe(3); expect(mocks.confirm).toHaveBeenCalledTimes(3);
    expect(mocks.preview).toHaveBeenCalledTimes(5);
  });
});

describe('unchanged ATIS sync operations contract', () => {
  it.each(['recovery', 'different request'])('returns an explicit sync not-started conflict for %s', async reason => {
    const op = { ...operation, state: reason === 'recovery' ? 'interrupted' as const : 'running' as const };
    mocks.start.mockRejectedValue(reason === 'recovery' ? new AtisOperationRecoveryRequired(op) : new AtisOperationRequestConflict(op));
    const response = await request(app('admin')).post('/api/atis/sync').send({ acknowledgeInterruptedOperationId: 12 }).expect(409);
    expect(response.body).toMatchObject({ operation: op, requestedNotStarted: true });
    expect(mocks.start.mock.calls[0][0].acknowledgeInterruptedOperationId).toBe(12);
  });
  it('polling includes interruption and never starts work', async () => {
    mocks.active.mockResolvedValue([{ ...operation, state: 'interrupted' }]);
    const response = await request(app('admin')).get('/api/atis/operations/active').expect(200);
    expect(response.body.operations[0].state).toBe('interrupted');
    mocks.get.mockRejectedValue(new Error('Private DB host'));
    const failed = await request(app('admin')).get('/api/atis/operations/12').expect(503);
    expect(failed.body.operation).toBeUndefined(); expect(JSON.stringify(failed.body)).not.toContain('Private');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('sync refuses provider work after lease loss', async () => {
    mocks.start.mockResolvedValue(operation);
    mocks.db.mockResolvedValue({ transaction: vi.fn() });
    await request(app('admin')).post('/api/atis/sync').send({}).expect(202);
    const context = { signal: new AbortController().signal, assertOwnership: vi.fn().mockRejectedValue(new ScheduledJobLeaseLostError()) };
    await expect(mocks.start.mock.calls[0][1](context)).rejects.toThrow(ScheduledJobLeaseLostError);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
