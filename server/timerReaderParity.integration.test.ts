import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool, escapeIdentifier } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../shared/isolatedPostgresTestDatabase.mjs';
import { getDb, closeDb } from './db';
import analytics from './routes/analytics';
import reports from './routes/reports';
import { timerRouter } from './routes/manus';
import { collectManagerInput } from './aptlssManagerService';
import { collectComplianceSnapshot } from './services/manus-scheduler';

// Only the two Trello network reads are replaced. All SQL, authorization,
// attribution, duration conversion and snapshot persistence execute unchanged.
const providers = vi.hoisted(() => ({ cards: vi.fn(), comments: vi.fn() }));
vi.mock('./services/trello-manus', async importOriginal => ({
  ...await importOriginal<typeof import('./services/trello-manus')>(),
  getWorkerCards: providers.cards,
  getWorkerCommentedCardIdsToday: providers.comments,
}));

const fixtureUrl = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!fixtureUrl)('native canonical timer cross-reader acceptance', { timeout: 30000 }, () => {
  const databaseName = `timer_parity_${randomUUID().replaceAll('-', '')}`;
  const envKeys = ['DATABASE_URL', 'APTLSS_MANAGER_PILOT_WORKER_IDS', 'APTLSS_MANAGER_SHADOW_ONLY',
    'TRELLO_API_KEY', 'TRELLO_TOKEN'] as const;
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const now = new Date('2026-10-19T06:30:00.000Z'); // Sunday 23:30 in Los Angeles.
  const localStart = '2026-10-18T07:00:00.000Z';
  const expectedIds = [101, 102, 103];
  // Independent fixture oracle, not a call to the duration implementation.
  // Derived 90.877 seconds quantizes once to 91 canonical whole seconds;
  // recorded seconds/minutes retain their authoritative precedence.
  const expectedSeconds = 61 + 120 + 91;
  let administrator: Pool | undefined;
  let pool: Pool;
  let created = false;
  let worker: schema.User;
  let founder: schema.User;
  let profile: schema.VAProfile;

  beforeAll(async () => {
    const base = new URL(requireIsolatedPostgresTestDatabase(fixtureUrl, process.env.NODE_ENV === 'production'));
    if (!/^timer_parity_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Invalid owned fixture database');
    administrator = new Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
    created = true;
    try { await administrator.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`); }
    catch (error) { if ((error as { code?: string }).code === '42P04') created = false; throw error; }
    base.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: base.href, max: 4, connectionTimeoutMillis: 5000,
      options: '-c timezone=UTC -c statement_timeout=15000 -c lock_timeout=5000' });
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(import.meta.dirname, '../drizzle-postgres-v1') });
    // The production DB factory is used, redirected only to this newly owned DB.
    await closeDb();
    process.env.DATABASE_URL = base.href;
    process.env.APTLSS_MANAGER_PILOT_WORKER_IDS = '1002';
    process.env.APTLSS_MANAGER_SHADOW_ONLY = 'true';
    process.env.TRELLO_API_KEY = 'synthetic-fixture';
    process.env.TRELLO_TOKEN = 'synthetic-fixture';
    const applicationDb = await getDb();
    if (!applicationDb) throw new Error('Owned fixture application database is unavailable');
    const identity = await applicationDb.execute<{ name: string }>(sql`SELECT current_database() AS name`);
    expect(identity.rows[0]?.name).toBe(databaseName);
  }, 90000);

  afterAll(async () => {
    vi.useRealTimers();
    try { await closeDb(); }
    finally {
      try { if (pool) await pool.end(); }
      finally {
        try { if (created && administrator) await administrator.query(`DROP DATABASE ${escapeIdentifier(databaseName)}`); }
        finally {
          try { if (administrator) await administrator.end(); }
          finally {
            for (const key of envKeys) {
              if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
            }
          }
        }
      }
    }
  });

  async function seed() {
    await pool.query(`TRUNCATE users,va_profiles,user_working_hours,time_entries,time_entry_events,
      aptlss_steps,aptlss_plans,task_assignments,daily_compliance_snapshots RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO users (id,"openId",role,name) VALUES
      (1001,'parity-founder','admin','Fixture founder'),(1002,'parity-worker','worker','Fixture worker'),
      (1003,'parity-peer','worker','Fixture peer'),(1004,'parity-other-founder','admin','Other founder')`);
    await pool.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status,timezone) VALUES
      (12,1002,1001,'Fixture worker','active','UTC'),(13,1003,1001,'Peer','active','UTC'),
      (14,1002,1004,'Historical tenant','inactive','UTC'),(1002,1003,1001,'Colliding alias','inactive','UTC')`);
    await pool.query(`INSERT INTO user_working_hours ("userId","userOpenId",timezone,"workingDays","enableBreaks")
      VALUES (1002,'parity-worker','America/Los_Angeles','0,1,2,3,4,5,6',0)`);
    const rows = [
      [101,1002,12,1001,12,'2026-10-18 07:00:00','2026-10-18 07:01:01',61,2,false],
      [102,1002,12,1001,1002,'2026-10-18 15:00:00','2026-10-18 15:02:00',null,2,false],
      [103,1002,12,1001,null,'2026-10-18 23:00:00.123','2026-10-18 23:01:31',null,null,false],
      [104,1003,13,1001,12,'2026-10-18 16:00:00','2026-10-18 17:00:00',3600,60,false],
      [105,1002,14,1004,null,'2026-10-18 17:00:00','2026-10-18 18:00:00',3600,60,false],
      [106,1002,12,1001,null,'2026-10-18 18:00:00','2026-10-18 19:00:00',3600,60,true],
      [107,1002,12,1001,null,'2026-10-19 06:00:00',null,3600,60,false],
      [108,1002,12,1001,null,'2026-10-11 06:59:59','2026-10-11 07:10:00',600,10,false],
      [109,null,null,1001,1002,'2026-10-18 19:00:00','2026-10-18 20:00:00',3600,60,true],
    ];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('aptlss.legacy_timer_import',txid_current()::text,true)`);
      for (const [id,owner,profileId,tenant,alias,start,end,seconds,minutes,voided] of rows) {
        await client.query(`INSERT INTO time_entries (id,"taskId","cardId","trackedUserId","trackedProfileId","founderId","vaId",
          "startTime","endTime","durationSeconds","durationMinutes","isVoided","aptlssStepId")
          VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1)`,
        [id,`card-${id}`,owner,profileId,tenant,alias,start,end,seconds,minutes,voided]);
        if (owner === 1002 && tenant === 1001) await client.query(`INSERT INTO aptlss_steps
          (id,"vaId","cardId","stepNumber",title,status) VALUES ($1,1002,$2,1,'Fixture step','complete')`, [id,`card-${id}`]);
      }
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    const db = (await getDb())!;
    const accounts = await db.select().from(schema.users);
    worker = accounts.find(row => row.id === 1002)!; founder = accounts.find(row => row.id === 1001)!;
    profile = (await db.select().from(schema.vaProfiles)).find(row => row.id === 12)!;
  }
  beforeEach(async () => {
    vi.useRealTimers();
    await seed();
    providers.cards.mockReset().mockResolvedValue([]);
    providers.comments.mockReset().mockResolvedValue(new Set());
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  });

  function app(actor = worker) {
    const application = express();
    application.use((req, _res, next) => { (req as express.Request & { user: schema.User }).user = actor; next(); });
    application.use('/analytics', analytics); application.use('/reports', reports);
    return application;
  }
  const caller = () => timerRouter.createCaller({ user: worker, req: {} as any, res: {} as any });
  async function csv(actor = worker) {
    const response = await request(app(actor)).get('/reports/export?format=csv&type=time-entries').expect(200);
    // This fixture deliberately has no commas, quotes or multiline field values.
    // Fail instead of pretending this narrow test reader is a general CSV parser.
    expect(response.text).not.toContain('"');
    const [header, ...lines] = response.text.trimEnd().split('\r\n').map(line => line.split(','));
    expect(header.slice(-7)).toEqual(['durationSeconds','isVoided','recordedSeconds','recordedMinutes',
      'ownershipVerified','historyComplete','unresolvedEntryCount']);
    const rows = lines.map(values => {
      expect(values).toHaveLength(header.length);
      return Object.fromEntries(header.map((key, index) => [key, values[index]]));
    });
    return { response, rows };
  }
  function localEligible(row: Record<string, string>) {
    return row.trackedUserId === '1002' && row.founderId === '1001' && row.endTime !== ''
      && row.isVoided === 'false' && row.startTime >= localStart && row.startTime <= now.toISOString();
  }
  async function manager() { return collectManagerInput((await getDb())!, worker.id, now); }
  async function unknownHistory() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('aptlss.legacy_timer_import',txid_current()::text,true)`);
      await client.query(`INSERT INTO time_entries (id,"taskId","vaId","founderId","startTime","endTime","durationSeconds")
        VALUES (110,'unknown',1002,1001,'2026-10-18 21:00:00','2026-10-18 21:01:00',60)`);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
  }

  it('exports the exact canonical membership with raw provenance and independently usable duration fields', async () => {
    const { response, rows } = await csv();
    expect(response.headers['x-time-history-complete']).toBe('true');
    expect(rows.map(r => Number(r.id)).sort()).toEqual([101,102,103,106,107,108]);
    const included = rows.filter(localEligible);
    expect(included.map(r => Number(r.id)).sort()).toEqual(expectedIds);
    expect(included.reduce((sum, r) => sum + Number(r.recordedSeconds), 0)).toBeCloseTo(expectedSeconds, 6);
    expect(rows.find(r => r.id === '101')).toMatchObject({ legacyVaId: '12', durationSeconds: '61', durationMinutes: '2', recordedSeconds: '61' });
    expect(rows.find(r => r.id === '102')).toMatchObject({ legacyVaId: '1002', durationSeconds: '', recordedSeconds: '120' });
    expect(rows.find(r => r.id === '103')).toMatchObject({ durationSeconds: '', durationMinutes: '' });
    expect(Number(rows.find(r => r.id === '103')!.recordedSeconds)).toBe(91);
    expect(rows.find(r => r.id === '103')).toMatchObject({ startTime: '2026-10-18T23:00:00.123Z',
      endTime: '2026-10-18T23:01:31.000Z' });
    expect(rows.find(r => r.id === '106')!.recordedSeconds).toBe('0');
    expect(rows.find(r => r.id === '107')!.recordedSeconds).toBe('0');
    expect(rows.every(row => row.ownershipVerified === 'true' && row.historyComplete === 'true' && row.unresolvedEntryCount === '0')).toBe(true);
  });

  it('returns matching actual analytics totals with explicit display rounding', async () => {
    const capacity = await request(app()).get('/analytics/team-capacity').expect(200);
    expect(capacity.body.complete).toBe(true);
    expect(capacity.body.trackedMinutes * 60).toBeCloseTo(expectedSeconds, 6);
    expect(capacity.body.workers).toHaveLength(1);
    expect(capacity.body.workers[0].trackedMinutes).toBe(Math.round(expectedSeconds / 60));
    const trends = await request(app()).get('/analytics/trends').expect(200);
    expect(trends.body.timezone).toBe('America/Los_Angeles');
    expect(trends.body.trends.find((day: any) => day.date === '2026-10-18').trackedMinutes).toBe(Math.round(expectedSeconds / 60));
  });

  it('retains exact IDs in real Manus history and unrounded seconds in its daily aggregation', async () => {
    const daily = await caller().getDailySummary({ date: '2026-10-18' });
    expect(daily.map(row => row.cardId).sort()).toEqual(expectedIds.map(id => `card-${id}`));
    expect(daily.reduce((sum, row) => sum + row.totalSeconds, 0)).toBeCloseTo(expectedSeconds, 6);
    for (const id of expectedIds) {
      const history = await caller().getCardHistory({ cardId: `card-${id}` });
      expect(history.map(row => row.id)).toEqual([id]);
    }
    expect(await caller().getCardHistory({ cardId: 'card-104' })).toEqual([]);
    expect(await caller().getCardHistory({ cardId: 'card-105' })).toEqual([]);
  });

  it('loads actual operator context from canonical history, not the colliding legacy aliases', async () => {
    const input = await manager();
    expect(input.timeSummary?.complete).toBe(true);
    const samples = input.timeSamples.filter(sample => sample.startedAt! >= localStart && sample.startedAt! <= now.toISOString());
    expect(samples.map(sample => sample.stepId).sort()).toEqual(expectedIds);
    // These are distinct non-overlapping steps, not a claim that operator
    // overlap-deduplicated estimates always equal accounting sums.
    expect(samples.find(sample => sample.stepId === 103)!.minutes * 60).toBeCloseTo(91, 6);
    expect(samples.reduce((sum, sample) => sum + sample.minutes * 60, 0)).toBeCloseTo(expectedSeconds, 6);
    expect(input.timeSamples.some(sample => [104,105,106,107,109].includes(sample.stepId))).toBe(false);
  });

  it('persists the same scheduler seconds and exact contributing count through real PostgreSQL', async () => {
    const snapshot = await collectComplianceSnapshot(profile, 'manual');
    expect(snapshot.trackedSeconds).toBeCloseTo(expectedSeconds, 6);
    expect(snapshot.timeEntryCount).toBe(expectedIds.length);
    const persisted = (await pool.query('SELECT * FROM daily_compliance_snapshots')).rows;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].trackedSeconds).toBe(snapshot.trackedSeconds);
    expect(snapshot.founderId).toBe(1001);
    expect(providers.cards).toHaveBeenCalledOnce(); expect(providers.comments).toHaveBeenCalledOnce();
  });

  it.each([
    { id: 101, delta: 181 - 61 }, { id: 102, delta: 181 - 120 }, { id: 103, delta: 181 - 91 },
    { id: 104, delta: 0 }, { id: 105, delta: 0 }, { id: 106, delta: 0 },
    { id: 107, delta: 0 }, { id: 108, delta: 0 },
  ])('proves the actual contribution/exclusion of entry $id across DB-backed readers', async ({ id, delta }) => {
    // The operator estimator clips intervals at actual end, so extend the test
    // interval as well when changing recorded seconds. Raw identities stay fixed.
    await pool.query(`UPDATE time_entries SET "durationSeconds"=181,
      "endTime"=CASE WHEN "endTime" IS NULL THEN NULL ELSE "startTime"+INTERVAL '181 seconds' END WHERE id=$1`, [id]);
    const expected = expectedSeconds + delta;
    const exported = (await csv()).rows.filter(localEligible);
    expect(exported.map(row => Number(row.id)).sort()).toEqual(expectedIds);
    expect(exported.reduce((sum, row) => sum + Number(row.recordedSeconds), 0)).toBeCloseTo(expected, 6);
    const capacity = await request(app()).get('/analytics/team-capacity').expect(200);
    expect(capacity.body.trackedMinutes * 60).toBeCloseTo(expected, 6);
    const input = await manager();
    const samples = input.timeSamples.filter(sample => sample.startedAt! >= localStart && sample.startedAt! <= now.toISOString());
    expect(samples.map(sample => sample.stepId).sort()).toEqual(expectedIds);
    expect(samples.reduce((sum, sample) => sum + sample.minutes * 60, 0)).toBeCloseTo(expected, 6);
    const snapshot = await collectComplianceSnapshot(profile, 'manual');
    expect(snapshot.trackedSeconds).toBeCloseTo(expected, 6);
    expect(snapshot.timeEntryCount).toBe(expectedIds.length);
  });

  it('keeps analytics/report incompleteness explicit and withholds operator samples for unresolved history', async () => {
    await unknownHistory();
    const capacity = await request(app()).get('/analytics/team-capacity').expect(200);
    expect(capacity.body).toMatchObject({ complete: false, capacityComplete: false });
    expect(capacity.body.trackedMinutes * 60).toBeCloseTo(expectedSeconds, 6);
    const exported = await csv(founder);
    expect(exported.response.headers['x-time-history-complete']).toBe('false');
    expect(Number(exported.response.headers['x-unresolved-time-entries'])).toBeGreaterThan(0);
    expect(exported.rows.find(row => row.id === '110')).toMatchObject({ trackedUserId: '', recordedSeconds: '', recordedMinutes: '',
      ownershipVerified: 'false', historyComplete: 'false', unresolvedEntryCount: '1' });
    const input = await manager();
    expect(input.timeSummary?.complete).toBe(false); expect(input.timeSamples).toEqual([]);
    expect(input.executionCoverageComplete).toBe(false);
    await expect(caller().getDailySummary({ date: '2026-10-18' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('holds known-incomplete scheduler history before any provider read or snapshot insert', async () => {
    await unknownHistory();
    await expect(collectComplianceSnapshot(profile, 'manual')).rejects.toThrow(/Historical time.*ownership review/i);
    expect(providers.cards).not.toHaveBeenCalled(); expect(providers.comments).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS n FROM daily_compliance_snapshots')).rows[0].n).toBe(0);
  });

  it.each([false, true])('holds history introduced during a provider await without changing a snapshot (existing=%s)', async existing => {
    if (existing) await pool.query(`INSERT INTO daily_compliance_snapshots ("vaId","founderId","snapshotDate","trackedSeconds")
      VALUES (1002,1001,'2026-10-18',321)`);
    const before = (await pool.query('SELECT to_jsonb(s) AS row FROM daily_compliance_snapshots s')).rows;
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    providers.cards.mockImplementationOnce(async () => { entered(); await gate; return []; });
    const pending = collectComplianceSnapshot(profile, 'manual').then(value => ({ value }), error => ({ error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([providerEntered, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Provider gate was not reached')), 5000);
      })]);
      await unknownHistory(); release();
      expect((await pending).error).toMatchObject({ message: expect.stringMatching(/Historical time.*ownership review/i) });
      expect((await pool.query('SELECT to_jsonb(s) AS row FROM daily_compliance_snapshots s')).rows).toEqual(before);
    } finally { if (timer) clearTimeout(timer); release(); await pending; }
  });
});
