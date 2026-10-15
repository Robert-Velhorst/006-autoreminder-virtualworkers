/**
 * Digest Scheduler Service
 * 
 * Handles scheduling and sending daily digest emails to users
 * who have selected the "daily_digest" notification mode.
 */

import { getDb } from '../db';
import { 
  userNotificationPreferences, 
  notificationHistory, 
  digestJobs,
  users 
} from '../../drizzle/schema.postgres';
import { eq, and, sql, lte, gte } from 'drizzle-orm';
import { sendEmail } from './email';

interface DigestNotification {
  id: number;
  title: string;
  content: string;
  notificationType: string;
  taskName: string | null;
  dueDate: Date | null;
  createdAt: Date;
}

/**
 * Check if it's time to send digest for a user based on their timezone and preferred time
 */
function isDigestTime(digestTime: string, timezone: string): boolean {
  try {
    // Get current time in user's timezone
    const now = new Date();
    const userTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    
    const [targetHour, targetMinute] = digestTime.split(':').map(Number);
    const currentHour = userTime.getHours();
    const currentMinute = userTime.getMinutes();
    
    // Check if we're within 5 minutes of the target time
    const targetMinutes = targetHour * 60 + targetMinute;
    const currentMinutes = currentHour * 60 + currentMinute;
    
    return Math.abs(targetMinutes - currentMinutes) <= 5;
  } catch (error) {
    console.error('[DigestScheduler] Error checking digest time:', error);
    return false;
  }
}

/**
 * Get pending notifications for a user's digest
 */
async function getPendingDigestNotifications(userOpenId: string): Promise<DigestNotification[]> {
  const db = await getDb();
  if (!db) return [];

  // Get notifications queued for digest in the last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const notifications = await db.select()
    .from(notificationHistory)
    .where(and(
      eq(notificationHistory.userOpenId, userOpenId),
      eq(notificationHistory.deliveryStatus, 'queued_for_digest'),
      gte(notificationHistory.createdAt, oneDayAgo)
    ))
    .orderBy(notificationHistory.createdAt);

  return notifications as DigestNotification[];
}

/**
 * Generate HTML content for digest email
 */
function generateDigestHtml(notifications: DigestNotification[], userName: string): string {
  const today = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    month: 'long', 
    day: 'numeric',
    year: 'numeric'
  });

  // Group notifications by type
  const byType: Record<string, DigestNotification[]> = {};
  notifications.forEach(n => {
    const type = n.notificationType;
    if (!byType[type]) byType[type] = [];
    byType[type].push(n);
  });

  const typeLabels: Record<string, { label: string; emoji: string; color: string }> = {
    task_overdue: { label: 'Overdue Tasks', emoji: '🚨', color: '#ef4444' },
    task_due_soon: { label: 'Due Soon', emoji: '⏰', color: '#f59e0b' },
    task_assigned: { label: 'New Assignments', emoji: '📋', color: '#3b82f6' },
    task_completed: { label: 'Completed', emoji: '✅', color: '#22c55e' },
    general: { label: 'Updates', emoji: '📢', color: '#6b7280' },
  };

  let sectionsHtml = '';
  
  // Render sections in priority order
  const typeOrder = ['task_overdue', 'task_due_soon', 'task_assigned', 'task_completed', 'general'];
  
  typeOrder.forEach(type => {
    const items = byType[type];
    if (!items || items.length === 0) return;
    
    const { label, emoji, color } = typeLabels[type] || { label: type, emoji: '📌', color: '#6b7280' };
    
    sectionsHtml += `
      <div style="margin-bottom: 24px;">
        <h3 style="color: ${color}; margin: 0 0 12px 0; font-size: 16px;">
          ${emoji} ${label} (${items.length})
        </h3>
        <ul style="margin: 0; padding-left: 20px; color: #374151;">
          ${items.map(item => `
            <li style="margin-bottom: 8px;">
              <strong>${item.taskName || item.title}</strong>
              ${item.dueDate ? `<br><span style="color: #6b7280; font-size: 13px;">Due: ${new Date(item.dueDate).toLocaleDateString()}</span>` : ''}
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  });

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
      <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1f2937; margin: 0 0 8px 0; font-size: 24px;">
            📋 Daily Task Digest
          </h1>
          <p style="color: #6b7280; margin: 0; font-size: 14px;">
            ${today}
          </p>
        </div>
        
        <p style="color: #374151; margin-bottom: 24px;">
          Good morning, ${userName}! Here's your task summary for today:
        </p>
        
        ${sectionsHtml || '<p style="color: #6b7280; text-align: center;">No new notifications in the last 24 hours.</p>'}
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin: 0;">
          You're receiving this because you have Daily Digest enabled.
          <br>
          <a href="/settings" style="color: #3b82f6;">Manage notification preferences</a>
        </p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send digest to a single user
 */
async function sendDigestToUser(userOpenId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    // Get user info
    const [user] = await db.select()
      .from(users)
      .where(eq(users.openId, userOpenId))
      .limit(1);

    if (!user) {
      console.error(`[DigestScheduler] User not found: ${userOpenId}`);
      return false;
    }

    // Get user preferences
    const [prefs] = await db.select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userOpenId, userOpenId))
      .limit(1);

    if (!prefs || prefs.notificationMode !== 'daily_digest') {
      console.log(`[DigestScheduler] User ${userOpenId} not in digest mode, skipping`);
      return false;
    }

    // Get pending notifications
    const notifications = await getPendingDigestNotifications(userOpenId);
    
    if (notifications.length === 0) {
      console.log(`[DigestScheduler] No notifications for user ${userOpenId}`);
      return true; // Success, just nothing to send
    }

    // Generate and send email
    const html = generateDigestHtml(notifications, user.name || 'there');
    const emailAddress = prefs.emailAddress || user.email;

    if (!emailAddress) {
      console.error(`[DigestScheduler] No email address for user ${userOpenId}`);
      return false;
    }

    const success = await sendEmail({
      to: emailAddress,
      subject: `📋 Your Daily Task Digest - ${new Date().toLocaleDateString()}`,
      html,
    });

    if (success) {
      // Mark notifications as sent
      await db.update(notificationHistory)
        .set({ 
          deliveryStatus: 'sent',
          deliveredAt: new Date(),
        })
        .where(and(
          eq(notificationHistory.userOpenId, userOpenId),
          eq(notificationHistory.deliveryStatus, 'queued_for_digest')
        ));

      // Update last digest sent
      await db.update(userNotificationPreferences)
        .set({ lastDigestSent: new Date() })
        .where(eq(userNotificationPreferences.userOpenId, userOpenId));

      // Record digest job
      await db.insert(digestJobs).values({
        userOpenId,
        scheduledFor: new Date(),
        status: 'completed',
        notificationCount: notifications.length,
        completedAt: new Date(),
      });

      console.log(`[DigestScheduler] Sent digest to ${emailAddress} with ${notifications.length} notifications`);
    }

    return success;
  } catch (error) {
    console.error(`[DigestScheduler] Error sending digest to ${userOpenId}:`, error);
    
    // Record failed job
    const db2 = await getDb();
    if (db2) {
      await db2.insert(digestJobs).values({
        userOpenId,
        scheduledFor: new Date(),
        status: 'failed',
        error: String(error),
      });
    }
    
    return false;
  }
}

/**
 * Process all pending digests
 * This should be called periodically (e.g., every 5 minutes)
 */
export async function processDigests(): Promise<{ processed: number; sent: number; failed: number }> {
  const db = await getDb();
  if (!db) return { processed: 0, sent: 0, failed: 0 };

  console.log('[DigestScheduler] Processing digests...');

  // Get all users with daily_digest mode
  const digestUsers = await db.select({
    userOpenId: userNotificationPreferences.userOpenId,
    digestTime: userNotificationPreferences.digestTime,
    digestTimezone: userNotificationPreferences.digestTimezone,
    lastDigestSent: userNotificationPreferences.lastDigestSent,
  })
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.notificationMode, 'daily_digest'));

  let processed = 0;
  let sent = 0;
  let failed = 0;

  for (const user of digestUsers) {
    // Check if it's digest time for this user
    if (!isDigestTime(user.digestTime, user.digestTimezone)) {
      continue;
    }

    // Check if we already sent a digest today
    if (user.lastDigestSent) {
      const lastSent = new Date(user.lastDigestSent);
      const now = new Date();
      const hoursSinceLastDigest = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceLastDigest < 20) { // Don't send more than once per 20 hours
        continue;
      }
    }

    processed++;
    const success = await sendDigestToUser(user.userOpenId);
    
    if (success) {
      sent++;
    } else {
      failed++;
    }
  }

  console.log(`[DigestScheduler] Processed ${processed} users: ${sent} sent, ${failed} failed`);
  return { processed, sent, failed };
}

/**
 * Queue a notification for digest (instead of sending immediately)
 */
export async function queueNotificationForDigest(
  userId: number,
  userOpenId: string,
  notification: {
    title: string;
    content: string;
    notificationType: 'task_assigned' | 'task_due_soon' | 'task_overdue' | 'task_completed' | 'general';
    taskId?: string;
    taskName?: string;
    dueDate?: Date | null;
  }
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const [result] = await db.insert(notificationHistory).values({
      userId,
      userOpenId,
      title: notification.title,
      content: notification.content,
      notificationType: notification.notificationType,
      taskId: notification.taskId || null,
      taskName: notification.taskName || null,
      dueDate: notification.dueDate || null,
      channel: 'email',
      deliveryStatus: 'queued_for_digest',
    }).returning({ id: notificationHistory.id });

    console.log(`[DigestScheduler] Queued notification for digest: ${notification.title}`);
    return result?.id ?? null;
  } catch (error) {
    console.error('[DigestScheduler] Error queuing notification:', error);
    return null;
  }
}

/**
 * Record a sent notification in history
 */
export async function recordNotification(
  userId: number,
  userOpenId: string,
  notification: {
    title: string;
    content: string;
    notificationType: 'task_assigned' | 'task_due_soon' | 'task_overdue' | 'task_completed' | 'daily_digest' | 'general';
    taskId?: string;
    taskName?: string;
    dueDate?: Date | null;
    channel: 'in_app' | 'email' | 'both';
    deliveryStatus: 'sent' | 'failed';
  }
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const [result] = await db.insert(notificationHistory).values({
      userId,
      userOpenId,
      title: notification.title,
      content: notification.content,
      notificationType: notification.notificationType,
      taskId: notification.taskId || null,
      taskName: notification.taskName || null,
      dueDate: notification.dueDate || null,
      channel: notification.channel,
      deliveryStatus: notification.deliveryStatus,
      deliveredAt: notification.deliveryStatus === 'sent' ? new Date() : null,
    }).returning({ id: notificationHistory.id });

    return result?.id ?? null;
  } catch (error) {
    console.error('[DigestScheduler] Error recording notification:', error);
    return null;
  }
}

// Start the digest scheduler (runs every 5 minutes)
let schedulerInterval: NodeJS.Timeout | null = null;

export function startDigestScheduler() {
  if (schedulerInterval) {
    console.log('[DigestScheduler] Scheduler already running');
    return;
  }

  console.log('[DigestScheduler] Starting scheduler (every 5 minutes)');
  
  // Run immediately on start
  processDigests().catch(console.error);
  
  // Then run every 5 minutes
  schedulerInterval = setInterval(() => {
    processDigests().catch(console.error);
  }, 5 * 60 * 1000);
}

export function stopDigestScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[DigestScheduler] Scheduler stopped');
  }
}
