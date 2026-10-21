import { describe, expect, it, vi } from 'vitest';
import { users, vaProfiles, timeEntries, timeEntryEvents, type User } from '../drizzle/schema.postgres';
import { closeCanonicalTimer, correctCanonicalTimer, insertCanonicalTimer, requireEntryId,
  timeCompleteness, withTimerAccountTransaction } from './canonicalTimer';
import { timerTestDatabase } from './test/timerDatabase';
import { recordedSeconds } from '../shared/timerDuration';

const actor = { id: 42, role: 'worker' } as User;
function fixture(afterInsert?: (table: unknown) => void) {
  const rows = new Map<unknown, any[]>([
    [users, [{ id: 7, role: 'admin' }, actor]],
    [vaProfiles, [{ id: 3, userId: 42, founderId: 7, status: 'active' }]],
    [timeEntries, [{ id: 1, taskId: 'card', cardId: 'card', trackedUserId: 42, trackedProfileId: 3,
      vaId: null, founderId: 7, startTime: new Date('2026-10-01T10:00:00Z'), endTime: null,
      durationSeconds: null, notes: 'private notes', isVoided: false }]],
    [timeEntryEvents, []],
  ]);
  return timerTestDatabase(rows, { afterInsert });
}

describe('canonical timer transaction behavior', () => {
  it.each([undefined, null, '1', 0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid exact entry ID %s', value => {
    expect(() => requireEntryId(value)).toThrow('Reload the active timer');
  });
  it('does not implicitly switch an existing active timer', async () => {
    const { db, inserts } = fixture();
    await expect(withTimerAccountTransaction(db, actor, tx => insertCanonicalTimer(tx, {
      taskId: 'next', vaId: null, trackedUserId: 42, trackedProfileId: 3, founderId: 7, startTime: new Date(),
    }))).rejects.toMatchObject({ status: 409 });
    expect(inserts).toEqual([]);
  });
  it('keeps stale exact STOP on entry A from closing later active entry B', async () => {
    const { db, rows } = fixture();
    const afterClose = vi.fn();
    const stopped = await closeCanonicalTimer(db, actor, 1, 'stop', { afterClose });
    rows.get(timeEntries)!.push({ ...stopped.entry, id: 2, endTime: null });
    expect(await closeCanonicalTimer(db, actor, 1, 'pause', { afterClose })).toMatchObject({ alreadyStopped: true, paused: false, entry: { id: 1 } });
    expect(rows.get(timeEntries)!.find(row => row.id === 2).endTime).toBeNull();
    expect(afterClose).toHaveBeenCalledTimes(1);
    expect(rows.get(timeEntryEvents)).toHaveLength(1);
    expect(JSON.stringify(rows.get(timeEntryEvents))).not.toContain('private notes');
  });
  it('rolls back closure if its audit insert fails', async () => {
    const { db, rows } = fixture(table => { if (table === timeEntryEvents) throw new Error('synthetic audit failure'); });
    await expect(closeCanonicalTimer(db, actor, 1, 'stop')).rejects.toThrow('synthetic audit failure');
    expect(rows.get(timeEntries)![0].endTime).toBeNull();
    expect(rows.get(timeEntryEvents)).toEqual([]);
  });
  it.each(['inactive', 'reassigned', 'promoted'])('lets the historical founder close after subject is %s', async condition => {
    const { db, rows } = fixture();
    if (condition === 'inactive') rows.get(vaProfiles)![0].status = 'inactive';
    if (condition === 'reassigned') rows.get(vaProfiles)![0].founderId = 99;
    if (condition === 'promoted') rows.get(users)![1] = { id: 42, role: 'admin' };
    expect(await closeCanonicalTimer(db, { id: 7, role: 'admin' }, 1, 'stop', { founderManaged: true }))
      .toMatchObject({ entry: { id: 1, founderId: 7 } });
    expect(rows.get(vaProfiles)![0].founderId).toBe(condition === 'reassigned' ? 99 : 7);
  });
  it('prevents a promoted worker or reassigned worker from correcting past-tenant entries', async () => {
    const { db, rows } = fixture();
    rows.get(timeEntries)![0].endTime = new Date();
    rows.get(vaProfiles)![0].founderId = 99;
    await expect(correctCanonicalTimer(db, actor, 1, { durationSeconds: 60 })).rejects.toMatchObject({ status: 404 });
    rows.get(users)![1] = { id: 42, role: 'admin' };
    await expect(closeCanonicalTimer(db, { id: 42, role: 'admin' }, 1, 'stop')).rejects.toMatchObject({ status: 409 });
  });
  it('counts unknown history without assigning legacy aliases to accounts', async () => {
    const { db, rows } = fixture();
    rows.get(timeEntries)!.push({ ...rows.get(timeEntries)![0], id: 2, vaId: 42, trackedUserId: null, endTime: new Date() });
    expect(await timeCompleteness(db, 7)).toEqual({ complete: false, unresolvedEntryCount: 1 });
    expect(await timeCompleteness(db, 99)).toEqual({ complete: true, unresolvedEntryCount: 0 });
  });
  it.each([
    { endTime: null, durationSeconds: 600, expected: 0 },
    { endTime: new Date(), isVoided: true, durationSeconds: 600, expected: 0 },
    { endTime: new Date(), durationSeconds: 61, durationMinutes: 2, expected: 61 },
    { endTime: new Date(), durationMinutes: 2, expected: 120 },
    { endTime: new Date(), durationSeconds: -5, expected: 0 },
  ])('applies the shared duration policy %#', ({ expected, ...entry }) => {
    expect(recordedSeconds(entry)).toBe(expected);
  });
});
