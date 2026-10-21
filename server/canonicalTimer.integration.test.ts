import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool, escapeIdentifier } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../shared/isolatedPostgresTestDatabase.mjs';
import { hasRequiredPostgresSchema } from './db/readiness';

const controls = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./db', () => ({ getDb: controls.getDb }));
vi.mock('./aptlssManagerPilot', () => ({ isManagerPilotWorker: () => false }));
vi.mock('./services/websocket', () => ({ websocketService: { emitToUser: vi.fn() } }));
import timeRoutes from './routes/time-tracking';
import vaRoutes from './routes/va-management';
import { timerRouter } from './routes/manus';
import { closeCanonicalTimer } from './canonicalTimer';
import { resolveAndCloseLegacyTimer, resolveTimerIdentity, timerIdentityReviewReport } from './timerIdentityReview';
import { recordedSeconds } from '../shared/timerDuration';

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)('canonical timer full-migration PostgreSQL acceptance', { timeout: 25000 }, () => {
  const token = randomUUID().replaceAll('-', '');
  const databaseName = `canonical_timer_${token}`;
  const roleName = `timer_dml_${token}`;
  const canonical = path.resolve(import.meta.dirname, '../drizzle-postgres-v1');
  let administrator: Pool;
  let pool: Pool;
  let connectionString: string;
  let directory: string;
  let created = false;
  let latestApplied = false;
  let roleCreated = false;
  const founder = { id: 1001, role: 'admin', openId: 'synthetic-founder' } as schema.User;
  const worker = { id: 1002, role: 'worker', openId: 'synthetic-worker' } as schema.User;
  const profileId = 12;
  const appFor = (actor: schema.User) => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = actor; next(); });
    app.use('/api', timeRoutes); app.use('/api/va', vaRoutes); return app;
  };
  const db = () => drizzle(pool, { schema });
  const context = () => ({ user: worker, req: {} as any, res: {} as any });

  beforeAll(async () => {
    const base = new URL(requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === 'production'));
    if (!/^canonical_timer_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Invalid owned fixture database');
    administrator = new Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
    created = true;
    try { await administrator.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`); }
    catch (error) { if ((error as { code?: string }).code === '42P04') created = false; throw error; }
    base.pathname = `/${databaseName}`; connectionString = base.href;
    pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=15000 -c lock_timeout=10000' });
    directory = await mkdtemp(path.join(tmpdir(), 'canonical-timer-migration-'));
    await mkdir(path.join(directory, 'meta'));
    const journal = JSON.parse(await readFile(path.join(canonical, 'meta/_journal.json'), 'utf8'));
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 7);
    await writeFile(path.join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) await copyFile(path.join(canonical, `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
    await migrate(db(), { migrationsFolder: directory });
    controls.getDb.mockImplementation(async () => db());
  }, 90000);

  async function seed() {
    await pool.query(`INSERT INTO users (id,"openId",role) VALUES
      (1001,'synthetic-founder','admin'),(1002,'synthetic-worker','worker'),
      (1003,'synthetic-other-worker','worker'),(1004,'synthetic-other-founder','admin')`);
    await pool.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status) VALUES
      (12,1002,1001,'Synthetic worker','active'),(13,1003,1001,'Other worker','active')`);
    for (const card of ['card-a', 'card-b']) {
      await pool.query(`INSERT INTO task_assignments ("taskId","vaId","founderId","assignedBy") VALUES ($1,12,1001,1001)`, [card]);
      await pool.query(`INSERT INTO aptlss_plans ("vaId","cardId","cardName","cardUrl","planJson") VALUES (1002,$1,$1,'https://example.invalid','{}')`, [card]);
    }
  }
  beforeEach(async () => {
    if (!latestApplied) return;
    await pool.query('TRUNCATE payment_cycles,weekly_pay_log,time_day_reviews,user_working_hours,time_entry_events,time_entries,task_assignments,aptlss_plans,va_profiles,users RESTART IDENTITY CASCADE');
    await seed();
  });
  afterAll(async () => {
    try {
      if (roleCreated) { await pool.query(`DROP OWNED BY ${escapeIdentifier(roleName)}`); await pool.query(`DROP ROLE ${escapeIdentifier(roleName)}`); }
    } finally {
      try { if (pool) await pool.end(); if (created) await administrator.query(`DROP DATABASE ${escapeIdentifier(databaseName)}`); }
      finally { if (administrator) await administrator.end(); if (directory) await rm(directory, { recursive: true, force: true }); }
    }
  });

  it('preserves ambiguous self/colliding/profile/orphan/founder-change/duplicate-open legacy rows without assigning owners', async () => {
    await seed();
    await pool.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status) VALUES (1002,1003,1001,'Colliding profile','inactive'),(14,1002,1004,'Historical profile','inactive')`);
    for (const [id, legacy, tenant, stopped] of [[1,1001,1001,true],[2,1002,1001,false],[3,12,1001,false],
      [4,9999,1001,true],[5,14,1004,true],[6,1002,1001,false],[7,12,1001,false]]) {
      await pool.query(`INSERT INTO time_entries (id,"taskId","vaId","founderId","startTime","endTime","durationMinutes",notes)
        VALUES ($1,'synthetic-legacy',$2,$3,'2026-10-01 09:00:00',$4,37,'preserved fixture')`,
      [id, legacy, tenant, stopped ? new Date('2026-10-01T09:37:00Z') : null]);
    }
    const before = (await pool.query('SELECT * FROM time_entries ORDER BY id')).rows;
    await migrate(db(), { migrationsFolder: canonical }); latestApplied = true;
    const after = (await pool.query('SELECT * FROM time_entries ORDER BY id')).rows;
    expect(after.map(({ trackedUserId, trackedProfileId, ...original }) => original)).toEqual(before);
    expect(after.every(row => row.trackedUserId === null && row.trackedProfileId === null)).toBe(true);
    expect(await hasRequiredPostgresSchema(pool)).toBe(false);
    expect(await timerIdentityReviewReport(db())).toMatchObject({ ready: false, unresolvedEntryCount: 7 });
    await migrate(db(), { migrationsFolder: canonical });
    expect((await pool.query('SELECT * FROM time_entries ORDER BY id')).rows).toEqual(after);
  });

  type Writer = 'rest' | 'manus' | 'founder';
  async function start(writer: Writer, cardId = 'card-a') {
    if (writer === 'rest') { const r = await request(appFor(worker)).post('/api/time-tracking/start').send({ taskId: cardId }); return { status: r.status, body: r.body }; }
    if (writer === 'founder') { const r = await request(appFor(founder)).post('/api/va/time-entries/start').send({ vaId: profileId, taskId: cardId }); return { status: r.status, body: r.body }; }
    try { const result = await timerRouter.createCaller(context()).start({ cardId, cardName: cardId, cardUrl: 'https://example.invalid' }); return { status: 200, body: result }; }
    catch (error) { if ((error as any).code === 'CONFLICT') return { status: 409, body: error }; throw error; }
  }
  async function waitBlockedBy(pid: number) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const rows = await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`, [pid]);
      if (rows.rows.length === 1) return rows.rows[0].pid;
    }
    throw new Error('Expected PostgreSQL blocking edge was not observed');
  }

  it.each<[Writer, Writer]>([['rest','rest'],['rest','manus'],['rest','founder'],['manus','manus'],['manus','founder'],['founder','founder']])(
    'serializes real concurrent %s/%s starts and returns only the winning inserted row', async (first, second) => {
      const controller = await pool.connect(); const gate = 710091;
      const operations: Promise<any>[] = [];
      const settle = (p: Promise<any>) => p.then(value => ({ value }), error => ({ error }));
      try {
        const controllerPid = (await controller.query('SELECT pg_backend_pid() AS id')).rows[0].id;
        await controller.query('SELECT pg_advisory_lock($1)', [gate]);
        await pool.query(`CREATE FUNCTION test_timer_start_gate() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(710091); RETURN NEW; END; $$`);
        await pool.query('CREATE TRIGGER test_timer_start_gate BEFORE INSERT ON time_entries FOR EACH ROW EXECUTE FUNCTION test_timer_start_gate()');
        const winner = settle(start(first)); operations.push(winner);
        const winnerPid = await waitBlockedBy(controllerPid);
        const loser = settle(start(second, 'card-b')); operations.push(loser);
        const loserPid = await waitBlockedBy(winnerPid);
        expect((await pool.query('SELECT pg_blocking_pids($1) AS blockers',[loserPid])).rows[0].blockers).toContain(winnerPid);
        await controller.query('SELECT pg_advisory_unlock($1)', [gate]);
        const [a,b] = await Promise.all([winner,loser]);
        if (a.error) throw a.error; if (b.error) throw b.error;
        expect(a.value.status).toBe(200); expect(b.value.status).toBe(409);
        const rows = (await pool.query('SELECT * FROM time_entries')).rows;
        expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ trackedUserId: 1002, trackedProfileId: 12, vaId: null, founderId: 1001 });
        expect(a.value.body.entry?.id ?? a.value.body.id).toBe(rows[0].id);
      } finally {
        try { await controller.query('SELECT pg_advisory_unlock($1)', [gate]); }
        finally { controller.release(true); await Promise.allSettled(operations);
          try { await pool.query('DROP TRIGGER IF EXISTS test_timer_start_gate ON time_entries'); }
          finally { await pool.query('DROP FUNCTION IF EXISTS test_timer_start_gate()'); } }
      }
    },
  );

  it('enforces direct-SQL uniqueness, profile/account/founder alignment, and restrictive history FKs', async () => {
    await start('rest');
    await expect(pool.query(`INSERT INTO time_entries ("taskId","trackedUserId","trackedProfileId","founderId","startTime") VALUES ('duplicate',1002,12,1001,now())`)).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO time_entries ("taskId","trackedUserId","trackedProfileId","founderId","startTime") VALUES ('spoof',1002,13,1001,now())`)).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`DELETE FROM users WHERE id=1002`)).rejects.toMatchObject({ code: '23001', constraint: 'time_entries_trackedUserId_users_id_fk' });
    await expect(pool.query(`DELETE FROM va_profiles WHERE id=12`)).rejects.toMatchObject({ code: '23001', constraint: 'time_entries_trackedProfileId_va_profiles_id_fk' });
  });

  it('rejects ownerless import and forged resolution audits under a restricted DML role even with SET LOCAL GUC', async () => {
    roleCreated = true;
    try { await pool.query(`CREATE ROLE ${escapeIdentifier(roleName)} NOLOGIN`); }
    catch (error) { if ((error as { code?: string }).code === '42710') roleCreated = false; throw error; }
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${escapeIdentifier(roleName)}`);
    await pool.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${escapeIdentifier(roleName)}`);
    await pool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${escapeIdentifier(roleName)}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${escapeIdentifier(roleName)}`);
      await client.query(`SELECT set_config('aptlss.legacy_timer_import',txid_current()::text,true)`);
      await expect(client.query(`INSERT INTO time_entries ("taskId","vaId","founderId","startTime") VALUES ('forged',12,1001,now())`)).rejects.toMatchObject({ code: 'PT409' });
      await client.query('ROLLBACK');
      // Stage one privileged legacy row without inventing a canonical identity.
      const staging = await pool.connect();
      try {
        await staging.query('BEGIN'); await staging.query(`SELECT set_config('aptlss.legacy_timer_import',txid_current()::text,true)`);
        await staging.query(`INSERT INTO time_entries (id,"taskId","vaId","founderId","startTime","endTime") VALUES (55,'legacy',12,1001,now(),now())`);
        await staging.query('COMMIT');
      } finally { await staging.query('ROLLBACK'); staging.release(); }
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${escapeIdentifier(roleName)}`);
      await client.query(`INSERT INTO time_entry_events ("timeEntryId","eventType","afterJson","metadataJson")
        VALUES (55,'identity_resolution','{"trackedUserId":1002,"trackedProfileId":12}',json_build_object('transactionId',txid_current()::text)::text)`);
      await expect(client.query(`UPDATE time_entries SET "trackedUserId"=1002,"trackedProfileId"=12 WHERE id=55`)).rejects.toMatchObject({ code: 'PT409' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await pool.query('SELECT "trackedUserId" FROM time_entries WHERE id=55')).rows[0].trackedUserId).toBeNull();
  });

  it('resolves historical ownership only through explicit privileged evidence and preserves all original fields', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SELECT set_config('aptlss.legacy_timer_import',txid_current()::text,true)`);
      await client.query(`INSERT INTO time_entries (id,"taskId","vaId","founderId","startTime","endTime","durationMinutes")
        VALUES (55,'review-fixture',12,1001,'2026-10-01 09:00:00','2026-10-01 09:37:00',37)`);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    const before = (await pool.query('SELECT * FROM time_entries WHERE id=55')).rows[0];
    const input = { entryId: 55, trackedUserId: worker.id, trackedProfileId: profileId, actorUserId: founder.id,
      expectedFounderId: founder.id, evidenceReference: 'fixture:review-55', execute: false };
    expect(await resolveTimerIdentity(db(), input)).toMatchObject({ executed: false });
    expect((await pool.query('SELECT * FROM time_entries WHERE id=55')).rows[0]).toEqual(before);
    expect(await resolveTimerIdentity(db(), { ...input, execute: true })).toMatchObject({ executed: true });
    const after = (await pool.query('SELECT * FROM time_entries WHERE id=55')).rows[0];
    expect(after).toEqual({ ...before, trackedUserId: worker.id, trackedProfileId: profileId });
    const audit = (await pool.query(`SELECT * FROM time_entry_events WHERE "timeEntryId"=55`)).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].metadataJson)).toMatchObject({ actorUserId: founder.id, evidenceReference: 'fixture:review-55' });
    await resolveTimerIdentity(db(), { ...input, execute: true });
    expect((await pool.query('SELECT count(*)::int AS n FROM time_entry_events')).rows[0].n).toBe(1);
  });

  it('reports a proposed active alias collision and keeps both raw histories and readiness blocked', async () => {
    const active = await start('rest');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SELECT set_config('aptlss.legacy_timer_import',txid_current()::text,true)`);
      await client.query(`INSERT INTO time_entries (id,"taskId","vaId","founderId","startTime") VALUES (55,'legacy-alias',12,1001,now())`);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    const before = (await pool.query('SELECT * FROM time_entries ORDER BY id')).rows;
    const input = { entryId: 55, trackedUserId: worker.id, trackedProfileId: profileId, actorUserId: founder.id,
      expectedFounderId: founder.id, evidenceReference: 'fixture:active-alias', execute: false };
    expect(await resolveTimerIdentity(db(), input)).toMatchObject({ executed: false, blockedByActiveEntryIds: [active.body.entry.id] });
    await expect(resolveTimerIdentity(db(), { ...input, execute: true })).rejects.toMatchObject({ status: 409 });
    expect((await pool.query('SELECT * FROM time_entries ORDER BY id')).rows).toEqual(before);
    expect(await hasRequiredPostgresSchema(pool)).toBe(false);
  });

  const closure = (entryId = 55) => ({ entryId, trackedUserId: 1002, trackedProfileId: 12,
    actorUserId: 1001, expectedFounderId: 1001, expectedLegacyVaId: 12,
    expectedTrackedProfileId: null, endTime: '2026-10-01T09:37:00Z',
    reason: 'Actual stop verified against operator record', evidenceReference: `fixture:closure-${entryId}`, execute: true });
  async function legacyOpen(id = 55, minutes: number | null = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('aptlss.legacy_timer_import',txid_current()::text,true)`);
      await client.query(`INSERT INTO time_entries (id,"taskId","vaId","founderId","startTime","durationMinutes",notes)
        VALUES ($1,'legacy-recovery',12,1001,'2026-10-01 09:00:00.123456',$2,'original retained')`, [id, minutes]);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
  const rawEntry = async (id = 55) => (await pool.query('SELECT to_jsonb(t) AS original FROM time_entries t WHERE id=$1', [id])).rows[0].original;

  it('atomically closes a duplicate legacy timer, retains raw provenance and derives only absent duration', async () => {
    await legacyOpen(55); await legacyOpen(56, 17);
    const before = await rawEntry(56);
    expect(await hasRequiredPostgresSchema(pool)).toBe(false);
    await resolveTimerIdentity(db(), { entryId: 55, trackedUserId: 1002, trackedProfileId: 12,
      actorUserId: 1001, expectedFounderId: 1001, evidenceReference: 'fixture:retained-active', execute: true });
    await expect(resolveTimerIdentity(db(), { entryId: 56, trackedUserId: 1002, trackedProfileId: 12,
      actorUserId: 1001, expectedFounderId: 1001, evidenceReference: 'fixture:duplicate-active', execute: true })).rejects.toMatchObject({ status: 409 });
    const results = await Promise.all([resolveAndCloseLegacyTimer(db(), closure(56)), resolveAndCloseLegacyTimer(db(), closure(56))]);
    expect(results.filter(r => r.executed)).toHaveLength(1);
    expect(results.filter(r => 'alreadyClosed' in r && r.alreadyClosed)).toHaveLength(1);
    const after = await rawEntry(56);
    expect(after).toEqual({ ...before, trackedUserId: 1002, trackedProfileId: 12, endTime: '2026-10-01T09:37:00' });
    expect(recordedSeconds((await db().select().from(schema.timeEntries)).find(r => r.id === 56)!)).toBe(17 * 60);
    const events = (await pool.query('SELECT * FROM time_entry_events WHERE "timeEntryId"=56 ORDER BY id')).rows;
    expect(events.map(e => e.eventType)).toEqual(['identity_resolution', 'legacy_timer_closed']);
    expect(JSON.parse(events[1].beforeJson)).toMatchObject({ startTime: before.startTime, endTime: null, durationMinutes: 17, durationSeconds: null, legacyVaId: 12 });
    expect(JSON.parse(events[1].metadataJson)).toMatchObject({ actorUserId: 1001, evidenceReference: 'fixture:closure-56', evidenceKind: 'operator_attestation' });
    expect(await hasRequiredPostgresSchema(pool)).toBe(true);
    await expect(resolveAndCloseLegacyTimer(db(), { ...closure(56), reason: 'Different attestation does not replay' })).rejects.toMatchObject({ status: 409 });
    await resolveTimerIdentity(db(), { entryId: 55, trackedUserId: 1002, trackedProfileId: 12,
      actorUserId: 1001, expectedFounderId: 1001, evidenceReference: 'fixture:retained-active', execute: true });
    // Test the no-recorded-duration variant separately, through actual Drizzle timestamp decoding.
    await legacyOpen(57);
    await resolveAndCloseLegacyTimer(db(), closure(57));
    const absent = (await db().select().from(schema.timeEntries)).find(r => r.id === 57)!;
    expect(absent.durationSeconds).toBeNull(); expect(absent.durationMinutes).toBeNull();
    expect(absent.startTime.toISOString()).toBe('2026-10-01T09:00:00.123Z');
    expect(absent.endTime!.toISOString()).toBe('2026-10-01T09:37:00.000Z');
    expect(recordedSeconds(absent)).toBeCloseTo(2219.877, 3);
  });

  it.each(['paid', 'locked', 'weekly'] as const)('rejects real PostgreSQL %s overlap without changing timer or audit', async kind => {
    await legacyOpen(); const before = await rawEntry();
    if (kind === 'locked') await pool.query(`INSERT INTO time_day_reviews ("dateKey",status) VALUES ('2026-10-01','locked')`);
    else {
      const cycle = (await pool.query(`INSERT INTO payment_cycles ("founderId","cycleStart","cycleEnd","isPaid")
        VALUES (1001,$1,$2,true) RETURNING id`, kind === 'weekly' ? ['2026-11-01','2026-11-07'] : ['2026-10-01','2026-10-01'])).rows[0].id;
      if (kind === 'weekly') await pool.query(`INSERT INTO weekly_pay_log ("vaId","founderId","weekStart","weekEnd","paymentCycleId")
        VALUES (1002,1001,'2026-09-28','2026-10-04',$1)`, [cycle]);
    }
    await expect(resolveAndCloseLegacyTimer(db(), closure())).rejects.toMatchObject({ status: 409 });
    expect(await rawEntry()).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS n FROM time_entry_events')).rows[0].n).toBe(0);
  });

  it('blocks concurrent settlement INSERT until the audited recovery commits, then preserves both records', async () => {
    await legacyOpen();
    const controller = await pool.connect(); const writer = await pool.connect();
    const operations: Promise<any>[] = [];
    const settle = (p: Promise<any>) => p.then(value => ({ value }), error => ({ error }));
    try {
      const pid = (await controller.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      await controller.query('SELECT pg_advisory_lock(710092)');
      await pool.query(`CREATE FUNCTION test_recovery_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."eventType"='legacy_timer_closed' THEN PERFORM pg_advisory_xact_lock(710092); END IF; RETURN NEW; END; $$`);
      await pool.query('CREATE TRIGGER test_recovery_gate BEFORE INSERT ON time_entry_events FOR EACH ROW EXECUTE FUNCTION test_recovery_gate()');
      const recovery = settle(resolveAndCloseLegacyTimer(db(), closure())); operations.push(recovery);
      const recoveryPid = await waitBlockedBy(pid);
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      const settlement = settle(writer.query(`INSERT INTO payment_cycles ("founderId","cycleStart","cycleEnd","isPaid")
        VALUES (1001,'2026-10-01','2026-10-01',true) RETURNING id`)); operations.push(settlement);
      await waitBlockedBy(recoveryPid);
      expect((await pool.query('SELECT pg_blocking_pids($1) AS blockers', [writerPid])).rows[0].blockers).toContain(recoveryPid);
      expect((await pool.query('SELECT count(*)::int AS n FROM payment_cycles')).rows[0].n).toBe(0);
      await controller.query('SELECT pg_advisory_unlock(710092)');
      const [closed, paid] = await Promise.all([recovery, settlement]);
      if (closed.error) throw closed.error; if (paid.error) throw paid.error;
      expect(closed.value.executed).toBe(true); expect(paid.value.rows).toHaveLength(1);
      expect((await rawEntry()).endTime).toBe('2026-10-01T09:37:00');
      // Exact replay is audit-idempotent even after settlement; a different unresolved row is held.
      expect(await resolveAndCloseLegacyTimer(db(), closure())).toMatchObject({ alreadyClosed: true });
      await legacyOpen(56);
      await expect(resolveAndCloseLegacyTimer(db(), closure(56))).rejects.toMatchObject({ status: 409 });
    } finally {
      try { await controller.query('SELECT pg_advisory_unlock(710092)'); }
      finally {
        controller.release(true); await Promise.allSettled(operations); writer.release(true);
        try { await pool.query('DROP TRIGGER IF EXISTS test_recovery_gate ON time_entry_events'); }
        finally { await pool.query('DROP FUNCTION IF EXISTS test_recovery_gate()'); }
      }
    }
  });

  it('rechecks a concurrently inserted paid cycle after waiting for its commit', async () => {
    await legacyOpen(); const before = await rawEntry();
    const client = await pool.connect(); let pending: Promise<any> | undefined;
    try {
      await client.query('BEGIN');
      const pid = (await client.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      await client.query(`INSERT INTO payment_cycles ("founderId","cycleStart","cycleEnd","isPaid")
        VALUES (1001,'2026-10-01','2026-10-01',true)`);
      pending = resolveAndCloseLegacyTimer(db(), closure()).then(value => ({ value }), error => ({ error }));
      await waitBlockedBy(pid);
      await client.query('COMMIT');
      expect((await pending).error).toMatchObject({ status: 409 });
      expect(await rawEntry()).toEqual(before);
      expect((await pool.query('SELECT count(*)::int AS n FROM time_entry_events')).rows[0].n).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(true); if (pending) await pending; }
  });

  it('compares and decodes naive timestamps as UTC on a western host and western database session', async () => {
    await legacyOpen();
    const client = await pool.connect(); const previousTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(new Date('2026-10-01T09:00:00Z').getTimezoneOffset()).toBe(420);
      await client.query(`SET timezone='America/Los_Angeles'`);
      const western = drizzle(client, { schema });
      await expect(resolveAndCloseLegacyTimer(western, { ...closure(), endTime: '2026-10-01T09:00:00.123Z' })).rejects.toMatchObject({ status: 400 });
      await resolveAndCloseLegacyTimer(western, closure());
      const row = (await western.select().from(schema.timeEntries))[0];
      expect(row.startTime.toISOString()).toBe('2026-10-01T09:00:00.123Z');
      expect(row.endTime!.toISOString()).toBe('2026-10-01T09:37:00.000Z');
      expect(recordedSeconds(row)).toBeCloseTo(2219.877, 3);
      expect(row.durationSeconds).toBeNull(); expect(row.durationMinutes).toBeNull();
    } finally {
      if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
      try { await client.query('RESET timezone'); } finally { client.release(); }
    }
  });

  it('rolls back both recovery events and identity when the second audit insert fails', async () => {
    await legacyOpen(); const before = await rawEntry();
    try {
      await pool.query(`CREATE FUNCTION test_recovery_reject() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."eventType"='legacy_timer_closed' THEN RAISE EXCEPTION 'Synthetic rejection' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$`);
      await pool.query('CREATE TRIGGER test_recovery_reject BEFORE INSERT ON time_entry_events FOR EACH ROW EXECUTE FUNCTION test_recovery_reject()');
      await expect(resolveAndCloseLegacyTimer(db(), closure())).rejects.toMatchObject({
        cause: { code: '23514', message: 'Synthetic rejection' },
      });
      expect(await rawEntry()).toEqual(before);
      expect((await pool.query('SELECT count(*)::int AS n FROM time_entry_events')).rows[0].n).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_recovery_reject ON time_entry_events');
      await pool.query('DROP FUNCTION IF EXISTS test_recovery_reject()');
    }
  });

  it('rejects closure under the restricted DML role and rejects mismatched before evidence', async () => {
    await legacyOpen(); const before = await rawEntry();
    for (const change of [{ expectedLegacyVaId: 999 }, { expectedTrackedProfileId: 12 }, { expectedFounderId: 1004 }, { trackedProfileId: 13 }]) {
      await expect(resolveAndCloseLegacyTimer(db(), { ...closure(), ...change })).rejects.toMatchObject({ status: 409 });
    }
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${escapeIdentifier(roleName)}`);
      await expect(resolveAndCloseLegacyTimer(drizzle(client, { schema }), closure())).rejects.toMatchObject({ status: 403 });
    } finally { await client.query('RESET ROLE'); client.release(); }
    expect(await rawEntry()).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS n FROM time_entry_events')).rows[0].n).toBe(0);
  });

  it('uses saved worker hours over profile UTC and reports the actual Sunday in the western week', async () => {
    await pool.query(`UPDATE va_profiles SET timezone='UTC' WHERE id=12`);
    await pool.query(`INSERT INTO user_working_hours ("userId","userOpenId",timezone,"weeklyHoursMin","weeklyHoursMax")
      VALUES (1002,'synthetic-worker','America/Los_Angeles',25,30)`);
    await pool.query(`INSERT INTO time_entries ("taskId","trackedUserId","trackedProfileId","founderId","startTime","endTime","durationMinutes")
      VALUES ('sunday',1002,12,1001,'2026-10-18 23:00:00','2026-10-19 00:00:00',60)`);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-19T00:30:00Z'));
      const calendar = await timerRouter.createCaller(context()).getDateContext();
      expect(calendar).toMatchObject({ timezone: 'America/Los_Angeles', date: '2026-10-18', startDate: '2026-10-12', endDate: '2026-10-18' });
      const result = await request(appFor(worker)).get('/api/time-tracking/weekly-progress');
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ complete: true, actualMinutes: 60, actualHours: 1,
        weeklyHoursMin: 25, weeklyHoursMax: 30, dailyHours: { '2026-10-18': 1 } });
    } finally { vi.useRealTimers(); }
  });

  it('closes one exact entry once under concurrent stop/pause, and a replay cannot stop its successor', async () => {
    const created = await start('rest'); const id = created.body.entry.id;
    const results = await Promise.all(['stop','pause'].map(action => request(appFor(worker)).post(`/api/time-tracking/${action}`).send({ entryId: id })));
    expect(results.map(result => result.status)).toEqual([200,200]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM time_entry_events WHERE "timeEntryId"=$1 AND "eventType"='timer_closed'`,[id])).rows[0].n).toBe(1);
    const successor = await start('manus','card-b'); expect(successor.status).toBe(200);
    const replay = await request(appFor(worker)).post('/api/time-tracking/stop').send({ entryId: id });
    expect(replay.body.entry.id).toBe(id); expect(replay.body.alreadyStopped).toBe(true);
    expect((await pool.query('SELECT "endTime" FROM time_entries WHERE id=$1',[successor.body.id])).rows[0].endTime).toBeNull();
    await expect(timerRouter.createCaller(context()).stop({ entryId: successor.body.id, cardId: 'card-a' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each(['offboard','reassign','promote'])('allows the old founder to close exactly its historical timer after %s, without touching a new tenant', async change => {
    const created = await start('rest'); const id = created.body.entry.id;
    if (change === 'offboard') expect((await request(appFor(founder)).put('/api/va/vas/12').send({ status: 'inactive' })).status).toBe(200);
    if (change === 'reassign') await pool.query('UPDATE va_profiles SET "founderId"=1004 WHERE id=12');
    if (change === 'promote') await pool.query(`UPDATE users SET role='admin' WHERE id=1002`);
    expect((await request(appFor({ ...founder, id: 1004 })).put(`/api/va/time-entries/${id}/stop`).send({})).status).toBe(404);
    const result = await request(appFor(founder)).put(`/api/va/time-entries/${id}/stop`).send({});
    expect(result.status).toBe(200); expect(result.body.entry.founderId).toBe(1001);
    expect((await request(appFor(founder)).put(`/api/va/time-entries/${id}/stop`).send({})).status).toBe(200);
    expect((await pool.query(`SELECT count(*)::int AS n FROM time_entry_events WHERE "timeEntryId"=$1 AND "eventType"='timer_closed'`,[id])).rows[0].n).toBe(1);
  });

  it('retains the database invariant and exact active identity across fresh application connections', async () => {
    const first = await start('rest'); expect(first.status).toBe(200);
    const fresh = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
    try {
      controls.getDb.mockResolvedValue(drizzle(fresh, { schema }));
      expect((await request(appFor(worker)).get('/api/time-tracking/active')).body.entry.id).toBe(first.body.entry.id);
      expect((await start('manus','card-b')).status).toBe(409);
      expect(await hasRequiredPostgresSchema(fresh)).toBe(true);
    } finally { controls.getDb.mockImplementation(async () => db()); await fresh.end(); }
  });

  it('retains the one-active invariant across two terminated and relaunched Node application processes', async () => {
    const launch = async () => {
      const result = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', path.resolve(import.meta.dirname, 'test/canonicalTimerProcess.ts')], {
          cwd: path.resolve(import.meta.dirname, '..'), timeout: 15000, maxBuffer: 4096,
          env: { ...process.env, DATABASE_URL: '', APTLSS_TIMER_PROCESS_FIXTURE: connectionString },
        });
      return JSON.parse(result.stdout);
    };
    const first = await launch(); expect(first.status).toBe(200);
    const restarted = await launch(); expect(restarted).toEqual({ status: 409, entryId: first.entryId });
    expect((await pool.query('SELECT count(*)::int AS n FROM time_entries')).rows[0].n).toBe(1);
  });

  it('rolls back the actual close and its duration when PostgreSQL rejects the audit write', async () => {
    const created = await start('rest'); expect(created.status).toBe(200);
    const before = (await pool.query('SELECT * FROM time_entries WHERE id=$1', [created.body.entry.id])).rows[0];
    try {
      await pool.query(`CREATE FUNCTION test_reject_timer_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic audit rejection' USING ERRCODE='23514'; END; $$`);
      await pool.query('CREATE TRIGGER test_reject_timer_audit BEFORE INSERT ON time_entry_events FOR EACH ROW EXECUTE FUNCTION test_reject_timer_audit()');
      const response = await request(appFor(worker)).post('/api/time-tracking/stop').send({ entryId: before.id });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to stop timer' });
      expect((await pool.query('SELECT * FROM time_entries WHERE id=$1', [before.id])).rows[0]).toEqual(before);
      expect((await pool.query('SELECT count(*)::int AS n FROM time_entry_events')).rows[0].n).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_reject_timer_audit ON time_entry_events');
      await pool.query('DROP FUNCTION IF EXISTS test_reject_timer_audit()');
    }
  });
});
