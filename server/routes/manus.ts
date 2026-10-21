import { z } from "zod";
import { closeCanonicalTimer, insertCanonicalTimer, withTimerAccountTransaction, lockTimerAccount, timerFailure, timeCompleteness, correctCanonicalTimer, assertTimerIdentityReady } from "../canonicalTimer";
import { recordedSeconds } from "../../shared/timerDuration";
import { TRPCError } from "@trpc/server";
import { adminProcedure, operatorAccountProcedure, router, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import {
  timeEntries,
  weeklyPayLog,
  dailyTriageState,
  sundayChecklist,
  dailyDueDateAssignments,
  dailyCardUpdates,
  onHoldDailyChecks,
  dailyUpdateStreak,
  appSettings,
  dailyComplianceSnapshots,
  replyThreads,
  vagueReplyFlags,
  emailTasks,
  cardSnoozes,
  vaProfiles,
  aptlssPlans,
  aptlssWaitingReasons,
  cardStates,
  taskAssignments,
  trelloCachedCards,
  users,
} from "../../drizzle/schema.postgres";
import { eq, and, desc, gte, lte, sql, isNull, isNotNull, inArray } from "drizzle-orm";
import { collectComplianceSnapshot } from "../services/manus-scheduler";
import { parseDateKey } from "../utils/date-only";
import { calculateCompliancePercentage } from "../complianceMetrics";
import { dateKeyInTimeZone, dateWindowInTimeZone, weekDateKeys } from "../../shared/workerTime";
import { resolveWorkerOperatorContext } from "../workerOperatorContext";
import { canStartTimerForCard, managerActionNeedsSourceVerification, managerActionSourceRequirements, managerExecutionCoverageComplete, managerIntervenesOnCard, timerExecutionBlockReason } from "../timerAccess";
import { isManagerPilotWorker } from "../aptlssManagerPilot";
import { enqueueManagerTask } from "../aptlssManagerQueue";
import { WORKER_EXECUTION_HOLD_MESSAGE } from "../../shared/aptlssManager";
import { parseManagerAssignmentReference, readManagerAssignmentState } from "../aptlssManagerAssignments";
import { selectWorkerProfile } from "../workerOperatorContext";
import { getGoogleEvidenceStatus } from "../googleEvidence";
import { readCurrentManagerHistory } from "../aptlssManagerHistoryDb";
import { assertCanonicalAssignmentRows, readCanonicalAssignments, assignmentFailure, MAX_ASSIGNMENT_TASKS } from "../taskAssignmentMutation";
import { financialFailure, settlePaymentCycle, saveWeeklyPayLog, getWeeklyPayLogs, getWeeklyPayLog } from '../financialLedger';
import { readPaymentCycles } from '../financialReadService';

// ─── Payment Cycles Router ──────────────────────────────────────────────────
const financialId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const financialCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const financialDateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { parseDateKey(value); return true; } catch { return false; }
}, 'A valid calendar date is required');
function throwFinancialRouteError(error: unknown): never {
  const failure = financialFailure(error);
  if (!failure) throw error;
  throw new TRPCError({ code: failure.status === 400 ? 'BAD_REQUEST'
    : failure.status === 403 ? 'FORBIDDEN' : failure.status === 404 ? 'NOT_FOUND'
      : failure.status === 409 ? 'CONFLICT' : 'INTERNAL_SERVER_ERROR', message: failure.error });
}

export const paymentRouter = router({
  getAllCycles: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
    return readPaymentCycles(db, ctx.user);
  }),

  getCurrentCycle: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
    const all = await readPaymentCycles(db, ctx.user, true);
    return all[0] ?? null;
  }),

  markPaid: adminProcedure
    .input(z.object({ cycleId: financialId }).strict())
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      try {
        await settlePaymentCycle(db, ctx.user, input);
      } catch (error) { throwFinancialRouteError(error); }
      return { success: true };
    }),
});

// ─── Weekly Pay Log Router ──────────────────────────────────────────────────
export const payLogRouter = router({
  getAll: operatorAccountProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional(), vaId: financialId.optional() }).strict())
    .query(async ({ input, ctx }) => {
      if (ctx.user.role === 'admin' && input.vaId === undefined) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'An explicit worker user ID is required' });
      }
      if (ctx.user.role === 'worker' && input.vaId !== undefined && input.vaId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Workers can read only their own pay log' });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
      try { return await getWeeklyPayLogs(db, ctx.user, input); }
      catch (error) { throwFinancialRouteError(error); }
    }),

  getByWeek: operatorAccountProcedure
    .input(z.object({ weekStart: financialDateKey, vaId: financialId.optional() }).strict())
    .query(async ({ input, ctx }) => {
      if (ctx.user.role === 'admin' && input.vaId === undefined) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'An explicit worker user ID is required' });
      }
      if (ctx.user.role === 'worker' && input.vaId !== undefined && input.vaId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Workers can read only their own pay log' });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB not available' });
      try { return await getWeeklyPayLog(db, ctx.user, input); }
      catch (error) { throwFinancialRouteError(error); }
    }),

  upsert: adminProcedure
    .input(z.object({
      vaId: financialId,
      weekStart: financialDateKey,
      weekEnd: financialDateKey,
      expectedRevision: z.string().max(100_000).nullable(),
      paymentCycleId: financialId.optional(),
      meritM1: financialCount.default(0),
      meritM2: financialCount.default(0),
      meritM3: financialCount.default(0),
      meritStreak: financialCount.default(0),
      demeritD1: financialCount.default(0),
      demeritD2: financialCount.default(0),
      demeritD3: financialCount.default(0),
      demeritD4: financialCount.default(0),
      demeritD5: financialCount.default(0),
      demeritD6: financialCount.default(0),
      demeritD7: financialCount.default(0),
      demeritD8: financialCount.default(0),
      demeritD9: financialCount.default(0),
      demeritD10: financialCount.default(0),
      demeritD11: financialCount.default(0),
      notes: z.string().optional(),
    }).strict().refine(value => value.weekEnd >= value.weekStart, 'Week end must not precede week start'))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      try { return (await saveWeeklyPayLog(db, ctx.user, input)).log; }
      catch (error) { throwFinancialRouteError(error); }
    }),
});

// ─── Daily Triage Router ──────────────────────────────────────────────────────
export const triageRouter = router({
  getByDate: operatorAccountProcedure
    .input(z.object({ date: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const vaId = Number(ctx.user.id);
      const rows = await db.select().from(dailyTriageState).where(
        and(eq(dailyTriageState.triageDate, parseDateKey(input.date)), eq(dailyTriageState.vaId, vaId))
      ).limit(1);
      return rows[0] ?? null;
    }),

  upsert: operatorAccountProcedure
    .input(z.object({
      triageDate: z.string(),
      step1Done: z.boolean().optional(),
      step2Done: z.boolean().optional(),
      step3Done: z.boolean().optional(),
      step4Done: z.boolean().optional(),
      step5Done: z.boolean().optional(),
      focusTasks: z.string().nullable().optional(),
      eveningStep1Done: z.boolean().optional(),
      eveningStep2Done: z.boolean().optional(),
      eveningStep3Done: z.boolean().optional(),
      eveningStep4Done: z.boolean().optional(),
      eodReport: z.string().nullable().optional(),
      currentView: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);

      const values: any = {
        vaId,
        triageDate: parseDateKey(input.triageDate),
        ...(input.step1Done !== undefined && { step1Done: input.step1Done }),
        ...(input.step2Done !== undefined && { step2Done: input.step2Done }),
        ...(input.step3Done !== undefined && { step3Done: input.step3Done }),
        ...(input.step4Done !== undefined && { step4Done: input.step4Done }),
        ...(input.step5Done !== undefined && { step5Done: input.step5Done }),
        ...(input.focusTasks !== undefined && { focusTasks: input.focusTasks }),
        ...(input.eveningStep1Done !== undefined && { eveningStep1Done: input.eveningStep1Done }),
        ...(input.eveningStep2Done !== undefined && { eveningStep2Done: input.eveningStep2Done }),
        ...(input.eveningStep3Done !== undefined && { eveningStep3Done: input.eveningStep3Done }),
        ...(input.eveningStep4Done !== undefined && { eveningStep4Done: input.eveningStep4Done }),
        ...(input.eodReport !== undefined && { eodReport: input.eodReport }),
        ...(input.currentView !== undefined && { currentView: input.currentView }),
      };

      const existing = await db.select().from(dailyTriageState).where(
        and(eq(dailyTriageState.triageDate, parseDateKey(input.triageDate)), eq(dailyTriageState.vaId, vaId))
      ).limit(1);

      if (existing[0]) {
        await db.update(dailyTriageState).set(values).where(eq(dailyTriageState.id, existing[0].id));
        return { ...existing[0], ...values };
      } else {
        const [result] = await db.insert(dailyTriageState).values(values)
          .returning({ id: dailyTriageState.id });
        return { id: result?.id, ...values };
      }
    }),

  getRecent: operatorAccountProcedure
    .input(z.object({ limit: z.number().optional(), vaId: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      const isWorker = ctx.user.role === "worker";
      const vaId = isWorker ? Number(ctx.user.id) : input.vaId;
      if (!vaId) return [];

      return db.select().from(dailyTriageState)
        .where(and(eq(dailyTriageState.vaId, vaId), isNotNull(dailyTriageState.eodReport)))
        .orderBy(desc(dailyTriageState.triageDate))
        .limit(input.limit ?? 7);
    }),
});

// ─── ON-HOLD Daily Checks Router ─────────────────────────────────────────────
export const onHoldChecksRouter = router({
  getByDate: operatorAccountProcedure
    .input(z.object({ date: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      const vaId = Number(ctx.user.id);
      return db.select().from(onHoldDailyChecks).where(
        and(eq(onHoldDailyChecks.date, parseDateKey(input.date)), eq(onHoldDailyChecks.vaId, vaId))
      );
    }),

  markChecked: operatorAccountProcedure
    .input(z.object({
      cardId: z.string(),
      cardName: z.string(),
      cardUrl: z.string(),
      date: z.string(),
      checked: z.boolean(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);

      const existing = await db.select().from(onHoldDailyChecks).where(
        and(
          eq(onHoldDailyChecks.cardId, input.cardId),
          eq(onHoldDailyChecks.date, parseDateKey(input.date)),
          eq(onHoldDailyChecks.vaId, vaId)
        )
      ).limit(1);

      const values = {
        vaId,
        cardId: input.cardId,
        cardName: input.cardName,
        cardUrl: input.cardUrl,
        date: parseDateKey(input.date),
        checked: input.checked,
        checkedAt: input.checked ? new Date() : null,
      };

      if (existing[0]) {
        await db.update(onHoldDailyChecks).set(values).where(eq(onHoldDailyChecks.id, existing[0].id));
        return { success: true };
      } else {
        await db.insert(onHoldDailyChecks).values(values);
        return { success: true };
      }
    }),
});

// ─── Streak Router ──────────────────────────────────────────────────────────
export const streakRouter = router({
  get: operatorAccountProcedure
    .input(z.object({ vaId: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { currentStreak: 0, longestStreak: 0 };
      const isWorker = ctx.user.role === "worker";
      const vaId = isWorker ? Number(ctx.user.id) : input.vaId;
      if (!vaId) return { currentStreak: 0, longestStreak: 0 };

      const rows = await db.select().from(dailyUpdateStreak)
        .where(and(eq(dailyUpdateStreak.vaId, vaId), eq(dailyUpdateStreak.completedBeforeDeadline, true)))
        .orderBy(desc(dailyUpdateStreak.streakDate));

      if (rows.length === 0) return { currentStreak: 0, longestStreak: 0 };

      let currentStreak = 0;
      let longestStreak = 0;
      let tempStreak = 0;
      let lastDate: Date | null = null;

      for (let i = 0; i < rows.length; i++) {
        const d = new Date(rows[i].streakDate);
        if (!lastDate) {
          tempStreak = 1;
        } else {
          const diff = Math.round((lastDate.getTime() - d.getTime()) / (1000 * 3600 * 24));
          if (diff === 1) {
            tempStreak++;
          } else if (diff > 1) {
            if (tempStreak > longestStreak) longestStreak = tempStreak;
            tempStreak = 1;
          }
        }
        lastDate = d;
      }
      if (tempStreak > longestStreak) longestStreak = tempStreak;
      currentStreak = tempStreak;

      return { currentStreak, longestStreak };
    }),

  record: operatorAccountProcedure
    .input(z.object({
      streakDate: z.string(),
      completedBeforeDeadline: z.boolean(),
      doingCardCount: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);

      const existing = await db.select().from(dailyUpdateStreak).where(
        and(eq(dailyUpdateStreak.streakDate, parseDateKey(input.streakDate)), eq(dailyUpdateStreak.vaId, vaId))
      ).limit(1);

      const values = {
        vaId,
        streakDate: parseDateKey(input.streakDate),
        completedBeforeDeadline: input.completedBeforeDeadline,
        doingCardCount: input.doingCardCount,
        completedAt: new Date(),
      };

      if (existing[0]) {
        await db.update(dailyUpdateStreak).set(values).where(eq(dailyUpdateStreak.id, existing[0].id));
      } else {
        await db.insert(dailyUpdateStreak).values(values);
      }
      return { success: true };
    }),
});

// ─── Sunday Checklist Router ───────────────────────────────────────────────
export const sundayRouter = router({
  getByDate: operatorAccountProcedure
    .input(z.object({ date: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const vaId = Number(ctx.user.id);
      const rows = await db.select().from(sundayChecklist).where(
        and(eq(sundayChecklist.sundayDate, parseDateKey(input.date)), eq(sundayChecklist.vaId, vaId))
      ).limit(1);
      return rows[0] ?? null;
    }),

  upsert: operatorAccountProcedure
    .input(z.object({
      sundayDate: z.string(),
      trelloArchived: z.boolean().optional(),
      trelloLabels: z.boolean().optional(),
      trelloDeadlines: z.boolean().optional(),
      trelloTimers: z.boolean().optional(),
      emailInbox: z.boolean().optional(),
      whatsappCleared: z.boolean().optional(),
      upworkArchived: z.boolean().optional(),
      downloadsCleared: z.boolean().optional(),
      desktopCleared: z.boolean().optional(),
      browserTabsClosed: z.boolean().optional(),
      weekReviewed: z.boolean().optional(),
      nextWeekPlanned: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);

      const { sundayDate, ...fields } = input;
      const existing = await db.select().from(sundayChecklist).where(
        and(eq(sundayChecklist.sundayDate, parseDateKey(sundayDate)), eq(sundayChecklist.vaId, vaId))
      ).limit(1);

      const values = {
        vaId,
        sundayDate: parseDateKey(sundayDate),
        ...fields,
      };

      if (existing[0]) {
        await db.update(sundayChecklist).set(values).where(eq(sundayChecklist.id, existing[0].id));
        return { ...existing[0], ...values };
      } else {
        const [result] = await db.insert(sundayChecklist).values(values)
          .returning({ id: sundayChecklist.id });
        return { id: result?.id, ...values };
      }
    }),
});

async function requireTimerHistory(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, founderId: number) {
  const status = await timeCompleteness(db, founderId);
  if (!status.complete) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Historical time ownership requires operator review; totals are incomplete" });
}

async function timerRoute<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const failure = assignmentFailure(error) ?? timerFailure(error);
    if (failure) throw new TRPCError({ code: failure.status === 409 ? "CONFLICT" : failure.status === 404 ? "NOT_FOUND" : failure.status === 400 ? "BAD_REQUEST" : "FORBIDDEN", message: failure.error });
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Timer operation could not be completed" });
  }
}

// ─── Time Tracker Router ────────────────────────────────────────────────────
export const timerRouter = router({
  getDateContext: operatorAccountProcedure.query(async ({ ctx }) => {
    const worker = await resolveWorkerOperatorContext(ctx.user);
    const date = dateKeyInTimeZone(new Date(Date.now()), worker.timezone);
    const week = weekDateKeys(date);
    return { timezone: worker.timezone, date, startDate: week.startDateKey, endDate: week.endDateKey };
  }),
  start: operatorAccountProcedure
    .input(z.object({
      cardId: z.string(),
      cardName: z.string(),
      cardUrl: z.string(),
      boardName: z.string().default("Unknown Board"),
      listName: z.string().default("Unknown"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);
      return timerRoute(() => withTimerAccountTransaction(db, ctx.user, async (tx, locked) => {
        const profiles = ctx.user.role === "worker"
          ? await tx.select({ id: vaProfiles.id, founderId: vaProfiles.founderId, status: vaProfiles.status }).from(vaProfiles)
            .where(eq(vaProfiles.userId, vaId)).orderBy(vaProfiles.id).for("update")
          : [];
        const profile = selectWorkerProfile(profiles);
        if (ctx.user.role === "worker" && !profile) {
          const activeProfileCount = profiles.filter(candidate => candidate.status === "active").length;
          throw new TRPCError({
            code: activeProfileCount > 1 ? "PRECONDITION_FAILED" : "FORBIDDEN",
            message: activeProfileCount > 1
              ? "Your worker profile is ambiguous. Ask an administrator to resolve it before tracking time."
              : "A worker profile is required before tracking time.",
          });
        }
        const managerPilot = ctx.user.role === "worker" && isManagerPilotWorker(vaId);
        const [workerPlan] = ctx.user.role === "worker"
          ? await tx.select().from(aptlssPlans)
            .where(and(eq(aptlssPlans.vaId, vaId), eq(aptlssPlans.cardId, input.cardId)))
            .limit(1)
          : [];
        if (ctx.user.role === "worker") {
          const founderAssignments = await tx.select()
            .from(taskAssignments)
            .where(eq(taskAssignments.founderId, profile!.founderId));
          const cardKeys = [...new Set([input.cardId, ...founderAssignments
            .filter(assignment => parseManagerAssignmentReference(assignment.taskId)?.cardId === input.cardId)
            .map(assignment => assignment.taskId)])];
          if (cardKeys.length > MAX_ASSIGNMENT_TASKS) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This card has too many assignment keys to verify safely." });
          }
          const cardRows = await readCanonicalAssignments(tx, profile!.founderId, cardKeys, { lock: true });
          assertCanonicalAssignmentRows(cardRows);
          if (cardRows.length > 250) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your current task assignments could not be verified. Refresh your work list before tracking time." });
          }
          const cardAssignments = cardRows.filter(assignment =>
            assignment.vaId === profile!.id && ["assigned", "in_progress", "blocked"].includes(assignment.status),
          );
          if (!cardAssignments.some(assignment => assignment.status === "assigned" || assignment.status === "in_progress")) {
            if (cardAssignments.some(assignment => assignment.status === "blocked")) {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This task is blocked. Ask the founder to update the assignment before tracking time." });
            }
            throw new TRPCError({ code: "FORBIDDEN", message: "This task is not currently assigned to your worker profile." });
          }
        }
        if (!canStartTimerForCard(ctx.user.role, Boolean(workerPlan))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only start a timer for a card in your work queue" });
        }
        if (workerPlan) {
          const [waiting] = await tx.select({ id: aptlssWaitingReasons.id }).from(aptlssWaitingReasons)
            .where(and(eq(aptlssWaitingReasons.vaId, vaId), eq(aptlssWaitingReasons.cardId, input.cardId), eq(aptlssWaitingReasons.status, "active")))
            .limit(1);
          const [cardState] = await tx.select({ state: cardStates.state }).from(cardStates)
            .where(and(eq(cardStates.vaId, vaId), eq(cardStates.cardId, input.cardId))).limit(1);
          let hasManagerIntervention = false;
          let hasStaleRequiredSource = false;
          if (managerPilot) {
            try {
              const { snapshot } = await readCurrentManagerHistory(tx as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>, vaId);
              if (!snapshot) throw new Error("Manager history is unavailable");
              const snapshotJson = JSON.stringify(snapshot);
              const assignmentState = await readManagerAssignmentState(tx as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>, vaId);
              if (!assignmentState.complete || !managerExecutionCoverageComplete(snapshotJson, assignmentState.fingerprint)) {
                throw new Error("Work list coverage is incomplete");
              }
              const sourceRequirements = managerActionSourceRequirements(snapshotJson, input.cardId);
              let googleStatus: Awaited<ReturnType<typeof getGoogleEvidenceStatus>> | null = null;
              if (sourceRequirements.sourceKeys.some(key => key === "gmail" || key === "google_drive")) {
                try { googleStatus = await getGoogleEvidenceStatus(vaId); }
                catch { googleStatus = null; }
              }
              let trelloCache: { cachedAt: string; expiresAt: string } | null = null;
              if (sourceRequirements.sourceKeys.includes("trello")) {
                const [cached] = await tx.select({ cachedAt: trelloCachedCards.cachedAt, expiresAt: trelloCachedCards.expiresAt })
                  .from(trelloCachedCards)
                  .where(and(eq(trelloCachedCards.userId, vaId), eq(trelloCachedCards.cardId, input.cardId)))
                  .orderBy(desc(trelloCachedCards.cachedAt)).limit(1);
                if (cached) trelloCache = { cachedAt: cached.cachedAt.toISOString(), expiresAt: cached.expiresAt.toISOString() };
              }
              hasStaleRequiredSource = managerActionNeedsSourceVerification(sourceRequirements, {
                trelloCache,
                gmail: googleStatus?.gmail ?? null,
                drive: googleStatus?.drive ?? null,
                googleConnectionReady: googleStatus?.credentialsReady ?? null,
                now: Date.now(),
              });
              hasManagerIntervention = managerIntervenesOnCard(snapshotJson, input.cardId);
            } catch {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: WORKER_EXECUTION_HOLD_MESSAGE });
            }
          }
          const reason = timerExecutionBlockReason({ listName: workerPlan.listName,
            hasActiveWaitingReason: Boolean(waiting), actionability: cardState?.state ?? null, hasManagerIntervention, hasStaleRequiredSource });
          if (reason) throw new TRPCError({ code: "PRECONDITION_FAILED", message: reason });
        }
        const founderId = ctx.user.role === "worker" ? profile!.founderId : vaId;
        const startTime = new Date();
        const cardName = workerPlan?.cardName ?? input.cardName;
        const result = await insertCanonicalTimer(tx, {
          taskId: input.cardId, vaId: null, trackedUserId: vaId, trackedProfileId: locked.profile?.id ?? null, founderId, cardId: input.cardId, cardName,
          cardUrl: workerPlan?.cardUrl ?? input.cardUrl,
          boardName: workerPlan?.boardName ?? input.boardName,
          listName: workerPlan?.listName ?? input.listName,
          startTime,
        });
        const id = result.id;
        if (managerPilot) {
          await enqueueManagerTask(tx, { vaId, trigger: "timer_changed", eventKey: `timer-start:${id}` });
        }
        return { ...result, id, cardId: input.cardId, cardName, startedAt: startTime };
      }));
    }),

  stop: operatorAccountProcedure
    .input(z.object({ cardId: z.string(), entryId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      return timerRoute(async () => {
        const result = await closeCanonicalTimer(db, ctx.user, input.entryId, 'stop', { cardId: input.cardId,
          afterClose: async (tx, entry) => {
            if (isManagerPilotWorker(ctx.user.id)) await enqueueManagerTask(tx, { vaId: ctx.user.id,
              trigger: "timer_changed", eventKey: `timer-closed:${entry.id}` });
          },
        });
        return { ...result, ...result.entry, stoppedAt: result.entry.endTime, durationSeconds: recordedSeconds(result.entry) };
      });
    }),

  getActive: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const vaId = Number(ctx.user.id);
    const worker = await resolveWorkerOperatorContext(ctx.user);
    const rows = await db.select().from(timeEntries).where(
      and(eq(timeEntries.trackedUserId, vaId), isNull(timeEntries.endTime), eq(timeEntries.isVoided, false))
    ).orderBy(desc(timeEntries.startTime)).limit(1);
    const active = rows[0];
    if (!active) await timerRoute(() => assertTimerIdentityReady(db));
    if (active && active.founderId !== (worker.founderId ?? ctx.user.id)) {
      throw new TRPCError({ code: "CONFLICT", message: "An active timer belongs to a previous founder. Ask that founder to close the exact entry before starting another timer." });
    }
    return active
      ? {
          ...active,
          cardId: active.cardId ?? active.taskId,
          cardName: active.cardName ?? "Unknown Card",
          cardUrl: active.cardUrl ?? "#",
          startedAt: active.startTime,
        }
      : null;
  }),

  getByCard: operatorAccountProcedure
    .input(z.object({ cardId: z.string(), limit: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable; timer history cannot be verified" });
      const vaId = Number(ctx.user.id);
      const worker = await resolveWorkerOperatorContext(ctx.user);
      await requireTimerHistory(db, worker.founderId ?? ctx.user.id);
      return db.select().from(timeEntries).where(
        and(eq(timeEntries.cardId, input.cardId), eq(timeEntries.trackedUserId, vaId), eq(timeEntries.founderId, worker.founderId ?? ctx.user.id), isNotNull(timeEntries.endTime), eq(timeEntries.isVoided, false))
      ).orderBy(desc(timeEntries.startTime)).limit(input.limit ?? 20);
    }),

  getDailySummary: operatorAccountProcedure
    .input(z.object({ date: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable; timer history cannot be verified" });
      const vaId = Number(ctx.user.id);
      const worker = await resolveWorkerOperatorContext(ctx.user);
      await requireTimerHistory(db, worker.founderId ?? ctx.user.id);
      const window = dateWindowInTimeZone(input.date, worker.timezone);
      const endUTC = new Date(window.endExclusive.getTime() - 1);

      const rows = await db.select().from(timeEntries).where(
        and(
          eq(timeEntries.trackedUserId, vaId),
          eq(timeEntries.founderId, worker.founderId ?? ctx.user.id),
          isNotNull(timeEntries.endTime), eq(timeEntries.isVoided, false),
          gte(timeEntries.startTime, window.start),
          lte(timeEntries.startTime, endUTC)
        )
      ).orderBy(desc(timeEntries.startTime));

      const map = new Map<string, any>();
      for (const row of rows) {
        const cardId = row.cardId || row.taskId;
        const existing = map.get(cardId);
        const secs = recordedSeconds(row);
        if (existing) {
          existing.totalSeconds += secs;
          existing.entryCount++;
        } else {
          map.set(cardId, {
            cardId,
            cardName: row.cardName || "Unknown Card",
            cardUrl: row.cardUrl || "#",
            boardName: row.boardName || "Unknown Board",
            listName: row.listName || "Unknown List",
            totalSeconds: secs,
            entryCount: 1,
          });
        }
      }
      return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds);
    }),

  getWeeklyTotal: operatorAccountProcedure
    .input(z.object({ startDate: z.string(), endDate: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable; timer history cannot be verified" });
      const vaId = Number(ctx.user.id);
      const worker = await resolveWorkerOperatorContext(ctx.user);
      await requireTimerHistory(db, worker.founderId ?? ctx.user.id);
      const startUTC = dateWindowInTimeZone(input.startDate, worker.timezone).start;
      const endUTC = new Date(dateWindowInTimeZone(input.endDate, worker.timezone).endExclusive.getTime() - 1);

      const rows = await db.select().from(timeEntries).where(
        and(
          eq(timeEntries.trackedUserId, vaId),
          eq(timeEntries.founderId, worker.founderId ?? ctx.user.id),
          isNotNull(timeEntries.endTime), eq(timeEntries.isVoided, false),
          gte(timeEntries.startTime, startUTC),
          lte(timeEntries.startTime, endUTC)
        )
      );

      const totalSeconds = rows.reduce((sum, r) => sum + recordedSeconds(r), 0);
      return {
        ...await timeCompleteness(db, worker.founderId ?? ctx.user.id),
        totalSeconds,
        totalMinutes: Math.floor(totalSeconds / 60),
        totalHours: Math.round((totalSeconds / 3600) * 10) / 10,
      };
    }),

  delete: operatorAccountProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);
      await timerRoute(() => correctCanonicalTimer(db, ctx.user, input.id, { void: true }));
      return { success: true };
    }),

  updateEntry: operatorAccountProcedure
    .input(z.object({
      id: z.number(),
      durationSeconds: z.number().int().min(0).max(86400),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);

      const entry = await timerRoute(() => correctCanonicalTimer(db, ctx.user, input.id, { durationSeconds: input.durationSeconds }));
      return { success: true, id: entry.id, durationSeconds: entry.durationSeconds, stoppedAt: entry.endTime };
    }),

  getEntriesForCard: operatorAccountProcedure
    .input(z.object({ cardId: z.string(), date: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable; timer history cannot be verified" });
      const vaId = Number(ctx.user.id);
      const worker = await resolveWorkerOperatorContext(ctx.user);
      await requireTimerHistory(db, worker.founderId ?? ctx.user.id);
      const window = dateWindowInTimeZone(input.date, worker.timezone);
      const endUTC = new Date(window.endExclusive.getTime() - 1);

      const rows = await db.select().from(timeEntries).where(
        and(
          eq(timeEntries.cardId, input.cardId),
          eq(timeEntries.trackedUserId, vaId),
          eq(timeEntries.founderId, worker.founderId ?? ctx.user.id),
          isNotNull(timeEntries.endTime), eq(timeEntries.isVoided, false),
          gte(timeEntries.startTime, window.start),
          lte(timeEntries.startTime, endUTC)
        )
      ).orderBy(desc(timeEntries.startTime));
      return rows.map(entry => ({
        ...entry,
        cardId: entry.cardId ?? entry.taskId,
        cardName: entry.cardName ?? "Unknown Card",
        cardUrl: entry.cardUrl ?? "#",
        startedAt: entry.startTime,
        stoppedAt: entry.endTime,
      }));
    }),

  getWeeklyBreakdown: operatorAccountProcedure
    .input(z.object({ startDate: z.string(), endDate: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable; timer history cannot be verified" });
      const vaId = Number(ctx.user.id);
      const worker = await resolveWorkerOperatorContext(ctx.user);
      await requireTimerHistory(db, worker.founderId ?? ctx.user.id);

      const days: any[] = [];
      const start = new Date(input.startDate + "T00:00:00Z");
      for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + i);
        days.push({ date: d.toISOString().slice(0, 10), totalSeconds: 0 });
      }

      const rows = await db.select({
        startTime: timeEntries.startTime, endTime: timeEntries.endTime, isVoided: timeEntries.isVoided,
        durationSeconds: timeEntries.durationSeconds, durationMinutes: timeEntries.durationMinutes,
      }).from(timeEntries).where(
        and(
          eq(timeEntries.trackedUserId, vaId),
          eq(timeEntries.founderId, worker.founderId ?? ctx.user.id),
          isNotNull(timeEntries.endTime), eq(timeEntries.isVoided, false),
          gte(timeEntries.startTime, dateWindowInTimeZone(input.startDate, worker.timezone).start),
          lte(timeEntries.startTime, new Date(dateWindowInTimeZone(input.endDate, worker.timezone).endExclusive.getTime() - 1))
        )
      );

      for (const row of rows) {
        const localDate = dateKeyInTimeZone(row.startTime, worker.timezone);
        const slot = days.find(d => d.date === localDate);
        if (slot) slot.totalSeconds += recordedSeconds(row);
      }
      return days;
    }),
});

// ─── Compliance Snapshots Router ────────────────────────────────────────────
type ComplianceSnapshot = typeof dailyComplianceSnapshots.$inferSelect;

function parseComplianceCards(value: string | null): Array<{ id: string; name: string; url: string }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((card): card is { id: string; name: string; url: string } =>
      typeof card === "object" &&
      card !== null &&
      typeof card.id === "string" &&
      typeof card.name === "string" &&
      typeof card.url === "string"
    );
  } catch {
    return [];
  }
}

function compliancePercentage(row: ComplianceSnapshot): number {
  return calculateCompliancePercentage(row);
}

function normalizeComplianceSnapshot(row: ComplianceSnapshot) {
  return {
    ...row,
    estimatedPenalty: Number(row.estimatedPenalty),
    onHoldMissedCards: parseComplianceCards(row.onHoldMissedCards),
    doingMissedCards: parseComplianceCards(row.doingMissedCards),
    compliancePct: compliancePercentage(row),
  };
}

export const complianceRouter = router({
  getHistory: operatorAccountProcedure
    .input(z.object({ limit: z.number().optional(), vaId: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      const isWorker = ctx.user.role === "worker";
      const vaId = isWorker ? Number(ctx.user.id) : input.vaId;
      if (!vaId) return [];

      const rows = await db.select().from(dailyComplianceSnapshots)
        .where(eq(dailyComplianceSnapshots.vaId, vaId))
        .orderBy(desc(dailyComplianceSnapshots.snapshotDate))
        .limit(input.limit ?? 30);
      return rows.map(normalizeComplianceSnapshot);
    }),

  getRollingAvg: operatorAccountProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(7) }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { avg: 100, days: 0 };
      const vaId = Number(ctx.user.id);
      const rows = await db.select().from(dailyComplianceSnapshots)
        .where(eq(dailyComplianceSnapshots.vaId, vaId))
        .orderBy(desc(dailyComplianceSnapshots.snapshotDate))
        .limit(input.days);
      const percentages = rows.map(compliancePercentage);
      return {
        avg: percentages.length === 0
          ? 100
          : Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length),
        days: percentages.length,
      };
    }),

  getWeekAvg: operatorAccountProcedure
    .input(z.object({ weekStart: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { avg: null, days: 0 };
      const vaId = Number(ctx.user.id);
      const start = parseDateKey(input.weekStart);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      const rows = await db.select().from(dailyComplianceSnapshots).where(and(
        eq(dailyComplianceSnapshots.vaId, vaId),
        gte(dailyComplianceSnapshots.snapshotDate, start),
        lte(dailyComplianceSnapshots.snapshotDate, end),
      ));
      const percentages = rows.map(compliancePercentage);
      return {
        avg: percentages.length === 0
          ? null
          : Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length),
        days: percentages.length,
      };
    }),

  recordNow: operatorAccountProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
    }
    const vaId = Number(ctx.user.id);
    const profiles = await db.select().from(vaProfiles)
      .where(eq(vaProfiles.userId, vaId))
      .limit(1);
    const profile = profiles[0];
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Worker profile not found" });
    }
    const snapshot = await collectComplianceSnapshot(profile, "manual");
    return normalizeComplianceSnapshot(snapshot);
  }),
});

// ─── Email Inbox Router ──────────────────────────────────────────────────────
function isDuplicateEmailMessageError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ER_DUP_ENTRY";
}

function emailTaskOwnershipConflict() {
  return new TRPCError({
    code: "CONFLICT",
    message: "One or more email tasks could not be saved. Refresh and try again.",
  });
}

export const emailInboxRouter = router({
  getAll: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const vaId = Number(ctx.user.id);
    return db.select().from(emailTasks).where(eq(emailTasks.vaId, vaId)).orderBy(desc(emailTasks.receivedAt));
  }),

  getPending: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const vaId = Number(ctx.user.id);
    return db.select().from(emailTasks).where(
      and(eq(emailTasks.vaId, vaId), eq(emailTasks.status, "pending"))
    ).orderBy(desc(emailTasks.receivedAt));
  }),

  getPendingCount: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { count: 0 };
    const vaId = Number(ctx.user.id);
    const results = await db.select({ count: sql<number>`count(*)` }).from(emailTasks).where(
      and(eq(emailTasks.vaId, vaId), eq(emailTasks.status, "pending"))
    );
    return { count: Number(results[0]?.count || 0) };
  }),

  updateStatus: operatorAccountProcedure
    .input(z.object({
      id: z.number().int(),
      status: z.enum(["pending", "processed", "archived"]),
      trelloCardId: z.string().optional(),
      trelloCardName: z.string().optional(),
      trelloCardUrl: z.string().optional(),
      suggestedNextAction: z.string().optional(),
      llmSummary: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);
      const { id, status, ...extra } = input;
      await db.update(emailTasks).set({
        status,
        ...(status === "processed" && { processedAt: new Date() }),
        ...(status === "archived" && { archivedAt: new Date() }),
        ...extra,
      }).where(and(eq(emailTasks.id, id), eq(emailTasks.vaId, vaId)));
      return { success: true };
    }),

  archiveAll: operatorAccountProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
    const vaId = Number(ctx.user.id);
    const result = await db.update(emailTasks)
      .set({ status: "archived", archivedAt: new Date() })
      .where(and(eq(emailTasks.vaId, vaId), eq(emailTasks.status, "pending")))
      .returning({ id: emailTasks.id });
    return { success: true, archived: result.length };
  }),

  upsertBatch: operatorAccountProcedure
    .input(z.array(z.object({
      gmailMessageId: z.string(),
      gmailThreadId: z.string(),
      subject: z.string().default("(no subject)"),
      fromAddress: z.string().default(""),
      fromName: z.string().default(""),
      snippet: z.string().optional(),
      receivedAt: z.date(),
      category: z.enum(["financial", "non_financial"]).default("non_financial"),
      status: z.enum(["pending", "processed", "archived"]).default("pending"),
      deadlineAt: z.date().optional(),
      trelloCardId: z.string().optional(),
      trelloCardName: z.string().optional(),
      trelloCardUrl: z.string().optional(),
      suggestedNextAction: z.string().optional(),
      llmSummary: z.string().optional(),
    })))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);
      return db.transaction(async tx => {
        let upserted = 0;
        for (const task of input) {
          const findExisting = () => tx.select({ id: emailTasks.id, vaId: emailTasks.vaId })
            .from(emailTasks)
            .where(eq(emailTasks.gmailMessageId, task.gmailMessageId))
            .limit(1)
            .for("update");
          let [existing] = await findExisting();

          if (existing && existing.vaId !== vaId) throw emailTaskOwnershipConflict();

          if (!existing) {
            const inserted = await tx.insert(emailTasks).values({ vaId, ...task })
              .onConflictDoNothing({ target: emailTasks.gmailMessageId }).returning({ id: emailTasks.id });
            if (inserted.length) { upserted++; continue; }
            [existing] = await findExisting();
            if (!existing) throw new TRPCError({ code: "CONFLICT", message: "Email task reservation changed; reload before retrying" });
            if (existing.vaId !== vaId) throw emailTaskOwnershipConflict();
          }

          await tx.update(emailTasks).set(task).where(and(
            eq(emailTasks.id, existing.id),
            eq(emailTasks.vaId, vaId),
          ));
          upserted++;
        }
        return { success: true, upserted };
      });
    }),
});

// ─── Card Snoozes Router ─────────────────────────────────────────────────────
export const cardSnoozeRouter = router({
  snooze: operatorAccountProcedure
    .input(z.object({
      cardId: z.string(),
      cardName: z.string(),
      cardUrl: z.string(),
      snoozedUntil: z.date(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);
      return db.transaction(async tx => {
        // Serialize a worker's snooze updates because this legacy table has no
        // unique key for (vaId, cardId) to make an upsert atomic.
        const [account] = await tx.select({ id: users.id }).from(users)
          .where(eq(users.id, vaId)).for("update");
        if (!account) throw new TRPCError({ code: "UNAUTHORIZED", message: "Account no longer exists" });

        const existing = await tx.select({ id: cardSnoozes.id }).from(cardSnoozes)
          .where(and(eq(cardSnoozes.vaId, vaId), eq(cardSnoozes.cardId, input.cardId)))
          .orderBy(desc(cardSnoozes.updatedAt), desc(cardSnoozes.id))
          .for("update");
        const [current, ...duplicates] = existing;

        if (current) {
          await tx.update(cardSnoozes).set({ snoozedUntil: input.snoozedUntil, isActive: true })
            .where(and(eq(cardSnoozes.id, current.id), eq(cardSnoozes.vaId, vaId)));
          for (const duplicate of duplicates) {
            await tx.update(cardSnoozes).set({ isActive: false })
              .where(and(eq(cardSnoozes.id, duplicate.id), eq(cardSnoozes.vaId, vaId)));
          }
        } else {
          await tx.insert(cardSnoozes).values({
            vaId,
            cardId: input.cardId,
            cardName: input.cardName,
            cardUrl: input.cardUrl,
            snoozedUntil: input.snoozedUntil,
            isActive: true,
          });
        }
        return { success: true };
      });
    }),

  cancel: operatorAccountProcedure
    .input(z.object({ cardId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      const vaId = Number(ctx.user.id);
      await db.update(cardSnoozes)
        .set({ isActive: false })
        .where(and(eq(cardSnoozes.cardId, input.cardId), eq(cardSnoozes.vaId, vaId)));
      return { success: true };
    }),

  getActive: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const vaId = Number(ctx.user.id);
    return db.select().from(cardSnoozes).where(
      and(eq(cardSnoozes.vaId, vaId), eq(cardSnoozes.isActive, true))
    );
  }),

  getForCard: operatorAccountProcedure
    .input(z.object({ cardId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const vaId = Number(ctx.user.id);
      const results = await db.select().from(cardSnoozes).where(
        and(eq(cardSnoozes.cardId, input.cardId), eq(cardSnoozes.vaId, vaId), eq(cardSnoozes.isActive, true))
      ).limit(1);
      return results[0] ?? null;
    }),

  getSnoozedIds: operatorAccountProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { cardIds: [] };
    const vaId = Number(ctx.user.id);
    const results = await db.select({ cardId: cardSnoozes.cardId }).from(cardSnoozes).where(
      and(eq(cardSnoozes.vaId, vaId), eq(cardSnoozes.isActive, true))
    );
    return { cardIds: results.map(r => r.cardId) };
  }),
});
