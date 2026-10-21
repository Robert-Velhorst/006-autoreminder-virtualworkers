import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { aptlssPlans, aptlssSteps, chatbotConversations, dailyBriefings, decisionOutcomes, taskAssignments, timeEntries, users, vaProfiles, type User } from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), pilot: vi.fn(), fetchCard: vi.fn(), postComment: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb, incrementPayLogD1: vi.fn() }));
vi.mock('../aptlssManagerPilot', () => ({ isManagerPilotWorker: mocks.pilot }));
vi.mock('../aptlssManagerQueue', () => ({ enqueueManagerTask: vi.fn() }));
vi.mock('../trelloCardAccess', () => ({ fetchAuthorizedTrelloCard: mocks.fetchCard,
  TrelloAccessError: class extends Error {} }));
vi.mock('../services/trello-chatbot', () => ({ isTrelloCommentAutomationEnabled: () => true,
  postTrelloComment: mocks.postComment, TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE: 'disabled' }));
import communication from './communication';
import handoff from './handoff';
import timeTracking from './time-tracking';
import { timerRouter } from './manus';
import { aptlssRouter } from './manus-trello-aptlss';

const worker = { id: 42, role: 'worker', openId: 'worker-42', name: 'Worker' } as User;
const task = (changes: Record<string, unknown> = {}) => ({ id: 1, taskId: 'card:list:item', founderId: 8, vaId: 7,
  status: 'assigned', handoffNotes: 'Existing note', decisionLog: '[]', ...changes });
const dialect = new PgDialect();
function fixture(assignments: Record<string, unknown>[], actor = worker, beforeLock?: (table: unknown) => void) {
  const taskLocks: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const locks: Array<{ table: unknown; params: unknown[] }> = [];
  const rows = new Map<unknown, any[]>([
    [users, [worker, { id: 43, role: 'worker' }, { id: 44, role: 'worker' }, { id: 8, role: 'admin', openId: 'founder-8' }, { id: 9, role: 'admin' }]],
    [vaProfiles, [{ id: 7, userId: 42, founderId: 8, status: 'active', name: 'Worker', timezone: 'UTC' },
      { id: 10, userId: 43, founderId: 9, status: 'active' }, { id: 11, userId: 44, founderId: 8, status: 'active' }]],
    [taskAssignments, assignments], [aptlssPlans, [{ id: 1, vaId: 42, cardId: 'card', listName: 'Doing' }]],
    [timeEntries, []], [dailyBriefings, []], [chatbotConversations, []],
  ]);
  const store = timerTestDatabase(rows, { beforeLock: async (table, condition) => {
    beforeLock?.(table);
    locks.push({ table, params: dialect.sqlToQuery(condition).params });
    if (table === taskAssignments) taskLocks.push(dialect.sqlToQuery(condition));
  } });
  mocks.getDb.mockResolvedValue(store.db);
  const app = express().use(express.json());
  app.use((req, _res, next) => { (req as any).user = actor; next(); });
  app.use('/communication', communication); app.use('/handoff', handoff); app.use(timeTracking);
  const caller = timerRouter.createCaller({ user: actor, req: {} as any, res: {} as any });
  const checklist = aptlssRouter.createCaller({ user: actor, req: {} as any, res: {} as any });
  return { ...store, app, caller, checklist, taskLocks, locks };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.pilot.mockReturnValue(false);
  mocks.fetchCard.mockResolvedValue({ id: 'card' }); mocks.postComment.mockResolvedValue(true);
});

describe('checklist mutation canonical assignment boundary', () => {
  function seedStep(store: ReturnType<typeof fixture>, changes: Record<string, unknown> = {}) {
    store.rows.set(aptlssSteps, [{ id: 60, vaId: 42, cardId: 'card', trelloChecklistId: 'list',
      trelloCheckItemId: 'item', status: 'open', requiresRobert: false, ...changes }]);
    return { trelloCheckItemId: 'item', state: 'incomplete' as const };
  }
  it.each(['completed', 'blocked', 'assigned'])('rejects cross-worker child duplicates before checklist writes (%s)', async status => {
    const store = fixture([task(), task({ id: 2, vaId: 11, status })]);
    const input = seedStep(store);
    await expect(store.checklist.syncCheckItem(input)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/duplicate/i) });
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
    expect(store.locks.some(lock => lock.table === aptlssSteps)).toBe(false);
  });
  it('locks fresh accounts before profiles, then batches absent child and parent before the step row', async () => {
    const store = fixture([task({ taskId: 'card' })]);
    const input = seedStep(store);
    await expect(store.checklist.syncCheckItem(input)).resolves.toEqual({ success: true });
    expect(store.locks.map(lock => lock.table)).toEqual([users, users, vaProfiles, taskAssignments, aptlssSteps, decisionOutcomes]);
    expect(store.locks.filter(lock => lock.table === users).map(lock => lock.params)).toEqual([[8], [42]]);
    expect(store.taskLocks).toHaveLength(1);
    expect(store.taskLocks[0].params).toEqual([8, 'card', 'card:list:item']);
    const advisory = store.db.execute.mock.calls.map(([query]: any[]) => dialect.sqlToQuery(query));
    expect(advisory.map((query: any) => query.params)).toEqual([
      [JSON.stringify(['task_assignment', 8, 'card'])], [JSON.stringify(['task_assignment', 8, 'card:list:item'])],
    ]);
    expect(store.updates).toEqual([]);
  });
  it.each(['requires-founder', 'persisted-decision'])('retains the Founder decision block (%s)', async blocker => {
    const store = fixture([task()]);
    const input = seedStep(store, { requiresRobert: blocker === 'requires-founder' });
    if (blocker === 'persisted-decision') store.rows.set(decisionOutcomes, [{ id: 1, vaId: 42, stepId: 60 }]);
    await expect(store.checklist.syncCheckItem(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/Founder.*decision/i) });
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
  });
  it('rechecks step full identity after assignment locks rather than using a stale child key', async () => {
    const store = fixture([task()], worker, table => {
      if (table === aptlssSteps) store.rows.get(aptlssSteps)![0].trelloChecklistId = 'replacement-list';
    });
    const input = seedStep(store);
    await expect(store.checklist.syncCheckItem(input)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/identity changed/i) });
    expect(store.updates).toEqual([]);
  });
  it('retains distinct child keys and independent founder scopes', async () => {
    const store = fixture([task(), task({ id: 2, taskId: 'card:list:other', vaId: 11 }),
      task({ id: 3, founderId: 9, vaId: 10, status: 'blocked' })]);
    await expect(store.checklist.syncCheckItem(seedStep(store))).resolves.toEqual({ success: true });
    expect(store.rows.get(aptlssSteps)![0].status).toBe('open');
    expect(store.updates).toEqual([]);
  });
});

describe('assignment cardinality at actual consumer boundaries', () => {
  it.each(['assigned', 'in_progress', 'completed', 'blocked'])('REST and Manus timer starts reject cross-worker duplicates regardless of status (%s)', async status => {
    const store = fixture([task(), task({ id: 2, vaId: 11, status })]);
    await request(store.app).post('/time-tracking/start').send({ taskId: 'card:list:item' }).expect(409);
    await expect(store.caller.start({ cardId: 'card', cardName: 'Card', cardUrl: 'https://trello.com/c/card' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/duplicate/i) });
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
    expect(mocks.fetchCard).not.toHaveBeenCalled(); expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it.each(['question', 'decision', 'decision-read', 'handoff', 'handoff-read', 'summary'])('rejects duplicates before %s performs writes or provider work', async action => {
    const store = fixture([task(), task({ id: 2, vaId: 11, status: 'completed' })]);
    const before = structuredClone(store.rows.get(taskAssignments));
    if (action === 'question') await request(store.app).post('/communication/ask-founder').send({ taskId: 'card:list:item', question: 'Clarify?' }).expect(409);
    if (action === 'decision') await request(store.app).post('/communication/decision-log').send({ taskId: 'card:list:item', decision: 'New decision' }).expect(409);
    if (action === 'decision-read') await request(store.app).get('/communication/decision-log/card:list:item').expect(409);
    if (action === 'handoff') await request(store.app).post('/handoff/notes').send({ taskId: 'card:list:item', notes: 'New note' }).expect(409);
    if (action === 'handoff-read') await request(store.app).get('/handoff/card:list:item').expect(409);
    if (action === 'summary') await request(store.app).post('/handoff/shift-summary').send({}).expect(409);
    expect(store.rows.get(taskAssignments)).toEqual(before);
    expect(store.updates).toEqual([]); expect(store.inserts).toEqual([]);
    expect(mocks.fetchCard).not.toHaveBeenCalled(); expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it('locks the requested child and parent once, in canonical lexical order, before the assignment row', async () => {
    const store = fixture([task()]);
    await request(store.app).post('/time-tracking/start').send({ taskId: 'card:list:item' }).expect(200);
    const locks = store.db.execute.mock.calls.map(([query]: any[]) => dialect.sqlToQuery(query))
      .filter((query: any) => query.sql.includes('pg_advisory_xact_lock'));
    expect(locks.map((query: any) => query.params)).toEqual([
      [JSON.stringify(['task_assignment', 8, 'card'])], [JSON.stringify(['task_assignment', 8, 'card:list:item'])],
    ]);
    expect(store.taskLocks).toHaveLength(1);
    expect(store.taskLocks[0].params).toEqual([8, 'card', 'card:list:item']);
  });

  it('locks an absent child before rejecting a blocked parent fallback', async () => {
    const store = fixture([task({ taskId: 'card', status: 'blocked' })]); mocks.pilot.mockReturnValue(true);
    await request(store.app).post('/time-tracking/start').send({ taskId: 'card:list:item' }).expect(409,
      { error: 'This task is blocked; resolve the blocker before tracking time' });
    expect(store.taskLocks).toHaveLength(1);
    expect(store.taskLocks[0].params).toEqual([8, 'card', 'card:list:item']);
    expect(store.inserts).toEqual([]);
  });

  it('does not collapse valid distinct checklist tasks on the same card into a duplicate', async () => {
    const store = fixture([task(), task({ id: 2, taskId: 'card:list:second' })]);
    await store.caller.start({ cardId: 'card', cardName: 'Card', cardUrl: 'https://trello.com/c/card' });
    expect(store.rows.get(timeEntries)).toHaveLength(1);
    expect(store.rows.get(timeEntries)![0]).toMatchObject({ trackedUserId: 42, trackedProfileId: 7, founderId: 8 });
  });

  it('keeps decision logs and handoff notes scoped to the current founder despite identical task keys', async () => {
    const store = fixture([task(), task({ id: 2, founderId: 9, vaId: 10, handoffNotes: 'Foreign secret',
      decisionLog: JSON.stringify([{ decision: 'Foreign secret' }]) })], { id: 8, role: 'admin', openId: 'founder-8' } as User);
    await request(store.app).post('/communication/decision-log').send({ taskId: 'card:list:item', decision: 'Own decision' }).expect(200);
    const response = await request(store.app).get('/communication/decision-log/card:list:item').expect(200);
    expect(response.body.logs).toEqual([expect.objectContaining({ decision: 'Own decision' })]);
    const notes = await request(store.app).get('/handoff/card:list:item').expect(200);
    expect(notes.body.notes).toBe('Existing note');
    expect(JSON.stringify(response.body) + JSON.stringify(notes.body)).not.toContain('Foreign secret');
    expect(store.rows.get(taskAssignments)![1].decisionLog).toContain('Foreign secret');
  });

  it('authorizes a full checklist key but sends the explicitly requested question to its parent card', async () => {
    const store = fixture([task()]);
    await request(store.app).post('/communication/ask-founder').send({ taskId: 'card:list:item', question: 'Clarify?' }).expect(200);
    expect(mocks.fetchCard).toHaveBeenCalledExactlyOnceWith(worker, 'card', { fields: 'idMembers' });
    expect(mocks.postComment).toHaveBeenCalledExactlyOnceWith('card', expect.stringContaining('Clarify?'), expect.any(Function));
    expect(store.rows.get(chatbotConversations)![0]).toMatchObject({ cardTrelloId: 'card', responseStatus: 'success' });
  });

  it('does not report a saved decision when the canonical row update affects no record', async () => {
    const store = fixture([task()]);
    store.db.update.mockImplementation(() => ({ set: () => ({ where: async () => ({ rowCount: 0 }) }) }));
    await request(store.app).post('/communication/decision-log').send({ taskId: 'card:list:item', decision: 'Not saved' }).expect(409);
    expect(store.rows.get(taskAssignments)![0].decisionLog).toBe('[]');
    expect(store.inserts).toEqual([]);
  });

  it.each(['stop', 'pause'])('keeps exact-entry %s independent of duplicate or reassigned task ownership', async transition => {
    const store = fixture([task({ vaId: 11 }), task({ id: 2, vaId: 11, status: 'completed' })]);
    store.rows.get(timeEntries)!.push({ id: 55, taskId: 'card:list:item', trackedUserId: 42, trackedProfileId: 7,
      founderId: 8, vaId: null, startTime: new Date(Date.now() - 60000), endTime: null, isVoided: false });
    await request(store.app).post(`/time-tracking/${transition}`).send({ entryId: 55 }).expect(200);
    expect(store.rows.get(timeEntries)![0].endTime).toBeInstanceOf(Date);
    expect(store.taskLocks).toEqual([]);
    expect(store.updates.filter(row => row.table === taskAssignments)).toEqual([]);
  });
});
