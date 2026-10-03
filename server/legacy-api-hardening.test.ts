import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import analyticsRoutes from './routes/analytics';
import reportsRoutes from './routes/reports';
import metricsRoutes from './routes/metrics';
import batchOperationRoutes from './routes/batch-operations';
import advancedSchedulingRoutes from './routes/advanced-scheduling';
import vaManagementRoutes from './routes/va-management';
import aptlssRoutes from './routes/aptlss';
import trelloBoardsRoutes from './routes/trello-boards';
import performanceRoutes from './routes/performance-optimization';
import { readFileSync } from 'node:fs';
import { vaProfiles } from '../drizzle/schema';
import { vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  return { ...actual, getDb: dbMocks.getDb };
});

const worker = {
  id: 42,
  openId: 'worker-42',
  role: 'worker',
};

function appWithUser(user?: typeof worker | { id: number; openId: string; role: 'admin' }) {
  const app = express();
  app.use(express.json());
  if (user) app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use('/analytics', analyticsRoutes);
  app.use('/reports', reportsRoutes);
  app.use('/metrics-api', metricsRoutes);
  app.use('/batch-operations', batchOperationRoutes);
  app.use('/scheduling', advancedSchedulingRoutes);
  app.use('/va', vaManagementRoutes);
  app.use('/legacy', aptlssRoutes);
  app.use('/trello-boards', trelloBoardsRoutes);
  app.use('/performance', performanceRoutes);
  return app;
}

function activeWorkerDatabase() {
  const profiles = [{ id: 7, status: 'active', userId: worker.id }];
  return {
    select: vi.fn(() => {
      let table: unknown;
      const query: any = {
        from: (value: unknown) => { table = value; return query; },
        where: () => query,
        orderBy: () => Promise.resolve(table === vaProfiles ? profiles : []),
        limit: () => Promise.resolve(table === vaProfiles ? profiles : []),
      };
      return query;
    }),
  };
}

describe('legacy API hardening', () => {
  it('requires authentication for analytics, reports, and batch operations', async () => {
    const app = appWithUser();
    await request(app).get('/analytics/team-capacity').expect(401);
    await request(app).get('/reports/export?format=csv&type=time-entries').expect(401);
    await request(app).get('/batch-operations/job/status').expect(401);
  });

  it('does not report placeholder batch algorithms as successful', async () => {
    const app = appWithUser(worker);
    const response = await request(app)
      .post('/batch-operations/start')
      .send({ operationType: 'optimization', taskIds: ['task-1'] })
      .expect(501);

    expect(response.body.supportedOperationTypes).toEqual(['re_analyze', 'reschedule']);

    await request(app)
      .post('/scheduling/batch-start')
      .send({ operationType: 'conflict_resolution', taskIds: ['task-1'] })
      .expect(501);
  });

  it('restricts destructive metric resets to admins', async () => {
    const workerApp = appWithUser(worker);
    await request(workerApp).post('/metrics-api/metrics/reset').expect(403);

    const adminApp = appWithUser({ id: 1, openId: 'admin-1', role: 'admin' });
    await request(adminApp).post('/metrics-api/metrics/reset').expect(200);
  });

  it('describes supported report exports instead of fabricating a PDF', async () => {
    dbMocks.getDb.mockResolvedValue(activeWorkerDatabase());
    const app = appWithUser(worker);
    const response = await request(app)
      .get('/reports/export?format=pdf&type=task-summary')
      .expect(400);
    expect(response.body.supported).toEqual(['csv/time-entries', 'csv/task-summary']);
    expect(dbMocks.getDb).toHaveBeenCalledOnce();
    dbMocks.getDb.mockReset();
  });

  it('keeps founder VA APIs separate from worker self-service APIs', async () => {
    const workerApp = appWithUser(worker);
    await request(workerApp).get('/va/assignments').expect(403);

    const adminApp = appWithUser({ id: 1, openId: 'admin-1', role: 'admin' });
    await request(adminApp).get('/va/worker/profile').expect(403);
  });

  it('keeps the legacy APTLSS administration surface out of the worker portal', async () => {
    await request(appWithUser()).get('/legacy/aptlss/history').expect(401);
    await request(appWithUser(worker)).get('/legacy/aptlss/history').expect(403);
  });

  it('does not intercept unrelated API routes before tRPC handles them', async () => {
    const app = express();
    app.use('/api', aptlssRoutes);
    app.get('/api/trpc/auth.me', (_req, res) => res.json({ result: { data: null } }));

    await request(app)
      .get('/api/trpc/auth.me')
      .expect(200, { result: { data: null } });
  });

  it('keeps Trello checklist completion in the single active Trello router', () => {
    const legacySource = readFileSync(new URL('./routes/aptlss.ts', import.meta.url), 'utf8');
    const activeSource = readFileSync(new URL('./routes/trello-config.ts', import.meta.url), 'utf8');

    expect(legacySource).not.toContain("router.put('/trello/tasks/:taskId/complete'");
    expect(activeSource).toContain("router.put('/tasks/:taskId/complete'");
  });

  it('keeps integration inventory and system performance admin-only', async () => {
    await request(appWithUser()).get('/trello-boards').expect(401);
    await request(appWithUser(worker)).get('/trello-boards').expect(403);
    await request(appWithUser(worker)).get('/performance/metrics').expect(403);
  });
});
