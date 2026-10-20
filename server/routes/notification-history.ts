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

const router = Router();
router.use(requireAuthenticated);

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

    const jobs = await db.select()
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
