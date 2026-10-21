/**
 * Notification History API Routes
 * 
 * Provides endpoints for viewing and managing notification history
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { notificationHistory, digestJobs } from '../../drizzle/schema.postgres';
import { eq, and, desc, sql } from 'drizzle-orm';
import { requireAdmin, requireAuthenticated } from '../middleware/auth';
import { parseLimitOffset } from '../utils/pagination';
import { z } from 'zod';

const router = Router();
router.use(requireAuthenticated);

const digestReconciliation = z.object({
  outcome: z.enum(['sent', 'retry']),
  note: z.string().trim().min(10).max(2000),
  evidenceReference: z.string().trim().min(3).max(1000),
  acknowledgeDuplicateRisk: z.boolean().optional(),
}).strict();

function hasDatabaseCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === code) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function sendDigestFailure(res: Response, error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'NOT_FOUND') return res.status(404).json({ error: 'Digest job not found' });
  if (code === 'FORBIDDEN') return res.status(403).json({ error: 'Digest administration is not permitted' });
  if (code === 'CONFLICT') return res.status(409).json({ error: 'Digest cannot be reconciled in its current state. Review active work and delivery evidence.' });
  if (code === 'BAD_REQUEST') return res.status(400).json({ error: 'Digest reconciliation requires valid delivery evidence and explicit duplicate-risk acknowledgement for retries.' });
  return res.status(503).json({ error: 'Digest status or reconciliation is unavailable' });
}

router.get('/digest-jobs/attention', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { listDigestJobsNeedingAttention } = await import('../services/digest-outbox');
    return res.json({ jobs: await listDigestJobsNeedingAttention((req as any).user.id) });
  } catch (error) { return sendDigestFailure(res, error); }
});

router.get('/digest-jobs/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid digest job ID' });
  try {
    const { getDigestJobForReview } = await import('../services/digest-outbox');
    return res.json({ job: await getDigestJobForReview(id, (req as any).user.id) });
  } catch (error) { return sendDigestFailure(res, error); }
});

router.post('/digest-jobs/:id/reconcile', requireAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const input = digestReconciliation.safeParse(req.body);
  if (!Number.isSafeInteger(id) || id <= 0 || !input.success) return res.status(400).json({ error: 'Invalid digest reconciliation request' });
  try {
    const { reconcileDigestJob } = await import('../services/digest-outbox');
    return res.json(await reconcileDigestJob(id, (req as any).user.id, input.data));
  } catch (error) { return sendDigestFailure(res, error); }
});

/**
 * GET /api/notifications
 * Get notification history for current user
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { unreadOnly = 'false' } = req.query;
    const { limit, offset } = parseLimitOffset(req.query);

    let query = db.select()
      .from(notificationHistory)
      .where(
        unreadOnly === 'true'
          ? and(
              eq(notificationHistory.userOpenId, user.openId),
              eq(notificationHistory.isRead, 0)
            )
          : eq(notificationHistory.userOpenId, user.openId)
      )
      .orderBy(desc(notificationHistory.createdAt))
      .limit(limit)
      .offset(offset);

    const notifications = await query;

    res.json({
      notifications,
      pagination: {
        limit,
        offset,
        hasMore: notifications.length === limit,
      },
    });
  } catch (error: unknown) {
    console.error('[NotificationHistory] Get error:', error);
    res.status(500).json({ error: 'Unable to load notification history' });
  }
});

/**
 * GET /api/notifications/unread-count
 * Get count of unread notifications
 */
router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const result = await db.select({
      count: sql<number>`COUNT(*)`,
    })
      .from(notificationHistory)
      .where(and(
        eq(notificationHistory.userOpenId, user.openId),
        eq(notificationHistory.isRead, 0)
      ));

    res.json({ unreadCount: result[0]?.count || 0 });
  } catch (error: unknown) {
    console.error('[NotificationHistory] Unread count error:', error);
    res.status(500).json({ error: 'Unable to load unread notifications' });
  }
});

/**
 * POST /api/notifications/:id/read
 * Mark a notification as read
 */
router.post('/:id/read', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { id } = req.params;

    await db.update(notificationHistory)
      .set({ 
        isRead: 1,
        readAt: new Date(),
      })
      .where(and(
        eq(notificationHistory.id, Number(id)),
        eq(notificationHistory.userOpenId, user.openId)
      ));

    res.json({ success: true });
  } catch (error: unknown) {
    console.error('[NotificationHistory] Mark read error:', error);
    res.status(500).json({ error: 'Unable to mark the notification as read' });
  }
});

/**
 * POST /api/notifications/mark-all-read
 * Mark all notifications as read
 */
router.post('/mark-all-read', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    await db.update(notificationHistory)
      .set({ 
        isRead: 1,
        readAt: new Date(),
      })
      .where(and(
        eq(notificationHistory.userOpenId, user.openId),
        eq(notificationHistory.isRead, 0)
      ));

    res.json({ success: true });
  } catch (error: unknown) {
    console.error('[NotificationHistory] Mark all read error:', error);
    res.status(500).json({ error: 'Unable to mark notifications as read' });
  }
});

/**
 * DELETE /api/notifications/:id
 * Delete a notification
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { id } = req.params;

    await db.delete(notificationHistory)
      .where(and(
        eq(notificationHistory.id, Number(id)),
        eq(notificationHistory.userOpenId, user.openId)
      ));

    res.json({ success: true });
  } catch (error: unknown) {
    console.error('[NotificationHistory] Delete error:', error);
    if (hasDatabaseCode(error, '23503')) {
      return res.status(409).json({ error: 'This notification belongs to a retained digest. Reconcile its delivery before changing its audit history.' });
    }
    res.status(500).json({ error: 'Unable to delete the notification' });
  }
});

/**
 * GET /api/notifications/digest-history
 * Get digest job history
 */
router.get('/digest-history', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { limit } = parseLimitOffset(req.query, { defaultLimit: 10 });

    const jobs = await db.select({
      id: digestJobs.id, userOpenId: digestJobs.userOpenId,
      scheduledFor: digestJobs.scheduledFor, status: digestJobs.status,
      notificationCount: digestJobs.notificationCount, completedAt: digestJobs.completedAt,
      createdAt: digestJobs.createdAt, deliveryPhase: digestJobs.deliveryPhase,
      attemptCount: digestJobs.attemptCount, attemptedAt: digestJobs.attemptedAt,
      nextAttemptAt: digestJobs.nextAttemptAt, reconciledAt: digestJobs.reconciledAt,
    })
      .from(digestJobs)
      .where(eq(digestJobs.userOpenId, user.openId))
      .orderBy(desc(digestJobs.createdAt))
      .limit(limit);

    res.json({ jobs });
  } catch (error: unknown) {
    console.error('[NotificationHistory] Digest history error:', error);
    res.status(500).json({ error: 'Unable to load digest history' });
  }
});

/**
 * POST /api/notifications/trigger-digest
 * Manually trigger digest for testing
 */
router.post('/trigger-digest', requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Import dynamically to avoid circular dependencies
    const { processDigests } = await import('../services/digest-scheduler');
    const result = await processDigests();

    res.json({ 
      success: true,
      ...result,
    });
  } catch (error: unknown) {
    console.error('[NotificationHistory] Trigger digest error:', error);
    res.status(500).json({ error: 'Unable to trigger the notification digest' });
  }
});

export default router;
