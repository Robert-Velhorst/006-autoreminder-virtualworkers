import express from 'express';
import request from 'supertest';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { users, type User } from '../../drizzle/schema.postgres';
import { createFinancialDatabase, type FinancialDatabase } from '../test/financialDatabase';

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
