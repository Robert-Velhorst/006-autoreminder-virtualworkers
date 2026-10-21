import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeEntries, users, userWorkingHours, vaProfiles } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), fetch: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: mocks.fetch }));
import { aggregateCardContext } from './context-aggregator';

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('TRELLO_API_KEY', 'synthetic-key'); vi.stubEnv('TRELLO_TOKEN', 'synthetic-token');
  mocks.fetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes('/cards/')
    ? { name: 'Synthetic card', idBoard: 'board', idList: 'list', checklists: [], actions: [], labels: [] } : { name: 'Synthetic list or board' } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('context totals use the effective worker calendar', () => {
  it.each([
    { timezone: 'America/Los_Angeles', now: '2026-10-19T00:30:00Z', start: '2026-10-18T07:00:00Z', end: '2026-10-19T07:00:00Z' },
    { timezone: 'Africa/Nairobi', now: '2026-10-19T00:30:00Z', start: '2026-10-18T21:00:00Z', end: '2026-10-19T21:00:00Z' },
    { timezone: 'Europe/Amsterdam', now: '2026-03-29T12:00:00Z', start: '2026-03-28T23:00:00Z', end: '2026-03-29T22:00:00Z' },
    { timezone: 'Europe/Amsterdam', now: '2026-10-25T12:00:00Z', start: '2026-10-24T22:00:00Z', end: '2026-10-25T23:00:00Z' },
  ].flatMap(row => [false, true].map(fallback => ({ ...row, fallback }))))(
    'bounds the complete local day for $timezone, founder fallback=$fallback', async ({ timezone, now, start, end, fallback }) => {
      vi.setSystemTime(new Date(now));
      const row = (id: number, time: number, minutes: number) => ({ id, taskId: 'card', trackedUserId: 41,
        trackedProfileId: 7, founderId: 9, vaId: null, isVoided: false, startTime: new Date(time),
        endTime: new Date(time + 60000), durationMinutes: minutes });
      const startMs = new Date(start).getTime(), endMs = new Date(end).getTime();
      const entries = [row(1, startMs - 1, 10), row(2, startMs, 20), row(3, endMs - 1, 30), row(4, endMs, 40),
        { ...row(5, startMs, 900), founderId: 99 }, { ...row(6, startMs, 900), trackedUserId: 84 },
        { ...row(7, startMs, 900), isVoided: true }];
      const rows = new Map<unknown, any[]>([
        [users, [{ id: 41, role: 'worker' }, { id: 9, role: 'admin' }]],
        [vaProfiles, [{ id: 6, userId: 41, founderId: 99, status: 'inactive', timezone: 'UTC' },
          { id: 7, userId: 41, founderId: 9, status: 'active', timezone: 'UTC', name: 'Synthetic worker' }]],
        [userWorkingHours, [{ userId: fallback ? 9 : 41, timezone, workStartHour: 9, workEndHour: 18,
          workStartMinute: 0, workEndMinute: 0, enableBreaks: 0, workingDays: '1,2,3,4,5' }]],
        [timeEntries, entries],
      ]);
      mocks.getDb.mockResolvedValue(timerTestDatabase(rows).db);
      const context = await aggregateCardContext('card', 41);
      expect(context.timeTracking).toMatchObject({ complete: true, totalMinutesToday: 50, totalMinutesAllTime: 100 });
      expect(context.timeTracking.entries).toHaveLength(4);
      expect(context.workerInfo).toMatchObject({ name: 'Synthetic worker', timezone, workingHoursStart: '09:00', workingHoursEnd: '18:00' });
    },
  );
});
