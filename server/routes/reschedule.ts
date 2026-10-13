import { Router } from 'express';
import type { Request, Response } from 'express';
import { getCachedTasks } from '../services/trello-cache';
import { invalidateCache } from '../services/trello-cache';
import { requireAdmin } from '../middleware/auth';
import { normalizeReschedulePreview } from '../operational-control-validation';

const router = Router();
router.use(requireAdmin);

export function extractCachedTasks(cachedData: unknown): any[] {
  if (Array.isArray(cachedData)) return cachedData;
  if (cachedData && typeof cachedData === 'object' && Array.isArray((cachedData as { tasks?: unknown }).tasks)) {
    return (cachedData as { tasks: any[] }).tasks;
  }
  return [];
}

/**
 * POST /api/reschedule/preview
 * Preview the impact of rescheduling with new settings
 */
router.post('/preview', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const schedule = normalizeReschedulePreview(req.body ?? {});
    if (!schedule.ok) {
      return res.status(400).json({ error: schedule.error });
    }
    const { workStartHour, workEndHour, workingDays } = schedule.value;

    const cachedTasks = await getCachedTasks(user.id, user.openId);
    const tasks = extractCachedTasks(cachedTasks);
    const affectedTasks = tasks.filter((task: any) => {
      if (!task.date) return false;

      const taskDate = new Date(task.date);
      const dayOfWeek = taskDate.getDay();
      if (!workingDays.includes(dayOfWeek)) {
        return true;
      }

      const startHour = Number(task.startTime?.split(':')?.[0]);
      const endHour = Number(task.endTime?.split(':')?.[0]);

      if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) {
        return false;
      }

      return startHour < workStartHour || endHour > workEndHour;
    });
    
    res.json({
      success: true,
      preview: {
        totalTasks: tasks.length,
        affectedTasks: affectedTasks.length,
        newSchedule: {
          workStartHour,
          workEndHour,
          workingDays,
        },
        message: tasks.length > 0
          ? `${affectedTasks.length} task(s) would be rescheduled based on the updated working hours and days`
          : 'No cached tasks available to preview rescheduling impact',
      },
    });
  } catch (error) {
    console.error('Error generating reschedule preview:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

/**
 * POST /api/reschedule/apply
 * Apply bulk rescheduling
 * This triggers a re-fetch of tasks which will automatically use new settings
 */
router.post('/apply', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // The task timeline is derived from current settings during the next fetch.
    // Invalidate the durable server cache so that refresh cannot reuse an old
    // schedule while claiming the new settings were applied.
    await invalidateCache(user.id, user.openId, 'tasks');

    res.json({
      success: true,
      cacheInvalidated: true,
      message: 'Schedule cache cleared. Tasks will be recalculated on refresh.',
    });
  } catch (error) {
    console.error('Error applying reschedule:', error);
    res.status(500).json({ error: 'Failed to apply rescheduling' });
  }
});

export default router;
