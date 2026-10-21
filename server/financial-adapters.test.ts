import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrpcContext } from './_core/context';
import type { User } from '../drizzle/schema.postgres';
import { financialLedgerEvents, paymentCycles, timeDayReviews, users, vaProfiles, weeklyPayLog } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';

const controls = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./db', () => ({ getDb: controls.getDb }));
import { paymentRouter, payLogRouter } from './routes/manus';

const admin = { id: 8, openId: 'founder-8', role: 'admin' } as User;
function context(user = admin) { return { user, req: {}, res: {} } as TrpcContext; }
const validWeek = { vaId: 42, weekStart: '2026-10-19', weekEnd: '2026-10-25' };

beforeEach(() => { vi.clearAllMocks(); controls.getDb.mockResolvedValue(undefined); });
describe('financial route input boundaries', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cycle ID %s before database access', async cycleId => {
    await expect(paymentRouter.createCaller(context()).markPaid({ cycleId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(controls.getDb).not.toHaveBeenCalled();
  });
  it.each(['meritM1', 'meritM2', 'meritM3', 'meritStreak', ...Array.from({ length: 11 }, (_, i) => `demeritD${i + 1}`)])
    ('treats %s as a nonnegative integer count, not money', async field => {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(payLogRouter.createCaller(context()).upsert({ ...validWeek, [field]: value } as any))
          .rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
      expect(controls.getDb).not.toHaveBeenCalled();
    });
  it.each([
    { vaId: undefined }, { vaId: 0 }, { vaId: -1 }, { vaId: 1.5 },
    { weekStart: '2026-02-30' }, { weekStart: '2026-1-01' }, { weekEnd: '2026-10-18' },
    { paymentCycleId: 0 }, { founderId: 99 },
  ])('rejects malformed financial input %j before database access', async changes => {
    await expect(payLogRouter.createCaller(context()).upsert({ ...validWeek, ...changes } as any))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(controls.getDb).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 101])('rejects invalid history limit %s', async limit => {
    await expect(payLogRouter.createCaller(context()).getAll({ vaId: 42, limit })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(controls.getDb).not.toHaveBeenCalled();
  });
  it('rejects worker financial writes before database access', async () => {
    const worker = { id: 42, role: 'worker' } as User;
    await expect(paymentRouter.createCaller(context(worker)).markPaid({ cycleId: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(payLogRouter.createCaller(context(worker)).upsert(validWeek)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(controls.getDb).not.toHaveBeenCalled();
  });
  it('requires explicit worker selection for both founder pay-log reads', async () => {
    const caller = payLogRouter.createCaller(context());
    await expect(caller.getAll({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.getByWeek({ weekStart: validWeek.weekStart })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(controls.getDb).not.toHaveBeenCalled();
  });
});

describe('financial adapters with the canonical ledger', () => {
  function fixture() {
    const store = timerTestDatabase(new Map<unknown, any[]>([
      [users, [admin, { id: 42, role: 'worker', openId: 'worker-42' }, { id: 9, role: 'admin' }, { id: 43, role: 'worker' }]],
      [vaProfiles, [{ id: 7, userId: 42, founderId: 8, status: 'active' }, { id: 6, userId: 43, founderId: 9, status: 'active' }]],
      [weeklyPayLog, []], [paymentCycles, []], [timeDayReviews, []], [financialLedgerEvents, []],
    ]));
    controls.getDb.mockResolvedValue(store.db);
    return store;
  }
  it('returns the weighted estimate without clamping a negative value and writes the canonical audit', async () => {
    const f = fixture();
    const log = await payLogRouter.createCaller(context()).upsert({ ...validWeek, meritM2: 2, demeritD1: 22 } as any);
    expect(log).toMatchObject({ vaId: 42, founderId: 8, baseAmount: '90.00', meritM2: '2.00', demeritD1: '22.00',
      totalMerits: '15.00', totalDemerits: '110.00', projectedPay: '-5.00' });
    expect(f.rows.get(financialLedgerEvents)).toEqual([expect.objectContaining({ kind: 'weekly_saved', founderId: 8, actorUserId: 8 })]);
    expect(await payLogRouter.createCaller(context()).getByWeek({ vaId: 42, weekStart: validWeek.weekStart })).toEqual(log);
  });
  it.each(['getAll', 'getByWeek', 'upsert'] as const)('rejects foreign-worker %s through the real ownership resolver', async method => {
    const f = fixture();
    const caller = payLogRouter.createCaller(context());
    const input = method === 'getAll' ? { vaId: 43 } : method === 'getByWeek'
      ? { vaId: 43, weekStart: validWeek.weekStart } : { ...validWeek, vaId: 43 };
    await expect((caller[method] as any)(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
  });
  it('reads only the worker own founder-scoped history and rejects an explicit foreign identity', async () => {
    const f = fixture();
    f.rows.get(weeklyPayLog)!.push({ id: 1, vaId: 42, founderId: 8, weekStart: new Date('2026-10-19Z') },
      { id: 2, vaId: 43, founderId: 9, weekStart: new Date('2026-10-19Z') });
    const caller = payLogRouter.createCaller(context({ id: 42, role: 'worker', openId: 'worker-42' } as User));
    expect((await caller.getAll({})).map(row => row.id)).toEqual([1]);
    await expect(caller.getAll({ vaId: 43 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.inserts).toEqual([]);
  });
  it('maps settled-period refusal to conflict without rewriting the historical row', async () => {
    const f = fixture();
    f.rows.get(paymentCycles)!.push({ id: 1, founderId: 8, cycleStart: new Date('2026-10-19Z'), cycleEnd: new Date('2026-10-25Z'), isPaid: true });
    await expect(payLogRouter.createCaller(context()).upsert(validWeek as any)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.rows.get(weeklyPayLog)).toEqual([]); expect(f.rows.get(financialLedgerEvents)).toEqual([]);
  });
});
