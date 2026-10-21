import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { protectedProcedure, router } from '../_core/trpc';
import { analyzeCardBeforeInterview } from '../services/pre-interview-analysis';
import { startInterview, processResponse } from '../services/conversational-interview';
import { getCardInterviewSessions, getInterviewSession } from '../services/interview-persistence';
import { fetchAuthorizedTrelloCardWithComments, TrelloAccessError } from '../trelloCardAccess';
import type { User } from '../../drizzle/schema.postgres';
import {
  users,
  vaProfiles,
  interviewSessions,
  interviewHistory,
  interviewResults,
} from '../../drizzle/schema.postgres';
import { getDb } from '../db';
import { sessionIdentityProof } from '../_core/sessionIdentity';
import { selectWorkerProfile } from '../workerOperatorContext';
import type { TrpcContext } from '../_core/context';

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function interviewAuthority(ctx: TrpcContext, actor: User, cardId: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Interview storage unavailable' });
  const proof = sessionIdentityProof(actor);
  const controller = new AbortController();
  let binding: { id: number; founderId: number; trelloMemberId: string | null } | null | undefined;
  const cancelled = () =>
    controller.abort(new TRPCError({ code: 'FORBIDDEN', message: 'Interview request cancelled' }));
  const disconnected = () => {
    if (!ctx.res.writableEnded) cancelled();
  };
  ctx.req.once?.('aborted', cancelled);
  ctx.res.once?.('close', disconnected);
  if (ctx.req.aborted || ctx.res.destroyed) cancelled();
  const close = () => {
    ctx.req.off?.('aborted', cancelled);
    ctx.res.off?.('close', disconnected);
  };
  const run = async <T,>(action: (tx: Transaction) => Promise<T>): Promise<T> => {
    try {
      controller.signal.throwIfAborted();
      return await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(users)
          .where(eq(users.id, proof.userId))
          .limit(1)
          .for('share');
        if (
          !current ||
          current.openId !== actor.openId ||
          current.sessionEpoch !== proof.sessionEpoch ||
          current.role !== actor.role ||
          !['admin', 'worker'].includes(current.role)
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Interview authority changed' });
        }
        let currentBinding = null;
        if (current.role === 'worker') {
          // Lifecycle triggers must update this locked account before a profile
          // change can commit. Avoid taking profile locks in the inverse order.
          const profiles = await tx
            .select()
            .from(vaProfiles)
            .where(eq(vaProfiles.userId, current.id))
            .orderBy(vaProfiles.id);
          const profile = selectWorkerProfile(profiles);
          if (!profile || !profile.trelloMemberId?.trim()) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Interview authority changed' });
          }
          currentBinding = {
            id: profile.id,
            founderId: profile.founderId,
            trelloMemberId: profile.trelloMemberId,
          };
        }
        if (binding !== undefined && JSON.stringify(binding) !== JSON.stringify(currentBinding)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Interview authority changed' });
        }
        binding = currentBinding;
        controller.signal.throwIfAborted();
        const result = await action(tx);
        controller.signal.throwIfAborted();
        return result;
      });
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  try {
    await run(async () => {});
  } catch (error) {
    close();
    throw error;
  }
  const readCard = async () => {
    try {
      await run(async () => {});
      // Never hold account locks while checking current external card access.
      const card = await getTrelloCard(cardId, actor);
      await run(async () => {});
      return card;
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  return {
    run,
    close,
    signal: controller.signal,
    readCard,
    beforeDispatch: async () => {
      await readCard();
    },
  };
}

// In-memory cache is kept only as a short-lived convenience layer.
const interviewStates = new Map<
  string,
  { sessionId: string; userId: number; state: any; preAnalysis: any }
>();

// Helper to get Trello card with all details
async function getTrelloCard(cardId: string, user: User) {
  try {
    return await fetchAuthorizedTrelloCardWithComments<any>(user, cardId);
  } catch (error) {
    if (error instanceof TrelloAccessError) {
      const code = error.status === 403 ? 'FORBIDDEN' : error.status === 404 ? 'NOT_FOUND' : 'BAD_GATEWAY';
      throw new TRPCError({ code, message: error.message });
    }
    throw error;
  }
}

export const interviewRouter = router({
  /**
   * Start a new interview for a card
   */
  start: protectedProcedure
    .input(
      z.object({
        cardId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { cardId } = input;
      const user = ctx.user;
      const authority = await interviewAuthority(ctx, user, cardId);
      try {
        // Get card data from Trello
        const card = await authority.readCard();
        if (!card) {
          throw new Error('Card not found');
        }

        // Perform pre-interview analysis
        const preAnalysis = await analyzeCardBeforeInterview(card);

        // Start interview
        const { state, firstMessage } = await startInterview(card.name, preAnalysis);
        const sessionId = randomUUID();
        await authority.beforeDispatch();
        await authority.run(async (tx) => {
          await tx.insert(interviewSessions).values({
            id: sessionId,
            cardId,
            userId: user.id,
            userOpenId: user.openId,
            currentPhase: 1,
            currentQuestion: 0,
            questionsAsked: 0,
            responsesProvided: 0,
            overallConfidence: state.overallConfidence,
            preAnalysisSummary: preAnalysis.summary,
            sessionData: JSON.stringify(state),
            status: 'active',
          });
        });
        await authority.beforeDispatch();

        // Store state
        interviewStates.set(cardId, { sessionId, userId: user.id, state, preAnalysis });

        return {
          sessionId,
          firstMessage,
          confidence: state.overallConfidence,
          preAnalysisSummary: preAnalysis.summary,
        };
      } finally {
        authority.close();
      }
    }),

  /**
   * Process user response and get next question
   */
  respond: protectedProcedure
    .input(
      z.object({
        cardId: z.string(),
        sessionId: z.string().optional(),
        response: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { cardId, response, sessionId: providedSessionId } = input;
      const user = ctx.user;
      const authority = await interviewAuthority(ctx, user, cardId);
      try {
        // The cache is presentation-only: another process may have advanced this session.
        const session = providedSessionId
          ? await getInterviewSession(providedSessionId)
          : (await getCardInterviewSessions(cardId))
              .filter((s) => s.userId === user.id && s.userOpenId === user.openId && s.status === 'active')
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        if (!session) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Interview session not found.' });
        }
        if (
          session.userOpenId !== user.openId ||
          session.userId !== user.id ||
          session.cardId !== cardId ||
          (providedSessionId !== undefined && session.id !== providedSessionId)
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Interview session does not belong to this account.',
          });
        }
        if (session.status !== 'active')
          throw new TRPCError({ code: 'CONFLICT', message: 'Interview is no longer active' });
        const state = session.sessionData ? JSON.parse(session.sessionData) : null;
        if (!state)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Interview state unavailable; restart the interview.',
          });
        const card = await authority.readCard();
        const preAnalysis = await analyzeCardBeforeInterview(card);

        // Process response
        const result = await processResponse(state, response, preAnalysis, authority);

        const latestQuestion = state.messages[state.messages.length - 2]?.content || '';
        const questionNumber = Math.max(0, state.validations.length - 1);
        await authority.beforeDispatch();
        await authority.run(async (tx) => {
          const [owned] = await tx
            .select()
            .from(interviewSessions)
            .where(
              and(
                eq(interviewSessions.id, session.id),
                eq(interviewSessions.userId, user.id),
                eq(interviewSessions.userOpenId, user.openId),
                eq(interviewSessions.cardId, cardId),
              ),
            )
            .limit(1)
            .for('update');
          if (
            !owned ||
            owned.status !== 'active' ||
            owned.sessionData !== session.sessionData ||
            owned.updatedAt?.getTime() !== session.updatedAt?.getTime()
          ) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Interview is no longer active' });
          }
          await tx.insert(interviewHistory).values({
            id: randomUUID(),
            sessionId: owned.id,
            cardId,
            userId: user.id,
            userOpenId: user.openId,
            phase: session.currentPhase || 1,
            questionNumber,
            question: latestQuestion || 'N/A',
            response: response || 'N/A',
            isValid: 1,
            validationScore: 75,
            confidenceScore: state.overallConfidence,
            requiresEscalation: 0,
          });
          await tx
            .update(interviewSessions)
            .set({
              currentPhase: session.currentPhase || 1,
              currentQuestion: state.messages.length,
              questionsAsked: state.validations.length,
              responsesProvided: state.validations.length,
              overallConfidence: state.overallConfidence,
              preAnalysisSummary: preAnalysis.summary,
              sessionData: JSON.stringify(state),
              status: 'active',
              updatedAt: new Date(),
            })
            .where(eq(interviewSessions.id, owned.id));

          // If complete, clean up state after returning result
          if (result.isComplete) {
            if (result.finalGoal) {
              const history = await tx
                .select()
                .from(interviewHistory)
                .where(eq(interviewHistory.sessionId, owned.id));
              await tx.insert(interviewResults).values({
                id: randomUUID(),
                sessionId: owned.id,
                cardId,
                userId: user.id,
                userOpenId: user.openId,
                finalGoal: result.finalGoal.goal || '',
                finalDeliverable: result.finalGoal.successCriteria?.join('; ') || '',
                finalAPTLSSChecklist: '[]',
                finalConfidence: result.finalGoal.confidence || 0,
                clarityScore: 0,
                completenessScore: 0,
                executionPlan: JSON.stringify(result.finalGoal),
                estimatedDuration: 0,
                totalQuestionsAsked: history.length,
                totalResponsesProvided: history.filter((row) => row.response).length,
                escalationsRequired: history.filter((row) => row.requiresEscalation).length,
                completedAt: new Date(),
              });
              await tx
                .update(interviewSessions)
                .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
                .where(eq(interviewSessions.id, owned.id));
            }
          }
        });
        await authority.beforeDispatch();
        interviewStates.set(cardId, { sessionId: session.id, userId: user.id, state, preAnalysis });
        if (result.isComplete)
          setTimeout(() => {
            if (interviewStates.get(cardId)?.sessionId === session.id) interviewStates.delete(cardId);
          }, 5000).unref();

        return {
          nextMessage: result.nextMessage,
          isComplete: result.isComplete,
          finalGoal: result.finalGoal,
          confidence: state.overallConfidence,
        };
      } finally {
        authority.close();
      }
    }),

  /**
   * Get current interview state
   */
  getState: protectedProcedure
    .input(
      z.object({
        cardId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { cardId } = input;
      const user = ctx.user;

      const stored = interviewStates.get(cardId);
      if (!stored || stored.userId !== ctx.user.id) {
        const sessions = await getCardInterviewSessions(cardId);
        const session = sessions
          .filter((item: any) => item.userId === ctx.user.id)
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (!session) {
          return null;
        }

        const state = session.sessionData ? JSON.parse(session.sessionData) : null;
        if (!state) return null;

        return {
          messages: state.messages || [],
          confidence: state.overallConfidence || 0,
          isComplete: state.isComplete || session.status === 'completed',
        };
      }

      const { state } = stored;

      return {
        messages: state.messages,
        confidence: state.overallConfidence,
        isComplete: state.isComplete,
      };
    }),

  /**
   * Cancel interview
   */
  cancel: protectedProcedure
    .input(
      z.object({
        cardId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { cardId } = input;
      if (interviewStates.get(cardId)?.userId === ctx.user.id) interviewStates.delete(cardId);
      return { success: true };
    }),
});
