import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const controls = vi.hoisted(() => ({ db: vi.fn(), deliver: vi.fn(), enqueue: vi.fn(), read: vi.fn(), email: vi.fn(), owner: vi.fn(), profile: vi.fn() }));
vi.mock('../../db', () => ({ getDb: controls.db }));
vi.mock('../digest-outbox', () => ({ deliverDigestForUser: controls.deliver, enqueueDigestNotification: controls.enqueue,
  readQueuedDigestNotifications: controls.read }));
vi.mock('../email', () => ({ sendEmailWithOutcome: controls.email }));
vi.mock('../../_core/notification', () => ({ notifyOwner: controls.owner }));
vi.mock('../../workerOperatorContext', () => ({ getActiveWorkerProfileId: controls.profile }));
import { getDigestQueue, getNotificationStats, sendDailyDigest, sendSmartNotification } from '../smart-notification';

const notice = { userId: 2, userOpenId: 'recipient', title: '<script>T</script>', content: '<img src=x onerror=x>',
  notificationType: 'task_overdue' as const };
const preferences = { notificationMode: 'priority_only', urgentThresholdHours: 24, emailEnabled: 1,
  emailAddress: 'recipient@example.invalid', inAppEnabled: 0 };
function database(rows: Array<any>, options: { lockedRows?: any[]; failCommit?: boolean; failInsert?: boolean; commit?: Promise<void> } = {}) {
  let index = 0;
  const where = vi.fn((_condition: unknown) => ({ limit: async () => rows[Math.min(index++, rows.length - 1)] }));
  const lock = vi.fn(async () => options.lockedRows ?? rows[0]);
  const insert = vi.fn((_table: unknown) => ({ values: vi.fn((value: any) => ({ returning: async () => {
    if (options.failInsert) throw new Error('Insert failed');
    return [{ id: 81, ...value }];
  } })) }));
  const profileLock = vi.fn(async () => []);
  const tx = { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => ({ for: lock }) }) }),
    where: () => ({ for: profileLock }) }) }), insert };
  const transaction = vi.fn(async (work: (connection: typeof tx) => Promise<unknown>) => {
    const result = await work(tx);
    await options.commit;
    if (options.failCommit) throw new Error('Commit failed');
    return result;
  });
  controls.db.mockResolvedValue({ select: () => ({ from: () => ({ innerJoin: () => ({ where }) }) }), transaction });
  return Object.assign(where, { insert, transaction, lock, profileLock, tx });
}
const recipient = (change = {}) => ({ user: { id: 2, openId: 'recipient', email: 'fallback@example.invalid', role: 'admin' },
  preferences: { ...preferences, ...change } });
beforeEach(() => { vi.resetAllMocks(); controls.profile.mockResolvedValue(9); vi.stubEnv('NOTIFICATIONS_ENABLED', 'true'); });
afterEach(() => vi.unstubAllEnvs());

describe('smart notifications use durable recipient state', () => {
  it.each(['revoked', 'address', 'identity missing', 'offboarded', 'mode', 'unavailable', 'global'])(
    'blocks %s changes during awaited provider readiness at the final dispatch guard', async change => {
      const latest = recipient();
      if (change === 'offboarded') latest.user.role = 'worker';
      const rows = [[latest], [latest], [latest]];
      database(rows);
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      const dispatch = vi.fn();
      controls.email.mockImplementation(async (_options, _context, beforeDispatch) => {
        await ready;
        if (!await beforeDispatch()) return { status: 'not_sent' };
        dispatch(); return { status: 'sent' };
      });
      const pending = sendSmartNotification(notice);
      await vi.waitFor(() => expect(controls.email).toHaveBeenCalledOnce());
      if (change === 'revoked') latest.preferences.emailEnabled = 0;
      if (change === 'address') latest.preferences.emailAddress = 'different@example.invalid';
      if (change === 'identity missing') rows[2] = [];
      if (change === 'offboarded') controls.profile.mockResolvedValue(null);
      if (change === 'mode') latest.preferences.notificationMode = 'disabled';
      if (change === 'unavailable') controls.db.mockRejectedValue(new Error('Synthetic read unavailable'));
      if (change === 'global') vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
      release();
      expect(await pending).toMatchObject({ sent: false, deliveryState: 'not_sent', channels: { email: 'not_sent' } });
      expect(dispatch).not.toHaveBeenCalled();
      expect(controls.email.mock.calls[0][1]).toBeUndefined();
      expect(typeof controls.email.mock.calls[0][2]).toBe('function');
    },
  );

  it('allows unchanged identity, consent and exact address after awaited readiness', async () => {
    database([[recipient()]]);
    const dispatch = vi.fn();
    controls.email.mockImplementation(async (_options, _context, beforeDispatch) => {
      await Promise.resolve();
      if (!await beforeDispatch()) return { status: 'not_sent' };
      dispatch(); return { status: 'sent' };
    });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: true, deliveryState: 'sent' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('globally disables delivery and enqueue before accessing dependencies', async () => {
    vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, mode: 'disabled' });
    expect(await sendDailyDigest('recipient')).toBe(false);
    expect(controls.db).not.toHaveBeenCalled(); expect(controls.email).not.toHaveBeenCalled(); expect(controls.enqueue).not.toHaveBeenCalled();
  });
  it('does not invent preferences or consent when the canonical join is absent', async () => {
    const where = database([[]]);
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, mode: 'unconfigured' });
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0] as any).params).toEqual(['recipient', 2]);
    expect(controls.email).not.toHaveBeenCalled(); expect(controls.owner).not.toHaveBeenCalled();
  });
  it('does not grant consent for missing, disabled or non-exact flags and never substitutes notifyOwner', async () => {
    for (const emailEnabled of [undefined, 0, 2, true]) {
      database([[recipient({ emailEnabled })]]);
      expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { inApp: 'disabled', email: 'disabled' } });
    }
    expect(controls.email).not.toHaveBeenCalled(); expect(controls.owner).not.toHaveBeenCalled();
  });
  it('honors a preference opt-out immediately before provider invocation', async () => {
    database([[recipient()], [recipient({ emailEnabled: 0 })]]);
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { email: 'disabled' } });
    expect(controls.email).not.toHaveBeenCalled();
  });
  it('honors urgency and global-policy changes before delivery', async () => {
    database([[recipient()], [recipient({ urgentThresholdHours: 1 })]]);
    const upcoming = { ...notice, notificationType: 'task_due_soon' as const, dueDate: new Date(Date.now() + 2 * 3_600_000) };
    expect(await sendSmartNotification(upcoming)).toMatchObject({ sent: false, reason: expect.stringContaining('current urgency') });
    let calls = 0;
    controls.db.mockImplementation(async () => {
      calls++;
      if (calls === 2) vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
      return { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [recipient()] }) }) }) }) };
    });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, reason: expect.stringContaining('Notifications are globally disabled') });
    expect(controls.email).not.toHaveBeenCalled();
  });
  it('escapes title/content and uses the current canonical recipient address', async () => {
    database([[recipient()], [recipient({ emailAddress: 'changed@example.invalid' })]]);
    controls.email.mockResolvedValue({ status: 'sent' });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: true, deliveryState: 'sent' });
    expect(controls.email.mock.calls[0][0]).toMatchObject({ to: 'changed@example.invalid' });
    const html = controls.email.mock.calls[0][0].html;
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<script>');
    expect(controls.owner).not.toHaveBeenCalled();
  });
  it.each(['not_sent', 'uncertain'])('preserves provider %s without claiming delivery', async status => {
    database([[recipient()]]); controls.email.mockResolvedValue({ status });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, deliveryState: status });
  });
  it('reports enqueue only after a committed core ID, and reports rejected persistence honestly', async () => {
    database([[recipient({ notificationMode: 'daily_digest' })]]);
    let release!: (value: number) => void;
    controls.enqueue.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    let settled = false;
    const pending = sendSmartNotification(notice).finally(() => { settled = true; });
    await vi.waitFor(() => expect(controls.enqueue).toHaveBeenCalledOnce());
    expect(settled).toBe(false); release(18);
    expect(await pending).toMatchObject({ sent: false, queuedForDigest: true });
    controls.enqueue.mockResolvedValueOnce(null);
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, queuedForDigest: false });
    controls.enqueue.mockRejectedValueOnce(new Error('write failed'));
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, queuedForDigest: false });
    expect(controls.email).not.toHaveBeenCalled();
  });
  it('reads the durable queue nondestructively and shares the core manual delivery', async () => {
    const rows = [{ id: 4, userId: 2, userOpenId: 'recipient', deliveryStatus: 'queued_for_digest' }];
    controls.read.mockResolvedValue(rows);
    expect(await getDigestQueue('recipient')).toEqual(rows); expect(await getDigestQueue('recipient')).toEqual(rows);
    for (const state of ['empty', 'uncertain', 'not_sent', 'skipped', 'sent']) {
      controls.deliver.mockResolvedValue({ state, count: 1 });
      expect(await sendDailyDigest('recipient')).toBe(state === 'sent');
    }
    expect(controls.deliver).toHaveBeenCalledWith('recipient', { trigger: 'manual' });
    expect(controls.email).not.toHaveBeenCalled();
  });
  it('computes stats from persisted rows without presenting missing preferences as defaults', async () => {
    database([[]]); controls.read.mockResolvedValue([]);
    expect(await getNotificationStats('recipient')).toMatchObject({ mode: 'unconfigured', emailEnabled: false,
      inAppEnabled: false, queuedForDigest: 0, urgentThreshold: null });
  });
  it('rejects nonurgent tasks and invalid dates before delivery', async () => {
    database([[recipient()]]);
    expect((await sendSmartNotification({ ...notice, notificationType: 'general' })).sent).toBe(false);
    expect((await sendSmartNotification({ ...notice, dueDate: 'invalid' })).sent).toBe(false);
    expect(controls.email).not.toHaveBeenCalled();
  });
  it('stores an in-app-only notice for the canonical recipient without granting email consent', async () => {
    const fixture = database([[recipient({ inAppEnabled: 1, emailEnabled: 0 })]]);
    const result = await sendSmartNotification(notice);
    expect(result).toMatchObject({ sent: true, inAppNotificationId: 81, channels: { inApp: 'stored', email: 'disabled' } });
    expect(result.reason).toContain('no push delivery claimed');
    expect(fixture.transaction).toHaveBeenCalledOnce(); expect(fixture.lock).toHaveBeenCalledWith('update');
    expect(fixture.insert.mock.results[0].value.values.mock.calls[0][0]).toMatchObject({
      userId: 2, userOpenId: 'recipient', channel: 'in_app', deliveryStatus: 'sent', title: notice.title, content: notice.content,
    });
    expect(controls.email).not.toHaveBeenCalled(); expect(controls.owner).not.toHaveBeenCalled();
  });
  it('waits for inbox commit and never reports storage when commit fails', async () => {
    let release!: () => void;
    const commit = new Promise<void>(resolve => { release = resolve; });
    database([[recipient({ inAppEnabled: 1, emailEnabled: 0 })]], { commit });
    let settled = false;
    const pending = sendSmartNotification(notice).finally(() => { settled = true; });
    await vi.waitFor(() => expect(controls.db).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false); release();
    expect(await pending).toMatchObject({ channels: { inApp: 'stored' } });
    database([[recipient({ inAppEnabled: 1, emailEnabled: 0 })]], { failCommit: true });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { inApp: 'failed', email: 'disabled' } });
  });
  it.each([{ inAppEnabled: 0 }, { inAppEnabled: 2 }, { inAppEnabled: true },
    { notificationMode: 'disabled' }, { urgentThresholdHours: -1 }])('rechecks locked inbox preferences %j', async change => {
    const fixture = database([[recipient({ inAppEnabled: 1, emailEnabled: 0 })]], { lockedRows: [recipient(change)] });
    expect((await sendSmartNotification(notice)).channels?.inApp).not.toBe('stored');
    expect(fixture.insert).not.toHaveBeenCalled();
  });
  it('rechecks the master flag and missing canonical identity inside the inbox transaction', async () => {
    const fixture = database([[recipient({ inAppEnabled: 1 })]]);
    fixture.lock.mockImplementationOnce(async () => {
      vi.stubEnv('NOTIFICATIONS_ENABLED', 'false');
      return [recipient({ inAppEnabled: 1 })];
    });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { inApp: 'not_stored', email: 'disabled' } });
    expect(fixture.insert).not.toHaveBeenCalled(); expect(controls.email).not.toHaveBeenCalled();
    vi.stubEnv('NOTIFICATIONS_ENABLED', 'true');
    const missing = database([[recipient({ inAppEnabled: 1, emailEnabled: 0 })]], { lockedRows: [] });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { inApp: 'not_stored' } });
    expect(missing.insert).not.toHaveBeenCalled();
  });
  it('preserves stored inbox success separately from uncertain email and preserves email despite inbox failure', async () => {
    database([[recipient({ inAppEnabled: 1 })]]);
    controls.email.mockResolvedValue({ status: 'uncertain' });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: true, deliveryState: 'uncertain',
      channels: { inApp: 'stored', email: 'uncertain' }, reason: expect.stringContaining('unconfirmed') });
    database([[recipient({ inAppEnabled: 1 })]], { failInsert: true });
    controls.email.mockResolvedValue({ status: 'sent' });
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: true, channels: { inApp: 'failed', email: 'sent' } });
  });
  it('denies offboarded or ambiguous workers before either channel, without requiring profiles for admins', async () => {
    const worker = { ...recipient({ inAppEnabled: 1 }), user: { ...recipient().user, role: 'worker' } };
    const blocked = database([[worker]]);
    controls.profile.mockResolvedValue(null);
    expect((await sendSmartNotification(notice)).sent).toBe(false);
    expect(blocked.transaction).not.toHaveBeenCalled(); expect(controls.email).not.toHaveBeenCalled();
    const admin = { ...recipient({ inAppEnabled: 1, emailEnabled: 0 }), user: { ...recipient().user, role: 'admin' } };
    database([[admin]]); controls.profile.mockClear();
    expect(await sendSmartNotification(notice)).toMatchObject({ channels: { inApp: 'stored', email: 'disabled' } });
    expect(controls.profile).not.toHaveBeenCalled();
  });
  it('rechecks worker eligibility under inbox transaction locks and again before email', async () => {
    const worker = { ...recipient({ inAppEnabled: 1 }), user: { ...recipient().user, role: 'worker' } };
    const fixture = database([[worker]]);
    controls.profile.mockResolvedValueOnce(9).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await sendSmartNotification(notice)).toMatchObject({ sent: false, channels: { inApp: 'not_stored', email: 'disabled' } });
    expect(fixture.profileLock).toHaveBeenCalledWith('share');
    expect(controls.profile.mock.calls[1]).toEqual([2, fixture.tx]);
    expect(fixture.insert).not.toHaveBeenCalled(); expect(controls.email).not.toHaveBeenCalled();
  });
  it('rejects pending nonoperator accounts before either channel', async () => {
    const pending = { ...recipient({ inAppEnabled: 1 }), user: { ...recipient().user, role: 'user' } };
    const fixture = database([[pending]]);
    expect((await sendSmartNotification(notice)).sent).toBe(false);
    expect(fixture.transaction).not.toHaveBeenCalled(); expect(controls.email).not.toHaveBeenCalled();
  });
});
