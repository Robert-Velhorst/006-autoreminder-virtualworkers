import { describe, expect, it } from 'vitest';
import { scheduleTasksByTime, readSchedulingAssignments, readSchedulingAssignmentSnapshot, type WorkerSettings } from './aptlss';
import { PgDialect } from 'drizzle-orm/pg-core';
import { taskAssignments, users, vaProfiles } from '../../drizzle/schema.postgres';
import { timerTestDatabase, type TestRow } from '../test/timerDatabase';

describe('founder scheduling assignment identity', () => {
  function fixture(rows: Array<{ id: number; founderId: number; taskId: string; vaId: number; status: string }>, beforeLock?: (table: unknown, params: unknown[]) => void) {
    const scopes: unknown[][] = [];
    const profiles = [...new Map(rows.map(row => [row.vaId,
      { id: row.vaId, userId: row.vaId + 100, founderId: row.founderId, status: 'active', workStartHour: 9, workEndHour: 18, workingDays: '1,2,3,4,5' }])).values()];
    const accounts = [...new Map([
      [7, { id: 7, role: 'admin' }],
      ...rows.map(row => [row.founderId, { id: row.founderId, role: 'admin' }] as const),
      ...profiles.map(profile => [profile.userId, { id: profile.userId, role: 'worker' }] as const),
    ]).values()];
    const state = new Map<unknown, TestRow[]>([[taskAssignments, structuredClone(rows)], [users, accounts], [vaProfiles, profiles]]);
    const locks: Array<{ table: unknown; params: unknown[] }> = [];
    const modes: string[] = [];
    const store = timerTestDatabase(state, { beforeLock: async (table, condition) => {
      const params = new PgDialect().sqlToQuery(condition).params;
      locks.push({ table, params }); beforeLock?.(table, params);
    } });
    store.db.execute.mockImplementation(async () => { locks.push({ table: 'identity', params: [] }); });
    const select = store.db.select;
    store.db.select = (...args: unknown[]) => {
      const query = select(...args); let table: unknown;
      const from = query.from; const where = query.where; const lock = query.for;
      query.from = (value: unknown) => { table = value; return from(value); };
      query.where = (condition: any) => {
        if (table === taskAssignments) scopes.push(new PgDialect().sqlToQuery(condition).params);
        return where(condition);
      };
      query.for = (mode: string) => { modes.push(mode); return lock(mode); };
      return query;
    };
    return { ...store, scopes, state, locks, modes };
  }

  it('keeps distinct full checklist keys and excludes another founder with the same external key', async () => {
    const { db, scopes } = fixture([
      { id: 1, founderId: 7, taskId: 'card:list:item-a', vaId: 10, status: 'assigned' },
      { id: 2, founderId: 7, taskId: 'card:list:item-b', vaId: 11, status: 'completed' },
      { id: 3, founderId: 99, taskId: 'card:list:item-a', vaId: 100, status: 'assigned' },
    ]);
    expect((await readSchedulingAssignments(db, 7, ['card:list:item-a', 'card:list:item-b'])).map(row => row.id)).toEqual([1, 2]);
    expect(scopes[0][0]).toBe(7);
  });

  it('does not hide a completed duplicate behind status or worker filters', async () => {
    const { db } = fixture([
      { id: 1, founderId: 7, taskId: 'card:list:item', vaId: 10, status: 'assigned' },
      { id: 2, founderId: 7, taskId: 'card:list:item', vaId: 11, status: 'completed' },
    ]);
    await expect(readSchedulingAssignments(db, 7, ['card:list:item'])).rejects.toMatchObject({ status: 409 });
  });

  it('batches more than 100 exact keys without truncating scheduling evidence', async () => {
    const rows = Array.from({ length: 203 }, (_, id) => ({ id, founderId: 7, taskId: `card:${id}`, vaId: 10, status: 'assigned' }));
    const { db, scopes } = fixture(rows);
    expect(await readSchedulingAssignments(db, 7, rows.map(row => row.taskId))).toHaveLength(203);
    expect(scopes.map(scope => scope.length)).toEqual([101, 101, 4, 101, 101, 4]);
  });

  const current = { id: 1, founderId: 7, taskId: 'card:list:item', vaId: 10, status: 'assigned' };

  it.each(['inactive', 'on_leave'])('rejects a retained assignment to an %s worker', async status => {
    const f = fixture([current]); f.state.get(vaProfiles)![0].status = status;
    await expect(readSchedulingAssignments(f.db, 7, [current.taskId])).rejects.toMatchObject({ status: 409 });
    expect(f.db.execute).not.toHaveBeenCalled(); expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
  });

  it.each(['admin', 'user'])('rejects a linked worker account whose role is %s', async role => {
    const f = fixture([current]); f.state.get(users)!.find(row => row.id === 110)!.role = role;
    await expect(readSchedulingAssignments(f.db, 7, [current.taskId])).rejects.toMatchObject({ status: 409 });
  });

  it('requires a fresh founder admin even for an empty/unassigned task set', async () => {
    const f = fixture([]); f.state.get(users)![0].role = 'worker';
    await expect(readSchedulingAssignments(f.db, 7, ['unassigned'])).rejects.toMatchObject({ status: 403 });
    expect(f.db.execute).not.toHaveBeenCalled();
  });

  it('accepts exactly one active profile while retaining inactive historical profiles', async () => {
    const f = fixture([current]);
    f.state.get(vaProfiles)!.push({ id: 99, userId: 110, founderId: 88, status: 'inactive' });
    const snapshot = await readSchedulingAssignmentSnapshot(f.db, 7, [current.taskId]);
    expect(snapshot.assignments).toEqual([current]);
    expect(snapshot.workers.map(profile => profile.id)).toEqual([10]);
    expect(f.state.get(vaProfiles)).toHaveLength(2);
  });

  it('rejects multiple active profiles for the same linked account, including another founder', async () => {
    const f = fixture([current]);
    f.state.get(vaProfiles)!.push({ id: 99, userId: 110, founderId: 88, status: 'active' });
    await expect(readSchedulingAssignments(f.db, 7, [current.taskId])).rejects.toMatchObject({ status: 409 });
  });

  it.each(['profile', 'account', 'foreign'])('fails closed for a missing/foreign %s identity', async change => {
    const f = fixture([current]);
    if (change === 'profile') f.state.set(vaProfiles, []);
    if (change === 'account') f.state.set(users, f.state.get(users)!.filter(row => row.id !== 110));
    if (change === 'foreign') f.state.get(vaProfiles)![0].founderId = 99;
    await expect(readSchedulingAssignments(f.db, 7, [current.taskId])).rejects.toMatchObject({ status: 409 });
  });

  it.each(['inactive', 'founder', 'link', 'ambiguous', 'role'])('rechecks a %s change while waiting for locks', async change => {
    let f: ReturnType<typeof fixture>;
    f = fixture([current], (table, params) => {
      if (change === 'role' && table === users && params[0] === 110) f.state.get(users)!.find(row => row.id === 110)!.role = 'admin';
      if (table !== vaProfiles) return;
      if (change === 'inactive') f.state.get(vaProfiles)![0].status = 'inactive';
      if (change === 'founder') f.state.get(vaProfiles)![0].founderId = 99;
      if (change === 'link') f.state.get(vaProfiles)![0].userId = 999;
      if (change === 'ambiguous') f.state.get(vaProfiles)!.push({ id: 99, userId: 110, founderId: 7, status: 'active' });
    });
    await expect(readSchedulingAssignments(f.db, 7, [current.taskId])).rejects.toMatchObject({ status: 409 });
    expect(f.db.execute).not.toHaveBeenCalled(); expect(f.updates).toEqual([]);
  });

  it('locks accounts ascending before profiles and identity rows, without locking old inactive owners', async () => {
    const f = fixture([current, { ...current, id: 2, taskId: 'other', vaId: 9 }]);
    await readSchedulingAssignments(f.db, 7, ['other', current.taskId]);
    expect(f.locks.filter(lock => lock.table === users).map(lock => lock.params[0])).toEqual([7, 109, 110]);
    expect(f.modes).toEqual(['no key update', 'no key update', 'no key update', 'update', 'update']);
    expect(f.locks.map(lock => lock.table)).toEqual([users, users, users, vaProfiles, 'identity', 'identity', taskAssignments]);
  });

  it('rejects an assignment changed to an unlocked worker after initial discovery', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture([current], table => { if (table === taskAssignments) f.state.get(taskAssignments)![0].vaId = 999; });
    await expect(readSchedulingAssignmentSnapshot(f.db, 7, [current.taskId])).rejects.toMatchObject({ status: 409 });
    expect(f.updates).toEqual([]);
  });

  it('rechecks duplicates appearing before the locked assignment read without hiding completed rows', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture([current], table => { if (table === taskAssignments) f.state.get(taskAssignments)!.push({ ...current, id: 2, status: 'completed' }); });
    await expect(readSchedulingAssignments(f.db, 7, [current.taskId])).rejects.toMatchObject({ status: 409 });
  });
});

describe('scheduleTasksByTime worker settings', () => {
  it('uses a worker-specific break and workday end when it validates a task', () => {
    const workerSettings = new Map<number, WorkerSettings>([
      [7, {
        workStartHour: 9,
        workEndHour: 12,
        workingDays: [1, 2, 3, 4, 5],
        schedulingOptions: {
          breakfastBreakStart: 10,
          breakfastBreakDuration: 30,
          lunchBreakStart: 99,
          lunchBreakDuration: 0,
        },
      }],
    ]);

    const result = scheduleTasksByTime([
      {
        id: 'worker-break-task',
        date: '2026-07-06',
        workerId: 7,
        cardName: 'Worker-specific schedule',
        durationHours: 2,
        priorityLevel: 'NORMAL',
        taskType: 'admin',
        stepIndex: 0,
      },
    ], 9, 18, [1, 2, 3, 4, 5], [], { lunchBreakDuration: 0 }, workerSettings);

    expect(result.scheduled).toHaveLength(0);
    expect(result.overflow).toHaveLength(1);
    expect(result.overflow[0].rejectionReason).toContain('12:00');
  });

  it('does not subtract a break outside the work window from available capacity', () => {
    const result = scheduleTasksByTime([
      {
        id: 'outside-break-task',
        date: '2026-07-06',
        cardName: 'Outside break capacity',
        durationHours: 7.5,
        priorityLevel: 'NORMAL',
        taskType: 'admin',
        stepIndex: 0,
      },
    ], 9, 18, [1, 2, 3, 4, 5], [], {
      lunchBreakDuration: 0,
      dinnerBreakStart: 20,
      dinnerBreakDuration: 120,
    });

    expect(result.overflow).toHaveLength(0);
    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0]).toMatchObject({ startTime: '09:00', endTime: '16:30' });
  });

  it('enforces a worker-specific daily capacity limit', () => {
    const workerSettings = new Map<number, WorkerSettings>([
      [8, {
        workStartHour: 9,
        workEndHour: 18,
        workingDays: [1, 2, 3, 4, 5],
        schedulingOptions: {
          lunchBreakDuration: 0,
          dailyHoursMax: 4,
        },
      }],
    ]);

    const result = scheduleTasksByTime([
      {
        id: 'worker-capacity-task',
        date: '2026-07-06',
        workerId: 8,
        cardName: 'Worker daily capacity',
        durationHours: 5,
        priorityLevel: 'NORMAL',
        taskType: 'admin',
        stepIndex: 0,
      },
    ], 9, 18, [1, 2, 3, 4, 5], [], { lunchBreakDuration: 0 }, workerSettings);

    expect(result.scheduled).toHaveLength(0);
    expect(result.overflow).toHaveLength(1);
    expect(result.overflow[0].rejectionReason).toContain('remaining capacity (240min)');
  });
});
