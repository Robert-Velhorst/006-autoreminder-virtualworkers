import { timeCompleteness } from '../canonicalTimer';
import { recordedMinutes, recordedSeconds } from '../../shared/timerDuration';
import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { taskAssignments, timeEntries, vaProfiles } from '../../drizzle/schema.postgres';
import { requireActiveWorkerProfile, requireAuthenticated, requestUser } from '../middleware/auth';
import { attributeTimeEntriesToProfiles, loadAccountTimeEntries } from '../timeEntryOwnership';
import { selectWorkerProfile } from '../workerOperatorContext';
import { serializeCsv } from '../utils/csv';

const router = Router();
router.use(requireAuthenticated);
router.use(requireActiveWorkerProfile);

async function loadWorkerProfileTimeEntries(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  activeProfile: { id: number; founderId: number },
) {
  const [profile] = await db.select().from(vaProfiles).where(eq(vaProfiles.id, activeProfile.id));
  if (!profile) return [];
  return db.select().from(timeEntries).where(and(eq(timeEntries.trackedUserId, profile.userId),
    eq(timeEntries.founderId, activeProfile.founderId)));

}

router.get('/export', async (req, res) => {
  const format = typeof req.query.format === 'string' ? req.query.format : '';
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  if (format !== 'csv' || !['time-entries', 'task-summary'].includes(type)) {
    return res.status(400).json({
      error: 'Unsupported export format or type',
      supported: ['csv/time-entries', 'csv/task-summary'],
    });
  }

  const user = requestUser(req)!;
  const supportedRoles = new Set(['admin', 'worker', 'user']);
  if (!supportedRoles.has(String(user.role))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const db = await getDb();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    let profiles: { id: number; status: string }[];
    let activeProfile: { id: number; userId: number; founderId: number } | null = null;
    if (user.role === 'admin') {
      profiles = await db.select({ id: vaProfiles.id, status: vaProfiles.status }).from(vaProfiles);
    } else if (user.role === 'worker') {
      const workerProfiles = await db.select({
        id: vaProfiles.id,
        status: vaProfiles.status,
        userId: vaProfiles.userId,
        founderId: vaProfiles.founderId,
      }).from(vaProfiles).where(eq(vaProfiles.userId, user.id));
      profiles = workerProfiles;
      activeProfile = selectWorkerProfile(workerProfiles);
    } else {
      profiles = await db.select({ id: vaProfiles.id, status: vaProfiles.status }).from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
    }
    const profileIds = user.role === 'worker'
      ? activeProfile ? [activeProfile.id] : []
      : profiles.map(profile => profile.id);

    if (type === 'time-entries') {
      const times = user.role === 'worker'
        ? activeProfile ? await loadWorkerProfileTimeEntries(db, activeProfile) : []
        : await loadAccountTimeEntries(db, user);
      const completeness = await timeCompleteness(db, user.role === 'admin' ? undefined : activeProfile?.founderId ?? user.id);
      res.setHeader('X-Time-History-Complete', String(completeness.complete));
      res.setHeader('X-Unresolved-Time-Entries', String(completeness.unresolvedEntryCount));
      const rows = [
        ['id', 'trackedUserId', 'trackedProfileId', 'legacyVaId', 'founderId', 'taskId', 'durationMinutes', 'startTime', 'endTime', 'source',
          'durationSeconds', 'isVoided', 'recordedSeconds', 'recordedMinutes',
          'ownershipVerified', 'historyComplete', 'unresolvedEntryCount'],
        ...times.map(entry => [entry.id, entry.trackedUserId, entry.trackedProfileId, entry.vaId, entry.founderId, entry.taskId, entry.durationMinutes,
          entry.startTime.toISOString(), entry.endTime?.toISOString(), entry.source, entry.durationSeconds, entry.isVoided,
          entry.trackedUserId == null ? null : recordedSeconds(entry),
          entry.trackedUserId == null ? null : recordedMinutes(entry),
          entry.trackedUserId != null, completeness.complete, completeness.unresolvedEntryCount]),
      ];
      res.type('text/csv').attachment('time-entries.csv');
      return res.send(serializeCsv(rows));
    }

    const tasks = user.role === 'admin'
      ? await db.select().from(taskAssignments)
      : profileIds.length > 0
        ? await db.select().from(taskAssignments).where(and(
          inArray(taskAssignments.vaId, profileIds),
          eq(taskAssignments.founderId, user.role === 'worker' ? activeProfile!.founderId : user.id),
        ))
        : [];
    const rows = [
      ['id', 'taskId', 'vaId', 'founderId', 'status', 'assignedAt', 'updatedAt'],
      ...tasks.map(task => [task.id, task.taskId, task.vaId, task.founderId, task.status,
        task.assignedAt.toISOString(), task.updatedAt.toISOString()]),
    ];
    res.type('text/csv').attachment('task-summary.csv');
    return res.send(serializeCsv(rows));
  } catch (error) {
    console.error('[Reports] Failed to generate report', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

export default router;
