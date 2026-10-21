import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generationItems, scheduledJobs, users } from '../../drizzle/schema.postgres';
import { timerTestDatabase, type TestRow } from '../test/timerDatabase';
import { approvalSnapshotHash } from '../services/aptlss-scheduled-approval';

const controls = vi.hoisted(() => ({ db: undefined as any }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
import router from './aptlss';

const actor = { id: 7,openId: 'schedule-founder',role: 'admin',sessionEpoch: '3' };
const cardId = '111111111111111111111111';
const future = () => new Date(Date.now()+3_600_000).toISOString();
let store: ReturnType<typeof timerTestDatabase>;
beforeEach(() => {
  store = timerTestDatabase(new Map<unknown,TestRow[]>([[users,[{ ...actor }]],[scheduledJobs,[]],[generationItems,[]]]));
  const insert = store.db.insert.getMockImplementation()!;
  store.db.insert.mockImplementation((table: unknown) => {
    const builder = insert(table);
    return { values: (value: unknown) => {
      const query = builder.values(value); query.onConflictDoNothing = () => query; return query;
    } };
  });
  controls.db = store.db;
});
afterEach(() => { controls.db = undefined; vi.restoreAllMocks(); });
function app() {
  const value = express(); value.use(express.json());
  value.use((req,_res,next) => { (req as any).user = { ...actor }; next(); });
  value.use('/api',router); return value;
}
function legacy(status = 'awaiting_approval') {
  const row = { id: 'legacy-schedule',createdBy: actor.openId,cardIds: JSON.stringify([cardId]),
    settings: JSON.stringify({ applyToTrello: false,legacyUi: { retained: true } }),scheduledTime: new Date(Date.now()-60_000),
    status,createdAt: new Date(),completedAt: null,error: 'Approval required',
    approvedByUserId: null,approvedSessionEpoch: null,approvedAt: null,approvalHash: null };
  store.rows.get(scheduledJobs)!.push(row); return row;
}

describe('mounted scheduled generation approval routes (transactional synthetic DB)', () => {
  it('binds fresh account proof, whitelists only functional settings and ignores client-supplied proof', async () => {
    const scheduledTime = future();
    const response = await request(app()).post('/api/aptlss/schedule').send({ cardIds: [cardId],scheduledTime,
      approvedByUserId: 999,approvedSessionEpoch: '99',approvedAt: '2000-01-01',approvalHash: '0'.repeat(64),
      settings: { applyToTrello: false,skipExisting: true,replaceExisting: false,validateBeforeGenerate: true,
        minimumConfidence: 81,clarifiedGoal: 'Read the evidence',maxRetries: 2,scheduledJobs: [{ private: 'UI state' }],batchSize: 10 } }).expect(200);
    expect(response.body).toMatchObject({ success: true,jobId: expect.any(String) });
    const [row] = store.rows.get(scheduledJobs)!;
    expect(row).toMatchObject({ id: response.body.jobId,createdBy: actor.openId,approvedByUserId: actor.id,
      approvedSessionEpoch: actor.sessionEpoch,status: 'pending',scheduledTime: new Date(scheduledTime) });
    expect(row.approvedAt).toBeInstanceOf(Date); expect(row.approvalHash).toBe(approvalSnapshotHash(row as any));
    expect(JSON.parse(row.settings)).toEqual({ applyToTrello: false,skipExisting: true,replaceExisting: false,validateBeforeGenerate: true,
      minimumConfidence: 81,clarifiedGoal: 'Read the evidence',maxRetries: 2 });
  });

  it.each([[],[cardId,cardId],[cardId,42],[cardId,'../invalid'],Array.from({ length: 251 },(_,i) => i.toString().padStart(24,'0'))].map(cardIds => ({ cardIds })))(
    'rejects invalid/ambiguous/oversized selections without inserting', async ({ cardIds }) => {
      await request(app()).post('/api/aptlss/schedule').send({ cardIds,scheduledTime: future() }).expect(400);
      expect(store.rows.get(scheduledJobs)).toEqual([]);
    });

  it.each([{ maxRetries: 0 },{ maxRetries: 4 },{ minimumConfidence: -1 },{ minimumConfidence: 1.5 },
    { validateBeforeGenerate: 'true' },{ clarifiedGoal: 'x'.repeat(65_536) }])('rejects malformed or oversized functional settings %j', async settings => {
    await request(app()).post('/api/aptlss/schedule').send({ cardIds: [cardId],scheduledTime: future(),settings }).expect(400);
    expect(store.rows.get(scheduledJobs)).toEqual([]);
  });

  it.each(['2000-01-01T00:00:00.000Z','2026-10-21T10:00','2099-02-31T00:00:00Z','not-a-date',123])('requires an explicit future zoned time (%s)', async scheduledTime => {
    await request(app()).post('/api/aptlss/schedule').send({ cardIds: [cardId],scheduledTime }).expect(400);
    expect(store.rows.get(scheduledJobs)).toEqual([]);
  });

  it.each(['role','epoch'])('refuses stale creator %s before persistence', async change => {
    Object.assign(store.rows.get(users)![0],change === 'role' ? { role: 'user' } : { sessionEpoch: '4' });
    await request(app()).post('/api/aptlss/schedule').send({ cardIds: [cardId],scheduledTime: future() }).expect(403);
    expect(store.rows.get(scheduledJobs)).toEqual([]);
  });

  it('previews all-null legacy proof, preserves full legacy settings and item warnings, and explicitly approves without resetting history', async () => {
    const row = legacy();
    const items = ['completed','needs_review','outcome_unknown','failed'].map((status,i) => ({ id: `item-${i}`,jobId: row.id,cardId,status }));
    store.rows.set(generationItems,structuredClone(items));
    const client = request(app());
    const preview = await client.get(`/api/aptlss/scheduled/${row.id}/approval`).expect(200);
    expect(preview.body.approval).toMatchObject({ jobId: row.id,approvedByUserId: null,
      settings: JSON.parse(row.settings),expectedSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      progress: { total: 4,completed: 1,needsReview: 1,outcomeUnknown: 1,failed: 1 } });
    expect(preview.body.approval).not.toHaveProperty('approvalHash');
    expect(row.approvedAt).toBeNull(); expect(row.approvalHash).toBeNull();
    const scheduledTime = future();
    await client.post(`/api/aptlss/scheduled/${row.id}/approval`).send({ expectedSnapshotHash: preview.body.approval.expectedSnapshotHash,scheduledTime }).expect(200);
    expect(row).toMatchObject({ status: 'pending',approvedByUserId: actor.id,approvedSessionEpoch: actor.sessionEpoch,
      scheduledTime: new Date(scheduledTime) });
    expect(row.approvalHash).toBe(approvalSnapshotHash(row as any));
    expect(row.approvalHash).not.toBe(preview.body.approval.expectedSnapshotHash);
    expect(store.rows.get(generationItems)).toEqual(items);
  });

  it.each(['settings','cardIds','scheduledTime','status'])('rejects changed %s after preview without replacing proof or resetting history', async field => {
    const row = legacy('pending'), client = request(app());
    const preview = await client.get(`/api/aptlss/scheduled/${row.id}/approval`).expect(200);
    Object.assign(row,{ [field]: field === 'scheduledTime' ? new Date(Date.now()+7_200_000)
      : field === 'cardIds' ? JSON.stringify(['222222222222222222222222']) : field === 'settings' ? '{"applyToTrello":true}' : 'running' });
    await client.post(`/api/aptlss/scheduled/${row.id}/approval`).send({ expectedSnapshotHash: preview.body.approval.expectedSnapshotHash,scheduledTime: future() }).expect(409);
    expect(store.rows.get(scheduledJobs)![0].approvalHash).toBeNull();
  });

  it('hides foreign owners and different bound UIDs uniformly, including same-openId replacement accounts', async () => {
    const row = legacy(); row.approvedByUserId = 99 as any;
    const client = request(app());
    await client.get(`/api/aptlss/scheduled/${row.id}/approval`).expect(404);
    await client.post(`/api/aptlss/scheduled/${row.id}/approval`).send({ expectedSnapshotHash: 'a'.repeat(64),scheduledTime: future() }).expect(404);
    await client.delete(`/api/aptlss/scheduled/${row.id}`).expect(404);
    expect((await client.get('/api/aptlss/scheduled').expect(200)).body).toEqual([]);
    row.approvedByUserId = null; row.createdBy = 'foreign-founder';
    await client.get(`/api/aptlss/scheduled/${row.id}/approval`).expect(404);
  });

  it.each(['pending','awaiting_approval','running'])('cancels only eligible %s state', async status => {
    const row = legacy(status);
    await request(app()).delete(`/api/aptlss/scheduled/${row.id}`).expect(status === 'running' ? 409 : 200);
    expect(store.rows.get(scheduledJobs)![0].status).toBe(status === 'running' ? 'running' : 'cancelled');
  });

  it('returns the same keyed schedule without mutating approval and requires review after a global epoch change', async () => {
    const payload = { requestKey: '11111111-1111-4111-8111-111111111111',cardIds: [cardId],scheduledTime: future(),settings: { applyToTrello: false } };
    const client = request(app()), first = await client.post('/api/aptlss/schedule').send(payload).expect(200);
    const before = structuredClone(store.rows.get(scheduledJobs));
    expect(first.body).toMatchObject({ status: 'pending',replayed: false,reviewNeeded: false });
    await client.post('/api/aptlss/schedule').send(payload).expect(200,{ ...first.body,replayed: true });
    expect(store.rows.get(scheduledJobs)).toEqual(before);
    store.rows.get(users)![0].sessionEpoch = '4';
    const refreshed = express(); refreshed.use(express.json());
    refreshed.use((req,_res,next) => { (req as any).user = { ...actor,sessionEpoch: '4' }; next(); }); refreshed.use('/api',router);
    const revokedReplay = await request(refreshed).post('/api/aptlss/schedule').send(payload).expect(409);
    expect(revokedReplay.body).toMatchObject({ success: false,jobId: first.body.jobId,status: 'pending',replayed: true,reviewNeeded: true });
    expect(store.rows.get(scheduledJobs)).toEqual(before);
    await request(refreshed).post('/api/aptlss/schedule').send({ ...payload,settings: { applyToTrello: true } }).expect(409);
    expect(store.rows.get(scheduledJobs)).toEqual(before);
  });

  it.each(['cancelled','completed','running','needs_review'])('reports the actual existing %s status on keyed replay without restarting it', async status => {
    const payload = { requestKey: '33333333-3333-4333-8333-333333333333',cardIds: [cardId],scheduledTime: future() };
    const client = request(app()), first = await client.post('/api/aptlss/schedule').send(payload).expect(200);
    store.rows.get(scheduledJobs)![0].status = status;
    const before = structuredClone(store.rows.get(scheduledJobs));
    const replay = await client.post('/api/aptlss/schedule').send(payload).expect(200);
    expect(replay.body).toMatchObject({ success: true,jobId: first.body.jobId,status,replayed: true,reviewNeeded: false });
    expect(store.rows.get(scheduledJobs)).toEqual(before);
  });

  it('preserves structured interview goals and replays the same canonical JSON across object key order', async () => {
    const goal = { objective: 'Review untrusted interview input',evidence: [{ text: 'A claimed source',verified: false }],
      constraints: { hours: 2,approvalRequired: true },extraFunctionalField: ['retain',null,42] };
    const payload = { requestKey: '44444444-4444-4444-8444-444444444444',cardIds: [cardId],scheduledTime: future(),
      settings: { clarifiedGoal: goal,applyToTrello: false } };
    const client = request(app()), created = await client.post('/api/aptlss/schedule').send(payload).expect(200);
    const before = structuredClone(store.rows.get(scheduledJobs));
    expect(JSON.parse(before![0].settings).clarifiedGoal).toEqual(goal);
    const reordered = { extraFunctionalField: ['retain',null,42],constraints: { approvalRequired: true,hours: 2 },
      evidence: [{ verified: false,text: 'A claimed source' }],objective: goal.objective };
    expect((await client.post('/api/aptlss/schedule').send({ ...payload,settings: { applyToTrello: false,clarifiedGoal: reordered } }).expect(200)).body)
      .toMatchObject({ jobId: created.body.jobId,replayed: true });
    expect(store.rows.get(scheduledJobs)).toEqual(before);
  });

  it.each(['depth','nodes','type'])('rejects excessive or non-goal JSON %s before persistence', async kind => {
    let clarifiedGoal: unknown = kind === 'nodes' ? Array(5001).fill(null) : 42;
    if (kind === 'depth') { clarifiedGoal = 'leaf'; for (let i=0;i<18;i++) clarifiedGoal = { nested: clarifiedGoal }; }
    await request(app()).post('/api/aptlss/schedule').send({ cardIds: [cardId],scheduledTime: future(),settings: { clarifiedGoal } }).expect(400);
    expect(store.rows.get(scheduledJobs)).toEqual([]);
  });
});
