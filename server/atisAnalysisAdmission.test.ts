import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { atisAnalysisItems, atisAnalysisRequests, users } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';
const controls = vi.hoisted(() => ({ db: undefined as any, operation: undefined as any, provider: vi.fn() }));
vi.mock('./db', () => ({ getDb: async () => controls.db }));
vi.mock('./services/atis-understanding', () => ({ processCardUnderstandingOutcome: controls.provider }));
vi.mock('./atisOperations', async original => ({ ...await original<typeof import('./atisOperations')>(),
  getAtisAnalysisOperation: async () => controls.operation,
}));
import { AtisAnalysisAdmissionError, atisAnalysisSelectionPredicate, getAtisAnalysisJob, normalizeAtisAnalysisSelection } from './atisAnalysisAdmission';
const id = '12222222-2222-4222-8222-222222222222';
beforeEach(() => { controls.db = undefined; controls.operation = undefined; controls.provider.mockReset(); });

describe('ATIS bounded selection contract', () => {
  it('freezes a sorted unique input without mutating the caller and caps only the selected batch', () => {
    const input = { mode: 'reanalyze' as const,cardIds: [9,2,9,4],guidance: { goal: ' Review ',successCriteria: [' Verified '] } };
    const selected = normalizeAtisAnalysisSelection(input);
    expect(selected).toEqual({ mode: 'reanalyze',cardIds: [2,4,9],limit: 100,guidance: { goal: 'Review',successCriteria: ['Verified'] } });
    expect(input.cardIds).toEqual([9,2,9,4]);
    expect(normalizeAtisAnalysisSelection({ mode: 'reanalyze',cardIds: Array.from({ length: 1000 },(_,i) => i+1) }).cardIds).toHaveLength(1000);
  });
  it.each([
    { mode: 'single' }, { mode: 'single',cardId: 1,boardId: 2 }, { mode: 'single',cardId: 1,limit: 2 },
    { mode: 'pending',cardId: 1 }, { mode: 'reanalyze',cardIds: [1],boardId: 2 },
    { mode: 'reanalyze',forceAll: true,minConfidence: 5 }, { mode: 'active_placeholders',minConfidence: 30 },
    { mode: 'pending',limit: 101 }, { mode: 'pending',limit: 0 }, { mode: 'pending',afterCardId: -1 },
    { mode: 'reanalyze',cardIds: [] }, { mode: 'reanalyze',cardIds: [1,1.5] },
    { mode: 'reanalyze',cardIds: Array.from({ length: 1001 },(_,i) => i+1) },
    { mode: 'pending',guidance: { private: 'not allowed' } }, { mode: 'pending',guidance: { successCriteria: [12] } },
  ])('rejects invalid or ambiguous selection %#', input => {
    expect(() => normalizeAtisAnalysisSelection(input as any)).toThrow(AtisAnalysisAdmissionError);
  });
  it('compiles placeholder filtering with a guarded JSON array branch, stable cursor and no confidence substitution', () => {
    const query = new PgDialect().sqlToQuery(atisAnalysisSelectionPredicate(normalizeAtisAnalysisSelection({ mode: 'active_placeholders',afterCardId: 7 })));
    expect(query.params).toEqual([7]);
    expect(query.sql).toContain('IS JSON ARRAY');
    expect(query.sql.indexOf('CASE')).toBeLessThan(query.sql.indexOf('::json'));
    expect(query.sql).toContain('json_array_length');
    expect(query.sql).not.toContain('confidenceScore');
  });
});

describe('ATIS durable job presentation', () => {
  function fixture(states: string[]) {
    const f = timerTestDatabase(new Map<unknown,any[]>([
      [users,[{ id: 1,role: 'admin',sessionEpoch: '1' }]],
      [atisAnalysisRequests,[{ id,ownerUserId: 1,actorEpoch: '1',confirmedAt: new Date(),
        cards: states.map((_,i) => ({ id: i+1,name: `Card ${i+1}` })),matched: 10,remaining: 10-states.length,nextAfterCardId: states.length,
        selection: { mode: 'pending',guidance: { goal: 'Private guidance must not be in summary' } } }]],
      [atisAnalysisItems,states.map((state,i) => ({ id: i+1,requestId: id,cardId: i+1,cardName: `Card ${i+1}`,state }))],
    ]));
    controls.db = f.db; return f;
  }
  it('counts generated plus fallback as processed, and completion means all items settled', async () => {
    fixture(['generated','fallback','missing','failed']); controls.operation = { id: 9,state: 'completed' };
    const job = await getAtisAnalysisJob(1,id);
    expect(job).toMatchObject({ state: 'completed',processed: 2,generated: 1,fallback: 1,missing: 1,failed: 1,pending: 0,uncertain: 0 });
    expect(JSON.stringify(job)).not.toContain('Private guidance'); expect(controls.provider).not.toHaveBeenCalled();
  });
  it('derives a crashed calling marker as uncertain without replay or writes', async () => {
    const f = fixture(['generated','calling','pending']); controls.operation = { id: 9,state: 'interrupted' };
    expect(await getAtisAnalysisJob(1,id)).toMatchObject({ state: 'interrupted',processed: 1,uncertain: 1,pending: 1,
      items: [{ state: 'generated' },{ state: 'uncertain' },{ state: 'pending' }] });
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]); expect(controls.provider).not.toHaveBeenCalled();
  });
  it('does not call active work uncertain and does not accept incomplete success as completion', async () => {
    fixture(['calling']); controls.operation = { id: 9,state: 'running' };
    expect(await getAtisAnalysisJob(1,id)).toMatchObject({ state: 'running',pending: 1,uncertain: 0 });
    controls.operation = { id: 9,state: 'completed' };
    expect(await getAtisAnalysisJob(1,id)).toMatchObject({ state: 'interrupted',uncertain: 1 });
  });
  it('hides foreign requests and rejects a demoted owner without exposing diagnostics', async () => {
    const f = fixture(['pending']);
    expect(await getAtisAnalysisJob(2,id)).toBeNull();
    f.rows.get(users)![0].role = 'worker';
    await expect(getAtisAnalysisJob(1,id)).rejects.toMatchObject({ status: 403,code: 'FORBIDDEN' });
  });
  it('does not certify completion if the frozen membership has lost an item record', async () => {
    const f = fixture(['generated']); controls.operation = { id: 9,state: 'completed' };
    f.rows.set(atisAnalysisItems,[]);
    expect(await getAtisAnalysisJob(1,id)).toMatchObject({ state: 'interrupted',total: 1,processed: 0 });
    expect(controls.provider).not.toHaveBeenCalled();
  });
  it('does not certify substituted item identities even when their count matches', async () => {
    const f = fixture(['generated']); controls.operation = { id: 9,state: 'completed' };
    f.rows.get(atisAnalysisItems)![0].cardId = 99;
    expect(await getAtisAnalysisJob(1,id)).toMatchObject({ state: 'interrupted' });
    expect(controls.provider).not.toHaveBeenCalled();
  });
  it('sanitizes infrastructure failure into a stable safe service error', async () => {
    controls.db = { select: () => { throw new Error('private SQL/provider details'); } };
    await expect(getAtisAnalysisJob(1,id)).rejects.toMatchObject({ status: 503,code: 'UNAVAILABLE',message: 'Analysis admission is unavailable; read its status before retrying.' });
  });
});
