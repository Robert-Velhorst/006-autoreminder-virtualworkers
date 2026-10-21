import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const controls = vi.hoisted(() => ({ db: vi.fn(), deliver: vi.fn(), enqueue: vi.fn(), read: vi.fn() }));
vi.mock('../../db', () => ({ getDb: controls.db }));
vi.mock('../digest-outbox', () => ({ deliverDigestForUser: controls.deliver,
  enqueueDigestNotification: controls.enqueue, readQueuedDigestNotifications: controls.read }));
import { isDigestDue, processDigests, queueNotificationForDigest, sendDigestToUser,
  startDigestScheduler, stopDigestScheduler } from '../digest-scheduler';

const now = new Date('2026-10-21T12:00:00Z');
const schedule = { digestTime: '08:00', digestTimezone: 'Europe/Amsterdam', lastDigestSent: null as Date | null };
function database(rows: any[]) {
  const where = vi.fn(async () => rows.map(row => ({ notificationMode: 'daily_digest', ...row })));
  controls.db.mockResolvedValue({ select: () => ({ from: () => ({ where }) }) });
  return where;
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NOTIFICATIONS_ENABLED', 'true'); });
afterEach(() => { stopDigestScheduler(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('recipient-local digest eligibility', () => {
  it('does not send early, but catches up after restart later on the same day', () => {
    expect(isDigestDue(schedule, new Date('2026-10-21T05:59:00Z'))).toBe(false);
    expect(isDigestDue(schedule, now)).toBe(true);
    expect(isDigestDue({ ...schedule, lastDigestSent: new Date('2026-10-21T06:00:00Z') }, now)).toBe(false);
  });
  it('uses local days, not an elapsed-hour cooldown', () => {
    expect(isDigestDue({ ...schedule, lastDigestSent: new Date('2026-10-20T21:00:00Z') }, new Date('2026-10-21T06:00:00Z'))).toBe(true);
    expect(isDigestDue({ ...schedule, digestTime: '00:00', lastDigestSent: new Date('2026-10-20T22:05:00Z') }, new Date('2026-10-21T01:00:00Z'))).toBe(false);
  });
  it('handles spring gaps and autumn repeated hours without creating two daily windows', () => {
    const dst = { ...schedule, digestTime: '02:30' };
    expect(isDigestDue(dst, new Date('2026-03-29T01:15:00Z'))).toBe(true);
    expect(isDigestDue({ ...dst, lastDigestSent: new Date('2026-10-25T00:30:00Z') }, new Date('2026-10-25T01:30:00Z'))).toBe(false);
  });
  it.each([{ digestTime: '25:00' }, { digestTime: '8:00' }, { digestTimezone: 'invalid/zone' },
    { lastDigestSent: new Date(NaN) }])('fails closed for invalid schedule %j', change => {
    expect(isDigestDue({ ...schedule, ...change }, now)).toBe(false);
  });
});

describe('durable digest scheduler adapters', () => {
  it('mounts exactly one lifecycle inside the shared background gate, independent of cache preparation', () => {
    const source = readFileSync(new URL('../../_core/index.ts', import.meta.url), 'utf8');
    const startup = source.slice(source.indexOf('if (backgroundWork.enabled)'), source.indexOf('const host ='));
    const shutdown = source.slice(source.indexOf('const gracefulShutdown ='));
    expect(startup.match(/startDigestScheduler\(\)/g)).toHaveLength(1);
    expect(shutdown.match(/stopDigestScheduler\(\)/g)).toHaveLength(1);
    expect(source.match(/startDigestScheduler\(\)/g)).toHaveLength(1);
    expect(startup).not.toContain('warmUpCache');
    expect(startup).not.toContain('scheduleCacheRefresh');
  });
  it('has no database/provider/queue activity when globally disabled', async () => {
    vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
    expect(await sendDigestToUser('recipient')).toBe(false);
    expect(await queueNotificationForDigest(2, 'recipient', { title: 'T', content: 'C', notificationType: 'general' })).toBeNull();
    expect(await processDigests()).toMatchObject({ processed: 0, sent: 0 });
    startDigestScheduler();
    expect(controls.db).not.toHaveBeenCalled(); expect(controls.deliver).not.toHaveBeenCalled(); expect(controls.enqueue).not.toHaveBeenCalled();
  });
  it.each(['sent', 'not_sent', 'uncertain', 'empty', 'skipped'])('maps %s to an honest compatibility boolean', async state => {
    controls.deliver.mockResolvedValue({ state, count: 1 });
    expect(await sendDigestToUser('recipient')).toBe(state === 'sent');
    expect(controls.deliver).toHaveBeenCalledWith('recipient', { trigger: 'manual' });
  });
  it('delegates queue persistence without writing its own history or acknowledging rows', async () => {
    const notice = { title: 'Title', content: 'Content', notificationType: 'general' as const };
    controls.enqueue.mockResolvedValueOnce(18).mockResolvedValueOnce(null);
    expect(await queueNotificationForDigest(2, 'recipient', notice)).toBe(18);
    expect(await queueNotificationForDigest(2, 'recipient', notice)).toBeNull();
    expect(controls.enqueue).toHaveBeenCalledWith({ userId: 2, userOpenId: 'recipient', ...notice });
    expect(controls.db).not.toHaveBeenCalled();
  });
  it('scans only eligible consented recipients and separates uncertain/empty/skipped outcomes', async () => {
    database(['sent', 'not_sent', 'uncertain', 'empty', 'skipped'].map(userOpenId => ({ ...schedule, userOpenId, emailEnabled: 1 }))
      .concat([{ ...schedule, userOpenId: 'opted-out', emailEnabled: 0 }]));
    controls.deliver.mockImplementation(async (state: string) => ({ state, count: 1 }));
    expect(await processDigests({ now })).toEqual({ processed: 5, sent: 1, failed: 1, uncertain: 1, empty: 1, skipped: 1 });
    expect(controls.deliver).not.toHaveBeenCalledWith('opted-out', expect.anything());
    expect(controls.deliver).toHaveBeenCalledWith('sent', { now, trigger: 'cron' });
  });
  it('does not turn a persistence/status exception into confirmed non-delivery', async () => {
    database([{ ...schedule, userOpenId: 'recipient', emailEnabled: 1 }]);
    controls.deliver.mockRejectedValue(new Error('unavailable'));
    expect(await processDigests({ now })).toMatchObject({ sent: 0, failed: 0, uncertain: 1 });
  });
  it('reports scan storage failure instead of idle success and clears the single-flight state', async () => {
    controls.db.mockResolvedValue(null);
    await expect(processDigests({ now })).rejects.toThrow('Database unavailable');
    database([]);
    expect(await processDigests({ now })).toMatchObject({ processed: 0 });
  });
  it('does not overlap scans across interval ticks and stop/start, and releases the shared promise', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const timer = vi.spyOn(globalThis, 'setInterval');
    database([{ ...schedule, userOpenId: 'recipient', emailEnabled: 1 }]);
    let release!: (value: unknown) => void;
    controls.deliver.mockReturnValue(new Promise(resolve => { release = resolve; }));
    startDigestScheduler(); startDigestScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const pending = processDigests();
    expect(processDigests()).toBe(pending);
    stopDigestScheduler(); startDigestScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(controls.deliver).toHaveBeenCalledOnce();
    expect(timer.mock.results[0].value.hasRef()).toBe(false);
    release({ state: 'sent', count: 1 });
    await pending;
    stopDigestScheduler();
    expect(vi.getTimerCount()).toBe(0);
    controls.deliver.mockResolvedValue({ state: 'empty', count: 0 });
    expect(await processDigests({ now })).toMatchObject({ empty: 1 });
  });
  it('catches background scan failures and cancels future ticks without invoking a provider', async () => {
    vi.useFakeTimers();
    controls.db.mockRejectedValue(new Error('Storage unavailable'));
    startDigestScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.db).toHaveBeenCalledOnce();
    stopDigestScheduler();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(controls.db).toHaveBeenCalledOnce();
    expect(controls.deliver).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
