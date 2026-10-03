import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import trelloConfigRoutes from './trello-config';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));

describe('Trello Config Routes', () => {
  let app: Express;
  const originalTrelloApiKey = process.env.TRELLO_API_KEY;
  const originalTrelloToken = process.env.TRELLO_TOKEN;
  const originalPilotWorkerIds = process.env.APTLSS_MANAGER_PILOT_WORKER_IDS;
  const originalShadowOnly = process.env.APTLSS_MANAGER_SHADOW_ONLY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 1, openId: 'admin-1', role: 'admin' };
      next();
    });
    app.use('/api/trello', trelloConfigRoutes);

    // Mock environment variables
    process.env.TRELLO_API_KEY = 'test-key';
    process.env.TRELLO_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalTrelloApiKey === undefined) delete process.env.TRELLO_API_KEY;
    else process.env.TRELLO_API_KEY = originalTrelloApiKey;
    if (originalTrelloToken === undefined) delete process.env.TRELLO_TOKEN;
    else process.env.TRELLO_TOKEN = originalTrelloToken;
    if (originalPilotWorkerIds === undefined) delete process.env.APTLSS_MANAGER_PILOT_WORKER_IDS;
    else process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = originalPilotWorkerIds;
    if (originalShadowOnly === undefined) delete process.env.APTLSS_MANAGER_SHADOW_ONLY;
    else process.env.APTLSS_MANAGER_SHADOW_ONLY = originalShadowOnly;
  });

  describe('PUT /api/trello/tasks/:taskId/complete', () => {
    it('should return 400 when missing required fields', async () => {
      const response = await request(app)
        .put('/api/trello/tasks/task-123/complete')
        .send({
          isCompleted: true,
          // Missing cardId, checklistId, checkItemId
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return unavailable when Trello credentials are missing', async () => {
      delete process.env.TRELLO_API_KEY;

      const response = await request(app)
        .put('/api/trello/tasks/task-123/complete')
        .send({
          isCompleted: true,
          cardId: 'card-123',
          checklistId: 'checklist-123',
          checkItemId: 'item-123',
        });

      expect(response.status).toBe(503);
      expect(response.body.error).toContain('Trello credentials not configured');
    });

    it('rejects a checklist item that is not present on the selected card', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        checklists: [{ id: 'list-123', checkItems: [{ id: 'item-123' }] }],
      }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(app)
        .put('/api/trello/tasks/task-123/complete')
        .send({ isCompleted: true, cardId: 'card-123', checklistId: 'list-123', checkItemId: 'item-from-another-list' })
        .expect(403);

      expect(response.body.error).toBe('The checklist item does not belong to the selected Trello card');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('checklists=all');
    });

    it('updates only a checklist item verified on the selected card', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          checklists: [{ id: 'list-123', checkItems: [{ id: 'item-123' }] }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'item-123' }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(app)
        .put('/api/trello/tasks/task-123/complete')
        .send({ isCompleted: true, cardId: 'card-123', checklistId: 'list-123', checkItemId: 'item-123' })
        .expect(200);

      expect(response.body).toMatchObject({ success: true, checkItemId: 'item-123' });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][0])).toContain('/checklists/list-123/checkItems/item-123');
    });

    it('rejects a worker pairing an assigned card with checklist identifiers from elsewhere', async () => {
      const query: any = {
        from: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn().mockResolvedValue([{ trelloMemberId: 'member-2', status: 'active' }]),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });

      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        idMembers: ['member-2'],
        checklists: [{ id: 'list-on-assigned-card', checkItems: [{ id: 'item-on-assigned-card' }] }],
      }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(workerApp)
        .put('/api/trello/tasks/task-123/complete')
        .send({ isCompleted: true, cardId: 'assigned-card', checklistId: 'list-on-other-card', checkItemId: 'item-on-other-card' })
        .expect(403, { error: 'The checklist item does not belong to the selected Trello card' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('blocks worker Trello writes when active profile identity is ambiguous', async () => {
      const query: any = {
        from: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn().mockResolvedValue([
          { trelloMemberId: 'member-2', status: 'active' },
          { trelloMemberId: 'member-3', status: 'active' },
        ]),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });

      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(workerApp)
        .put('/api/trello/tasks/task-123/complete')
        .send({ isCompleted: true, cardId: 'assigned-card', checklistId: 'list-123', checkItemId: 'item-123' })
        .expect(409, { error: 'Your worker profile is ambiguous. Ask an administrator to resolve it before updating Trello.' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks worker Trello writes when only an inactive profile exists', async () => {
      const query: any = {
        from: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn().mockResolvedValue([
          { trelloMemberId: 'former-member', status: 'inactive' },
        ]),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });

      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(workerApp)
        .put('/api/trello/tasks/task-123/complete')
        .send({ isCompleted: true, cardId: 'assigned-card', checklistId: 'list-123', checkItemId: 'item-123' })
        .expect(409);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks a shadow-pilot worker from completing a checklist through the direct Trello API', async () => {
      process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
      process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(workerApp)
        .put('/api/trello/tasks/task-123/complete')
        .send({ isCompleted: true, cardId: 'assigned-card', checklistId: 'list-123', checkItemId: 'item-123' })
        .expect(409, { error: 'Checklist completion is paused while APTLSS is in shadow mode. Report the completed work through Work guidance; the task remains open until it is verified.' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.getDb).not.toHaveBeenCalled();
    });

    it('does not apply the shadow-only restriction when the pilot is not in shadow mode', async () => {
      process.env.APTLSS_MANAGER_SHADOW_ONLY = 'false';
      process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
      const query: any = {
        from: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn().mockResolvedValue([{ trelloMemberId: 'member-2', status: 'active' }]),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          idMembers: ['member-2'],
          checklists: [{ id: 'list-123', checkItems: [{ id: 'item-123' }] }],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);

      await request(workerApp)
        .put('/api/trello/tasks/task-123/complete')
        .send({ isCompleted: true, cardId: 'card-123', checklistId: 'list-123', checkItemId: 'item-123' })
        .expect(200);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('blocks the shadow-pilot card-status completion fallback before Trello access', async () => {
      process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
      process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(workerApp)
        .put('/api/trello/cards/card-123/status')
        .send({ isCompleted: true })
        .expect(409, { error: 'Checklist completion is paused while APTLSS is in shadow mode. Report the completed work through Work guidance; the task remains open until it is verified.' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.getDb).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/trello/cards/:cardId/status', () => {
    it('should return 400 when cardId is missing', async () => {
      const response = await request(app)
        .put('/api/trello/cards/')
        .send({
          isCompleted: true,
        });

      // Note: Express will return 404 for missing route parameter
      expect(response.status).toBe(404);
    });

    it('should return 503 when Trello credentials are missing', async () => {
      delete process.env.TRELLO_API_KEY;

      const response = await request(app)
        .put('/api/trello/cards/card-123/status')
        .send({
          isCompleted: true,
        });

      expect(response.status).toBe(503);
      expect(response.body.error).toContain('Trello credentials not configured');
    });

    it('should handle card fetch errors gracefully', async () => {
      // Mock fetch to fail
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      const response = await request(app)
        .put('/api/trello/cards/invalid-card/status')
        .send({
          isCompleted: true,
        });

      expect(response.status).toBe(502);
      expect(response.body.error).toBe('Could not update the Trello card status');
    });

    it('does not replace card labels when Trello omits the current label list', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'card-123' }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(app)
        .put('/api/trello/cards/card-123/status')
        .send({ isCompleted: true })
        .expect(502, { error: 'Could not verify Trello card labels' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['/api/trello/cards/card-123/STATUS', '/api/trello/cards/card-123/status/'])(
      'keeps the shadow completion block for equivalent route path %s', async (path) => {
        process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
        process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
        const query: any = {
          from: vi.fn(),
          where: vi.fn(),
          orderBy: vi.fn().mockResolvedValue([{ trelloMemberId: 'member-2', status: 'active' }]),
          limit: vi.fn().mockResolvedValue([{ value: JSON.stringify(['completion-label']) }]),
        };
        query.from.mockReturnValue(query);
        query.where.mockReturnValue(query);
        mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });

        const workerApp = express();
        workerApp.use(express.json());
        workerApp.use((req, _res, next) => {
          (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
          next();
        });
        workerApp.use('/api/trello', trelloConfigRoutes);
        const fetchMock = vi.fn()
          .mockResolvedValueOnce(new Response(JSON.stringify({ idMembers: ['member-2'] }), { status: 200 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ idLabels: [] }), { status: 200 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'card-123' }), { status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        await request(workerApp)
          .put(path)
          .send({ isCompleted: true })
          .expect(409, { error: 'Checklist completion is paused while APTLSS is in shadow mode. Report the completed work through Work guidance; the task remains open until it is verified.' });

        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('PUT /api/trello/cards/:cardId/update', () => {
    function makeQuery(limitRows: unknown[] = [], orderedRows: unknown[] = []) {
      const query: any = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn().mockResolvedValue(limitRows),
        orderBy: vi.fn().mockResolvedValue(orderedRows),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      return query;
    }

    function createPilotWorkerApp() {
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);
      return workerApp;
    }

    beforeEach(() => {
      process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
      process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
    });

    it('blocks a pilot worker from applying a configured completion label before contacting Trello', async () => {
      const query = makeQuery([{ value: JSON.stringify(['completion-label']) }]);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/update')
        .send({ idLabels: ['safe-label', 'completion-label'] })
        .expect(409, { error: 'Applying a configured completion label is paused while APTLSS is in shadow mode. Report completed work through Work guidance; the task remains open until it is verified.' });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['/api/trello/cards/card-123/UPDATE', '/api/trello/cards/card-123/update/'])(
      'keeps the shadow completion-label block for equivalent route path %s', async (path) => {
        const query = makeQuery([{ value: JSON.stringify(['completion-label']) }], [{ trelloMemberId: 'member-2', status: 'active' }]);
        mocks.getDb.mockResolvedValue({ select: vi.fn(() => query) });
        const fetchMock = vi.fn()
          .mockResolvedValueOnce(new Response(JSON.stringify({ idMembers: ['member-2'] }), { status: 200 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'card-123' }), { status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        await request(createPilotWorkerApp())
          .put(path)
          .send({ idLabels: ['completion-label'] })
          .expect(409, { error: 'Applying a configured completion label is paused while APTLSS is in shadow mode. Report completed work through Work guidance; the task remains open until it is verified.' });

        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('allows a pilot worker to update card details and non-completion labels', async () => {
      const queries = [
        makeQuery([{ value: JSON.stringify(['completion-label']) }]),
        makeQuery([], [{ trelloMemberId: 'member-2', status: 'active' }]),
      ];
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => queries.shift()) });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ idMembers: ['member-2'], idLabels: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'card-123',
          name: 'Updated title',
          desc: 'Updated description',
          idLabels: ['safe-label'],
        }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/update')
        .send({ name: 'Updated title', desc: 'Updated description', idLabels: ['safe-label'] })
        .expect(200);

      expect(response.body).toMatchObject({ success: true, card: { name: 'Updated title', idLabels: ['safe-label'] } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][0])).toContain('idLabels=safe-label');
      expect(String(fetchMock.mock.calls[1][0])).not.toContain('completion-label');
    });

    it('preserves an existing completion label when an empty idLabels update clears ordinary labels', async () => {
      const queries = [
        makeQuery([{ value: JSON.stringify(['completion-label']) }]),
        makeQuery([], [{ trelloMemberId: 'member-2', status: 'active' }]),
      ];
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => queries.shift()) });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          idMembers: ['member-2'],
          idLabels: ['completion-label', 'ordinary-label'],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'card-123',
          idLabels: ['completion-label'],
        }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/update')
        .send({ idLabels: [] })
        .expect(200);

      expect(response.body.card.idLabels).toEqual(['completion-label']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('idLabels')).toBe('completion-label');
    });

    it('keeps the completion label while allowing ordinary label changes on a completed card', async () => {
      const queries = [
        makeQuery([{ value: JSON.stringify(['completion-label']) }]),
        makeQuery([], [{ trelloMemberId: 'member-2', status: 'active' }]),
      ];
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => queries.shift()) });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          idMembers: ['member-2'],
          idLabels: ['completion-label', 'old-label'],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: 'card-123',
          idLabels: ['ordinary-label', 'completion-label'],
        }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/update')
        .send({ idLabels: ['ordinary-label'] })
        .expect(200);

      expect(response.body.card.idLabels).toEqual(['ordinary-label', 'completion-label']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('idLabels')).toBe('ordinary-label,completion-label');
    });

    it('fails closed when current labels cannot be verified', async () => {
      const queries = [
        makeQuery([{ value: JSON.stringify(['completion-label']) }]),
        makeQuery([], [{ trelloMemberId: 'member-2', status: 'active' }]),
      ];
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => queries.shift()) });
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        idMembers: ['member-2'],
      }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/update')
        .send({ idLabels: [] })
        .expect(502, { error: 'Could not verify Trello completion label protection' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when a pilot worker completion-label configuration is corrupt', async () => {
      const configQuery = makeQuery([{ value: 'not-json' }]);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => configQuery) });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/update')
        .send({ idLabels: ['completion-label'] })
        .expect(502, { error: 'Could not verify Trello card access' });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an unassigned card before any worker mutation', async () => {
      const profileQuery = makeQuery([], [{ trelloMemberId: 'member-2', status: 'active' }]);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => profileQuery) });
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ idMembers: ['another-member'] }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/due')
        .send({ dueDate: '2026-08-15T12:00:00.000Z' })
        .expect(403, { error: 'This Trello card is not assigned to your linked member account' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
    });

    it('does not expose credentials or arbitrary Trello response fields', async () => {
      process.env.TRELLO_API_KEY = 'key+/ with spaces';
      process.env.TRELLO_TOKEN = 'token?&secret';
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        id: 'card-123',
        name: 'Updated title',
        apiKey: 'key+/ with spaces',
        token: 'token?&secret',
      }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(app)
        .put('/api/trello/cards/card-123/update')
        .send({ name: 'Updated title' })
        .expect(200);

      const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
      expect(requestUrl.searchParams.get('key')).toBe('key+/ with spaces');
      expect(requestUrl.searchParams.get('token')).toBe('token?&secret');
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
      expect(response.body).toEqual({ success: true, card: { id: 'card-123', name: 'Updated title' } });
      expect(JSON.stringify(response.body)).not.toContain('token?&secret');
    });

    it('does not return or log credential-bearing Trello error bodies', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        message: 'rejected token test-token and key test-key',
      }), { status: 500 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(app)
        .put('/api/trello/cards/card-123/update')
        .send({ name: 'Updated title' })
        .expect(502);

      expect(JSON.stringify(response.body)).not.toContain('test-token');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('test-token');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('test-key');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not replace labels when idLabels is omitted from a card-details update', async () => {
      const profileQuery = makeQuery([], [{ trelloMemberId: 'member-2', status: 'active' }]);
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => profileQuery) });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          idMembers: ['member-2'],
          idLabels: ['completion-label'],
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'card-123', name: 'Updated title' }), { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(createPilotWorkerApp())
        .put('/api/trello/cards/card-123/update')
        .send({ name: 'Updated title' })
        .expect(200);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.has('idLabels')).toBe(false);
      expect(String(fetchMock.mock.calls[0][0])).toContain('fields=idMembers');
    });
  });

  describe('GET /api/trello/labels', () => {
    it('should return 503 when Trello credentials are missing', async () => {
      delete process.env.TRELLO_API_KEY;

      const response = await request(app)
        .get('/api/trello/labels');

      expect(response.status).toBe(503);
      expect(response.body.error).toContain('Trello credentials not configured');
    });

    it('rejects a worker before listing labels from the shared Trello account', async () => {
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);

      await request(workerApp)
        .get('/api/trello/labels')
        .expect(403, { error: 'Forbidden - admin only' });
    });
  });

  describe('GET /api/trello/boards/list', () => {
    it('rejects a worker before listing boards from the shared Trello account', async () => {
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);

      await request(workerApp)
        .get('/api/trello/boards/list')
        .expect(403, { error: 'Forbidden - admin only' });
    });

    it('fails closed on an unsuccessful Trello response without forwarding its body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('token=test-token', { status: 403 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const response = await request(app)
        .get('/api/trello/boards/list')
        .expect(502, { error: 'Could not fetch Trello boards' });

      expect(JSON.stringify(response.body)).not.toContain('test-token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/trello/completion-labels', () => {
    it('rejects requests when user is not authenticated', async () => {
      const unauthenticated = express();
      unauthenticated.use(express.json());
      unauthenticated.use('/api/trello', trelloConfigRoutes);
      const response = await request(unauthenticated)
        .get('/api/trello/completion-labels');
      expect(response.status).toBe(401);
    });

    it('saves worker completion labels under the authenticated worker identity', async () => {
      const duplicateUpdate = vi.fn();
      const values = vi.fn().mockReturnValue({ onDuplicateKeyUpdate: duplicateUpdate });
      mocks.getDb.mockResolvedValue({ insert: vi.fn().mockReturnValue({ values }) });
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);

      await request(workerApp)
        .post('/api/trello/completion-labels')
        .send({ userId: 1, labels: ['worker-completion'] })
        .expect(200);

      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        vaId: 2,
        key: 'trelloCompletionLabels:2',
      }));
      expect(duplicateUpdate).toHaveBeenCalled();
    });

    it('does not let a shadow-pilot worker remove a configured completion label', async () => {
      process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
      process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '2';
      const query: any = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn().mockResolvedValue([{ value: JSON.stringify(['completion-label']) }]),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      const duplicateUpdate = vi.fn();
      const values = vi.fn().mockReturnValue({ onDuplicateKeyUpdate: duplicateUpdate });
      const insert = vi.fn().mockReturnValue({ values });
      mocks.getDb.mockResolvedValue({ select: vi.fn(() => query), insert });

      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);

      await request(workerApp)
        .post('/api/trello/completion-labels')
        .send({ labels: [] })
        .expect(409, { error: 'Completion label protection cannot be weakened while APTLSS is in shadow mode' });

      expect(insert).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/trello/cards/:cardId/members', () => {
    it('rejects a worker before querying the database or calling Trello', async () => {
      const workerApp = express();
      workerApp.use(express.json());
      workerApp.use((req, _res, next) => {
        (req as any).user = { id: 2, openId: 'worker-2', role: 'worker' };
        next();
      });
      workerApp.use('/api/trello', trelloConfigRoutes);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await request(workerApp)
        .put('/api/trello/cards/card-123/members')
        .send({ idMembers: ['member-3'] })
        .expect(403, { error: 'Only an admin can change Trello card membership' });

      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/trello/cards/:cardId/due', () => {
    it('rejects invalid dates before calling Trello', async () => {
      const response = await request(app)
        .put('/api/trello/cards/card-123/due')
        .send({ dueDate: 'not-a-date' });
      expect(response.status).toBe(400);
    });

    it('reports unavailable Trello configuration instead of fake success', async () => {
      delete process.env.TRELLO_API_KEY;
      const response = await request(app)
        .put('/api/trello/cards/card-123/due')
        .send({ dueDate: '2026-08-15T12:00:00.000Z' });
      expect(response.status).toBe(503);
      expect(response.body.error).toContain('not configured');
    });
  });
});
