import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import performanceRouter from './routes/performance-optimization';
import rescheduleRouter from './routes/reschedule';

function adminApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, openId: 'admin-1', role: 'admin' };
    next();
  });
  app.use('/reschedule', rescheduleRouter);
  app.use('/performance', performanceRouter);
  return app;
}

describe('operational control route validation', () => {
  it('rejects invalid work windows before reading cached work', async () => {
    const response = await request(adminApp())
      .post('/reschedule/preview')
      .send({ workStartHour: 18, workEndHour: 9, workingDays: [1] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Work end hour must be after work start hour' });
  });

  it('rejects unsafe cache refresh intervals before scheduling work', async () => {
    const response = await request(adminApp())
      .post('/performance/cache-refresh-schedule')
      .send({ intervalMinutes: 'not-a-number' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Interval must be a whole number of minutes between 5 and 1440' });
  });
});
