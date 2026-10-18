import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
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
import { taskAssignments } from "../drizzle/schema.postgres";
import { eq, inArray, and } from "drizzle-orm";
import { z } from "zod";
import { operatorRouter } from "./operatorRouter";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => {
      const user = opts.ctx.user;
      // Reject mock/legacy users — they must re-register with local auth
      if (user?.loginMethod === 'mock') return null;
      return user;
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
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
    getCommentToken: trelloRouter.getCommentToken,
    setCommentToken: trelloRouter.setCommentToken,
  }),
  aptlss: aptlssRouter,
  replyMonitor: replyMonitorRouter,
  operator: operatorRouter,

  interview: interviewRouter,
  settings: settingsRouter,
  ares: aresRouter,
  atis: router({
    ...atisTaskSelectorRouter,
    startAnalysis: protectedProcedure
      .input(z.object({
        taskId: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const { runAllPhases } = await import('./services/atis-phases-service');
          const { createAnalysisSession } = await import('./db/atis-phases');

          const workerId = Number(ctx.user.id);
          const workerIdForContext = Number.isFinite(workerId) ? workerId : undefined;
          const cardContext = await aggregateCardContext(input.taskId, workerIdForContext);
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
    bulkComplete: protectedProcedure
      .input(z.object({
        taskIds: z.array(z.string()),
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
        const matchingAssignments = await db
          .select()
          .from(taskAssignments)
          .where(
            and(
              eq(taskAssignments.founderId, userId),
              inArray(taskAssignments.taskId, input.taskIds)
            )
          );

        if (matchingAssignments.length === 0) {
          return {
            success: false,
            completed: 0,
            notFound: input.taskIds.length,
            completedTasks: [],
            timestamp: new Date().toISOString(),
            message: "No matching assignments found for the selected tasks",
          };
        }

        const updatedTaskIds: string[] = [];
        for (const assignment of matchingAssignments) {
          await db
            .update(taskAssignments)
            .set({ status: "completed" })
            .where(eq(taskAssignments.id, assignment.id));

          updatedTaskIds.push(assignment.taskId);
        }

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
          notFound: input.taskIds.length - updatedTaskIds.length,
          completedTasks: updatedTaskIds.map((id) => ({ taskId: id, status: 'completed' })),
          timestamp: new Date().toISOString()
        };
      }),

    bulkIncomplete: protectedProcedure
      .input(z.object({
        taskIds: z.array(z.string()),
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
        const matchingAssignments = await db
          .select()
          .from(taskAssignments)
          .where(
            and(
              eq(taskAssignments.founderId, userId),
              inArray(taskAssignments.taskId, input.taskIds)
            )
          );

        if (matchingAssignments.length === 0) {
          return {
            success: false,
            incompleted: 0,
            notFound: input.taskIds.length,
            incompletedTasks: [],
            timestamp: new Date().toISOString(),
            message: "No matching assignments found for the selected tasks",
          };
        }

        const updatedTaskIds: string[] = [];
        for (const assignment of matchingAssignments) {
          await db
            .update(taskAssignments)
            .set({ status: "in_progress" })
            .where(eq(taskAssignments.id, assignment.id));

          updatedTaskIds.push(assignment.taskId);
        }

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
          notFound: input.taskIds.length - updatedTaskIds.length,
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
