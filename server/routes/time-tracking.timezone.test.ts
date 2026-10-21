import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeEntries, userWorkingHours, users, vaProfiles, type User } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../aptlssManagerPilot', () => ({ isManagerPilotWorker: () => false }));
import routes from './time-tracking';
import { timerRouter } from './manus';

const worker = { id: 42, openId: 'synthetic-zone-worker', role: 'worker' } as User;
const founder = { id: 8, openId: 'synthetic-zone-founder', role: 'admin' };
function fixture(zone: string, start: string, minutes: number, founderFallback = false) {
  const rows = new Map<unknown, Record<string, any>[]>([
    [users, [worker, founder]],
    [vaProfiles, [{ id: 7, userId: worker.id, founderId: founder.id, status: 'active', timezone: 'UTC' }]],
    [userWorkingHours, [{ userId: founderFallback ? founder.id : worker.id, timezone: zone,
      weeklyHoursMin: 25, weeklyHoursMax: 30, dailyHoursMin: '5', dailyHoursMax: '6' }]],
    [timeEntries, [{ id: 55, trackedUserId: worker.id, trackedProfileId: 7, vaId: null,
      founderId: founder.id, taskId: 'synthetic-zone-task', startTime: new Date(start),
      endTime: new Date(new Date(start).getTime() + minutes * 60_000),
      durationMinutes: minutes, durationSeconds: minutes * 60, isVoided: false }]],
  ]);
  const { db } = timerTestDatabase(rows);
  mocks.getDb.mockResolvedValue(db);
  const app = express();
  app.use((req, _res, next) => { (req as any).user = worker; next(); });
  app.use(routes);
  return { app, caller: timerRouter.createCaller({ user: worker, req: {} as any, res: {} as any }) };
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('canonical timer calendar agreement', () => {
  it.each([false, true])('uses the same worker hours timezone as tRPC (founder fallback=%s)', async founderFallback => {
    vi.setSystemTime(new Date('2026-10-19T00:30:00Z'));
    const { app, caller } = fixture('America/Los_Angeles', '2026-10-18T23:00:00Z', 60, founderFallback);
    const context = await caller.getDateContext();
    expect(context).toMatchObject({ timezone: 'America/Los_Angeles', date: '2026-10-18', startDate: '2026-10-12', endDate: '2026-10-18' });
    const weekly = await request(app).get('/time-tracking/weekly-progress');
    const rpcWeekly = await caller.getWeeklyTotal({ startDate: context.startDate, endDate: context.endDate });
    expect(weekly.status).toBe(200);
    expect(weekly.body).toMatchObject({ complete: true, weekStart: context.startDate, weekEnd: context.endDate,
      actualHours: rpcWeekly.totalHours, actualMinutes: 60, weeklyHoursMin: 25, weeklyHoursMax: 30,
      dailyHours: { '2026-10-18': 1 } });
    const daily = await request(app).get('/time-tracking/summary?startDate=2026-10-18&endDate=2026-10-18');
    expect(daily.body).toMatchObject({ complete: true, totalMinutes: 60, byDate: { '2026-10-18': 60 } });
  });

  it('keeps the full Monday-Sunday local calendar for an eastern timezone', async () => {
    vi.setSystemTime(new Date('2026-10-18T17:00:00Z'));
    const { app } = fixture('Africa/Nairobi', '2026-10-18T07:00:00Z', 120);
    const weekly = await request(app).get('/time-tracking/weekly-progress');
    expect(weekly.status).toBe(200);
    expect(weekly.body).toMatchObject({ weekStart: '2026-10-12', weekEnd: '2026-10-18', actualHours: 2 });
    expect(Object.keys(weekly.body.dailyHours)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14',
      '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(weekly.body.dailyHours['2026-10-18']).toBe(2);
    expect(Object.values(weekly.body.dailyHours).reduce((sum: number, value) => sum + Number(value), 0)).toBe(weekly.body.actualHours);
  });

  it('uses the saved local day across a daylight-saving transition', async () => {
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    const { app } = fixture('America/New_York', '2026-11-02T04:30:00Z', 15);
    const daily = await request(app).get('/time-tracking/summary?startDate=2026-11-01&endDate=2026-11-01');
    expect(daily.status).toBe(200);
    expect(daily.body).toMatchObject({ totalMinutes: 15, byDate: { '2026-11-01': 15 } });
  });
});
