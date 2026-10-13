import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import trelloConfigRoutes from './trello-config';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));

const envKeys = [
  'TRELLO_API_KEY',
  'TRELLO_TOKEN',
  'APTLSS_MANAGER_SHADOW_ONLY',
  'APTLSS_MANAGER_PILOT_WORKER_IDS',
] as const;
const initialEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rowsQuery(rows: unknown[]) {
  const query: any = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

function configureWorkerDatabase(labels: string[] = [], profiles: unknown[] = []) {
  const settingsQuery = rowsQuery(labels.length ? [{ value: JSON.stringify(labels) }] : []);
  const profileQuery = rowsQuery(profiles);
  const db = {
    select: vi.fn((selection: Record<string, unknown>) =>
      'value' in selection ? settingsQuery : profileQuery),
  };
  mocks.getDb.mockResolvedValue(db);
  return db;
}

function createApp(user?: { id: number; role: string }): Express {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      (req as any).user = { ...user, openId: `${user.role}-${user.id}` };
      next();
    });
  }
  app.use('/api/trello', trelloConfigRoutes);
  return app;
}

describe('Trello worker route boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRELLO_API_KEY = 'test-key';
    process.env.TRELLO_TOKEN = 'test-token';
    delete process.env.APTLSS_MANAGER_SHADOW_ONLY;
    delete process.env.APTLSS_MANAGER_PILOT_WORKER_IDS;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = initialEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it.each([
    '/api/trello/cards/card-123/status',
    '/api/trello/cards/card-123/STATUS/',
    '/API/TRELLO/CARDS/%63ard-123/StAtUs/?view=worker',
  ])('blocks shadow completion on equivalent status path %s before database or provider access', async (path) => {
    process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
    process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp({ id: 2, role: 'worker' }))
      .put(path)
      .send({ isCompleted: true })
      .expect(409);

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/api/trello/tasks/task-123/complete',
    '/api/trello/tasks/task-123/COMPLETE/',
    '/API/TRELLO/TASKS/task-123/Complete/?view=worker',
  ])('blocks shadow checklist completion on equivalent task path %s before dependencies', async (path) => {
    process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
    process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp({ id: 2, role: 'worker' }))
      .put(path)
      .send({ isCompleted: true, cardId: 'card-123', checklistId: 'list-123', checkItemId: 'item-123' })
      .expect(409);

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/api/trello/cards/card-123/update',
    '/api/trello/cards/card-123/UPDATE/',
    '/API/TRELLO/CARDS/%63ard-123/UPDATE/?view=worker',
  ])('blocks shadow completion-label writes on equivalent update path %s before Trello access', async (path) => {
    process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
    process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
    const query = rowsQuery([{ value: JSON.stringify(['done-label']) }]);
    mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp({ id: 2, role: 'worker' }))
      .put(path)
      .send({ idLabels: ['done-label'] })
      .expect(409);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let a shadow-pilot worker remove a configured completion label from their settings', async () => {
    process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
    process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
    const query = rowsQuery([{ value: JSON.stringify(['done-label']) }]);
    const insert = vi.fn();
    mocks.getDb.mockResolvedValue({ select: vi.fn(() => query), insert });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp({ id: 2, role: 'worker' }))
      .post('/api/trello/completion-labels')
      .send({ labels: [] })
      .expect(409, { error: 'Completion label protection cannot be weakened while APTLSS is in shadow mode' });

    expect(insert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves a worker-configured completion label when an ordinary worker replaces card labels', async () => {
    configureWorkerDatabase(['done-label'], [{ trelloMemberId: 'member-2', status: 'active' }]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ idMembers: ['member-2'], idLabels: ['done-label', 'ordinary-label'] }))
      .mockResolvedValueOnce(response({ id: 'card-123', idLabels: ['ordinary-label', 'done-label'] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await request(createApp({ id: 2, role: 'worker' }))
      .put('/api/trello/cards/card-123/update')
      .send({ idLabels: ['ordinary-label'] })
      .expect(200);

    expect(result.body.card.idLabels).toEqual(['ordinary-label', 'done-label']);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('idLabels'))
      .toBe('ordinary-label,done-label');
  });

  it('rejects unsupported roles before profile lookup, credentials, or provider access', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp({ id: 9, role: 'founder' }))
      .put('/api/trello/cards/card-123/due')
      .send({ dueDate: '2026-09-26T12:00:00.000Z' })
      .expect(403, { error: 'Trello operations require an admin or worker account' });

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated direct API calls before dependencies', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp())
      .put('/api/trello/cards/card-123/due')
      .send({ dueDate: null })
      .expect(401, { error: 'Unauthorized' });

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a worker without an active linked profile before checking credentials or calling Trello', async () => {
    delete process.env.TRELLO_API_KEY;
    configureWorkerDatabase([], []);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp({ id: 2, role: 'worker' }))
      .put('/api/trello/cards/card-123/due')
      .send({ dueDate: '2026-09-26T12:00:00.000Z' })
      .expect(403, { error: 'An active worker profile is required to update Trello' });

    expect(mocks.getDb).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a card assigned to another Trello member without issuing a mutation', async () => {
    configureWorkerDatabase([], [{ trelloMemberId: 'member-2', status: 'active' }]);
    const fetchMock = vi.fn().mockResolvedValue(response({ idMembers: ['member-3'] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await request(createApp({ id: 2, role: 'worker' }))
      .put('/api/trello/cards/card-123/due')
      .send({ dueDate: '2026-09-26T12:00:00.000Z' })
      .expect(403, { error: 'This Trello card is not assigned to your linked member account' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });

  it('rejects workers attempting to change card membership before dependency access', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await request(createApp({ id: 2, role: 'worker' }))
      .put('/api/trello/cards/card-123/members')
      .send({ idMembers: ['member-3'] })
      .expect(403, { error: 'Only an admin can change Trello card membership' });

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
