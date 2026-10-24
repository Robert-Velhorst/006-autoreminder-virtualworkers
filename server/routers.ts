import { COOKIE_NAME } from "@shared/const";
import { parseCookie as parseCookieHeader } from "cookie";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, operatorAccountProcedure, publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { invalidateCache } from "./services/trello-cache";
import { interviewRouter } from "./routes/interview";
import { settingsRouter } from "./routes/settings";
import { atisTaskSelectorRouter } from "./routes/atis-task-selector";
import { aresRouter } from "./routers/ares";
import {
  paymentRouter,
  payLogRouter,
  triageRouter,
  onHoldChecksRouter,
  streakRouter,
  sundayRouter,
  timerRouter,
  complianceRouter,
  emailInboxRouter,
  cardSnoozeRouter
} from "./routes/manus";
import { trelloRouter, aptlssRouter, replyMonitorRouter } from "./routes/manus-trello-aptlss";

import { aggregateCardContext, formatContextForAI } from "./services/context-aggregator";
import { websocketService } from "./services/websocket";
import { getDb } from "./db";
import { vaProfiles } from "../drizzle/schema.postgres";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { operatorRouter } from "./operatorRouter";
import { reminderRouter } from "./reminderRouter";
import { haiConnectorRouter } from "./haiConnectorRouter";
import { maintenanceRouter } from "./maintenanceRouter";
import { fetchAuthorizedTrelloCard, TrelloAccessError } from "./trelloCardAccess";
import { assignmentFailure, type AssignmentActor } from "./taskAssignmentMutation";
import { changeAssignmentStatuses, type AssignmentStatus } from "./taskAssignmentService";

async function changeSchedulingStatuses(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, actor: AssignmentActor,
  input: { taskIds: string[]; status: AssignmentStatus }) {
  try { return await changeAssignmentStatuses(db, actor, input); }
  catch (error) {
    const failure = assignmentFailure(error);
    if (failure) throw new TRPCError({
      code: failure.status === 409 ? "CONFLICT" : failure.status === 404 ? "NOT_FOUND"
        : failure.status === 403 ? "FORBIDDEN" : failure.status === 400 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE",
      message: failure.error,
    });
    throw error;
  }
}

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => {
      const user = opts.ctx.user;
      // Reject mock/legacy users — they must re-register with local auth
      if (user?.loginMethod === 'mock') return null;
      if (!user) return null;
      // Session and credential material must remain server-side, including future fields.
      return {
        id: user.id, openId: user.openId, name: user.name, email: user.email,
        loginMethod: user.loginMethod, role: user.role,
        createdAt: user.createdAt, updatedAt: user.updatedAt, lastSignedIn: user.lastSignedIn,
      };
    }),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      try {
        await (await import("./_core/sdk")).sdk.revokeSession(parseCookieHeader(ctx.req.headers.cookie ?? "")[COOKIE_NAME]);
      } finally {
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.clearCookie(COOKIE_NAME, cookieOptions);
      }
      return {
        success: true,
      } as const;
    }),
  }),

  trello: router({
    reschedule: protectedProcedure.mutation(async ({ ctx }) => {
      const userId = Number(ctx.user.id);
      await invalidateCache(userId, String(ctx.user.openId), 'tasks');

      return {
        success: true,
        message: 'Cache cleared. Tasks will be rescheduled on next refresh.',
        note: 'APTLSS will regenerate schedules the next time tasks are loaded.',
      };
    }),
    weeklyHours: trelloRouter.weeklyHours,
    recentUpdates: trelloRouter.recentUpdates,
    actionAlerts: trelloRouter.actionAlerts,
    webhooks: trelloRouter.webhooks,
    postComment: trelloRouter.postComment,
  }),
  aptlss: aptlssRouter,
  replyMonitor: replyMonitorRouter,
  operator: operatorRouter,
  reminders: reminderRouter,
  haiConnector: haiConnectorRouter,
  maintenance: maintenanceRouter,

  interview: interviewRouter,
  settings: settingsRouter,
  ares: aresRouter,
  atis: router({
    ...atisTaskSelectorRouter,
    startAnalysis: operatorAccountProcedure
      .input(z.object({
        taskId: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const { runAllPhases } = await import('./services/atis-phases-service');
          const { createAnalysisSession } = await import('./db/atis-phases');

          // Legacy aggregation uses the shared Trello connector. Authorize the
          // card against the caller before collecting any context from it.
          try {
            await fetchAuthorizedTrelloCard(ctx.user, input.taskId, { fields: 'id,idMembers' });
          } catch (error) {
            if (error instanceof TrelloAccessError) {
              throw new TRPCError({
                code: error.status === 404 ? 'NOT_FOUND' : error.status === 403 ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
                message: error.message,
              });
            }
            throw error;
          }

          const workerUserId = Number(ctx.user.id);
          const db = await getDb();
          const [workerProfile] = db && Number.isFinite(workerUserId)
            ? await db.select({ id: vaProfiles.id }).from(vaProfiles)
              .where(eq(vaProfiles.userId, workerUserId))
              .limit(1)
            : [];
          const cardContext = await aggregateCardContext(input.taskId, workerUserId);
          const taskDescription = formatContextForAI(cardContext);
          const sessionId = await createAnalysisSession(input.taskId, String(ctx.user.id));

          setTimeout(() => {
            void runAllPhases(input.taskId, String(ctx.user.id), taskDescription, sessionId).catch((error) => {
              console.error('[ATIS Analysis tRPC] Background analysis failed:', error);
            });
          }, 0);

          return {
            success: true,
            data: {
              sessionId,
              taskId: input.taskId,
              taskTitle: cardContext.cardTitle,
              status: 'in_progress',
              overallConfidence: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              phase1: null,
              phase2: null,
            },
          };
        } catch (error) {
          console.error('[ATIS Analysis tRPC] Error:', error);
          throw error;
        }
      }),
  }),

  scheduling: router({
    bulkComplete: adminProcedure
      .input(z.object({
        taskIds: z.array(z.string().min(1)).min(1).max(100),
      }))
      .mutation(async ({ input, ctx }) => {
        if (input.taskIds.length === 0) {
          throw new Error("No tasks selected");
        }

        const db = await getDb();
        if (!db) {
          throw new Error("Database not available");
        }

        const userId = Number(ctx.user.id);
        const results = await changeSchedulingStatuses(db, ctx.user, { taskIds: input.taskIds, status: "completed" });
        const updatedTaskIds = results.map(result => result.assignment.taskId);

        await invalidateCache(userId, String(ctx.user.openId), 'tasks');
        websocketService.emitToUser(String(ctx.user.openId), "task:completed", {
          taskIds: updatedTaskIds,
          isCompleted: true,
          timestamp: new Date().toISOString(),
          source: "bulk_complete",
        });

        return {
          success: true,
          completed: updatedTaskIds.length,
          notFound: 0,
          completedTasks: updatedTaskIds.map((id) => ({ taskId: id, status: 'completed' })),
          timestamp: new Date().toISOString()
        };
      }),

    bulkIncomplete: adminProcedure
      .input(z.object({
        taskIds: z.array(z.string().min(1)).min(1).max(100),
      }))
      .mutation(async ({ input, ctx }) => {
        if (input.taskIds.length === 0) {
          throw new Error("No tasks selected");
        }

        const db = await getDb();
        if (!db) {
          throw new Error("Database not available");
        }

        const userId = Number(ctx.user.id);
        const results = await changeSchedulingStatuses(db, ctx.user, { taskIds: input.taskIds, status: "in_progress" });
        const updatedTaskIds = results.map(result => result.assignment.taskId);

        await invalidateCache(userId, String(ctx.user.openId), 'tasks');
        websocketService.emitToUser(String(ctx.user.openId), "task:completed", {
          taskIds: updatedTaskIds,
          isCompleted: false,
          timestamp: new Date().toISOString(),
          source: "bulk_incomplete",
        });

        return {
          success: true,
          incompleted: updatedTaskIds.length,
          notFound: 0,
          incompletedTasks: updatedTaskIds.map((id) => ({ taskId: id, status: 'in_progress' })),
          timestamp: new Date().toISOString()
        };
      }),
  }),

  // Manus merged routers
  payment: paymentRouter,
  payLog: payLogRouter,
  triage: triageRouter,
  onHoldChecks: onHoldChecksRouter,
  streak: streakRouter,
  sunday: sundayRouter,
  timer: timerRouter,
  compliance: complianceRouter,
  emailInbox: emailInboxRouter,
  cardSnooze: cardSnoozeRouter,
});

export type AppRouter = typeof appRouter;
