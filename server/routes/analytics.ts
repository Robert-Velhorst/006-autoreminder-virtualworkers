import { timeCompleteness } from '../canonicalTimer';
import { recordedMinutes } from '../../shared/timerDuration';
import { Router, type Request } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { taskAssignments, vaProfiles, timeEntries } from '../../drizzle/schema.postgres';
import { requireActiveWorkerProfile, requireAuthenticated, requestUser } from '../middleware/auth';
import { attributeTimeEntriesToProfiles, loadAccountTimeEntries } from '../timeEntryOwnership';
import { resolveWorkerOperatorContext, selectWorkerProfile, type WorkerOperatorContext } from '../workerOperatorContext';
import { calculateScheduledTargetSeconds } from '../complianceMetrics';
import { addDaysToDateKey, dateKeyInTimeZone, dateWindowInTimeZone } from '../../shared/workerTime';

const router = Router();
router.use(requireAuthenticated);
const supportedAnalyticsRoles = new Set(['admin', 'user', 'worker']);
router.use((req, res, next) => {
  const user = requestUser(req);
  if (!user || !supportedAnalyticsRoles.has(String(user.role))) {
    res.status(user ? 403 : 401).json({ error: user ? 'Forbidden' : 'Unauthorized' });
    return;
  }
  next();
});
router.use(requireActiveWorkerProfile);

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function getScopedOperationalData(req: Request, db: Database) {
  const user = requestUser(req)!;
  const allProfiles = user.role === 'admin'
    ? await db.select().from(vaProfiles)
    : user.role === 'worker'
      ? await db.select().from(vaProfiles).where(eq(vaProfiles.userId, user.id))
      : await db.select().from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
  const activeProfile = user.role === 'worker' ? selectWorkerProfile(allProfiles) : null;
  const profiles = user.role === 'worker'
    ? activeProfile ? [activeProfile] : []
    : allProfiles;
  const profileIds = profiles.map(profile => profile.id);
  const taskFounderId = user.role === 'worker' ? activeProfile?.founderId : user.id;
  const tasks = user.role === 'admin'
    ? await db.select().from(taskAssignments)
    : profileIds.length > 0 && taskFounderId != null
      ? await db.select().from(taskAssignments).where(and(
        inArray(taskAssignments.vaId, profileIds),
        eq(taskAssignments.founderId, taskFounderId),
      ))
      : [];
  const founderProfiles = user.role === 'worker' && activeProfile
    ? await db.select({ id: vaProfiles.id, userId: vaProfiles.userId, founderId: vaProfiles.founderId })
      .from(vaProfiles)
      .where(eq(vaProfiles.founderId, activeProfile.founderId))
    : profiles;
  const attributionProfiles = user.role === 'worker' && activeProfile
    ? [
      ...founderProfiles.filter(profile => profile.userId !== user.id),
      { id: activeProfile.id, userId: activeProfile.userId, founderId: activeProfile.founderId },
    ]
    : profiles;
  const times = await loadAccountTimeEntries(db, user);

  const completeness = await timeCompleteness(db, user.role === 'admin' ? undefined : activeProfile?.founderId ?? user.id);
  return { profiles, attributionProfiles, tasks, times, completeness };
}

const trackedMinutes = recordedMinutes;

function scheduledMinutes(schedule: WorkerOperatorContext, startDateKey: string, dayCount: number) {
  let total = 0;
  for (let index = 0; index < dayCount; index += 1) {
    total += calculateScheduledTargetSeconds(schedule, addDaysToDateKey(startDateKey, index)) / 60;
  }
  return total;
}

router.get('/worker-productivity', async (req, res) => {
  const db = await getDb();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const user = requestUser(req)!;
    const { profiles, attributionProfiles, tasks, times, completeness } = await getScopedOperationalData(req, db);
    const attribution = attributeTimeEntriesToProfiles(attributionProfiles, times);
    if (attribution.unattributed.length) { completeness.complete = false; completeness.unresolvedEntryCount += attribution.unattributed.filter(entry => entry.trackedUserId !== null).length; }
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
    res.json({ ...completeness, success: true, productivity,
      ...(user.role === 'worker' ? {} : {
        unattributedTimeEntries: { count: attribution.unattributed.length, minutes: Math.round(unattributedMinutes) },
      }),
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
    const user = requestUser(req)!;
    const { profiles, attributionProfiles, times, completeness } = await getScopedOperationalData(req, db);
    const attribution = attributeTimeEntriesToProfiles(attributionProfiles, times);
    if (attribution.unattributed.length) { completeness.complete = false; completeness.unresolvedEntryCount += attribution.unattributed.filter(entry => entry.trackedUserId !== null).length; }
    const attributedTimes = profiles.flatMap(profile => attribution.entriesByProfileId.get(profile.id) ?? []);
    const periodEnd = new Date();
    const { timezone } = await resolveWorkerOperatorContext(user, db);
    const endDateKey = dateKeyInTimeZone(periodEnd, timezone);
    const startDateKey = addDaysToDateKey(endDateKey, -6);
    const periodStart = dateWindowInTimeZone(startDateKey, timezone).start;
    const workers = await Promise.all(profiles.map(async profile => {
      // Profiles are already caller-scoped; resolve each account's effective
      // schedule rather than reusing the viewer's or a retired profile's hours.
      const schedule = await resolveWorkerOperatorContext({ ...user, id: profile.userId, name: profile.name }, db);
      const expectedMinutes = schedule.profileId === profile.id && schedule.founderId === profile.founderId
        ? scheduledMinutes(schedule, startDateKey, 7) : 0;
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
    }));
    const expectedMinutes = workers.reduce((sum, worker) => sum + worker.expectedMinutes, 0);
    const actualMinutes = attributedTimes
      .filter(entry => entry.startTime >= periodStart && entry.startTime <= periodEnd)
      .reduce((sum, entry) => sum + trackedMinutes(entry), 0);
    const unattributedMinutes = attribution.unattributed
      .filter(entry => entry.startTime >= periodStart && entry.startTime <= periodEnd)
      .reduce((sum, entry) => sum + trackedMinutes(entry), 0);

    res.json({
      ...completeness,
      success: true,
      period: { start: periodStart.toISOString(), end: periodEnd.toISOString(), days: 7,
        timezone, startDate: startDateKey, endDate: endDateKey },
      utilization: expectedMinutes > 0 ? Math.round((actualMinutes / expectedMinutes) * 1000) / 10 : null,
      expectedMinutes,
      trackedMinutes: actualMinutes,
      overtimeMinutes: Math.max(0, actualMinutes - expectedMinutes),
      ...(user.role === 'worker' ? {} : {
        unattributedTimeEntries: {
          count: attribution.unattributed.filter(entry => entry.startTime >= periodStart && entry.startTime <= periodEnd).length,
          minutes: Math.round(unattributedMinutes),
        },
      }),
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
    const user = requestUser(req)!;
    const { profiles, attributionProfiles, tasks, times, completeness } = await getScopedOperationalData(req, db);
    const attribution = attributeTimeEntriesToProfiles(attributionProfiles, times);
    if (attribution.unattributed.length) { completeness.complete = false; completeness.unresolvedEntryCount += attribution.unattributed.filter(entry => entry.trackedUserId !== null).length; }
    const attributedTimes = profiles.flatMap(profile => attribution.entriesByProfileId.get(profile.id) ?? []);
    const { timezone } = await resolveWorkerOperatorContext(user, db);
    const startDateKey = addDaysToDateKey(dateKeyInTimeZone(new Date(), timezone), -13);
    const trends = Array.from({ length: 14 }, (_, index) => {
      const date = addDaysToDateKey(startDateKey, index);
      const { start: dayStart, endExclusive: dayEnd } = dateWindowInTimeZone(date, timezone);
      return {
        date,
        trackedMinutes: Math.round(attributedTimes
          .filter(entry => entry.startTime >= dayStart && entry.startTime < dayEnd)
          .reduce((sum, entry) => sum + trackedMinutes(entry), 0)),
        ...(user.role === 'worker' ? {} : {
          unattributedTimeEntries: {
            count: attribution.unattributed.filter(entry => entry.startTime >= dayStart && entry.startTime < dayEnd).length,
            minutes: Math.round(attribution.unattributed
              .filter(entry => entry.startTime >= dayStart && entry.startTime < dayEnd)
              .reduce((sum, entry) => sum + trackedMinutes(entry), 0)),
          },
        }),
        completedTasks: tasks.filter(task =>
          task.status === 'completed' && task.updatedAt >= dayStart && task.updatedAt < dayEnd
        ).length,
      };
    });

    res.json({ ...completeness, success: true, timezone, periodDays: 14, trends, source: 'task_assignments+time_entries' });
  } catch (error) {
    console.error('[Analytics] Failed to get trends', error);
    res.status(500).json({ error: 'Failed to get trends' });
  }
});

export default router;
