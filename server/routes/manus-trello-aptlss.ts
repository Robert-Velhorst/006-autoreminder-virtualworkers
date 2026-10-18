import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb, incrementPayLogD1 } from "../db";
import {
  getPendingReplyThreads,
  getAllReplyThreads,
  resolveVagueReplyFlag,
  getActiveVagueReplyFlags,
  getAllVagueReplyFlags,
  getActiveUnsignedFlags,
  getAllUnsignedFlags,
  resolveUnsignedFlag,
  upsertReplyThread,
  insertVagueReplyFlag,
  insertUnsignedFlag,
  markReplyThreadReplied,
  markReplyThreadDemerited,
} from "../replyMonitorDb";
import {
  getWorkerCards,
  getWorkerRecentActions,
  getWeeklyHours,
  getCardsNeedingDueDate,
  getCardsNeedingDailyUpdate,
  getOnHoldCards,
  getWorkerCommentedCardIdsToday,
  getRegisteredWebhooks,
  getCardsDueToday,
  getOverdueCards,
  getWorkerBoards,
  postCardComment,
  isDoingList,
} from "../services/trello-manus";
import { fetchCardContext } from "../trelloCardContext";
import { upsertAptlssPlan, getAptlssPlan, getAllAptlssPlans } from "../aptlssDb";
import {
  logAuditAction,
  getCardAuditLog,
  getRecentAuditLog,
  countRecentActions,
  pruneOldAuditLog,
  recordSyncAttempt,
  getRecentSyncLog,
  getLastSuccessfulSync,
  getSyncStats24h,
} from "../aptlssAuditDb";
import {
  computeAndSaveCardState,
  computeAndSavePriorityScore,
  writeChecklistToTrello,
  type AptlssStepInput,
} from "../aptlssEngine";
import {
  upsertAptlssSteps,
  getOpenStepsForCard,
  getAllFounderDecisionSteps,
  completeStepByCheckItemId,
  uncompleteStepByCheckItemId,
  resolveFounderStep,
  getCardStepProgress,
  getCardState,
  getAllCardStates,
  getPriorityScore,
  getAllPriorityScores,
  getNeedsRepairCards,
  getReadyForDoneCards,
} from "../aptlssStepsDb";
import { invokeLLM } from "../_core/llm";
import {
  getAllPolicies,
  upsertFollowUpDraft,
  getPolicyByKey,
  getPolicyValue,
  upsertPolicy,
  setPolicyEnabled,
  getPendingFollowUpDrafts,
  getAllFollowUpDrafts,
  markFollowUpDraftSent,
  dismissFollowUpDraft,
  getFollowUpDraftById,
  getAllWorkerPerformance,
  getLatestWeeklyAnalysis,
  getRecentWeeklyAnalyses,
  upsertWorkerPerformance,
  getAutopilotLevel,
} from "../aptlssPoliciesDb";
import { appSettings, timeEntries, vaProfiles } from "../../drizzle/schema.postgres";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { resolveWorkerOperatorContext } from "../workerOperatorContext";
import { dateKeyInTimeZone, dateWindowInTimeZone, weekDateKeys } from "../../shared/workerTime";

async function resolveTrelloWorker(ctx: { user: Parameters<typeof resolveWorkerOperatorContext>[0] }) {
  if (ctx.user.role !== "worker") {
    return { memberId: "me", timezone: "UTC" };
  }
  const worker = await resolveWorkerOperatorContext(ctx.user);
  return {
    memberId: worker.trelloMemberId || "me",
    timezone: worker.timezone,
  };
}

export const trelloRouter = router({
  weeklyHours: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
    const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
    if (!apiKey || !apiToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello API credentials not configured" });
    
    const worker = await resolveTrelloWorker(ctx);
    const base = await getWeeklyHours(apiKey, apiToken, worker.memberId);

    // Get tracked seconds from DB
    const dateKey = dateKeyInTimeZone(new Date(), worker.timezone);
    const { startDateKey, endDateKey } = weekDateKeys(dateKey);
    const weekStart = dateWindowInTimeZone(startDateKey, worker.timezone).start;
    const weekEndExclusive = dateWindowInTimeZone(endDateKey, worker.timezone).endExclusive;

    const db = await getDb();
    if (!db) return { ...base, totalHours: 0, weekStart: weekStart.toISOString(), weekEnd: weekEndExclusive.toISOString() };

    const tracked = await db.select({
      total: sql<number>`sum(durationSeconds)`
    }).from(timeEntries).where(
      and(
        eq(timeEntries.vaId, vaId),
        gte(timeEntries.startTime, weekStart),
        lte(timeEntries.startTime, new Date(weekEndExclusive.getTime() - 1))
      )
    );
    const trackedSeconds = Number(tracked[0]?.total ?? 0);
    const trackedHours = Math.round((trackedSeconds / 3600) * 10) / 10;
    return {
      ...base,
      totalHours: trackedHours,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEndExclusive.toISOString(),
    };
  }),

  recentUpdates: protectedProcedure.query(async ({ ctx }) => {
    const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
    const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
    if (!apiKey || !apiToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello API credentials not configured" });
    
    const worker = await resolveTrelloWorker(ctx);
    const [cards, actions] = await Promise.all([
      getWorkerCards(apiKey, apiToken, worker.memberId),
      getWorkerRecentActions(apiKey, apiToken, worker.memberId, 15),
    ]);

    const cardBoardMap = new Map<string, string>();
    for (const card of cards) {
      if (card.id && card.boardName) cardBoardMap.set(card.id, card.boardName);
    }

    return actions.map(action => ({
      id: action.id,
      type: action.type,
      date: action.date,
      cardName: action.data.card?.name || "Unknown Card",
      cardUrl: action.data.card?.id ? `https://trello.com/c/${action.data.card.id}` : "#",
      text: action.data.text,
      memberName: action.memberCreator.fullName,
      listBefore: action.data.listBefore?.name,
      listAfter: action.data.listAfter?.name,
      boardName: action.data.card?.id ? (cardBoardMap.get(action.data.card.id) ?? null) : null,
    }));
  }),

  actionAlerts: protectedProcedure.query(async ({ ctx }) => {
    const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
    const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
    if (!apiKey || !apiToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello API credentials not configured" });
    
    const worker = await resolveTrelloWorker(ctx);
    const trelloMemberId = worker.memberId;
    const [cards, recentActions, commentedCardIds] = await Promise.all([
      getWorkerCards(apiKey, apiToken, trelloMemberId),
      getWorkerRecentActions(apiKey, apiToken, trelloMemberId, 50),
      getWorkerCommentedCardIdsToday(apiKey, apiToken, trelloMemberId, undefined, undefined, worker.timezone),
    ]);

    const noDueDate = cards.filter(c => !c.due);
    const dueToday = await getCardsDueToday(apiKey, apiToken, trelloMemberId, worker.timezone);
    const overdue = await getOverdueCards(apiKey, apiToken, trelloMemberId);
    const onHold = cards.filter(c => c.list && c.list.name.toLowerCase().includes("hold"));
    const doingCards = cards.filter(c => c.list && isDoingList(c.list.name));

    return {
      noDueDateCards: noDueDate.map(c => ({ id: c.id, name: c.name, url: c.url, boardName: c.boardName, listName: c.list?.name })),
      dueTodayCards: dueToday.map(c => ({ id: c.id, name: c.name, url: c.url, boardName: c.boardName, listName: c.list?.name })),
      overdueCards: overdue.map(c => ({ id: c.id, name: c.name, url: c.url, boardName: c.boardName, listName: c.list?.name, due: c.due })),
      onHoldCards: onHold.map(c => ({ id: c.id, name: c.name, url: c.url, boardName: c.boardName, listName: c.list?.name, due: c.due, dateLastActivity: c.dateLastActivity })),
      doingCards: doingCards.map(c => ({
        id: c.id,
        name: c.name,
        url: c.url,
        boardName: c.boardName,
        listName: c.list?.name,
        due: c.due,
        dateLastActivity: c.dateLastActivity,
        updatedToday: commentedCardIds.has(c.id),
      })),
      recentActions: recentActions.slice(0, 10).map(a => ({
        id: a.id,
        type: a.type,
        date: a.date,
        cardName: a.data.card?.name || "Unknown Card",
        cardUrl: a.data.card?.id ? `https://trello.com/c/${a.data.card.id}` : "#",
        text: a.data.text,
        memberName: a.memberCreator.fullName,
      })),
      commentedCardIds: Array.from(commentedCardIds),
    };
  }),

  webhooks: protectedProcedure.query(async ({ ctx }) => {
    const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
    const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
    if (!apiKey || !apiToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello API credentials not configured" });
    return await getRegisteredWebhooks(apiKey, apiToken);
  }),

  postComment: protectedProcedure
    .input(z.object({ cardId: z.string(), text: z.string() }))
    .mutation(async ({ input }) => {
      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      if (!apiKey || !apiToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello API credentials not configured" });
      return await postCardComment(input.cardId, input.text, apiKey, apiToken);
    }),

  getCommentToken: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const db = await getDb();
    if (!db) return { isSet: false, preview: "" };
    const rows = await db.select().from(appSettings).where(and(eq(appSettings.vaId, vaId), eq(appSettings.key, "trello_comment_token"))).limit(1);
    const value = rows[0]?.value ?? "";
    return {
      isSet: value.length > 0,
      preview: value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : "",
    };
  }),

  setCommentToken: protectedProcedure
    .input(z.object({ token: z.string().min(1).nullable() }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      if (input.token === null) {
        await db.delete(appSettings).where(and(
          eq(appSettings.vaId, vaId),
          eq(appSettings.key, "trello_comment_token"),
        ));
        return { success: true, isSet: false };
      }
      await db.insert(appSettings)
        .values({ vaId, key: "trello_comment_token", value: input.token })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: input.token, updatedAt: new Date() },
        });
      return { success: true };
    }),
});

export const aptlssRouter = router({
  upsertAptlssPlan: protectedProcedure
    .input(z.object({ cardId: z.string(), planJson: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      if (!apiKey || !apiToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello credentials not configured" });

      const trelloCtx = await fetchCardContext(input.cardId, apiKey, apiToken);
      const plan = JSON.parse(input.planJson);

      await upsertAptlssPlan({
        vaId,
        cardId: input.cardId,
        cardName: trelloCtx.name,
        cardUrl: trelloCtx.url,
        boardName: trelloCtx.boardName,
        listName: trelloCtx.listName,
        planJson: input.planJson,
        contextSnapshot: JSON.stringify(trelloCtx),
      });

      const stepInputs = ((plan.steps ?? []) as AptlssStepInput[]).map((s, idx) => ({
        ...s,
        stepNumber: s.stepNumber ?? idx + 1,
      }));

      const autopilotLevel = await getAutopilotLevel(vaId);
      let checklistId: string | null = null;
      const stepCheckItemIds: Record<number, string> = {};

      if (autopilotLevel >= 1) {
        try {
          const result = await writeChecklistToTrello(vaId, input.cardId, trelloCtx, stepInputs);
          checklistId = result.checklistId;
          Object.assign(stepCheckItemIds, result.stepCheckItemIds);
        } catch (e) {
          console.error("[APTLSS] Failed to write checklist to Trello:", e);
        }
      }

      const dbSteps = stepInputs.map((s) => ({
        vaId,
        cardId: input.cardId,
        trelloChecklistId: checklistId ?? null,
        trelloCheckItemId: stepCheckItemIds[s.stepNumber] ?? null,
        stepNumber: s.stepNumber,
        title: s.title,
        estimatedMinutes: s.estimatedMinutes,
        status: "open" as const,
        category: s.category,
        requiresRobert: s.requiresRobert,
        blockedBy: s.blockedBy ?? null,
        dependsOnCards: s.dependsOnCards ? JSON.stringify(s.dependsOnCards) : null,
        completionCriteria: s.completionCriteria ?? null,
        riskIfSkipped: s.riskIfSkipped ?? null,
        recommendedDecision: s.recommendedDecision ?? null,
        isManual: false,
        lastSyncedAt: new Date(),
      }));
      await upsertAptlssSteps(vaId, input.cardId, dbSteps);

      const cardState = await computeAndSaveCardState(vaId, trelloCtx);
      const { score: priorityScore, tier: priorityTier } = await computeAndSavePriorityScore(vaId, trelloCtx, cardState);

      // Auto-generate follow-up draft if card is WAITING_FOR_EXTERNAL_PARTY and policy is enabled
      try {
        const followUpEnabled = await getPolicyValue(vaId, "follow_up_hours_routine", "24");
        const autopilotLevelForFollowUp = await getAutopilotLevel(vaId);
        if (followUpEnabled && cardState === "WAITING_FOR_EXTERNAL_PARTY" && autopilotLevelForFollowUp >= 3) {
          const followUpLLM = await invokeLLM({
            messages: [
              { role: "system", content: "You are the worker, a virtual assistant. Write a concise, professional follow-up message for a task that is waiting for an external party. Return JSON with fields: draftMessage (string - the full follow-up message to send), reason (string - why this follow-up is needed)." },
              { role: "user", content: `Card: ${trelloCtx.name}\nContext: ${trelloCtx.desc.slice(0, 1500)}\nPlan summary: ${plan.summary ?? ""}` },
            ],
            response_format: { type: "json_schema", json_schema: { name: "follow_up_draft", strict: true, schema: { type: "object", properties: { draftMessage: { type: "string" }, reason: { type: "string" } }, required: ["draftMessage", "reason"], additionalProperties: false } } },
          });
          const rawFollowUp = followUpLLM?.choices?.[0]?.message?.content;
          const followUpContent = typeof rawFollowUp === "string" ? rawFollowUp : null;
          if (followUpContent) {
            const followUpData = JSON.parse(followUpContent) as { draftMessage: string; reason: string };
            await upsertFollowUpDraft({
              vaId,
              cardId: input.cardId,
              cardName: trelloCtx.name,
              draftMessage: followUpData.draftMessage,
              reason: followUpData.reason,
              hoursSinceLastReply: 0,
              urgencyType: "routine",
              status: "pending",
            });
          }
        }
      } catch (e) {
        console.error("[APTLSS] Follow-up draft generation failed:", e);
      }

      const steps = await getOpenStepsForCard(vaId, input.cardId);
      const progress = await getCardStepProgress(vaId, input.cardId);

      return {
        plan,
        cached: false,
        generatedAt: new Date(),
        steps,
        progress,
        cardState,
        cardStateReason: plan.stateReason ?? null,
        priorityScore,
        priorityTier,
      };
    }),

  getCached: protectedProcedure
    .input(z.object({ cardId: z.string() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const cached = await getAptlssPlan(vaId, input.cardId);
      if (!cached) return null;
      const steps = await getOpenStepsForCard(vaId, input.cardId);
      const progress = await getCardStepProgress(vaId, input.cardId);
      const state = await getCardState(vaId, input.cardId);
      const priority = await getPriorityScore(vaId, input.cardId);
      return {
        plan: JSON.parse(cached.planJson),
        generatedAt: cached.generatedAt,
        cardName: cached.cardName,
        boardName: cached.boardName,
        listName: cached.listName,
        steps,
        progress,
        cardState: state?.state ?? null,
        cardStateReason: state?.stateReason ?? null,
        priorityScore: priority?.score ?? null,
        priorityTier: priority?.tier ?? null,
      };
    }),

  getAll: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getAllAptlssPlans(vaId);
  }),

  getFounderDecisionQueue: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getAllFounderDecisionSteps(vaId);
  }),

  resolveFounderStep: protectedProcedure
    .input(z.object({ stepId: z.number() }))
    .mutation(async ({ input }) => {
      await resolveFounderStep(input.stepId);
      return { success: true };
    }),

  getProgress: protectedProcedure
    .input(z.object({ cardId: z.string() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getCardStepProgress(vaId, input.cardId);
    }),

  getCardState: protectedProcedure
    .input(z.object({ cardId: z.string() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getCardState(vaId, input.cardId);
    }),

  getAllCardStates: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const [states, plans] = await Promise.all([getAllCardStates(vaId), getAllAptlssPlans(vaId)]);
    const planMap = new Map(plans.map(p => {
      let confidenceScore: number | null = null;
      try {
        const parsed = JSON.parse(p.planJson) as Record<string, unknown>;
        confidenceScore = typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : null;
      } catch { /* ignore */ }
      return [p.cardId, confidenceScore] as [string, number | null];
    }));
    return states.map((s: any) => ({ ...s, confidenceScore: planMap.get(s.cardId) ?? null }));
  }),

  getPriorityScore: protectedProcedure
    .input(z.object({ cardId: z.string() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getPriorityScore(vaId, input.cardId);
    }),

  getAllPriorityScores: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getAllPriorityScores(vaId);
  }),

  getDecisionQueue: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const [allPlans, allSteps, allScores] = await Promise.all([
      getAllAptlssPlans(vaId),
      getAllFounderDecisionSteps(vaId),
      getAllPriorityScores(vaId),
    ]);
    const scoreMap = new Map<string, any>(allScores.map((s: any) => [s.cardId, s]));
    const planMap = new Map<string, any>(allPlans.map((p: any) => [p.cardId, p]));
    const items = allSteps
      .filter((s: any) => s.status !== 'complete')
      .map((s: any) => {
        const plan = planMap.get(s.cardId);
        const score = scoreMap.get(s.cardId);
        let recommendedDecision: string | null = null;
        try {
          const planData = JSON.parse(plan?.planJson ?? '{}') as Record<string, unknown>;
          const steps = (planData.steps as Array<{ title?: string; recommendedDecision?: string }> | undefined) ?? [];
          const matchingStep = steps.find((st: any) => st.title === s.title);
          recommendedDecision = matchingStep?.recommendedDecision ?? null;
        } catch { /* ignore */ }
        return {
          cardId: s.cardId,
          cardName: plan?.cardName ?? s.cardId,
          cardUrl: plan?.cardUrl ?? `https://trello.com/c/${s.cardId}`,
          stepId: s.id,
          stepIndex: s.stepNumber,
          stepTitle: s.title,
          tier: score?.tier ?? 'MEDIUM',
          recommendedDecision,
        };
      })
      .sort((a: any, b: any) => {
        const tierOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, BLOCKED: 4 };
        return (tierOrder[a.tier] ?? 2) - (tierOrder[b.tier] ?? 2);
      });
    return { items };
  }),

  syncCheckItem: protectedProcedure
    .input(z.object({
      trelloCheckItemId: z.string(),
      state: z.enum(["complete", "incomplete"]),
    }))
    .mutation(async ({ input, ctx }) => {
      let vaId: number | undefined;
      if (ctx.user.role !== "admin") {
        if (ctx.user.role !== "worker") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const [profile] = await db
          .select({ id: vaProfiles.id })
          .from(vaProfiles)
          .where(eq(vaProfiles.userId, ctx.user.id))
          .limit(1);
        if (!profile) throw new TRPCError({ code: "FORBIDDEN" });
        vaId = profile.id;
      }
      if (input.state === "complete") {
        await completeStepByCheckItemId(input.trelloCheckItemId, vaId);
      } else {
        await uncompleteStepByCheckItemId(input.trelloCheckItemId, vaId);
      }
      return { success: true };
    }),

  planMyDay: protectedProcedure.mutation(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const autopilotLvl = await getAutopilotLevel(vaId);
    if (autopilotLvl < 2) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Autopilot level ${autopilotLvl} is too low to generate daily plans. Set level ≥ 2 in Settings → Operational Policies.` });
    
    const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
    const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
    if (!apiKey || !apiToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Trello API credentials not configured" });

    const [allPlans, allScores, allStates] = await Promise.all([
      getAllAptlssPlans(vaId),
      getAllPriorityScores(vaId),
      getAllCardStates(vaId),
    ]);
    if (allPlans.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No APTLSS plans found. Generate plans for your active cards first." });
    
    const scoreMap = new Map<string, any>(allScores.map((s: any) => [s.cardId, s]));
    const stateMap = new Map<string, any>(allStates.map((s: any) => [s.cardId, s]));
    const cardSummaries = allPlans.slice(0, 20).map((p: any) => {
      let plan: Record<string, unknown> = {};
      try { plan = JSON.parse(p.planJson) as Record<string, unknown>; } catch { /* ignore */ }
      const score = scoreMap.get(p.cardId);
      const state = stateMap.get(p.cardId);
      const steps = (plan.steps as Array<{ estimatedMinutes?: number }> | undefined) ?? [];
      return {
        cardId: p.cardId,
        cardName: p.cardName,
        boardName: p.boardName,
        listName: p.listName,
        urgency: (plan.urgencyLabel as string | undefined) ?? 'MEDIUM',
        nextBestAction: (plan.nextBestAction as string | undefined) ?? (plan.action as string | undefined) ?? '',
        estimatedMinutes: steps.reduce((acc: number, st: any) => acc + (st.estimatedMinutes ?? 15), 0),
        requiresFounder: steps.some((st: any) => (st as { requiresFounder?: boolean }).requiresFounder) ?? false,
        isBlocked: (plan.isBlocked as boolean | undefined) ?? false,
        confidenceScore: (plan.confidenceScore as number | undefined) ?? 70,
        priorityScore: score?.score ?? 50,
        priorityTier: score?.tier ?? 'MEDIUM',
        cardState: state?.state ?? 'READY_TO_WORK',
      };
    });
    const summaryText = cardSummaries.map((c: any, i: number) =>
      `${i+1}. [${c.urgency}] ${c.cardName} (${c.boardName} › ${c.listName})\n   NBA: ${c.nextBestAction}\n   Est: ${c.estimatedMinutes}m | Priority: ${c.priorityScore} | State: ${c.cardState}${c.requiresFounder ? ' | ⚠️ NEEDS the Founder' : ''}${c.isBlocked ? ' | 🚫 BLOCKED' : ''}`
    ).join('\n\n');
    const response = await invokeLLM({
      messages: [
        {
          role: 'system' as const,
          content: `You are an expert daily planner for the worker, a virtual assistant working for the Founder (who has autism and ADHD).\nCreate a realistic, time-blocked daily work schedule based on the APTLSS plans for all active Trello cards.\nRules:\n- the worker works 08:00–23:00 EAT with breaks at 09:00 (30m), 15:00 (45m), 21:00 (90m)\n- Total available work time: ~555 minutes\n- Prioritise CRITICAL > HIGH > MEDIUM > LOW\n- Put BLOCKED cards at the end or skip if fully blocked\n- Cards requiring the Founder should be scheduled early\n- Be realistic — do not schedule more than 555 minutes of work\n- Each time block should be 30–120 minutes\n- Include a morning triage block (08:00–09:00) and an end-of-day wrap-up block\nReturn ONLY valid JSON.`,
        },
        {
          role: 'user' as const,
          content: `Active cards:\n\n${summaryText}\n\nCreate the optimal daily schedule for today.`,
        },
      ],
      response_format: {
        type: 'json_schema' as const,
        json_schema: {
          name: 'daily_schedule',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              schedule: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    time: { type: 'string' },
                    cardId: { type: ['string', 'null'] },
                    cardName: { type: 'string' },
                    action: { type: 'string' },
                    estimatedMinutes: { type: 'number' },
                    priority: { type: 'string' },
                    notes: { type: 'string' },
                  },
                  required: ['time', 'cardId', 'cardName', 'action', 'estimatedMinutes', 'priority', 'notes'],
                  additionalProperties: false,
                },
              },
              totalScheduledMinutes: { type: 'number' },
              unscheduledCards: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    cardId: { type: 'string' },
                    cardName: { type: 'string' },
                    reason: { type: 'string' },
                  },
                  required: ['cardId', 'cardName', 'reason'],
                  additionalProperties: false,
                },
              },
              dailySummary: { type: 'string' },
              topPriority: { type: 'string' },
              founderItems: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    cardId: { type: 'string' },
                    cardName: { type: 'string' },
                    decision: { type: 'string' },
                  },
                  required: ['cardId', 'cardName', 'decision'],
                  additionalProperties: false,
                },
              },
            },
            required: ['schedule', 'totalScheduledMinutes', 'unscheduledCards', 'dailySummary', 'topPriority', 'founderItems'],
            additionalProperties: false,
          },
        },
      },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: 'No schedule generated' });
    const parsed = JSON.parse(typeof content === 'string' ? content : JSON.stringify(content)) as {
      schedule: Array<{ time: string; cardId: string | null; cardName: string; action: string; estimatedMinutes: number; priority: string; notes: string }>;
      totalScheduledMinutes: number;
      unscheduledCards: Array<{ cardId: string; cardName: string; reason: string }>;
      dailySummary: string;
      topPriority: string;
      founderItems: Array<{ cardId: string; cardName: string; decision: string }>;
    };
    return { ...parsed, robertItems: parsed.founderItems };
  }),

  doneGateCheck: protectedProcedure
    .input(z.object({ cardId: z.string() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      if (!apiKey || !apiToken) return { ready: false, missing: ["Trello credentials not configured"] };

      const trelloCtx = await fetchCardContext(input.cardId, apiKey, apiToken);
      const progress = await getCardStepProgress(vaId, input.cardId);
      const state = await getCardState(vaId, input.cardId);

      const missing: string[] = [];

      if (progress.total > 0 && progress.completed < progress.total) {
        missing.push(`${progress.total - progress.completed} APTLSS checklist item(s) not yet complete`);
      }
      if (progress.openFounder > 0) {
        missing.push(`${progress.openFounder} the Founder decision(s) still open`);
      }
      if (!state?.hasFinalSummary) {
        missing.push("No final summary comment posted on the card");
      }
      if (trelloCtx.attachments.length === 0) {
        missing.push("No attachments or proof of completion linked");
      }
      if (progress.openBlocked > 0) {
        missing.push(`${progress.openBlocked} step(s) still blocked by other cards`);
      }
      if (state?.hasUnansweredQuestion) {
        missing.push("Latest comment contains an unanswered question");
      }

      return {
        ready: missing.length === 0,
        missing,
        cardState: state?.state ?? null,
        progress,
      };
    }),

  getRepairQueue: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getNeedsRepairCards(vaId);
  }),

  getReadyForDone: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getReadyForDoneCards(vaId);
  }),

  getRisksAndExceptions: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const [allPlans, allSteps, allScores, allStates] = await Promise.all([
      getAllAptlssPlans(vaId),
      getAllFounderDecisionSteps(vaId),
      getAllPriorityScores(vaId),
      getAllCardStates(vaId),
    ]);
    const scoreMap = new Map<string, any>(allScores.map((s: any) => [s.cardId, s]));
    const planMap = new Map<string, any>(allPlans.map((p: any) => [p.cardId, p]));

    const pendingDecisions = allSteps
      .filter((s: any) => s.status !== 'complete')
      .map((s: any) => {
        const plan = planMap.get(s.cardId);
        const score = scoreMap.get(s.cardId);
        let recommendedDecision: string | null = null;
        try {
          const planData = JSON.parse(plan?.planJson ?? '{}') as Record<string, unknown>;
          const steps = (planData.steps as Array<{ title?: string; recommendedDecision?: string }> | undefined) ?? [];
          const matchingStep = steps.find((st: any) => st.title === s.title);
          recommendedDecision = matchingStep?.recommendedDecision ?? null;
        } catch { /* ignore */ }
        return {
          cardId: s.cardId,
          cardName: plan?.cardName ?? s.cardId,
          cardUrl: plan?.cardUrl ?? `https://trello.com/c/${s.cardId}`,
          boardName: plan?.boardName ?? null,
          stepTitle: s.title,
          tier: score?.tier ?? 'MEDIUM',
          recommendedDecision,
        };
      })
      .sort((a: any, b: any) => {
        const tierOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, BLOCKED: 4 };
        return (tierOrder[a.tier] ?? 2) - (tierOrder[b.tier] ?? 2);
      });

    const cardUrl = (cardId: string) => planMap.get(cardId)?.cardUrl ?? `https://trello.com/c/${cardId}`;

    const stalledCards = allStates.filter((s: any) => s.state === 'STALLED').map((s: any) => ({
      cardId: s.cardId, cardName: s.cardName, cardUrl: cardUrl(s.cardId),
      boardName: s.boardName, stateReason: s.stateReason,
      tier: scoreMap.get(s.cardId)?.tier ?? 'MEDIUM',
    }));
    const blockedCards = allStates.filter((s: any) => s.state === 'BLOCKED').map((s: any) => ({
      cardId: s.cardId, cardName: s.cardName, cardUrl: cardUrl(s.cardId),
      boardName: s.boardName, stateReason: s.stateReason,
      tier: scoreMap.get(s.cardId)?.tier ?? 'MEDIUM',
    }));
    const waitingCards = allStates.filter((s: any) => s.state === 'waiting_for_worker').map((s: any) => ({
      cardId: s.cardId, cardName: s.cardName, cardUrl: cardUrl(s.cardId),
      boardName: s.boardName, stateReason: s.stateReason,
      tier: scoreMap.get(s.cardId)?.tier ?? 'MEDIUM',
    }));
    const repairCards = allStates.filter((s: any) => s.state === 'NEEDS_RESTRUCTURING').map((s: any) => ({
      cardId: s.cardId, cardName: s.cardName, cardUrl: cardUrl(s.cardId),
      boardName: s.boardName, stateReason: s.stateReason,
      tier: scoreMap.get(s.cardId)?.tier ?? 'MEDIUM',
    }));

    const deadlineRisks = allStates.filter((s: any) => {
      if (s.state === 'OVERDUE') return true;
      const tier = scoreMap.get(s.cardId)?.tier;
      if ((tier === 'CRITICAL' || tier === 'HIGH') && (s.state === 'STALLED' || s.state === 'BLOCKED_BY_OTHER_CARD')) return true;
      return false;
    }).map((s: any) => ({
      cardId: s.cardId, cardName: s.cardName, cardUrl: cardUrl(s.cardId),
      boardName: s.boardName, stateReason: s.stateReason,
      tier: scoreMap.get(s.cardId)?.tier ?? 'HIGH',
      isOverdue: s.state === 'OVERDUE',
    }));

    const readyForApproval = allStates.filter((s: any) => s.state === 'READY_FOR_DONE').map((s: any) => ({
      cardId: s.cardId, cardName: s.cardName, cardUrl: cardUrl(s.cardId),
      boardName: s.boardName, stateReason: s.stateReason,
      tier: scoreMap.get(s.cardId)?.tier ?? 'MEDIUM',
    }));

    const exceptionCardIds = new Set([
      ...pendingDecisions.map((c: any) => c.cardId),
      ...stalledCards.map((c: any) => c.cardId),
      ...blockedCards.map((c: any) => c.cardId),
      ...waitingCards.map((c: any) => c.cardId),
      ...repairCards.map((c: any) => c.cardId),
      ...deadlineRisks.map((c: any) => c.cardId),
      ...readyForApproval.map((c: any) => c.cardId),
    ]);
    const normalCount = allStates.filter((s: any) =>
      !exceptionCardIds.has(s.cardId) &&
      s.state !== 'DONE_CONFIRMED' &&
      s.state !== 'NEEDS_ARCHIVE'
    ).length;
    const externalCount = allStates.filter((s: any) => s.state === 'WAITING_FOR_EXTERNAL_PARTY').length;

    const escalations = allPlans
      .filter((p: any) => {
        try {
          const plan = JSON.parse(p.planJson) as Record<string, unknown>;
          return plan.escalationCategory && plan.escalationCategory !== null;
        } catch { return false; }
      })
      .map(p => {
        let escalationCategory: string | null = null;
        let founderDecision: string | null = null;
        let confidenceScore: number | null = null;
        let confidenceReason: string | null = null;
        try {
          const plan = JSON.parse(p.planJson) as Record<string, unknown>;
          escalationCategory = (plan.escalationCategory as string) ?? null;
          founderDecision = (plan.founderDecision as string) ?? null;
          confidenceScore = (plan.confidenceScore as number) ?? null;
          confidenceReason = (plan.confidenceReason as string) ?? null;
        } catch { /* ignore */ }
        return {
          cardId: p.cardId,
          cardName: p.cardName,
          cardUrl: p.cardUrl,
          boardName: p.boardName,
          escalationCategory,
          founderDecision,
          confidenceScore,
          confidenceReason,
          tier: scoreMap.get(p.cardId)?.tier ?? 'MEDIUM',
        };
      });

    return {
      pendingDecisions,
      stalledCards,
      blockedCards,
      waitingCards,
      repairCards,
      escalations,
      deadlineRisks,
      readyForApproval,
      normalCount,
      externalCount,
      totalIssues: pendingDecisions.length + stalledCards.length + blockedCards.length + waitingCards.length + escalations.length + deadlineRisks.length + readyForApproval.length,
    };
  }),

  getPolicies: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return getAllPolicies(vaId);
  }),

  updatePolicy: protectedProcedure
    .input(z.object({ ruleKey: z.string(), value: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      await upsertPolicy(vaId, input.ruleKey, input.value);
      return { success: true };
    }),

  togglePolicy: protectedProcedure
    .input(z.object({ ruleKey: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      await setPolicyEnabled(vaId, input.ruleKey, input.enabled);
      return { success: true };
    }),

  getPendingFollowUps: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return getPendingFollowUpDrafts(vaId);
  }),

  getAllFollowUps: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return getAllFollowUpDrafts(vaId);
  }),

  markFollowUpSent: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await markFollowUpDraftSent(input.id);
      return { success: true };
    }),

  dismissFollowUp: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await dismissFollowUpDraft(input.id);
      return { success: true };
    }),

  postFollowUpToTrello: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const draft = await getFollowUpDraftById(input.id);
      if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "Follow-up draft not found" });
      if (draft.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "Draft is not pending" });

      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      const autopilotLevel = await getAutopilotLevel(vaId);

      let postedToTrello = false;
      if (autopilotLevel >= 3 && apiKey && apiToken) {
        const commentText = `[APTLSS Auto Follow-Up]\n\n${draft.draftMessage}\n\n_Reason: ${draft.reason}_`;
        await postCardComment(draft.cardId, commentText, apiKey, apiToken);
        postedToTrello = true;
      }

      await markFollowUpDraftSent(input.id);
      return { success: true, postedToTrello };
    }),

  getWorkerPerformance: protectedProcedure.query(async () => {
    return getAllWorkerPerformance();
  }),

  recordWorkerSignal: protectedProcedure
    .input(z.object({
      workerId: z.string(),
      workerName: z.string(),
      weekKey: z.string(),
      avgResponseTimeMinutes: z.number().default(0),
      checklistItemsCompleted: z.number().default(0),
      stalledCardsCount: z.number().default(0),
      missedDeadlines: z.number().default(0),
      founderEscalationsCount: z.number().default(0),
      reworkCount: z.number().default(0),
      unclearHandovers: z.number().default(0),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { founderEscalationsCount, ...rest } = input;
      await upsertWorkerPerformance({
        ...rest,
        robertEscalationsCount: founderEscalationsCount,
        notes: input.notes ?? null,
        calculatedAt: new Date(),
      });
      return { success: true };
    }),

  getDefaultActionForState: protectedProcedure
    .input(z.object({ state: z.string() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const ruleKey = `default_action_${input.state.toLowerCase()}`;
      const BUILT_IN_DEFAULTS: Record<string, string> = {
        new_untriaged: "Generate an APTLSS plan to break this card into actionable steps.",
        ready_to_start: "Pick the highest-priority open step and start working on it.",
        in_progress: "Continue the current open step. Update checklist when done.",
        waiting_for_worker: "Answer the pending question in the card comments.",
        WAITING_FOR_FOUNDER: "Notify the Founder that a decision is needed on this card.",
        waiting_for_external_party: "Check if the follow-up deadline has passed. If yes, send a follow-up message.",
        blocked_by_other_card: "Check the blocking card. If resolved, unblock and resume.",
        stalled: "Leave a comment explaining why progress has stalled. Escalate if needed.",
        overdue: "Immediately prioritise this card. Notify the Founder if it cannot be completed today.",
        ready_for_review: "Ask the Founder to review and approve before moving to Done.",
        ready_for_done: "Verify all done-gate criteria are met, then move the card to Done.",
        done_confirmed: "Archive this card at the end of the week.",
        needs_restructuring: "Open the card and fix the flagged issue (add description, due date, or split into smaller cards).",
        needs_archive: "Mark the card as complete in Trello and move it to the Archive list.",
      };
      const customValue = await getPolicyValue(vaId, ruleKey, "");
      const action = customValue.trim() || BUILT_IN_DEFAULTS[input.state.toLowerCase()] || "No default action configured for this state.";
      return { state: input.state, action, isCustom: !!customValue.trim() };
    }),

  getAllDefaultActions: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const allPolicies = await getAllPolicies(vaId);
    return allPolicies.filter((p) => p.ruleKey.startsWith("default_action_"));
  }),

  getLatestWeeklyAnalysis: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return getLatestWeeklyAnalysis(vaId);
  }),
  getWeeklyAnalysisHistory: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return getRecentWeeklyAnalyses(vaId, 8);
  }),

  getCommandCenter: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const [allPlans, allScores, allStates, allSteps] = await Promise.all([
      getAllAptlssPlans(vaId),
      getAllPriorityScores(vaId),
      getAllCardStates(vaId),
      getAllFounderDecisionSteps(vaId),
    ]);

    const scoreMap = new Map<string, any>(allScores.map((s: any) => [s.cardId, s]));
    const planMap = new Map<string, any>(allPlans.map((p: any) => [p.cardId, p]));
    const stateMap = new Map<string, any>(allStates.map((s: any) => [s.cardId, s]));

    function parsePlan(cardId: string): Record<string, unknown> {
      try { return JSON.parse(planMap.get(cardId)?.planJson ?? '{}'); } catch { return {}; }
    }

    function confidenceLabel(score: number | null | undefined): 'High' | 'Medium' | 'Low' {
      if (score == null) return 'Low';
      if (score >= 80) return 'High';
      if (score >= 60) return 'Medium';
      return 'Low';
    }

    function buildWhyShown(state: (typeof allStates)[0] | undefined, score: (typeof allScores)[0] | undefined, plan: Record<string, unknown>): string {
      const reasons: string[] = [];
      if (state?.isOverdue) reasons.push('due date passed');
      if (state?.daysSinceProgress && state.daysSinceProgress > 7) reasons.push(`${state.daysSinceProgress} days idle`);
      if (state?.state === 'BLOCKED_BY_OTHER_CARD') reasons.push('blocked by another card');
      if (state?.state === 'STALLED') reasons.push('stalled — no recent progress');
      if (state?.state === 'WAITING_FOR_EXTERNAL_PARTY') reasons.push('waiting for external reply');
      if (state?.hasUnansweredQuestion) reasons.push('unanswered question detected');
      if (plan.escalationCategory) reasons.push(`escalation: ${plan.escalationCategory}`);
      if (score?.tier === 'CRITICAL') reasons.push('CRITICAL priority tier');
      if (score?.tier === 'HIGH') reasons.push('HIGH priority tier');
      if (reasons.length === 0) reasons.push('active card in system');
      return 'Shown because: ' + reasons.join(' + ');
    }

    function classifyOnHold(state: (typeof allStates)[0] | undefined, plan: Record<string, unknown>): string {
      if (!state) return 'still_waiting';
      const daysSince = state.daysSinceProgress ?? 0;
      const isOverdue = state.isOverdue;
      const hasEscalation = !!plan.escalationCategory;
      const needsFounder = !!plan.founderDecision;
      if (needsFounder || hasEscalation) return 'needs_founder';
      if (isOverdue || daysSince > 14) return 'needs_escalation';
      if (daysSince > 30) return 'possibly_obsolete';
      const updatedMs = state.calculatedAt ? new Date(state.calculatedAt).getTime() : 0;
      const daysSinceUpdate = (Date.now() - updatedMs) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 3 && daysSince < 3) return 'ready_to_resume';
      return 'still_waiting';
    }

    const enrichedCards = allStates.map((s: any) => {
      const score = scoreMap.get(s.cardId);
      const plan = planMap.get(s.cardId);
      const planData = parsePlan(s.cardId);
      const openSteps = allSteps.filter((st: any) => st.cardId === s.cardId && st.status !== 'complete');
      const totalSteps = (score?.openSteps ?? 0) + (score?.completedSteps ?? 0);
      const completedSteps = score?.completedSteps ?? 0;
      const pct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
      const confidenceScore = (planData.confidenceScore as number | null) ?? null;
      const confidenceReason = (planData.confidenceReason as string | null) ?? null;
      const nextBestAction = (planData.nextBestAction as string | null) ?? null;
      const escalationCategory = (planData.escalationCategory as string | null) ?? null;
      const founderDecision = (planData.founderDecision as string | null) ?? null;
      const urgencyLabel = (planData.urgencyLabel as string | null) ?? null;
      
      const checklistClarity = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 40) : 0;
      const planClarity = confidenceScore != null ? Math.min(Math.round(confidenceScore * 0.4), 40) : 20;
      const activityScore = Math.max(0, 20 - Math.min(s.daysSinceProgress * 2, 20));
      const scoreBreakdown = {
        planClarity,
        checklistClarity,
        activityScore,
        total: confidenceScore ?? (planClarity + checklistClarity + activityScore),
        reason: confidenceReason ?? (confidenceScore != null
          ? `Plan confidence: ${confidenceScore}%. Checklist: ${completedSteps}/${totalSteps} steps done. Days idle: ${s.daysSinceProgress}.`
          : 'No plan generated yet — confidence cannot be calculated.'),
      };
      return {
        cardId: s.cardId,
        cardName: s.cardName,
        cardUrl: plan?.cardUrl ?? `https://trello.com/c/${s.cardId}`,
        boardName: s.boardName,
        listName: s.listName,
        state: s.state,
        stateReason: s.stateReason ?? null,
        tier: score?.tier ?? 'MEDIUM',
        score: score?.score ?? 0,
        isOverdue: s.isOverdue,
        daysSinceProgress: s.daysSinceProgress,
        hasUnansweredQuestion: s.hasUnansweredQuestion,
        checklistProgress: { completed: completedSteps, total: totalSteps, pct },
        nextBestAction,
        confidenceScore,
        confidenceLabel: confidenceLabel(confidenceScore),
        confidenceReason,
        scoreBreakdown,
        escalationCategory,
        founderDecision,
        AdminDecision: founderDecision,
        urgencyLabel,
        openFounderSteps: openSteps.filter((st: any) => st.requiresRobert).length,
        openAdminSteps: openSteps.filter((st: any) => st.requiresRobert).length,
        whyShown: buildWhyShown(s, score, planData),
        onHoldClassification: s.listName && s.listName.toLowerCase().includes('hold')
          ? classifyOnHold(s, planData)
          : null,
      };
    });

    const criticalToday = enrichedCards.filter((c: any) =>
      c.tier === 'CRITICAL' ||
      c.isOverdue ||
      c.escalationCategory === 'legal_approval' ||
      c.escalationCategory === 'money_decision' ||
      (c.tier === 'HIGH' && c.daysSinceProgress > 5)
    ).sort((a: any, b: any) => b.score - a.score);

    const readyToAct = enrichedCards.filter((c: any) =>
      !criticalToday.find((x: any) => x.cardId === c.cardId) &&
      (c.state === 'READY_TO_START' || c.state === 'IN_PROGRESS' || c.state === 'READY_FOR_REVIEW') &&
      c.openFounderSteps === 0 &&
      !c.isOverdue
    ).sort((a: any, b: any) => b.score - a.score);

    const waitingExternal = enrichedCards.filter((c: any) =>
      !criticalToday.find((x: any) => x.cardId === c.cardId) &&
      !readyToAct.find((x: any) => x.cardId === c.cardId) &&
      (c.state === 'WAITING_FOR_EXTERNAL_PARTY' || c.state === 'BLOCKED_BY_OTHER_CARD')
    ).sort((a: any, b: any) => b.score - a.score);

    const needsFounderDecision = enrichedCards.filter((c: any) =>
      !criticalToday.find((x: any) => x.cardId === c.cardId) &&
      !readyToAct.find((x: any) => x.cardId === c.cardId) &&
      !waitingExternal.find((x: any) => x.cardId === c.cardId) &&
      (c.openFounderSteps > 0 || c.state === 'WAITING_FOR_FOUNDER' || !!c.founderDecision)
    ).sort((a: any, b: any) => b.score - a.score);

    const lowRiskMaintenance = enrichedCards.filter((c: any) =>
      !criticalToday.find((x: any) => x.cardId === c.cardId) &&
      !readyToAct.find((x: any) => x.cardId === c.cardId) &&
      !waitingExternal.find((x: any) => x.cardId === c.cardId) &&
      !needsFounderDecision.find((x: any) => x.cardId === c.cardId) &&
      c.state !== 'DONE_CONFIRMED' &&
      c.state !== 'NEEDS_ARCHIVE'
    ).sort((a: any, b: any) => a.score - b.score);

    const onHoldCards = enrichedCards.filter((c: any) =>
      c.listName && c.listName.toLowerCase().includes('hold')
    ).map((c: any) => ({
      ...c,
      onHoldClassification: c.onHoldClassification ?? 'still_waiting',
    }));

    const summary = {
      criticalCount: criticalToday.length,
      needsDecisionCount: needsFounderDecision.length,
      autoHandledCount: readyToAct.filter((c: any) => (c.confidenceScore ?? 0) >= 80).length,
      waitingExternalCount: waitingExternal.length,
      totalActive: enrichedCards.filter((c: any) => c.state !== 'DONE_CONFIRMED' && c.state !== 'NEEDS_ARCHIVE').length,
    };

    return {
      criticalToday,
      readyToAct,
      waitingExternal,
      needsFounderDecision,
      needsAdminDecision: needsFounderDecision,
      lowRiskMaintenance,
      onHoldCards,
      summary,
    };
  }),

  batchKeepOnHold: protectedProcedure
    .input(z.object({ cardIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const allPlansKOH = await getAllAptlssPlans(vaId);
      const planMapKOH = new Map(allPlansKOH.map(p => [p.cardId, p]));
      let count = 0;
      for (const cardId of input.cardIds) {
        const plan = planMapKOH.get(cardId);
        await logAuditAction({
          vaId,
          cardId,
          cardName: plan?.cardName ?? cardId,
          action: 'kept_on_hold',
          description: 'Batch action: kept on hold (low-risk, no escalation needed)',
          source: 'manual',
        });
        count++;
      }
      return { success: true, count };
    }),

  batchMoveToDoing: protectedProcedure
    .input(z.object({ cardIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      let count = 0;
      for (const cardId of input.cardIds) {
        if (apiKey && apiToken) {
          await postCardComment(cardId, '[APTLSS] Batch action: card moved to DOING — ready to resume, no blocker detected.', apiKey, apiToken);
        }
        await logAuditAction({
          vaId,
          cardId,
          cardName: cardId,
          action: 'moved_to_doing',
          description: 'Batch action: moved to DOING (ready to resume)',
          source: 'manual',
        });
        count++;
      }
      return { success: true, count };
    }),

  batchDraftDailyUpdates: protectedProcedure
    .input(z.object({ cardIds: z.array(z.string()), autoPost: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      const [allPlans, allScores, allStates] = await Promise.all([
        getAllAptlssPlans(vaId),
        getAllPriorityScores(vaId),
        getAllCardStates(vaId),
      ]);
      const planMap2 = new Map<string, any>(allPlans.map((p: any) => [p.cardId, p]));
      const scoreMap2 = new Map<string, any>(allScores.map((s: any) => [s.cardId, s]));
      const stateMap2 = new Map<string, any>(allStates.map((s: any) => [s.cardId, s]));

      const drafts: Array<{
        cardId: string; cardName: string; cardUrl: string;
        draft: string; confidenceScore: number; autoPosted: boolean;
      }> = [];

      for (const cardId of input.cardIds) {
        const plan = planMap2.get(cardId);
        const score = scoreMap2.get(cardId);
        const state = stateMap2.get(cardId);
        if (!plan) continue;

        let planData: Record<string, unknown> = {};
        try { planData = JSON.parse(plan.planJson); } catch { /* ignore */ }

        const nextBestAction = (planData.nextBestAction as string) ?? 'Continue working on current tasks';
        const summary = (planData.summary as string) ?? '';
        const nextCheckpoint = (planData.nextCheckpoint as string) ?? 'Tomorrow';
        const isBlocked = (planData.isBlocked as boolean) ?? false;
        const blockedReason = (planData.blockedReason as string) ?? '';
        const confidenceScore = (planData.confidenceScore as number) ?? 70;
        const steps = (planData.steps as Array<{ description?: string; status?: string }> | undefined) ?? [];
        const completedSteps = steps.filter(s => s.status === 'complete').map(s => s.description ?? '').filter(Boolean);
        const openStepsArr = steps.filter(s => s.status !== 'complete').map(s => s.description ?? '').filter(Boolean);
        const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

        let draft: string;
        try {
          const llmRes = await invokeLLM({
            messages: [
              {
                role: 'system' as const,
                content: `You are the worker, a professional virtual assistant. Write a concise, professional daily Trello update comment for a task card.\nFormat:\n**Daily update — ${todayStr}**\nWork completed today: <what was done>\nCurrent status: <brief status>\nNext step: <single most important next action>\nBlocker: <None or describe blocker>\nExpected next update: <when>\n\nBe specific, use the context provided. Keep it under 120 words. Return only the formatted comment text, no JSON.`,
              },
              {
                role: 'user' as const,
                content: `Card: ${plan.cardName}\nSummary: ${summary || 'No summary available'}\nCurrent state: ${state?.stateReason ?? state?.state ?? 'In progress'}\nNext best action: ${nextBestAction}\nCompleted steps today: ${completedSteps.slice(0, 5).join('; ') || 'None recorded'}\nOpen steps remaining: ${openStepsArr.slice(0, 5).join('; ') || 'None'}\nBlocker: ${isBlocked ? blockedReason : 'None'}\nNext checkpoint: ${nextCheckpoint}`,
              },
            ],
          });
          const llmContent = llmRes?.choices?.[0]?.message?.content;
          draft = typeof llmContent === 'string' && llmContent.trim()
            ? llmContent.trim()
            : [
                `**Daily update — ${todayStr}**`,
                `Work completed today: ${summary || 'Progressing on assigned tasks'}`,
                `Current status: ${state?.stateReason ?? state?.state ?? 'In progress'}`,
                `Next step: ${nextBestAction}`,
                `Blocker: ${isBlocked ? blockedReason : 'None'}`,
                `Expected next update: ${nextCheckpoint}`,
              ].join('\n');
        } catch {
          draft = [
            `**Daily update — ${todayStr}**`,
            `Work completed today: ${summary || 'Progressing on assigned tasks'}`,
            `Current status: ${state?.stateReason ?? state?.state ?? 'In progress'}`,
            `Next step: ${nextBestAction}`,
            `Blocker: ${isBlocked ? blockedReason : 'None'}`,
            `Expected next update: ${nextCheckpoint}`,
          ].join('\n');
        }

        let autoPosted = false;
        if (input.autoPost && confidenceScore >= 80 && apiKey && apiToken) {
          await postCardComment(cardId, draft, apiKey, apiToken);
          await logAuditAction({
            vaId,
            cardId,
            cardName: plan.cardName,
            action: 'daily_update_drafted',
            description: 'Auto-posted daily update (confidence >= 80, autoPost=true)',
            confidenceScore,
            source: 'manual',
          });
          autoPosted = true;
        } else {
          await logAuditAction({
            vaId,
            cardId,
            cardName: plan.cardName,
            action: 'daily_update_drafted',
            description: 'Daily update draft generated (awaiting approval)',
            confidenceScore,
            requiresApproval: true,
            source: 'manual',
          });
        }

        drafts.push({
          cardId,
          cardName: plan.cardName,
          cardUrl: plan.cardUrl,
          draft,
          confidenceScore,
          autoPosted,
        });
      }

      return { drafts };
    }),

  postDailyUpdateDraft: protectedProcedure
    .input(z.object({ cardId: z.string(), cardName: z.string(), draft: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      if (!apiKey || !apiToken) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Trello credentials not configured' });
      await postCardComment(input.cardId, input.draft, apiKey, apiToken);
      await logAuditAction({
        vaId,
        cardId: input.cardId,
        cardName: input.cardName,
        action: 'comment_posted',
        description: 'Daily update posted to Trello after manual approval',
        source: 'manual',
        approved: true,
      });
      return { success: true };
    }),

  batchFollowUp: protectedProcedure
    .input(z.object({ cardIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
      const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;
      const allPlans = await getAllAptlssPlans(vaId);
      const planMap3 = new Map(allPlans.map(p => [p.cardId, p]));
      let count = 0;
      for (const cardId of input.cardIds) {
        const plan = planMap3.get(cardId);
        const comment = '[APTLSS Auto Follow-Up] This card has been waiting for an external reply. Please follow up with the relevant party.';
        if (apiKey && apiToken) {
          await postCardComment(cardId, comment, apiKey, apiToken);
        }
        await logAuditAction({
          vaId,
          cardId,
          cardName: plan?.cardName ?? cardId,
          action: 'follow_up_drafted',
          description: 'Batch follow-up comment posted on stale external-waiting card',
          source: 'manual',
        });
        count++;
      }
      return { success: true, count };
    }),

  batchSnooze: protectedProcedure
    .input(z.object({ cardIds: z.array(z.string()), days: z.number().min(1).max(30).default(7) }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      const allPlans = await getAllAptlssPlans(vaId);
      const planMap4 = new Map(allPlans.map(p => [p.cardId, p]));
      let count = 0;
      for (const cardId of input.cardIds) {
        const plan = planMap4.get(cardId);
        await logAuditAction({
          vaId,
          cardId,
          cardName: plan?.cardName ?? cardId,
          action: 'snooze_applied',
          description: `Batch snooze: card snoozed for ${input.days} days`,
          source: 'manual',
        });
        count++;
      }
      return { success: true, count };
    }),

  getCardAuditLog: protectedProcedure
    .input(z.object({ cardId: z.string(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return getCardAuditLog(vaId, input.cardId, input.limit);
    }),

  getRecentAuditLog: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const vaId = Number(ctx.user.id);
      return getRecentAuditLog(vaId, input.limit);
    }),

  getAdminMonitor: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const apiKey = process.env.TRELLO_API_KEY || process.env.TrelloAPIKey;
    const apiToken = process.env.TRELLO_TOKEN || process.env.TrelloAPIToken;

    const [syncStats, lastSync, recentSyncs, recentAudit] = await Promise.all([
      getSyncStats24h(vaId),
      getLastSuccessfulSync(vaId),
      getRecentSyncLog(vaId, 20),
      getRecentAuditLog(vaId, 50),
    ]);

    let webhookStatus: { active: boolean; count: number; webhooks: unknown[] } = { active: false, count: 0, webhooks: [] };
    if (apiKey && apiToken) {
      try {
        const webhooks = await getRegisteredWebhooks(apiKey, apiToken);
        webhookStatus = { active: webhooks.length > 0, count: webhooks.length, webhooks };
      } catch { /* ignore */ }
    }

    const pendingApprovals = recentAudit.filter(e => e.requiresApproval && e.approved === null);
    const cardsSkipped = recentAudit.filter(e => e.action === 'card_skipped_low_confidence');
    const failedRecs = recentAudit.filter(e =>
      e.action === 'escalated' && (e.confidenceScore ?? 100) < 60
    );

    return {
      syncStats,
      lastSync,
      recentSyncs,
      webhookStatus,
      pendingApprovals,
      cardsSkipped,
      failedRecs,
      recentAuditLog: recentAudit,
      ownerName: process.env.OWNER_NAME ?? 'Owner',
    };
  }),

  getEscalationRules: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    const [allPlans, allScores, allStates] = await Promise.all([
      getAllAptlssPlans(vaId),
      getAllPriorityScores(vaId),
      getAllCardStates(vaId),
    ]);
    const scoreMap3 = new Map<string, any>(allScores.map((s: any) => [s.cardId, s]));
    const planMap5 = new Map<string, any>(allPlans.map((p: any) => [p.cardId, p]));

    const triggered: Array<{
      cardId: string; cardName: string; cardUrl: string; boardName: string;
      rule: string; ruleDescription: string; recommendedAction: string; tier: string;
      daysSinceActivity: number;
    }> = [];

    for (const state of allStates) {
      if (state.state === 'DONE_CONFIRMED' || state.state === 'NEEDS_ARCHIVE') continue;
      const score = scoreMap3.get(state.cardId);
      const plan = planMap5.get(state.cardId);
      let planData: Record<string, unknown> = {};
      try { planData = JSON.parse(plan?.planJson ?? '{}'); } catch { /* ignore */ }

      const cardUrl = plan?.cardUrl ?? `https://trello.com/c/${state.cardId}`;
      const boardName = state.boardName;
      const tier = score?.tier ?? 'MEDIUM';
      const daysSince = state.daysSinceProgress ?? 0;
      const escalationCategory = planData.escalationCategory as string | null;

      if (state.isOverdue && (escalationCategory === 'legal_approval' || escalationCategory === 'money_decision')) {
        triggered.push({
          cardId: state.cardId, cardName: state.cardName, cardUrl, boardName, tier,
          rule: 'legal_financial_overdue',
          ruleDescription: 'Legal or financial card is overdue',
          recommendedAction: 'Show to the Founder immediately — requires urgent decision',
          daysSinceActivity: daysSince,
        });
      }

      if (state.listName?.toLowerCase().includes('hold') && daysSince >= 7) {
        triggered.push({
          cardId: state.cardId, cardName: state.cardName, cardUrl, boardName, tier,
          rule: 'on_hold_idle_7_days',
          ruleDescription: `ON-HOLD card idle for ${daysSince} days`,
          recommendedAction: 'Ask VA to follow up with external party',
          daysSinceActivity: daysSince,
        });
      }

      if (state.state === 'IN_PROGRESS' && state.stateReason?.toLowerCase().includes('no update')) {
        triggered.push({
          cardId: state.cardId, cardName: state.cardName, cardUrl, boardName, tier,
          rule: 'doing_no_update_today',
          ruleDescription: 'DOING card has no update posted today',
          recommendedAction: 'Draft daily update for this card',
          daysSinceActivity: daysSince,
        });
      }

      if (daysSince >= 30) {
        triggered.push({
          cardId: state.cardId, cardName: state.cardName, cardUrl, boardName, tier,
          rule: 'inactive_30_days',
          ruleDescription: `Card inactive for ${daysSince} days`,
          recommendedAction: 'Suggest archive or review — possibly obsolete',
          daysSinceActivity: daysSince,
        });
      }

      if (state.state === 'WAITING_FOR_EXTERNAL_PARTY' && daysSince >= 5) {
        triggered.push({
          cardId: state.cardId, cardName: state.cardName, cardUrl, boardName, tier,
          rule: 'external_silent_5_days',
          ruleDescription: `External party has not replied for ${daysSince} days`,
          recommendedAction: 'Send reminder email or follow-up message',
          daysSinceActivity: daysSince,
        });
      }
    }

    triggered.sort((a, b) => {
      const ruleOrder: Record<string, number> = {
        legal_financial_overdue: 0,
        doing_no_update_today: 1,
        on_hold_idle_7_days: 2,
        external_silent_5_days: 3,
        inactive_30_days: 4,
      };
      const orderDiff = (ruleOrder[a.rule] ?? 5) - (ruleOrder[b.rule] ?? 5);
      if (orderDiff !== 0) return orderDiff;
      return b.daysSinceActivity - a.daysSinceActivity;
    });

    return { triggered, totalCount: triggered.length };
  }),
});

// Reply Monitor tRPC router
export const replyMonitorRouter = router({
  getPendingReplyThreads: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getPendingReplyThreads(vaId);
  }),
  getPendingThreads: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getPendingReplyThreads(vaId);
  }),
  getAllReplyThreads: protectedProcedure
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getAllReplyThreads(vaId, input.limit ?? 100);
    }),
  getAllThreads: protectedProcedure
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getAllReplyThreads(vaId, input.limit ?? 100);
    }),
  markReplyThreadReplied: protectedProcedure
    .input(z.object({ cardId: z.string(), source: z.enum(["trello", "upwork"]) }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      await markReplyThreadReplied(vaId, input.cardId, input.source);
      return { success: true };
    }),
  markReplyThreadDemerited: protectedProcedure
    .input(z.object({ cardId: z.string(), source: z.enum(["trello", "upwork"]) }))
    .mutation(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      await markReplyThreadDemerited(vaId, input.cardId, input.source);
      return { success: true };
    }),
  getActiveVagueReplyFlags: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getActiveVagueReplyFlags(vaId);
  }),
  getActiveVagueFlags: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getActiveVagueReplyFlags(vaId);
  }),
  getAllVagueReplyFlags: protectedProcedure
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getAllVagueReplyFlags(vaId, input.limit ?? 50);
    }),
  getAllVagueFlags: protectedProcedure
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getAllVagueReplyFlags(vaId, input.limit ?? 50);
    }),
  resolveVagueReplyFlag: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await resolveVagueReplyFlag(input.id);
      return { success: true };
    }),
  resolveVagueFlag: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await resolveVagueReplyFlag(input.id);
      return { success: true };
    }),
  getActiveUnsignedFlags: protectedProcedure.query(async ({ ctx }) => {
    const vaId = Number(ctx.user.id);
    return await getActiveUnsignedFlags(vaId);
  }),
  getAllUnsignedFlags: protectedProcedure
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      const vaId = Number(ctx.user.id);
      return await getAllUnsignedFlags(vaId, input.limit ?? 50);
    }),
  resolveUnsignedFlag: protectedProcedure
    .input(z.object({ id: z.number(), note: z.string().optional() }))
    .mutation(async ({ input }) => {
      await resolveUnsignedFlag(input.id, input.note);
      return { success: true };
    }),
  triggerScan: protectedProcedure.mutation(async () => {
    return { success: true };
  }),
});
