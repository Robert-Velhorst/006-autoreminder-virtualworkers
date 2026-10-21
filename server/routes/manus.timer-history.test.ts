import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users, vaProfiles, timeEntries } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';
import type { TrpcContext } from '../_core/context';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../aptlssManagerPilot', () => ({ isManagerPilotWorker: () => false }));
import { timerRouter } from './manus';

const context = { user: { id: 42, role: 'worker', openId: 'synthetic-worker' }, req: {}, res: {} } as TrpcContext;
const startTime = new Date('2026-10-19T10:00:00Z');
function fixture(unresolved = false) {
  const entry = { id: 1, trackedUserId: 42, trackedProfileId: 3, vaId: null, founderId: 7,
    cardId: 'card', taskId: 'card', cardName: 'Current tenant', startTime,
    endTime: new Date('2026-10-19T10:01:00Z'), durationSeconds: 60, isVoided: false };
  const rows = new Map<unknown, any[]>([
    [users, [{ id: 42, role: 'worker' }, { id: 7, role: 'admin' }]],
    [vaProfiles, [{ id: 3, userId: 42, founderId: 7, status: 'active', timezone: 'UTC' }]],
    [timeEntries, [entry, { ...entry, id: 2, founderId: 99, cardName: 'Old tenant private', durationSeconds: 9000 },
      ...(unresolved ? [{ ...entry, id: 3, trackedUserId: null, trackedProfileId: null, cardName: 'Unreviewed' }] : [])]],
  ]);
  const store = timerTestDatabase(rows);
  mocks.getDb.mockResolvedValue(store.db);
  return { ...store, caller: timerRouter.createCaller(context) };
}

describe('Manus canonical timer history contract', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());
  it.each([
    { timezone: 'UTC', now: '2026-10-25T23:30:00Z', date: '2026-10-25', startDate: '2026-10-19', endDate: '2026-10-25' },
    { timezone: 'Africa/Nairobi', now: '2026-10-25T23:30:00Z', date: '2026-10-26', startDate: '2026-10-26', endDate: '2026-11-01' },
    { timezone: 'Europe/Amsterdam', now: '2026-10-25T23:30:00Z', date: '2026-10-26', startDate: '2026-10-26', endDate: '2026-11-01' },
    { timezone: 'Europe/Amsterdam', now: '2026-03-29T00:30:00Z', date: '2026-03-29', startDate: '2026-03-23', endDate: '2026-03-29' },
    { timezone: 'Europe/Amsterdam', now: '2026-03-29T01:30:00Z', date: '2026-03-29', startDate: '2026-03-23', endDate: '2026-03-29' },
    { timezone: 'Europe/Amsterdam', now: '2026-10-25T00:30:00Z', date: '2026-10-25', startDate: '2026-10-19', endDate: '2026-10-25' },
    { timezone: 'Europe/Amsterdam', now: '2026-10-25T01:30:00Z', date: '2026-10-25', startDate: '2026-10-19', endDate: '2026-10-25' },
  ])('uses the server clock for $timezone at $now', async ({ timezone, now, ...expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const { caller, rows } = fixture();
    rows.get(vaProfiles)![0].timezone = timezone;
    expect(await caller.getDateContext()).toEqual({ timezone, ...expected });
  });
  it('keeps daily, weekly and card history scoped to the recorded current founder', async () => {
    const { caller } = fixture();
    const range = { startDate: '2026-10-19', endDate: '2026-10-25' };
    expect(await caller.getDailySummary({ date: '2026-10-19' })).toEqual([
      expect.objectContaining({ cardName: 'Current tenant', totalSeconds: 60 }),
    ]);
    expect(await caller.getWeeklyTotal(range)).toMatchObject({ totalSeconds: 60, complete: true });
    expect((await caller.getWeeklyBreakdown(range)).reduce((sum, row) => sum + row.totalSeconds, 0)).toBe(60);
    expect(await caller.getByCard({ cardId: 'card' })).toEqual([expect.objectContaining({ id: 1 })]);
    expect(await caller.getEntriesForCard({ cardId: 'card', date: '2026-10-19' })).toEqual([expect.objectContaining({ id: 1 })]);
  });
  it('rejects unknown history instead of inventing zero totals, but permits exact active STOP', async () => {
    const { caller, rows } = fixture(true);
    rows.get(timeEntries)!.push({ ...rows.get(timeEntries)![0], id: 4, endTime: null, durationSeconds: null });
    await expect(caller.getDailySummary({ date: '2026-10-19' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.getWeeklyTotal({ startDate: '2026-10-19', endDate: '2026-10-25' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.getByCard({ cardId: 'card' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await caller.getActive()).toMatchObject({ id: 4 });
    expect(await caller.stop({ entryId: 4, cardId: 'card' })).toMatchObject({ entry: { id: 4 } });
    expect(rows.get(timeEntries)!.find(row => row.id === 4).endTime).toBeInstanceOf(Date);
  });
  it('does not return private old-founder active DTOs after reassignment', async () => {
    const { caller, rows } = fixture();
    rows.get(timeEntries)![1].endTime = null;
    await expect(caller.getActive()).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
