/**
 * Smart Notification Service
 * 
 * Wraps the notification system to respect user preferences:
 * - disabled: Skip all notifications
 * - daily_digest: Queue for daily summary
 * - priority_only: Only send if task is urgent (due within threshold)
 */

import { getDb } from '../db';
import { userNotificationPreferences } from '../../drizzle/schema.postgres';
import { eq } from 'drizzle-orm';
import { notifyOwner, NotificationPayload } from '../_core/notification';
import { sendEmail } from './email';

export interface TaskNotification {
  userOpenId: string;
  userId: number;
  title: string;
  content: string;
  taskId?: string;
  dueDate?: Date | string | null;
  notificationType: 'task_assigned' | 'task_due_soon' | 'task_overdue' | 'task_completed' | 'general';
}

interface NotificationResult {
  sent: boolean;
  reason: string;
  mode: string;
  queuedForDigest?: boolean;
}

// In-memory digest queue (in production, use Redis or database)
const digestQueue: Map<string, TaskNotification[]> = new Map();

/**
 * Get user's notification preferences
 */
async function getUserPreferences(userOpenId: string) {
  const db = await getDb();
  if (!db) return null;

  const [prefs] = await db.select()
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userOpenId, userOpenId))
    .limit(1);

  return prefs || {
    notificationMode: 'priority_only' as const,
    urgentThresholdHours: 24,
    emailEnabled: 1,
    inAppEnabled: 1,
    emailAddress: null,
  };
}

/**
 * Check if a task is urgent based on due date and threshold
 */
function isTaskUrgent(dueDate: Date | string | null | undefined, thresholdHours: number): { urgent: boolean; hoursUntilDue: number | null } {
  if (!dueDate) {
    return { urgent: false, hoursUntilDue: null };
  }

  const due = new Date(dueDate);
  const now = new Date();
  const hoursUntilDue = (due.getTime() - now.getTime()) / (1000 * 60 * 60);

  // Urgent if due within threshold or overdue
  const urgent = hoursUntilDue <= thresholdHours;

  return { urgent, hoursUntilDue };
}

/**
 * Add notification to digest queue
 */
function queueForDigest(notification: TaskNotification) {
  const queue = digestQueue.get(notification.userOpenId) || [];
  queue.push(notification);
  digestQueue.set(notification.userOpenId, queue);
  console.log(`[SmartNotification] Queued notification for digest: ${notification.title} (user: ${notification.userOpenId})`);
}

/**
 * Get and clear digest queue for a user
 */
export function getDigestQueue(userOpenId: string): TaskNotification[] {
  const queue = digestQueue.get(userOpenId) || [];
  digestQueue.delete(userOpenId);
  return queue;
}

/**
 * Send a notification respecting user preferences
 */
export async function sendSmartNotification(notification: TaskNotification): Promise<NotificationResult> {
  const prefs = await getUserPreferences(notification.userOpenId);

  if (!prefs) {
    // No preferences found, use default (priority_only)
    console.log(`[SmartNotification] No preferences found for user ${notification.userOpenId}, using defaults`);
  }

  const mode = prefs?.notificationMode || 'priority_only';
  const urgentThreshold = prefs?.urgentThresholdHours || 24;

  // Check notification mode
  switch (mode) {
    case 'disabled':
      console.log(`[SmartNotification] Notifications disabled for user ${notification.userOpenId}`);
      return {
        sent: false,
        reason: 'Notifications disabled by user preference',
        mode,
      };

    case 'daily_digest':
      // Queue for daily digest instead of sending immediately
      queueForDigest(notification);
      return {
        sent: false,
        reason: 'Queued for daily digest',
        mode,
        queuedForDigest: true,
      };

    case 'priority_only':
      const { urgent, hoursUntilDue } = isTaskUrgent(notification.dueDate, urgentThreshold);

      // Always send overdue notifications
      if (notification.notificationType === 'task_overdue') {
        return await sendNotificationNow(notification, prefs, mode);
      }

      // Check if task is urgent
      if (!urgent) {
        console.log(`[SmartNotification] Task not urgent (due in ${hoursUntilDue?.toFixed(1)} hours, threshold: ${urgentThreshold}h)`);
        return {
          sent: false,
          reason: `Task not urgent (due in ${hoursUntilDue?.toFixed(1) || 'unknown'} hours, threshold: ${urgentThreshold}h)`,
          mode,
        };
      }

      // Task is urgent, send notification
      return await sendNotificationNow(notification, prefs, mode);

    default:
      console.warn(`[SmartNotification] Unknown notification mode: ${mode}`);
      return {
        sent: false,
        reason: `Unknown notification mode: ${mode}`,
        mode,
      };
  }
}

/**
 * Actually send the notification through available channels
 */
async function sendNotificationNow(
  notification: TaskNotification,
  prefs: any,
  mode: string
): Promise<NotificationResult> {
  let sent = false;
  const channels: string[] = [];

  // Send in-app notification if enabled
  if (prefs?.inAppEnabled !== 0) {
    try {
      const success = await notifyOwner({
        title: notification.title,
        content: notification.content,
      });
      if (success) {
        sent = true;
        channels.push('in-app');
      }
    } catch (error) {
      console.error('[SmartNotification] Failed to send in-app notification:', error);
    }
  }

  // Send email notification if enabled and email address available
  if (prefs?.emailEnabled !== 0 && prefs?.emailAddress) {
    try {
      const success = await sendEmail({
        to: prefs.emailAddress,
        subject: notification.title,
        html: `
          <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a1a;">${notification.title}</h2>
            <p style="color: #4a4a4a; line-height: 1.6;">${notification.content}</p>
            ${notification.dueDate ? `<p style="color: #666; font-size: 14px;">Due: ${new Date(notification.dueDate).toLocaleString()}</p>` : ''}
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="color: #888; font-size: 12px;">
              You can adjust your notification preferences in the <a href="/settings">Settings</a> page.
            </p>
          </div>
        `,
      });
      if (success) {
        sent = true;
        channels.push('email');
      }
    } catch (error) {
      console.error('[SmartNotification] Failed to send email notification:', error);
    }
  }

  console.log(`[SmartNotification] Notification ${sent ? 'sent' : 'failed'} via: ${channels.join(', ') || 'none'}`);

  return {
    sent,
    reason: sent ? `Sent via ${channels.join(', ')}` : 'Failed to send through any channel',
    mode,
  };
}

/**
 * Send daily digest to a user
 */
export async function sendDailyDigest(userOpenId: string): Promise<boolean> {
  const queue = getDigestQueue(userOpenId);
  
  if (queue.length === 0) {
    console.log(`[SmartNotification] No notifications in digest queue for user ${userOpenId}`);
    return true;
  }

  const prefs = await getUserPreferences(userOpenId);
  if (!prefs || prefs.notificationMode !== 'daily_digest') {
    console.log(`[SmartNotification] User ${userOpenId} not in digest mode, skipping`);
    return false;
  }

  // Group notifications by type
  const byType = queue.reduce((acc, n) => {
    const type = n.notificationType;
    if (!acc[type]) acc[type] = [];
    acc[type].push(n);
    return acc;
  }, {} as Record<string, TaskNotification[]>);

  // Build digest content
  const sections: string[] = [];
  
  if (byType.task_overdue?.length) {
    sections.push(`**Overdue Tasks (${byType.task_overdue.length})**\n${byType.task_overdue.map(n => `- ${n.title}`).join('\n')}`);
  }
  if (byType.task_due_soon?.length) {
    sections.push(`**Due Soon (${byType.task_due_soon.length})**\n${byType.task_due_soon.map(n => `- ${n.title}`).join('\n')}`);
  }
  if (byType.task_assigned?.length) {
    sections.push(`**New Assignments (${byType.task_assigned.length})**\n${byType.task_assigned.map(n => `- ${n.title}`).join('\n')}`);
  }
  if (byType.task_completed?.length) {
    sections.push(`**Completed (${byType.task_completed.length})**\n${byType.task_completed.map(n => `- ${n.title}`).join('\n')}`);
  }
  if (byType.general?.length) {
    sections.push(`**Updates (${byType.general.length})**\n${byType.general.map(n => `- ${n.title}`).join('\n')}`);
  }

  const digestContent = sections.join('\n\n');
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // Send digest
  const result = await sendNotificationNow({
    userOpenId,
    userId: queue[0]?.userId || 0,
    title: `📋 Daily Task Digest - ${today}`,
    content: digestContent,
    notificationType: 'general',
  }, prefs, 'daily_digest');

  // Update last digest sent timestamp
  if (result.sent) {
    const db = await getDb();
    if (db) {
      await db.update(userNotificationPreferences)
        .set({ lastDigestSent: new Date() })
        .where(eq(userNotificationPreferences.userOpenId, userOpenId));
    }
  }

  return result.sent;
}

/**
 * Get notification statistics for a user
 */
export async function getNotificationStats(userOpenId: string) {
  const prefs = await getUserPreferences(userOpenId);
  const queuedCount = digestQueue.get(userOpenId)?.length || 0;

  return {
    mode: prefs?.notificationMode || 'priority_only',
    urgentThreshold: prefs?.urgentThresholdHours || 24,
    emailEnabled: prefs?.emailEnabled === 1,
    inAppEnabled: prefs?.inAppEnabled === 1,
    queuedForDigest: queuedCount,
    lastDigestSent: prefs?.lastDigestSent || null,
  };
}
