import { and, eq } from 'drizzle-orm';
import { notificationHistory, userNotificationPreferences, users, vaProfiles } from '../../drizzle/schema.postgres';
import { getDb } from '../db';
import { getActiveWorkerProfileId } from '../workerOperatorContext';
import { deliverDigestForUser, enqueueDigestNotification, readQueuedDigestNotifications } from './digest-outbox';
import { sendEmailWithOutcome } from './email';
import { areNotificationsEnabled } from './notificationPolicy';
import { hasPersistedEmailConsent } from './recipientEmailConsent';

export interface TaskNotification {
  userOpenId: string; userId: number; title: string; content: string;
  taskId?: string; taskName?: string; dueDate?: Date | string | null;
  notificationType: 'task_assigned' | 'task_due_soon' | 'task_overdue' | 'task_completed' | 'general';
}

interface NotificationResult {
  sent: boolean; reason: string; mode: string; queuedForDigest?: boolean;
  deliveryState?: 'sent' | 'not_sent' | 'uncertain';
  channels?: { inApp: 'stored' | 'disabled' | 'not_stored' | 'failed'; email: 'sent' | 'not_sent' | 'uncertain' | 'disabled' };
  inAppNotificationId?: number;
}

function isUrgent(notification: TaskNotification, dueDate: Date | null, threshold: number) {
  return Number.isFinite(threshold) && threshold >= 0 && (notification.notificationType === 'task_overdue'
    || Boolean(dueDate && (dueDate.getTime() - Date.now()) / 3_600_000 <= threshold));
}

async function storeRecipientInbox(notification: TaskNotification, dueDate: Date | null): Promise<{
  state: 'stored' | 'disabled' | 'not_stored' | 'failed'; id?: number;
}> {
  try {
    const db = await getDb();
    if (!db) return { state: 'failed' };
    return await db.transaction(async tx => {
      const [recipient] = await tx.select({ user: users, preferences: userNotificationPreferences }).from(users)
        .innerJoin(userNotificationPreferences, and(eq(users.openId, userNotificationPreferences.userOpenId),
          eq(users.id, userNotificationPreferences.userId)))
        .where(and(eq(users.id, notification.userId), eq(users.openId, notification.userOpenId))).limit(1).for('update');
      if (!recipient) return { state: 'not_stored' as const };
      if (!['admin', 'worker'].includes(recipient.user.role)) return { state: 'not_stored' as const };
      if (recipient.user.role === 'worker') {
        // Hold existing profile rows through inbox commit; selection policy stays canonical.
        await tx.select({ id: vaProfiles.id }).from(vaProfiles)
          .where(eq(vaProfiles.userId, recipient.user.id)).for('share');
        if (await getActiveWorkerProfileId(recipient.user.id, tx) === null) return { state: 'not_stored' as const };
      }
      const preferences = recipient.preferences;
      if (preferences.inAppEnabled !== 1) return { state: 'disabled' as const };
      if (!areNotificationsEnabled() || preferences.notificationMode !== 'priority_only'
        || !isUrgent(notification, dueDate, preferences.urgentThresholdHours)) return { state: 'not_stored' as const };
      const [record] = await tx.insert(notificationHistory).values({
        userId: recipient.user.id, userOpenId: recipient.user.openId, title: notification.title, content: notification.content,
        notificationType: notification.notificationType, taskId: notification.taskId ?? null,
        taskName: notification.taskName ?? null, dueDate, channel: 'in_app', deliveryStatus: 'sent', deliveredAt: new Date(),
      }).returning({ id: notificationHistory.id });
      if (!record || !areNotificationsEnabled()) throw new Error('Inbox persistence not confirmed');
      return { state: 'stored' as const, id: record.id };
    });
  } catch { return { state: 'failed' }; }
}

async function getRecipient(userOpenId: string, userId?: number) {
  if (!userOpenId || (userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0))) return null;
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select({ user: users, preferences: userNotificationPreferences }).from(users)
    .innerJoin(userNotificationPreferences, and(eq(users.openId, userNotificationPreferences.userOpenId),
      eq(users.id, userNotificationPreferences.userId)))
    .where(and(eq(users.openId, userOpenId), userId === undefined ? undefined : eq(users.id, userId))).limit(1);
  if (row && !['admin', 'worker'].includes(row.user.role)) return null;
  if (row?.user.role === 'worker' && await getActiveWorkerProfileId(row.user.id, db) === null) return null;
  return row ?? null;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Nondestructive compatibility read: only the durable core acknowledges membership. */
export async function getDigestQueue(userOpenId: string) {
  return readQueuedDigestNotifications(userOpenId);
}

export async function sendSmartNotification(notification: TaskNotification): Promise<NotificationResult> {
  const skip = (reason: string, mode = 'unconfigured'): NotificationResult => ({ sent: false, reason, mode });
  if (!areNotificationsEnabled()) return skip('Notifications are globally disabled', 'disabled');
  if (!notification.title?.trim() || notification.title.length > 500 || !notification.content?.trim()) return skip('Invalid notification content');
  const dueDate = notification.dueDate == null ? null : new Date(notification.dueDate);
  if (dueDate && !Number.isFinite(dueDate.getTime())) return skip('Invalid due date');
  let recipient;
  try { recipient = await getRecipient(notification.userOpenId, notification.userId); }
  catch { return skip('Recipient preferences unavailable'); }
  if (!recipient) return skip('Canonical recipient and persisted preferences are required');
  const { preferences } = recipient;
  const mode = preferences.notificationMode;
  if (mode === 'disabled') return skip('Notifications disabled by user preference', mode);
  if (mode === 'daily_digest') {
    try {
      if (!areNotificationsEnabled()) return skip('Notifications are globally disabled', mode);
      const id = await enqueueDigestNotification({ ...notification, dueDate });
      return { sent: false, mode, queuedForDigest: id !== null,
        reason: id === null ? 'Digest notification was not persisted' : 'Persisted for daily digest' };
    } catch { return { ...skip('Digest notification was not persisted', mode), queuedForDigest: false }; }
  }
  if (mode !== 'priority_only') return skip('Unsupported notification mode', mode);
  const threshold = preferences.urgentThresholdHours;
  if (!Number.isFinite(threshold) || threshold < 0) return skip('Invalid persisted urgency threshold', mode);
  if (notification.notificationType !== 'task_overdue'
    && (!dueDate || (dueDate.getTime() - Date.now()) / 3_600_000 > threshold)) return skip('Task is not urgent', mode);
  const inbox = await storeRecipientInbox(notification, dueDate);
  const channelResult = (email: NonNullable<NotificationResult['channels']>['email'], detail: string): NotificationResult => ({
    sent: inbox.state === 'stored' || email === 'sent', mode, channels: { inApp: inbox.state, email },
    ...(inbox.id === undefined ? {} : { inAppNotificationId: inbox.id }),
    ...(email === 'disabled' ? {} : { deliveryState: email }),
    reason: `${inbox.state === 'stored' ? 'Stored in recipient inbox (no push delivery claimed)' : `Recipient inbox ${inbox.state}`}; ${detail}`,
  });
  let current;
  try { current = await getRecipient(notification.userOpenId, notification.userId); }
  catch { return channelResult('not_sent', 'Recipient email preferences unavailable'); }
  if (!current || current.preferences.notificationMode !== 'priority_only'
    || !hasPersistedEmailConsent(current.preferences)) return channelResult('disabled', 'Recipient email consent is absent or changed');
  const currentThreshold = current.preferences.urgentThresholdHours;
  if (!Number.isFinite(currentThreshold) || currentThreshold < 0
    || (notification.notificationType !== 'task_overdue'
      && (!dueDate || (dueDate.getTime() - Date.now()) / 3_600_000 > currentThreshold))) {
    return channelResult('not_sent', 'Task no longer meets the current urgency preference');
  }
  const address = current.preferences.emailAddress || current.user.email;
  if (!address) return channelResult('not_sent', 'Recipient email address is missing');
  if (!areNotificationsEnabled()) return channelResult('disabled', 'Notifications are globally disabled');
  try {
    const outcome = await sendEmailWithOutcome({ to: address, subject: notification.title,
      html: `<h2>${escapeHtml(notification.title)}</h2><p>${escapeHtml(notification.content)}</p>${dueDate ? `<p>Due: ${escapeHtml(dueDate.toISOString())}</p>` : ''}` });
    return channelResult(outcome.status, outcome.status === 'sent' ? 'Email delivery confirmed' : outcome.status === 'uncertain'
      ? 'Email delivery is unconfirmed; do not retry automatically' : 'Email was not sent');
  } catch { return channelResult('uncertain', 'Email delivery is unconfirmed; do not retry automatically'); }
}

export async function sendDailyDigest(userOpenId: string): Promise<boolean> {
  if (!areNotificationsEnabled()) return false;
  return (await deliverDigestForUser(userOpenId, { trigger: 'manual' })).state === 'sent';
}

export async function getNotificationStats(userOpenId: string) {
  const recipient = await getRecipient(userOpenId);
  const preferences = recipient?.preferences;
  const queued = await readQueuedDigestNotifications(userOpenId);
  return { mode: preferences?.notificationMode ?? 'unconfigured', urgentThreshold: preferences?.urgentThresholdHours ?? null,
    emailEnabled: hasPersistedEmailConsent(preferences), inAppEnabled: preferences?.inAppEnabled === 1,
    queuedForDigest: queued.length, lastDigestSent: preferences?.lastDigestSent ?? null };
}
