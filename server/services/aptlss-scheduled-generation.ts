import { and, asc, eq, lte } from "drizzle-orm";
import { generationItems, generationJobs, scheduledJobs } from "../../drizzle/schema";
import { getDb } from "../db";
import { runScheduledJob } from "../scheduledJobRuntime";
import {
  fetchAndGenerateAptlss,
  type AptlssGenerationSettings,
} from "./aptlss-generation";

type BatchInput = {
  jobId: string;
  cardIds: string[];
  settings?: AptlssGenerationSettings & { maxRetries?: number };
  createdBy: string;
};

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeAptlssGenerationBatch(input: BatchInput): Promise<AptlssBatchResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const cardIds = cleanCardIds(input.cardIds);
  if (cardIds.length === 0) throw new Error("At least one card is required");
  const settings = input.settings ?? {};
  const maxAttempts = Math.min(3, Math.max(1, Math.round(Number(settings.maxRetries) || 1)));

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

  const results: AptlssBatchResult["results"] = [];
  let completed = 0;
  let failed = 0;
  let needsReview = 0;

  for (const [index, cardId] of cardIds.entries()) {
    const itemId = `item_${input.jobId}_${index}`.slice(0, 64);
    let lastError = "Generation failed";
    let result: Awaited<ReturnType<typeof fetchAndGenerateAptlss>> | null = null;
    let attempts = 0;

    while (attempts < maxAttempts && !result) {
      attempts += 1;
      try {
        result = await fetchAndGenerateAptlss(cardId, { ...settings, applyToTrello: true });
      } catch (error) {
        lastError = errorMessage(error);
        if (attempts < maxAttempts) await delay(Math.min(4_000, 500 * 2 ** attempts));
      }
    }

    if (result) {
      completed += 1;
      if (result.validation.needsReview) needsReview += 1;
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
      await db.insert(generationItems).values({
        id: itemId,
        jobId: input.jobId,
        cardId,
        cardName: `Card ${cardId}`,
        boardName: null,
        status: "failed",
        attempts,
        maxAttempts,
        error: lastError.slice(0, 8_000),
        result: null,
      }).onDuplicateKeyUpdate({
        set: {
          status: "failed",
          attempts,
          error: lastError.slice(0, 8_000),
          result: null,
          updatedAt: new Date(),
        },
      });
      results.push({ cardId, success: false, error: lastError });
    }

    await db.update(generationJobs).set({ completedCards: completed, failedCards: failed })
      .where(eq(generationJobs.id, input.jobId));
  }

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

export async function processDueAptlssGenerationJobs(now = new Date()) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const due = await db.select().from(scheduledJobs)
    .where(and(eq(scheduledJobs.status, "pending"), lte(scheduledJobs.scheduledTime, now)))
    .orderBy(asc(scheduledJobs.scheduledTime))
    .limit(5);

  let processed = 0;
  let failed = 0;
  for (const queued of due) {
    try {
      const run = await runScheduledJob({
        jobKey: `aptlss-scheduled:${queued.id}`,
        leaseMs: 60 * 60_000,
        skipIfSuccessful: false,
      }, async () => {
        const [current] = await db.select().from(scheduledJobs)
          .where(eq(scheduledJobs.id, queued.id)).limit(1);
        if (!current || current.status !== "pending" || current.scheduledTime > now) {
          return { recordsProcessed: 0, detail: "Job was no longer due and pending." };
        }

        await db.update(scheduledJobs).set({ status: "running", error: null })
          .where(and(eq(scheduledJobs.id, current.id), eq(scheduledJobs.status, "pending")));
        const [claimed] = await db.select().from(scheduledJobs)
          .where(eq(scheduledJobs.id, current.id)).limit(1);
        if (claimed?.status !== "running") return { recordsProcessed: 0, detail: "Job claim was lost." };

        try {
          const cardIds = cleanCardIds(JSON.parse(current.cardIds));
          const result = await executeAptlssGenerationBatch({
            jobId: current.id,
            cardIds,
            settings: parseSettings(current.settings),
            createdBy: current.createdBy,
          });
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
      failed += 1;
      console.error(`[APTLSS Scheduler] Job ${queued.id} failed`, error);
    }
  }
  return { found: due.length, processed, failed };
}

let processorTimer: ReturnType<typeof setInterval> | null = null;
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
  const initial = setTimeout(() => void tick(), 2_000);
  initial.unref?.();
  processorTimer = setInterval(() => void tick(), intervalMs);
  processorTimer.unref?.();
}

export function stopAptlssScheduledGenerationProcessor() {
  if (processorTimer) clearInterval(processorTimer);
  processorTimer = null;
}
