import { EventEmitter } from 'node:events';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../drizzle/schema.postgres';
import { createFinancialDatabase, type FinancialDatabase } from '../test/financialDatabase';
import { requireIsolatedPostgresTestDatabase } from '../../shared/isolatedPostgresTestDatabase.mjs';
import { codexLlmFixture } from '../test/codexLlmFixture';

const controls = vi.hoisted(() => ({ db: undefined as any, trello: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
vi.mock('../utils/retry', async original => ({ ...await original<typeof import('../utils/retry')>(),fetchWithRetry: controls.trello }));
import { generationRequestContext } from './aptlss';
import { generateAptlssForCard } from '../services/aptlss-generation';
import { getAptlssChecklistWriteAuthorization } from '../services/trello-checklist-sync';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!baseUrl)('generation guard supplied-reader PostgreSQL pool-of-one acceptance', { timeout: 10000 }, () => {
  let fixture: FinancialDatabase | undefined;
  let pool: Pool | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let actor: typeof schema.users.$inferSelect;
  beforeAll(async () => {
    fixture = await createFinancialDatabase(baseUrl);
    const url = new URL(requireIsolatedPostgresTestDatabase(baseUrl,process.env.NODE_ENV === 'production'));
    url.pathname = `/${fixture.name}`;
    pool = new Pool({ connectionString: url.href,max: 1,connectionTimeoutMillis: 750,
      options: '-c timezone=UTC -c statement_timeout=2000 -c lock_timeout=500' });
    db = drizzle(pool,{ schema }); controls.db = db;
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(fixture.name);
    await fixture.pool.query(`INSERT INTO users ("openId",role) VALUES ('generation-reader-fixture','admin')`);
  },120000);
  beforeEach(async () => {
    [actor] = (await fixture!.pool.query(`UPDATE users SET role='admin' WHERE "openId"='generation-reader-fixture' RETURNING *`)).rows;
  });
  afterAll(async () => {
    controls.db = undefined;
    try { await pool?.end(); } finally { await fixture?.close(); }
  });
  function operation() {
    return generationRequestContext(Object.assign(new EventEmitter(),{ user: actor }) as any,
      Object.assign(new EventEmitter(),{ writableEnded: false }) as any);
  }

  it('completes repeated fresh checkpoints on the already occupied single connection without nested checkout', async () => {
    const context = operation();
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(7013291)`);
        await context.context.assertOwnership(tx);
        await context.context.assertOwnership(tx);
        expect(pool!.totalCount).toBe(1); expect(pool!.waitingCount).toBe(0);
      });
      expect((await pool!.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally { context.dispose(); }
  });

  it('does not retain account SHARE locks across provider-spanning transactions and detects committed revocation on the same reader', async () => {
    const context = operation();
    try {
      await expect(db.transaction(async tx => {
        await context.context.assertOwnership(tx);
        // A separate owned connection represents lifecycle work while the card transaction stays open.
        // statement_timeout bounds this proof: an accidental retained account lock must fail, not hang CI.
        const lifecycle = await fixture!.pool.connect();
        try {
          await lifecycle.query('BEGIN');
          await lifecycle.query(`SET LOCAL statement_timeout='2s'`);
          await lifecycle.query(`UPDATE users SET role='user' WHERE id=$1`,[actor.id]);
          await lifecycle.query('COMMIT');
        } finally { await lifecycle.query('ROLLBACK'); lifecycle.release(); }
        await context.context.assertOwnership(tx);
      })).rejects.toHaveProperty('name','ScheduledJobLeaseLostError');
      expect(context.failureStatus).toBe(403); expect(pool!.waitingCount).toBe(0);
    } finally { context.dispose(); }
  });

  it('generates and verifies a safeguarded checklist, commits its sync record and reuses it with a single pooled connection', async () => {
    const cardId = '111111111111111111111111';
    const checklistId = '222222222222222222222222';
    const [worker] = await db.insert(schema.users).values({ openId: 'generation-service-worker',role: 'worker' }).returning();
    const [profile] = await db.insert(schema.vaProfiles).values({ userId: worker.id,founderId: actor.id,
      name: 'Synthetic generation worker',status: 'active',trelloMemberId: 'generation-fixture-member' }).returning();
    await db.insert(schema.taskAssignments).values({ taskId: cardId,vaId: profile.id,founderId: actor.id,assignedBy: actor.id,status: 'assigned' });
    // Enable actual assignment/card-membership safeguards, with this card explicitly non-pilot.
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS',String(profile.id+100000));
    vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY','true');
    vi.stubEnv('TRELLO_API_KEY','synthetic-native-key'); vi.stubEnv('TRELLO_TOKEN','synthetic-native-token');
    const fetchMock = vi.fn(() => { throw new Error('No real provider fetch is permitted in this fixture'); });
    vi.stubGlobal('fetch',fetchMock);
    const source = { id: cardId,name: 'Review synthetic source evidence',desc: 'Review the supplied evidence and record verified findings. '.repeat(3),
      actions: [{ type: 'commentCard',data: { text: 'Use the attached source as evidence.' } }],attachments: [{ name: 'synthetic-source.txt' }],checklists: [] };
    const plan = { summary: 'Review evidence',nextBestAction: 'Read source',stateReason: 'Source is ready',urgencyLabel: 'HIGH',confidenceScore: 95,
      missingInformation: [],steps: ['Read source','Record findings'].map(title => ({ title,estimatedMinutes: 10,category: 'T',requiresFounder: false,
        blockedBy: null,completionCriteria: `${title} is verified`,riskIfSkipped: 'Evidence may be missed',recommendedDecision: null })) };
    const remote: Array<{ id: string; name: string; checkItems: Array<{ id: string; name: string; state: string }> }> = [];
    controls.trello.mockReset().mockImplementation(async (raw: string,init?: RequestInit) => {
      expect(pool!.totalCount).toBe(1); expect(pool!.waitingCount).toBe(0);
      const url = new URL(String(raw)), method = init?.method ?? 'GET';
      if (url.pathname === `/1/cards/${cardId}/checklists` && method === 'GET') return Response.json(structuredClone(remote));
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (url.pathname === `/1/cards/${cardId}/checklists` && method === 'POST') {
        const checklist = { id: checklistId,name: body.name,checkItems: [] };
        remote.push(checklist); return Response.json({ id: checklist.id,name: checklist.name });
      }
      if (url.pathname === `/1/checklists/${checklistId}/checkItems` && method === 'POST') {
        const item = { id: (remote[0].checkItems.length+3).toString(16).padStart(24,'0'),name: body.name,state: 'incomplete' };
        remote[0].checkItems.push(item); return Response.json(item);
      }
      if (url.pathname === `/1/checklists/${checklistId}` && method === 'PUT') {
        remote[0].name = url.searchParams.get('name')!; return Response.json(remote[0]);
      }
      throw new Error(`Unexpected synthetic Trello operation: ${method} ${url.pathname}`);
    });
    let bridge: Awaited<ReturnType<typeof codexLlmFixture>> | undefined;
    const context = operation();
    try {
      const assignments = await db.select().from(schema.taskAssignments).where(eq(schema.taskAssignments.taskId,cardId));
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({ taskId: cardId,vaId: profile.id,founderId: actor.id,status: 'assigned' });
      await expect(getAptlssChecklistWriteAuthorization(cardId,db)).resolves.toEqual({ allowed: true,applyToTrello: true });
      // Real generation/subscription/checklist services; only the CLI executable and Trello are synthetic.
      bridge = await codexLlmFixture({ turns: [{ answer: JSON.stringify(plan) }] });
      const result = await generateAptlssForCard(source,{},context.context);
      expect(result).toMatchObject({ success: true,cardId,checklistId,itemsCreated: 2,appliedToTrello: true,validation: { passed: true } });
      expect(remote).toHaveLength(1); expect(remote[0].checkItems).toHaveLength(2);
      expect(remote[0].checkItems.map(item => item.name)).toEqual([
        expect.stringContaining('Read source'),expect.stringContaining('Record findings'),
      ]);
      const persisted = await db.select().from(schema.atisChecklistSync);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ trelloCardId: cardId,trelloChecklistId: checklistId,itemsSynced: 2 });
      expect(persisted[0].syncedAt).toBeInstanceOf(Date);
      const writes = controls.trello.mock.calls.filter(([,init]) => init?.method === 'POST');
      expect(writes).toHaveLength(3); // one checklist and its two verified items
      const callsBeforeReuse = controls.trello.mock.calls.length;
      const reused = await generateAptlssForCard({ ...source,checklists: structuredClone(remote) },{},context.context);
      expect(reused).toMatchObject({ success: true,reusedExistingChecklist: true,appliedToTrello: false,itemsCreated: 0,checklistId });
      expect(controls.trello).toHaveBeenCalledTimes(callsBeforeReuse);
      expect(await bridge.calls()).toHaveLength(1); expect(fetchMock).not.toHaveBeenCalled();
      expect(pool!.totalCount).toBe(1); expect(pool!.waitingCount).toBe(0);
      expect((await pool!.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally {
      context.dispose();
      try { await bridge?.close(); } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); controls.trello.mockReset(); }
    }
  });
});
