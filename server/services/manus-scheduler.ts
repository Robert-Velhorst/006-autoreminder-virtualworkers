import { getDb } from "../db";
import {
  dailyComplianceSnapshots,
  emailTasks,
  onHoldDailyChecks,
  replyThreads,
  timeEntries,
  users,
  vaProfiles,
} from "../../drizzle/schema.postgres";
import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import {
  getWorkerCards,
  getWorkerCommentedCardIdsToday,
  isDoingList,
  isOnHoldList,
} from "./trello-manus";
import { notifyOwner } from "../_core/notification";
import { parseDateKey } from "../utils/date-only";
import { dateKeyInTimeZone, dateWindowInTimeZone, dayOfWeekInTimeZone } from "../../shared/workerTime";
import { calculateScheduledTargetSeconds } from "../complianceMetrics";
import { resolveWorkerOperatorContextById } from "../workerOperatorContext";

let schedulerInterval: NodeJS.Timeout | null = null;

export function startManusScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);

  console.log("[ManusScheduler] Starting Manus background cron scheduler");
  schedulerInterval = setInterval(async () => {
    try {
      await runBackgroundTasks();
    } catch (error) {
      console.error("[ManusScheduler] Error in runBackgroundTasks:", error);
    }
  }, 60 * 1000);
}

export function stopManusScheduler() {
  if (!schedulerInterval) return;
  clearInterval(schedulerInterval);
  schedulerInterval = null;
  console.log("[ManusScheduler] Stopped Manus background cron scheduler");
}

async function runBackgroundTasks() {
  const db = await getDb();
  if (!db) return;

  const activeWorkers = await db.select()
    .from(vaProfiles)
    .where(eq(vaProfiles.status, "active"));

  for (const worker of activeWorkers) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: worker.timezone || "UTC",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(new Date());
      const currentHour = Number(parts.find(part => part.type === "hour")?.value ?? 0);
      const currentMinute = Number(parts.find(part => part.type === "minute")?.value ?? 0);

      if (currentHour === 0 && currentMinute === 0) {
        await runAutoStopForWorker(worker);
      }
      if (currentHour === 22 && currentMinute === 30) {
        await runComplianceSnapshotForWorker(worker);
      }
    } catch (error) {
      console.error(`[ManusScheduler] Error processing worker ${worker.id}:`, error);
    }
  }
}

async function runAutoStopForWorker(worker: typeof vaProfiles.$inferSelect) {
  console.log(`[ManusScheduler] Running auto-stop for worker ${worker.name}...`);
  const db = await getDb();
  if (!db) return;

  const maxSeconds = 12 * 3600;
  const now = new Date();
  const running = await db.select().from(timeEntries).where(
    and(eq(timeEntries.vaId, worker.userId), isNull(timeEntries.endTime)),
  );

  const stopped: Array<(typeof timeEntries.$inferSelect) & {
    durationSeconds: number;
    wasCapped: boolean;
  }> = [];
  for (const entry of running) {
    const rawSeconds = Math.round((now.getTime() - entry.startTime.getTime()) / 1000);
    const durationSeconds = Math.min(rawSeconds, maxSeconds);
    const durationMinutes = Math.round(durationSeconds / 60);
    const wasCapped = rawSeconds > maxSeconds;

    await db.update(timeEntries)
      .set({ endTime: now, durationSeconds, durationMinutes })
      .where(eq(timeEntries.id, entry.id));
    stopped.push({ ...entry, durationSeconds, wasCapped });
  }

  if (stopped.length === 0) return;
  const founder = await db.select().from(users).where(eq(users.id, worker.founderId)).limit(1);
  if (founder.length === 0) return;

  const lines = stopped.map(entry => {
    const hours = Math.floor(entry.durationSeconds / 3600);
    const minutes = Math.floor((entry.durationSeconds % 3600) / 60);
    const capped = entry.wasCapped ? " (capped at 12h)" : "";
    return `- ${entry.cardName || "Unknown Card"}: ${hours}h ${minutes}m${capped}`;
  });
  await notifyOwner({
    title: `Auto-stopped ${stopped.length} timer(s) for ${worker.name}`,
    content: [
      `The following timers for ${worker.name} were automatically stopped at midnight local time:`,
      "",
      ...lines,
      "",
      stopped.some(entry => entry.wasCapped)
        ? "Entries marked capped were running for more than 12 hours and should be reviewed."
        : "All durations are below the 12-hour safety cap.",
    ].join("\n"),
  });
}

async function runComplianceSnapshotForWorker(worker: typeof vaProfiles.$inferSelect) {
  if (dayOfWeekInTimeZone(new Date(), worker.timezone) === 0) return;
  try {
    await collectComplianceSnapshot(worker, "auto");
  } catch (error) {
    console.error(`[ManusScheduler] Error creating compliance snapshot for ${worker.name}:`, error);
  }
}

export async function collectComplianceSnapshot(
  worker: typeof vaProfiles.$inferSelect,
  source: "auto" | "manual",
) {
  const now = new Date();
  const dateKey = dateKeyInTimeZone(now, worker.timezone);
  console.log(`[ManusScheduler] Collecting compliance for ${worker.name} on ${dateKey}`);

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const apiKey = process.env.TRELLO_API_KEY;
  const apiToken = process.env.TRELLO_TOKEN;
  if (!apiKey || !apiToken) throw new Error("Trello API credentials not configured");

  const trelloMemberId = worker.trelloMemberId || "me";
  const window = dateWindowInTimeZone(dateKey, worker.timezone);
  const endInclusive = new Date(window.endExclusive.getTime() - 1);
  const [allCards, commentedCardIds, messages, emails, trackedEntries, operatorContext] = await Promise.all([
    getWorkerCards(apiKey, apiToken, trelloMemberId),
    getWorkerCommentedCardIdsToday(apiKey, apiToken, trelloMemberId, undefined, undefined, worker.timezone),
    db.select().from(replyThreads).where(and(
      eq(replyThreads.vaId, worker.userId),
      gte(replyThreads.lastNonWorkerMsgAt, window.start),
      lte(replyThreads.lastNonWorkerMsgAt, endInclusive),
    )),
    db.select().from(emailTasks).where(and(
      eq(emailTasks.vaId, worker.userId),
      gte(emailTasks.receivedAt, window.start),
      lte(emailTasks.receivedAt, endInclusive),
    )),
    db.select().from(timeEntries).where(and(
      eq(timeEntries.vaId, worker.userId),
      eq(timeEntries.isVoided, false),
      isNotNull(timeEntries.endTime),
      gte(timeEntries.startTime, window.start),
      lte(timeEntries.startTime, endInclusive),
    )),
    resolveWorkerOperatorContextById(worker.userId),
  ]);
  const doingCards = allCards.filter(card => card.list && isDoingList(card.list.name));
  const onHoldCards = allCards.filter(card => card.list && isOnHoldList(card.list.name));
  const doingUpdated = doingCards.filter(card => commentedCardIds.has(card.id));
  const doingMissed = doingCards.filter(card => !commentedCardIds.has(card.id));

  const snapshotDate = parseDateKey(dateKey);
  const checkedOnHold = await db.select().from(onHoldDailyChecks).where(and(
    eq(onHoldDailyChecks.vaId, worker.userId),
    eq(onHoldDailyChecks.date, snapshotDate),
    eq(onHoldDailyChecks.checked, true),
  ));
  const checkedOnHoldIds = new Set(checkedOnHold.map(check => check.cardId));
  const onHoldReviewed = onHoldCards.filter(card => checkedOnHoldIds.has(card.id)).length;
  const d1Instances = doingMissed.length;
  const messageReplied = messages.filter(message =>
    message.lastWorkerReplyAt && message.lastWorkerReplyAt >= message.lastNonWorkerMsgAt
  ).length;
  const messageNeedsClarification = messages.filter(message =>
    !message.lastWorkerReplyAt && !message.lastNonWorkerText?.trim()
  ).length;
  const messageMissed = Math.max(0, messages.length - messageReplied);
  const emailCompleted = emails.filter(email => email.status === "processed" || email.status === "archived").length;
  const emailNeedsClarification = emails.filter(email =>
    email.status === "pending" && !email.suggestedNextAction?.trim() && !email.llmSummary?.trim()
  ).length;
  const emailMissed = Math.max(0, emails.length - emailCompleted);
  const trackedSeconds = trackedEntries.reduce((total, entry) => total + (entry.durationSeconds ?? 0), 0);
  const scheduledTargetSeconds = calculateScheduledTargetSeconds(operatorContext, dateKey);
  const clarificationOpen = messageNeedsClarification + emailNeedsClarification;
  const evidenceCount = allCards.length + messages.length + emails.length + trackedEntries.length;

  const values = {
    vaId: worker.userId,
    founderId: worker.founderId,
    snapshotDate,
    onHoldTotal: onHoldCards.length,
    onHoldReviewed,
    onHoldMissedCards: JSON.stringify(
      onHoldCards
        .filter(card => !checkedOnHoldIds.has(card.id))
        .map(card => ({ id: card.id, name: card.name, url: card.url })),
    ),
    doingTotal: doingCards.length,
    doingUpdated: doingUpdated.length,
    doingMissedCards: JSON.stringify(
      doingMissed.map(card => ({ id: card.id, name: card.name, url: card.url })),
    ),
    messageTotal: messages.length,
    messageReplied,
    messageMissed,
    messageNeedsClarification,
    emailTotal: emails.length,
    emailCompleted,
    emailMissed,
    emailNeedsClarification,
    clarificationOpen,
    trackedSeconds,
    scheduledTargetSeconds,
    overtimeSeconds: Math.max(0, trackedSeconds - scheduledTargetSeconds),
    timeEntryCount: trackedEntries.length,
    d1Instances,
    estimatedPenalty: String(d1Instances * 5),
    source,
    verificationStatus: clarificationOpen > 0 ? "needs_clarification" : "verified",
    verificationMethod: "trello+reply_monitor+gmail+time_entries",
    verificationCutoffAt: now,
    verifiedAt: now,
    evidenceCount,
  };

  await db.insert(dailyComplianceSnapshots).values(values).onConflictDoUpdate({
    target: [dailyComplianceSnapshots.vaId, dailyComplianceSnapshots.snapshotDate],
    set: values,
  });
  const rows = await db.select().from(dailyComplianceSnapshots).where(and(
    eq(dailyComplianceSnapshots.vaId, worker.userId),
    eq(dailyComplianceSnapshots.snapshotDate, snapshotDate),
  )).limit(1);

  if (!rows[0]) throw new Error("Compliance snapshot was not persisted");
  return rows[0];
}
