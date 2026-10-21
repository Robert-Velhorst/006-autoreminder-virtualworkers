import { createHash, randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { convert } from 'html-to-text';
import { and, asc, eq, exists, inArray, isNotNull, isNull, notExists, notInArray, or, sql } from 'drizzle-orm';
import { digestJobItems, digestJobs, notificationHistory, scheduledJobLeases, userNotificationPreferences, users, vaProfiles } from '../../drizzle/schema.postgres';
import { dateKeyInTimeZone } from '../../shared/workerTime';
import { getDb } from '../db';
import { getActiveWorkerProfileId } from '../workerOperatorContext';
import { runScheduledJob, ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobTransaction, type ScheduledJobTrigger } from '../scheduledJobRuntime';
import { sendEmailWithOutcome } from './email';
import { hasPersistedEmailConsent } from './recipientEmailConsent';

export type DigestDeliveryResult = {
  state: 'sent' | 'not_sent' | 'uncertain' | 'empty' | 'skipped';
  jobId?: number;
  count: number;
  reason?: string;
  reconciled?: true;
  reconciliationOutcome?: 'sent' | 'retry';
};
export type DigestNotificationInput = {
  userId: number;
  userOpenId: string;
  title: string;
  content: string;
  notificationType: 'task_assigned' | 'task_due_soon' | 'task_overdue' | 'task_completed' | 'general';
  taskId?: string;
  taskName?: string;
  dueDate?: Date | string | null;
};

type Job = typeof digestJobs.$inferSelect;
const MAX_BATCH = 100;
const MAX_ATTEMPTS = 5;
const backoffMs = (attempt: number) => Math.min(3_600_000, 60_000 * 2 ** Math.min(10, Math.max(0, attempt - 1)));
const digestLeaseKey = (openId: string) => `digest:${createHash('sha256').update(openId).digest('hex')}`;
const result = (state: DigestDeliveryResult['state'], job?: Job, reason?: string): DigestDeliveryResult => ({
  state, ...(job ? { jobId: job.id } : {}), count: state === 'skipped' ? 0 : job?.notificationCount ?? 0, ...(reason ? { reason } : {}),
});
const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'Digest job not found' });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function payloadHash(job: Pick<Job, 'recipientEmail' | 'subject' | 'html'>, ids: number[]) {
  return createHash('sha256').update(JSON.stringify({
    recipientEmail: job.recipientEmail, subject: job.subject, html: job.html,
    notificationIds: [...ids].sort((a, b) => a - b),
  })).digest('hex');
}

function originalReplacementMembers(job: Job): number[] {
  const snapshots: number[][] = [];
  for (const line of (job.reconciliationNote ?? '').split('\n')) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.version !== 1 || entry.eventType !== 'recipient_replacement' || entry.originalJobId !== job.id) continue;
    const ids = entry.notificationIds;
    if (!Array.isArray(ids) || ids.length !== job.notificationCount || ids.length < 1 || ids.length > MAX_BATCH
      || !ids.every(id => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length
      || entry.originalPayloadHash !== job.payloadHash || entry.originalRecipient !== job.recipientEmail
      || !Number.isSafeInteger(entry.replacementJobId) || entry.replacementJobId <= 0 || entry.replacementJobId === job.id
      || payloadHash(job, ids) !== job.payloadHash) {
      throw new Error('Historical digest membership integrity check failed');
    }
    snapshots.push(ids);
  }
  if (snapshots.length !== 1) throw new Error('Historical digest membership snapshot is unavailable or ambiguous');
  return [...snapshots[0]].sort((a, b) => a - b);
}

async function database() {
  const db = await getDb();
  if (!db) throw new Error('Database unavailable for digest delivery');
  return db;
}

async function identity(tx: ScheduledJobTransaction, openId: string) {
  const [user] = await tx.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (!user) return null;
  const [preferences] = await tx.select().from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userOpenId, openId)).limit(1).for('update');
  const workerEligible = user.role === 'admin'
    || (user.role === 'worker' && await getActiveWorkerProfileId(user.id, tx) !== null);
  return { user, preferences: preferences?.userId === user.id ? preferences : undefined, workerEligible };
}

function consenting(preferences: typeof userNotificationPreferences.$inferSelect | undefined) {
  return hasPersistedEmailConsent(preferences) && preferences?.notificationMode === 'daily_digest';
}

export async function readQueuedDigestNotifications(userOpenId: string) {
  const db = await database();
  const [user] = await db.select().from(users).where(eq(users.openId, userOpenId)).limit(1);
  if (!user) return [];
  return db.select().from(notificationHistory).where(and(
    eq(notificationHistory.userId, user.id), eq(notificationHistory.userOpenId, user.openId),
    eq(notificationHistory.deliveryStatus, 'queued_for_digest'),
  )).orderBy(asc(notificationHistory.createdAt), asc(notificationHistory.id));
}

export async function enqueueDigestNotification(input: DigestNotificationInput): Promise<number | null> {
  if (!input || !Number.isSafeInteger(input.userId) || input.userId <= 0
    || typeof input.userOpenId !== 'string' || !input.userOpenId.length || input.userOpenId.length > 64
    || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500
    || typeof input.content !== 'string' || input.content.length > 20_000
    || !['task_assigned', 'task_due_soon', 'task_overdue', 'task_completed', 'general'].includes(input.notificationType)
    || (input.taskId !== undefined && (typeof input.taskId !== 'string' || input.taskId.length > 128))
    || (input.taskName !== undefined && (typeof input.taskName !== 'string' || input.taskName.length > 500))) return null;
  try {
    const db = await database();
    return await db.transaction(async tx => {
      const recipient = await identity(tx, input.userOpenId);
      if (!recipient || recipient.user.id !== input.userId || !recipient.workerEligible || !consenting(recipient.preferences)) return null;
      const dueDate = input.dueDate == null ? null : new Date(input.dueDate);
      if (dueDate && Number.isNaN(dueDate.getTime())) return null;
      const [row] = await tx.insert(notificationHistory).values({
        userId: recipient.user.id, userOpenId: recipient.user.openId,
        title: input.title, content: input.content, notificationType: input.notificationType,
        taskId: input.taskId ?? null, taskName: input.taskName ?? null, dueDate,
        channel: 'email', deliveryStatus: 'queued_for_digest',
      }).returning({ id: notificationHistory.id });
      return row?.id ?? null;
    });
  } catch {
    return null;
  }
}

async function members(tx: ScheduledJobTransaction, job: Job) {
  const items = await tx.select({ notificationId: digestJobItems.notificationId }).from(digestJobItems)
    .where(eq(digestJobItems.jobId, job.id)).orderBy(asc(digestJobItems.notificationId));
  const ids = items.map(item => item.notificationId);
  if (!ids.length || ids.length !== job.notificationCount || ids.length > MAX_BATCH
    || !job.recipientEmail || !job.subject || !job.html || payloadHash(job, ids) !== job.payloadHash) {
    throw new Error('Digest batch integrity check failed');
  }
  return ids;
}

async function acknowledge(tx: ScheduledJobTransaction, context: ScheduledJobContext, job: Job, userId: number, now: Date) {
  await context.assertOwnership(tx);
  const ids = await members(tx, job);
  const updated = await tx.update(notificationHistory).set({ deliveryStatus: 'sent', deliveredAt: now })
    .where(and(inArray(notificationHistory.id, ids), eq(notificationHistory.userOpenId, job.userOpenId),
      eq(notificationHistory.userId, userId), eq(notificationHistory.deliveryStatus, 'queued_for_digest')))
    .returning({ id: notificationHistory.id });
  if (updated.length !== ids.length) throw new Error('Digest acknowledgement membership mismatch');
  await tx.update(digestJobs).set({ deliveryPhase: 'sent', status: 'completed', completedAt: now, nextAttemptAt: null, error: null })
    .where(eq(digestJobs.id, job.id));
  await tx.update(userNotificationPreferences).set({ lastDigestSent: now })
    .where(eq(userNotificationPreferences.userOpenId, job.userOpenId));
  await context.assertOwnership(tx);
}

async function prepare(tx: ScheduledJobTransaction, context: ScheduledJobContext, openId: string, now: Date) {
  await context.assertOwnership(tx);
  const recipient = await identity(tx, openId);
  if (!recipient) return { outcome: result('skipped', undefined, 'Recipient not found') };
  const [legacy] = await tx.select().from(digestJobs).where(and(eq(digestJobs.userOpenId, openId),
    isNull(digestJobs.deliveryPhase), inArray(digestJobs.status, ['pending', 'processing', 'failed'])))
    .orderBy(asc(digestJobs.id)).limit(1).for('update');
  if (legacy) return { outcome: result('skipped', legacy, 'Legacy delivery has unknown membership; source-specific operator review is required') };
  if (!recipient.workerEligible) return { outcome: result('skipped', undefined, 'An unambiguous active worker profile is required; queued rows retained') };
  const [unfinished] = await tx.select().from(digestJobs).where(and(eq(digestJobs.userOpenId, openId),
    isNotNull(digestJobs.deliveryPhase), notInArray(digestJobs.deliveryPhase, ['sent', 'cancelled'])))
    .orderBy(asc(digestJobs.createdAt), asc(digestJobs.id)).limit(1).for('update');
  if (unfinished) return { job: unfinished, recipient };
  if (!consenting(recipient.preferences)) return { outcome: result('skipped', undefined, 'Recipient has not enabled digest email') };
  const dateKey = dateKeyInTimeZone(now, recipient.preferences!.digestTimezone);
  const windowKey = `digest:${recipient.user.id}:${dateKey}`;
  const [existing] = await tx.select().from(digestJobs).where(eq(digestJobs.windowKey, windowKey)).limit(1);
  if (existing) return { outcome: result('skipped', existing, 'Delivery window already completed') };
  const queued = await tx.select().from(notificationHistory).where(and(
    eq(notificationHistory.userOpenId, openId), eq(notificationHistory.userId, recipient.user.id),
    eq(notificationHistory.deliveryStatus, 'queued_for_digest'),
    notExists(tx.select({ id: digestJobItems.id }).from(digestJobItems)
      .where(eq(digestJobItems.notificationId, notificationHistory.id))),
  )).orderBy(asc(notificationHistory.createdAt), asc(notificationHistory.id)).limit(MAX_BATCH).for('update');
  if (!queued.length) return { outcome: result('empty') };
  const email = recipient.preferences!.emailAddress || recipient.user.email;
  if (!email) return { outcome: result('skipped', undefined, 'Recipient has no email address') };
  const payload = {
    recipientEmail: email,
    subject: `Daily Task Digest - ${dateKey}`,
    html: `<h1>Daily Task Digest</h1><p>Hello ${escapeHtml(recipient.user.name || 'there')},</p><ul>${queued.map(row =>
      `<li><strong>${escapeHtml(row.taskName || row.title)}</strong><p>${escapeHtml(row.content)}</p>${row.dueDate ? `<p>Due: ${escapeHtml(row.dueDate.toISOString())}</p>` : ''}</li>`).join('')}</ul>`,
  };
  const [job] = await tx.insert(digestJobs).values({
    userOpenId: openId, scheduledFor: now, status: 'pending', deliveryPhase: 'prepared',
    windowKey, notificationCount: queued.length, ...payload,
    payloadHash: payloadHash(payload, queued.map(row => row.id)),
  }).returning();
  await tx.insert(digestJobItems).values(queued.map(row => ({ jobId: job.id, notificationId: row.id })));
  await context.assertOwnership(tx);
  return { job, recipient };
}

export async function deliverDigestForUser(
  userOpenId: string,
  options: { now?: Date; trigger?: ScheduledJobTrigger } = {},
): Promise<DigestDeliveryResult> {
  const db = await database();
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid digest time');
  let outcome = result('skipped', undefined, 'Digest lease is held');
  await runScheduledJob({ jobKey: digestLeaseKey(userOpenId), trigger: options.trigger, skipIfSuccessful: false }, async context => {
    const prepared = await db.transaction(tx => prepare(tx, context, userOpenId, now));
    if ('outcome' in prepared) { outcome = prepared.outcome!; return; }
    const { job } = prepared;
    if (job.deliveryPhase === 'dispatching' || job.deliveryPhase === 'uncertain') {
      await db.transaction(async tx => {
        await context.assertOwnership(tx);
        await tx.update(digestJobs).set({ deliveryPhase: 'uncertain', status: 'failed',
          error: 'Delivery may have occurred; operator reconciliation is required.' }).where(eq(digestJobs.id, job.id));
        await context.assertOwnership(tx);
      });
      outcome = result('uncertain', job, 'Operator reconciliation required; no resend attempted');
      return;
    }
    if (job.deliveryPhase !== 'prepared' && job.deliveryPhase !== 'not_sent') throw new Error('Invalid digest delivery phase');
    if (job.deliveryPhase === 'not_sent' && (job.attemptCount >= MAX_ATTEMPTS
      || (job.nextAttemptAt && job.nextAttemptAt > now))) {
      outcome = result('not_sent', job, job.attemptCount >= MAX_ATTEMPTS ? 'Retry limit reached; operator action required' : 'Retry backoff has not elapsed');
      return;
    }
    const attemptId = randomUUID();
    const dispatch = await db.transaction(async tx => {
      await context.assertOwnership(tx);
      const recipient = await identity(tx, userOpenId);
      if (!recipient || !recipient.workerEligible || !consenting(recipient.preferences)) return false;
      if ((recipient.preferences!.emailAddress || recipient.user.email) !== job.recipientEmail) return false;
      await members(tx, job);
      const changed = await tx.update(digestJobs).set({ deliveryPhase: 'dispatching', status: 'processing',
        attemptId, attemptCount: job.attemptCount + 1, attemptedAt: now, nextAttemptAt: null, error: null })
        .where(and(eq(digestJobs.id, job.id), eq(digestJobs.deliveryPhase, job.deliveryPhase!),
          eq(digestJobs.attemptCount, job.attemptCount))).returning({ id: digestJobs.id });
      if (changed.length !== 1) throw new Error('Digest dispatch claim changed');
      await context.assertOwnership(tx);
      return true;
    });
    if (!dispatch) { outcome = result('skipped', job, 'Recipient consent or address changed; batch retained'); return; }
    let delivery: Awaited<ReturnType<typeof sendEmailWithOutcome>>;
    try {
      await context.assertOwnership();
      const eligible = await db.transaction(async tx => {
        await context.assertOwnership(tx);
        const recipient = await identity(tx, userOpenId);
        const allowed = recipient?.workerEligible && consenting(recipient.preferences)
          && (recipient.preferences!.emailAddress || recipient.user.email) === job.recipientEmail;
        await context.assertOwnership(tx);
        return allowed;
      });
      delivery = eligible
        ? await sendEmailWithOutcome({ to: job.recipientEmail!, subject: job.subject!, html: job.html! }, context)
        : { status: 'not_sent', reason: 'Recipient consent, address, or active worker eligibility changed; no email was sent' };
    } catch (error) {
      if (error instanceof ScheduledJobLeaseLostError || context.signal.aborted) throw error;
      delivery = { status: 'uncertain', reason: 'Provider outcome was not recorded; reconciliation required' };
    }
    await db.transaction(async tx => {
      await context.assertOwnership(tx);
      const [current] = await tx.select().from(digestJobs).where(eq(digestJobs.id, job.id)).limit(1).for('update');
      if (!current || current.attemptId !== attemptId || current.deliveryPhase !== 'dispatching') throw new Error('Digest attempt ownership changed');
      if (delivery.status === 'sent') {
        await acknowledge(tx, context, current, prepared.recipient.user.id, now);
      } else {
        await tx.update(digestJobs).set({ deliveryPhase: delivery.status, status: 'failed', error: delivery.reason,
          nextAttemptAt: delivery.status === 'not_sent' && current.attemptCount < MAX_ATTEMPTS
            ? new Date(now.getTime() + backoffMs(current.attemptCount)) : null,
        }).where(eq(digestJobs.id, job.id));
      }
      await context.assertOwnership(tx);
    });
    outcome = result(delivery.status, job, delivery.status === 'sent' ? undefined : delivery.reason);
    return { recordsProcessed: delivery.status === 'sent' ? job.notificationCount : 0, detail: `Digest ${job.id}: ${delivery.status}` };
  });
  return outcome;
}

async function authorizeRecovery(tx: ScheduledJobTransaction, jobId: number, actorUserId: number) {
  const [actor] = await tx.select().from(users).where(eq(users.id, actorUserId)).limit(1);
  const [job] = await tx.select().from(digestJobs).where(eq(digestJobs.id, jobId)).limit(1);
  if (!actor || actor.role !== 'admin' || !job) throw notFound();
  const [recipient] = await tx.select().from(users).where(eq(users.openId, job.userOpenId)).limit(1);
  if (!recipient) throw notFound();
  if (recipient.id !== actor.id) {
    if (recipient.role !== 'worker') throw notFound();
    const profiles = await tx.select({ founderId: vaProfiles.founderId }).from(vaProfiles)
      .where(eq(vaProfiles.userId, recipient.id));
    if (profiles.length !== 1 || profiles[0].founderId !== actor.id) throw notFound();
  }
  return { job, recipient };
}

export async function reconcileDigestJob(
  jobId: number,
  actorUserId: number,
  input: { outcome: 'sent' | 'retry'; note: string; evidenceReference: string; acknowledgeDuplicateRisk?: boolean },
): Promise<DigestDeliveryResult> {
  const db = await database();
  const authorized = await db.transaction(tx => authorizeRecovery(tx, jobId, actorUserId));
  const note = input.note?.trim();
  const evidence = input.evidenceReference?.trim();
  if (!note || note.length < 10 || note.length > 2000 || !evidence || evidence.length < 3 || evidence.length > 1000
    || !['sent', 'retry'].includes(input.outcome)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Recovery requires a valid outcome, a 10-2000 character note, and a 3-1000 character evidence reference' });
  }
  let outcome = result('skipped', authorized.job, 'Digest lease is held; active dispatch cannot be reconciled');
  let recorded = false;
  const run = await runScheduledJob({ jobKey: digestLeaseKey(authorized.job.userOpenId), trigger: 'manual', skipIfSuccessful: false,
    initialDetail: `Digest reconciliation ${jobId} by actor ${actorUserId}` }, async context => {
    const committed = await db.transaction(async tx => {
      await context.assertOwnership(tx);
      const { job, recipient } = await authorizeRecovery(tx, jobId, actorUserId);
      await tx.select({ id: digestJobs.id }).from(digestJobs).where(eq(digestJobs.id, jobId)).for('update');
      if (!job.deliveryPhase) throw new TRPCError({ code: 'CONFLICT', message: 'Legacy digest has unknown membership; source-specific operator review is required' });
      if (job.deliveryPhase === 'sent' || job.deliveryPhase === 'cancelled') { outcome = result('skipped', job, 'Digest already finalized'); return; }
      if (!['prepared', 'dispatching', 'uncertain', 'not_sent'].includes(job.deliveryPhase ?? '')) {
        outcome = result('skipped', job, 'Digest has no recoverable dispatch attempt'); return;
      }
      if (input.outcome === 'retry' && ['dispatching', 'uncertain'].includes(job.deliveryPhase!) && input.acknowledgeDuplicateRisk !== true) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Retry requires explicit acknowledgement of duplicate-delivery risk' });
      }
      const reconciledAt = new Date();
      const auditRecord = { version: 1, eventType: 'reconciliation', actorUserId, timestamp: reconciledAt.toISOString(), outcome: input.outcome,
        note, evidenceReference: evidence, acknowledgeDuplicateRisk: input.acknowledgeDuplicateRisk === true,
        attestation: 'Operator attestation; not a provider-verified receipt' };
      const audit = JSON.stringify(auditRecord);
      let replacement: Job | undefined;
      if (input.outcome === 'sent') {
        if (job.deliveryPhase === 'prepared' || job.deliveryPhase === 'not_sent') {
          throw new TRPCError({ code: 'CONFLICT', message: 'A definitely unsent batch cannot be acknowledged as sent' });
        }
        await acknowledge(tx, context, job, recipient.id, reconciledAt);
      }
      else {
        const ids = await members(tx, job);
        const current = await identity(tx, job.userOpenId);
        if (!current || !current.workerEligible || !consenting(current.preferences)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Recipient must enable digest email and have an unambiguous active worker profile before retry authorization' });
        }
        const email = current.preferences!.emailAddress || current.user.email;
        if (!email) throw new TRPCError({ code: 'CONFLICT', message: 'Recipient has no current email address' });
        if (email !== job.recipientEmail) {
          const payload = { recipientEmail: email, subject: job.subject!, html: job.html! };
          [replacement] = await tx.insert(digestJobs).values({
            userOpenId: job.userOpenId, scheduledFor: reconciledAt, status: 'pending', deliveryPhase: 'prepared',
            windowKey: `digest-replacement:${job.id}:${randomUUID()}`, notificationCount: job.notificationCount,
            ...payload, payloadHash: payloadHash(payload, ids), reconciledAt, reconciledBy: actorUserId,
            reconciliationNote: audit,
          }).returning();
          const replacementAudit = JSON.stringify({ ...auditRecord, eventType: 'recipient_replacement',
            originalJobId: job.id, notificationIds: ids, originalPayloadHash: job.payloadHash,
            originalRecipient: job.recipientEmail, replacementJobId: replacement.id });
          // Preserve the original exact batch before moving its live membership.
          await tx.update(digestJobs).set({ deliveryPhase: 'cancelled', status: 'failed', nextAttemptAt: null,
            error: `Explicitly replaced by digest ${replacement.id}; not marked delivered`, reconciledAt, reconciledBy: actorUserId,
            reconciliationNote: [job.reconciliationNote, replacementAudit].filter(Boolean).join('\n'),
          }).where(eq(digestJobs.id, jobId));
          await tx.update(digestJobs).set({ reconciliationNote: replacementAudit }).where(eq(digestJobs.id, replacement.id));
          const moved = await tx.update(digestJobItems).set({ jobId: replacement.id })
            .where(eq(digestJobItems.jobId, jobId)).returning({ id: digestJobItems.id });
          if (moved.length !== ids.length) throw new Error('Digest replacement membership mismatch');
        } else {
          await tx.update(digestJobs).set({ deliveryPhase: 'prepared', status: 'pending', nextAttemptAt: null,
            error: null }).where(eq(digestJobs.id, jobId));
        }
      }
      if (!replacement) await tx.update(digestJobs).set({ reconciledAt, reconciledBy: actorUserId,
        reconciliationNote: [job.reconciliationNote, audit].filter(Boolean).join('\n'),
      }).where(eq(digestJobs.id, jobId));
      await context.assertOwnership(tx);
      outcome = result(input.outcome === 'sent' ? 'sent' : 'skipped', replacement ?? job,
        input.outcome === 'retry' ? 'Frozen batch authorized for retry; no send attempted'
          : 'Operator-attested delivery; not a provider-verified receipt');
      return true;
    });
    recorded = committed === true;
    return { detail: `Digest ${jobId} reconciliation: ${input.outcome}; actor ${actorUserId}; evidenceReference: ${evidence}; note: ${note}` };
  });
  if (run.state === 'skipped') throw new TRPCError({ code: 'CONFLICT', message: 'Digest dispatch is active; reconciliation is unavailable until its lease is released or expires' });
  return recorded ? { ...outcome, reconciled: true, reconciliationOutcome: input.outcome } : outcome;
}

export async function listDigestJobsNeedingAttention(actorUserId: number) {
  const db = await database();
  const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, actorUserId)).limit(1);
  if (actor?.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access required' });
  const rows = await db.select({
    id: digestJobs.id, userOpenId: digestJobs.userOpenId, deliveryPhase: digestJobs.deliveryPhase,
    status: digestJobs.status, notificationCount: digestJobs.notificationCount,
    attemptCount: digestJobs.attemptCount, attemptedAt: digestJobs.attemptedAt,
    nextAttemptAt: digestJobs.nextAttemptAt, completedAt: digestJobs.completedAt, reconciledAt: digestJobs.reconciledAt,
    addressChanged: sql<boolean>`coalesce(${userNotificationPreferences.emailAddress}, ${users.email}, '') <> coalesce(${digestJobs.recipientEmail}, '')`,
    consent: sql<boolean>`${userNotificationPreferences.userId} = ${users.id} and ${userNotificationPreferences.emailEnabled} = 1 and ${userNotificationPreferences.notificationMode} = 'daily_digest'`,
    workerEligible: sql<boolean>`${users.role} = 'admin' or (${users.role} = 'worker' and (select count(*) from ${vaProfiles} where ${vaProfiles.userId} = ${users.id} and ${vaProfiles.status} = 'active') = 1)`,
  }).from(digestJobs).innerJoin(users, eq(users.openId, digestJobs.userOpenId))
    .leftJoin(userNotificationPreferences, eq(userNotificationPreferences.userOpenId, users.openId))
    .where(and(or(inArray(digestJobs.deliveryPhase, ['prepared', 'dispatching', 'uncertain', 'not_sent']),
      and(isNull(digestJobs.deliveryPhase), inArray(digestJobs.status, ['pending', 'processing', 'failed']))),
      or(eq(users.id, actorUserId), and(eq(users.role, 'worker'),
        exists(db.select({ id: vaProfiles.id }).from(vaProfiles).where(and(eq(vaProfiles.userId, users.id), eq(vaProfiles.founderId, actorUserId)))),
        sql`(select count(*) from ${vaProfiles} where ${vaProfiles.userId} = ${users.id}) = 1`,
      )))).orderBy(asc(digestJobs.createdAt), asc(digestJobs.id)).limit(100);
  const leaseKeys = [...new Set(rows.filter(row => row.deliveryPhase === 'dispatching').map(row => digestLeaseKey(row.userOpenId)))];
  const leases = leaseKeys.length ? await db.select({ jobKey: scheduledJobLeases.jobKey }).from(scheduledJobLeases)
    .where(and(inArray(scheduledJobLeases.jobKey, leaseKeys), sql`${scheduledJobLeases.leaseExpiresAt} > clock_timestamp()`)) : [];
  const live = new Set(leases.map(lease => lease.jobKey));
  return rows.map(({ addressChanged, consent, workerEligible, ...row }) => ({ ...row,
    legacyIncomplete: row.deliveryPhase === null,
    reason: row.deliveryPhase === null ? 'legacy_membership_unknown'
      : row.deliveryPhase === 'dispatching' && live.has(digestLeaseKey(row.userOpenId)) ? 'dispatch_in_progress'
        : row.deliveryPhase === 'dispatching' || row.deliveryPhase === 'uncertain' ? 'delivery_requires_reconciliation'
      : !workerEligible ? 'active_worker_profile_required'
        : !consent ? 'recipient_consent_required' : addressChanged ? 'recipient_address_changed'
        : row.attemptCount >= MAX_ATTEMPTS && row.deliveryPhase === 'not_sent' ? 'retry_limit_reached'
          : row.deliveryPhase === 'not_sent' ? 'retry_backoff' : 'prepared',
  }));
}

export async function getDigestJobForReview(jobId: number, actorUserId: number) {
  const db = await database();
  return db.transaction(async tx => {
    const { job } = await authorizeRecovery(tx, jobId, actorUserId);
    const items = await tx.select({ notificationId: digestJobItems.notificationId }).from(digestJobItems)
      .where(eq(digestJobItems.jobId, job.id)).orderBy(asc(digestJobItems.notificationId));
    let notificationIds = items.map(item => item.notificationId);
    let integrityVerified = false;
    if (job.deliveryPhase) {
      try {
        if (job.deliveryPhase === 'cancelled') {
          if (items.length) throw new Error('Cancelled digest retains unexpected live membership');
          notificationIds = originalReplacementMembers(job);
        } else await members(tx, job);
        integrityVerified = true;
      }
      catch { throw new TRPCError({ code: 'CONFLICT', message: 'Digest payload integrity cannot be verified; source-specific operator review is required' }); }
    }
    const converted = convert(job.html ?? '', { wordwrap: false, selectors: [
      { selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' },
      { selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } },
    ] });
    return { id: job.id, recipientEmail: job.recipientEmail, subject: job.subject, text: converted.slice(0, 32_000),
      textTruncated: converted.length > 32_000, integrityVerified,
      notificationIds, deliveryPhase: job.deliveryPhase,
      attemptCount: job.attemptCount, attemptedAt: job.attemptedAt, payloadHash: job.payloadHash,
      legacyIncomplete: job.deliveryPhase === null };
  });
}
