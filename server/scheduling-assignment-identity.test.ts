import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assignmentEvents, taskAssignments, taskScheduleHistory, users, vaProfiles, type User } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';
import type { TrpcContext } from './_core/context';

const controls = vi.hoisted(() => ({ getDb: vi.fn(), invalidate: vi.fn(), emit: vi.fn() }));
vi.mock('./db', () => ({ getDb: controls.getDb }));
vi.mock('./services/trello-cache', () => ({ invalidateCache: controls.invalidate }));
vi.mock('./services/websocket', () => ({ websocketService: { emitToUser: controls.emit } }));
import * as scheduling from './db/scheduling';
import routes from './routes/advanced-scheduling';
import { appRouter } from './routers';

const founder = { id: 7, openId: 'founder-7', role: 'admin', name: 'Founder' } as User;
const worker = { id: 42, openId: 'worker-42', role: 'worker', name: 'Worker' } as User;
const taskId = 'card:checklist:item-a';
const nextStart = new Date('2026-10-22T10:00:00Z'), nextEnd = new Date('2026-10-22T11:00:00Z');
function assignment(id = 1, changes: Record<string, unknown> = {}) {
  return { id, taskId, founderId: 7, vaId: 3, status: 'assigned', assignedBy: 7,
    startTime: new Date('2026-10-22T08:00:00Z'), endTime: new Date('2026-10-22T09:00:00Z'), ...changes };
}
function fixture(assignments = [assignment()], failHistory = false) {
  const rows = new Map<unknown, any[]>([
    [users, [founder, worker, { id: 84, role: 'worker' }, { id: 9, role: 'admin' }]],
    [vaProfiles, [{ id: 3, userId: 42, founderId: 7, status: 'active' },
      { id: 5, userId: 84, founderId: 7, status: 'active' }]],
    [taskAssignments, assignments], [taskScheduleHistory, []], [assignmentEvents, []],
  ]);
  const store = timerTestDatabase(rows, { afterInsert: table => {
    if (failHistory && table === taskScheduleHistory) throw new Error('Synthetic history rejection');
  } });
  controls.getDb.mockResolvedValue(store.db);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = worker; next(); });
  app.use('/scheduling', routes);
  const caller = appRouter.createCaller({ user: founder, req: {}, res: {} } as TrpcContext);
  return { ...store, app, caller };
}
beforeEach(() => { vi.clearAllMocks(); controls.invalidate.mockResolvedValue(undefined); });

describe('scheduling canonical assignment boundaries', () => {
  for (const duplicate of [{ vaId: 5, status: 'completed' }, { vaId: 3, status: 'blocked' }]) {
    it(`rejects hidden duplicate ${JSON.stringify(duplicate)} before reads, schedule writes or history`, async () => {
      const f = fixture([assignment(), assignment(2, duplicate)]);
      for (const operation of [
        () => scheduling.getScheduledTaskForActor(taskId, worker),
        () => scheduling.getScheduleHistoryForActor(taskId, worker),
        () => scheduling.getUserTasks(worker),
        () => scheduling.getTasksByAssignee(worker, 3),
        () => scheduling.rescheduleTaskForActor(worker, taskId, nextStart, nextEnd),
        () => scheduling.undoLastRescheduleForActor(worker, taskId),
      ]) await expect(operation()).rejects.toMatchObject({ status: 409 });
      expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
    });
  }

  it('keeps different full checklist IDs and other founders independent', async () => {
    const f = fixture([assignment(), assignment(2, { taskId: 'card:checklist:item-b' }),
      assignment(3, { founderId: 9, vaId: 99 })]);
    expect((await scheduling.getUserTasks(worker)).map(row => row.taskId)).toEqual([taskId, 'card:checklist:item-b']);
    const result = await scheduling.rescheduleTaskForActor(worker, taskId, nextStart, nextEnd);
    expect(result).toMatchObject({ taskId, newStartTime: nextStart });
    expect(f.rows.get(taskAssignments)!.find(row => row.id === 2).startTime).not.toEqual(nextStart);
    expect(f.rows.get(taskAssignments)!.find(row => row.id === 3).startTime).not.toEqual(nextStart);
    expect(f.rows.get(taskScheduleHistory)).toEqual([expect.objectContaining({ founderId: 7, assignmentId: 1, taskId })]);
    expect(await scheduling.undoLastRescheduleForActor(worker, taskId)).toMatchObject({ taskId,
      newStartTime: new Date('2026-10-22T08:00:00Z') });
  });

  it('rolls back the schedule change when history persistence fails', async () => {
    const f = fixture([assignment()], true);
    await expect(scheduling.rescheduleTaskForActor(worker, taskId, nextStart, nextEnd)).rejects.toThrow('Synthetic history rejection');
    expect(f.rows.get(taskAssignments)![0].startTime).toEqual(new Date('2026-10-22T08:00:00Z'));
    expect(f.rows.get(taskScheduleHistory)).toEqual([]);
  });

  it('does not silently substitute an administrator role for a generic account', async () => {
    const f = fixture();
    const actor = { ...founder, role: 'user' as const };
    await expect(scheduling.rescheduleTaskForActor(actor, taskId, nextStart, nextEnd)).rejects.toMatchObject({ status: 403 });
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
  });

  it.each(['reschedule', 'undo', 'history', 'detect-conflicts'])('maps ambiguous %s requests to HTTP 409', async endpoint => {
    const f = fixture([assignment(), assignment(2, { vaId: 5, status: 'completed' })]);
    const response = endpoint === 'history'
      ? await request(f.app).get(`/scheduling/history/${encodeURIComponent(taskId)}`)
      : endpoint === 'undo' ? await request(f.app).post(`/scheduling/undo/${encodeURIComponent(taskId)}`)
        : await request(f.app).post(`/scheduling/${endpoint}`).send({ taskId, newStartTime: nextStart, newEndTime: nextEnd });
    expect(response.status).toBe(409);
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
  });

  it('rejects duplicate batch scheduling before persisting a job', async () => {
    const f = fixture([assignment(), assignment(2, { vaId: 5, status: 'completed' })]);
    await request(f.app).post('/scheduling/batch-start').send({ operationType: 'reschedule', taskIds: [taskId],
      parameters: { schedules: { [taskId]: { startTime: nextStart, endTime: nextEnd } } } }).expect(409);
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
  });

  for (const method of ['bulkComplete', 'bulkIncomplete'] as const) {
    it(`${method} validates all requested keys before any write, cache invalidation or emission`, async () => {
      const f = fixture([assignment(), assignment(2, { taskId: 'other' }),
        assignment(3, { taskId: 'other', vaId: 5, status: 'completed' })]);
      await expect(f.caller.scheduling[method]({ taskIds: [taskId, 'other'] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
      expect(controls.invalidate).not.toHaveBeenCalled(); expect(controls.emit).not.toHaveBeenCalled();
    });
  }

  it('bulk status changes preserve full checklist IDs and emit only after the transaction commits', async () => {
    const f = fixture([assignment(), assignment(2, { taskId: 'card:checklist:item-b' }),
      assignment(3, { founderId: 9, vaId: 99 })]);
    const transaction = f.db.transaction.getMockImplementation();
    let committed = false;
    f.db.transaction.mockImplementation(async (work: any) => { const result = await transaction(work); committed = true; return result; });
    controls.invalidate.mockImplementation(async () => { expect(committed).toBe(true); });
    controls.emit.mockImplementation(() => { expect(committed).toBe(true); });
    expect(await f.caller.scheduling.bulkComplete({ taskIds: [taskId, 'card:checklist:item-b'] }))
      .toMatchObject({ success: true, completed: 2, notFound: 0 });
    expect(f.rows.get(taskAssignments)!.find(row => row.id === 3).status).toBe('assigned');
    expect(f.rows.get(assignmentEvents)).toHaveLength(2);
    expect(controls.invalidate).toHaveBeenCalledOnce(); expect(controls.emit).toHaveBeenCalledOnce();
  });
});
