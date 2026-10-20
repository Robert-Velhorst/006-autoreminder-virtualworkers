import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import atisRouter from './routes/atis';
import atisPhasesRouter from './routes/atis-phases';

type TestUser = {
  id: number;
  openId: string;
  role: 'admin' | 'worker';
};

function appWithUser(user?: TestUser) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      (req as typeof req & { user?: TestUser }).user = user;
      next();
    });
  }
  app.use('/api/atis', atisRouter);
  app.use('/api/atis/phases', atisPhasesRouter);
  return app;
}

describe('ATIS route authorization', () => {
  it('rejects an unauthenticated request before reading ATIS data', async () => {
    await request(appWithUser()).get('/api/atis/stats').expect(401, { error: 'Unauthorized' });
  });

  it('rejects worker access to the retained administrator ATIS portal', async () => {
    await request(appWithUser({ id: 2, openId: 'worker-2', role: 'worker' }))
      .get('/api/atis/stats')
      .expect(403, { error: 'Forbidden - admin only' });
  });

  it('rejects an unauthenticated compatibility analysis read before loading session data', async () => {
    await request(appWithUser())
      .get('/api/atis/phases/analyze/card-1')
      .expect(401, { error: 'Unauthorized' });
  });

  it('rejects worker access to the retained administrator phase-analysis portal', async () => {
    await request(appWithUser({ id: 2, openId: 'worker-2', role: 'worker' }))
      .get('/api/atis/phases/analyze/card-1')
      .expect(403, { error: 'Forbidden - admin only' });
  });

  it('does not accept a client-supplied checklist owner', async () => {
    await request(appWithUser({ id: 1, openId: 'admin-1', role: 'admin' }))
      .post('/api/atis/checklist/toggle')
      .send({ cardId: 1, stepIndex: -1, userId: 999 })
      .expect(400, { error: 'cardId and stepIndex must be valid non-negative integers' });
  });
});
