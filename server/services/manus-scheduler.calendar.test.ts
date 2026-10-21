import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeEntries, users, userWorkingHours, vaProfiles } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const controls = vi.hoisted(() => ({ getDb: vi.fn(), run: vi.fn(), provider: vi.fn() }));
vi.mock('../db', () => ({ getDb: controls.getDb }));
vi.mock('../scheduledJobRuntime', async original => ({ ...await original<typeof import('../scheduledJobRuntime')>(), runScheduledJob: controls.run }));
vi.mock('./trello-manus', () => ({ getWorkerCards: controls.provider, getWorkerCommentedCardIdsToday: controls.provider,
  isDoingList: () => false, isOnHoldList: () => false }));
import { startManusScheduler, stopManusScheduler } from './manus-scheduler';

function fixture(timezone: string, founderFallback = false) {
  const now = new Date();
  const rows = new Map<unknown, any[]>([
    [users, [{ id: 41, role: 'worker' }, { id: 9, role: 'admin' }]],
    [vaProfiles, [{ id: 7, userId: 41, founderId: 9, status: 'active', timezone: 'UTC', name: 'Synthetic worker' }]],
    [userWorkingHours, [{ userId: founderFallback ? 9 : 41, timezone, workStartHour: 9, workEndHour: 18,
      workStartMinute: 0, workEndMinute: 0, workingDays: '1,2,3,4,5', enableBreaks: 0 }]],
    [timeEntries, [{ id: 1, trackedUserId: 41, trackedProfileId: 7, founderId: 9, vaId: null, taskId: 'synthetic-card',
      cardId: 'synthetic-card', cardName: 'Synthetic card', cardUrl: null, boardName: null, listName: null,
      startTime: new Date(now.getTime() - 3600000), endTime: null, durationSeconds: null, durationMinutes: null,
      source: 'manus', category: 'client_work', notes: null, planDateKey: null, planBlockId: null, aptlssStepId: null,
      isVoided: false, voidedAt: null, voidReason: null, createdAt: now, updatedAt: now }]],
  ]);
  const store = timerTestDatabase(rows);
  // The auto-stop CAS includes literal SQL interpolation for text COLLATE.
  // Compare its compiled bound parameters, including every unchanged field.
  store.db.update = vi.fn(() => ({ set: (values: Record<string, unknown>) => ({ where: async (condition: SQL) => {
    const query = new PgDialect().sqlToQuery(condition);
    const predicates = [...query.sql.matchAll(/"time_entries"\."([^"]+)"(?: COLLATE "C")? (= \$[0-9]+(?:::text COLLATE "C")?|is null)/g)];
    let rowCount = 0;
    for (const row of rows.get(timeEntries)!) {
      let index = 0;
      const matches = predicates.map(([, key, operator]) => {
        if (operator === 'is null') return row[key] === null;
        const value = row[key] instanceof Date ? row[key].toISOString() : row[key];
        return value === query.params[index++];
      });
      expect(index).toBe(query.params.length);
      if (matches.every(Boolean)) { Object.assign(row, values); rowCount++; }
    }
    return { rowCount };
  } }) }));
  controls.getDb.mockResolvedValue(store.db);
  const completed = new Set<string>();
  const executions: string[] = [];
  const failures: unknown[] = [];
  controls.run.mockImplementation(async ({ jobKey }, work) => {
    if (completed.has(jobKey)) return { state: 'skipped' };
    let result;
    try { result = await work({ signal: new AbortController().signal, assertOwnership: async () => {} }); }
    catch (error) { failures.push(error); throw error; }
    completed.add(jobKey); executions.push(jobKey); return result;
  });
  return { ...store, executions, failures };
}
async function tick() {
  startManusScheduler(); await vi.advanceTimersByTimeAsync(0); stopManusScheduler();
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { stopManusScheduler(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('automatic timer canonical calendar', () => {
  it.each([false, true])('does not close at profile midnight before effective local midnight (founder fallback=%s)', async fallback => {
    vi.setSystemTime(new Date('2026-10-22T00:01:00Z'));
    const { rows, db } = fixture('America/Los_Angeles', fallback);
    await tick();
    expect(controls.run).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(rows.get(timeEntries)![0].endTime).toBeNull();
    expect(controls.provider).not.toHaveBeenCalled();
  });
  it.each([false, true])('closes at effective western midnight once per local dated job (founder fallback=%s)', async fallback => {
    vi.setSystemTime(new Date('2026-10-22T07:01:00Z'));
    const { rows, db, executions, failures } = fixture('America/Los_Angeles', fallback);
    await tick();
    expect(failures).toEqual([]);
    expect(rows.get(timeEntries)![0].endTime).toEqual(new Date('2026-10-22T07:01:00Z'));
    expect(executions).toEqual(['auto-stop:41:2026-10-22']);
    vi.setSystemTime(new Date('2026-10-22T07:02:00Z')); await tick();
    expect(executions).toHaveLength(1);
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(controls.provider).not.toHaveBeenCalled();
  });
  it.each([
    { now: '2026-03-28T23:01:00Z', next: '2026-03-29T22:01:00Z', firstDate: '2026-03-29', nextDate: '2026-03-30' },
    { now: '2026-10-24T22:01:00Z', next: '2026-10-25T23:01:00Z', firstDate: '2026-10-25', nextDate: '2026-10-26' },
  ])('retains distinct daily job identities across DST at $now', async ({ now, next, firstDate, nextDate }) => {
    vi.setSystemTime(new Date(now));
    const { executions } = fixture('Europe/Amsterdam');
    await tick(); vi.setSystemTime(new Date(next)); await tick();
    expect(executions).toEqual([`auto-stop:41:${firstDate}`, `auto-stop:41:${nextDate}`]);
    expect(controls.provider).not.toHaveBeenCalled();
  });
  it('does not claim a timer job when active profile ownership is ambiguous', async () => {
    vi.setSystemTime(new Date('2026-10-22T07:01:00Z'));
    const { rows, db } = fixture('America/Los_Angeles');
    rows.get(vaProfiles)!.push({ ...rows.get(vaProfiles)![0], id: 8 });
    await tick();
    expect(controls.run).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
