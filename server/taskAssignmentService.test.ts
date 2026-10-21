import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { assignmentEvents, taskAssignments, users, vaProfiles } from '../drizzle/schema.postgres';
import { timerTestDatabase, type TestRow } from './test/timerDatabase';
import { assignTask, reassignTask, changeAssignmentStatus, changeAssignmentStatuses, withLockedAssignment } from './taskAssignmentService';

const admin = { id: 10, role: 'admin' as const };
const worker = { id: 20, role: 'worker' as const };
const date = new Date('2026-10-20T12:00:00Z');
function assignment(overrides: TestRow = {}) {
  return { id: 100, taskId: 'card:list:item', founderId: admin.id, vaId: 200, assignedBy: admin.id,
    assignedAt: date, createdAt: date, updatedAt: date, status: 'assigned', notes: 'Preserved notes',
    startTime: date, endTime: new Date(date.getTime() + 60000), handoffNotes: 'handoff',
    decisionLog: '[{"decision":"keep"}]', externalLinks: '["https://example.invalid"]', lastWorkedAt: date, ...overrides };
}

function fixture(initial: TestRow[] = [], hooks: { beforeLock?: (table: unknown) => void; failAudit?: boolean; beforeUpsert?: () => void } = {}) {
  const rows = new Map<unknown, TestRow[]>([
    [users, [{ ...admin }, { ...worker }, { id: 30, role: 'worker' }, { id: 40, role: 'admin' }]],
    [vaProfiles, [{ id: 200, userId: 20, founderId: 10, status: 'active' },
      { id: 201, userId: 20, founderId: 40, status: 'inactive' },
      { id: 300, userId: 30, founderId: 10, status: 'active' }]],
    [taskAssignments, initial.map(value => structuredClone(value))], [assignmentEvents, []],
  ]);
  const locks: unknown[] = [];
  const store = timerTestDatabase(rows, {
    beforeLock: async table => { locks.push(table); hooks.beforeLock?.(table); },
    afterInsert: table => { if (table === assignmentEvents && hooks.failAudit) throw new Error('audit unavailable'); },
  });
  store.db.execute.mockImplementation(async () => { locks.push('identity'); });
  const insert = store.db.insert;
  // Model PostgreSQL's unique-target upsert and conditional RETURNING, not lock concurrency.
  store.db.insert = (table: unknown) => table !== taskAssignments ? insert(table) : { values: (value: TestRow) => {
    let conflict: any;
    return { onConflictDoUpdate: (options: any) => { conflict = options; return {
      returning: async () => {
        hooks.beforeUpsert?.();
        const current = rows.get(taskAssignments)!.find(row => row.founderId === value.founderId && row.taskId === value.taskId);
        if (current) {
          const predicate = new PgDialect().sqlToQuery(conflict.setWhere);
          if (predicate.sql === 'false' || (predicate.params.length && predicate.params[0] !== current.id)) return [];
          return store.db.update(taskAssignments).set(conflict.set).where(eq(taskAssignments.id, current.id)).returning();
        }
        const { id: _id, ...defaults } = assignment({ notes: null });
        return insert(table).values({ ...defaults, ...value }).returning();
      },
    }; } };
  } };
  return { ...store, locks, list: (table: unknown) => rows.get(table)! };
}

describe('transactional task assignment service', () => {
  it('creates one canonical row and dedicated audit with historical inactive profiles retained', async () => {
    const f = fixture();
    const result = await assignTask(f.db, admin, { taskId: 'card:list:item', workerProfileId: 200, notes: 'new' });
    expect(result.outcome).toBe('created');
    expect(f.list(taskAssignments)).toHaveLength(1);
    expect(f.list(assignmentEvents)[0]).toMatchObject({ assignmentId: result.assignment.id, founderId: 10,
      taskId: 'card:list:item', actorUserId: 10, kind: 'created', beforeJson: null, nextWorkerProfileId: 200 });
    expect(f.list(vaProfiles)).toHaveLength(3);
  });

  it('reassigns in place preserving all unrelated raw fields and prior identity in audit', async () => {
    const original = assignment(); const f = fixture([original]);
    const result = await reassignTask(f.db, admin, { assignmentId: 100, workerProfileId: 300 });
    expect(result).toMatchObject({ outcome: 'changed', assignment: { ...original, vaId: 300, assignedBy: 10,
      assignedAt: expect.any(Date), updatedAt: expect.any(Date) } });
    expect(f.list(assignmentEvents)[0]).toMatchObject({ kind: 'reassigned', previousWorkerProfileId: 200,
      nextWorkerProfileId: 300, beforeJson: original, afterJson: result.assignment });
    expect(f.list(taskAssignments)).toHaveLength(1);
  });

  it('permits reassignment away from an inactive old worker without locking that old account late', async () => {
    const f = fixture([assignment()]);
    f.list(vaProfiles).find(row => row.id === 200)!.status = 'inactive';
    const result = await reassignTask(f.db, admin, { assignmentId: 100, workerProfileId: 300 });
    expect(result.assignment.vaId).toBe(300);
    expect(f.locks.slice(f.locks.indexOf('identity') + 1)).not.toContain(users);
  });

  it('leaves timestamp, assigner, and event count unchanged on an identical retry', async () => {
    const original = assignment(); const f = fixture([original]);
    expect((await assignTask(f.db, admin, { taskId: original.taskId, workerProfileId: 200 })).outcome).toBe('unchanged');
    expect((await reassignTask(f.db, admin, { assignmentId: 100, workerProfileId: 200 })).outcome).toBe('unchanged');
    expect(f.list(taskAssignments)).toEqual([original]);
    expect(f.list(assignmentEvents)).toEqual([]);
    expect(f.updates).toEqual([]);
  });

  it('preserves omitted notes and explicitly clears null notes without resetting assignment time', async () => {
    const f = fixture([assignment()]);
    const result = await assignTask(f.db, admin, { taskId: 'card:list:item', workerProfileId: 200, notes: null });
    expect(result.assignment).toMatchObject({ notes: null, assignedAt: date, createdAt: date });
    expect(f.list(assignmentEvents)[0].kind).toBe('notes_changed');
  });

  it.each(['worker', 'user'] as const)('rejects a stale admin whose persisted role became %s', async role => {
    const f = fixture([assignment()]); f.list(users)[0].role = role;
    await expect(changeAssignmentStatus(f.db, admin, { taskId: 'card:list:item', status: 'completed' })).rejects.toMatchObject({ status: 403 });
    expect(f.list(taskAssignments)[0].status).toBe('assigned'); expect(f.list(assignmentEvents)).toEqual([]);
  });

  it.each(['inactive', 'on_leave'])('rejects a target with %s eligibility', async status => {
    const f = fixture(); f.list(vaProfiles)[0].status = status;
    await expect(assignTask(f.db, admin, { taskId: 'card', workerProfileId: 200 })).rejects.toMatchObject({ status: 409 });
    expect(f.list(taskAssignments)).toEqual([]);
  });

  it.each(['founder', 'role', 'ambiguous'])('rechecks target %s under account/profile locks', async change => {
    const f = fixture();
    if (change === 'founder') f.list(vaProfiles)[0].founderId = 40;
    if (change === 'role') f.list(users).find(row => row.id === 20)!.role = 'admin';
    if (change === 'ambiguous') f.list(vaProfiles).push({ id: 202, userId: 20, founderId: 10, status: 'active' });
    await expect(assignTask(f.db, admin, { taskId: 'card', workerProfileId: 200 })).rejects.toMatchObject({ status: 409 });
    expect(f.list(taskAssignments)).toEqual([]);
  });

  it('detects target offboarding between initial discovery and profile locking', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture([], { beforeLock: table => { if (table === vaProfiles) f.list(vaProfiles)[0].status = 'inactive'; } });
    await expect(assignTask(f.db, admin, { taskId: 'card', workerProfileId: 200 })).rejects.toMatchObject({ status: 409 });
    expect(f.list(taskAssignments)).toEqual([]);
  });

  it('blocks foreign/missing ID reassignment without changing any row', async () => {
    const original = assignment({ founderId: 40 }); const f = fixture([original]);
    await expect(reassignTask(f.db, admin, { assignmentId: 100, workerProfileId: 300 })).rejects.toMatchObject({ status: 404 });
    expect(f.list(taskAssignments)).toEqual([original]); expect(f.list(assignmentEvents)).toEqual([]);
  });

  it('requires administrator assignment privileges even for a correctly scoped worker', async () => {
    const f = fixture();
    await expect(assignTask(f.db, worker, { taskId: 'card', workerProfileId: 200 })).rejects.toMatchObject({ status: 403 });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it('changes only the assigned worker exact row and records status history', async () => {
    const f = fixture([assignment(), assignment({ id: 101, taskId: 'other', vaId: 300 })]);
    expect((await changeAssignmentStatus(f.db, worker, { taskId: 'card:list:item', status: 'completed' })).assignment.status).toBe('completed');
    expect(f.list(taskAssignments)[1].status).toBe('assigned');
    expect(f.list(assignmentEvents)[0]).toMatchObject({ kind: 'status_changed', actorUserId: 20, previousStatus: 'assigned', nextStatus: 'completed' });
  });

  it('rejects another worker task without writing', async () => {
    const f = fixture([assignment({ vaId: 300 })]);
    await expect(changeAssignmentStatus(f.db, worker, { taskId: 'card:list:item', status: 'completed' })).rejects.toMatchObject({ status: 403 });
    expect(f.updates).toEqual([]);
  });

  it('rejects duplicate identities before any status update, including completed/other-worker rows', async () => {
    const f = fixture([assignment(), assignment({ id: 101, vaId: 300, status: 'completed' })]);
    await expect(changeAssignmentStatus(f.db, worker, { taskId: 'card:list:item', status: 'completed' })).rejects.toMatchObject({ status: 409 });
    expect(f.updates).toEqual([]); expect(f.list(assignmentEvents)).toEqual([]);
  });

  it('rolls back assignment creation when its audit insert fails', async () => {
    const f = fixture([], { failAudit: true });
    await expect(assignTask(f.db, admin, { taskId: 'card', workerProfileId: 200 })).rejects.toThrow('audit unavailable');
    expect(f.list(taskAssignments)).toEqual([]); expect(f.list(assignmentEvents)).toEqual([]);
  });

  it('rolls back reassignment and bulk updates with audit failure', async () => {
    const originals = [assignment(), assignment({ id: 101, taskId: 'other' })]; const f = fixture(originals, { failAudit: true });
    await expect(reassignTask(f.db, admin, { assignmentId: 100, workerProfileId: 300 })).rejects.toThrow();
    expect(f.list(taskAssignments)).toEqual(originals);
    await expect(changeAssignmentStatuses(f.db, admin, { taskIds: ['other', 'card:list:item'], status: 'completed' })).rejects.toThrow();
    expect(f.list(taskAssignments)).toEqual(originals); expect(f.list(assignmentEvents)).toEqual([]);
  });

  it('rejects missing bulk tasks atomically and deduplicates repeated requested tasks', async () => {
    const f = fixture([assignment()]);
    await expect(changeAssignmentStatuses(f.db, admin, { taskIds: ['missing', 'card:list:item'], status: 'completed' })).rejects.toMatchObject({ status: 404 });
    expect(f.updates).toEqual([]);
    expect(await changeAssignmentStatuses(f.db, admin, { taskIds: ['card:list:item', 'card:list:item'], status: 'completed' })).toHaveLength(1);
    expect(f.list(assignmentEvents)).toHaveLength(1);
  });

  it('validates status and task identity before starting any transaction', async () => {
    const f = fixture();
    await expect(changeAssignmentStatus(f.db, admin, { taskId: 'card', status: 'bad' as any })).rejects.toMatchObject({ status: 400 });
    await expect(assignTask(f.db, admin, { taskId: ' ', workerProfileId: 200 })).rejects.toMatchObject({ status: 400 });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it('locks requested handoff accounts/profiles before identity rows and rolls back callback failure', async () => {
    const f = fixture([assignment()]);
    await expect(withLockedAssignment(f.db, admin, 'card:list:item', async (tx, current, context) => {
      expect(context.profiles.get(300)?.userId).toBe(30);
      await tx.update(taskAssignments).set({ handoffNotes: 'changed' }).where(eq(taskAssignments.id, current.id));
      throw new Error('history insert failed');
    }, { workerProfileIds: [300, 200] })).rejects.toThrow('history insert failed');
    expect(f.list(taskAssignments)[0].handoffNotes).toBe('handoff');
    const keyIndex = f.locks.indexOf('identity');
    expect(f.locks.slice(0, keyIndex)).toEqual([users, users, users, vaProfiles]);
    expect(f.locks.slice(keyIndex + 1)).not.toContain(users);
    expect(f.locks.slice(keyIndex + 1)).not.toContain(vaProfiles);
  });

  it('does not blindly overwrite a new non-cooperating identity inserted after the locked read', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture([], { beforeUpsert: () => { f.list(taskAssignments).push(assignment({ vaId: 300 })); } });
    await expect(assignTask(f.db, admin, { taskId: 'card:list:item', workerProfileId: 200 })).rejects.toMatchObject({ status: 409 });
    expect(f.list(assignmentEvents)).toEqual([]); expect(f.updates).toEqual([]);
  });
});
