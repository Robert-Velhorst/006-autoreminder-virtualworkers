import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users, userWorkingHours, vaProfiles, type User } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), fetch: vi.fn() }));
vi.mock('./db', () => ({ getDb: mocks.getDb }));
vi.mock('./utils/retry', () => ({ fetchWithRetry: mocks.fetch }));
import settingsRoutes from './routes/working-hours';
import { timerRouter } from './routes/manus';
import { aggregateCardContext } from './services/context-aggregator';
import { resolveWorkerOperatorContext } from './workerOperatorContext';

const founder = { id: 8, openId: 'calendar-founder', role: 'admin' } as User;
const worker = { id: 42, openId: 'calendar-worker', role: 'worker' } as User;
function fixture(profileOverrides: Record<string, unknown> = {}, workerHours?: Record<string, unknown>) {
  const profile = { id: 7, userId: 42, founderId: 8, status: 'active', name: 'Worker',
    timezone: 'America/Los_Angeles', workStartHour: 7, workEndHour: 15, workingDays: '0,1,2,3,4',
    lunchTime: 11, lunchDuration: 30, ...profileOverrides };
  const global = { userId: 8, userOpenId: founder.openId, timezone: 'UTC', workStartHour: 9,
    workStartMinute: 15, workEndHour: 18, workEndMinute: 30, workingDays: '1,2,3,4,5',
    enableBreaks: 1, lunchTime: '15:00', lunchDuration: 45,
    breakfastTime: '09:00', breakfastDuration: 0, dinnerTime: '20:00', dinnerDuration: 0,
    shortBreakInterval: 120, shortBreakDuration: 10, longBreakInterval: 240, longBreakDuration: 30, country: 'US',
    weeklyHoursMin: 25, weeklyHoursMax: 30, dailyHoursMin: '5', dailyHoursMax: '6' };
  const rows = new Map<unknown, any[]>([[users, [worker, founder]], [vaProfiles, [profile]],
    [userWorkingHours, [global, ...(workerHours ? [{ ...global, userId: 42, userOpenId: worker.openId, ...workerHours }] : [])]]]);
  const { db } = timerTestDatabase(rows);
  mocks.getDb.mockResolvedValue(db);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = founder; next(); });
  app.use('/api/working-hours', settingsRoutes);
  return { db, app, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-19T00:30:00Z'));
  vi.stubEnv('TRELLO_API_KEY', 'synthetic-key');
  vi.stubEnv('TRELLO_TOKEN', 'synthetic-token');
  mocks.fetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes('/cards/')
    ? { name: 'Card', idBoard: 'board', idList: 'list', checklists: [], actions: [], labels: [] } : { name: 'Board' } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('worker calendar settings agree with canonical consumers', () => {
  it('uses the displayed LA 07-15 profile rather than founder UTC 09-18 in calendar and card context', async () => {
    const { db, app } = fixture();
    const settings = await request(app).get('/api/working-hours/settings?workerId=7').expect(200);
    expect(settings.body).toMatchObject({ timezone: 'America/Los_Angeles', workStartHour: 7, workEndHour: 15 });
    const context = await resolveWorkerOperatorContext(worker, db);
    expect(context).toMatchObject({ timezone: settings.body.timezone, workStartTime: '07:00', workEndTime: '15:00',
      workingDays: [0, 1, 2, 3, 4], breaks: [{ name: 'Lunch', startTime: '11:00', durationMinutes: 30 }], weeklyHoursMin: 25 });
    const caller = timerRouter.createCaller({ user: worker, req: {} as any, res: {} as any });
    expect(await caller.getDateContext()).toMatchObject({ timezone: 'America/Los_Angeles', date: '2026-10-18' });
    expect((await aggregateCardContext('card', worker.id)).workerInfo).toMatchObject({
      timezone: 'America/Los_Angeles', workingHoursStart: '07:00', workingHoursEnd: '15:00' });
  });

  it('makes a profile schedule saved through the mounted route effective immediately', async () => {
    const { app, db, rows } = fixture();
    await request(app).post('/api/working-hours/settings?workerId=7')
      .send({ workStartHour: 8, workEndHour: 16, workingDays: '2,3,4,5,6' }).expect(200);
    expect(await resolveWorkerOperatorContext(worker, db)).toMatchObject({
      workStartTime: '08:00', workEndTime: '16:00', workingDays: [2, 3, 4, 5, 6] });
    rows.get(vaProfiles)!.push({ id: 99, userId: 99, founderId: 99, status: 'active' });
    await request(app).get('/api/working-hours/settings?workerId=99').expect(404);
    await request(app).post('/api/working-hours/settings?workerId=99')
      .send({ workStartHour: 8, workEndHour: 16 }).expect(404);
    await request(app).get('/api/working-hours/settings?workerId=999').expect(404);
  });

  it('retains explicit worker hours including minute precision, disabled breaks and targets', async () => {
    const { db } = fixture({}, { timezone: 'Asia/Manila', workStartHour: 10, workStartMinute: 20,
      workEndHour: 19, workEndMinute: 40, workingDays: '2,4,6', enableBreaks: 0, weeklyHoursMin: 35, weeklyHoursMax: 40 });
    expect(await resolveWorkerOperatorContext(worker, db)).toMatchObject({ timezone: 'Asia/Manila',
      workStartTime: '10:20', workEndTime: '19:40', workingDays: [2, 4, 6], breaks: [], weeklyHoursMin: 35 });
  });

  it('does not infer that persisted schema defaults are unset', async () => {
    const { db } = fixture({ timezone: 'Asia/Manila', workStartHour: 9, workEndHour: 18, workingDays: '1,2,3,4,5' });
    expect(await resolveWorkerOperatorContext(worker, db)).toMatchObject({ timezone: 'Asia/Manila',
      workStartTime: '09:00', workEndTime: '18:00', workingDays: [1, 2, 3, 4, 5] });
  });

  it('inherits founder break-disable policy without replacing worker schedule fields', async () => {
    const { db, rows } = fixture();
    rows.get(userWorkingHours)![0].enableBreaks = 0;
    expect(await resolveWorkerOperatorContext(worker, db)).toMatchObject({ timezone: 'America/Los_Angeles',
      workStartTime: '07:00', workEndTime: '15:00', breaks: [], weeklyHoursMin: 25 });
  });

  it('inherits founder fields only when profile fields are absent', async () => {
    const { db } = fixture({ timezone: null, workStartHour: null, workEndHour: null, workingDays: null, lunchTime: null, lunchDuration: null });
    expect(await resolveWorkerOperatorContext(worker, db)).toMatchObject({ timezone: 'UTC',
      workStartTime: '09:15', workEndTime: '18:30', workingDays: [1, 2, 3, 4, 5],
      breaks: [{ name: 'Lunch', startTime: '15:00', durationMinutes: 45 }] });
  });
});
