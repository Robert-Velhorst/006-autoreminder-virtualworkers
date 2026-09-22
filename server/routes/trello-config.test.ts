import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import trelloConfigRoutes from './trello-config';

describe('Trello Config Routes', () => {
  let app: Express;
  const originalTrelloApiKey = process.env.TRELLO_API_KEY;
  const originalTrelloToken = process.env.TRELLO_TOKEN;

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
    if (originalTrelloApiKey === undefined) delete process.env.TRELLO_API_KEY;
    else process.env.TRELLO_API_KEY = originalTrelloApiKey;
    if (originalTrelloToken === undefined) delete process.env.TRELLO_TOKEN;
    else process.env.TRELLO_TOKEN = originalTrelloToken;
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

    it('should return 500 when Trello credentials are missing', async () => {
      delete process.env.TRELLO_API_KEY;

      const response = await request(app)
        .put('/api/trello/tasks/task-123/complete')
        .send({
          isCompleted: true,
          cardId: 'card-123',
          checklistId: 'checklist-123',
          checkItemId: 'item-123',
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Trello credentials not configured');
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

    it('should return 500 when Trello credentials are missing', async () => {
      delete process.env.TRELLO_API_KEY;

      const response = await request(app)
        .put('/api/trello/cards/card-123/status')
        .send({
          isCompleted: true,
        });

      expect(response.status).toBe(500);
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
  });

  describe('GET /api/trello/labels', () => {
    it('should return 500 when Trello credentials are missing', async () => {
      delete process.env.TRELLO_API_KEY;

      const response = await request(app)
        .get('/api/trello/labels');

      expect(response.status).toBe(500);
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
