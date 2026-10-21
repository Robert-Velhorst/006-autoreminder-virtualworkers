import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../../shared/isolatedPostgresTestDatabase.mjs';
import { createFinancialDatabase, type FinancialDatabase } from '../test/financialDatabase';
import { codexLlmFixture } from '../test/codexLlmFixture';

const controls = vi.hoisted(() => ({ db: undefined as any, trello: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
vi.mock('../utils/retry', async original => ({ ...await original<typeof import('../utils/retry')>(),fetchWithRetry: controls.trello }));
import router from './aptlss';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
const cardId = '111111111111111111111111';
const source = { id: cardId,name: 'Review synthetic report',desc: 'Read the supplied report and record verified findings. '.repeat(3),
  idMembers: ['batch-fixture-member'],checklists: [] };
const plan = { summary: 'Review synthetic report',nextBestAction: 'Read report',stateReason: 'Report ready',urgencyLabel: 'HIGH',confidenceScore: 95,
  missingInformation: [],steps: ['Read report','Record findings'].map(title => ({ title,estimatedMinutes: 10,category: 'T',requiresFounder: false,
    blockedBy: null,completionCriteria: `${title} verified`,riskIfSkipped: 'Missing evidence',recommendedDecision: null })) };

describe.skipIf(!baseUrl)('mounted batch/history authority (isolated PostgreSQL, actual Codex adapter, synthetic CLI/Trello)', { timeout: 15000 }, () => {
  let fixture: FinancialDatabase;
  let founders: Array<typeof schema.users.$inferSelect>;
  let profileId: number;
  const bridges: Array<Awaited<ReturnType<typeof codexLlmFixture>>> = [];
  beforeAll(async () => {
    requireIsolatedPostgresTestDatabase(baseUrl,process.env.NODE_ENV === 'production');
    fixture = await createFinancialDatabase(baseUrl); controls.db = fixture.db;
    expect((await fixture.pool.query('SELECT current_database() AS name')).rows[0].name).toBe(fixture.name);
    await fixture.db.insert(schema.users).values([
      { openId: 'batch-founder-a',role: 'admin' },{ openId: 'batch-founder-b',role: 'admin' },
    ]);
    founders = await fixture.db.select().from(schema.users).orderBy(schema.users.id);
    const [worker] = await fixture.db.insert(schema.users).values({ openId: 'batch-worker',role: 'worker' }).returning();
    const [profile] = await fixture.db.insert(schema.vaProfiles).values({ userId: worker.id,founderId: founders[0].id,
      name: 'Synthetic batch worker',status: 'active',trelloMemberId: 'batch-fixture-member' }).returning();
    profileId = profile.id;
    await fixture.db.insert(schema.taskAssignments).values({ taskId: cardId,vaId: profile.id,founderId: founders[0].id,
      assignedBy: founders[0].id,status: 'assigned' });
  },120000);
  beforeEach(async () => {
    await fixture.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.openId,'batch-founder-a'));
    founders = await fixture.db.select().from(schema.users).where(eq(schema.users.role,'admin')).orderBy(schema.users.id);
    expect(founders).toHaveLength(2);
    // Stable retry IDs also share durable run keys. Reset only this test's owned database between cases.
    await fixture.db.delete(schema.scheduledJobRuns); await fixture.db.delete(schema.scheduledJobLeases);
    await fixture.db.delete(schema.generationItems); await fixture.db.delete(schema.generationJobs);
    await fixture.db.insert(schema.generationJobs).values(founders.map((founder,index) => ({
      id: `history-${index}`,totalCards: 1,failedCards: 1,status: 'completed_with_errors',
      settings: JSON.stringify({ applyToTrello: false,maxRetries: 1 }),createdBy: founder.openId,
    })));
    await fixture.db.insert(schema.generationItems).values([
      ...founders.map((_,index) => ({ id: `history-item-${index}`,jobId: `history-${index}`,cardId,
        cardName: `Private founder ${index} source`,status: 'failed',error: `Private founder ${index} error`,attempts: 1 })),
      { id: 'orphan-item',jobId: 'missing-history',cardId,cardName: 'Orphan private source',status: 'failed',attempts: 1 },
    ]);
    // Keep the real pilot ownership checks active; this worker is deliberately non-pilot.
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS',String(profileId+100000)); vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY','true');
    vi.stubEnv('TRELLO_API_KEY','synthetic-key'); vi.stubEnv('TRELLO_TOKEN','synthetic-token');
    controls.trello.mockReset().mockImplementation(() => { throw new Error('Unexpected Trello checklist operation'); });
    vi.stubGlobal('fetch',vi.fn(async (raw: string | URL | Request,init?: RequestInit) => {
      const url = new URL(String(raw));
      expect(url.hostname).toBe('api.trello.com'); expect(url.pathname).toBe(`/1/cards/${cardId}`);
      expect(init?.method ?? 'GET').toBe('GET');
      return Response.json(source);
    }));
  });
  afterEach(async () => {
    try { for (const bridge of bridges.splice(0)) await bridge.close(); }
    finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); controls.trello.mockReset(); }
  });
  afterAll(async () => { controls.db = undefined; await fixture?.close(); });
  function app(actor: typeof schema.users.$inferSelect) {
    const value = express(); value.use(express.json());
    // Authentication is outside this router; retain a stale authenticated snapshot to exercise fresh DB checks.
    value.use((req,_res,next) => { (req as any).user = { ...actor }; next(); });
    value.use('/api',router); return value;
  }
  async function bridge(holdLogin = false) {
    const value = await codexLlmFixture({ holdLogin,turns: [{ answer: JSON.stringify(plan) }] });
    bridges.push(value); return value;
  }
  async function historySnapshot() {
    return { jobs: await fixture.db.select().from(schema.generationJobs).orderBy(schema.generationJobs.id),
      items: await fixture.db.select().from(schema.generationItems).orderBy(schema.generationItems.id) };
  }

  it.each([0,1])('shows only founder %i history while preserving their detail and status APIs', async index => {
    const client = request(app(founders[index]));
    const list = await client.get('/api/aptlss/history').expect(200);
    expect(list.body.map((job: { id: string }) => job.id)).toEqual([`history-${index}`]);
    const detail = await client.get(`/api/aptlss/history/history-${index}`).expect(200);
    expect(detail.body).toMatchObject({ id: `history-${index}`,createdBy: founders[index].openId,
      items: [{ id: `history-item-${index}`,cardName: `Private founder ${index} source` }] });
    const status = await client.get(`/api/aptlss/status/history-${index}`).expect(200);
    expect(status.body).toMatchObject({ jobId: `history-${index}`,status: 'completed_with_errors',progress: { total: 1,completed: 0,failed: 1 } });
  });

  it.each([0,1])('gives founder %i identical foreign/missing 404s without work or history mutation', async index => {
    const before = await historySnapshot(), client = request(app(founders[index]));
    for (const kind of ['detail','status','retry']) {
      const invoke = (id: string) => kind === 'retry' ? client.post(`/api/aptlss/history/${id}/retry`).send({})
        : client.get(kind === 'status' ? `/api/aptlss/status/${id}` : `/api/aptlss/history/${id}`);
      const foreign = await invoke(`history-${1-index}`).expect(404);
      const missing = await invoke('missing-history').expect(404);
      expect(foreign.body).toEqual(missing.body); expect(foreign.body).toEqual({ error: 'Job not found' });
    }
    expect(await historySnapshot()).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('retries only the owner failed items and persists the successful dry result with its conservative evidence review', async () => {
    const cli = await bridge(), original = await historySnapshot();
    const response = await request(app(founders[0])).post('/api/aptlss/history/history-0/retry').send({}).expect(200);
    expect(response.body).toMatchObject({ success: true,completed: 1,failed: 0,needsReview: 1,
      results: [{ cardId,success: true,needsReview: true,appliedToTrello: false }] });
    expect(response.body.jobId).not.toBe('history-0');
    const [job] = await fixture.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id,response.body.jobId));
    expect(job).toMatchObject({ createdBy: founders[0].openId,status: 'needs_review',completedCards: 1,failedCards: 0 });
    const items = await fixture.db.select().from(schema.generationItems).where(eq(schema.generationItems.jobId,job.id));
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ cardId,status: 'needs_review',attempts: 1 });
    // Description is the sole evidence signal: 65 + 7 = 72, below the independent 98 review threshold.
    // Generation still passes the default minimum of 70; no evidence or confidence is fabricated.
    expect(JSON.parse(items[0].result!)).toMatchObject({ success: true,appliedToTrello: false,
      aptlss: { summary: plan.summary,confidenceScore: 72,needsReview: true,missingInformation: [] },
      validation: { confidenceScore: 72,minimumConfidence: 70,passed: true,needsReview: true,issues: [] } });
    const after = await historySnapshot();
    expect(after.jobs.filter(row => row.id.startsWith('history-'))).toEqual(original.jobs);
    expect(after.items.filter(row => row.id.startsWith('history-') || row.id === 'orphan-item')).toEqual(original.items);
    expect(await cli.calls()).toHaveLength(1); expect(controls.trello).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.atisChecklistSync)).toEqual([]);
  });

  it('persists completed_with_errors and truthful failed counts after an actual dry batch provider failure', async () => {
    const cli = await codexLlmFixture({ turns: [{ failure: 'provider offline' }] });
    bridges.push(cli);
    const response = await request(app(founders[0])).post('/api/aptlss/generate-batch')
      .send({ cardIds: [cardId],settings: { applyToTrello: false,maxRetries: 1 } }).expect(200);
    expect(response.body).toMatchObject({ total: 1,completed: 0,failed: 1,needsReview: 0,
      results: [{ cardId,success: false,error: expect.stringMatching(/inference unavailable/) }] });
    const [job] = await fixture.db.select().from(schema.generationJobs).where(eq(schema.generationJobs.id,response.body.jobId));
    expect(job).toMatchObject({ createdBy: founders[0].openId,status: 'completed_with_errors',totalCards: 1,completedCards: 0,failedCards: 1 });
    expect(job.completedAt).toBeInstanceOf(Date);
    const items = await fixture.db.select().from(schema.generationItems).where(eq(schema.generationItems.jobId,job.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ cardId,status: 'failed',attempts: 1,maxAttempts: 1,result: null,
      error: expect.stringMatching(/inference unavailable/) });
    const status = await request(app(founders[0])).get(`/api/aptlss/status/${job.id}`).expect(200);
    expect(status.body).toMatchObject({ status: 'completed_with_errors',progress: { total: 1,completed: 0,failed: 1 } });
    expect(await cli.calls()).toHaveLength(1);
    expect(controls.trello).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.atisChecklistSync)).toEqual([]);
  });

  it('repeating the original parent cannot bypass an uncertain child outcome with a fresh child or provider dispatch', async () => {
    await fixture.db.update(schema.generationJobs).set({ settings: JSON.stringify({ applyToTrello: true,maxRetries: 1 }) })
      .where(eq(schema.generationJobs.id,'history-0'));
    const cli = await bridge();
    controls.trello.mockImplementation(async (_raw: string,init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('Synthetic response loss after dispatch');
      return Response.json([]);
    });
    const client = request(app(founders[0]));
    const first = await client.post('/api/aptlss/history/history-0/retry').send({}).expect(200);
    expect(first.body).toMatchObject({ success: true,completed: 0,failed: 1,results: [{ cardId,success: false }] });
    const childId = first.body.jobId;
    expect(childId).toEqual(expect.any(String)); expect(childId).not.toBe('history-0');
    const before = await historySnapshot();
    const unknown = before.items.filter(item => item.jobId === childId);
    expect(unknown).toHaveLength(1); expect(unknown[0]).toMatchObject({ cardId,status: 'outcome_unknown',result: null });
    expect(await cli.calls()).toHaveLength(1);
    expect(controls.trello.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(1);
    const sourceCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const trelloCalls = controls.trello.mock.calls.length;
    // Retaining the canonical failed result or explicitly refusing it are both safe; a new attempt is not.
    const repeated = await client.post('/api/aptlss/history/history-0/retry').send({});
    expect([200,409]).toContain(repeated.status);
    if (repeated.status === 200) expect(repeated.body).toMatchObject({ jobId: childId,completed: 0,failed: 1,
      results: [{ cardId,success: false }] });
    else expect(repeated.body).toMatchObject({ jobId: childId,error: expect.any(String) });
    const after = await historySnapshot();
    expect(after.jobs.map(job => job.id)).toEqual(before.jobs.map(job => job.id));
    expect(after.items.filter(item => item.jobId === childId)).toEqual(unknown);
    expect(await cli.calls()).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(sourceCalls);
    expect(controls.trello).toHaveBeenCalledTimes(trelloCalls);
    expect(await fixture.db.select().from(schema.atisChecklistSync)).toEqual([]);
  });

  it('serializes concurrent retries of the original parent with a real PG lease and reuses its completed child', async () => {
    const cli = await codexLlmFixture({ turns: [{ answer: JSON.stringify(plan),hold: true }] }); bridges.push(cli);
    const client = request(app(founders[0]));
    const firstPending = client.post('/api/aptlss/history/history-0/retry').send({}).then(value => value);
    let first: Awaited<typeof firstPending>;
    let childId: string;
    try {
      await cli.waitFile('calls.jsonl');
      const snapshot = await historySnapshot();
      const children = snapshot.jobs.filter(job => !job.id.startsWith('history-'));
      expect(children).toHaveLength(1); childId = children[0].id;
      expect(children[0]).toMatchObject({ createdBy: founders[0].openId,status: 'running' });
      const activeRuns = await fixture.db.select().from(schema.scheduledJobRuns).where(eq(schema.scheduledJobRuns.status,'running'));
      expect(activeRuns).toHaveLength(1);
      const leases = await fixture.pool.query('SELECT "jobKey", "ownerToken", "leaseExpiresAt" > clock_timestamp() AS live FROM scheduled_job_leases');
      expect(leases.rows).toHaveLength(1);
      expect(leases.rows[0]).toMatchObject({ jobKey: activeRuns[0].jobKey,ownerToken: expect.any(String),live: true });
      const second = await client.post('/api/aptlss/history/history-0/retry').send({})
        .timeout({ response: 3000,deadline: 5000 }).expect(409);
      if (second.body.jobId !== undefined) expect(second.body.jobId).toBe(childId);
      expect(second.body.error).toEqual(expect.any(String));
      expect((await historySnapshot()).jobs.map(job => job.id)).toEqual(snapshot.jobs.map(job => job.id));
      expect(await fixture.db.select().from(schema.scheduledJobRuns)).toHaveLength(1);
      expect(await cli.calls()).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1); expect(controls.trello).not.toHaveBeenCalled();
    } finally {
      await cli.release('allow-turn'); first = await firstPending;
    }
    expect(first!.status).toBe(200);
    expect(first!.body).toMatchObject({ jobId: childId!,completed: 1,failed: 0,needsReview: 1 });
    const settled = await historySnapshot();
    expect(settled.jobs.find(job => job.id === childId!)).toMatchObject({ status: 'needs_review',completedCards: 1,failedCards: 0 });
    const providerReads = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const third = await client.post('/api/aptlss/history/history-0/retry').send({}).expect(200);
    expect(third.body).toMatchObject({ jobId: childId!,completed: 1,failed: 0,needsReview: 1,
      results: [{ cardId,success: true,needsReview: true,appliedToTrello: false }] });
    const replayed = await historySnapshot();
    expect(replayed.jobs.map(job => job.id)).toEqual(settled.jobs.map(job => job.id));
    expect(replayed.jobs.find(job => job.id === childId!)).toMatchObject({ createdBy: founders[0].openId,
      status: 'needs_review',totalCards: 1,completedCards: 1,failedCards: 0 });
    expect(replayed.items).toEqual(settled.items);
    expect(await cli.calls()).toHaveLength(1); expect(globalThis.fetch).toHaveBeenCalledTimes(providerReads);
    expect(controls.trello).not.toHaveBeenCalled(); expect(await fixture.db.select().from(schema.scheduledJobLeases)).toEqual([]);
  });

  it('roundtrips the existing scheduled partial-error status through the migrated PostgreSQL column', async () => {
    const id = 'scheduled-partial-error';
    await fixture.db.insert(schema.scheduledJobs).values({ id,cardIds: JSON.stringify([cardId]),
      scheduledTime: new Date('2026-10-21T09:00:00.000Z'),settings: JSON.stringify({ applyToTrello: false }),
      createdBy: founders[0].openId,status: 'running' });
    const completedAt = new Date('2026-10-21T09:01:00.000Z');
    await fixture.db.update(schema.scheduledJobs).set({ status: 'completed_with_errors',completedAt,
      error: '1 card failed during synthetic generation' }).where(eq(schema.scheduledJobs.id,id));
    const [stored] = await fixture.db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.id,id));
    expect(stored).toMatchObject({ id,status: 'completed_with_errors',completedAt,
      createdBy: founders[0].openId,error: '1 card failed during synthetic generation' });
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });

  it.each(['batch-role','batch-epoch','retry-role','retry-epoch'])('refuses queued %s revocation before actual CLI dispatch or checklist persistence', async scenario => {
    const cli = await bridge(true), client = request(app(founders[0]));
    const pending = (scenario.startsWith('batch')
      ? client.post('/api/aptlss/generate-batch').send({ cardIds: [cardId],settings: { applyToTrello: false,maxRetries: 1 } })
      : client.post('/api/aptlss/history/history-0/retry').send({})).then(value => value);
    try {
      await cli.waitFile('login-ready');
      if (scenario.endsWith('role')) await fixture.db.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id,founders[0].id));
      else await fixture.pool.query('UPDATE users SET "sessionEpoch"="sessionEpoch"+1 WHERE id=$1',[founders[0].id]);
    } finally { await cli.release('allow-login'); }
    const response = await pending;
    expect(response.status).toBe(403); expect(response.body.success).not.toBe(true);
    expect(await cli.calls()).toEqual([]); expect(controls.trello).not.toHaveBeenCalled();
    expect(await fixture.db.select().from(schema.atisChecklistSync)).toEqual([]);
    const after = await historySnapshot();
    expect(after.items.filter(item => !item.id.startsWith('history-') && item.id !== 'orphan-item')
      .some(item => item.status === 'completed' || item.status === 'needs_review')).toBe(false);
    expect(after.jobs.filter(job => !job.id.startsWith('history-')).some(job => job.status === 'completed')).toBe(false);
    for (const child of ['requests','replies','dispatch']) expect(await readdir(join(cli.root,child))).toEqual([]);
  });
});
