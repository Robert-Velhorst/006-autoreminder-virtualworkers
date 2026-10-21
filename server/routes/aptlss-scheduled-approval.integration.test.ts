import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../../shared/isolatedPostgresTestDatabase.mjs';
import { createFinancialDatabase, type FinancialDatabase } from '../test/financialDatabase';
import { codexLlmFixture } from '../test/codexLlmFixture';

const controls = vi.hoisted(() => ({ db: undefined as any, trello: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
vi.mock('../utils/retry', async original => ({ ...await original<typeof import('../utils/retry')>(),fetchWithRetry: controls.trello }));
import router from './aptlss';
import { processDueAptlssGenerationJobs } from '../services/aptlss-scheduled-generation';
import { approvalSnapshotHash, assertScheduledGenerationApproval, holdScheduledGenerationForApproval,
  ScheduledGenerationApprovalError } from '../services/aptlss-scheduled-approval';
import { runScheduledJob } from '../scheduledJobRuntime';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
const cardId = '111111111111111111111111';
const source = { id: cardId,name: 'Review synthetic scheduled report',desc: 'Review the provided evidence and record verified findings. '.repeat(3),
  idMembers: ['scheduled-native-member'],checklists: [] };
const plan = { summary: 'Review scheduled evidence',nextBestAction: 'Read evidence',stateReason: 'Evidence ready',urgencyLabel: 'HIGH',confidenceScore: 95,
  missingInformation: [],steps: ['Read evidence','Record findings'].map(title => ({ title,estimatedMinutes: 10,category: 'T',requiresFounder: false,
    blockedBy: null,completionCriteria: `${title} verified`,riskIfSkipped: 'Missing evidence',recommendedDecision: null })) };

describe.skipIf(!baseUrl)('scheduled generation approval (migrated isolated PG, real leases/adapter, synthetic CLI/Trello)', { timeout: 15000 }, () => {
  let fixture: FinancialDatabase;
  let actor: typeof schema.users.$inferSelect;
  let other: typeof schema.users.$inferSelect;
  let profileId: number;
  const bridges: Array<Awaited<ReturnType<typeof codexLlmFixture>>> = [];
  beforeAll(async () => {
    requireIsolatedPostgresTestDatabase(baseUrl,process.env.NODE_ENV === 'production');
    fixture = await createFinancialDatabase(baseUrl); controls.db = fixture.db;
    expect((await fixture.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(fixture.name);
    [actor,other] = await fixture.db.insert(schema.users).values([
      { openId: 'scheduled-native-founder',role: 'admin' },{ openId: 'scheduled-native-other',role: 'admin' },
    ]).returning();
    const [worker] = await fixture.db.insert(schema.users).values({ openId: 'scheduled-native-worker',role: 'worker' }).returning();
    const [profile] = await fixture.db.insert(schema.vaProfiles).values({ userId: worker.id,founderId: actor.id,name: 'Synthetic scheduled worker',
      status: 'active',trelloMemberId: 'scheduled-native-member' }).returning();
    profileId = profile.id;
    await fixture.db.insert(schema.taskAssignments).values({ taskId: cardId,vaId: profileId,founderId: actor.id,assignedBy: actor.id,status: 'assigned' });
  },120000);
  beforeEach(async () => {
    [actor] = await fixture.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.openId,'scheduled-native-founder')).returning();
    await fixture.db.delete(schema.scheduledJobRuns); await fixture.db.delete(schema.scheduledJobLeases);
    await fixture.db.delete(schema.generationItems); await fixture.db.delete(schema.generationJobs); await fixture.db.delete(schema.scheduledJobs);
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS',String(profileId+100000)); vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY','true');
    vi.stubEnv('TRELLO_API_KEY','synthetic-key'); vi.stubEnv('TRELLO_TOKEN','synthetic-token');
    controls.trello.mockReset().mockImplementation(() => { throw new Error('Unexpected Trello checklist operation'); });
    vi.stubGlobal('fetch',vi.fn(async (raw: string | URL | Request,init?: RequestInit) => {
      const url = new URL(String(raw)); expect(url.hostname).toBe('api.trello.com'); expect(url.pathname).toBe(`/1/cards/${cardId}`);
      expect(init?.method ?? 'GET').toBe('GET'); return Response.json(source);
    }));
  });
  afterEach(async () => {
    try { for (const bridge of bridges.splice(0)) await bridge.close(); }
    finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); controls.trello.mockReset(); }
  });
  afterAll(async () => { controls.db = undefined; await fixture?.close(); });
  function app(snapshot = actor) {
    const value = express(); value.use(express.json());
    value.use((req,_res,next) => { (req as any).user = { ...snapshot }; next(); });
    value.use('/api',router); return value;
  }
  async function create(applyToTrello = false) {
    const scheduledTime = new Date(Date.now()+60_000).toISOString();
    const response = await request(app()).post('/api/aptlss/schedule').send({ cardIds: [cardId],scheduledTime,
      settings: { applyToTrello,maxRetries: 1 } }).expect(200);
    return (await fixture.db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.id,response.body.jobId)))[0];
  }
  async function stored(id: string) { return (await fixture.db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.id,id)))[0]; }
  // An explicit due cutoff exercises the real scheduler without sleeping or modifying the signed schedule time.
  const dueCutoff = () => new Date(Date.now()+120_000);
  async function bridge(options: { holdLogin?: boolean; holdTurn?: boolean } = {}) {
    const value = await codexLlmFixture({ holdLogin: options.holdLogin,turns: [{ answer: JSON.stringify(plan),hold: options.holdTurn }] });
    bridges.push(value); return value;
  }
  async function revoke(kind: string) {
    if (kind === 'role') await fixture.db.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id,actor.id));
    else await fixture.pool.query('UPDATE users SET "sessionEpoch"="sessionEpoch"+1 WHERE id=$1',[actor.id]);
  }

  it('binds a fresh creator and successfully runs the unchanged approved schedule with real lease persistence', async () => {
    const row = await create(), cli = await bridge();
    expect(row).toMatchObject({ approvedByUserId: actor.id,approvedSessionEpoch: actor.sessionEpoch,status: 'pending' });
    expect(row.approvedAt).toBeInstanceOf(Date); expect(row.approvalHash).toBe(approvalSnapshotHash(row));
    const result = await processDueAptlssGenerationJobs(dueCutoff());
    expect(result).toMatchObject({ processed: 1,failed: 0,awaitingApproval: 0 });
    expect(await stored(row.id)).toMatchObject({ status: 'needs_review',approvalHash: row.approvalHash });
    const items = await fixture.db.select().from(schema.generationItems).where(eq(schema.generationItems.jobId,row.id));
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ cardId,status: 'needs_review',attempts: 1 });
    expect(JSON.parse(items[0].result!)).toMatchObject({ success: true,appliedToTrello: false,
      validation: { confidenceScore: 72,passed: true,needsReview: true } });
    expect(await cli.calls()).toHaveLength(1); expect(controls.trello).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.scheduledJobLeases)).toEqual([]);
    expect(await fixture.db.select().from(schema.scheduledJobRuns)).toMatchObject([{ status: 'success' }]);
  });

  it.each(['role','epoch'])('holds a %s-revoked creator before due work without dispatching any provider', async kind => {
    const row = await create(); await revoke(kind);
    expect(await processDueAptlssGenerationJobs(dueCutoff())).toMatchObject({ processed: 0,awaitingApproval: 1 });
    expect(await stored(row.id)).toMatchObject({ status: 'awaiting_approval',approvalHash: row.approvalHash });
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.generationItems)).toEqual([]);
  });

  it.each(['role','epoch'])('holds %s revocation during actual CLI readiness with zero completion dispatch', async kind => {
    const row = await create(), cli = await bridge({ holdLogin: true });
    const pending = processDueAptlssGenerationJobs(dueCutoff());
    try { await cli.waitFile('login-ready'); await revoke(kind); }
    finally { await cli.release('allow-login'); await pending; }
    expect(await cli.calls()).toEqual([]); expect(controls.trello).not.toHaveBeenCalled();
    expect(await stored(row.id)).toMatchObject({ status: 'awaiting_approval',approvalHash: row.approvalHash });
    expect(await fixture.db.select().from(schema.atisChecklistSync)).toEqual([]);
    expect((await fixture.db.select().from(schema.generationItems)).some(item => ['completed','needs_review'].includes(item.status))).toBe(false);
  });

  it('rejects epoch revocation after actual inference starts and retains the unknown fence without Trello writes', async () => {
    const row = await create(true), cli = await bridge({ holdTurn: true });
    const pending = processDueAptlssGenerationJobs(dueCutoff());
    try { await cli.waitFile('calls.jsonl'); await revoke('epoch'); }
    finally { await cli.release('allow-turn'); await pending; }
    expect(await cli.calls()).toHaveLength(1); expect(controls.trello).not.toHaveBeenCalled();
    expect(await stored(row.id)).toMatchObject({ status: 'awaiting_approval',approvalHash: row.approvalHash });
    expect(await fixture.db.select().from(schema.generationItems)).toMatchObject([{ jobId: row.id,cardId,status: 'outcome_unknown',result: null }]);
    expect(await fixture.db.select().from(schema.atisChecklistSync)).toEqual([]);
  });

  it('retains all-null legacy proof, enforces partial-tuple SQLSTATE 23514, holds legacy execution, then explicitly reapproves and cancels without history loss', async () => {
    const id = 'native-legacy-schedule', settings = JSON.stringify({ applyToTrello: false,legacyUi: { retained: true } });
    await fixture.db.insert(schema.scheduledJobs).values({ id,cardIds: JSON.stringify([cardId]),settings,
      scheduledTime: new Date(Date.now()-60_000),createdBy: actor.openId,status: 'pending' });
    expect(await stored(id)).toMatchObject({ approvedByUserId: null,approvedSessionEpoch: null,approvedAt: null,approvalHash: null });
    for (const [column,value] of [['approvedByUserId',actor.id],['approvedSessionEpoch',actor.sessionEpoch],['approvedAt',new Date()],['approvalHash','a'.repeat(64)]]) {
      // Column names are a fixed literal test set, never external input.
      const query = column === 'approvedByUserId' ? 'UPDATE scheduled_jobs SET "approvedByUserId"=$1 WHERE id=$2'
        : column === 'approvedSessionEpoch' ? 'UPDATE scheduled_jobs SET "approvedSessionEpoch"=$1 WHERE id=$2'
        : column === 'approvedAt' ? 'UPDATE scheduled_jobs SET "approvedAt"=$1 WHERE id=$2'
        : 'UPDATE scheduled_jobs SET "approvalHash"=$1 WHERE id=$2';
      await expect(fixture.pool.query(query,[value,id])).rejects.toHaveProperty('code','23514');
    }
    await fixture.db.insert(schema.generationItems).values(['completed','needs_review','outcome_unknown'].map((status,i) => ({
      id: `legacy-progress-${i}`,jobId: id,cardId,status,cardName: 'Synthetic historical source',attempts: 1,
    })));
    const history = await fixture.db.select().from(schema.generationItems).orderBy(schema.generationItems.id);
    expect(await processDueAptlssGenerationJobs()).toMatchObject({ processed: 0,awaitingApproval: 1 });
    expect(await stored(id)).toMatchObject({ status: 'awaiting_approval',approvedByUserId: null,approvedSessionEpoch: null,approvedAt: null,approvalHash: null });
    const client = request(app()), preview = await client.get(`/api/aptlss/scheduled/${id}/approval`).expect(200);
    expect(preview.body.approval).toMatchObject({ jobId: id,settings: JSON.parse(settings),
      progress: { completed: 1,needsReview: 1,outcomeUnknown: 1 } });
    await client.post(`/api/aptlss/scheduled/${id}/approval`).send({ expectedSnapshotHash: preview.body.approval.expectedSnapshotHash,
      scheduledTime: new Date(Date.now()+3_600_000).toISOString() }).expect(200);
    const approved = await stored(id);
    expect(approved).toMatchObject({ status: 'pending',settings,approvedByUserId: actor.id,approvedSessionEpoch: actor.sessionEpoch });
    expect(approved.approvalHash).toBe(approvalSnapshotHash(approved));
    await client.delete(`/api/aptlss/scheduled/${id}`).expect(200);
    expect(await stored(id)).toMatchObject({ status: 'cancelled',approvalHash: approved.approvalHash });
    expect(await fixture.db.select().from(schema.generationItems).orderBy(schema.generationItems.id)).toEqual(history);
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('hides a same-openId schedule bound to a different UID from preview, reapproval, list and cancellation', async () => {
    const row = await create();
    const changed = { ...row,approvedByUserId: other.id,approvedSessionEpoch: other.sessionEpoch };
    await fixture.db.update(schema.scheduledJobs).set({ approvedByUserId: other.id,approvedSessionEpoch: other.sessionEpoch,
      approvalHash: approvalSnapshotHash(changed) }).where(eq(schema.scheduledJobs.id,row.id));
    const client = request(app());
    await client.get(`/api/aptlss/scheduled/${row.id}/approval`).expect(404);
    await client.post(`/api/aptlss/scheduled/${row.id}/approval`).send({ expectedSnapshotHash: 'a'.repeat(64),
      scheduledTime: new Date(Date.now()+3_600_000).toISOString() }).expect(404);
    await client.delete(`/api/aptlss/scheduled/${row.id}`).expect(404);
    expect((await client.get('/api/aptlss/scheduled').expect(200)).body).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('waits on an actual concurrent row update and rejects the stale preview with 409 instead of approving changed inputs', async () => {
    const row = await create(), client = request(app());
    const preview = await client.get(`/api/aptlss/scheduled/${row.id}/approval`).expect(200);
    const blocker = await fixture.pool.connect();
    let pending: Promise<request.Response> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE scheduled_jobs SET settings=$1 WHERE id=$2',[JSON.stringify({ applyToTrello: true }),row.id]);
      pending = client.post(`/api/aptlss/scheduled/${row.id}/approval`).send({ expectedSnapshotHash: preview.body.approval.expectedSnapshotHash,
        scheduledTime: new Date(Date.now()+3_600_000).toISOString() }).then(value => value);
      await vi.waitFor(async () => {
        const waiting = await fixture.pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query ILIKE '%scheduled_jobs%'`);
        expect(waiting.rows.length).toBeGreaterThan(0);
      },{ timeout: 5000 });
      await blocker.query('COMMIT');
      expect((await pending).status).toBe(409);
      expect(await stored(row.id)).toMatchObject({ settings: JSON.stringify({ applyToTrello: true }),approvalHash: row.approvalHash });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('concurrent keyed creates commit exactly one job, replay unchanged proof, and reject changed inputs or an oversized selection', async () => {
    const payload = { requestKey: '11111111-1111-4111-8111-111111111111',cardIds: [cardId],
      scheduledTime: new Date(Date.now()+3_600_000).toISOString(),settings: { applyToTrello: false,maxRetries: 1,
        clarifiedGoal: { objective: 'Review interview claims',evidence: [{ verified: false,text: 'Untrusted claim' }],constraints: { hours: 2 } } } };
    const client = request(app());
    const results = await Promise.all([client.post('/api/aptlss/schedule').send(payload),client.post('/api/aptlss/schedule').send(payload)]);
    expect(results.map(result => result.status)).toEqual([200,200]);
    expect(results[0].body.jobId).toBe(results[1].body.jobId);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false,true]);
    for (const result of results) expect(result.body).toMatchObject({ status: 'pending',reviewNeeded: false });
    const [row] = await fixture.db.select().from(schema.scheduledJobs);
    expect(row.id).toBe(results[0].body.jobId); expect(row.id).toHaveLength(64);
    const before = await fixture.db.select().from(schema.scheduledJobs);
    expect(before).toHaveLength(1);
    expect((await client.post('/api/aptlss/schedule').send(payload).expect(200)).body)
      .toMatchObject({ jobId: row.id,status: 'pending',replayed: true,reviewNeeded: false });
    expect(JSON.parse(row.settings).clarifiedGoal).toEqual(payload.settings.clarifiedGoal);
    const reordered = { ...payload,settings: { clarifiedGoal: { constraints: { hours: 2 },
      evidence: [{ text: 'Untrusted claim',verified: false }],objective: 'Review interview claims' },maxRetries: 1,applyToTrello: false } };
    expect((await client.post('/api/aptlss/schedule').send(reordered).expect(200)).body)
      .toMatchObject({ jobId: row.id,replayed: true });
    for (const changed of [{ cardIds: ['222222222222222222222222'] },{ settings: { applyToTrello: true } },
      { scheduledTime: new Date(Date.now()+7_200_000).toISOString() }]) {
      await client.post('/api/aptlss/schedule').send({ ...payload,...changed }).expect(409);
    }
    await client.post('/api/aptlss/schedule').send({ ...payload,requestKey: '22222222-2222-4222-8222-222222222222',
      cardIds: Array.from({ length: 251 },(_,i) => i.toString().padStart(24,'0')) }).expect(400);
    expect(await fixture.db.select().from(schema.scheduledJobs)).toEqual(before);
    for (const status of ['cancelled','completed','running']) {
      await fixture.db.update(schema.scheduledJobs).set({ status }).where(eq(schema.scheduledJobs.id,row.id));
      const advanced = await fixture.db.select().from(schema.scheduledJobs);
      expect((await client.post('/api/aptlss/schedule').send(payload).expect(200)).body)
        .toMatchObject({ jobId: row.id,status,replayed: true,reviewNeeded: false });
      expect(await fixture.db.select().from(schema.scheduledJobs)).toEqual(advanced);
    }
    const beforeRevocation = await fixture.db.select().from(schema.scheduledJobs);
    // Recovery reports revoked proof; it never refreshes the epoch or resets the existing state.
    await revoke('epoch');
    const [fresh] = await fixture.db.select().from(schema.users).where(eq(schema.users.id,actor.id));
    expect((await request(app(fresh)).post('/api/aptlss/schedule').send(payload).expect(409)).body)
      .toMatchObject({ success: false,jobId: row.id,status: 'running',replayed: true,reviewNeeded: true });
    expect(await fixture.db.select().from(schema.scheduledJobs)).toEqual(beforeRevocation);
    const otherResult = await request(app(other)).post('/api/aptlss/schedule').send(payload).expect(200);
    expect(otherResult.body.jobId).not.toBe(row.id);
    expect(await fixture.db.select().from(schema.scheduledJobs)).toHaveLength(2);
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('does not let an old worker hold clobber a fresh reapproval committed after its actual row-lock wait', async () => {
    const old = await create(); await revoke('epoch');
    await expect(assertScheduledGenerationApproval(old,fixture.db)).rejects.toMatchObject({ reason: 'creator_epoch_changed' });
    const [fresh] = await fixture.db.select().from(schema.users).where(eq(schema.users.id,actor.id));
    const replacement = { ...old,status: 'pending',scheduledTime: new Date(Date.now()+3_600_000),
      approvedSessionEpoch: fresh.sessionEpoch,approvedAt: new Date(),error: null,completedAt: null };
    replacement.approvalHash = approvalSnapshotHash(replacement);
    expect(replacement.approvalHash).not.toBe(old.approvalHash);
    const blocker = await fixture.pool.connect();
    let worker: ReturnType<typeof runScheduledJob> | undefined;
    let didHold: boolean | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[fresh.id]);
      await blocker.query('SELECT id FROM scheduled_jobs WHERE id=$1 FOR UPDATE',[old.id]);
      await blocker.query(`UPDATE scheduled_jobs SET status='pending',"scheduledTime"=$1,"approvedSessionEpoch"=$2,
        "approvedAt"=$3,"approvalHash"=$4,error=NULL,"completedAt"=NULL WHERE id=$5`,
      // Match Drizzle's UTC ISO encoding for timestamp-without-time-zone columns, not pg's host-local Date encoding.
      [replacement.scheduledTime.toISOString(),replacement.approvedSessionEpoch,replacement.approvedAt.toISOString(),replacement.approvalHash,old.id]);
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      worker = runScheduledJob({ jobKey: `aptlss-scheduled:${old.id}`,skipIfSuccessful: false,trigger: 'manual' },async lease => {
        didHold = await holdScheduledGenerationForApproval(old,new ScheduledGenerationApprovalError('creator_epoch_changed'),lease,fixture.db);
        return { recordsProcessed: 0 };
      });
      void worker.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await fixture.pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query ILIKE '%scheduled_jobs%' AND $1::int=ANY(pg_blocking_pids(pid))`,[pid]);
        expect(waiting.rows.length).toBeGreaterThan(0);
      },{ timeout: 5000 });
      await blocker.query('COMMIT');
      expect(await worker).toMatchObject({ state: 'success',recordsProcessed: 0 });
      expect(didHold).toBe(false);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (worker) await worker; }
    const after = await stored(old.id);
    expect(after).toEqual(replacement);
    await expect(assertScheduledGenerationApproval(after,fixture.db)).resolves.toMatchObject({ approvedSessionEpoch: fresh.sessionEpoch });
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.scheduledJobLeases)).toEqual([]);
  });

  it('recovers an approved orphan through real leases but retains its unknown item without source, CLI or Trello replay', async () => {
    const row = await create(true);
    await fixture.db.update(schema.scheduledJobs).set({ status: 'running' }).where(eq(schema.scheduledJobs.id,row.id));
    await fixture.db.insert(schema.generationJobs).values({ id: row.id,totalCards: 1,completedCards: 0,failedCards: 0,
      status: 'running',settings: row.settings,createdBy: actor.openId });
    await fixture.db.insert(schema.generationItems).values({ id: 'orphan-unknown-item',jobId: row.id,cardId,
      cardName: 'Synthetic interrupted source',status: 'outcome_unknown',attempts: 1,maxAttempts: 1,
      error: 'Prior Trello response was lost; manual verification required',result: null });
    const before = await fixture.db.select().from(schema.generationItems);
    const cli = await bridge();
    const result = await processDueAptlssGenerationJobs(dueCutoff());
    expect(result).toMatchObject({ processed: 1,failed: 0,awaitingApproval: 0 });
    expect(await stored(row.id)).toMatchObject({ status: 'completed_with_errors',approvalHash: row.approvalHash,
      error: '1 card(s) failed; inspect generation history.' });
    const [history] = await fixture.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id,row.id));
    expect(history).toMatchObject({ status: 'completed_with_errors',totalCards: 1,completedCards: 0,failedCards: 1 });
    expect(history.completedAt).toBeInstanceOf(Date);
    expect(await fixture.db.select().from(schema.generationItems)).toEqual(before);
    expect(await cli.calls()).toEqual([]); expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.atisChecklistSync)).toEqual([]);
    expect(await fixture.db.select().from(schema.scheduledJobLeases)).toEqual([]);
    const runs = await fixture.db.select().from(schema.scheduledJobRuns).orderBy(schema.scheduledJobRuns.id);
    expect(runs).toHaveLength(2); expect(runs.map(run => run.status)).toEqual(['success','success']);
    expect(runs[0].jobKey).toBe(runs[1].jobKey);
  });
});
