import express from 'express';
import request from 'supertest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';
import { codexLlmFixture } from '../test/codexLlmFixture';

const controls = vi.hoisted(() => ({ db: undefined as any, trello: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: controls.trello }));
import router, { generationRequestContext } from './aptlss';

const actor = { id: 7,openId: 'synthetic-founder',role: 'admin',sessionEpoch: '1' };
const source = { id: 'syntheticcard0001',name: 'Review the report',desc: 'Read the supplied report and record the reviewed findings. '.repeat(3),checklists: [] };
const plan = { summary: 'Review',nextBestAction: 'Read report',stateReason: 'Report ready',urgencyLabel: 'HIGH',confidenceScore: 90,
  missingInformation: [],steps: [
    { title: 'Read report',estimatedMinutes: 10,category: 'T',requiresFounder: false,blockedBy: null,completionCriteria: 'Report read',riskIfSkipped: 'Missing evidence',recommendedDecision: null },
    { title: 'Record findings',estimatedMinutes: 10,category: 'T',requiresFounder: false,blockedBy: null,completionCriteria: 'Findings recorded',riskIfSkipped: 'Lost findings',recommendedDecision: null },
  ] };
let store: ReturnType<typeof timerTestDatabase>;
const bridges: Array<Awaited<ReturnType<typeof codexLlmFixture>>> = [];
async function bridge(options: { holdLogin?: boolean; holdTurn?: boolean } = {}) {
  const f = await codexLlmFixture({ holdLogin: options.holdLogin,turns: [{ answer: JSON.stringify(plan),hold: options.holdTurn }] });
  bridges.push(f); return f;
}
function app(snapshot: typeof actor | null = actor) {
  const value = express(); value.use(express.json());
  value.use((req,_res,next) => { (req as any).user = snapshot && { ...snapshot }; next(); });
  value.use('/api',router); return value;
}
function mutate(change: string) {
  const row = store.rows.get(users)![0];
  if (change === 'deleted') store.rows.set(users,[]);
  else if (change === 'role') row.role = 'user';
  else row.sessionEpoch = '2';
}
beforeEach(() => {
  store = timerTestDatabase(new Map([[users,[{ ...actor }]]])); controls.db = store.db;
  controls.trello.mockReset();
  vi.stubEnv('TRELLO_API_KEY','fixture-key'); vi.stubEnv('TRELLO_TOKEN','fixture-token');
  vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS',''); vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY','');
  vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify(source))));
  vi.spyOn(console,'log').mockImplementation(() => {}); vi.spyOn(console,'error').mockImplementation(() => {});
});
afterEach(async () => { for (const f of bridges.splice(0)) await f.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('mounted APTLSS generation authority (actual subscription transport, synthetic CLI/DB/Trello)', () => {
  it('uses a supplied transaction reader without opening another identity transaction or retaining account locks', async () => {
    const req = Object.assign(new EventEmitter(),{ user: { ...actor } });
    const res = Object.assign(new EventEmitter(),{ writableEnded: false });
    const operation = generationRequestContext(req as any,res as any);
    let locked = false;
    const select = store.db.select;
    const reader = { select: (...args: any[]) => {
      const query = select(...args);
      query.for = () => { locked = true; throw new Error('A provider-spanning checkpoint must not retain identity locks'); };
      return query;
    } };
    store.db.transaction.mockImplementation(() => { throw new Error('Nested checkout must not occur'); });
    try {
      await operation.context.assertOwnership(reader as any);
      expect(store.db.transaction).not.toHaveBeenCalled(); expect(locked).toBe(false);
      mutate('epoch');
      await expect(operation.context.assertOwnership(reader as any)).rejects.toHaveProperty('name','ScheduledJobLeaseLostError');
      expect(operation.failureStatus).toBe(403); expect(store.db.transaction).not.toHaveBeenCalled();
    } finally { operation.dispose(); }
  });

  it.each([null,{ ...actor,role: 'worker' }])('rejects unauthorized request snapshots before transport', async snapshot => {
    await request(app(snapshot)).post('/api/aptlss/generate').send({ cardId: source.id }).expect(snapshot ? 403 : 401);
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });

  it.each(['role','epoch','deleted'])('rejects fresh %s changes while subscription readiness is paused with zero CLI calls or sync', async change => {
    const f = await bridge({ holdLogin: true });
    const response = request(app()).post('/api/aptlss/generate').send({ cardId: source.id }).then(value => value);
    await f.waitFile('login-ready'); mutate(change); await f.release('allow-login');
    expect((await response).status).toBe(403);
    expect(await f.calls()).toEqual([]); expect(controls.trello).not.toHaveBeenCalled();
    expect(await readdir(join(f.root,'requests'))).toEqual([]);
  });

  it('rejects an epoch change after source retrieval before inference publication', async () => {
    const f = await bridge();
    vi.stubGlobal('fetch',vi.fn(async () => { mutate('epoch'); return new Response(JSON.stringify(source)); }));
    await request(app()).post('/api/aptlss/generate').send({ cardId: source.id }).expect(403);
    expect(await f.calls()).toEqual([]); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('does not apply a successful model result after admin revocation in flight', async () => {
    const f = await bridge({ holdTurn: true });
    const response = request(app()).post('/api/aptlss/generate').send({ cardId: source.id }).then(value => value);
    await f.waitFile('calls.jsonl'); mutate('role'); await f.release('allow-turn');
    expect((await response).status).toBe(403);
    expect(await f.calls()).toHaveLength(1); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('checks fresh authority after awaited checklist reads and before the first Trello mutation', async () => {
    const f = await bridge();
    controls.trello.mockImplementation(async (_url: string,init?: RequestInit) => {
      expect(init?.method).toBeUndefined(); mutate('epoch'); return new Response('[]');
    });
    await request(app()).post('/api/aptlss/generate').send({ cardId: source.id,settings: { validateBeforeGenerate: false } }).expect(403);
    expect(await f.calls()).toHaveLength(1); expect(controls.trello).toHaveBeenCalledTimes(1);
    const sql = store.db.execute.mock.calls.map(([query]: any[]) => new PgDialect().sqlToQuery(query).sql).join('\n');
    expect(sql).not.toContain('INSERT INTO atis_checklist_sync');
  });

  it('stops after an in-flight checklist creation loses authority, without adding items or claiming completion', async () => {
    await bridge();
    controls.trello.mockImplementation(async (_url: string,init?: RequestInit) => {
      if (init?.method === 'POST') { mutate('epoch'); return new Response(JSON.stringify({ id: 'created-before-revocation',name: 'Staged' })); }
      return new Response('[]');
    });
    const response = await request(app()).post('/api/aptlss/generate').send({ cardId: source.id,settings: { validateBeforeGenerate: false } }).expect(403);
    expect(response.body.success).not.toBe(true);
    expect(controls.trello.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(1);
    const sql = store.db.execute.mock.calls.map(([query]: any[]) => new PgDialect().sqlToQuery(query).sql).join('\n');
    expect(sql).not.toContain('INSERT INTO atis_checklist_sync');
  });

  it('preserves successful dry generation through the actual subscription adapter', async () => {
    const f = await bridge();
    const response = await request(app()).post('/api/aptlss/generate').send({ cardData: source }).expect(200);
    expect(response.body).toMatchObject({ success: true,cardId: source.id,appliedToTrello: false,aptlss: { summary: 'Review' } });
    expect(await f.calls()).toHaveLength(1); expect(controls.trello).not.toHaveBeenCalled();
    expect(store.db.transaction).toHaveBeenCalled();
  });

  it('preserves successful generation and verified checklist synchronization for the unchanged admin', async () => {
    const f = await bridge();
    const remote: Array<{ id: string; name: string; checkItems: Array<{ id: string; name: string; state: string }> }> = [];
    controls.trello.mockImplementation(async (raw: string,init?: RequestInit) => {
      const url = new URL(raw);
      if (!init?.method) return new Response(JSON.stringify(remote));
      const body = JSON.parse(String(init.body ?? '{}'));
      if (url.pathname.endsWith('/checklists') && init.method === 'POST') {
        const created = { id: 'checklist0001',name: body.name,checkItems: [] };
        remote.push(created); return new Response(JSON.stringify(created));
      }
      if (url.pathname.endsWith('/checkItems') && init.method === 'POST') {
        const created = { id: `checkitem${remote[0].checkItems.length}`,name: body.name,state: 'incomplete' };
        remote[0].checkItems.push(created); return new Response(JSON.stringify(created));
      }
      if (init.method === 'PUT') { remote[0].name = url.searchParams.get('name')!; return new Response(JSON.stringify(remote[0])); }
      throw new Error('Unexpected synthetic Trello write');
    });
    const response = await request(app()).post('/api/aptlss/generate')
      .send({ cardId: source.id,settings: { validateBeforeGenerate: false } }).expect(200);
    expect(response.body).toMatchObject({ success: true,appliedToTrello: true,itemsCreated: 2,checklistId: 'checklist0001' });
    expect(remote[0].checkItems).toHaveLength(2); expect(await f.calls()).toHaveLength(1);
    const sql = store.db.execute.mock.calls.map(([query]: any[]) => new PgDialect().sqlToQuery(query).sql).join('\n');
    expect(sql).toContain('INSERT INTO atis_checklist_sync');
  });

  it('cancels queued transport on HTTP disconnect and stops the readiness child without dispatching', async () => {
    const f = await bridge({ holdLogin: true });
    const call = request(app()).post('/api/aptlss/generate').send({ cardId: source.id });
    const response = call.then(() => undefined,error => error);
    await f.waitFile('login-ready');
    const pid = Number(await readFile(join(f.work,'login-ready'),'utf8'));
    call.abort(); await response;
    await vi.waitFor(async () => expect(await readdir(join(f.root,'requests'))).toEqual([]));
    await vi.waitFor(() => expect(() => process.kill(pid,0)).toThrow(),{ timeout: 5000 });
    expect(await f.calls()).toEqual([]); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('fails closed on identity-database failure without publishing model or Trello work', async () => {
    const f = await bridge(); controls.db = null;
    await request(app()).post('/api/aptlss/generate').send({ cardId: source.id }).expect(503);
    expect(await f.calls()).toEqual([]); expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });
});
