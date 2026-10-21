import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../drizzle/schema.postgres';
import { createAssignmentDatabase, type AssignmentDatabase } from './test/assignmentDatabase';
import { readCanonicalAssignment, readCanonicalAssignments } from './taskAssignmentMutation';
import { assignTask, reassignTask, changeAssignmentStatus, changeAssignmentStatuses, withLockedAssignment } from './taskAssignmentService';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
const founder = { id: 1001, role: 'admin' as const };
async function seed(pool: Pool) {
  await pool.query(`INSERT INTO users (id,"openId",role) VALUES
    (1001,'assignment-founder','admin'),(1002,'assignment-worker','worker'),
    (1003,'assignment-peer','worker'),(1004,'assignment-other-founder','admin'),
    (1005,'assignment-third-worker','worker')`);
  await pool.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status) VALUES
    (12,1002,1001,'First','active'),(13,1003,1001,'Second','active'),
    (14,1005,1004,'Other tenant','active'),(15,1002,1001,'Historical','inactive')`);
}
async function rawAssignments(pool: Pool) {
  return (await pool.query('SELECT to_jsonb(a) AS row FROM task_assignments a ORDER BY id')).rows.map(row => row.row);
}
async function rawEvents(pool: Pool) {
  return (await pool.query('SELECT to_jsonb(e) AS row FROM assignment_events e ORDER BY id')).rows.map(row => row.row);
}
async function blockedBy(pool: Pool, blocker: number) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const result = await pool.query<{ pid: number; wait_event: string }>(`SELECT pid,wait_event FROM pg_stat_activity
      WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid)) ORDER BY pid`, [blocker]);
    if (result.rows.length === 1) return result.rows[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected assignment PostgreSQL blocking edge was not observed');
}
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));

describe.skipIf(!baseUrl)('canonical task assignment native service acceptance', { timeout: 30000 }, () => {
  let fixture: AssignmentDatabase;
  beforeAll(async () => { fixture = await createAssignmentDatabase(baseUrl); }, 120000);
  beforeEach(async () => {
    await fixture.pool.query(`TRUNCATE assignment_events,task_schedule_history,task_assignments,va_profiles,users RESTART IDENTITY CASCADE`);
    await seed(fixture.pool);
  });
  afterAll(async () => { if (fixture) await fixture.close(); });
  const assign = (workerProfileId = 12, taskId = 'card:list:item') => assignTask(fixture.db,founder,{ taskId,workerProfileId });
  const pid = async (client: PoolClient) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  async function waiters(blocker: number, count: number) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const waiting = (await fixture.pool.query<{ pid: number; blockers: number[]; wait_event: string }>(`SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event
        FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`)).rows;
      const reachesGate = (pid: number, seen = new Set<number>()): boolean => {
        if (pid === blocker) return true;
        if (seen.has(pid)) return false;
        const nextSeen = new Set(seen).add(pid);
        return waiting.find(row => row.pid === pid)?.blockers.some(next => reachesGate(next, nextSeen)) ?? false;
      };
      // A second tuple waiter can block behind the first waiter, not directly
      // behind the controller. Require both actual waiters to reach our gate.
      if (waiting.length === count && waiting.every(row => reachesGate(row.pid))) return waiting;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    throw new Error('Expected owned assignment lock waiters were not observed');
  }

  it('serializes two first assignments through observed account-first waits, retaining one stable row and last-writer audit', async () => {
    const gate = await fixture.pool.connect(); const operations: Promise<any>[] = [];
    try {
      await gate.query('BEGIN'); const gatePid = await pid(gate);
      await gate.query('SELECT id FROM users WHERE id=1001 FOR NO KEY UPDATE');
      const first = settled(assign(12)); operations.push(first);
      const firstWaiter = await blockedBy(fixture.pool,gatePid);
      expect(firstWaiter.wait_event).not.toBe('advisory');
      const second = settled(assign(13)); operations.push(second);
      const waiting = await waiters(gatePid,2);
      expect(waiting.map(row => row.pid)).toContain(firstWaiter.pid);
      expect(new Set(waiting.map(row => row.pid)).size).toBe(2);
      expect(await rawAssignments(fixture.pool)).toEqual([]); expect(await rawEvents(fixture.pool)).toEqual([]);
      await gate.query('COMMIT');
      const [a,b] = await Promise.all([first,second]); if (a.error) throw a.error; if (b.error) throw b.error;
      expect(a.value.outcome).toBe('created'); expect(b.value.outcome).toBe('changed');
      expect(a.value.assignment.id).toBe(b.value.assignment.id);
      expect(await rawAssignments(fixture.pool)).toMatchObject([{ id: a.value.assignment.id, vaId: 13, taskId: 'card:list:item', founderId: 1001 }]);
      const events = await rawEvents(fixture.pool);
      expect(events).toHaveLength(2);
      expect(events).toMatchObject([
        { assignmentId: a.value.assignment.id, kind: 'created', previousWorkerProfileId: null, nextWorkerProfileId: 12 },
        { assignmentId: a.value.assignment.id, kind: 'reassigned', previousWorkerProfileId: 12, nextWorkerProfileId: 13 },
      ]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); await Promise.allSettled(operations); }
  });

  it('serializes concurrent reassignment of an existing stable ID and records the actual before/after chain', async () => {
    const original = await assign(12); const id = original.assignment.id;
    const gate = await fixture.pool.connect(); const operations: Promise<any>[] = [];
    try {
      await gate.query('BEGIN'); const gatePid = await pid(gate);
      await gate.query('SELECT id FROM users WHERE id=1001 FOR NO KEY UPDATE');
      const first = settled(reassignTask(fixture.db,founder,{ assignmentId: id,workerProfileId: 13 })); operations.push(first);
      const firstWaiter = await blockedBy(fixture.pool,gatePid);
      const second = settled(reassignTask(fixture.db,founder,{ assignmentId: id,workerProfileId: 12 })); operations.push(second);
      expect((await waiters(gatePid,2)).map(row => row.pid)).toContain(firstWaiter.pid);
      await gate.query('COMMIT');
      for (const result of await Promise.all([first,second])) { if (result.error) throw result.error; expect(result.value.assignment.id).toBe(id); }
      expect(await rawAssignments(fixture.pool)).toMatchObject([{ id,vaId: 12 }]);
      expect((await rawEvents(fixture.pool)).map(event => [event.kind,event.previousWorkerProfileId,event.nextWorkerProfileId])).toEqual([
        ['created',null,12],['reassigned',12,13],['reassigned',13,12],
      ]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); await Promise.allSettled(operations); }
  });

  it('fences requested child plus parent fallback absence against an administrator assigning that exact child to another worker', async () => {
    await assign(12,'card');
    const gate = await fixture.pool.connect(); let pending: Promise<any> | undefined;
    try {
      await gate.query('BEGIN'); const gatePid = await pid(gate);
      const rows = await readCanonicalAssignments(drizzle(gate,{ schema }),1001,['card:list:item','card'],{ lock: true });
      expect(rows.map(row => [row.taskId,row.vaId])).toEqual([['card',12]]);
      pending = settled(assign(13,'card:list:item'));
      expect((await blockedBy(fixture.pool,gatePid)).wait_event).toBe('advisory');
      // Test advisory key independence without issuing another same-founder
      // service mutation: the pending writer legitimately holds that account.
      expect(await fixture.db.transaction(tx => readCanonicalAssignment(tx,1001,'card:list:unrelated',{ lock: true }))).toBeNull();
      const foreign = await assignTask(fixture.db,{ id: 1004,role: 'admin' },{ taskId: 'card:list:item',workerProfileId: 14 });
      expect(foreign.outcome).toBe('created');
      expect((await fixture.pool.query('SELECT id FROM task_assignments WHERE "founderId"=1001 AND "taskId"=$1',['card:list:item'])).rows).toEqual([]);
      await gate.query('COMMIT'); const result = await pending; if (result.error) throw result.error;
      const after = await readCanonicalAssignments(fixture.db,1001,['card','card:list:item']);
      expect(after.map(row => [row.taskId,row.vaId])).toEqual([['card',12],['card:list:item',13]]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); if (pending) await pending; }
  });

  it.each([
    { label: 'actor role', query: "UPDATE users SET role='worker' WHERE id=1001", status: 403 },
    { label: 'target account role', query: "UPDATE users SET role='user' WHERE id=1002", status: 409 },
    { label: 'target offboarding', query: "UPDATE va_profiles SET status='inactive' WHERE id=12", status: 409 },
    { label: 'target profile account', query: 'UPDATE va_profiles SET "userId"=1003 WHERE id=12', status: 409 },
    { label: 'target profile founder', query: 'UPDATE va_profiles SET "founderId"=1004 WHERE id=12', status: 409 },
  ])('rechecks $label after its real row-lock wait and writes no assignment/audit', async ({ query,status }) => {
    const gate = await fixture.pool.connect(); let pending: Promise<any> | undefined;
    try {
      await gate.query('BEGIN'); const gatePid = await pid(gate); await gate.query(query);
      pending = settled(assign()); await blockedBy(fixture.pool,gatePid);
      await gate.query('COMMIT'); expect((await pending).error).toMatchObject({ status });
      expect(await rawAssignments(fixture.pool)).toEqual([]); expect(await rawEvents(fixture.pool)).toEqual([]);
    } finally { await gate.query('ROLLBACK'); gate.release(true); if (pending) await pending; }
  });

  it('permits reassignment away from a historically inactive source while preserving operational fields and history identity', async () => {
    const created = await assign(); const id = created.assignment.id;
    await fixture.pool.query(`UPDATE task_assignments SET status='in_progress',"startTime"='2026-10-01 09:00:00',
      "endTime"='2026-10-01 10:00:00',notes='Original note',"handoffNotes"='Original handoff',
      "lastWorkedAt"='2026-10-01 09:50:00',"decisionLog"='[{"decision":"retained"}]',"externalLinks"='["https://example.invalid/record"]' WHERE id=$1`,[id]);
    await fixture.pool.query(`INSERT INTO task_schedule_history (id,"taskId","founderId","assignmentId","changedBy",reason)
      VALUES ('stable-history','card:list:item',1001,$1,'assignment-founder','Preserved historical schedule')`,[id]);
    const history = (await fixture.pool.query('SELECT to_jsonb(h) AS row FROM task_schedule_history h')).rows;
    const [before] = await rawAssignments(fixture.pool);
    await fixture.pool.query("UPDATE va_profiles SET status='inactive' WHERE id=12");
    const changed = await reassignTask(fixture.db,founder,{ assignmentId: id,workerProfileId: 13 });
    expect(changed.assignment.id).toBe(id);
    const [after] = await rawAssignments(fixture.pool);
    for (const key of ['taskId','founderId','createdAt','status','startTime','endTime','notes','handoffNotes','lastWorkedAt','decisionLog','externalLinks']) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.vaId).toBe(13);
    expect((await fixture.pool.query('SELECT to_jsonb(h) AS row FROM task_schedule_history h')).rows).toEqual(history);
    const events = await rawEvents(fixture.pool); expect(events.at(-1)).toMatchObject({ assignmentId: id,kind: 'reassigned',previousWorkerProfileId: 12,nextWorkerProfileId: 13 });
    await expect(fixture.pool.query('DELETE FROM task_assignments WHERE id=$1',[id])).rejects.toMatchObject({ code: '23001',constraint: 'assignment_events_assignmentId_task_assignments_id_fk' });
  });

  it('does not change timestamps or append audit for repeated identical assign/reassign/status operations', async () => {
    const created = await assign(); const before = await rawAssignments(fixture.pool); const audit = await rawEvents(fixture.pool);
    expect((await assign()).outcome).toBe('unchanged');
    expect((await reassignTask(fixture.db,founder,{ assignmentId: created.assignment.id,workerProfileId: 12 })).outcome).toBe('unchanged');
    expect((await changeAssignmentStatus(fixture.db,founder,{ taskId: 'card:list:item',status: 'assigned' })).outcome).toBe('unchanged');
    expect(await rawAssignments(fixture.pool)).toEqual(before); expect(await rawEvents(fixture.pool)).toEqual(audit);
  });

  it.each(['America/New_York','Asia/Kolkata'])('preserves exact UTC timestamps, audit JSON, idempotence and history on session timezone %s', async timezone => {
    const client = await fixture.pool.connect();
    const initial = new Date('2026-11-01T06:30:00.123Z'); // The repeated New York DST hour.
    const reassignedAt = new Date('2026-11-01T06:31:00.456Z');
    const statusAt = new Date('2026-11-01T06:32:00.789Z');
    try {
      await client.query("SELECT set_config('TimeZone',$1,false)",[timezone]);
      expect((await client.query('SHOW TimeZone')).rows[0].TimeZone).toBe(timezone);
      const localDb = drizzle(client,{ schema });
      const beforeClock = (await fixture.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(initial);
      const created = await assignTask(localDb,founder,{ taskId: 'utc:full:task',workerProfileId: 12 });
      const id = created.assignment.id;
      for (const key of ['assignedAt','createdAt','updatedAt'] as const) expect(created.assignment[key].toISOString()).toBe(initial.toISOString());
      const rawUtc = (await fixture.pool.query(`SELECT
        to_char("assignedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS assigned,
        to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created,
        to_char("updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated FROM task_assignments WHERE id=$1`,[id])).rows[0];
      expect(rawUtc).toEqual({ assigned: initial.toISOString(),created: initial.toISOString(),updated: initial.toISOString() });
      const [createdEvent] = await localDb.select().from(schema.assignmentEvents);
      expect(createdEvent.afterJson).toMatchObject({ id,assignedAt: initial.toISOString(),createdAt: initial.toISOString(),updatedAt: initial.toISOString() });
      const rawEvent = (await fixture.pool.query('SELECT "createdAt" FROM assignment_events WHERE id=$1',[createdEvent.id])).rows[0];
      // Audit time is the actual DB transaction instant, not the frozen app clock.
      expect(createdEvent.createdAt.toISOString()).toBe(rawEvent.createdAt.toISOString());
      expect(createdEvent.createdAt.getTime()).toBeGreaterThanOrEqual(beforeClock.getTime());
      const afterClock = (await fixture.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      expect(createdEvent.createdAt.getTime()).toBeLessThanOrEqual(afterClock.getTime());

      await fixture.pool.query(`INSERT INTO task_schedule_history (id,"taskId","founderId","assignmentId","changedBy",
        "previousStartTime","newStartTime",reason) VALUES ('utc-history','utc:full:task',1001,$1,'assignment-founder',
        '2026-11-01 05:30:00.654321','2026-11-01 06:30:00.123456','Retained precise UTC history')`,[id]);
      const history = (await fixture.pool.query('SELECT to_jsonb(h) AS row FROM task_schedule_history h')).rows;
      vi.setSystemTime(reassignedAt);
      const reassigned = await reassignTask(localDb,founder,{ assignmentId: id,workerProfileId: 13 });
      expect(reassigned.assignment).toMatchObject({ id,createdAt: initial,assignedAt: reassignedAt,updatedAt: reassignedAt });
      vi.setSystemTime(statusAt);
      const changed = await changeAssignmentStatus(localDb,founder,{ taskId: 'utc:full:task',status: 'in_progress' });
      expect(changed.assignment).toMatchObject({ id,createdAt: initial,assignedAt: reassignedAt,updatedAt: statusAt });
      const events = await rawEvents(fixture.pool);
      expect(events.map(event => event.kind)).toEqual(['created','reassigned','status_changed']);
      expect(events[1].beforeJson).toMatchObject({ assignedAt: initial.toISOString(),createdAt: initial.toISOString(),updatedAt: initial.toISOString() });
      expect(events[1].afterJson).toMatchObject({ assignedAt: reassignedAt.toISOString(),createdAt: initial.toISOString(),updatedAt: reassignedAt.toISOString() });
      expect(events[2].afterJson).toMatchObject({ assignedAt: reassignedAt.toISOString(),createdAt: initial.toISOString(),updatedAt: statusAt.toISOString() });
      const beforeReplay = await rawAssignments(fixture.pool);
      vi.setSystemTime(new Date('2026-11-01T07:30:00.999Z'));
      expect((await assignTask(localDb,founder,{ taskId: 'utc:full:task',workerProfileId: 13 })).outcome).toBe('unchanged');
      expect((await reassignTask(localDb,founder,{ assignmentId: id,workerProfileId: 13 })).outcome).toBe('unchanged');
      expect((await changeAssignmentStatus(localDb,founder,{ taskId: 'utc:full:task',status: 'in_progress' })).outcome).toBe('unchanged');
      expect(await rawAssignments(fixture.pool)).toEqual(beforeReplay); expect(await rawEvents(fixture.pool)).toEqual(events);
      expect((await fixture.pool.query('SELECT to_jsonb(h) AS row FROM task_schedule_history h')).rows).toEqual(history);
    } finally {
      vi.useRealTimers();
      try { await client.query('RESET TimeZone'); } finally { client.release(true); }
    }
  });

  it('changes exact full-key batch statuses without touching a parent, sibling, other worker or founder', async () => {
    for (const taskId of ['card','card:list:item','card:list:other']) await assign(12,taskId);
    await assign(13,'other-worker');
    await assignTask(fixture.db,{ id: 1004,role: 'admin' },{ taskId: 'card:list:item',workerProfileId: 14 });
    const result = await changeAssignmentStatuses(fixture.db,{ id: 1002,role: 'worker' },{ taskIds: ['card:list:other','card:list:item'],status: 'completed' });
    expect(result.map(row => row.assignment.taskId)).toEqual(['card:list:item','card:list:other']);
    expect((await rawAssignments(fixture.pool)).filter(row => row.status === 'completed').map(row => [row.founderId,row.taskId])).toEqual([
      [1001,'card:list:item'],[1001,'card:list:other'],
    ]);
    expect((await rawEvents(fixture.pool)).filter(event => event.kind === 'status_changed')).toMatchObject([
      { taskId: 'card:list:item',actorUserId: 1002,previousStatus: 'assigned',nextStatus: 'completed' },
      { taskId: 'card:list:other',actorUserId: 1002,previousStatus: 'assigned',nextStatus: 'completed' },
    ]);
  });

  it.each(['create','reassign','status','batch'] as const)('rolls back actual %s mutations when PostgreSQL rejects the audit insert', async action => {
    if (action !== 'create') { await assign(); if (action === 'batch') await assign(12,'second-task'); }
    const before = await rawAssignments(fixture.pool); const audit = await rawEvents(fixture.pool);
    try {
      await fixture.pool.query(`CREATE FUNCTION reject_assignment_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${action === 'batch' ? 'NEW."taskId"=\'second-task\'' : 'true'} THEN
          RAISE EXCEPTION 'Synthetic assignment audit rejection' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$`);
      await fixture.pool.query('CREATE TRIGGER reject_assignment_audit BEFORE INSERT ON assignment_events FOR EACH ROW EXECUTE FUNCTION reject_assignment_audit()');
      const operation = action === 'create' ? assign()
        : action === 'reassign' ? reassignTask(fixture.db,founder,{ assignmentId: before[0].id,workerProfileId: 13 })
          : action === 'batch' ? changeAssignmentStatuses(fixture.db,founder,{ taskIds: ['second-task','card:list:item'],status: 'blocked' })
            : changeAssignmentStatus(fixture.db,founder,{ taskId: 'card:list:item',status: 'in_progress' });
      await expect(operation).rejects.toMatchObject({ cause: { code: '23514',message: 'Synthetic assignment audit rejection' } });
      expect(await rawAssignments(fixture.pool)).toEqual(before); expect(await rawEvents(fixture.pool)).toEqual(audit);
    } finally {
      await fixture.pool.query('DROP TRIGGER IF EXISTS reject_assignment_audit ON assignment_events');
      await fixture.pool.query('DROP FUNCTION IF EXISTS reject_assignment_audit()');
    }
  });

  it('enforces founder/full-task uniqueness while retaining distinct tenants, cards and composite keys', async () => {
    const insert = (taskId: string, founderId = 1001, vaId = 12) => fixture.pool.query(`INSERT INTO task_assignments
      ("taskId","founderId","vaId","assignedBy") VALUES ($1,$2,$3,$2) RETURNING id`, [taskId,founderId,vaId]);
    await insert('card');
    await expect(insert('card',1001,13)).rejects.toMatchObject({ code: '23505', constraint: 'task_assignments_founder_task_unique' });
    await insert('card',1004,14); await insert('other-card'); await insert('card:list:item'); await insert('card:list:other');
    expect(await rawAssignments(fixture.pool)).toHaveLength(5);
    expect((await readCanonicalAssignment(fixture.db,1001,'card'))?.vaId).toBe(12);
    expect((await readCanonicalAssignment(fixture.db,1004,'card'))?.vaId).toBe(14);
    expect((await readCanonicalAssignments(fixture.db,1001,['card:list:item','card'])).map(row => row.taskId)).toEqual(['card','card:list:item']);
  });
});

describe.skipIf(!baseUrl)('canonical assignment migration refuses ambiguous legacy identity', { timeout: 30000 }, () => {
  it('aborts 0008 without choosing a worker/status or changing assignments, schedule history or ledger', async () => {
    const fixture = await createAssignmentDatabase(baseUrl, 7);
    try {
      await seed(fixture.pool);
      await fixture.pool.query(`INSERT INTO task_assignments (id,"taskId","founderId","vaId","assignedBy",status,notes)
        VALUES (71,'legacy-card:list:item',1001,12,1001,'in_progress','First preserved'),
        (72,'legacy-card:list:item',1001,13,1001,'completed','Second preserved')`);
      await fixture.pool.query(`INSERT INTO task_schedule_history (id,"taskId","founderId","assignmentId","changedBy",reason)
        VALUES ('legacy-history-71','legacy-card:list:item',1001,71,'assignment-founder','Original first'),
        ('legacy-history-72','legacy-card:list:item',1001,72,'assignment-founder','Original second')`);
      const snapshot = async () => ({ assignments: await rawAssignments(fixture.pool),
        history: (await fixture.pool.query('SELECT to_jsonb(h) AS row FROM task_schedule_history h ORDER BY id')).rows,
        ledger: (await fixture.pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows });
      const before = await snapshot();
      await expect(readCanonicalAssignment(fixture.db,1001,'legacy-card:list:item')).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_DUPLICATE' });
      const taskId = 'legacy-card:list:item';
      await expect(assignTask(fixture.db,founder,{ taskId,workerProfileId: 12 })).rejects.toMatchObject({ status: 409,code: 'ASSIGNMENT_DUPLICATE' });
      await expect(changeAssignmentStatus(fixture.db,founder,{ taskId,status: 'blocked' })).rejects.toMatchObject({ status: 409,code: 'ASSIGNMENT_DUPLICATE' });
      await expect(changeAssignmentStatuses(fixture.db,founder,{ taskIds: [taskId],status: 'completed' })).rejects.toMatchObject({ status: 409,code: 'ASSIGNMENT_DUPLICATE' });
      let callbackCalls = 0;
      await expect(withLockedAssignment(fixture.db,founder,taskId,async () => { callbackCalls++; }))
        .rejects.toMatchObject({ status: 409,code: 'ASSIGNMENT_DUPLICATE' });
      expect(callbackCalls).toBe(0); expect(await snapshot()).toEqual(before);
      await expect(fixture.migrateLatest()).rejects.toMatchObject({ cause: { code: '23505',
        message: 'Duplicate task assignments require explicit operator review; no assignment or history rows were changed' } });
      expect(await snapshot()).toEqual(before);
      expect((await fixture.pool.query(`SELECT to_regclass('public.assignment_events') AS name`)).rows[0].name).toBeNull();
      expect((await fixture.pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='task_assignments'::regclass
        AND conname='task_assignments_founder_task_unique'`)).rows).toEqual([]);
    } finally { await fixture.close(); }
  }, 120000);
});
