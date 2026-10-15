import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { timeEntries, taskAssignments, vaProfiles } from '../../drizzle/schema.postgres';
import { requireAuthenticated, requestUser } from '../middleware/auth';

const router = Router();
router.use(requireAuthenticated);

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

  const db = await getDb();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const user = requestUser(req)!;
    const profiles = user.role === 'admin'
      ? await db.select({ id: vaProfiles.id }).from(vaProfiles)
      : user.role === 'worker'
        ? await db.select({ id: vaProfiles.id }).from(vaProfiles).where(eq(vaProfiles.userId, user.id))
        : await db.select({ id: vaProfiles.id }).from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
    const profileIds = profiles.map(profile => profile.id);

    if (type === 'time-entries') {
      const times = user.role === 'admin'
        ? await db.select().from(timeEntries)
        : profileIds.length > 0
          ? await db.select().from(timeEntries).where(inArray(timeEntries.vaId, profileIds))
          : [];
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
        ? await db.select().from(taskAssignments).where(inArray(taskAssignments.vaId, profileIds))
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
