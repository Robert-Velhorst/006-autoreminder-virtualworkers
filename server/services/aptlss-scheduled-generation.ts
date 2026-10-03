import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { and, asc, eq, lte } from "drizzle-orm";
import { generationItems, generationJobs, scheduledJobs } from "../../drizzle/schema";
import { getDb } from "../db";
import { runScheduledJob, ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobOwnershipReader } from "../scheduledJobRuntime";
import { assertAptlssJobOwnership, getAptlssChecklistWriteAuthorization } from "./trello-checklist-sync";
import {
  fetchAndGenerateAptlss,
  type AptlssGenerationSettings,
} from "./aptlss-generation";

type BatchInput = {
  jobId: string;
  cardIds: string[];
  settings?: AptlssGenerationSettings & { maxRetries?: number };
  createdBy: string;
  context?: ScheduledJobContext;
};

const UNKNOWN_TRELLO_OUTCOME = "outcome_unknown";
const UNKNOWN_TRELLO_OUTCOME_MESSAGE = "A previous attempt may have changed Trello. Verify the Trello checklist before retrying.";

export type AptlssBatchResult = {
  success: true;
  jobId: string;
  total: number;
  completed: number;
  failed: number;
  needsReview: number;
  results: Array<{
    cardId: string;
    success: boolean;
    checklistId?: string | null;
    appliedToTrello?: boolean;
    needsReview?: boolean;
    error?: string;
  }>;
};

function cleanCardIds(value: unknown) {
  if (!Array.isArray(value)) throw new Error("cardIds must be an array");
  return Array.from(new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))).slice(0, 250);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parsePersistedGenerationResult(value: unknown, cardId: string) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result = parsed as {
    success?: unknown;
    cardId?: unknown;
    checklistId?: unknown;
    appliedToTrello?: unknown;
    aptlss?: unknown;
    validation?: { needsReview?: unknown } | null;
  };
  if (
    result.success !== true
    || result.cardId !== cardId
    || !result.aptlss || typeof result.aptlss !== "object"
    || !result.validation || typeof result.validation.needsReview !== "boolean"
  ) return null;
  return result as Awaited<ReturnType<typeof fetchAndGenerateAptlss>>;
}

function affectedRows(result: unknown) {
  const value = Array.isArray(result) ? result[0] : result;
  return Number((value as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0);
}

function generationItemId(jobId: string, index: number, cardId: string) {
  const legacyId = `item_${jobId}_${index}`;
  if (legacyId.length <= 64) return legacyId;
  const digest = createHash("sha256").update(jobId).update("\0").update(cardId).digest("hex");
  return `item_${digest.slice(0, 59)}`;
}

function chainJobContext(child: ScheduledJobContext, parent?: ScheduledJobContext): ScheduledJobContext {
  if (!parent) return child;
  return {
    signal: AbortSignal.any([parent.signal, child.signal]),
    assertOwnership: async (reader?: ScheduledJobOwnershipReader) => {
      await assertAptlssJobOwnership(parent, reader);
      await assertAptlssJobOwnership(child, reader);
    },
  };
}

export async function executeAptlssGenerationBatch(input: BatchInput): Promise<AptlssBatchResult> {
  const { context } = input;
  await assertAptlssJobOwnership(context);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const cardIds = cleanCardIds(input.cardIds);
  if (cardIds.length === 0) throw new Error("At least one card is required");
  const settings = input.settings ?? {};
  const maxAttempts = Math.min(3, Math.max(1, Math.round(Number(settings.maxRetries) || 1)));

  await assertAptlssJobOwnership(context);
  await db.insert(generationJobs).values({
    id: input.jobId,
    totalCards: cardIds.length,
    completedCards: 0,
    failedCards: 0,
    status: "running",
    settings: JSON.stringify(settings),
    createdBy: input.createdBy,
    completedAt: null,
  }).onDuplicateKeyUpdate({
    set: {
      totalCards: cardIds.length,
      completedCards: 0,
      failedCards: 0,
      status: "running",
      settings: JSON.stringify(settings),
      completedAt: null,
    },
  });

  const priorItems = await db.select().from(generationItems)
    .where(eq(generationItems.jobId, input.jobId));
  const priorItemsByCardId = new Map(priorItems.map((item) => [item.cardId, item]));
  const results: AptlssBatchResult["results"] = [];
  let completed = 0;
  let failed = 0;
  let needsReview = 0;

  for (const [index, cardId] of cardIds.entries()) {
    await assertAptlssJobOwnership(context);
    const itemId = generationItemId(input.jobId, index, cardId);
    const priorItem = priorItemsByCardId.get(cardId);
    const priorResult = priorItem && (priorItem.status === "completed" || priorItem.status === "needs_review")
      ? parsePersistedGenerationResult(priorItem.result, cardId)
      : null;
    if (priorItem && priorResult) {
      const requiresReview = priorResult.validation.needsReview;
      if ((priorItem.status === "needs_review") === requiresReview) {
        completed += 1;
        if (requiresReview) needsReview += 1;
        results.push({
          cardId,
          success: true,
          checklistId: priorResult.checklistId,
          appliedToTrello: priorResult.appliedToTrello,
          needsReview: requiresReview,
        });
        continue;
      }
    }
    if (priorItem?.status === UNKNOWN_TRELLO_OUTCOME) {
      failed += 1;
      results.push({
        cardId,
        success: false,
        error: priorItem.error || UNKNOWN_TRELLO_OUTCOME_MESSAGE,
      });
      continue;
    }

    const authorization = await getAptlssChecklistWriteAuthorization(cardId);
    if (!authorization.allowed) {
      const reason = authorization.reason || "Trello checklist write authorization failed.";
      failed += 1;
      await assertAptlssJobOwnership(context);
      await db.insert(generationItems).values({
        id: itemId,
        jobId: input.jobId,
        cardId,
        cardName: `Card ${cardId}`,
        boardName: null,
        status: "failed",
        attempts: 0,
        maxAttempts,
        error: reason.slice(0, 8_000),
        result: null,
      }).onDuplicateKeyUpdate({
        set: {
          status: "failed",
          attempts: 0,
          error: reason.slice(0, 8_000),
          result: null,
          updatedAt: new Date(),
        },
      });
      results.push({ cardId, success: false, error: reason });
      await assertAptlssJobOwnership(context);
      await db.update(generationJobs).set({ completedCards: completed, failedCards: failed })
        .where(eq(generationJobs.id, input.jobId));
      continue;
    }

    const applyToTrello = settings.applyToTrello !== false && authorization.applyToTrello;
    if (applyToTrello) {
      await assertAptlssJobOwnership(context);
      await db.insert(generationItems).values({
        id: itemId,
        jobId: input.jobId,
        cardId,
        cardName: `Card ${cardId}`,
        boardName: null,
        status: UNKNOWN_TRELLO_OUTCOME,
        attempts: 0,
        maxAttempts,
        error: UNKNOWN_TRELLO_OUTCOME_MESSAGE,
        result: null,
      }).onDuplicateKeyUpdate({
        set: {
          status: UNKNOWN_TRELLO_OUTCOME,
          attempts: 0,
          maxAttempts,
          error: UNKNOWN_TRELLO_OUTCOME_MESSAGE,
          result: null,
          updatedAt: new Date(),
        },
      });
    }

    let lastError = "Generation failed";
    let result: Awaited<ReturnType<typeof fetchAndGenerateAptlss>> | null = null;
    let attempts = 0;

    const attemptLimit = applyToTrello ? 1 : maxAttempts;
    while (attempts < attemptLimit && !result) {
      attempts += 1;
      try {
        await assertAptlssJobOwnership(context);
        result = await fetchAndGenerateAptlss(cardId, {
          ...settings,
          applyToTrello,
        }, context);
      } catch (error) {
        if (error instanceof ScheduledJobLeaseLostError) throw error;
        await assertAptlssJobOwnership(context);
        lastError = errorMessage(error);
        if (attempts < attemptLimit) {
          try {
            await sleep(Math.min(4_000, 500 * 2 ** attempts), undefined, { signal: context?.signal });
          } catch (error) {
            await assertAptlssJobOwnership(context);
            throw error;
          }
        }
      }
    }

    if (result) {
      completed += 1;
      if (result.validation.needsReview) needsReview += 1;
      await assertAptlssJobOwnership(context);
      await db.insert(generationItems).values({
        id: itemId,
        jobId: input.jobId,
        cardId,
        cardName: result.aptlss.summary.slice(0, 255),
        boardName: null,
        status: result.validation.needsReview ? "needs_review" : "completed",
        attempts,
        maxAttempts,
        error: null,
        result: JSON.stringify(result),
      }).onDuplicateKeyUpdate({
        set: {
          status: result.validation.needsReview ? "needs_review" : "completed",
          attempts,
          error: null,
          result: JSON.stringify(result),
          updatedAt: new Date(),
        },
      });
      results.push({
        cardId,
        success: true,
        checklistId: result.checklistId,
        appliedToTrello: result.appliedToTrello,
        needsReview: result.validation.needsReview,
      });
    } else {
      failed += 1;
      await assertAptlssJobOwnership(context);
      await db.insert(generationItems).values({
        id: itemId,
        jobId: input.jobId,
        cardId,
        cardName: `Card ${cardId}`,
        boardName: null,
        status: applyToTrello ? UNKNOWN_TRELLO_OUTCOME : "failed",
        attempts,
        maxAttempts,
        error: (applyToTrello
          ? `${UNKNOWN_TRELLO_OUTCOME_MESSAGE} Last error: ${lastError}`
          : lastError).slice(0, 8_000),
        result: null,
      }).onDuplicateKeyUpdate({
        set: {
          status: applyToTrello ? UNKNOWN_TRELLO_OUTCOME : "failed",
          attempts,
          error: (applyToTrello
            ? `${UNKNOWN_TRELLO_OUTCOME_MESSAGE} Last error: ${lastError}`
            : lastError).slice(0, 8_000),
          result: null,
          updatedAt: new Date(),
        },
      });
      results.push({ cardId, success: false, error: lastError });
    }

    await assertAptlssJobOwnership(context);
    await db.update(generationJobs).set({ completedCards: completed, failedCards: failed })
      .where(eq(generationJobs.id, input.jobId));
  }

  await assertAptlssJobOwnership(context);
  await db.update(generationJobs).set({
    status: failed > 0 ? "completed_with_errors" : needsReview > 0 ? "needs_review" : "completed",
    completedCards: completed,
    failedCards: failed,
    completedAt: new Date(),
  }).where(eq(generationJobs.id, input.jobId));

  return { success: true, jobId: input.jobId, total: cardIds.length, completed, failed, needsReview, results };
}

function parseSettings(value: string): AptlssGenerationSettings & { maxRetries?: number } {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as AptlssGenerationSettings & { maxRetries?: number }
      : {};
  } catch {
    return {};
  }
}

export async function processDueAptlssGenerationJobs(now = new Date(), context?: ScheduledJobContext) {
  await assertAptlssJobOwnership(context);
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  let processed = 0;
  let failed = 0;

  const running = await db.select().from(scheduledJobs)
    .where(and(eq(scheduledJobs.status, "running"), lte(scheduledJobs.scheduledTime, now)))
    .orderBy(asc(scheduledJobs.scheduledTime))
    .limit(5);

  for (const orphaned of running) {
    let jobContext: ScheduledJobContext | undefined;
    try {
      await assertAptlssJobOwnership(context);
      // The shared lease runtime refuses this callback while a worker is still heartbeating.
      await runScheduledJob({
        jobKey: `aptlss-scheduled:${orphaned.id}`,
        leaseMs: 60 * 60_000,
        skipIfSuccessful: false,
      }, async (childContext) => {
        jobContext = chainJobContext(childContext, context);
        await assertAptlssJobOwnership(jobContext);
        const reset = await db.update(scheduledJobs).set({ status: "pending" })
          .where(and(
            eq(scheduledJobs.id, orphaned.id),
            eq(scheduledJobs.status, "running"),
            lte(scheduledJobs.scheduledTime, now),
          ));
        return {
          recordsProcessed: 0,
          detail: affectedRows(reset) === 1
            ? "Recovered an interrupted scheduled generation after acquiring its expired or missing lease."
            : "Scheduled generation state changed before recovery.",
        };
      });
    } catch (error) {
      if (error instanceof ScheduledJobLeaseLostError) throw error;
      if (jobContext?.signal.aborted) throw new ScheduledJobLeaseLostError();
      // The runtime has released the child lease; only the parent remains assertable.
      await assertAptlssJobOwnership(context);
      failed += 1;
      console.error(`[APTLSS Scheduler] Recovery of job ${orphaned.id} failed`, error);
    }
  }

  await assertAptlssJobOwnership(context);
  const due = await db.select().from(scheduledJobs)
    .where(and(eq(scheduledJobs.status, "pending"), lte(scheduledJobs.scheduledTime, now)))
    .orderBy(asc(scheduledJobs.scheduledTime))
    .limit(5);

  for (const queued of due) {
    let jobContext: ScheduledJobContext | undefined;
    try {
      await assertAptlssJobOwnership(context);
      const run = await runScheduledJob({
        jobKey: `aptlss-scheduled:${queued.id}`,
        leaseMs: 60 * 60_000,
        skipIfSuccessful: false,
      }, async (childContext) => {
        jobContext = chainJobContext(childContext, context);
        await assertAptlssJobOwnership(jobContext);
        const [current] = await db.select().from(scheduledJobs)
          .where(eq(scheduledJobs.id, queued.id)).limit(1);
        if (!current || current.status !== "pending" || current.scheduledTime > now) {
          return { recordsProcessed: 0, detail: "Job was no longer due and pending." };
        }

        await assertAptlssJobOwnership(jobContext);
        const claim = await db.update(scheduledJobs).set({ status: "running", error: null })
          .where(and(
            eq(scheduledJobs.id, current.id),
            eq(scheduledJobs.status, "pending"),
            lte(scheduledJobs.scheduledTime, now),
          ));
        if (affectedRows(claim) !== 1) return { recordsProcessed: 0, detail: "Job claim was lost." };

        try {
          const cardIds = cleanCardIds(JSON.parse(current.cardIds));
          const result = await executeAptlssGenerationBatch({
            jobId: current.id,
            cardIds,
            settings: parseSettings(current.settings),
            createdBy: current.createdBy,
            context: jobContext,
          });
          await assertAptlssJobOwnership(jobContext);
          await db.update(scheduledJobs).set({
            status: result.failed > 0 ? "completed_with_errors" : result.needsReview > 0 ? "needs_review" : "completed",
            completedAt: new Date(),
            error: result.failed > 0 ? `${result.failed} card(s) failed; inspect generation history.` : null,
          }).where(eq(scheduledJobs.id, current.id));
          return {
            recordsProcessed: result.completed,
            detail: JSON.stringify({ total: result.total, completed: result.completed, failed: result.failed, needsReview: result.needsReview }),
          };
        } catch (error) {
          if (error instanceof ScheduledJobLeaseLostError) throw error;
          await assertAptlssJobOwnership(jobContext);
          await db.update(scheduledJobs).set({
            status: "failed",
            completedAt: new Date(),
            error: errorMessage(error).slice(0, 8_000),
          }).where(eq(scheduledJobs.id, current.id));
          throw error;
        }
      });
      if (run.state === "success") processed += 1;
    } catch (error) {
      if (error instanceof ScheduledJobLeaseLostError) throw error;
      if (jobContext?.signal.aborted) throw new ScheduledJobLeaseLostError();
      await assertAptlssJobOwnership(context);
      failed += 1;
      console.error(`[APTLSS Scheduler] Job ${queued.id} failed`, error);
    }
  }
  await assertAptlssJobOwnership(context);
  return { found: due.length, processed, failed };
}

let processorTimer: ReturnType<typeof setInterval> | null = null;
let processorInitialTimer: ReturnType<typeof setTimeout> | null = null;
let processorRunning = false;

async function tick() {
  if (processorRunning) return;
  processorRunning = true;
  try {
    await processDueAptlssGenerationJobs();
  } catch (error) {
    console.error("[APTLSS Scheduler] Due-job scan failed", error);
  } finally {
    processorRunning = false;
  }
}

export function startAptlssScheduledGenerationProcessor(intervalSeconds = 30) {
  if (processorTimer) return;
  const intervalMs = Math.min(15 * 60_000, Math.max(15_000, Math.round(intervalSeconds * 1_000)));
  processorInitialTimer = setTimeout(() => {
    processorInitialTimer = null;
    void tick();
  }, 2_000);
  processorInitialTimer.unref?.();
  processorTimer = setInterval(() => void tick(), intervalMs);
  processorTimer.unref?.();
}

export function stopAptlssScheduledGenerationProcessor() {
  if (processorInitialTimer) clearTimeout(processorInitialTimer);
  processorInitialTimer = null;
  if (processorTimer) clearInterval(processorTimer);
  processorTimer = null;
}
