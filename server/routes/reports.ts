import { Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { taskAssignments, timeEntries, vaProfiles } from '../../drizzle/schema.postgres';
import { requireActiveWorkerProfile, requireAuthenticated, requestUser } from '../middleware/auth';
import { attributeTimeEntriesToProfiles, loadAccountTimeEntries } from '../timeEntryOwnership';
import { selectWorkerProfile } from '../workerOperatorContext';

const router = Router();
router.use(requireAuthenticated);
router.use(requireActiveWorkerProfile);

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function loadWorkerProfileTimeEntries(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  activeProfile: { id: number; founderId: number },
) {
  const founderProfiles = await db.select({
    id: vaProfiles.id,
    userId: vaProfiles.userId,
    founderId: vaProfiles.founderId,
  }).from(vaProfiles).where(eq(vaProfiles.founderId, activeProfile.founderId));
  const identities = Array.from(new Set(founderProfiles.flatMap(profile => [profile.id, profile.userId])));
  if (identities.length === 0) return [];

  const entries = await db.select().from(timeEntries).where(and(
    eq(timeEntries.founderId, activeProfile.founderId),
    inArray(timeEntries.vaId, identities),
  ));
  return attributeTimeEntriesToProfiles(founderProfiles, entries).entriesByProfileId.get(activeProfile.id) ?? [];
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
      const rows = [
        ['id', 'vaId', 'founderId', 'taskId', 'durationMinutes', 'startTime', 'endTime', 'source'],
        ...times.map(entry => [entry.id, entry.vaId, entry.founderId, entry.taskId, entry.durationMinutes,
          entry.startTime.toISOString(), entry.endTime?.toISOString(), entry.source]),
      ];
      res.type('text/csv').attachment('time-entries.csv');
      return res.send(rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
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
    return res.send(rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
  } catch (error) {
    console.error('[Reports] Failed to generate report', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

export default router;
