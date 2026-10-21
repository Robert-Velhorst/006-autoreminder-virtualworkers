import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../../drizzle/schema.postgres';
import { requireIsolatedPostgresTestDatabase } from '../../../shared/isolatedPostgresTestDatabase.mjs';
const controls = vi.hoisted(() => ({ db: undefined as any, email: vi.fn(), owner: vi.fn() }));
vi.mock('../../db', () => ({ getDb: async () => controls.db }));
vi.mock('../email', () => ({ sendEmailWithOutcome: controls.email }));
vi.mock('../../_core/notification', () => ({ notifyOwner: controls.owner }));
import { sendSmartNotification } from '../smart-notification';

const url = process.env.APTLSS_TEST_DATABASE_URL;
describe.skipIf(!url)('smart notification recipient inbox PostgreSQL', { timeout: 15_000 }, () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const owned: number[] = [];
  beforeAll(async () => {
    requireIsolatedPostgresTestDatabase(url, process.env.NODE_ENV === 'production');
    pool = new Pool({ connectionString: url!, max: 4, connectionTimeoutMillis: 5000 });
    db = drizzle(pool, { schema });
    expect((await pool.query('SELECT current_database() AS name')).rows[0].name).toBe(new URL(url!).pathname.slice(1));
  });
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv('NOTIFICATIONS_ENABLED', 'true'); controls.db = db;
    controls.email.mockResolvedValue({ status: 'not_sent', reason: 'Synthetic provider: no external calls' });
  });
  afterEach(async () => {
    vi.unstubAllEnvs(); controls.db = db;
    if (owned.length) {
      await db.transaction(async tx => {
        await tx.delete(schema.notificationHistory).where(inArray(schema.notificationHistory.userId, owned));
        await tx.delete(schema.userNotificationPreferences).where(inArray(schema.userNotificationPreferences.userId, owned));
        await tx.delete(schema.vaProfiles).where(inArray(schema.vaProfiles.userId, owned));
        await tx.delete(schema.users).where(inArray(schema.users.id, owned));
      });
      owned.length = 0;
    }
  });
  afterAll(async () => { if (pool) await pool.end(); });
  async function fixture(inAppEnabled: number, emailEnabled: number) {
    const [user] = await db.insert(schema.users).values({ openId: `smart-inbox-test-${randomUUID()}`,
      role: 'admin', email: 'recipient@example.invalid' }).returning();
    owned.push(user.id);
    await db.insert(schema.userNotificationPreferences).values({ userId: user.id, userOpenId: user.openId,
      notificationMode: 'priority_only', inAppEnabled, emailEnabled });
    return { userId: user.id, userOpenId: user.openId, title: 'Synthetic overdue notice',
      content: 'Synthetic content', notificationType: 'task_overdue' as const };
  }
  const history = (id: number) => db.select().from(schema.notificationHistory).where(eq(schema.notificationHistory.userId, id));

  it('commits an owned in-app-only row visible to recipient history without any provider call', async () => {
    const notice = await fixture(1, 0);
    const outcome = await sendSmartNotification(notice);
    expect(outcome).toMatchObject({ sent: true, channels: { inApp: 'stored', email: 'disabled' } });
    const rows = await history(notice.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: outcome.inAppNotificationId, userId: notice.userId,
      userOpenId: notice.userOpenId, channel: 'in_app', deliveryStatus: 'sent', isRead: 0 });
    expect(controls.email).not.toHaveBeenCalled(); expect(controls.owner).not.toHaveBeenCalled();
  });
  it('supports email-only consent and keeps email uncertainty independent from stored inbox success', async () => {
    const emailOnly = await fixture(0, 1);
    controls.email.mockResolvedValue({ status: 'sent' });
    expect(await sendSmartNotification(emailOnly)).toMatchObject({ sent: true, channels: { inApp: 'disabled', email: 'sent' } });
    expect(await history(emailOnly.userId)).toHaveLength(0);
    const both = await fixture(1, 1);
    controls.email.mockResolvedValue({ status: 'uncertain', reason: 'Synthetic unknown outcome' });
    expect(await sendSmartNotification(both)).toMatchObject({ sent: true, deliveryState: 'uncertain', channels: { inApp: 'stored', email: 'uncertain' } });
    expect(await history(both.userId)).toHaveLength(1);
  });
  it('refuses mismatched recipient keys and respects a committed inbox opt-out before its locked recheck', async () => {
    const notice = await fixture(1, 0);
    const other = await fixture(1, 0);
    expect((await sendSmartNotification({ ...notice, userId: other.userId })).sent).toBe(false);
    controls.db = new Proxy(db, { get(target, property) {
      if (property === 'transaction') return async (work: any) => {
        await db.update(schema.userNotificationPreferences).set({ inAppEnabled: 0 }).where(and(
          eq(schema.userNotificationPreferences.userId, notice.userId), eq(schema.userNotificationPreferences.userOpenId, notice.userOpenId)));
        return target.transaction(work);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { inApp: 'disabled', email: 'disabled' } });
    expect(await history(notice.userId)).toHaveLength(0); expect(await history(other.userId)).toHaveLength(0);
    expect(controls.email).not.toHaveBeenCalled();
  });
  it('does not persist or send under a global opt-out or a nonurgent priority request', async () => {
    const notice = await fixture(1, 1);
    vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
    expect((await sendSmartNotification(notice)).sent).toBe(false);
    vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
    expect((await sendSmartNotification({ ...notice, notificationType: 'task_due_soon', dueDate: new Date(Date.now() + 48 * 3_600_000) })).sent).toBe(false);
    expect(await history(notice.userId)).toHaveLength(0); expect(controls.email).not.toHaveBeenCalled();
  });
  it('fails closed for inactive, missing or ambiguous worker profiles and admits exactly one active profile', async () => {
    const notice = await fixture(1, 1);
    const founder = await fixture(0, 0);
    await db.update(schema.users).set({ role: 'worker' }).where(eq(schema.users.id, notice.userId));
    expect((await sendSmartNotification(notice)).sent).toBe(false);
    const [profile] = await db.insert(schema.vaProfiles).values({ userId: notice.userId, founderId: founder.userId,
      name: 'Synthetic notification worker', status: 'inactive' }).returning();
    expect((await sendSmartNotification(notice)).sent).toBe(false);
    await db.update(schema.vaProfiles).set({ status: 'active' }).where(eq(schema.vaProfiles.id, profile.id));
    expect(await sendSmartNotification(notice)).toMatchObject({ channels: { inApp: 'stored' } });
    await db.insert(schema.vaProfiles).values({ userId: notice.userId, founderId: founder.userId,
      name: 'Ambiguous synthetic profile', status: 'active' });
    controls.email.mockClear();
    expect((await sendSmartNotification(notice)).sent).toBe(false);
    expect(await history(notice.userId)).toHaveLength(1); expect(controls.email).not.toHaveBeenCalled();
  });
  it('honors offboarding committed between recipient preflight and the inbox transaction', async () => {
    const notice = await fixture(1, 1);
    const founder = await fixture(0, 0);
    await db.update(schema.users).set({ role: 'worker' }).where(eq(schema.users.id, notice.userId));
    const [profile] = await db.insert(schema.vaProfiles).values({ userId: notice.userId, founderId: founder.userId,
      name: 'Synthetic offboarding worker', status: 'active' }).returning();
    controls.db = new Proxy(db, { get(target, property) {
      if (property === 'transaction') return async (work: any) => {
        await db.update(schema.vaProfiles).set({ status: 'inactive' }).where(eq(schema.vaProfiles.id, profile.id));
        return target.transaction(work);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { inApp: 'not_stored', email: 'disabled' } });
    expect(await history(notice.userId)).toHaveLength(0); expect(controls.email).not.toHaveBeenCalled();
  });
});
