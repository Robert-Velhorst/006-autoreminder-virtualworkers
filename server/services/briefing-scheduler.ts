import { getDb } from '../db';
import { taskAssignments, timeEntries, vaProfiles, users } from '../../drizzle/schema.postgres';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { sendMorningBriefing, sendEODReport } from './email';
import { dateKeyInTimeZone, dateWindowInTimeZone } from '../../shared/workerTime';
import { runScheduledJob, ScheduledJobLeaseLostError } from '../scheduledJobRuntime';
import { getBriefingSettings, shouldRunBriefingAt, type BriefingSettings } from '../briefingSettings';
import { createNonOverlappingRunner } from './non-overlapping-runner';

let schedulerInterval: NodeJS.Timeout | null = null;

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

      const parts = formatter.formatToParts(new Date());
      const currentHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
      const currentMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

      let settings = founderSettings.get(worker.founderId);
      if (!settings) {
        settings = await getBriefingSettings(worker.founderId);
        founderSettings.set(worker.founderId, settings);
      }
      const shouldSendMorning = settings.morningBriefingEnabled
        && shouldRunBriefingAt(settings.morningBriefingTime, currentHour, currentMinute)
        && Boolean(worker.email);
      const shouldSendEod = settings.eodReportEnabled
        && shouldRunBriefingAt(settings.eodReportTime, currentHour, currentMinute);
      if (!shouldSendMorning && !shouldSendEod) continue;

      // Only load detailed worker state when a delivery is due.
      const founder = await db.select().from(users).where(eq(users.id, worker.founderId)).limit(1);
      if (!founder || founder.length === 0) continue;

      const assignments = await db.select().from(taskAssignments).where(and(
        eq(taskAssignments.vaId, worker.id),
        eq(taskAssignments.founderId, worker.founderId),
      ));
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
      }).format(new Date());
      const dateKey = dateKeyInTimeZone(new Date(), workerTimezone);

      if (shouldSendMorning) {
        await runScheduledJob({ jobKey: `briefing:${worker.userId}:${dateKey}` }, async context => {
          await context.assertOwnership();
          console.log(`[Scheduler] Triggering Morning Briefing for ${worker.name} (${workerTimezone})`);
          const delivered = await sendMorningBriefing(worker.email!, {
            workerName: worker.name,
            date: reportDate,
            tasks,
            totalHours: tasks.reduce((sum, task) => sum + task.durationHours, 0),
            highPriorityCount: 0,
          }, context);
          if (!delivered) throw new Error("Morning briefing provider did not confirm delivery");
          return { recordsProcessed: tasks.length, detail: `Delivered to worker for ${dateKey}` };
        });
      }

      if (shouldSendEod && founder[0].email) {
        await runScheduledJob({ jobKey: `eod-report:${worker.userId}:${dateKey}` }, async context => {
          console.log(`[Scheduler] Triggering EOD Report for ${worker.name} (${workerTimezone})`);
          const window = dateWindowInTimeZone(dateKey, workerTimezone);
          const entries = await db.select().from(timeEntries).where(and(
            eq(timeEntries.vaId, worker.userId),
            gte(timeEntries.startTime, window.start),
            isNotNull(timeEntries.endTime),
          ));
          const totalHoursWorked = entries.reduce(
            (sum, entry) => sum + (entry.durationSeconds ?? 0) / 3600,
            0,
          );
          const tasksFor = (statuses: Array<typeof assignments[number]["status"]>) => assignments
            .filter(assignment => statuses.includes(assignment.status))
            .map(assignment => tasks.find(task => task.cardName === assignment.taskId.split(":")[0]))
            .filter((task): task is NonNullable<typeof task> => Boolean(task));
          const completedTasks = tasksFor(["completed"]);
          const incompleteTasks = tasksFor(["assigned", "in_progress"]);
          const blockedTasks = tasksFor(["blocked"]);
          const completionRate = assignments.length === 0
            ? 0
            : Math.round((completedTasks.length / assignments.length) * 100);
          await context.assertOwnership();
          const delivered = await sendEODReport(founder[0].email!, {
            workerName: worker.name,
            date: reportDate,
            completedTasks,
            incompleteTasks,
            blockedTasks,
            totalHoursWorked,
            completionRate,
          }, context);
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
