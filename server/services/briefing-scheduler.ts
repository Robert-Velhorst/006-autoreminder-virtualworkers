import { getDb } from '../db';
import { taskAssignments, timeEntries, vaProfiles, users } from '../../drizzle/schema.postgres';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { sendMorningBriefing, sendEODReport } from './email';

let schedulerInterval: NodeJS.Timeout | null = null;

export function startBriefingScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  console.log('[Scheduler] Starting automated daily briefing and EOD report scheduler');

  // Run every minute to check if any worker needs their briefing/report sent
  schedulerInterval = setInterval(async () => {
    try {
      await checkAndSendReports();
    } catch (error) {
      console.error('[Scheduler] Error in checkAndSendReports:', error);
    }
  }, 60 * 1000);
}

export function stopBriefingScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped automated scheduler');
  }
}

async function checkAndSendReports() {
  const db = await getDb();
  if (!db) return;

  // We need current time in various timezones.
  // The simplest approach is to check each worker's profile, calculate their local time, and see if it matches their start/end hour.
  // However, we only have workStartHour and workEndHour right now.
  // We'll trigger morning briefing at `workStartHour : 00` (local time for the worker)
  // We'll trigger EOD report at `workEndHour : 00` (local time for the worker)

  const activeWorkers = await db.select()
    .from(vaProfiles)
    .where(eq(vaProfiles.status, 'active'));

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

      // Only run exactly on the hour/minute (minute === 0)
      if (currentMinute === 0) {
        // Find the founder
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

        if (currentHour === worker.workStartHour && worker.email) {
          console.log(`[Scheduler] Triggering Morning Briefing for ${worker.name} (${workerTimezone})`);
          await sendMorningBriefing(worker.email, {
            workerName: worker.name,
            date: reportDate,
            tasks,
            totalHours: tasks.reduce((sum, task) => sum + task.durationHours, 0),
            highPriorityCount: 0,
          }).catch(err => {
            console.error(`[Scheduler] Failed to send morning briefing for ${worker.name}:`, err);
          });
        }

        if (currentHour === worker.workEndHour && founder[0].email) {
          console.log(`[Scheduler] Triggering EOD Report for ${worker.name} (${workerTimezone})`);
          const dayStart = new Date();
          dayStart.setHours(0, 0, 0, 0);
          const entries = await db.select().from(timeEntries).where(and(
            eq(timeEntries.vaId, worker.userId),
            gte(timeEntries.startTime, dayStart),
            isNotNull(timeEntries.endTime),
          ));
          const totalHoursWorked = entries.reduce(
            (sum, entry) => sum + (entry.durationSeconds ?? 0) / 3600,
            0,
          );
          const completedTasks = assignments
            .filter(assignment => assignment.status === "completed")
            .map(assignment => tasks.find(task => task.cardName === assignment.taskId.split(":")[0])!);
          const incompleteTasks = assignments
            .filter(assignment => assignment.status === "assigned" || assignment.status === "in_progress")
            .map(assignment => tasks.find(task => task.cardName === assignment.taskId.split(":")[0])!);
          const blockedTasks = assignments
            .filter(assignment => assignment.status === "blocked")
            .map(assignment => tasks.find(task => task.cardName === assignment.taskId.split(":")[0])!);
          const completionRate = assignments.length === 0
            ? 0
            : Math.round((completedTasks.length / assignments.length) * 100);
          await sendEODReport(founder[0].email, {
            workerName: worker.name,
            date: reportDate,
            completedTasks,
            incompleteTasks,
            blockedTasks,
            totalHoursWorked,
            completionRate,
          }).catch(err => {
            console.error(`[Scheduler] Failed to send EOD report for ${worker.name}:`, err);
          });
        }
      }
    } catch (err) {
      console.error(`[Scheduler] Error processing worker ${worker.id}:`, err);
    }
  }
}
