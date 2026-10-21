import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  users,
  vaProfiles,
  interviewSessions,
  interviewHistory,
  interviewResults,
  type User,
} from '../../drizzle/schema.postgres';
import { timerTestDatabase } from '../test/timerDatabase';
import { codexLlmFixture } from '../test/codexLlmFixture';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), card: vi.fn(), analysis: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../trelloCardAccess', async (original) => ({
  ...(await original<typeof import('../trelloCardAccess')>()),
  fetchAuthorizedTrelloCardWithComments: mocks.card,
}));
vi.mock('../services/pre-interview-analysis', () => ({ analyzeCardBeforeInterview: mocks.analysis }));
import { interviewRouter } from './interview';
import enhancedRoutes from './interview-enhanced';
import { TrelloAccessError } from '../trelloCardAccess';
import * as conversation from '../services/conversational-interview';

const fixtures: Array<Awaited<ReturnType<typeof codexLlmFixture>>> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function setup(plan: Parameters<typeof codexLlmFixture>[0] = {}, role: 'worker' | 'admin' = 'worker') {
  const actor = { id: 42, openId: 'interview-worker', role, sessionEpoch: '1' } as User;
  const profile = { id: 7, userId: 42, founderId: 8, status: 'active', trelloMemberId: 'member-42' };
  const rows = new Map<unknown, any[]>([
    [users, [{ ...actor }]],
    [vaProfiles, [profile]],
    [interviewSessions, []],
    [interviewHistory, []],
    [interviewResults, []],
  ]);
  const store = timerTestDatabase(rows);
  mocks.getDb.mockResolvedValue(store.db);
  mocks.card.mockReset().mockResolvedValue({ id: 'card', name: 'Synthetic goal', idMembers: ['member-42'] });
  mocks.analysis.mockReset().mockResolvedValue({
    summary: 'Synthetic evidence',
    proposedGoal: 'Measurable outcome',
    confidence: 80,
    evidence: { keywords: ['revenue'] },
    identifiedGaps: [],
  });
  const req = new EventEmitter(),
    res = Object.assign(new EventEmitter(), { writableEnded: false });
  const caller = interviewRouter.createCaller({ user: actor, req: req as any, res: res as any });
  const cardId = randomUUID();
  const { sessionId } = await caller.start({ cardId });
  const fixture = await codexLlmFixture(plan);
  fixtures.push(fixture);
  const respond = () =>
    caller.respond({
      cardId,
      sessionId,
      response: 'Revenue for customer Alice increases from 10 to 20 by 2026-12-01.',
    });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...actor };
    next();
  });
  app.use('/api/interview', enhancedRoutes);
  app.use(
    '/trpc',
    createExpressMiddleware({
      router: interviewRouter,
      createContext: ({ req, res }) => ({ req, res, user: { ...actor } }),
    }),
  );
  return { ...store, caller, actor, profile, fixture, respond, req, res, sessionId, cardId, app };
}

describe('interview authority across real subscription queue boundaries', () => {
  it.each(['start','respond','complete'] as const)(
    '%s acknowledges a committed mutation without a new external check even if Trello becomes unavailable',
    async mode => {
      const f = await setup({ turns: mode === 'complete' ? [
        { answer: 'INTERVIEW_COMPLETE Goal agreed.' },
        { answer: JSON.stringify({ goal: 'Revenue reaches 20',successCriteria: ['20 measured'],confidence: 90 }) },
      ] : [{ answer: 'Which evidence confirms that outcome?' }] });
      let committed = false, postCommitReads = 0;
      const transaction = f.db.transaction;
      f.db.transaction = vi.fn(async (work: any) => {
        const before = f.inserts.length;
        const value = await transaction(work);
        if (f.inserts.length > before) committed = true;
        return value;
      });
      mocks.card.mockImplementation(async () => {
        if (committed) {
          postCommitReads++;
          throw new TrelloAccessError(502,'Synthetic Trello outage after commit');
        }
        return { id: f.cardId,name: 'Synthetic goal',idMembers: ['member-42'] };
      });
      const cardId = mode === 'start' ? randomUUID() : f.cardId;
      const result = mode === 'start' ? await f.caller.start({ cardId }) : await f.respond();
      expect(committed).toBe(true); expect(postCommitReads).toBe(0);
      if (mode === 'start') {
        expect(result).toMatchObject({ sessionId: expect.any(String),firstMessage: expect.any(String) });
        expect(f.rows.get(interviewSessions)).toHaveLength(2);
        expect(f.rows.get(interviewHistory)).toEqual([]);
        expect(await f.fixture.calls()).toEqual([]);
      } else {
        expect(result).toMatchObject({ isComplete: mode === 'complete',nextMessage: expect.any(String) });
        expect(f.rows.get(interviewHistory)).toHaveLength(1);
        expect(f.rows.get(interviewResults)).toHaveLength(mode === 'complete' ? 1 : 0);
        expect(f.rows.get(interviewSessions)![0].status).toBe(mode === 'complete' ? 'completed' : 'active');
        expect(await f.fixture.calls()).toHaveLength(mode === 'complete' ? 2 : 1);
      }
      const state = await f.caller.getState({ cardId });
      expect(state?.messages.length).toBeGreaterThan(0);
      expect(postCommitReads).toBe(0);
      expect(f.req.listenerCount('aborted')).toBe(0); expect(f.res.listenerCount('close')).toBe(0);
    },
  );

  it('fails a transient external check immediately before the response transaction without advancing history or state', async () => {
    const f = await setup({ turns: [{ answer: 'Which evidence confirms that outcome?' }] });
    const before = structuredClone(f.rows.get(interviewSessions));
    const cachedBefore = structuredClone(await f.caller.getState({ cardId: f.cardId }));
    let responseReady = false;
    const process = conversation.processResponse;
    vi.spyOn(conversation,'processResponse').mockImplementation(async (...args) => {
      const result = await process(...args); responseReady = true; return result;
    });
    mocks.card.mockImplementation(async () => {
      if (responseReady) throw new TrelloAccessError(502,'Synthetic outage before response commit');
      return { id: f.cardId,name: 'Synthetic goal',idMembers: ['member-42'] };
    });
    await expect(f.respond()).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    expect(responseReady).toBe(true);
    expect(await f.fixture.calls()).toHaveLength(1);
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]); expect(f.rows.get(interviewResults)).toEqual([]);
    expect(await f.caller.getState({ cardId: f.cardId })).toEqual(cachedBefore);
  });

  it.each(['epoch','role'] as const)('still fences a fresh %s change during the final pre-commit external read', async change => {
    const f = await setup({ turns: [{ answer: 'Which evidence confirms that outcome?' }] });
    const before = structuredClone(f.rows.get(interviewSessions));
    let responseReady = false;
    const process = conversation.processResponse;
    vi.spyOn(conversation,'processResponse').mockImplementation(async (...args) => {
      const result = await process(...args); responseReady = true; return result;
    });
    mocks.card.mockImplementation(async () => {
      if (responseReady) Object.assign(f.rows.get(users)![0],change === 'epoch' ? { sessionEpoch: '2' } : { role: 'user' });
      return { id: f.cardId,name: 'Synthetic goal',idMembers: ['member-42'] };
    });
    await expect(f.respond()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(responseReady).toBe(true); expect(await f.fixture.calls()).toHaveLength(1);
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]); expect(f.rows.get(interviewResults)).toEqual([]);
  });

  it('fails the final external check before start persistence without creating an orphan session', async () => {
    const f = await setup(), before = structuredClone(f.rows.get(interviewSessions));
    const start = conversation.startInterview;
    let openingReady = false;
    vi.spyOn(conversation,'startInterview').mockImplementation(async (...args) => {
      const result = await start(...args); openingReady = true; return result;
    });
    mocks.card.mockImplementation(async () => {
      if (openingReady) throw new TrelloAccessError(502,'Synthetic outage before start commit');
      return { id: f.cardId,name: 'Synthetic goal',idMembers: ['member-42'] };
    });
    await expect(f.caller.start({ cardId: randomUUID() })).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    expect(openingReady).toBe(true);
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]); expect(f.rows.get(interviewResults)).toEqual([]);
    expect(await f.fixture.calls()).toEqual([]);
  });

  it.each(['epoch', 'role', 'inactive', 'ambiguous', 'founder', 'member'] as const)(
    'revocation while queued (%s) prevents CLI inference and all response writes',
    async (change) => {
      const f = await setup({ holdLogin: true });
      const before = structuredClone(f.rows.get(interviewSessions));
      const pending = f.respond();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await f.fixture.waitFile('login-ready');
      if (change === 'epoch') f.rows.get(users)![0].sessionEpoch = '2';
      if (change === 'role') f.rows.get(users)![0].role = 'user';
      if (change === 'inactive') f.profile.status = 'inactive';
      if (change === 'ambiguous') f.rows.get(vaProfiles)!.push({ ...f.profile, id: 9 });
      if (change === 'founder') f.profile.founderId = 9;
      if (change === 'member') f.profile.trelloMemberId = 'other-member';
      await f.fixture.release('allow-login');
      await rejected;
      expect(await f.fixture.calls()).toEqual([]);
      expect(f.rows.get(interviewHistory)).toEqual([]);
      expect(f.rows.get(interviewResults)).toEqual([]);
      expect(f.rows.get(interviewSessions)).toEqual(before);
      expect(f.req.listenerCount('aborted')).toBe(0);
      expect(f.res.listenerCount('close')).toBe(0);
    },
  );

  it('does not revive queued approval after offboarding then reactivation with a new epoch', async () => {
    const f = await setup({ holdLogin: true });
    const pending = f.respond();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.fixture.waitFile('login-ready');
    f.profile.status = 'inactive';
    f.rows.get(users)![0].sessionEpoch = '2';
    f.profile.status = 'active';
    f.rows.get(users)![0].sessionEpoch = '3';
    await f.fixture.release('allow-login');
    await rejected;
    expect(await f.fixture.calls()).toEqual([]);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });

  it('rejects an in-flight answer after revocation without persisting it or a generic fallback', async () => {
    const f = await setup({ turns: [{ answer: 'Private synthetic answer', hold: true }] });
    const before = structuredClone(f.rows.get(interviewSessions));
    const pending = f.respond();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await vi.waitFor(async () => expect(await f.fixture.calls()).toHaveLength(1));
    f.rows.get(users)![0].sessionEpoch = '2';
    await f.fixture.release('allow-turn');
    await rejected;
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]);
    expect(f.rows.get(interviewResults)).toEqual([]);
  });

  it('cancels queued transport when the response connection closes', async () => {
    const f = await setup({ holdLogin: true });
    const pending = f.respond();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.fixture.waitFile('login-ready');
    f.res.emit('close');
    await rejected;
    expect(await f.fixture.calls()).toEqual([]);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });

  it('preserves authorized response and final-goal generation with atomic history/results', async () => {
    const f = await setup({
      turns: [
        { answer: 'INTERVIEW_COMPLETE Goal agreed.' },
        {
          answer: JSON.stringify({
            goal: 'Revenue reaches 20',
            successCriteria: ['20 measured'],
            priority: 'normal',
            constraints: [],
            people: [],
            confidence: 90,
          }),
        },
      ],
    });
    expect(await f.respond()).toMatchObject({ isComplete: true, finalGoal: { goal: 'Revenue reaches 20' } });
    expect(await f.fixture.calls()).toHaveLength(2);
    expect(f.rows.get(interviewSessions)![0].status).toBe('completed');
    expect(f.rows.get(interviewHistory)).toHaveLength(1);
    expect(f.rows.get(interviewResults)).toHaveLength(1);
    expect(f.rows.get(interviewResults)![0].userId).toBe(42);
  });

  it('rejects foreign sessions/card swaps before queue publication', async () => {
    const f = await setup();
    f.rows.get(interviewSessions)![0].userId = 99;
    await expect(f.respond()).rejects.toThrow('does not belong');
    expect(await f.fixture.calls()).toEqual([]);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });

  it('rolls back history and session state if final-result persistence fails', async () => {
    const f = await setup({
      turns: [
        { answer: 'INTERVIEW_COMPLETE Goal agreed.' },
        {
          answer: JSON.stringify({
            goal: 'Revenue reaches 20',
            successCriteria: ['20 measured'],
            confidence: 90,
          }),
        },
      ],
    });
    const before = structuredClone(f.rows.get(interviewSessions));
    const insert = f.db.insert;
    f.db.insert = vi.fn((table: unknown) => {
      if (table === interviewResults) throw new Error('Synthetic result insert rejection');
      return insert(table);
    });
    await expect(f.respond()).rejects.toThrow('Synthetic result insert rejection');
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]);
    expect(f.rows.get(interviewResults)).toEqual([]);
  });

  it('rechecks authority after card analysis before creating an interview', async () => {
    const f = await setup();
    const before = structuredClone(f.rows.get(interviewSessions));
    mocks.analysis.mockImplementationOnce(async () => {
      f.rows.get(users)![0].sessionEpoch = '2';
      return { summary: 'Synthetic evidence', proposedGoal: 'Outcome' };
    });
    await expect(f.caller.start({ cardId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(await f.fixture.calls()).toEqual([]);
  });

  it('rechecks current card membership at the queued grant before CLI inference', async () => {
    const f = await setup({ holdLogin: true });
    const before = structuredClone(f.rows.get(interviewSessions));
    const pending = request(f.app)
      .post('/trpc/respond')
      .send({
        json: {
          cardId: f.cardId,
          sessionId: f.sessionId,
          response: 'Revenue for customer Alice increases from 10 to 20 by 2026-12-01.',
        },
      })
      .then((value) => value);
    await f.fixture.waitFile('login-ready');
    mocks.card.mockRejectedValue(
      new TrelloAccessError(403, 'This card is no longer assigned to this member'),
    );
    await f.fixture.release('allow-login');
    expect((await pending).status).toBe(403);
    expect(await f.fixture.calls()).toEqual([]);
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });

  it('rejects revoked card access at result acceptance without committing conversation writes', async () => {
    const f = await setup({ turns: [{ answer: 'Private answer', hold: true }] });
    const before = structuredClone(f.rows.get(interviewSessions));
    const pending = f.respond();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await vi.waitFor(async () => expect(await f.fixture.calls()).toHaveLength(1));
    mocks.card.mockRejectedValue(new TrelloAccessError(403, 'Card membership changed'));
    await f.fixture.release('allow-turn');
    await rejected;
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });

  it('checks DB authority after external card reads and never holds its transaction over the GET', async () => {
    const f = await setup();
    let depth = 0;
    const transaction = f.db.transaction;
    f.db.transaction = vi.fn(async (work: any) => {
      depth++;
      try {
        return await transaction(work);
      } finally {
        depth--;
      }
    });
    mocks.card.mockImplementation(async () => {
      expect(depth).toBe(0);
      f.rows.get(users)![0].sessionEpoch = '2';
      return { id: f.cardId, name: 'Synthetic goal' };
    });
    await expect(f.respond()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await f.fixture.calls()).toEqual([]);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });

  it('uses newer persisted conversation instead of the cached start state', async () => {
    const f = await setup({ turns: [{ answer: 'Next question from persisted conversation' }] });
    const persisted = JSON.parse(f.rows.get(interviewSessions)![0].sessionData);
    persisted.messages.push(
      { role: 'user', content: 'Externally persisted answer' },
      { role: 'assistant', content: 'Externally persisted question' },
    );
    f.rows.get(interviewSessions)![0].sessionData = JSON.stringify(persisted);
    await f.respond();
    const calls = await f.fixture.calls();
    expect(calls[0].input.conversation[0].content).toContain('Externally persisted question');
    const saved = JSON.parse(f.rows.get(interviewSessions)![0].sessionData);
    expect(saved.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'Externally persisted answer' })]),
    );
  });

  it('returns mounted CONFLICT on concurrent advancement without overwriting the winner or adding loser history', async () => {
    const f = await setup({
      turns: [{ answer: 'Winning question', hold: true }, { answer: 'Losing question' }],
    });
    const body = {
      json: {
        cardId: f.cardId,
        sessionId: f.sessionId,
        response: 'Revenue for customer Alice increases from 10 to 20 by 2026-12-01.',
      },
    };
    const first = request(f.app)
      .post('/trpc/respond')
      .send(body)
      .then((value) => value);
    await vi.waitFor(async () => expect(await f.fixture.calls()).toHaveLength(1));
    const second = request(f.app)
      .post('/trpc/respond')
      .send(body)
      .then((value) => value);
    await vi.waitFor(async () => expect(await readdir(join(f.fixture.root, 'requests'))).toHaveLength(2));
    await f.fixture.release('allow-turn');
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(409);
    expect(f.rows.get(interviewHistory)).toHaveLength(1);
    const saved = JSON.parse(f.rows.get(interviewSessions)![0].sessionData);
    expect(saved.messages.at(-1).content).toBe('Winning question');
  });

  it('preserves REST admin scope and denies owner/card swaps before invoking the canonical response', async () => {
    const worker = await setup();
    await request(worker.app).post('/api/interview/start').send({ cardId: 'card' }).expect(403);
    const f = await setup({}, 'admin');
    f.rows.get(interviewSessions)![0].userId = 99;
    await request(f.app)
      .post(`/api/interview/${f.sessionId}/respond`)
      .send({ response: 'Valid response' })
      .expect(403);
    f.rows.get(interviewSessions)![0].userId = f.actor.id;
    await request(f.app)
      .post(`/api/interview/${f.sessionId}/respond`)
      .send({ response: 'Valid response', cardId: 'other-card' })
      .expect(403);
    expect(await f.fixture.calls()).toEqual([]);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });

  it('REST delegation preserves response shapes and writes exactly one canonical history and final result', async () => {
    const f = await setup(
      {
        turns: [
          { answer: 'What measurement confirms that outcome?' },
          { answer: 'INTERVIEW_COMPLETE Goal agreed.' },
          {
            answer: JSON.stringify({
              goal: 'Revenue reaches 20',
              successCriteria: ['20 measured'],
              confidence: 90,
            }),
          },
        ],
      },
      'admin',
    );
    const started = await request(f.app)
      .post('/api/interview/start')
      .send({ cardId: 'restcard0001' })
      .expect(200);
    expect(started.body).toMatchObject({
      phase: 1,
      firstMessage: expect.any(String),
      confidence: expect.any(Number),
    });
    const continuing = await request(f.app)
      .post(`/api/interview/${started.body.sessionId}/respond`)
      .send({ response: 'Revenue for customer Alice increases from 10 to 20 by 2026-12-01.' })
      .expect(200);
    expect(continuing.body).toMatchObject({
      isComplete: false,
      nextMessage: 'What measurement confirms that outcome?',
      message: 'What measurement confirms that outcome?',
    });
    const response = await request(f.app)
      .post(`/api/interview/${started.body.sessionId}/respond`)
      .send({ response: 'Revenue for customer Alice increases from 10 to 20 by 2026-12-01.' })
      .expect(200);
    expect(response.body).toMatchObject({
      isComplete: true,
      message: 'Interview completed successfully',
      finalGoal: { goal: 'Revenue reaches 20' },
    });
    expect(f.rows.get(interviewHistory)).toHaveLength(2);
    expect(f.rows.get(interviewResults)).toHaveLength(1);
  });

  it('REST delegated queued responses are fenced by fresh administrator authority', async () => {
    const f = await setup({ holdLogin: true }, 'admin');
    const before = structuredClone(f.rows.get(interviewSessions));
    const pending = request(f.app)
      .post(`/api/interview/${f.sessionId}/respond`)
      .send({ response: 'Revenue for customer Alice increases from 10 to 20 by 2026-12-01.' })
      .then((value) => value);
    await f.fixture.waitFile('login-ready');
    f.rows.get(users)![0].sessionEpoch = '2';
    await f.fixture.release('allow-login');
    expect((await pending).status).toBe(403);
    expect(await f.fixture.calls()).toEqual([]);
    expect(f.rows.get(interviewSessions)).toEqual(before);
    expect(f.rows.get(interviewHistory)).toEqual([]);
  });
});
