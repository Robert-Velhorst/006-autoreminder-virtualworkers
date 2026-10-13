/**
 * Notification Preferences API Routes
 * 
 * Allows users to configure their notification settings:
 * - disabled: No automated notifications
 * - daily_digest: Single summary at scheduled time
 * - priority_only: Immediate notifications only for urgent items
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { userNotificationPreferences } from '../../drizzle/schema';
import { eq } from 'drizzle-orm';
import { requireAuthenticated, requestUser } from '../middleware/auth';
import {
  normalizeNotificationPreferences,
  type NotificationPreferenceValues,
} from '../operational-control-validation';

const router = Router();
router.use(requireAuthenticated);

interface NotificationPreferencesInput {
  notificationMode: 'disabled' | 'daily_digest' | 'priority_only';
  digestTime?: string; // HH:MM format
  digestTimezone?: string;
  urgentThresholdHours?: number;
  emailEnabled?: boolean;
  emailAddress?: string;
  inAppEnabled?: boolean;
}

/**
 * GET /api/notification-preferences
 * Get current user's notification preferences
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

    const [prefs] = await db.select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userOpenId, user.openId))
      .limit(1);

    if (!prefs) {
      // Return defaults if no preferences set
      return res.json({
        notificationMode: 'priority_only',
        digestTime: '08:00',
        digestTimezone: 'Europe/Amsterdam',
        urgentThresholdHours: 24,
        emailEnabled: true,
        emailAddress: user.email || null,
        inAppEnabled: true,
        lastDigestSent: null,
      });
    }

    res.json({
      notificationMode: prefs.notificationMode,
      digestTime: prefs.digestTime,
      digestTimezone: prefs.digestTimezone,
      urgentThresholdHours: prefs.urgentThresholdHours,
      emailEnabled: prefs.emailEnabled === 1,
      emailAddress: prefs.emailAddress,
      inAppEnabled: prefs.inAppEnabled === 1,
      lastDigestSent: prefs.lastDigestSent,
    });
  } catch (error: unknown) {
    console.error('[NotificationPrefs] Get error:', error);
    res.status(500).json({ error: 'Unable to load notification preferences' });
  }
});

/**
 * PUT /api/notification-preferences
 * Update current user's notification preferences
 */
router.put('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const input: NotificationPreferencesInput = req.body ?? {};

    // Check if preferences exist
    const [existing] = await db.select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userOpenId, user.openId))
      .limit(1);

    const current: NotificationPreferenceValues | undefined = existing ? {
      notificationMode: existing.notificationMode as NotificationPreferenceValues['notificationMode'],
      digestTime: existing.digestTime,
      digestTimezone: existing.digestTimezone,
      urgentThresholdHours: existing.urgentThresholdHours,
      emailEnabled: existing.emailEnabled,
      emailAddress: existing.emailAddress,
      inAppEnabled: existing.inAppEnabled,
    } : undefined;
    const normalized = normalizeNotificationPreferences(input as unknown as Record<string, unknown>, current, user.email);
    if (!normalized.ok) return res.status(400).json({ error: normalized.error });
    const data = normalized.value;

    if (existing) {
      await db.update(userNotificationPreferences)
        .set(data)
        .where(eq(userNotificationPreferences.userOpenId, user.openId));
    } else {
      await db.insert(userNotificationPreferences).values({
        userId: user.id,
        userOpenId: user.openId,
        ...data,
      });
    }

    console.log(`[NotificationPrefs] Updated preferences for user ${user.openId}: mode=${data.notificationMode}`);

    res.json({
      success: true,
      ...data,
      emailEnabled: data.emailEnabled === 1,
      inAppEnabled: data.inAppEnabled === 1,
    });
  } catch (error: unknown) {
    console.error('[NotificationPrefs] Update error:', error);
    res.status(500).json({ error: 'Unable to update notification preferences' });
  }
});

/**
 * GET /api/notification-preferences/should-notify
 * Check if a notification should be sent based on user preferences
 * Used internally by notification service
 */
router.get('/should-notify', async (req: Request, res: Response) => {
  try {
    const { dueDate } = req.query;
    const user = requestUser(req)!;
    const requestedUserOpenId = typeof req.query.userOpenId === 'string' ? req.query.userOpenId : '';
    const userOpenId = user.role === 'admin' && requestedUserOpenId ? requestedUserOpenId : user.openId;

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const [prefs] = await db.select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userOpenId, userOpenId))
      .limit(1);

    // Default to priority_only if no preferences set
    const mode = prefs?.notificationMode || 'priority_only';
    const urgentThreshold = prefs?.urgentThresholdHours || 24;

    let shouldNotify = false;
    let reason = '';

    switch (mode) {
      case 'disabled':
        shouldNotify = false;
        reason = 'Notifications disabled';
        break;

      case 'daily_digest':
        // For digest mode, we don't send immediate notifications
        // The digest scheduler will handle sending summaries
        shouldNotify = false;
        reason = 'Will be included in daily digest';
        break;

      case 'priority_only':
        // Only notify if task is due within urgent threshold
        if (dueDate) {
          const due = new Date(dueDate as string);
          const now = new Date();
          const hoursUntilDue = (due.getTime() - now.getTime()) / (1000 * 60 * 60);
          
          if (hoursUntilDue <= urgentThreshold && hoursUntilDue > 0) {
            shouldNotify = true;
            reason = `Task due within ${urgentThreshold} hours`;
          } else if (hoursUntilDue <= 0) {
            shouldNotify = true;
            reason = 'Task is overdue';
          } else {
            shouldNotify = false;
            reason = `Task not urgent (due in ${Math.round(hoursUntilDue)} hours)`;
          }
        } else {
          // No due date - don't send immediate notification
          shouldNotify = false;
          reason = 'No due date set';
        }
        break;
    }

    res.json({
      shouldNotify,
      reason,
      mode,
      urgentThreshold,
    });
  } catch (error: unknown) {
    console.error('[NotificationPrefs] Should-notify error:', error);
    res.status(500).json({ error: 'Unable to evaluate notification preferences' });
  }
});

export default router;
