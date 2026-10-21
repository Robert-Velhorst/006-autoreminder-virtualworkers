import express from 'express';
import request from 'supertest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generationJobs, generationItems, users, scheduledJobLeases, scheduledJobRuns } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';
import { codexLlmFixture } from '../test/codexLlmFixture';

const controls = vi.hoisted(() => ({ db: undefined as any, trello: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: controls.trello }));
import router from './aptlss';

const actor = { id: 7, openId: 'batch-owner', role: 'admin', sessionEpoch: '1' };
const foreign = { id: 8, openId: 'other-owner', role: 'admin', sessionEpoch: '1' };
const cards = ['syntheticcard0001', 'syntheticcard0002'];
const plan = { summary: 'Review evidence', nextBestAction: 'Read source', stateReason: 'Evidence supplied',
  urgencyLabel: 'HIGH', confidenceScore: 90, missingInformation: [], steps: [
    { title: 'Read source', estimatedMinutes: 10, category: 'T', requiresFounder: false,
      blockedBy: null, completionCriteria: 'Source read', riskIfSkipped: 'Missing evidence', recommendedDecision: null },
    { title: 'Record findings', estimatedMinutes: 10, category: 'T', requiresFounder: false,
      blockedBy: null, completionCriteria: 'Findings recorded', riskIfSkipped: 'Lost evidence', recommendedDecision: null },
  ] };
const bridges: Array<Awaited<ReturnType<typeof codexLlmFixture>>> = [];
let store: ReturnType<typeof timerTestDatabase>;
let reads: unknown[];
const dialect = new PgDialect();
function materialize(row: Record<string, any>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value?.queryChunks
    ? new Date(Date.now() + (dialect.sqlToQuery(value).sql.includes('interval') ? Number(dialect.sqlToQuery(value).params[0]) : 0)) : value]));
}
function ownsLease(row: Record<string, any>, condition: any) {
  const query = dialect.sqlToQuery(condition);
  return row.jobKey === query.params[0] && (query.params.length < 2 || row.ownerToken === query.params[1])
    && (!query.sql.includes('> clock_timestamp()') || row.leaseExpiresAt.getTime() > Date.now());
}

function app() {
  const value = express(); value.use(express.json());
  value.use((req, _res, next) => { (req as any).user = { ...actor }; next(); });
  value.use('/api', router); return value;
}
function job(id = 'owned-job', owner = actor.openId, settings: unknown = {}) {
  store.rows.get(generationJobs)!.push({ id, createdBy: owner, settings: JSON.stringify(settings),
    status: 'completed_with_errors', totalCards: 2, completedCards: 0, failedCards: 2, createdAt: new Date() });
  for (const [index, cardId] of cards.entries()) store.rows.get(generationItems)!.push({
    id: `${id}-item-${index}`, jobId: id, cardId, cardName: `Private ${owner}`, status: 'failed', attempts: 1,
  });
}
async function bridge(options: { holdLogin?: boolean; holdTurn?: boolean } = {}) {
  const fixture = await codexLlmFixture({ holdLogin: options.holdLogin,
    turns: cards.map((_, index) => ({ answer: JSON.stringify(plan), hold: index === 0 && options.holdTurn })) });
  bridges.push(fixture); return fixture;
}
function submit(mode: 'batch' | 'retry') {
  return request(app()).post(mode === 'batch' ? '/api/aptlss/generate-batch' : '/api/aptlss/history/owned-job/retry')
    .send(mode === 'batch' ? { cardIds: cards } : {});
}
function newItems() { return store.rows.get(generationItems)!.filter(row => row.jobId !== 'owned-job'); }

beforeEach(() => {
  store = timerTestDatabase(new Map<unknown, any[]>([
    [users, [{ ...actor }, { ...foreign }]], [generationJobs, []], [generationItems, []],
    [scheduledJobLeases, []], [scheduledJobRuns, []],
  ]));
  controls.db = store.db;
  // Add the real service's upsert contract to the transactional test row store.
  // SQL predicates remain evaluated by its shared structured predicate evaluator.
  const insert = store.db.insert;
  store.db.insert = vi.fn((table: any) => ({ values: (input: any) => {
    const row = materialize(input);
    const query = insert(table).values(row);
    return { ...query, onConflictDoUpdate: async ({ set }: { set: any }) => {
      const prior = store.rows.get(table)?.find(value => table === scheduledJobLeases ? value.jobKey === row.jobKey : value.id === row.id);
      // Preserve the production runtime's conditional atomic lease upsert.
      if (table === scheduledJobLeases && prior) {
        if (prior.leaseExpiresAt.getTime() <= Date.now()) Object.assign(prior, materialize(set));
      } else if (prior) await store.db.update(table).set(materialize(set)).where(eq(table.id, row.id));
      else await query.returning();
    } };
  } }));
  reads = [];
  const select = store.db.select;
  store.db.select = vi.fn((...args: any[]) => {
    const query = select(...args), from = query.from;
    query.from = (table: unknown) => {
      reads.push(table);
      if (table === scheduledJobLeases) {
        let condition: any;
        const values = () => (store.rows.get(table) ?? []).filter(row => ownsLease(row, condition))
          .map(row => args[0] ? Object.fromEntries(Object.entries(args[0]).map(([key, column]: [string, any]) => [key, row[column.name]])) : row);
        const leaseQuery: any = { where: (value: any) => { condition = value; return leaseQuery; },
          limit: () => leaseQuery, for: async () => values(),
          then: (resolve: any, reject: any) => Promise.resolve(values()).then(resolve, reject) };
        return leaseQuery;
      }
      return from(table);
    };
    return query;
  });
  const update = store.db.update;
  store.db.update = vi.fn((table: unknown) => ({ set: (input: any) => {
    const values = materialize(input);
    if (table !== scheduledJobLeases) {
      const query = update(table).set(values);
      query.catch = (reject: any) => Promise.resolve(query).catch(reject);
      return query;
    }
    return { where: async (condition: any) => {
      const rows = store.rows.get(table)!.filter(row => ownsLease(row, condition));
      rows.forEach(row => Object.assign(row, values)); return { rowCount: rows.length };
    } };
  } }));
  store.db.delete = vi.fn((table: unknown) => ({ where: async (condition: any) => {
    if (table !== scheduledJobLeases) throw new Error('Unexpected fixture deletion');
    const rows = store.rows.get(table)!;
    const retained = rows.filter(row => !ownsLease(row, condition)); store.rows.set(table, retained);
    return { rowCount: rows.length - retained.length };
  } }));
  vi.stubEnv('TRELLO_API_KEY', 'synthetic-key'); vi.stubEnv('TRELLO_TOKEN', 'synthetic-token');
  vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS', ''); vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY', '');
  vi.stubGlobal('fetch', vi.fn(async (raw: string) => new Response(JSON.stringify({
    id: new URL(raw).pathname.split('/').at(-1), name: 'Synthetic source', desc: 'Supplied source evidence. '.repeat(8), checklists: [],
  }))));
  controls.trello.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const fixture of bridges.splice(0)) await fixture.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('mounted batch and history request authority', () => {
  it('scopes list/detail/status to the creator and returns uniform missing/foreign responses without item reads', async () => {
    job(); job('foreign-job', foreign.openId);
    const list = await request(app()).get('/api/aptlss/history').expect(200);
    expect(list.body.map((row: any) => row.id)).toEqual(['owned-job']);
    expect((await request(app()).get('/api/aptlss/history/owned-job').expect(200)).body.items).toHaveLength(2);
    await request(app()).get('/api/aptlss/status/owned-job').expect(200);
    for (const prefix of ['/api/aptlss/history/', '/api/aptlss/status/']) {
      reads.length = 0;
      const other = await request(app()).get(prefix + 'foreign-job').expect(404);
      const missing = await request(app()).get(prefix + 'missing-job').expect(404);
      expect(other.body).toEqual(missing.body);
      expect(reads).not.toContain(generationItems);
    }
  });

  it('rejects foreign and missing retry parents before reading items, writing jobs or invoking providers', async () => {
    job('foreign-job', foreign.openId);
    const before = structuredClone([...store.rows.values()]);
    const other = await request(app()).post('/api/aptlss/history/foreign-job/retry').send({}).expect(404);
    const missing = await request(app()).post('/api/aptlss/history/missing-job/retry').send({}).expect(404);
    expect(other.body).toEqual(missing.body);
    expect(reads).not.toContain(generationItems);
    expect([...store.rows.values()]).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(controls.trello).not.toHaveBeenCalled();
  });

  it('preserves the retry response shape and original dry-run settings through the actual adapter', async () => {
    job('owned-job', actor.openId, { applyToTrello: false });
    const fixture = await bridge();
    const response = await submit('retry').expect(200);
    expect(response.body).toMatchObject({ success: true, jobId: expect.stringMatching(/^retry_/),
      itemsToRetry: 2, completed: 2, failed: 0,
      needsReview: 2,
      results: cards.map(cardId => ({ cardId, success: true, checklistId: null, needsReview: true, appliedToTrello: false })) });
    expect(response.body.jobId.length).toBeLessThanOrEqual(64);
    expect(await fixture.calls()).toHaveLength(2);
    expect(controls.trello).not.toHaveBeenCalled();
    expect(newItems().map(row => row.status)).toEqual(['needs_review', 'needs_review']);
  });

  it('keeps generated-but-not-applied review metadata when parent validation requires stronger evidence', async () => {
    job('owned-job', actor.openId, { minimumConfidence: 98 });
    store.rows.get(generationItems)!.splice(1);
    await bridge();
    const response = await submit('retry').expect(200);
    expect(response.body).toMatchObject({ completed: 1, failed: 0, needsReview: 1,
      results: [{ cardId: cards[0], success: true, checklistId: null, needsReview: true, appliedToTrello: false }] });
    expect(controls.trello).not.toHaveBeenCalled();
    expect(newItems()[0].status).toBe('needs_review');
  });

  it('preserves a successful owner retry and actual verified checklist application', async () => {
    job(); store.rows.get(generationItems)!.splice(1);
    const fixture = await bridge();
    const remote: Array<{ id: string; name: string; checkItems: Array<{ id: string; name: string; state: string }> }> = [];
    controls.trello.mockImplementation(async (raw: string, init?: RequestInit) => {
      const url = new URL(raw), body = JSON.parse(String(init?.body ?? '{}'));
      if (!init?.method) return new Response(JSON.stringify(remote));
      if (init.method === 'POST' && url.pathname.endsWith('/checklists')) {
        const checklist = { id: 'syntheticchecklist', name: body.name, checkItems: [] };
        remote.push(checklist); return new Response(JSON.stringify(checklist));
      }
      if (init.method === 'POST' && url.pathname.endsWith('/checkItems')) {
        const item = { id: `syntheticitem${remote[0].checkItems.length}`, name: body.name, state: 'incomplete' };
        remote[0].checkItems.push(item); return new Response(JSON.stringify(item));
      }
      if (init.method === 'PUT') {
        remote[0].name = url.searchParams.get('name')!; return new Response(JSON.stringify(remote[0]));
      }
      throw new Error('Unexpected synthetic checklist mutation');
    });
    const response = await submit('retry').expect(200);
    expect(response.body).toMatchObject({ completed: 1, failed: 0,
      results: [{ cardId: cards[0], success: true, checklistId: 'syntheticchecklist', appliedToTrello: true, needsReview: true }] });
    expect(remote[0].checkItems).toHaveLength(2);
    expect(await fixture.calls()).toHaveLength(1);
  });

  it('does not replay uncertain Trello outcomes when retrying the canonical failed job', async () => {
    job(); store.rows.get(generationItems)!.splice(1);
    const fixture = await bridge();
    controls.trello.mockImplementation(async (_raw: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('Synthetic response loss');
      return new Response('[]');
    });
    const result = await submit('retry').expect(200);
    expect(result.body).toMatchObject({ success: true, itemsToRetry: 1, completed: 0, failed: 1 });
    expect(newItems()).toMatchObject([{ status: 'outcome_unknown' }]);
    const before = (await fixture.calls()).length;
    const repeatedOriginal = await submit('retry').expect(200);
    expect(repeatedOriginal.body).toMatchObject({ jobId: result.body.jobId, completed: 0, failed: 1 });
    expect(await fixture.calls()).toHaveLength(before);
    expect(store.rows.get(generationJobs)).toHaveLength(2);
    expect(newItems()).toHaveLength(1);
    await request(app()).post(`/api/aptlss/history/${result.body.jobId}/retry`).send({}).expect(200, { message: 'No failed items to retry' });
    expect(await fixture.calls()).toHaveLength(before);
    expect(newItems()[0].status).toBe('outcome_unknown');
  });

  it('replays completed retry items through the original parent without another generation or child', async () => {
    job('owned-job', actor.openId, { applyToTrello: false });
    const fixture = await bridge();
    const first = await submit('retry').expect(200);
    const before = (await fixture.calls()).length;
    const repeated = await submit('retry').expect(200);
    expect(repeated.body).toEqual(first.body);
    expect(await fixture.calls()).toHaveLength(before);
    expect(store.rows.get(generationJobs)).toHaveLength(2);
    expect(newItems()).toHaveLength(2);
    expect(store.rows.get(scheduledJobRuns)).toHaveLength(2);
    expect(store.rows.get(scheduledJobLeases)).toEqual([]);
    const manifest = JSON.parse(store.rows.get(generationJobs)!.find(row => row.id === first.body.jobId)!.settings)._retryBinding;
    expect(manifest).toMatchObject({ version: 1, parentJobId: 'owned-job', ownerOpenId: actor.openId,
      actorUserId: actor.id, cardIds: cards });
    expect(manifest.settingsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('serializes concurrent original-parent retries with the actual lease runtime and retains the owner lease', async () => {
    job('owned-job', actor.openId, { applyToTrello: false });
    const fixture = await bridge({ holdLogin: true });
    const first = submit('retry').then(value => value);
    await fixture.waitFile('login-ready');
    const child = store.rows.get(generationJobs)!.find(row => row.id !== 'owned-job')!;
    try {
      const contender = await submit('retry').expect(409);
      expect(contender.body.jobId).toBe(child.id);
      expect(await fixture.calls()).toEqual([]);
      expect(store.rows.get(generationJobs)).toHaveLength(2);
      expect(store.rows.get(scheduledJobRuns)).toHaveLength(1);
      expect(store.rows.get(scheduledJobLeases)).toHaveLength(1);
    } finally { await fixture.release('allow-login'); }
    expect((await first).body).toMatchObject({ success: true, jobId: child.id, completed: 2 });
    expect(await fixture.calls()).toHaveLength(2);
    expect(store.rows.get(scheduledJobLeases)).toEqual([]);
    expect(store.rows.get(scheduledJobRuns)![0].status).toBe('success');
  });

  it.each(['owner', 'settings', 'parent_cards', 'child_cards', 'child_manifest'] as const)(
    'refuses changed %s bindings rather than overwriting a stable child or generating again', async change => {
      job('owned-job', actor.openId, { applyToTrello: false });
      const fixture = await bridge();
      const first = await submit('retry').expect(200);
      const child = store.rows.get(generationJobs)!.find(row => row.id === first.body.jobId)!;
      if (change === 'owner') child.createdBy = foreign.openId;
      if (change === 'settings') store.rows.get(generationJobs)![0].settings = JSON.stringify({ applyToTrello: true });
      if (change === 'parent_cards') store.rows.get(generationItems)![0].cardId = 'anothercard0001';
      if (change === 'child_cards') store.rows.get(generationItems)!.find(row => row.jobId === child.id)!.cardId = 'anothercard0001';
      if (change === 'child_manifest') child.settings = JSON.stringify({ applyToTrello: false, _retryBinding: {} });
      const before = structuredClone({ child, items: store.rows.get(generationItems) });
      const calls = (await fixture.calls()).length;
      expect((await submit('retry').expect(409)).body.jobId).toBe(child.id);
      expect(await fixture.calls()).toHaveLength(calls);
      expect(store.rows.get(generationJobs)).toHaveLength(2);
      expect(store.rows.get(generationJobs)!.find(row => row.id === child.id)).toEqual(before.child);
      expect(store.rows.get(generationItems)).toEqual(before.items);
    },
  );

  it('refuses malformed stored retry settings rather than guessing mutation permissions', async () => {
    job(); store.rows.get(generationJobs)![0].settings = '{broken';
    await submit('retry').expect(409);
    expect(store.rows.get(generationJobs)).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each((['batch', 'retry'] as const).flatMap(mode => ['epoch', 'role', 'deleted'].map(change => ({ mode, change }))))(
    '$mode stops queued work on $change revocation', async ({ mode, change }) => {
    job(); const fixture = await bridge({ holdLogin: true });
    const pending = submit(mode).then(value => value);
    await fixture.waitFile('login-ready');
    if (change === 'epoch') store.rows.get(users)![0].sessionEpoch = '2';
    if (change === 'role') store.rows.get(users)![0].role = 'user';
    if (change === 'deleted') store.rows.set(users, [{ ...foreign }]);
    const response = await fixture.release('allow-login').then(() => pending);
    expect(response.status).toBe(403);
    expect(response.body.success).not.toBe(true);
    expect(await fixture.calls()).toEqual([]);
    expect(controls.trello).not.toHaveBeenCalled();
    expect(newItems()).toMatchObject([{ cardId: cards[0], status: 'outcome_unknown' }]);
    expect(newItems()).toHaveLength(1);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });

  it.each(['batch', 'retry'] as const)('%s fences an in-flight result and never continues to the next card', async mode => {
    job(); const fixture = await bridge({ holdTurn: true });
    const pending = submit(mode).then(value => value);
    await fixture.waitFile('calls.jsonl');
    store.rows.set(users, [{ ...foreign }]);
    await fixture.release('allow-turn');
    expect((await pending).status).toBe(403);
    expect(await fixture.calls()).toHaveLength(1);
    expect(controls.trello).not.toHaveBeenCalled();
    expect(newItems()).toMatchObject([{ cardId: cards[0], status: 'outcome_unknown' }]);
    expect(newItems()).toHaveLength(1);
  });

  it.each(['batch', 'retry'] as const)('%s cancels queued inference on client disconnect', async mode => {
    job(); const fixture = await bridge({ holdLogin: true });
    const call = submit(mode), pending = call.then(() => undefined, error => error);
    await fixture.waitFile('login-ready');
    const pid = Number(await readFile(join(fixture.work, 'login-ready'), 'utf8'));
    call.abort(); await pending;
    await vi.waitFor(async () => expect(await readdir(join(fixture.root, 'requests'))).toEqual([]));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    expect(await fixture.calls()).toEqual([]);
    expect(controls.trello).not.toHaveBeenCalled();
    expect(newItems()).toHaveLength(1);
  });
});
