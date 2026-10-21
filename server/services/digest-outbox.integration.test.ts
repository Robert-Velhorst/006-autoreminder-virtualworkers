import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../../shared/isolatedPostgresTestDatabase.mjs';

const controls = vi.hoisted(() => ({ db: undefined as any, send: vi.fn() }));
vi.mock('../db', () => ({ getDb: async () => controls.db }));
vi.mock('./email', () => ({ sendEmailWithOutcome: controls.send }));
import { ScheduledJobLeaseLostError } from '../scheduledJobRuntime';
import { deliverDigestForUser, enqueueDigestNotification, getDigestJobForReview, listDigestJobsNeedingAttention,
  readQueuedDigestNotifications, reconcileDigestJob } from './digest-outbox';

const url = process.env.APTLSS_TEST_DATABASE_URL;
const now = new Date('2026-10-21T10:00:00Z');
const evidence = { note: 'Reviewed the operator delivery record', evidenceReference: 'operator-record:test-123' };

describe.skipIf(!url)('digest outbox full-migration native PostgreSQL', { timeout: 30_000 }, () => {
  let admin: Pool;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const privateName = `digest_outbox_${randomUUID().replaceAll('-', '')}`;
  let recipient: typeof schema.users.$inferSelect;
  let stranger: typeof schema.users.$inferSelect;
  const gates: Array<() => void> = [];

  beforeAll(async () => {
    requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === 'production');
    admin = new Pool({ connectionString: url!, max: 2 });
    // Only the generated private database is created/dropped; never the supplied fixture.
    if (!/^digest_outbox_[a-f0-9]{32}$/.test(privateName)) throw new Error('Invalid private fixture identity');
    await admin.query(`CREATE DATABASE "${privateName}"`);
    const privateUrl = new URL(url!); privateUrl.pathname = `/${privateName}`;
    pool = new Pool({ connectionString: privateUrl.href, max: 8, connectionTimeoutMillis: 10_000 });
    db = drizzle(pool, { schema }); controls.db = db;
    await migrate(db, { migrationsFolder: path.resolve('drizzle-postgres-v1') });
    const tables = await pool.query("select count(*)::integer as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
    expect(tables.rows[0].count).toBe(137);
  }, 125_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${privateName}"`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    controls.db = db; controls.send.mockReset(); controls.send.mockResolvedValue({ status: 'sent' });
    [recipient, stranger] = await db.insert(schema.users).values([
      { openId: `digest-${randomUUID()}`, role: 'admin', name: '<Owner>', email: 'owner@example.invalid' },
      { openId: `digest-${randomUUID()}`, role: 'admin', name: 'Other owner', email: 'other@example.invalid' },
    ]).returning();
    await db.insert(schema.userNotificationPreferences).values({ userId: recipient.id, userOpenId: recipient.openId,
      emailEnabled: 1, notificationMode: 'daily_digest', digestTimezone: 'UTC' });
  });
  afterEach(async () => {
    for (const release of gates.splice(0)) release();
    controls.db = db;
    // Each test owns distinct recipient IDs; leave all other test data untouched.
    const jobs = await db.select({ id: schema.digestJobs.id }).from(schema.digestJobs).where(eq(schema.digestJobs.userOpenId, recipient.openId));
    if (jobs.length) await db.delete(schema.digestJobItems).where(inArray(schema.digestJobItems.jobId, jobs.map(job => job.id)));
    await db.delete(schema.digestJobs).where(eq(schema.digestJobs.userOpenId, recipient.openId));
    await db.delete(schema.notificationHistory).where(eq(schema.notificationHistory.userOpenId, recipient.openId));
    await db.delete(schema.userNotificationPreferences).where(eq(schema.userNotificationPreferences.userOpenId, recipient.openId));
    await db.delete(schema.vaProfiles).where(eq(schema.vaProfiles.userId, recipient.id));
    await db.delete(schema.users).where(inArray(schema.users.id, [recipient.id, stranger.id]));
    const key = `digest:${createHash('sha256').update(recipient.openId).digest('hex')}`;
    await db.delete(schema.scheduledJobRuns).where(eq(schema.scheduledJobRuns.jobKey, key));
    await db.delete(schema.scheduledJobLeases).where(eq(schema.scheduledJobLeases.jobKey, key));
  });

  async function queue(count = 1) {
    return db.insert(schema.notificationHistory).values(Array.from({ length: count }, (_, index) => ({
      userId: recipient.id, userOpenId: recipient.openId, title: `Notice ${index} <script>secret()</script>`, content: 'Keep & review',
      notificationType: 'general' as const, channel: 'email' as const, deliveryStatus: 'queued_for_digest' as const,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }))).returning();
  }
  async function job(id: number) { return (await db.select().from(schema.digestJobs).where(eq(schema.digestJobs.id, id)))[0]; }
  async function uncertain() {
    await queue(); controls.send.mockResolvedValue({ status: 'uncertain', reason: 'Provider did not confirm' });
    return deliverDigestForUser(recipient.openId, { now });
  }

  it('freezes old backlog, bounds membership, and never acknowledges overflow or in-flight arrivals', async () => {
    const queued = await queue(103);
    controls.send.mockImplementation(async () => {
      await queue(); return { status: 'sent' };
    });
    const sent = await deliverDigestForUser(recipient.openId, { now });
    expect(sent).toMatchObject({ state: 'sent', count: 100 });
    const items = await db.select().from(schema.digestJobItems).where(eq(schema.digestJobItems.jobId, sent.jobId!));
    expect(items.map(item => item.notificationId).sort((a, b) => a - b)).toEqual(queued.slice(0, 100).map(row => row.id));
    const history = await db.select().from(schema.notificationHistory).where(eq(schema.notificationHistory.userOpenId, recipient.openId));
    expect(history.filter(row => row.deliveryStatus === 'sent')).toHaveLength(100);
    expect(await readQueuedDigestNotifications(recipient.openId)).toHaveLength(4);
    expect(await deliverDigestForUser(recipient.openId, { now })).toMatchObject({ state: 'skipped', count: 0 });
    expect(controls.send).toHaveBeenCalledOnce();
    expect(controls.send.mock.calls[0][0].html).not.toContain('<script>');
  });

  it('does not consume a daily window when empty', async () => {
    expect(await deliverDigestForUser(recipient.openId, { now })).toMatchObject({ state: 'empty', count: 0 });
    await queue(); expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('sent');
  });

  it('serializes concurrent triggers and rejects recovery while a dispatch lease is active', async () => {
    await queue();
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); gates.push(release);
    controls.send.mockImplementation(async () => { started(); await wait; return { status: 'sent' }; });
    const first = deliverDigestForUser(recipient.openId, { now }); await entered;
    const [active] = await db.select().from(schema.digestJobs).where(eq(schema.digestJobs.userOpenId, recipient.openId));
    expect((await listDigestJobsNeedingAttention(recipient.id))[0].reason).toBe('dispatch_in_progress');
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('skipped');
    await expect(reconcileDigestJob(active.id, recipient.id, { outcome: 'retry', ...evidence, acknowledgeDuplicateRisk: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    release(); expect((await first).state).toBe('sent'); expect(controls.send).toHaveBeenCalledOnce();
  });

  it('retries only definitely-not-sent outcomes, with backoff, frozen content and a monotonic bounded attempt count', async () => {
    await queue(); controls.send.mockResolvedValue({ status: 'not_sent', reason: 'Provider disabled' });
    const first = await deliverDigestForUser(recipient.openId, { now });
    expect(first.state).toBe('not_sent');
    const frozen = await job(first.jobId!);
    await deliverDigestForUser(recipient.openId, { now }); expect(controls.send).toHaveBeenCalledOnce();
    for (let i = 1; i < 5; i++) await deliverDigestForUser(recipient.openId, { now: new Date(now.getTime() + i * 3_600_000) });
    expect((await job(first.jobId!)).attemptCount).toBe(5); expect(controls.send).toHaveBeenCalledTimes(5);
    await deliverDigestForUser(recipient.openId, { now: new Date(now.getTime() + 10 * 3_600_000) });
    expect(controls.send).toHaveBeenCalledTimes(5);
    await reconcileDigestJob(first.jobId!, recipient.id, { outcome: 'retry', ...evidence });
    controls.send.mockResolvedValue({ status: 'sent' });
    expect((await deliverDigestForUser(recipient.openId, { now: new Date(now.getTime() + 11 * 3_600_000) })).state).toBe('sent');
    expect((await job(first.jobId!)).attemptCount).toBe(6);
    expect(controls.send.mock.calls.every(([message]) => message.html === frozen.html && message.to === frozen.recipientEmail)).toBe(true);
  });

  it('never replays uncertain membership, including on the next local day', async () => {
    const held = await uncertain(); await queue();
    expect((await deliverDigestForUser(recipient.openId, { now: new Date('2026-10-22T10:00:00Z') })).state).toBe('uncertain');
    expect(controls.send).toHaveBeenCalledOnce();
    expect(await readQueuedDigestNotifications(recipient.openId)).toHaveLength(2);
    expect((await job(held.jobId!)).deliveryPhase).toBe('uncertain');
  });

  it('retains a dispatch marker after interrupted ownership and refuses automatic replay after restart', async () => {
    await queue(); controls.send.mockRejectedValue(new ScheduledJobLeaseLostError());
    await expect(deliverDigestForUser(recipient.openId, { now })).rejects.toBeInstanceOf(ScheduledJobLeaseLostError);
    const [interrupted] = await db.select().from(schema.digestJobs).where(eq(schema.digestJobs.userOpenId, recipient.openId));
    expect(interrupted.deliveryPhase).toBe('dispatching');
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('uncertain');
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it('holds an expired in-flight attempt and fences its late acceptance without another provider call', async () => {
    await queue();
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); gates.push(release);
    controls.send.mockImplementation(async () => { started(); await wait; return { status: 'sent' }; });
    const original = deliverDigestForUser(recipient.openId, { now }).then(value => ({ value }), error => ({ error }));
    await entered;
    const key = `digest:${createHash('sha256').update(recipient.openId).digest('hex')}`;
    await pool.query('update scheduled_job_leases set "leaseExpiresAt" = clock_timestamp() - interval \'1 second\' where "jobKey" = $1', [key]);
    expect((await listDigestJobsNeedingAttention(recipient.id))[0].reason).toBe('delivery_requires_reconciliation');
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('uncertain');
    release(); expect(await original).toHaveProperty('error');
    expect(controls.send).toHaveBeenCalledOnce();
    expect(await readQueuedDigestNotifications(recipient.openId)).toHaveLength(1);
  });

  it('rolls back exact acknowledgement if a member is no longer queued', async () => {
    const rows = await queue(2);
    controls.send.mockImplementation(async () => {
      await db.update(schema.notificationHistory).set({ deliveryStatus: 'failed' }).where(eq(schema.notificationHistory.id, rows[1].id));
      return { status: 'sent' };
    });
    await expect(deliverDigestForUser(recipient.openId, { now })).rejects.toThrow('membership mismatch');
    expect((await db.select().from(schema.notificationHistory).where(eq(schema.notificationHistory.id, rows[0].id)))[0].deliveryStatus).toBe('queued_for_digest');
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('uncertain');
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it('rejects claimed-history deletion via the real restrictive foreign key', async () => {
    const held = await uncertain();
    const [item] = await db.select().from(schema.digestJobItems).where(eq(schema.digestJobItems.jobId, held.jobId!));
    await expect(db.delete(schema.notificationHistory).where(eq(schema.notificationHistory.id, item.notificationId))).rejects.toThrow();
  });

  it('enforces scoped recovery, records attestation without fabricating a receipt, and sends nothing during recovery', async () => {
    const held = await uncertain();
    await expect(reconcileDigestJob(held.jobId!, stranger.id, { outcome: 'sent', ...evidence })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'retry', ...evidence })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const recovered = await reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'sent', ...evidence });
    expect(recovered).toMatchObject({ state: 'sent', reconciled: true, reconciliationOutcome: 'sent' });
    expect(controls.send).toHaveBeenCalledOnce();
    const saved = await job(held.jobId!);
    expect(saved.reconciledBy).toBe(recipient.id); expect(saved.reconciliationNote).toContain(evidence.evidenceReference);
    expect(saved.providerReceipt).toBeNull(); expect(saved.deliveryPhase).toBe('sent');
    const repeated = await reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'sent', ...evidence });
    expect(repeated).toMatchObject({ state: 'skipped', count: 0 });
    expect(repeated).not.toHaveProperty('reconciled'); expect(repeated).not.toHaveProperty('reconciliationOutcome');
  });

  it.each([{ note: 'short', evidenceReference: 'valid' }, { note: evidence.note, evidenceReference: 'x' }])('validates recovery evidence in the direct helper: %j', async invalid => {
    const held = await uncertain();
    await expect(reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'sent', ...invalid })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('offers audited address replacement without altering or falsely completing the original frozen payload', async () => {
    await queue(3);
    const held = await uncertain(); const original = await job(held.jobId!);
    const originalItems = await db.select().from(schema.digestJobItems).where(eq(schema.digestJobItems.jobId, original.id));
    const originalIds = originalItems.map(item => item.notificationId).sort((a, b) => a - b);
    await db.update(schema.userNotificationPreferences).set({ emailAddress: 'new@example.invalid' }).where(eq(schema.userNotificationPreferences.userId, recipient.id));
    expect((await listDigestJobsNeedingAttention(recipient.id))[0].reason).toBe('delivery_requires_reconciliation');
    const replacement = await reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'retry', ...evidence, acknowledgeDuplicateRisk: true });
    expect(replacement).toMatchObject({ reconciled: true, reconciliationOutcome: 'retry' });
    expect(replacement.jobId).not.toBe(held.jobId); expect(controls.send).toHaveBeenCalledOnce();
    const cancelled = await job(held.jobId!); expect(cancelled.deliveryPhase).toBe('cancelled');
    expect(cancelled.html).toBe(original.html); expect(cancelled.recipientEmail).toBe(original.recipientEmail); expect(cancelled.completedAt).toBeNull();
    const audit = cancelled.reconciliationNote!.split('\n').map(line => JSON.parse(line));
    const replacementRecord = audit.find(entry => entry.eventType === 'recipient_replacement');
    expect(replacementRecord).toMatchObject({ version: 1, originalJobId: original.id, notificationIds: originalIds,
      originalPayloadHash: original.payloadHash, originalRecipient: original.recipientEmail, replacementJobId: replacement.jobId,
      actorUserId: recipient.id, evidenceReference: evidence.evidenceReference, acknowledgeDuplicateRisk: true });
    expect(createHash('sha256').update(JSON.stringify({ recipientEmail: replacementRecord.originalRecipient,
      subject: cancelled.subject, html: cancelled.html, notificationIds: replacementRecord.notificationIds })).digest('hex'))
      .toBe(replacementRecord.originalPayloadHash);
    expect(await db.select().from(schema.digestJobItems).where(eq(schema.digestJobItems.jobId, original.id))).toEqual([]);
    const historical = await getDigestJobForReview(original.id, recipient.id);
    expect(historical).toMatchObject({ notificationIds: originalIds, payloadHash: original.payloadHash,
      recipientEmail: original.recipientEmail, deliveryPhase: 'cancelled', integrityVerified: true });
    expect((await readQueuedDigestNotifications(recipient.openId)).map(row => row.id)).toEqual(originalIds);
    expect((await job(replacement.jobId!)).recipientEmail).toBe('new@example.invalid');
    controls.send.mockResolvedValue({ status: 'sent' });
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('sent');
    expect(controls.send.mock.calls[1][0].to).toBe('new@example.invalid');
  });

  it('refuses cancelled historical review when structured original membership is missing or corrupted', async () => {
    const held = await uncertain();
    await db.update(schema.userNotificationPreferences).set({ emailAddress: 'new@example.invalid' }).where(eq(schema.userNotificationPreferences.userId, recipient.id));
    await reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'retry', ...evidence, acknowledgeDuplicateRisk: true });
    const cancelled = await job(held.jobId!);
    const audit = cancelled.reconciliationNote!.split('\n').map(line => JSON.parse(line));
    audit.find(entry => entry.eventType === 'recipient_replacement').originalPayloadHash = '0'.repeat(64);
    await db.update(schema.digestJobs).set({ reconciliationNote: audit.map(entry => JSON.stringify(entry)).join('\n') })
      .where(eq(schema.digestJobs.id, cancelled.id));
    await expect(getDigestJobForReview(cancelled.id, recipient.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.update(schema.digestJobs).set({ reconciliationNote: 'Replaced job; notification IDs: 1,2,3' })
      .where(eq(schema.digestJobs.id, cancelled.id));
    await expect(getDigestJobForReview(cancelled.id, recipient.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await job(cancelled.id)).completedAt).toBeNull();
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it('recovers an address-changed definitely-unsent batch without falsely acknowledging it or needing duplicate-risk attestation', async () => {
    await queue(); controls.send.mockResolvedValue({ status: 'not_sent', reason: 'Provider disabled' });
    const held = await deliverDigestForUser(recipient.openId, { now });
    await db.update(schema.userNotificationPreferences).set({ emailAddress: 'new@example.invalid' }).where(eq(schema.userNotificationPreferences.userId, recipient.id));
    expect((await deliverDigestForUser(recipient.openId, { now: new Date(now.getTime() + 3_600_000) })).state).toBe('skipped');
    expect((await listDigestJobsNeedingAttention(recipient.id))[0].reason).toBe('recipient_address_changed');
    const replacement = await reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'retry', ...evidence });
    expect((await job(held.jobId!)).deliveryPhase).toBe('cancelled');
    expect((await job(replacement.jobId!)).deliveryPhase).toBe('prepared');
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it('scopes safe attention summaries and renders frozen review text without raw HTML or active content', async () => {
    const held = await uncertain();
    expect(await listDigestJobsNeedingAttention(stranger.id)).toEqual([]);
    await expect(getDigestJobForReview(held.jobId!, stranger.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const summary = (await listDigestJobsNeedingAttention(recipient.id))[0];
    for (const key of ['html', 'recipientEmail', 'subject', 'content', 'error']) expect(summary).not.toHaveProperty(key);
    const review = await getDigestJobForReview(held.jobId!, recipient.id);
    expect(review).not.toHaveProperty('html'); expect(review.notificationIds).toHaveLength(1);
    expect(review.text).toContain('Keep & review');
    expect(review.textTruncated).toBe(false); expect(review.integrityVerified).toBe(true);
  });

  it('rejects review or dispatch of a frozen payload whose hash no longer matches', async () => {
    const held = await uncertain();
    await db.update(schema.digestJobs).set({ html: '<p>Tampered</p>' }).where(eq(schema.digestJobs.id, held.jobId!));
    await expect(getDigestJobForReview(held.jobId!, recipient.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(reconcileDigestJob(held.jobId!, recipient.id, { outcome: 'retry', ...evidence, acknowledgeDuplicateRisk: true })).rejects.toThrow('integrity');
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it('bounds review text and skips script/style/image contents and link destinations', async () => {
    const held = await uncertain();
    const saved = await job(held.jobId!);
    const [item] = await db.select().from(schema.digestJobItems).where(eq(schema.digestJobItems.jobId, saved.id));
    const html = '<p>Visible</p><script>SECRET_SCRIPT</script><style>SECRET_STYLE</style><img alt="SECRET_IMAGE" src="https://secret.invalid"><a href="https://secret.invalid">Review</a><p>' + 'x'.repeat(33_000) + '</p>';
    const hash = createHash('sha256').update(JSON.stringify({ recipientEmail: saved.recipientEmail,
      subject: saved.subject, html, notificationIds: [item.notificationId] })).digest('hex');
    await db.update(schema.digestJobs).set({ html, payloadHash: hash }).where(eq(schema.digestJobs.id, saved.id));
    const preview = await getDigestJobForReview(saved.id, recipient.id);
    expect(preview.text).toHaveLength(32_000); expect(preview.textTruncated).toBe(true);
    expect(preview.text).not.toMatch(/SECRET_|https:\/\/secret/); expect(preview.text).toContain('Visible');
  });

  it('keeps consent-revoked queued membership intact and resumes it only after persisted consent returns', async () => {
    await queue(); controls.send.mockResolvedValue({ status: 'not_sent', reason: 'Provider disabled' });
    const held = await deliverDigestForUser(recipient.openId, { now });
    await db.update(schema.userNotificationPreferences).set({ emailEnabled: 0 }).where(eq(schema.userNotificationPreferences.userId, recipient.id));
    expect((await deliverDigestForUser(recipient.openId, { now: new Date(now.getTime() + 3_600_000) })).state).toBe('skipped');
    expect((await listDigestJobsNeedingAttention(recipient.id))[0].reason).toBe('recipient_consent_required');
    expect(controls.send).toHaveBeenCalledOnce();
    await db.update(schema.userNotificationPreferences).set({ emailEnabled: 1 }).where(eq(schema.userNotificationPreferences.userId, recipient.id));
    controls.send.mockResolvedValue({ status: 'sent' });
    expect(await deliverDigestForUser(recipient.openId, { now: new Date(now.getTime() + 3_600_000) })).toMatchObject({ state: 'sent', jobId: held.jobId });
  });

  it('allows only the canonical worker founder to review/reconcile a different recipient', async () => {
    await db.update(schema.users).set({ role: 'worker' }).where(eq(schema.users.id, recipient.id));
    await db.insert(schema.vaProfiles).values({ userId: recipient.id, founderId: stranger.id, name: 'Worker' });
    const held = await uncertain();
    expect((await listDigestJobsNeedingAttention(stranger.id)).map(row => row.id)).toContain(held.jobId);
    expect((await getDigestJobForReview(held.jobId!, stranger.id)).id).toBe(held.jobId);
    await db.insert(schema.vaProfiles).values({ userId: recipient.id, founderId: stranger.id, name: 'Ambiguous worker' });
    expect(await listDigestJobsNeedingAttention(stranger.id)).toEqual([]);
    await expect(getDigestJobForReview(held.jobId!, stranger.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['missing', 'inactive', 'ambiguous', 'foreign'] as const)('holds offboarded/invalid worker privacy boundary: %s profile', async kind => {
    await db.update(schema.users).set({ role: 'worker' }).where(eq(schema.users.id, recipient.id));
    const profiles = kind === 'inactive' ? [{ userId: recipient.id, founderId: stranger.id, name: 'Worker', status: 'inactive' as const }]
      : kind === 'ambiguous' ? Array.from({ length: 2 }, () => ({ userId: recipient.id, founderId: stranger.id, name: 'Worker', status: 'active' as const }))
        : kind === 'foreign' ? [{ userId: stranger.id, founderId: stranger.id, name: 'Unrelated active profile', status: 'active' as const }] : [];
    const inserted = profiles.length ? await db.insert(schema.vaProfiles).values(profiles).returning() : [];
    await queue();
    const input = { userId: recipient.id, userOpenId: recipient.openId, title: 'New task', content: 'Private work', notificationType: 'general' as const };
    expect(await enqueueDigestNotification(input)).toBeNull();
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('skipped');
    expect(controls.send).not.toHaveBeenCalled();
    expect(await readQueuedDigestNotifications(recipient.openId)).toHaveLength(1);
    if (kind === 'inactive') await db.update(schema.vaProfiles).set({ status: 'active' }).where(eq(schema.vaProfiles.id, inserted[0].id));
    else if (kind === 'ambiguous') await db.update(schema.vaProfiles).set({ status: 'inactive' }).where(eq(schema.vaProfiles.id, inserted[1].id));
    else await db.insert(schema.vaProfiles).values({ userId: recipient.id, founderId: stranger.id, name: 'Canonical active worker', status: 'active' });
    expect(await enqueueDigestNotification(input)).toEqual(expect.any(Number));
    expect(await deliverDigestForUser(recipient.openId, { now })).toMatchObject({ state: 'sent', count: 2 });
    expect(controls.send).toHaveBeenCalledOnce();
    if (kind === 'foreign') await db.delete(schema.vaProfiles).where(eq(schema.vaProfiles.id, inserted[0].id));
  });

  it('retains historical review for the founder but rejects retry authorization while the worker is inactive', async () => {
    await db.update(schema.users).set({ role: 'worker' }).where(eq(schema.users.id, recipient.id));
    const [profile] = await db.insert(schema.vaProfiles).values({ userId: recipient.id, founderId: stranger.id, name: 'Worker' }).returning();
    const held = await uncertain();
    await db.update(schema.vaProfiles).set({ status: 'inactive' }).where(eq(schema.vaProfiles.id, profile.id));
    expect((await getDigestJobForReview(held.jobId!, stranger.id)).id).toBe(held.jobId);
    await expect(reconcileDigestJob(held.jobId!, stranger.id, { outcome: 'retry', ...evidence, acknowledgeDuplicateRisk: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await job(held.jobId!)).deliveryPhase).toBe('uncertain');
    expect(controls.send).toHaveBeenCalledOnce();
    await db.update(schema.vaProfiles).set({ status: 'active' }).where(eq(schema.vaProfiles.id, profile.id));
    await reconcileDigestJob(held.jobId!, stranger.id, { outcome: 'retry', ...evidence, acknowledgeDuplicateRisk: true });
    controls.send.mockResolvedValue({ status: 'sent' });
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('sent');
  });

  it('rejects a generic non-operator user even with consent and an active profile', async () => {
    await db.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id, recipient.id));
    await db.insert(schema.vaProfiles).values({ userId: recipient.id, founderId: stranger.id, name: 'Not an operator' });
    await queue();
    expect(await enqueueDigestNotification({ userId: recipient.id, userOpenId: recipient.openId,
      title: 'Private task', content: 'Do not send', notificationType: 'general' })).toBeNull();
    expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('skipped');
    expect(controls.send).not.toHaveBeenCalled();
    expect(await readQueuedDigestNotifications(recipient.openId)).toHaveLength(1);
  });

  it('rechecks worker activation after the durable marker commits and before any provider call', async () => {
    await db.update(schema.users).set({ role: 'worker' }).where(eq(schema.users.id, recipient.id));
    await db.insert(schema.vaProfiles).values({ userId: recipient.id, founderId: stranger.id, name: 'Worker' });
    await queue();
    // A native trigger deterministically offboards between the committed marker and the final check.
    await pool.query(`CREATE FUNCTION digest_test_offboard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE va_profiles SET status = 'inactive' WHERE "userId" = (SELECT id FROM users WHERE "openId" = NEW."userOpenId");
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER digest_test_offboard AFTER UPDATE OF "deliveryPhase" ON digest_jobs
      FOR EACH ROW WHEN (NEW."deliveryPhase" = 'dispatching') EXECUTE FUNCTION digest_test_offboard()`);
    try {
      const stopped = await deliverDigestForUser(recipient.openId, { now });
      expect(stopped.state).toBe('not_sent');
      expect(controls.send).not.toHaveBeenCalled();
      expect((await job(stopped.jobId!)).deliveryPhase).toBe('not_sent');
      expect(await readQueuedDigestNotifications(recipient.openId)).toHaveLength(1);
      expect((await listDigestJobsNeedingAttention(stranger.id))[0].reason).toBe('active_worker_profile_required');
    } finally {
      await pool.query('DROP TRIGGER digest_test_offboard ON digest_jobs');
      await pool.query('DROP FUNCTION digest_test_offboard()');
    }
  });

  it.each(['pending', 'processing', 'failed'] as const)('holds legacy %s jobs with unknown membership rather than replaying queued rows', async status => {
    await queue();
    const [legacy] = await db.insert(schema.digestJobs).values({ userOpenId: recipient.openId, status, scheduledFor: now }).returning();
    const held = await deliverDigestForUser(recipient.openId, { now });
    expect(held).toMatchObject({ state: 'skipped', count: 0, jobId: legacy.id }); expect(controls.send).not.toHaveBeenCalled();
    expect(await db.select().from(schema.digestJobItems).where(eq(schema.digestJobItems.jobId, legacy.id))).toEqual([]);
    expect((await listDigestJobsNeedingAttention(recipient.id))[0]).toMatchObject({ legacyIncomplete: true, reason: 'legacy_membership_unknown' });
    await expect(reconcileDigestJob(legacy.id, recipient.id, { outcome: 'sent', ...evidence })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not hold a recipient merely because completed legacy history exists', async () => {
    await db.insert(schema.digestJobs).values({ userOpenId: recipient.openId, status: 'completed', scheduledFor: now });
    await queue(); expect((await deliverDigestForUser(recipient.openId, { now })).state).toBe('sent');
  });

  it('enqueues canonical persisted digest mode only', async () => {
    expect(await enqueueDigestNotification({ userId: stranger.id, userOpenId: recipient.openId, title: 'No', content: 'No', notificationType: 'general' })).toBeNull();
    expect(await enqueueDigestNotification({ userId: recipient.id, userOpenId: recipient.openId, title: 'Yes', content: 'Persist', notificationType: 'general' })).toEqual(expect.any(Number));
  });
});
