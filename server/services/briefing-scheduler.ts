import { recordedSeconds } from '../../shared/timerDuration';
import { timeCompleteness } from '../canonicalTimer';
import { getDb } from '../db';
import { taskAssignments, timeEntries, vaProfiles, users } from '../../drizzle/schema.postgres';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { sendMorningBriefing, sendEODReport } from './email';
import { dateKeyInTimeZone, dateWindowInTimeZone } from '../../shared/workerTime';
import { runScheduledJob, ScheduledJobLeaseLostError } from '../scheduledJobRuntime';
import { getBriefingSettings, shouldRunBriefingAt, type BriefingSettings } from '../briefingSettings';
import { createNonOverlappingRunner } from './non-overlapping-runner';
import { getConsentingRecipientEmail } from './recipientEmailConsent';
import { resolveWorkerOperatorContextById } from '../workerOperatorContext';
import { areNotificationsEnabled } from './notificationPolicy';
import { AssignmentError, assertCanonicalAssignmentRows, MAX_ASSIGNMENT_TASKS, readCanonicalAssignments } from '../taskAssignmentMutation';

let schedulerInterval: NodeJS.Timeout | null = null;

// Catch up within this local day only; the durable daily job key still owns
// duplicate suppression and the lease still owns dispatch authorization.
const BRIEFING_DUE_WINDOW_MINUTES = 15;
function isBriefingDue(time: string, hour: number, minute: number) {
  const currentMinute = hour * 60 + minute;
  for (let late = 0; late < BRIEFING_DUE_WINDOW_MINUTES && late <= currentMinute; late++) {
    const candidate = currentMinute - late;
    if (shouldRunBriefingAt(time, Math.floor(candidate / 60), candidate % 60)) return true;
  }
  return false;
}

export function startBriefingScheduler() {
  if (process.env.BRIEFING_SCHEDULER_ENABLED !== 'true') {
    console.log('[Scheduler] Automated email briefings disabled; set BRIEFING_SCHEDULER_ENABLED=true to enable');
    return;
  }
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  console.log('[Scheduler] Starting automated daily briefing and EOD report scheduler');

  const run = createNonOverlappingRunner(async () => {
    try {
      await processScheduledBriefings();
    } catch (error) {
      console.error('[Scheduler] Error in checkAndSendReports:', error);
    }
  });

  // Run every minute to check if any worker needs their briefing/report sent.
  schedulerInterval = setInterval(() => {
    void run();
  }, 60 * 1000);
  schedulerInterval.unref?.();
  void run();
}

export function stopBriefingScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped automated scheduler');
  }
}

export async function processScheduledBriefings() {
  const sweepTime = new Date();
  const db = await getDb();
  if (!db) return;

  // Each founder controls the local delivery time for their workers. The
  // per-day durable job key below prevents duplicate sends after a restart.

  const activeWorkers = await db.select()
    .from(vaProfiles)
    .where(eq(vaProfiles.status, 'active'));
  const founderSettings = new Map<number, BriefingSettings>();

  for (const worker of activeWorkers) {
    try {
      // Get worker's current local time
      const workerTimezone = worker.timezone || 'UTC';
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: workerTimezone,
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23', // 0-23
      });

      const parts = formatter.formatToParts(sweepTime);
      const currentHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
      const currentMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

      let settings = founderSettings.get(worker.founderId);
      if (!settings) {
        settings = await getBriefingSettings(worker.founderId);
        founderSettings.set(worker.founderId, settings);
      }
      const morningAddress = settings.morningBriefingEnabled
        && isBriefingDue(settings.morningBriefingTime, currentHour, currentMinute)
        ? await getConsentingRecipientEmail(worker.userId, 'daily_digest') : null;
      const eodAddress = settings.eodReportEnabled
        && isBriefingDue(settings.eodReportTime, currentHour, currentMinute)
        ? await getConsentingRecipientEmail(worker.founderId, 'daily_digest') : null;
      const shouldSendMorning = morningAddress !== null;
      const shouldSendEod = eodAddress !== null;
      if (!shouldSendMorning && !shouldSendEod) continue;

      // Only load detailed worker state when a delivery is due.
      const founder = await db.select().from(users).where(eq(users.id, worker.founderId)).limit(1);
      if (!founder || founder.length === 0) continue;

      // Validate full founder/task identities before trusting worker/status filters.
      const founderAssignments = await db.select().from(taskAssignments)
        .where(eq(taskAssignments.founderId, worker.founderId));
      assertCanonicalAssignmentRows(founderAssignments);
      const keys = [...new Set(founderAssignments.map(row => row.taskId))].sort();
      const canonicalAssignments: typeof founderAssignments = [];
      for (let offset = 0; offset < keys.length; offset += MAX_ASSIGNMENT_TASKS) {
        canonicalAssignments.push(...await readCanonicalAssignments(db, worker.founderId,
          keys.slice(offset, offset + MAX_ASSIGNMENT_TASKS)));
      }
      if (canonicalAssignments.length !== founderAssignments.length) {
        throw new AssignmentError(409, 'Assignments changed; reload before trying again');
      }
      const assignments = canonicalAssignments.filter(row => row.vaId === worker.id);
      const tasks = assignments.map(assignment => {
        const startTime = assignment.startTime?.toISOString();
        const endTime = assignment.endTime?.toISOString();
        const durationHours = assignment.startTime && assignment.endTime
          ? Math.max(0, (assignment.endTime.getTime() - assignment.startTime.getTime()) / 3_600_000)
          : 1;
        return {
          title: assignment.notes || `Task ${assignment.taskId.split(":").pop()}`,
          cardName: assignment.taskId.split(":")[0] || "Project",
          startTime,
          endTime,
          durationHours,
          priority: "normal",
        };
      });
      const reportDate = new Intl.DateTimeFormat("en-US", {
        timeZone: workerTimezone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(sweepTime);
      const dateKey = dateKeyInTimeZone(sweepTime, workerTimezone);
      const beforeDispatch = (recipientId: number, expectedAddress: string) => async () => {
        try {
          if (!areNotificationsEnabled()) return false;
          const currentWorker = await resolveWorkerOperatorContextById(worker.userId);
          if (currentWorker.profileId !== worker.id || currentWorker.founderId !== worker.founderId) return false;
          // Provider readiness may have awaited I/O since the payload was built.
          const payloadKeys = assignments.map(row => row.taskId);
          for (let offset = 0; offset < payloadKeys.length; offset += MAX_ASSIGNMENT_TASKS) {
            const batch = payloadKeys.slice(offset, offset + MAX_ASSIGNMENT_TASKS);
            const current = await readCanonicalAssignments(db, worker.founderId, batch);
            if (current.length !== batch.length
              || current.some(row => row.vaId !== worker.id)) return false;
          }
          const currentAddress = await getConsentingRecipientEmail(recipientId, 'daily_digest');
          return areNotificationsEnabled() && currentAddress === expectedAddress;
        } catch { return false; }
      };

      if (shouldSendMorning) {
        await runScheduledJob({ jobKey: `briefing:${worker.userId}:${dateKey}` }, async context => {
          await context.assertOwnership();
          if (await getConsentingRecipientEmail(worker.userId, 'daily_digest') !== morningAddress) throw new Error("Morning briefing recipient consent or address changed");
          console.log(`[Scheduler] Triggering Morning Briefing for ${worker.name} (${workerTimezone})`);
          const delivered = await sendMorningBriefing(morningAddress!, {
            workerName: worker.name,
            date: reportDate,
            tasks,
            totalHours: tasks.reduce((sum, task) => sum + task.durationHours, 0),
            highPriorityCount: 0,
          }, context, beforeDispatch(worker.userId, morningAddress!));
          if (!delivered) throw new Error("Morning briefing provider did not confirm delivery");
          return { recordsProcessed: tasks.length, detail: `Delivered to worker for ${dateKey}` };
        });
      }

      if (shouldSendEod) {
        await runScheduledJob({ jobKey: `eod-report:${worker.userId}:${dateKey}` }, async context => {
          console.log(`[Scheduler] Triggering EOD Report for ${worker.name} (${workerTimezone})`);
          const window = dateWindowInTimeZone(dateKey, workerTimezone);
          const entries = await db.select().from(timeEntries).where(and(
            eq(timeEntries.trackedUserId, worker.userId), eq(timeEntries.isVoided, false), eq(timeEntries.founderId, worker.founderId),
            gte(timeEntries.startTime, window.start),
            isNotNull(timeEntries.endTime),
          ));
          if (!(await timeCompleteness(db, worker.founderId)).complete) throw new Error('Historical time requires ownership review; no complete EOD total can be sent');
          const totalHoursWorked = entries.reduce(
            (sum, entry) => sum + recordedSeconds(entry) / 3600,
            0,
          );
          const tasksFor = (statuses: Array<typeof assignments[number]["status"]>) => tasks
            .filter((_task, index) => statuses.includes(assignments[index].status));
          const completedTasks = tasksFor(["completed"]);
          const incompleteTasks = tasksFor(["assigned", "in_progress"]);
          const blockedTasks = tasksFor(["blocked"]);
          const completionRate = assignments.length === 0
            ? 0
            : Math.round((completedTasks.length / assignments.length) * 100);
          await context.assertOwnership();
          if (await getConsentingRecipientEmail(worker.founderId, 'daily_digest') !== eodAddress) throw new Error("EOD report recipient consent or address changed");
          const delivered = await sendEODReport(eodAddress!, {
            workerName: worker.name,
            date: reportDate,
            completedTasks,
            incompleteTasks,
            blockedTasks,
            totalHoursWorked,
            completionRate,
          }, context, beforeDispatch(worker.founderId, eodAddress!));
          if (!delivered) throw new Error("EOD report provider did not confirm delivery");
          return { recordsProcessed: entries.length + assignments.length, detail: `Delivered to owner for ${dateKey}` };
        });
      }
    } catch (err) {
      if (err instanceof ScheduledJobLeaseLostError) throw err;
      console.error(`[Scheduler] Error processing worker ${worker.id}:`, err);
    }
  }
}
