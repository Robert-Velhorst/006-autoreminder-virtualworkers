import { Router, type Request } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { taskAssignments, vaProfiles, timeEntries } from '../../drizzle/schema';
import { requireAuthenticated, requestUser } from '../middleware/auth';
import { attributeTimeEntriesToProfiles, loadAccountTimeEntries } from '../timeEntryOwnership';

const router = Router();
router.use(requireAuthenticated);

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function getScopedOperationalData(req: Request, db: Database) {
  const user = requestUser(req)!;
  const profiles = user.role === 'admin'
    ? await db.select().from(vaProfiles)
    : user.role === 'worker'
      ? await db.select().from(vaProfiles).where(eq(vaProfiles.userId, user.id))
      : await db.select().from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
  const profileIds = profiles.map(profile => profile.id);
  const tasks = user.role === 'admin'
    ? await db.select().from(taskAssignments)
    : profileIds.length > 0
      ? await db.select().from(taskAssignments).where(inArray(taskAssignments.vaId, profileIds))
      : [];
  const times = await loadAccountTimeEntries(db, user);

  return { profiles, tasks, times };
}

function trackedMinutes(entry: typeof timeEntries.$inferSelect) {
  if (entry.isVoided) return 0;
  if (entry.durationMinutes != null) return Math.max(0, entry.durationMinutes);
  if (entry.durationSeconds != null) return Math.max(0, entry.durationSeconds / 60);
  if (entry.endTime) return Math.max(0, (entry.endTime.getTime() - entry.startTime.getTime()) / 60_000);
  return 0;
}

function scheduledMinutes(profile: typeof vaProfiles.$inferSelect, start: Date, dayCount: number) {
  const workingDays = new Set(profile.workingDays.split(',').map(Number).filter(Number.isInteger));
  let total = 0;
  for (let index = 0; index < dayCount; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    if (!workingDays.has(day.getDay())) continue;

    const gross = Math.max(0, profile.workEndHour - profile.workStartHour) * 60;
    const breaks = [
      [profile.breakfastTime, profile.breakfastDuration],
      [profile.lunchTime, profile.lunchDuration],
      [profile.dinnerTime, profile.dinnerDuration],
    ].reduce((sum, [hour, duration]) => {
      const isInsideShift = hour != null && hour >= profile.workStartHour && hour < profile.workEndHour;
      return sum + (isInsideShift ? Math.max(0, duration ?? 0) : 0);
    }, 0);
    total += Math.max(0, gross - breaks);
  }
  return total;
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

router.get('/worker-productivity', async (req, res) => {
  const db = await getDb();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const { profiles, tasks, times } = await getScopedOperationalData(req, db);
    const attribution = attributeTimeEntriesToProfiles(profiles, times);
    const productivity = profiles.map(profile => {
      const workerTasks = tasks.filter(task => task.vaId === profile.id);
      const completed = workerTasks.filter(task => task.status === 'completed').length;
      const actualMinutes = (attribution.entriesByProfileId.get(profile.id) ?? [])
        .reduce((sum, entry) => sum + trackedMinutes(entry), 0);

      return {
        workerId: profile.id,
        workerName: profile.name,
        totalAssigned: workerTasks.length,
        completed,
        actualMinutes: Math.round(actualMinutes),
        completionRate: workerTasks.length > 0 ? Math.round((completed / workerTasks.length) * 1000) / 10 : null,
        completedPerTrackedHour: actualMinutes > 0 ? Math.round((completed * 60 / actualMinutes) * 100) / 100 : null,
      };
    });

    const unattributedMinutes = attribution.unattributed.reduce((sum, entry) => sum + trackedMinutes(entry), 0);
    res.json({ success: true, productivity,
      unattributedTimeEntries: { count: attribution.unattributed.length, minutes: Math.round(unattributedMinutes) },
      source: 'task_assignments+time_entries' });
  } catch (error) {
    console.error('[Analytics] Failed to get productivity data', error);
    res.status(500).json({ error: 'Failed to get productivity data' });
  }
});

router.get('/team-capacity', async (req, res) => {
  const db = await getDb();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const { profiles, times } = await getScopedOperationalData(req, db);
    const attribution = attributeTimeEntriesToProfiles(profiles, times);
    const attributedTimes = [...attribution.entriesByProfileId.values()].flat();
    const periodStart = startOfDay(new Date());
    periodStart.setDate(periodStart.getDate() - 6);
    const periodEnd = new Date();
    const workers = profiles.map(profile => {
      const expectedMinutes = scheduledMinutes(profile, periodStart, 7);
      const actualMinutes = (attribution.entriesByProfileId.get(profile.id) ?? [])
        .filter(entry => entry.startTime >= periodStart && entry.startTime <= periodEnd)
        .reduce((sum, entry) => sum + trackedMinutes(entry), 0);
      return {
        workerId: profile.id,
        workerName: profile.name,
        expectedMinutes,
        trackedMinutes: Math.round(actualMinutes),
        utilization: expectedMinutes > 0 ? Math.round((actualMinutes / expectedMinutes) * 1000) / 10 : null,
        overtimeMinutes: Math.max(0, Math.round(actualMinutes - expectedMinutes)),
      };
    });
    const expectedMinutes = workers.reduce((sum, worker) => sum + worker.expectedMinutes, 0);
    const actualMinutes = attributedTimes
      .filter(entry => entry.startTime >= periodStart && entry.startTime <= periodEnd)
      .reduce((sum, entry) => sum + trackedMinutes(entry), 0);
    const unattributedMinutes = attribution.unattributed
      .filter(entry => entry.startTime >= periodStart && entry.startTime <= periodEnd)
      .reduce((sum, entry) => sum + trackedMinutes(entry), 0);

    res.json({
      success: true,
      period: { start: periodStart.toISOString(), end: periodEnd.toISOString(), days: 7 },
      utilization: expectedMinutes > 0 ? Math.round((actualMinutes / expectedMinutes) * 1000) / 10 : null,
      expectedMinutes,
      trackedMinutes: actualMinutes,
      overtimeMinutes: Math.max(0, actualMinutes - expectedMinutes),
      unattributedTimeEntries: {
        count: attribution.unattributed.filter(entry => entry.startTime >= periodStart && entry.startTime <= periodEnd).length,
        minutes: Math.round(unattributedMinutes),
      },
      workers,
      source: 'worker_schedules+time_entries',
    });
  } catch (error) {
    console.error('[Analytics] Failed to get team capacity', error);
    res.status(500).json({ error: 'Failed to get team capacity' });
  }
});

router.get('/trends', async (req, res) => {
  const db = await getDb();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const { profiles, tasks, times } = await getScopedOperationalData(req, db);
    const attribution = attributeTimeEntriesToProfiles(profiles, times);
    const attributedTimes = [...attribution.entriesByProfileId.values()].flat();
    const periodStart = startOfDay(new Date());
    periodStart.setDate(periodStart.getDate() - 13);
    const trends = Array.from({ length: 14 }, (_, index) => {
      const dayStart = new Date(periodStart);
      dayStart.setDate(periodStart.getDate() + index);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return {
        date: dayStart.toISOString().slice(0, 10),
        trackedMinutes: Math.round(attributedTimes
          .filter(entry => entry.startTime >= dayStart && entry.startTime < dayEnd)
          .reduce((sum, entry) => sum + trackedMinutes(entry), 0)),
        unattributedTimeEntries: {
          count: attribution.unattributed.filter(entry => entry.startTime >= dayStart && entry.startTime < dayEnd).length,
          minutes: Math.round(attribution.unattributed
            .filter(entry => entry.startTime >= dayStart && entry.startTime < dayEnd)
            .reduce((sum, entry) => sum + trackedMinutes(entry), 0)),
        },
        completedTasks: tasks.filter(task =>
          task.status === 'completed' && task.updatedAt >= dayStart && task.updatedAt < dayEnd
        ).length,
      };
    });

    res.json({ success: true, periodDays: 14, trends, source: 'task_assignments+time_entries' });
  } catch (error) {
    console.error('[Analytics] Failed to get trends', error);
    res.status(500).json({ error: 'Failed to get trends' });
  }
});

export default router;
