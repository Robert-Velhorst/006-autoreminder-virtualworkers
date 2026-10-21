import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../drizzle/schema.postgres';
import { createAssignmentDatabase, type AssignmentDatabase } from '../test/assignmentDatabase';

const controls = vi.hoisted(() => ({ getDb: vi.fn(), cache: vi.fn(), emit: vi.fn() }));
vi.mock('../db', () => ({ getDb: controls.getDb }));
vi.mock('../services/trello-cache', () => ({ invalidateCache: controls.cache }));
vi.mock('../services/websocket', () => ({ websocketService: { emitToUser: controls.emit } }));
import router from './va-management';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!baseUrl)('mounted assignment HTTP native PostgreSQL acceptance', { timeout: 30000 }, () => {
  let fixture: AssignmentDatabase;
  const founder = { id: 1001, openId: 'http-assignment-founder', role: 'admin' } as User;
  const worker = { id: 1002, openId: 'http-assignment-worker', role: 'worker' } as User;
  const peer = { id: 1003, openId: 'http-assignment-peer', role: 'worker' } as User;
  const foreignFounder = { id: 1004, openId: 'http-assignment-other-founder', role: 'admin' } as User;
  const taskId = 'card-alpha:list-beta:item-gamma.v2/opaque';
  function app(actor = founder) {
    const application = express(); application.use(express.json());
    // Authentication is outside this suite; current actor authority is re-read
    // by the real services from the private PostgreSQL fixture.
    application.use((req, _res, next) => { (req as express.Request & { user: User }).user = actor; next(); });
    application.use('/api/va',router); return application;
  }
  const assign = (vaId = 12, key = taskId, actor = founder) => request(app(actor)).post('/api/va/assignments').send({ taskId: key, vaId });
  const complete = (actor = worker) => request(app(actor)).post(`/api/va/worker/tasks/${encodeURIComponent(taskId)}/complete`).send({ completed: true });
  const assignments = async () => (await fixture.pool.query('SELECT to_jsonb(a) AS row FROM task_assignments a ORDER BY id')).rows.map(row => row.row);
  const events = async () => (await fixture.pool.query('SELECT to_jsonb(e) AS row FROM assignment_events e ORDER BY id')).rows.map(row => row.row);
  const messages = async () => (await fixture.pool.query('SELECT to_jsonb(m) AS row FROM communication_log m ORDER BY id')).rows.map(row => row.row);
  beforeAll(async () => {
    fixture = await createAssignmentDatabase(baseUrl);
    controls.getDb.mockResolvedValue(fixture.db);
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS','');
  },120000);
  beforeEach(async () => {
    await fixture.pool.query(`TRUNCATE communication_log,assignment_events,task_schedule_history,task_assignments,va_profiles,users RESTART IDENTITY CASCADE`);
    await fixture.pool.query(`INSERT INTO users (id,"openId",role) VALUES
      (1001,'http-assignment-founder','admin'),(1002,'http-assignment-worker','worker'),
      (1003,'http-assignment-peer','worker'),(1004,'http-assignment-other-founder','admin'),
      (1005,'http-assignment-foreign-worker','worker')`);
    await fixture.pool.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status) VALUES
      (12,1002,1001,'Assigned worker','active'),(13,1003,1001,'Message recipient','active'),
      (14,1005,1004,'Other tenant','active')`);
    controls.cache.mockReset().mockResolvedValue(undefined); controls.emit.mockReset();
  });
  afterAll(async () => {
    controls.getDb.mockReset(); vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });

  it('mounts primary assign and reassign with a stable ID and idempotent timestamps/audit', async () => {
    await request(app()).post('/api/va/assignments').send({ taskId,vaId: 12,notes: 'Retained HTTP note' }).expect(200);
    const original = await assignments(); const firstAudit = await events();
    expect(original).toHaveLength(1); expect(firstAudit).toHaveLength(1);
    expect(firstAudit[0]).toMatchObject({ kind: 'created',assignmentId: original[0].id,actorUserId: 1001,nextWorkerProfileId: 12 });
    await assign().expect(200);
    expect(await assignments()).toEqual(original); expect(await events()).toEqual(firstAudit);
    const path = `/api/va/assignments/${original[0].id}/assign`;
    await request(app()).post(path).send({ vaId: 13 }).expect(200);
    const changed = await assignments(); const changedAudit = await events();
    expect(changed).toMatchObject([{ id: original[0].id,taskId,vaId: 13,notes: 'Retained HTTP note' }]);
    expect(changedAudit).toHaveLength(2);
    expect(changedAudit[1]).toMatchObject({ kind: 'reassigned',assignmentId: original[0].id,previousWorkerProfileId: 12,nextWorkerProfileId: 13 });
    await request(app()).post(path).send({ vaId: 13 }).expect(200);
    expect(await assignments()).toEqual(changed); expect(await events()).toEqual(changedAudit);
    expect(controls.cache).toHaveBeenCalledWith(1001,founder.openId,'tasks');
  });

  it('completes only the opaque full task key for the actual worker and refuses another worker', async () => {
    await assign().expect(200); await assign(13,'card-alpha').expect(200);
    await assign(13,'card-alpha:list-beta:item-other').expect(200);
    await assign(14,taskId,foreignFounder).expect(200);
    controls.cache.mockClear(); controls.emit.mockClear();
    await complete().expect(200);
    expect((await assignments()).filter(row => row.status === 'completed')).toMatchObject([{ founderId: 1001,taskId,vaId: 12 }]);
    const statusEvents = (await events()).filter(event => event.kind === 'status_changed');
    expect(statusEvents).toHaveLength(1); expect(statusEvents[0]).toMatchObject({ taskId,actorUserId: 1002,nextStatus: 'completed' });
    expect(controls.cache).toHaveBeenCalledWith(1002,worker.openId,'tasks');
    expect(controls.emit).toHaveBeenCalledWith(worker.openId,'task:completed',expect.objectContaining({ taskId,isCompleted: true }));
    const before = await assignments(); const audit = await events();
    await complete().expect(200); expect(await assignments()).toEqual(before); expect(await events()).toEqual(audit);
    controls.cache.mockClear(); controls.emit.mockClear();
    await complete(peer).expect(403);
    expect(await assignments()).toEqual(before); expect(await events()).toEqual(audit);
    expect(controls.cache).not.toHaveBeenCalled(); expect(controls.emit).not.toHaveBeenCalled();
  });

  it('rolls back HTTP create/reassign/completion when the actual audit INSERT fails, without cache or realtime success', async () => {
    await assign().expect(200); const before = await assignments(); const audit = await events();
    controls.cache.mockClear(); controls.emit.mockClear();
    try {
      await fixture.pool.query(`CREATE FUNCTION reject_http_assignment_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic HTTP assignment audit rejection' USING ERRCODE='23514'; END; $$`);
      await fixture.pool.query('CREATE TRIGGER reject_http_assignment_audit BEFORE INSERT ON assignment_events FOR EACH ROW EXECUTE FUNCTION reject_http_assignment_audit()');
      await assign(12,'new-full-task').expect(500,{ error: 'Failed to assign task' });
      expect(await assignments()).toEqual(before); expect(await events()).toEqual(audit);
      await request(app()).post(`/api/va/assignments/${before[0].id}/assign`).send({ vaId: 13 }).expect(500,{ error: 'Failed to assign task' });
      expect(await assignments()).toEqual(before); expect(await events()).toEqual(audit);
      await complete().expect(500,{ error: 'Failed to update task' });
      expect(await assignments()).toEqual(before); expect(await events()).toEqual(audit);
      expect(controls.cache).not.toHaveBeenCalled(); expect(controls.emit).not.toHaveBeenCalled();
    } finally {
      await fixture.pool.query('DROP TRIGGER IF EXISTS reject_http_assignment_audit ON assignment_events');
      await fixture.pool.query('DROP FUNCTION IF EXISTS reject_http_assignment_audit()');
    }
  });

  const races = [true,false].flatMap(taskBound => [
    { taskBound,change: 'role',status: taskBound ? 409 : 403 },
    { taskBound,change: 'founder',status: 409 },
    { taskBound,change: 'profile relink',status: 409 },
  ]);
  it.each(races)('rejects recipient $change after an observed account wait (task-bound=$taskBound) without inserting communication', async ({ taskBound,change,status }) => {
    await assign().expect(200);
    const body = { ...(taskBound ? { taskId } : {}),toUserId: 1003,messageType: 'update',message: 'Synthetic recipient-scoped message' };
    await request(app()).post('/api/va/communication').send(body).expect(200);
    const beforeMessages = await messages(); const beforeAssignments = await assignments(); const beforeAudit = await events();
    expect(beforeMessages).toHaveLength(1);
    expect(beforeMessages[0]).toMatchObject({ fromUserId: 1001,toUserId: 1003,taskId: taskBound ? taskId : null });
    controls.cache.mockClear(); controls.emit.mockClear();
    const gate = await fixture.pool.connect();
    let pending: Promise<{ response?: request.Response; error?: unknown }> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await gate.query('SELECT id FROM users WHERE id=1001 FOR NO KEY UPDATE');
      pending = request(app()).post('/api/va/communication').send(body).timeout({ deadline: 12000 })
        .then(response => ({ response }),error => ({ error }));
      const deadline = performance.now() + 5000; let blocked = false;
      while (performance.now() < deadline) {
        const observed = await fixture.pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND $1::integer=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`,[gatePid]);
        if (observed.rows.length === 1) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(blocked).toBe(true); // Preflight has completed; the real account guard is waiting.
      if (change === 'role') await fixture.pool.query("UPDATE users SET role='user' WHERE id=1003");
      else if (change === 'founder') await fixture.pool.query('UPDATE va_profiles SET "founderId"=1004 WHERE id=13');
      else {
        const mutation = await fixture.pool.connect();
        try {
          await mutation.query('BEGIN');
          await mutation.query('UPDATE va_profiles SET "userId"=1005,status=\'inactive\' WHERE id=13');
          await mutation.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status) VALUES (16,1003,1001,'Replacement recipient profile','active')`);
          await mutation.query('COMMIT');
        } finally { await mutation.query('ROLLBACK'); mutation.release(); }
      }
      await gate.query('COMMIT'); const result = await pending; if (result.error) throw result.error;
      expect(result.response?.status).toBe(status);
      expect(result.response?.body).toEqual({ error: expect.any(String) });
      expect(await messages()).toEqual(beforeMessages); expect(await assignments()).toEqual(beforeAssignments); expect(await events()).toEqual(beforeAudit);
      expect(controls.cache).not.toHaveBeenCalled(); expect(controls.emit).not.toHaveBeenCalled();
    } finally { await gate.query('ROLLBACK'); gate.release(true); if (pending) await pending; }
  });
});
