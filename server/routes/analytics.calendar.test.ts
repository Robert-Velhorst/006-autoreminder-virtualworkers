import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskAssignments, timeEntries, users, userWorkingHours, vaProfiles, type User } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';
const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
import analytics from './analytics';

function fixture(timezone: string, fallback: boolean, times: string[], schedule: Partial<typeof userWorkingHours.$inferSelect> = {}) {
  const actor = { id: 41, role: 'worker', openId: 'synthetic-worker' } as User;
  const entry = (id: number, timestamp: string) => ({ id, trackedUserId: 41, trackedProfileId: 7, founderId: 9,
    vaId: null, taskId: 'card', startTime: new Date(timestamp), endTime: new Date(new Date(timestamp).getTime() + 60000),
    isVoided: false, durationSeconds: 600, durationMinutes: 10 });
  const profile = { id: 7, userId: 41, founderId: 9, status: 'active', name: 'Synthetic worker', timezone: fallback ? null : 'UTC',
    workingDays: fallback ? null : '1', workStartHour: fallback ? null : 9, workEndHour: fallback ? null : 17,
    breakfastTime: null, lunchTime: null, dinnerTime: null };
  const rows = new Map<unknown, any[]>([
    [users, [actor, { id: 9, role: 'admin' }]], [vaProfiles, [profile]],
    [userWorkingHours, [{ userId: fallback ? 9 : 41, timezone, workStartHour: 9, workEndHour: 17,
      workStartMinute: 0, workEndMinute: 0, workingDays: '1', enableBreaks: 0, ...schedule }]],
    [timeEntries, [...times.map((time, index) => entry(index + 1, time)),
      { ...entry(90, times[1]), founderId: 99 }, { ...entry(91, times[1]), trackedUserId: 84 },
      { ...entry(92, times[1]), isVoided: true }]],
    [taskAssignments, [{ id: 1, vaId: 7, founderId: 9, status: 'completed', updatedAt: new Date(times[1]) },
      { id: 2, vaId: 7, founderId: 99, status: 'completed', updatedAt: new Date(times[1]) }]],
  ]);
  mocks.getDb.mockResolvedValue(timerTestDatabase(rows).db);
  const app = express(); app.use((req, _res, next) => { (req as any).user = actor; next(); }); app.use(analytics);
  return app;
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => vi.useRealTimers());

describe('analytics canonical calendar', () => {
  it.each(['user', 'admin'])('retains inactive history without inventing overtime for a %s viewer', async role => {
    vi.setSystemTime(new Date('2026-10-19T00:30:00Z'));
    const actor = { id: 9, role, openId: 'synthetic-founder' } as User;
    const rows = new Map<unknown, any[]>([
      [users, [actor, { id: 41, role: 'worker' }]],
      [vaProfiles, [{ id: 7, userId: 41, founderId: 9, status: 'inactive', name: 'Retired profile', timezone: 'UTC' }]],
      [userWorkingHours, []], [taskAssignments, []],
      [timeEntries, [{ id: 1, trackedUserId: 41, trackedProfileId: 7, founderId: 9, vaId: null,
        taskId: 'retained-history', startTime: new Date('2026-10-18T12:00:00Z'),
        endTime: new Date('2026-10-18T13:00:00Z'), durationSeconds: 3600, durationMinutes: 60, isVoided: false }]],
    ]);
    mocks.getDb.mockResolvedValue(timerTestDatabase(rows).db);
    const app = express(); app.use((req, _res, next) => { (req as any).user = actor; next(); }); app.use(analytics);
    const response = await request(app).get('/team-capacity').expect(200);
    expect(response.body).toMatchObject({ complete: true, capacityComplete: false,
      expectedMinutes: 0, trackedMinutes: 60, utilization: null, overtimeMinutes: null,
      workers: [{ workerId: 7, scheduleVerified: false, expectedMinutes: 0, trackedMinutes: 60,
        utilization: null, overtimeMinutes: null }] });
    expect(rows.get(timeEntries)).toHaveLength(1);
    expect(rows.get(vaProfiles)![0].status).toBe('inactive');
  });

  it.each([false, true])('uses the saved four-hour schedule instead of the legacy eight-hour profile, founder fallback=%s', async fallback => {
    vi.setSystemTime(new Date('2026-10-19T00:30:00Z'));
    const app = fixture('America/Los_Angeles', fallback, ['2026-10-18T23:00:00Z', '2026-10-18T23:10:00Z'], { workEndHour: 13 });
    const response = await request(app).get('/team-capacity').expect(200);
    expect(response.body).toMatchObject({ expectedMinutes: 240, trackedMinutes: 20,
      workers: [{ workerId: 7, expectedMinutes: 240, trackedMinutes: 20 }] });
  });
  it.each([false, true])('uses saved working days, minute precision, and enabled breaks, founder fallback=%s', async fallback => {
    vi.setSystemTime(new Date('2026-10-19T00:30:00Z'));
    const app = fixture('America/Los_Angeles', fallback, ['2026-10-18T23:00:00Z', '2026-10-18T23:10:00Z'], {
      workingDays: '2,3', workStartHour: 9, workStartMinute: 15, workEndHour: 13, workEndMinute: 45,
      enableBreaks: 1, lunchTime: '12:00', lunchDuration: 45,
    });
    const response = await request(app).get('/team-capacity').expect(200);
    expect(response.body).toMatchObject({ expectedMinutes: 450, workers: [{ workerId: 7, expectedMinutes: 450 }] });
  });
  it.each([false, true])('retains western Sunday and seven calendar-day capacity, founder fallback=%s', async fallback => {
    vi.setSystemTime(new Date('2026-10-19T00:30:00Z'));
    const app = fixture('America/Los_Angeles', fallback,
      ['2026-10-12T06:59:59Z', '2026-10-12T07:00:00Z', '2026-10-18T23:00:00Z', '2026-10-19T07:00:00Z']);
    const capacity = await request(app).get('/team-capacity').expect(200);
    expect(capacity.body).toMatchObject({ complete: true, trackedMinutes: 20, expectedMinutes: 480,
      period: { timezone: 'America/Los_Angeles', startDate: '2026-10-12', endDate: '2026-10-18', start: '2026-10-12T07:00:00.000Z' } });
    const trends = await request(app).get('/trends').expect(200);
    expect(trends.body.timezone).toBe('America/Los_Angeles');
    expect(trends.body.trends.at(-1)).toMatchObject({ date: '2026-10-18', trackedMinutes: 10 });
    expect(trends.body.trends.find((day: any) => day.date === '2026-10-12')).toMatchObject({ trackedMinutes: 10, completedTasks: 1 });
    expect(trends.body.trends.find((day: any) => day.date === '2026-10-11').trackedMinutes).toBe(10);
  });
  it.each([
    { now: '2026-03-29T22:30:00Z', day: '2026-03-29', start: '2026-03-28T23:00:00Z', late: '2026-03-29T21:59:59Z', end: '2026-03-29T22:00:00Z' },
    { now: '2026-10-25T23:30:00Z', day: '2026-10-25', start: '2026-10-24T22:00:00Z', late: '2026-10-25T22:59:59Z', end: '2026-10-25T23:00:00Z' },
  ])('buckets the complete DST local day $day without a fixed 24-hour boundary', async ({ now, day, start, late, end }) => {
    vi.setSystemTime(new Date(now));
    const app = fixture('Europe/Amsterdam', false, [start, late, end]);
    const response = await request(app).get('/trends').expect(200);
    expect(response.body.trends.find((row: any) => row.date === day)).toMatchObject({ trackedMinutes: 20, completedTasks: 1 });
    expect(response.body.trends.at(-1).trackedMinutes).toBe(10);
    expect(response.body.trends.reduce((sum: number, row: any) => sum + row.trackedMinutes, 0)).toBe(30);
  });
});
