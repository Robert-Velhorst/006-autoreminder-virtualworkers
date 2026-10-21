import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationHistory, userNotificationPreferences, users, vaProfiles } from '../../drizzle/schema.postgres';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), run: vi.fn(), send: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('./email', () => ({ sendEmailWithOutcome: mocks.send }));
vi.mock('../scheduledJobRuntime', async original => ({
  ...await original<typeof import('../scheduledJobRuntime')>(), runScheduledJob: mocks.run,
}));
import { deliverDigestForUser, enqueueDigestNotification, listDigestJobsNeedingAttention, readQueuedDigestNotifications } from './digest-outbox';

const input = { userId: 17, userOpenId: 'worker', title: 'A task', content: 'Review it', notificationType: 'general' as const };

describe('digest outbox direct contracts', () => {
  beforeEach(() => vi.resetAllMocks());

  function fixture(preferences: Record<string, unknown> | undefined, user = { id: 17, openId: 'worker', role: 'worker' }) {
    const writes: unknown[] = [];
    const predicates: unknown[] = [];
    const db: any = {
      transaction: async (work: (tx: any) => unknown) => work(db),
      select: () => ({ from: (table: unknown) => ({ where: (condition: any) => {
        predicates.push(new PgDialect().sqlToQuery(condition));
        const rows = table === users ? [user] : table === userNotificationPreferences ? (preferences ? [preferences] : [])
          : table === vaProfiles ? [{ id: 71, status: 'active' }] : [];
        const query = { limit: () => query, for: async () => rows, then: (resolve: any) => Promise.resolve(rows).then(resolve),
          orderBy: async () => rows };
        return query;
      } }) }),
      insert: (table: unknown) => ({ values: (value: unknown) => {
        expect(table).toBe(notificationHistory); writes.push(value);
        return { returning: async () => [{ id: 41 }] };
      } }),
    };
    mocks.getDb.mockResolvedValue(db);
    return { writes, predicates };
  }

  it('does not claim queue success without database storage', async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await enqueueDigestNotification(input)).toBeNull();
  });

  it.each([0, -1, 1.2, NaN])('rejects invalid canonical user ID %s', async userId => {
    expect(await enqueueDigestNotification({ ...input, userId })).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([undefined, { userId: 17, emailEnabled: 0, notificationMode: 'daily_digest' },
    { userId: 17, emailEnabled: 1, notificationMode: 'priority_only' },
    { userId: 22, emailEnabled: 1, notificationMode: 'daily_digest' }])('requires persisted canonical digest consent: %j', async preferences => {
    const f = fixture(preferences);
    expect(await enqueueDigestNotification(input)).toBeNull();
    expect(f.writes).toEqual([]);
  });

  it('rejects mismatched input identity before insertion', async () => {
    const f = fixture({ userId: 17, emailEnabled: 1, notificationMode: 'daily_digest' });
    expect(await enqueueDigestNotification({ ...input, userId: 99 })).toBeNull();
    expect(f.writes).toEqual([]);
  });

  it('persists the normalized queue record before reporting its ID', async () => {
    const f = fixture({ userId: 17, emailEnabled: 1, notificationMode: 'daily_digest' });
    expect(await enqueueDigestNotification({ ...input, dueDate: '2026-10-21T12:00:00Z' })).toBe(41);
    expect(f.writes).toEqual([expect.objectContaining({ userId: 17, userOpenId: 'worker',
      channel: 'email', deliveryStatus: 'queued_for_digest', dueDate: new Date('2026-10-21T12:00:00Z') })]);
  });

  it('does not drain history when reading the queue', async () => {
    const f = fixture(undefined);
    expect(await readQueuedDigestNotifications('worker')).toEqual([]);
    expect(f.predicates).toContainEqual(expect.objectContaining({ params: [17, 'worker', 'queued_for_digest'] }));
    expect(f.writes).toEqual([]);
  });

  it('uses a stable bounded recipient lease key and does not report a held lease as sent', async () => {
    mocks.getDb.mockResolvedValue({});
    mocks.run.mockResolvedValue({ state: 'skipped', reason: 'lease_held' });
    expect(await deliverDigestForUser('worker', { trigger: 'manual' })).toMatchObject({ state: 'skipped', count: 0 });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ jobKey: expect.stringMatching(/^digest:[a-f0-9]{64}$/),
      trigger: 'manual', skipIfSuccessful: false }), expect.any(Function));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('requires an admin even when attention listing is called without a route', async () => {
    fixture(undefined);
    await expect(listDigestJobsNeedingAttention(17)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    { title: 'x'.repeat(501) }, { content: 'x'.repeat(20_001) }, { notificationType: 'invalid' },
    { taskId: 'x'.repeat(129) }, { taskName: 'x'.repeat(501) }, { userOpenId: 'x'.repeat(65) },
  ])('rejects bounded-input violations before storage: %j', async override => {
    expect(await enqueueDigestNotification({ ...input, ...override } as any)).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
