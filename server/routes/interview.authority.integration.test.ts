import express from 'express';
import request from 'supertest';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { users, type User } from '../../drizzle/schema.postgres';
import { createFinancialDatabase, type FinancialDatabase } from '../test/financialDatabase';
import { TrelloAccessError } from '../trelloCardAccess';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  card: vi.fn(),
  analysis: vi.fn(),
  llm: vi.fn(),
  provider: vi.fn(),
}));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../trelloCardAccess', async (original) => ({
  ...(await original<typeof import('../trelloCardAccess')>()),
  fetchAuthorizedTrelloCardWithComments: mocks.card,
}));
vi.mock('../services/pre-interview-analysis', () => ({ analyzeCardBeforeInterview: mocks.analysis }));
vi.mock('../_core/llm', () => ({
  invokeLLM: mocks.llm,
  getLLMText: (result: any) => result.choices[0].message.content,
}));
import { interviewRouter } from './interview';

const baseUrl = process.env.APTLSS_TEST_DATABASE_URL;
const responseText = 'Revenue for customer Alice increases from 10 to 20 by 2026-12-01.';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe.skipIf(!baseUrl)(
  'mounted interview native authority and atomic persistence',
  { timeout: 30000 },
  () => {
    let fixture: FinancialDatabase;
    let actor: User;
    let app: express.Express;
    let routeErrors: unknown[];
    const gates: Array<() => void> = [];
    beforeAll(async () => {
      fixture = await createFinancialDatabase(baseUrl);
    }, 120000);
    beforeEach(async () => {
      await fixture.pool.query(
        `TRUNCATE interview_results,interview_history,interview_sessions,va_profiles,users RESTART IDENTITY CASCADE`,
      );
      await fixture.pool.query(`INSERT INTO users (id,"openId",role) VALUES
      (8101,'native-interview-founder','admin'),(8102,'native-interview-worker','worker')`);
      await fixture.pool.query(`INSERT INTO va_profiles (id,"userId","founderId",name,status,"trelloMemberId")
      VALUES (8103,8102,8101,'Native interview worker','active','native-member')`);
      [actor] = await fixture.db.select().from(users).where(eq(users.id, 8102));
      mocks.getDb.mockReset().mockResolvedValue(fixture.db);
      mocks.card.mockReset().mockImplementation(async (_user, cardId) => ({
        id: cardId,
        name: 'Synthetic native goal',
        idMembers: ['native-member'],
      }));
      mocks.analysis
        .mockReset()
        .mockResolvedValue({
          summary: 'Synthetic evidence',
          proposedGoal: 'Measurable outcome',
          confidence: 80,
          evidence: { keywords: ['revenue'] },
          identifiedGaps: [],
        });
      mocks.llm.mockReset();
      mocks.provider.mockReset();
      routeErrors = [];
      app = express();
      app.use(express.json());
      app.use(
        '/trpc',
        createExpressMiddleware({
          router: interviewRouter,
          createContext: ({ req, res }) => ({ req, res, user: { ...actor } }),
          onError: ({ error }) => {
            routeErrors.push(error);
          },
        }),
      );
    });
    afterAll(async () => {
      for (const release of gates.splice(0)) release();
      if (fixture) await fixture.close();
    });

    async function start(cardId: string) {
      const response = await request(app).post('/trpc/start').send({ json: { cardId } }).expect(200);
      const sessionId = response.body.result.data.json.sessionId as string;
      expect(typeof sessionId).toBe('string');
      return sessionId;
    }
    function respond(cardId: string, sessionId: string) {
      return request(app)
        .post('/trpc/respond')
        .send({ json: { cardId, sessionId, response: responseText } });
    }
    async function snapshot(sessionId: string) {
      return {
        session: (
          await fixture.pool.query(`SELECT to_jsonb(s) AS row FROM interview_sessions s WHERE id=$1`, [
            sessionId,
          ])
        ).rows,
        history: (
          await fixture.pool.query(
            `SELECT to_jsonb(h) AS row FROM interview_history h WHERE "sessionId"=$1 ORDER BY id`,
            [sessionId],
          )
        ).rows,
        results: (
          await fixture.pool.query(
            `SELECT to_jsonb(r) AS row FROM interview_results r WHERE "sessionId"=$1 ORDER BY id`,
            [sessionId],
          )
        ).rows,
      };
    }

    const finalGoal = {
      goal: 'Native commit-boundary goal',
      successCriteria: ['20 measured'],
      priority: 'normal',
      constraints: [],
      people: [],
      confidence: 90,
    };
    function completeInterview(afterFinal?: () => Promise<void> | void) {
      let turn = 0;
      mocks.llm.mockImplementation(async (options) => {
        options.signal.throwIfAborted();
        await options.beforeDispatch();
        mocks.provider();
        if (++turn === 1) return completion('INTERVIEW_COMPLETE Goal agreed.');
        await afterFinal?.();
        return completion(JSON.stringify(finalGoal));
      });
    }

    it.each(['start', 'respond'] as const)(
      '%s refuses unavailable final pre-commit card access without adding or changing interview rows',
      async mode => {
        const cardId = `native-precommit-provider-${mode}`;
        const sessionId = mode === 'respond' ? await start(cardId) : undefined;
        const before = sessionId ? await snapshot(sessionId) : undefined;
        let providerUnavailable = false;
        const readCard = mocks.card.getMockImplementation()!;
        mocks.card.mockImplementation(async (...args) => {
          if (providerUnavailable) throw new TrelloAccessError(503, 'Synthetic card provider unavailable');
          return readCard(...args);
        });
        if (mode === 'start') {
          const analysis = mocks.analysis.getMockImplementation()!;
          mocks.analysis.mockImplementation(async (...args) => {
            const value = await analysis(...args);
            providerUnavailable = true;
            return value;
          });
        } else completeInterview(() => { providerUnavailable = true; });
        const response = mode === 'start'
          ? await request(app).post('/trpc/start').send({ json: { cardId } })
          : await respond(cardId, sessionId!);
        expect(providerUnavailable).toBe(true);
        expect(response.status).toBe(502);
        expect(response.body.error.json.data.code).toBe('BAD_GATEWAY');
        if (sessionId) expect(await snapshot(sessionId)).toEqual(before);
        else {
          for (const table of ['interview_sessions', 'interview_history', 'interview_results']) {
            expect((await fixture.pool.query(`SELECT id FROM ${table}`)).rows).toEqual([]);
          }
        }
        expect(mocks.provider).toHaveBeenCalledTimes(mode === 'respond' ? 2 : 0);
      },
    );

    it.each(['start', 'respond'] as const)(
      '%s returns its committed success without requesting a now-unavailable provider after real PG COMMIT',
      async mode => {
        const cardId = `native-postcommit-provider-${mode}`;
        const sessionId = mode === 'respond' ? await start(cardId) : undefined;
        if (mode === 'respond') completeInterview();
        let committed = false, postCommitCardReads = 0;
        const readCard = mocks.card.getMockImplementation()!;
        mocks.card.mockImplementation(async (...args) => {
          if (committed) {
            postCommitCardReads++;
            throw new TrelloAccessError(503, 'Synthetic provider unavailable after commit');
          }
          return readCard(...args);
        });
        const transaction = fixture.db.transaction.bind(fixture.db);
        // Keep the actual PG transaction/COMMIT; fail the provider only once an
        // independent pooled reader can observe the route's committed write.
        const transactionSpy = vi.spyOn(fixture.db, 'transaction').mockImplementation(async (work, config) => {
          const result = await transaction(work, config);
          const visible = await fixture.pool.query(
            `SELECT id FROM interview_sessions WHERE "cardId"=$1 AND status=$2`,
            [cardId, mode === 'respond' ? 'completed' : 'active'],
          );
          if (visible.rows.length) committed = true;
          return result;
        });
        try {
          const response = mode === 'start'
            ? await request(app).post('/trpc/start').send({ json: { cardId } })
            : await respond(cardId, sessionId!);
          expect(committed).toBe(true);
          expect(response.status).toBe(200);
          expect(response.body.error).toBeUndefined();
          expect(routeErrors).toEqual([]);
          expect(postCommitCardReads).toBe(0);
          if (mode === 'respond') {
            expect(response.body.result.data.json).toMatchObject({ isComplete: true, finalGoal });
          } else expect(response.body.result.data.json).toMatchObject({ sessionId: expect.any(String), firstMessage: expect.any(String) });
          const saved = await snapshot(sessionId ?? response.body.result.data.json.sessionId);
          expect(saved.session).toHaveLength(1);
          expect(saved.session[0].row).toMatchObject({ userId: actor.id, cardId, status: mode === 'respond' ? 'completed' : 'active' });
          expect(saved.history).toHaveLength(mode === 'respond' ? 1 : 0);
          expect(saved.results).toHaveLength(mode === 'respond' ? 1 : 0);
          if (mode === 'respond') expect(saved.results[0].row.finalGoal).toBe(finalGoal.goal);
          expect(mocks.provider).toHaveBeenCalledTimes(mode === 'respond' ? 2 : 0);
        } finally { transactionSpy.mockRestore(); }
      },
    );

    it.each(['role', 'epoch'] as const)(
      'still refuses %s revocation after generation and before final-goal commit',
      async change => {
        const cardId = `native-final-commit-${change}`, sessionId = await start(cardId);
        const before = await snapshot(sessionId);
        completeInterview(async () => {
          if (change === 'role') await fixture.pool.query(`UPDATE users SET role='user' WHERE id=$1`, [actor.id]);
          else await fixture.pool.query(`UPDATE users SET "sessionEpoch"="sessionEpoch"+1 WHERE id=$1`, [actor.id]);
        });
        const response = await respond(cardId, sessionId);
        expect(response.status).toBe(403);
        expect(response.body.error.json.data.code).toBe('FORBIDDEN');
        expect(mocks.provider).toHaveBeenCalledTimes(2);
        expect(await snapshot(sessionId)).toEqual(before);
      },
    );

    it('rejects queued approval after real profile offboarding/reactivation increments the epoch, with no generation or interview writes', async () => {
      const cardId = 'native-interview-queued',
        sessionId = await start(cardId);
      const before = await snapshot(sessionId);
      const release = deferred();
      gates.push(release.resolve);
      let waiting = false;
      mocks.llm.mockImplementation(async (options) => {
        // Synthetic adapter boundary: publication and the later dispatch grant
        // both execute the real route authority callback against PostgreSQL.
        await options.beforeDispatch();
        waiting = true;
        await release.promise;
        options.signal.throwIfAborted();
        await options.beforeDispatch();
        mocks.provider();
        return completion('This must never be generated');
      });
      const pending = respond(cardId, sessionId).then((value) => value);
      try {
        await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 5000 });
        await fixture.pool.query(`UPDATE va_profiles SET status='inactive' WHERE id=8103`);
        await fixture.pool.query(`UPDATE va_profiles SET status='active' WHERE id=8103`);
        const [current] = await fixture.db.select().from(users).where(eq(users.id, actor.id));
        expect(BigInt(current.sessionEpoch)).toBeGreaterThan(BigInt(actor.sessionEpoch));
      } finally {
        release.resolve();
        await pending;
      }
      const response = await pending;
      expect(response.status).toBe(403);
      expect(response.body.error.json.data.code).toBe('FORBIDDEN');
      expect(mocks.provider).not.toHaveBeenCalled();
      expect(await snapshot(sessionId)).toEqual(before);
    });

    it('commits an authorized final goal and rolls back history/session changes when a real result INSERT is rejected', async () => {
      const finalGoal = {
        goal: 'Native approved goal',
        successCriteria: ['20 measured'],
        priority: 'normal',
        constraints: [],
        people: [],
        confidence: 90,
      };
      let turn = 0;
      mocks.llm.mockImplementation(async (options) => {
        options.signal.throwIfAborted();
        await options.beforeDispatch();
        mocks.provider();
        return completion(++turn % 2 === 1 ? 'INTERVIEW_COMPLETE Goal agreed.' : JSON.stringify(finalGoal));
      });
      const firstCard = 'native-interview-success',
        first = await start(firstCard);
      const success = await respond(firstCard, first).expect(200);
      expect(success.body.result.data.json).toMatchObject({
        isComplete: true,
        finalGoal: { goal: finalGoal.goal },
      });
      const committed = await snapshot(first);
      expect(committed.session[0].row.status).toBe('completed');
      expect(committed.history).toHaveLength(1);
      expect(committed.results).toHaveLength(1);
      expect(committed.results[0].row).toMatchObject({
        userId: actor.id,
        cardId: firstCard,
        finalGoal: finalGoal.goal,
      });

      const secondCard = 'native-interview-rollback',
        second = await start(secondCard);
      const before = await snapshot(second);
      await fixture.pool
        .query(`CREATE FUNCTION reject_native_interview_result() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic interview result rejection' USING ERRCODE='23514'; END; $$`);
      await fixture.pool
        .query(`CREATE TRIGGER native_interview_result_rejection BEFORE INSERT ON interview_results
      FOR EACH ROW EXECUTE FUNCTION reject_native_interview_result()`);
      try {
        await respond(secondCard, second).expect(500);
        const causes: Array<{ code?: string; message?: string }> = [];
        let cause: any = routeErrors.at(-1);
        const seen = new Set<unknown>();
        while (cause && !seen.has(cause)) {
          seen.add(cause);
          causes.push(cause);
          cause = cause.cause;
        }
        expect(causes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: '23514', message: 'Synthetic interview result rejection' }),
          ]),
        );
        expect(mocks.provider).toHaveBeenCalledTimes(4);
        expect(await snapshot(second)).toEqual(before);
        expect(await snapshot(first)).toEqual(committed);
      } finally {
        await fixture.pool.query('DROP TRIGGER native_interview_result_rejection ON interview_results');
        await fixture.pool.query('DROP FUNCTION reject_native_interview_result()');
      }
    });
  },
);
