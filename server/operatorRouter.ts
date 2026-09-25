import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  aptlssAssessments,
  aptlssPlans,
  aptlssSteps,
  cardStates,
  communicationEvidence,
  emailTasks,
  founderDecisionDeadlines,
  priorityScores,
  timeEntries,
  trelloCachedCards,
  workspaceEvidenceItems,
  workspaceEvidenceLinks,
} from "../drizzle/schema";
import { getActiveWaitingReason, getActiveWaitingReasons, getWaitingReasonHistory, recordAptlssWaitingReason, resolveAptlssWaitingReason } from "./aptlssWaitingReasonDb";
import { selectWorkQueueNextAction } from "./aptlssWorkQueue";
import {
  ensureBrowserTabCollectorToken,
  getBrowserTabEvidenceHistory,
  getBrowserTabPolicy,
  getBrowserTabStatus,
  setBrowserTabPolicy,
} from "./browserTabHygiene";
import { getDb } from "./db";
import { DecisionOutcomeError, getDecisionHistory, recordDecisionOutcome } from "./decisionOutcomesDb";
import { FounderDecisionDeadlineError, deferFounderDecisionDeadline, getFounderDecisionInbox, setFounderDecisionDeadline } from "./founderDecisionInbox";
import { generateOperatorDailyPlan, getOperatorDailyPlan, OperatorDailyPlanScopeError, updateOperatorDailyPlan, type OperatorDailyPlanPayload } from "./operatorDailyPlan";
import {
  clearGoogleRefreshToken,
  getGoogleEvidenceStatus,
  syncWorkerGoogleEvidence,
  updateGoogleEvidenceSettings,
} from "./googleEvidence";
import {
  buildOperatorEvidenceSummary,
  type OperatorAssessmentEvidence,
  type OperatorEvidenceSourceKey,
  type OperatorIntelligenceSnapshot,
} from "./operatorEvidence";
import { protectedProcedure, router } from "./_core/trpc";
import { indexWorkQueueSteps } from "./operatorWorkQueueIndex";
import { resolveWorkerOperatorContext } from "./workerOperatorContext";
import { bindWaitingReasonToOwnedCard, interpretWaitingReasonForWorker } from "./workerWaitingReason";
import { canRecordWaitingReasonForCard } from "./timerAccess";
import { getManagerStatus, runManager, submitManagerUpdate, updateManagerPolicy } from "./aptlssManagerService";
import { closeManagerTrial, getManagerReviewInbox, managerCorrectionRevokeInputSchema, managerPlanVersion, managerReviewInboxInputSchema, managerReviewInputSchema, managerTrialInputSchema, recordManagerReview, restartManagerTrial, restoreManagerPlan, revokeManagerCorrection, setManagerMode } from "./aptlssManagerReviewService";
import { AptlssEvidenceGraphError, createEvidenceConflict, getCardEvidence, getOpenVerificationFollowups, recordWorkerEvidenceAssertion, resolveVerificationFollowup } from "./aptlssEvidenceGraphDb";
import { assertManagerPilotWorker } from "./aptlssManagerPilot";
import { toWorkerManagerSnapshot, toWorkerManagerStatus } from "./workerManagerResponse";

const managerReviewer = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Founder/admin access is required" });
  return next({ ctx });
});

const operatorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "worker") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Operator access requires a worker role" });
  }
  return next({ ctx });
});

const workerMutation = operatorProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "worker") {
    throw new TRPCError({ code: "FORBIDDEN", message: "This action must be completed by the worker" });
  }
  return next({ ctx });
});

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const dailyPlanPayloadSchema = z.object({
  version: z.literal(2),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string(),
  blocks: z.array(z.object({
    id: z.string(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    cardId: z.string().nullable(),
    cardName: z.string(),
    cardUrl: z.string().nullable(),
    boardName: z.string(),
    listName: z.string(),
    action: z.string(),
    stepIds: z.array(z.number().int()),
    priority: z.string(),
    score: z.number(),
    state: z.string(),
    status: z.enum(["planned", "active", "done", "skipped"]),
    notes: z.string(),
    flags: z.array(z.string()),
  })),
  robertItems: z.array(z.object({
    stepId: z.number().int(),
    cardId: z.string(),
    cardName: z.string(),
    decision: z.string(),
  })),
  unscheduledCards: z.array(z.object({
    cardId: z.string(),
    cardName: z.string(),
    reason: z.string(),
  })),
  planHealth: z.object({
    confidence: z.number(),
    scheduledMinutes: z.number(),
    availableMinutes: z.number(),
    overlaps: z.number(),
    gaps: z.number(),
  }),
  constraints: z.object({
    startTime: z.string(),
    endTime: z.string(),
    breaks: z.array(z.object({
      name: z.string(),
      startTime: z.string(),
      durationMinutes: z.number(),
    })),
  }),
  auditTrail: z.array(z.object({
    at: z.string(),
    action: z.string(),
    detail: z.string(),
  })),
});

export const operatorRouter = router({
  getManagerReviewInbox: managerReviewer.input(managerReviewInboxInputSchema.optional())
    .query(({ ctx, input }) => getManagerReviewInbox(ctx.user.id, input?.vaId, input?.page)),
  recordManagerReview: managerReviewer.input(managerReviewInputSchema)
    .mutation(({ ctx, input }) => recordManagerReview(ctx.user.id, input)),
  closeManagerTrial: managerReviewer.input(managerTrialInputSchema)
    .mutation(({ ctx, input }) => closeManagerTrial(ctx.user.id, input)),
  restartManagerTrial: managerReviewer.input(managerTrialInputSchema)
    .mutation(({ ctx, input }) => restartManagerTrial(ctx.user.id, input)),
  revokeManagerCorrection: managerReviewer.input(managerCorrectionRevokeInputSchema)
    .mutation(({ ctx, input }) => revokeManagerCorrection(ctx.user.id, input)),
  setManagerMode: managerReviewer.input(z.object({ vaId: z.number().int().positive(), mode: z.enum(["shadow", "active"]) }))
    .mutation(({ ctx, input }) => setManagerMode(ctx.user.id, input.vaId, input.mode)),
  restoreManagerPlan: managerReviewer.input(z.object({ vaId: z.number().int().positive(), runId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => restoreManagerPlan(ctx.user.id, input.vaId, input.runId)),
  runManagerForReview: managerReviewer.input(z.object({ vaId: z.number().int().positive() }))
    .mutation(({ input }) => runManager(input.vaId, "founder_review")),
  getManagerStatus: operatorProcedure.query(async ({ ctx }) => {
    return toWorkerManagerStatus(await getManagerStatus(Number(ctx.user.id)));
  }),
  runManager: workerMutation.input(z.object({ trigger: z.enum(["manual", "worker_update"]).optional() }).optional())
    .mutation(async ({ ctx, input }) => ({ applied: (await runManager(Number(ctx.user.id), input?.trigger ?? "manual")).applied })),
  updateManagerPolicy: workerMutation.input(z.object({ enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(60) }).strict())
    .mutation(({ ctx, input }) => updateManagerPolicy(Number(ctx.user.id), input)),
  submitManagerUpdate: workerMutation.input(z.object({
    cardId: z.string().min(1), detail: z.string().trim().min(3).max(8000), interventionId: z.string().optional(),
    outcome: z.enum(["Update", "Action needed", "No action needed", "Cannot access source", "Need Robert's decision"]).optional(),
    deadlineDate: z.string().optional(), sourceEvidenceId: z.string().optional(), sourceDescription: z.string().trim().max(512).optional(),
  }).strict())
    .mutation(async ({ ctx, input }) => ({ applied: (await submitManagerUpdate(Number(ctx.user.id), input.cardId, input.detail, input.interventionId, input)).applied })),
  getCardEvidence: operatorProcedure.input(z.object({ cardId: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) }))
    .query(({ ctx, input }) => getCardEvidence(ctx.user.id, input.cardId, input.limit)),
  getVerificationFollowups: operatorProcedure.input(z.object({ cardId: z.string().min(1).optional() }).optional())
    .query(({ ctx, input }) => getOpenVerificationFollowups(ctx.user.id, input?.cardId)),
  recordEvidenceAssertion: workerMutation.input(z.object({ cardId: z.string().min(1).optional(), title: z.string().trim().min(3).max(512), detail: z.string().trim().min(3).max(8000) }))
    .mutation(async ({ ctx, input }) => {
      assertManagerPilotWorker(ctx.user.id);
      try {
        return await recordWorkerEvidenceAssertion({ ...input, vaId: ctx.user.id, recordedBy: ctx.user.openId });
      } catch (error) {
        if (error instanceof AptlssEvidenceGraphError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        throw error;
      }
    }),
  createEvidenceConflict: workerMutation.input(z.object({ sourceEvidenceId: z.number().int().positive(), assertedEvidenceId: z.number().int().positive(), cardId: z.string().min(1).optional(), question: z.string().trim().min(3).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createEvidenceConflict({ ...input, vaId: ctx.user.id, createdBy: ctx.user.openId });
      } catch (error) {
        if (error instanceof AptlssEvidenceGraphError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        throw error;
      }
    }),
  resolveVerificationFollowup: workerMutation.input(z.object({ followupId: z.number().int().positive(), resolution: z.string().trim().min(3).max(4000), sourceEvidenceId: z.number().int().positive().optional(), sourceQuote: z.string().trim().min(3).max(4000).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await resolveVerificationFollowup({ ...input, vaId: ctx.user.id, resolvedBy: ctx.user.openId });
        await runManager(ctx.user.id, "worker_update").catch(() => null);
        return result;
      } catch (error) {
        if (error instanceof AptlssEvidenceGraphError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        throw error;
      }
    }),
  getContext: operatorProcedure.query(async ({ ctx }) => resolveWorkerOperatorContext(ctx.user)),

  getWorkQueueContext: operatorProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Database unavailable" });
    const vaId = Number(ctx.user.id);
    const [plans, waitingReasons] = await Promise.all([
      db.select().from(aptlssPlans).where(eq(aptlssPlans.vaId, vaId)),
      getActiveWaitingReasons(vaId),
    ]);
    const cardIds = plans.map((plan) => plan.cardId);
    const [states, scores, steps, assessments, linkedEvidence, linkedCommunication, linkedEmails, completedTimeEntries, cachedCards, founderDeadlines] = cardIds.length
      ? await Promise.all([
          db.select().from(cardStates).where(and(eq(cardStates.vaId, vaId), inArray(cardStates.cardId, cardIds))),
          db.select().from(priorityScores).where(and(eq(priorityScores.vaId, vaId), inArray(priorityScores.cardId, cardIds))),
          db.select().from(aptlssSteps).where(and(eq(aptlssSteps.vaId, vaId), inArray(aptlssSteps.cardId, cardIds))),
          db.select().from(aptlssAssessments)
            .where(inArray(aptlssAssessments.cardId, cardIds))
            .orderBy(desc(aptlssAssessments.assessedAt)),
          db.select({
            cardId: workspaceEvidenceLinks.cardId,
            source: workspaceEvidenceItems.source,
          }).from(workspaceEvidenceLinks)
            .innerJoin(workspaceEvidenceItems, eq(workspaceEvidenceItems.id, workspaceEvidenceLinks.evidenceId))
            .where(and(
              eq(workspaceEvidenceItems.vaId, vaId),
              inArray(workspaceEvidenceLinks.cardId, cardIds),
              eq(workspaceEvidenceItems.active, true),
            )),
          db.select({ cardId: communicationEvidence.linkedCardId })
            .from(communicationEvidence)
            .where(and(
              eq(communicationEvidence.vaId, vaId),
              inArray(communicationEvidence.linkedCardId, cardIds),
            )),
          db.select({ cardId: emailTasks.trelloCardId })
            .from(emailTasks)
            .where(and(
              eq(emailTasks.vaId, vaId),
              inArray(emailTasks.trelloCardId, cardIds),
            )),
          db.select({ cardId: timeEntries.cardId })
            .from(timeEntries)
            .where(and(
              eq(timeEntries.vaId, vaId),
              eq(timeEntries.isVoided, false),
              isNotNull(timeEntries.endTime),
              inArray(timeEntries.cardId, cardIds),
            )),
          db.select({ cardId: trelloCachedCards.cardId, cardData: trelloCachedCards.cardData, cachedAt: trelloCachedCards.cachedAt, expiresAt: trelloCachedCards.expiresAt })
            .from(trelloCachedCards)
            .where(and(eq(trelloCachedCards.userId, vaId), inArray(trelloCachedCards.cardId, cardIds)))
            .orderBy(desc(trelloCachedCards.cachedAt))
            .limit(1001),
          db.select().from(founderDecisionDeadlines)
            .where(eq(founderDecisionDeadlines.vaId, vaId))
            .orderBy(desc(founderDecisionDeadlines.id)),
        ])
      : [[], [], [], [], [], [], [], [], [], []];
    const latestAssessment = new Map<string, typeof assessments[number]>();
    assessments.forEach((assessment) => {
      if (!latestAssessment.has(assessment.cardId)) latestAssessment.set(assessment.cardId, assessment);
    });
    const stateMap = new Map(states.map((item) => [item.cardId, item]));
    const cachedCardMap = new Map<string, typeof cachedCards[number]>();
    cachedCards.forEach((item) => {
      if (!cachedCardMap.has(item.cardId)) cachedCardMap.set(item.cardId, item);
    });
    const scoreMap = new Map(scores.map((item) => [item.cardId, item]));
    const founderDeadlineMap = new Map<number, typeof founderDeadlines[number]>();
    founderDeadlines.forEach((item) => {
      if (!founderDeadlineMap.has(item.stepId)) founderDeadlineMap.set(item.stepId, item);
    });
    const stepsByCardId = indexWorkQueueSteps(steps);
    const waitingMap = new Map(waitingReasons.map((item) => [item.cardId, item]));
    const sourceCounts = new Map<string, Partial<Record<Exclude<OperatorEvidenceSourceKey, "time">, number>>>();
    const completedTimeSamples = new Map<string, number>();
    const addSource = (
      cardId: string | null,
      source: Exclude<OperatorEvidenceSourceKey, "time">,
    ) => {
      if (!cardId) return;
      const counts = sourceCounts.get(cardId) ?? {};
      counts[source] = (counts[source] ?? 0) + 1;
      sourceCounts.set(cardId, counts);
    };
    linkedEvidence.forEach((row) => addSource(row.cardId, row.source));
    linkedCommunication.forEach((row) => addSource(row.cardId, "communication"));
    linkedEmails.forEach((row) => addSource(row.cardId, "gmail"));
    completedTimeEntries.forEach((row) => {
      if (!row.cardId) return;
      completedTimeSamples.set(row.cardId, (completedTimeSamples.get(row.cardId) ?? 0) + 1);
    });

    return {
      cards: plans.map((plan) => {
        const planValue = parseJson<Record<string, unknown>>(plan.planJson, {});
        const cachedCardRow = cachedCardMap.get(plan.cardId);
        const cachedCard = parseJson<Record<string, unknown>>(cachedCardRow?.cardData, {});
        const state = stateMap.get(plan.cardId);
        const score = scoreMap.get(plan.cardId);
        const assessment = latestAssessment.get(plan.cardId);
        const cardSteps = stepsByCardId.get(plan.cardId) ?? [];
        const assessmentEvidence = assessment
          ? parseJson<OperatorAssessmentEvidence[]>(assessment.evidenceJson, [])
          : [];
        const intelligence = assessment
          ? parseJson<OperatorIntelligenceSnapshot>(assessment.intelligenceJson, {})
          : {};
        const rawUncertainties = assessment
          ? parseJson<string[]>(assessment.uncertaintiesJson, [])
          : [];
        const openRobertStep = cardSteps.find((step) => step.requiresRobert && step.status !== "complete") ?? null;
        const recommendations = assessment
          ? parseJson<string[]>(assessment.recommendationsJson, [])
          : Array.isArray(planValue.recommendations) ? planValue.recommendations.filter((item): item is string => typeof item === "string") : [];
        const nextBestAction = waitingMap.get(plan.cardId)?.nextAction ?? selectWorkQueueNextAction({
          planAction: typeof planValue.nextBestAction === "string" ? planValue.nextBestAction : typeof planValue.action === "string" ? planValue.action : null,
          primaryState: assessment?.primaryState ?? state?.state ?? null,
          actionability: assessment?.actionability ?? null,
          recommendations,
          openRobertStep,
        });
        const evidenceSummary = buildOperatorEvidenceSummary({
          rawUncertainties,
          assessmentEvidence,
          intelligence,
          linkedSourceCounts: sourceCounts.get(plan.cardId) ?? {},
          completedTimeSamples: completedTimeSamples.get(plan.cardId) ?? 0,
        });
        const waitingReason = waitingMap.get(plan.cardId);
        return {
          cardId: plan.cardId,
          cardName: plan.cardName,
          cardUrl: plan.cardUrl,
          trelloCache: cachedCardRow ? {
            cachedAt: cachedCardRow.cachedAt.toISOString(),
            expiresAt: cachedCardRow.expiresAt.toISOString(),
          } : null,
          boardName: plan.boardName,
          listName: plan.listName,
          dueAt: typeof cachedCard?.due === "string" ? cachedCard.due : typeof planValue.due === "string" ? planValue.due : null,
          overdue: state?.isOverdue ?? false,
          nextBestAction,
          primaryState: assessment?.primaryState ?? state?.state ?? null,
          actionability: assessment?.actionability ?? null,
          priorityScore: assessment?.priorityScore ?? score?.score ?? 0,
          priorityTier: assessment?.priorityTier ?? score?.tier ?? "MEDIUM",
          evidenceSummary: {
            sources: evidenceSummary.sources,
            forecast: evidenceSummary.forecast ? {
              p50Minutes: evidenceSummary.forecast.p50Minutes,
              p90Minutes: evidenceSummary.forecast.p90Minutes,
            } : null,
          },
          waitingReason: waitingReason ? {
            waitingOn: waitingReason.waitingOn,
            nextAction: waitingReason.nextAction,
            followUpAt: waitingReason.followUpAt,
          } : null,
          steps: cardSteps.map((step) => ({
            id: step.id,
            stepNumber: step.stepNumber,
            title: step.title,
            status: step.status,
            category: step.category,
            requiresRobert: step.requiresRobert,
            decisionDueAt: founderDeadlineMap.get(step.id)?.dueAt?.toISOString() ?? null,
            decisionDeferred: founderDeadlineMap.get(step.id)?.source.startsWith("Deferred:") ?? false,
            completionCriteria: step.completionCriteria,
            riskIfSkipped: step.riskIfSkipped,
          })),
        };
      }),
    };
  }),

  interpretWaitingReason: workerMutation
    .input(z.object({
      reason: z.string().trim().min(3).max(4_000),
      cardId: z.string().optional(),
      cardName: z.string().optional(),
      boardName: z.string().optional(),
      listName: z.string().optional(),
      due: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const worker = await resolveWorkerOperatorContext(ctx.user);
      return interpretWaitingReasonForWorker(input.reason, input, {
        workerName: worker.displayName,
        founderName: worker.founderName,
        timeZone: worker.timezone,
      });
    }),

  recordWaitingReason: workerMutation
    .input(z.object({
      reason: z.string().trim().min(3).max(4_000),
      cardId: z.string().min(1),
      cardName: z.string().min(1),
      cardUrl: z.string(),
      boardName: z.string(),
      listName: z.string(),
      due: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Database unavailable" });
      const [plannedCard] = await db.select({
        cardId: aptlssPlans.cardId,
        cardName: aptlssPlans.cardName,
        cardUrl: aptlssPlans.cardUrl,
        boardName: aptlssPlans.boardName,
        listName: aptlssPlans.listName,
      }).from(aptlssPlans)
        .where(and(eq(aptlssPlans.vaId, ctx.user.id), eq(aptlssPlans.cardId, input.cardId)))
        .limit(1);
      if (!canRecordWaitingReasonForCard(Boolean(plannedCard))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only record a waiting reason for a card in your work queue" });
      }
      const ownedCardInput = bindWaitingReasonToOwnedCard(input, plannedCard);
      const worker = await resolveWorkerOperatorContext(ctx.user);
      const interpretation = interpretWaitingReasonForWorker(input.reason, ownedCardInput, {
        workerName: worker.displayName,
        founderName: worker.founderName,
        timeZone: worker.timezone,
      });
      return recordAptlssWaitingReason({
        cardId: ownedCardInput.cardId,
        cardName: ownedCardInput.cardName,
        cardUrl: ownedCardInput.cardUrl,
        boardName: ownedCardInput.boardName,
        listName: ownedCardInput.listName,
        vaId: worker.userId,
        interpretation,
        recordedBy: String(ctx.user.openId),
      });
    }),

  getWaitingReasons: operatorProcedure.query(({ ctx }) => getActiveWaitingReasons(ctx.user.id)),
  getWaitingReason: operatorProcedure
    .input(z.object({ cardId: z.string() }))
    .query(({ input, ctx }) => getActiveWaitingReason(ctx.user.id, input.cardId)),
  getWaitingReasonHistory: operatorProcedure
    .input(z.object({ cardId: z.string(), limit: z.number().int().min(1).max(100).default(20) }))
    .query(({ input, ctx }) => getWaitingReasonHistory(ctx.user.id, input.cardId, input.limit)),
  resolveWaitingReason: workerMutation
    .input(z.object({ cardId: z.string() }))
    .mutation(({ input, ctx }) => resolveAptlssWaitingReason(ctx.user.id, input.cardId)),

  getFounderDecisionInbox: managerReviewer.query(() => getFounderDecisionInbox()),
  setFounderDecisionDeadline: managerReviewer
    .input(z.object({
      vaId: z.number().int().positive(), stepId: z.number().int().positive(),
      dueAt: z.string().datetime({ offset: true }).nullable(),
      source: z.string().trim().min(3).max(1024),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await setFounderDecisionDeadline({
          ...input,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          recordedBy: String(ctx.user.openId),
        });
      } catch (error) {
        if (error instanceof FounderDecisionDeadlineError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),
  deferFounderDecision: managerReviewer
    .input(z.object({
      vaId: z.number().int().positive(), stepId: z.number().int().positive(),
      dueAt: z.string().datetime({ offset: true }),
      reason: z.string().trim().min(3).max(1014),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await deferFounderDecisionDeadline({
          vaId: input.vaId, stepId: input.stepId, dueAt: new Date(input.dueAt),
          source: input.reason, recordedBy: String(ctx.user.openId),
        });
      } catch (error) {
        if (error instanceof FounderDecisionDeadlineError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),
  recordFounderDecisionOutcome: managerReviewer
    .input(z.object({ vaId: z.number().int().positive(), stepId: z.number().int().positive(), disposition: z.enum(["approved", "rejected"]), outcome: z.string().trim().min(3).max(5_000) }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await recordDecisionOutcome({
          ...input,
          resolvedBy: String(ctx.user.openId),
        });
      } catch (error) {
        if (error instanceof DecisionOutcomeError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    }),
  getDecisionHistory: operatorProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).optional())
    .query(({ input, ctx }) => getDecisionHistory(ctx.user.id, input?.limit ?? 30)),

  getDailyPlan: operatorProcedure
    .input(z.object({ dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const worker = await resolveWorkerOperatorContext(ctx.user);
      const plan = await getOperatorDailyPlan(worker.userId, input?.dateKey, worker);
      return plan ? { ...plan, planVersion: managerPlanVersion(plan.scheduleJson) } : null;
    }),
  generateDailyPlan: workerMutation
    .input(z.object({
      dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      force: z.boolean().default(false),
    }).optional())
    .mutation(async ({ input, ctx }) => {
      const worker = await resolveWorkerOperatorContext(ctx.user);
      return generateOperatorDailyPlan(worker.userId, input?.dateKey, input?.force ?? false, worker);
    }),
  updateDailyPlan: workerMutation
    .input(dailyPlanPayloadSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await updateOperatorDailyPlan(Number(ctx.user.id), input as OperatorDailyPlanPayload);
      } catch (error) {
        if (error instanceof OperatorDailyPlanScopeError) {
          throw new TRPCError({ code: "FORBIDDEN", message: error.message });
        }
        throw error;
      }
    }),

  getBrowserTabStatus: operatorProcedure.query(({ ctx }) => getBrowserTabStatus(ctx.user.id)),
  getBrowserTabPolicy: operatorProcedure.query(({ ctx }) => getBrowserTabPolicy(ctx.user.id)),
  setBrowserTabPolicy: workerMutation
    .input(z.object({
      enabled: z.boolean().optional(),
      maxOpenTabs: z.number().int().min(0).max(50).optional(),
      warningMinutesBeforeEnd: z.number().int().min(0).max(240).optional(),
      staleAfterMinutes: z.number().int().min(2).max(120).optional(),
      includePinnedTabs: z.boolean().optional(),
    }))
    .mutation(({ input, ctx }) => setBrowserTabPolicy(ctx.user.id, input)),
  getBrowserCollectorToken: workerMutation.mutation(async ({ ctx }) => ({
    token: await ensureBrowserTabCollectorToken(ctx.user.id),
  })),
  getBrowserTabEvidenceHistory: operatorProcedure
    .input(z.object({ limit: z.number().int().min(1).max(366).default(30) }).optional())
    .query(({ input, ctx }) => getBrowserTabEvidenceHistory(ctx.user.id, input?.limit ?? 30)),

  getGoogleEvidenceStatus: operatorProcedure.query(({ ctx }) => getGoogleEvidenceStatus(ctx.user.id)),
  updateGoogleEvidenceSettings: workerMutation
    .input(z.object({
      gmail: z.object({
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(15).max(1_440).optional(),
        lookbackDays: z.number().int().min(1).max(90).optional(),
      }).optional(),
      drive: z.object({
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(15).max(1_440).optional(),
        lookbackDays: z.number().int().min(1).max(90).optional(),
        folderId: z.string().trim().max(256).nullable().optional(),
      }).optional(),
    }))
    .mutation(({ input, ctx }) => updateGoogleEvidenceSettings(ctx.user.id, input)),
  syncGoogleEvidence: workerMutation
    .input(z.object({
      gmail: z.boolean().optional(),
      drive: z.boolean().optional(),
    }).optional())
    .mutation(({ input, ctx }) => syncWorkerGoogleEvidence(ctx.user.id, input)),
  disconnectGoogleEvidence: workerMutation.mutation(async ({ ctx }) => {
    await clearGoogleRefreshToken(ctx.user.id);
    return { success: true };
  }),
});
