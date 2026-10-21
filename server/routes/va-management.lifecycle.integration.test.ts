import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { Pool, escapeIdentifier } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../../shared/isolatedPostgresTestDatabase.mjs';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../services/websocket', () => ({ websocketService: { emitToUser: vi.fn() } }));
import router from './va-management';
import { acceptWorkerInvitation, createWorkerInvitation } from '../workerInvitations';
import { withSessionIdentity } from '../sessionLifecycle';

const fixtureUrl = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!fixtureUrl)('VA lifecycle native PostgreSQL transactions', () => {
  const name = `worker_lifecycle_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let created = false;
  let actorId: number;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: actorId, openId: 'synthetic-founder', role: 'admin' };
    next();
  });
  app.use('/api/va', router);

  beforeAll(async () => {
    const base = new URL(requireIsolatedPostgresTestDatabase(fixtureUrl, process.env.NODE_ENV === 'production'));
    if (!/^worker_lifecycle_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe fixture name');
    admin = new Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    created = true;
    base.pathname = `/${name}`;
    pool = new Pool({ connectionString: base.href, max: 6, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=10000 -c lock_timeout=5000' });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle-postgres-v1') });
    mocks.getDb.mockResolvedValue(db);
  }, 60000);

  beforeEach(async () => {
    await pool.query('TRUNCATE worker_lifecycle_audit, worker_invitations, time_entries, va_profiles, users RESTART IDENTITY CASCADE');
    actorId = (await pool.query(`INSERT INTO users ("openId", role) VALUES ('synthetic-founder','admin') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE ${escapeIdentifier(name)}`);
    if (admin) await admin.end();
  });

  async function createWorker(email = 'synthetic-worker@example.test') {
    const response = await request(app).post('/api/va/vas').send({ name: 'Synthetic worker', email, password: 'synthetic-test-password' });
    expect(response.status).toBe(200);
    const profile = (await pool.query('SELECT * FROM va_profiles WHERE id=$1', [response.body.id])).rows[0];
    const account = (await pool.query('SELECT * FROM users WHERE id=$1', [profile.userId])).rows[0];
    return { profile, account };
  }

  it('rolls back a new credential when profile insertion fails', async () => {
    await pool.query(`ALTER TABLE va_profiles ADD CONSTRAINT injected_profile_failure CHECK (name <> 'Fail')`);
    try {
      const response = await request(app).post('/api/va/vas').send({ name: 'Fail', email: 'failed@example.test', password: 'synthetic-test-password' });
      expect(response.status).toBe(500);
      expect((await pool.query(`SELECT id FROM users WHERE "openId"='failed@example.test'`)).rows).toEqual([]);
      expect((await pool.query('SELECT id FROM worker_lifecycle_audit')).rows).toEqual([]);
    } finally { await pool.query('ALTER TABLE va_profiles DROP CONSTRAINT injected_profile_failure'); }
  });

  it('does not partially change a password on email collision', async () => {
    const { profile, account } = await createWorker();
    await createWorker('taken@example.test');
    const response = await request(app).put(`/api/va/vas/${profile.id}`).send({ email: 'taken@example.test', password: 'different-test-password' });
    expect(response.status).toBe(409);
    expect((await pool.query('SELECT * FROM users WHERE id=$1', [account.id])).rows[0]).toEqual(account);
    expect((await pool.query('SELECT * FROM va_profiles WHERE id=$1', [profile.id])).rows[0]).toEqual(profile);
  });

  it('rolls back credentials, status, epoch and invitation revocation when audit insertion fails', async () => {
    const { profile, account } = await createWorker();
    await pool.query(`INSERT INTO worker_invitations ("userId","vaId","founderId",email,"tokenHash","expiresAt") VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`,
      [account.id, profile.id, actorId, profile.email, 'a'.repeat(64)]);
    await pool.query(`ALTER TABLE worker_lifecycle_audit ADD CONSTRAINT injected_audit_failure CHECK (action='create')`);
    try {
      expect((await request(app).put(`/api/va/vas/${profile.id}`).send({ password: 'changed-test-password', status: 'inactive' })).status).toBe(500);
      expect((await pool.query('SELECT * FROM users WHERE id=$1', [account.id])).rows[0]).toEqual(account);
      expect((await pool.query('SELECT * FROM va_profiles WHERE id=$1', [profile.id])).rows[0]).toEqual(profile);
      expect((await pool.query('SELECT "revokedAt" FROM worker_invitations')).rows).toEqual([{ revokedAt: null }]);
      expect((await pool.query('SELECT action FROM worker_lifecycle_audit')).rows).toEqual([{ action: 'create' }]);
    } finally { await pool.query('ALTER TABLE worker_lifecycle_audit DROP CONSTRAINT injected_audit_failure'); }
  });

  it('coalesces no credentials on concurrent duplicate creates: one pair and one audit only', async () => {
    const responses = await Promise.all([0, 1].map(() => request(app).post('/api/va/vas').send({
      name: 'Synthetic worker', email: 'concurrent@example.test', password: 'synthetic-test-password',
    })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await pool.query('SELECT count(*)::int AS n FROM va_profiles')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM users WHERE role=\'worker\'')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM worker_lifecycle_audit')).rows[0].n).toBe(1);
  });

  it('rechecks the worker role after waiting for the account lock', async () => {
    const { profile, account } = await createWorker();
    const blocker = await pool.connect();
    let response: Promise<any> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [account.id]);
      response = request(app).put(`/api/va/vas/${profile.id}`).send({ name: 'Must not change' }).then(result => result);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`);
        if (result.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query(`UPDATE users SET role='admin' WHERE id=$1`, [account.id]);
      await blocker.query('COMMIT');
      expect((await response).status).toBe(409);
      expect((await pool.query('SELECT name FROM va_profiles WHERE id=$1', [profile.id])).rows[0].name).toBe(profile.name);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (response) await response;
    }
  });

  it('soft-offboards without deleting time history', async () => {
    const { profile, account } = await createWorker();
    await pool.query(`INSERT INTO time_entries ("taskId","trackedUserId","trackedProfileId","founderId","startTime","endTime","durationMinutes") VALUES ('synthetic-task',$1,$2,$3,now()-interval '45 minutes',now(),45)`, [account.id, profile.id, actorId]);
    expect((await request(app).delete(`/api/va/vas/${profile.id}`)).status).toBe(200);
    expect((await pool.query('SELECT status FROM va_profiles WHERE id=$1', [profile.id])).rows[0].status).toBe('inactive');
    expect((await pool.query('SELECT "durationMinutes" FROM time_entries')).rows).toEqual([{ durationMinutes: 45 }]);
    const current = (await pool.query('SELECT "sessionEpoch" FROM users WHERE id=$1', [account.id])).rows[0];
    expect(BigInt(current.sessionEpoch)).toBeGreaterThan(BigInt(account.sessionEpoch));
    expect((await pool.query(`SELECT action,"previousStatus","nextStatus" FROM worker_lifecycle_audit ORDER BY id DESC LIMIT 1`)).rows[0])
      .toEqual({ action: 'offboard', previousStatus: 'active', nextStatus: 'inactive' });
  });

  it.each(['inactive', 'on_leave'])('PUT %s cancels an old invitation even when status was already unchanged', async status => {
    const { profile, account } = await createWorker();
    await pool.query('UPDATE va_profiles SET status=$1 WHERE id=$2', [status, profile.id]);
    await pool.query('UPDATE users SET "passwordHash"=NULL WHERE id=$1', [account.id]);
    const token = randomUUID();
    await pool.query(`INSERT INTO worker_invitations ("userId","vaId","founderId",email,"tokenHash","expiresAt") VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`,
      [account.id, profile.id, actorId, profile.email, createHash('sha256').update(token).digest('hex')]);
    expect((await request(app).put(`/api/va/vas/${profile.id}`).send({ status })).status).toBe(200);
    expect((await pool.query('SELECT "revokedAt" FROM worker_invitations')).rows[0].revokedAt).toBeInstanceOf(Date);
    await expect(acceptWorkerInvitation(token, 'synthetic-accept-password')).rejects.toMatchObject({ code: 'invalid' });
    expect((await pool.query('SELECT status FROM va_profiles WHERE id=$1', [profile.id])).rows[0].status).toBe(status);
    expect((await pool.query('SELECT "passwordHash" FROM users WHERE id=$1', [account.id])).rows[0].passwordHash).toBeNull();
  });

  it.each(['acceptance', 'offboarding'] as const)(
    '%s wins the account lock against concurrent invitation acceptance/offboarding without restoring access',
    async winner => {
      const invitation = await createWorkerInvitation(actorId, {
        name: 'Synthetic race invitee', email: 'race-invitee@example.test',
      });
      const accountBefore = (await pool.query('SELECT * FROM users WHERE id=$1', [invitation.userId])).rows[0];
      expect(accountBefore.passwordHash).toBeNull();
      await pool.query(`INSERT INTO time_entries ("taskId","trackedUserId","trackedProfileId","founderId","startTime","endTime","durationMinutes")
        VALUES ('synthetic-race-history',$1,$2,$3,now()-interval '45 minutes',now(),45)`, [invitation.userId, invitation.vaId, actorId]);
      const historyBefore = (await pool.query('SELECT * FROM time_entries ORDER BY id')).rows;

      const suffix = randomUUID().replaceAll('-', '');
      const functionName = escapeIdentifier(`lifecycle_race_gate_${suffix}`);
      const triggerName = escapeIdentifier(`lifecycle_race_gate_${suffix}`);
      const gateKey = Number.parseInt(suffix.slice(0, 7), 16);
      const gateNamespace = 710021;
      const controller = await pool.connect();
      const operations: Promise<unknown>[] = [];
      // Attach rejection handlers immediately: losing acceptance must not create
      // an unhandled rejection while the test observes PostgreSQL's lock graph.
      const outcome = <T,>(operation: Promise<T>) => operation.then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }),
      );
      const startAcceptance = () => outcome(acceptWorkerInvitation(invitation.token, 'synthetic-race-password'));
      const startOffboarding = () => outcome(request(app).delete(`/api/va/vas/${invitation.vaId}`).then(response => response));
      type Acceptance = Awaited<ReturnType<typeof startAcceptance>>;
      type Offboarding = Awaited<ReturnType<typeof startOffboarding>>;
      let acceptance: Promise<Acceptance>;
      let offboarding: Promise<Offboarding>;

      // Poll actual blocking relationships, not elapsed time or operation mocks.
      const observeBlockedBackend = async (blockerPid: number, expectedQuery: RegExp) => {
        const deadline = performance.now() + 4000;
        while (performance.now() < deadline) {
          const blocked = await pool.query<{ pid: number; query: string }>(`
            SELECT pid, query FROM pg_stat_activity
            WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`, [blockerPid]);
          const match = blocked.rows.find(row => expectedQuery.test(row.query));
          if (match) return match.pid;
        }
        throw new Error('Expected lifecycle transaction did not appear in the PostgreSQL blocking graph');
      };

      try {
        const controllerPid = (await controller.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await controller.query('SELECT pg_advisory_lock($1::integer,$2::integer)', [gateNamespace, gateKey]);
        // The real functions reach their audit insert only after locking the
        // account and applying their lifecycle writes in the same transaction.
        await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW."userId"=TG_ARGV[0]::integer AND NEW.action=TG_ARGV[1] THEN
              PERFORM set_config('lock_timeout','10s',true);
              PERFORM pg_advisory_xact_lock(710021,TG_ARGV[2]::integer);
            END IF;
            RETURN NEW;
          END;
        $$`);
        await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON worker_lifecycle_audit
          FOR EACH ROW EXECUTE FUNCTION ${functionName}('${invitation.userId}',
            '${winner === 'acceptance' ? 'reactivate' : 'offboard'}','${gateKey}')`);

        const first = winner === 'acceptance' ? startAcceptance() : startOffboarding();
        operations.push(first);
        const winnerPid = await observeBlockedBackend(controllerPid, /insert into "worker_lifecycle_audit"/i);
        const second = winner === 'acceptance' ? startOffboarding() : startAcceptance();
        operations.push(second);
        // pg_stat_activity can truncate long joined SELECTs before FOR UPDATE;
        // identify the real account query and prove its blocker by PID instead.
        const loserPid = await observeBlockedBackend(winnerPid, /select\b[\s\S]*\busers\b/i);
        expect(loserPid).not.toBe(winnerPid);
        // The contender is genuinely in flight, blocked by the account-lock
        // owner, which is itself blocked by this test's advisory gate.
        expect((await pool.query('SELECT pg_blocking_pids($1::integer) AS blockers', [loserPid])).rows[0].blockers)
          .toContain(winnerPid);
        expect((await pool.query('SELECT pg_blocking_pids($1::integer) AS blockers', [winnerPid])).rows[0].blockers)
          .toContain(controllerPid);
        await controller.query('SELECT pg_advisory_unlock($1::integer,$2::integer)', [gateNamespace, gateKey]);

        acceptance = (winner === 'acceptance' ? first : second) as Promise<Acceptance>;
        offboarding = (winner === 'offboarding' ? first : second) as Promise<Offboarding>;
        const [accepted, offboarded] = await Promise.all([acceptance, offboarding]);
        expect(offboarded.ok).toBe(true);
        if (!offboarded.ok) throw offboarded.error;
        expect(offboarded.value.status).toBe(200);
        const accountAfter = (await pool.query('SELECT * FROM users WHERE id=$1', [invitation.userId])).rows[0];
        expect((await pool.query('SELECT status FROM va_profiles WHERE id=$1', [invitation.vaId])).rows[0].status).toBe('inactive');
        expect((await pool.query('SELECT * FROM time_entries ORDER BY id')).rows).toEqual(historyBefore);
        const storedInvitation = (await pool.query('SELECT "acceptedAt","revokedAt" FROM worker_invitations WHERE id=$1', [invitation.invitationId])).rows[0];
        const audit = (await pool.query(`SELECT action,"actorUserId","previousStatus","nextStatus"
          FROM worker_lifecycle_audit WHERE "userId"=$1 ORDER BY id`, [invitation.userId])).rows;
        const allowedAction = vi.fn(async () => true);

        if (winner === 'acceptance') {
          expect(accepted.ok).toBe(true);
          if (!accepted.ok) throw accepted.error;
          expect(storedInvitation).toEqual({ acceptedAt: expect.any(Date), revokedAt: null });
          expect(accountAfter.passwordHash).toEqual(expect.any(String));
          expect(BigInt(accountAfter.sessionEpoch)).toBeGreaterThan(BigInt(accepted.value.sessionEpoch));
          expect(audit).toEqual([
            { action: 'create', actorUserId: actorId, previousStatus: null, nextStatus: 'inactive' },
            { action: 'reactivate', actorUserId: invitation.userId, previousStatus: 'inactive', nextStatus: 'active' },
            { action: 'offboard', actorUserId: actorId, previousStatus: 'active', nextStatus: 'inactive' },
          ]);
          await expect(withSessionIdentity(invitation.email, accepted.value, allowedAction)).rejects.toMatchObject({ statusCode: 403 });
        } else {
          expect(accepted.ok).toBe(false);
          if (accepted.ok) throw new Error('Cancelled invitation unexpectedly activated a worker');
          // A stale join may reach the invitation CAS after the lock wait;
          // either rejection code must leave all activation writes rolled back.
          expect(['invalid', 'used']).toContain(accepted.error.code);
          expect(storedInvitation).toEqual({ acceptedAt: null, revokedAt: expect.any(Date) });
          expect(accountAfter).toEqual(accountBefore);
          expect(audit).toEqual([
            { action: 'create', actorUserId: actorId, previousStatus: null, nextStatus: 'inactive' },
            { action: 'offboard', actorUserId: actorId, previousStatus: 'inactive', nextStatus: 'inactive' },
          ]);
        }
        // Even a fresh proof cannot bypass the inactive-profile access gate.
        await expect(withSessionIdentity(invitation.email, undefined, allowedAction)).rejects.toMatchObject({ statusCode: 403 });
        expect(allowedAction).not.toHaveBeenCalled();
      } finally {
        try {
          await controller.query('SELECT pg_advisory_unlock($1::integer,$2::integer)', [gateNamespace, gateKey]);
        } finally {
          controller.release(true);
          await Promise.allSettled(operations);
          try { await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON worker_lifecycle_audit`); }
          finally { await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`); }
        }
      }
    }, 20000,
  );
});
