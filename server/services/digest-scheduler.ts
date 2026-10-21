import { and, eq } from 'drizzle-orm';
import { notificationHistory, userNotificationPreferences, users } from '../../drizzle/schema.postgres';
import { getDb } from '../db';
import { deliverDigestForUser, enqueueDigestNotification } from './digest-outbox';
import { areNotificationsEnabled } from './notificationPolicy';
import { hasPersistedEmailConsent } from './recipientEmailConsent';

export { deliverDigestForUser, readQueuedDigestNotifications, enqueueDigestNotification } from './digest-outbox';

type DigestSchedule = { digestTime: string; digestTimezone: string; lastDigestSent: Date | null };

function localClock(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)!.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

export function isDigestDue(schedule: DigestSchedule, now = new Date()): boolean {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.digestTime)) return false;
  try {
    const current = localClock(now, schedule.digestTimezone);
    const [hour, minute] = schedule.digestTime.split(':').map(Number);
    if (current.minutes < hour * 60 + minute) return false;
    // Compare recipient-local calendar days, not 20/24-hour elapsed windows.
    return !schedule.lastDigestSent || localClock(schedule.lastDigestSent, schedule.digestTimezone).date < current.date;
  } catch { return false; }
}

/** Compatibility boolean means confirmed delivery, never an empty or uncertain send. */
export async function sendDigestToUser(userOpenId: string): Promise<boolean> {
  if (!areNotificationsEnabled()) return false;
  return (await deliverDigestForUser(userOpenId, { trigger: 'manual' })).state === 'sent';
}

type DigestProcessingResult = { processed: number; sent: number; failed: number; uncertain: number; empty: number; skipped: number };
let processing: Promise<DigestProcessingResult> | null = null;

export function processDigests(options: { now?: Date } = {}): Promise<DigestProcessingResult> {
  if (!areNotificationsEnabled()) return Promise.resolve({ processed: 0, sent: 0, failed: 0, uncertain: 0, empty: 0, skipped: 0 });
  if (processing) return processing;
  const operation = runDigests(options.now ?? new Date());
  processing = operation;
  const clear = () => { if (processing === operation) processing = null; };
  void operation.then(clear, clear);
  return operation;
}

async function runDigests(now: Date): Promise<DigestProcessingResult> {
  const result = { processed: 0, sent: 0, failed: 0, uncertain: 0, empty: 0, skipped: 0 };
  const db = await getDb();
  if (!areNotificationsEnabled()) return result;
  if (!db) throw new Error('Database unavailable for digest scan');
  const recipients = await db.select().from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.notificationMode, 'daily_digest'));
  for (const recipient of recipients) {
    if (!areNotificationsEnabled()) break;
    if (!hasPersistedEmailConsent(recipient) || !isDigestDue(recipient, now)) continue;
    result.processed++;
    try {
      const delivery = await deliverDigestForUser(recipient.userOpenId, { now, trigger: 'cron' });
      if (delivery.state === 'sent') result.sent++;
      else if (delivery.state === 'uncertain') result.uncertain++;
      else if (delivery.state === 'empty') result.empty++;
      else if (delivery.state === 'skipped') result.skipped++;
      else result.failed++;
    } catch {
      result.uncertain++;
      console.warn('[DigestScheduler] Delivery outcome unavailable; inspect durable job before retrying');
    }
  }
  return result;
}

type DigestNotice = {
  title: string; content: string;
  notificationType: 'task_assigned' | 'task_due_soon' | 'task_overdue' | 'task_completed' | 'general';
  taskId?: string; taskName?: string; dueDate?: Date | null;
};

export async function queueNotificationForDigest(userId: number, userOpenId: string, notification: DigestNotice): Promise<number | null> {
  if (!areNotificationsEnabled()) return null;
  return enqueueDigestNotification({ userId, userOpenId, ...notification });
}

// Retain the historical explicit-outcome recorder, but bind both recipient keys.
export async function recordNotification(userId: number, userOpenId: string, notification: Omit<DigestNotice, 'notificationType'> & {
  notificationType: DigestNotice['notificationType'] | 'daily_digest';
  channel: 'in_app' | 'email' | 'both'; deliveryStatus: 'sent' | 'failed';
}): Promise<number | null> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !userOpenId) return null;
  const db = await getDb();
  if (!db) return null;
  try {
    return await db.transaction(async tx => {
      const [recipient] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.id, userId), eq(users.openId, userOpenId))).limit(1).for('share');
      if (!recipient) return null;
      const [row] = await tx.insert(notificationHistory).values({ userId, userOpenId, ...notification,
        taskId: notification.taskId ?? null, taskName: notification.taskName ?? null, dueDate: notification.dueDate ?? null,
        deliveredAt: notification.deliveryStatus === 'sent' ? new Date() : null,
      }).returning({ id: notificationHistory.id });
      return row?.id ?? null;
    });
  } catch { console.warn('[DigestScheduler] Could not persist notification history'); return null; }
}

let schedulerInterval: NodeJS.Timeout | null = null;

export function startDigestScheduler(): void {
  if (schedulerInterval || !areNotificationsEnabled()) return;
  const tick = () => { if (areNotificationsEnabled()) void processDigests().catch(() => {
    console.warn('[DigestScheduler] Digest scan unavailable');
  }); };
  schedulerInterval = setInterval(tick, 5 * 60_000);
  schedulerInterval.unref();
  tick();
}

export function stopDigestScheduler(): void {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = null;
}
