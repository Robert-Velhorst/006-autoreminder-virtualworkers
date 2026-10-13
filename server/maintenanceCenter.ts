import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  maintenanceJobSettings,
  scheduledJobRuns,
  vaProfiles,
} from "../drizzle/schema";
import { getAllAptlssPlans } from "./aptlssDb";
import { upsertWeeklyAnalysis } from "./aptlssPoliciesDb";
import { getAllCardStates } from "./aptlssStepsDb";
import { getDb } from "./db";
import { syncWorkerGoogleEvidence } from "./googleEvidence";
import { runScheduledJob, type ScheduledJobContext, type ScheduledJobTransaction, type ScheduledJobTrigger } from "./scheduledJobRuntime";
import { syncWorkerTrelloCommitments } from "./sourceCommitments";
import { processDueAptlssGenerationJobs } from "./services/aptlss-scheduled-generation";
import { warmUpCache } from "./services/cache-warming";
import { collectComplianceSnapshot } from "./services/manus-scheduler";
import { getWebhookCallbackUrl, syncWebhooks } from "./services/webhook-auto-register";
import { syncWorkerTrelloReplyEvidence } from "./services/trello-reply-evidence";

export const MAINTENANCE_JOB_DEFINITIONS = [
  {
    key: "google_evidence",
    category: "Evidence sync",
    title: "Google evidence",
    description: "Checks each active worker's Gmail and Drive connection, then imports only configured read-only evidence that is due.",
    defaultEnabled: true,
    defaultIntervalMinutes: 5,
    minimumIntervalMinutes: 5,
    defaultEstimateMs: 120_000,
    externalEffect: "Reads Google data and updates local evidence. It does not send, archive, label, move, or delete provider data.",
  },
  {
    key: "trello_commitments",
    category: "Evidence sync",
    title: "Trello deadlines",
    description: "Reads assigned Trello cards and maintains durable local commitments and in-app reminder schedules for card deadlines.",
    defaultEnabled: true,
    defaultIntervalMinutes: 30,
    minimumIntervalMinutes: 15,
    defaultEstimateMs: 90_000,
    externalEffect: "Reads Trello and writes local reminder records. It does not post comments or move cards.",
  },
  {
    key: "communication_evidence",
    category: "Evidence sync",
    title: "Trello reply evidence",
    description: "Checks comments on each worker's assigned Trello cards and records pending, overdue, and answered conversations.",
    defaultEnabled: true,
    defaultIntervalMinutes: 15,
    minimumIntervalMinutes: 5,
    defaultEstimateMs: 90_000,
    externalEffect: "Reads Trello comments and updates local response evidence. It never posts or edits a Trello comment.",
  },
  {
    key: "eod_compliance",
    category: "Accountability",
    title: "Compliance evidence",
    description: "Fact-checks today's Trello updates, messages, processed email, tracked time, and overtime for every active worker.",
    defaultEnabled: true,
    defaultIntervalMinutes: 1_440,
    minimumIntervalMinutes: 60,
    defaultEstimateMs: 120_000,
    externalEffect: "Reads connected evidence and upserts the local daily compliance record. No provider data is changed.",
  },
  {
    key: "weekly_analysis",
    category: "Accountability",
    title: "Weekly APTLSS analysis",
    description: "Builds the missing weekly evidence snapshot from card states and plans, including stalled work, recurring blockers, and process improvements.",
    defaultEnabled: true,
    defaultIntervalMinutes: 10_080,
    minimumIntervalMinutes: 1_440,
    defaultEstimateMs: 30_000,
    externalEffect: "Uses local APTLSS evidence and writes a weekly analysis snapshot. It does not call an AI model or change Trello.",
  },
  {
    key: "aptlss_queue",
    category: "Planning",
    title: "Scheduled APTLSS queue",
    description: "Claims due APTLSS jobs created in the admin planner, generates validated plans, and records card-by-card results.",
    defaultEnabled: true,
    defaultIntervalMinutes: 1,
    minimumIntervalMinutes: 1,
    defaultEstimateMs: 300_000,
    externalEffect: "May create a Trello checklist only for an explicitly scheduled job whose validation gate passes.",
  },
  {
    key: "webhook_sync",
    category: "Integration health",
    title: "Trello webhook registry",
    description: "Reconciles registered Trello webhooks with the boards known to ATIS.",
    defaultEnabled: false,
    defaultIntervalMinutes: 60,
    minimumIntervalMinutes: 30,
    defaultEstimateMs: 60_000,
    externalEffect: "Creates missing and removes obsolete Trello webhooks. Disabled by default because this changes provider configuration.",
  },
  {
    key: "database_preload",
    category: "Performance",
    title: "Database buffer preload",
    description: "Reads frequently used tables so a larger dedicated database can warm its own buffer cache.",
    defaultEnabled: false,
    defaultIntervalMinutes: 60,
    minimumIntervalMinutes: 30,
    defaultEstimateMs: 20_000,
    externalEffect: "Local database reads only. Disabled by default on a small Windows host to avoid unnecessary idle work.",
  },
] as const;

export type MaintenanceJobKey = typeof MAINTENANCE_JOB_DEFINITIONS[number]["key"];

type ProgressState = {
  jobKey: MaintenanceJobKey;
  startedAt: string;
  current: number;
  total: number;
  message: string;
};

const activeRuns = new Map<MaintenanceJobKey, ProgressState>();
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerInitialTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerScanning = false;

function definitionFor(jobKey: string) {
  return MAINTENANCE_JOB_DEFINITIONS.find((definition) => definition.key === jobKey);
}

function clampInterval(jobKey: MaintenanceJobKey, intervalMinutes: number) {
  const definition = definitionFor(jobKey)!;
  return Math.min(43_200, Math.max(definition.minimumIntervalMinutes, Math.round(intervalMinutes)));
}

async function activeWorkers() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(vaProfiles).where(eq(vaProfiles.status, "active"));
}

function setProgress(jobKey: MaintenanceJobKey, current: number, total: number, message: string) {
  const existing = activeRuns.get(jobKey);
  if (!existing) return;
  activeRuns.set(jobKey, { ...existing, current, total, message });
}

function isoWeekKey(date = new Date()) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function generateWeeklyAnalysis(context: ScheduledJobContext) {
  await context.assertOwnership();
  const workers = await activeWorkers();
  let records = 0;
  for (const [index, worker] of workers.entries()) {
    await context.assertOwnership();
    setProgress("weekly_analysis", index, workers.length, `Analyzing ${worker.name}`);
    const [states, plans] = await Promise.all([
      getAllCardStates(worker.userId),
      getAllAptlssPlans(worker.userId),
    ]);
    const noProgressStates = new Set(["STALLED", "OVERDUE", "WAITING_FOR_WORKER", "WAITING_FOR_ROBERT", "WAITING_FOR_EXTERNAL_PARTY", "BLOCKED_BY_OTHER_CARD"]);
    const noProgressCards = states
      .filter((state) => noProgressStates.has(state.state))
      .map((state) => ({ cardId: state.cardId, cardName: state.cardName, state: state.state, reason: state.stateReason }));
    const blockerGroups = new Map<string, string[]>();
    for (const state of states.filter((item) => item.state.includes("WAITING") || item.state.includes("BLOCKED"))) {
      const reason = state.stateReason?.trim() || state.state;
      blockerGroups.set(reason, [...(blockerGroups.get(reason) ?? []), state.cardName]);
    }
    const recurringBlockers = [...blockerGroups.entries()]
      .filter(([, cards]) => cards.length >= 2)
      .map(([reason, cards]) => ({ reason, count: cards.length, cards }));
    const overdue = states.filter((state) => state.isOverdue).length;
    const stalled = states.filter((state) => state.state === "STALLED").length;
    const waiting = states.filter((state) => state.state.includes("WAITING") || state.state.includes("BLOCKED")).length;
    const improvements: string[] = [];
    if (overdue) improvements.push("Revalidate overdue dates and record one dated recovery action on every affected card.");
    if (stalled) improvements.push("Define a concrete completion criterion and first executable step for each stalled card.");
    if (waiting) improvements.push("Record the waiting owner, requested item, expected response date, and follow-up checkpoint.");
    if (plans.length < states.length) improvements.push("Generate or repair APTLSS plans for active cards that have state evidence but no current plan.");
    if (improvements.length === 0) improvements.push("No recurring process exception was detected; keep the current review cadence.");
    const weekKey = isoWeekKey();
    await context.assertOwnership();
    await upsertWeeklyAnalysis({
      vaId: worker.userId,
      weekKey,
      noProgressCards: JSON.stringify(noProgressCards),
      recurringBlockers: JSON.stringify(recurringBlockers),
      estimateDrift: JSON.stringify([]),
      underperformingWorkers: JSON.stringify([]),
      listHoppers: JSON.stringify([]),
      unclearScopeProjects: JSON.stringify([]),
      processImprovements: JSON.stringify(improvements),
      summary: `Week ${weekKey}: ${states.length} assessed cards, ${stalled} stalled, ${overdue} overdue, ${waiting} waiting or blocked, and ${improvements.length} process action(s).`,
    });
    records += 1;
    setProgress("weekly_analysis", index + 1, workers.length, `Saved ${worker.name}`);
  }
  return { recordsProcessed: records, detail: `Weekly analysis saved for ${records} active worker(s).` };
}

async function executeMaintenanceWork(jobKey: MaintenanceJobKey, trigger: ScheduledJobTrigger, context: ScheduledJobContext) {
  await context.assertOwnership();
  if (jobKey === "aptlss_queue") {
    setProgress(jobKey, 0, 1, "Checking due generation jobs");
    const result = await processDueAptlssGenerationJobs(new Date(), context);
    setProgress(jobKey, 1, 1, "Queue scan complete");
    return { recordsProcessed: result.processed, detail: JSON.stringify(result) };
  }
  if (jobKey === "database_preload") {
    setProgress(jobKey, 0, 1, "Preloading database buffers");
    const result = await warmUpCache();
    await context.assertOwnership();
    setProgress(jobKey, 1, 1, "Preload complete");
    return { recordsProcessed: result.totalCards + result.totalBoards, detail: JSON.stringify(result) };
  }
  if (jobKey === "webhook_sync") {
    if (!getWebhookCallbackUrl()) throw new Error("Trello webhook callback URL is not configured");
    setProgress(jobKey, 0, 1, "Reconciling Trello webhooks");
    const result = await syncWebhooks(context);
    if (result.errors > 0) throw new Error(`Webhook reconciliation reported ${result.errors} error(s)`);
    setProgress(jobKey, 1, 1, "Webhook registry is synchronized");
    return { recordsProcessed: result.registered + result.removed, detail: JSON.stringify(result) };
  }
  if (jobKey === "weekly_analysis") return generateWeeklyAnalysis(context);

  const workers = await activeWorkers();
  let recordsProcessed = 0;
  const details: unknown[] = [];
  for (const [index, worker] of workers.entries()) {
    await context.assertOwnership();
    setProgress(jobKey, index, workers.length, `Processing ${worker.name}`);
    if (jobKey === "google_evidence") {
      const result = await syncWorkerGoogleEvidence(worker.userId, { onlyDue: true, context });
      recordsProcessed += result.gmail.imported + result.drive.imported;
      details.push({ workerId: worker.userId, gmail: result.gmail.state, drive: result.drive.state, message: result.message });
    } else if (jobKey === "trello_commitments") {
      const result = await syncWorkerTrelloCommitments({
        userId: worker.userId,
        workspaceOwnerId: worker.founderId,
        trelloMemberId: worker.trelloMemberId,
        context,
      });
      recordsProcessed += result.scanned;
      details.push({ workerId: worker.userId, ...result });
    } else if (jobKey === "communication_evidence") {
      const result = await syncWorkerTrelloReplyEvidence({
        vaId: worker.userId,
        trelloMemberId: worker.trelloMemberId,
        context,
      });
      recordsProcessed += result.threads;
      details.push({ workerId: worker.userId, ...result });
    } else if (jobKey === "eod_compliance") {
      const result = await collectComplianceSnapshot(worker, trigger === "manual" ? "manual" : "auto", context);
      recordsProcessed += result ? 1 : 0;
      details.push({ workerId: worker.userId, recorded: Boolean(result) });
    }
    await context.assertOwnership();
    setProgress(jobKey, index + 1, workers.length, `Completed ${worker.name}`);
  }
  return { recordsProcessed, detail: JSON.stringify(details) };
}

function dueMaintenanceCondition(jobKey: MaintenanceJobKey) {
  return and(eq(maintenanceJobSettings.jobKey, jobKey), eq(maintenanceJobSettings.enabled, true),
    or(isNull(maintenanceJobSettings.lastScheduledAt),
      sql`TIMESTAMPADD(MINUTE, ${maintenanceJobSettings.intervalMinutes}, ${maintenanceJobSettings.lastScheduledAt}) <= CURRENT_TIMESTAMP`));
}

async function recordMaintenanceSchedule(jobKey: MaintenanceJobKey, context: ScheduledJobContext, tx: ScheduledJobTransaction) {
  await context.assertOwnership(tx);
  const definition = definitionFor(jobKey)!;
  await tx.insert(maintenanceJobSettings).values({ jobKey, enabled: definition.defaultEnabled,
    intervalMinutes: definition.defaultIntervalMinutes,
  }).onDuplicateKeyUpdate({ set: { jobKey } });
  const [due] = await tx.select({ jobKey: maintenanceJobSettings.jobKey }).from(maintenanceJobSettings)
    .where(dueMaintenanceCondition(jobKey)).limit(1).for("update");
  if (!due) return false;
  await context.assertOwnership(tx);
  await tx.update(maintenanceJobSettings).set({ lastScheduledAt: sql`CURRENT_TIMESTAMP` })
    .where(dueMaintenanceCondition(jobKey));
  await context.assertOwnership(tx);
  return true;
}

export async function runMaintenanceJob(jobKey: MaintenanceJobKey, trigger: ScheduledJobTrigger = "manual") {
  if (activeRuns.has(jobKey)) return { state: "skipped" as const, reason: "already_running" as const };
  activeRuns.set(jobKey, { jobKey, startedAt: new Date().toISOString(), current: 0, total: 1, message: "Starting" });
  try {
    return await runScheduledJob({
      jobKey: `maintenance:${jobKey}`,
      trigger,
      leaseMs: 60 * 60_000,
      skipIfSuccessful: false,
      shouldRun: trigger === "cron" ? (context, tx) => recordMaintenanceSchedule(jobKey, context, tx) : undefined,
    }, context => executeMaintenanceWork(jobKey, trigger, context));
  } finally {
    activeRuns.delete(jobKey);
  }
}

export async function updateMaintenanceSetting(jobKey: MaintenanceJobKey, enabled: boolean, intervalMinutes: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const interval = clampInterval(jobKey, intervalMinutes);
  await db.insert(maintenanceJobSettings).values({ jobKey, enabled, intervalMinutes: interval })
    .onDuplicateKeyUpdate({ set: { enabled, intervalMinutes: interval, updatedAt: new Date() } });
  return { jobKey, enabled, intervalMinutes: interval };
}

export async function getMaintenanceCenterStatus() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const keys = MAINTENANCE_JOB_DEFINITIONS.map((definition) => definition.key);
  const runKeys = keys.map((key) => `maintenance:${key}`);
  const [settings, history] = await Promise.all([
    db.select().from(maintenanceJobSettings).where(inArray(maintenanceJobSettings.jobKey, keys)),
    db.select().from(scheduledJobRuns)
      .where(inArray(scheduledJobRuns.jobKey, runKeys))
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(200),
  ]);
  const settingMap = new Map(settings.map((setting) => [setting.jobKey, setting]));
  const now = Date.now();
  return MAINTENANCE_JOB_DEFINITIONS.map((definition) => {
    const setting = settingMap.get(definition.key);
    const runs = history.filter((run) => run.jobKey === `maintenance:${definition.key}`);
    const latest = runs[0] ?? null;
    const successfulDurations = runs
      .filter((run) => run.status === "success" && typeof run.durationMs === "number")
      .slice(0, 10)
      .map((run) => run.durationMs!);
    const estimatedDurationMs = successfulDurations.length
      ? Math.round(successfulDurations.reduce((total, duration) => total + duration, 0) / successfulDurations.length)
      : null;
    const enabled = setting?.enabled ?? definition.defaultEnabled;
    const intervalMinutes = setting?.intervalMinutes ?? definition.defaultIntervalMinutes;
    const baseline = setting?.lastScheduledAt ?? latest?.startedAt ?? null;
    const nextRunAt = enabled
      ? new Date(baseline ? baseline.getTime() + intervalMinutes * 60_000 : now).toISOString()
      : null;
    return {
      ...definition,
      enabled,
      intervalMinutes,
      nextRunAt,
      estimatedDurationMs,
      active: activeRuns.get(definition.key) ?? null,
      latest: latest ? {
        id: latest.id,
        status: latest.status,
        trigger: latest.trigger,
        startedAt: latest.startedAt.toISOString(),
        finishedAt: latest.finishedAt?.toISOString() ?? null,
        durationMs: latest.durationMs,
        recordsProcessed: latest.recordsProcessed,
        detail: latest.detail,
        errorMessage: latest.errorMessage,
      } : null,
    };
  });
}

async function scanScheduledMaintenance() {
  if (schedulerScanning) return;
  schedulerScanning = true;
  try {
    const db = await getDb();
    if (!db) return;
    const status = await getMaintenanceCenterStatus();
    const now = new Date();
    for (const job of status) {
      if (!job.enabled || job.active || !job.nextRunAt || new Date(job.nextRunAt) > now) continue;
      await runMaintenanceJob(job.key, "cron").catch((error) => {
        console.error(`[MaintenanceCenter] ${job.key} failed; retained history requires review`);
      });
    }
  } catch {
    console.error("[MaintenanceCenter] Scheduled scan unavailable; will retry at the next interval");
  } finally {
    schedulerScanning = false;
  }
}

export function startMaintenanceCenter() {
  if (schedulerTimer) return;
  schedulerInitialTimer = setTimeout(() => {
    schedulerInitialTimer = null;
    void scanScheduledMaintenance();
  }, 5_000);
  schedulerInitialTimer.unref?.();
  schedulerTimer = setInterval(() => void scanScheduledMaintenance(), 60_000);
  schedulerTimer.unref?.();
}

export function stopMaintenanceCenter() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (schedulerInitialTimer) clearTimeout(schedulerInitialTimer);
  schedulerTimer = null;
  schedulerInitialTimer = null;
}
