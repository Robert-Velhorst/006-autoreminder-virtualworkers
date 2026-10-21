import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrpcContext } from './_core/context';
import type { User } from '../drizzle/schema.postgres';
import { financialLedgerEvents, paymentCycles, timeDayReviews, users, vaProfiles, weeklyPayLog } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';
import { incrementWeeklyD1, saveWeeklyPayLog } from './financialLedger';
import { weeklyPayRevision } from '../shared/financialRevision';

const controls = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./db', () => ({ getDb: controls.getDb }));
import { paymentRouter, payLogRouter } from './routes/manus';

const admin = { id: 8, openId: 'founder-8', role: 'admin' } as User;
function context(user = admin) { return { user, req: {}, res: {} } as TrpcContext; }
const validWeek = { vaId: 42, weekStart: '2026-10-19', weekEnd: '2026-10-25', expectedRevision: null };

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
  it('requires an explicit expectedRevision before database access', async () => {
    const { expectedRevision: _revision, ...missingRevision } = validWeek;
    await expect(payLogRouter.createCaller(context()).upsert(missingRevision as any))
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
  it('propagates a stale create revision as conflict without overwriting the winning ledger or adding an audit', async () => {
    const f = fixture();
    const caller = payLogRouter.createCaller(context());
    const winner = await caller.upsert({ ...validWeek, meritM2: 2, demeritD1: 22 } as any);
    const audits = structuredClone(f.rows.get(financialLedgerEvents));
    await expect(caller.upsert({ ...validWeek, demeritD1: 0 } as any))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.rows.get(weeklyPayLog)).toEqual([winner]);
    expect(f.rows.get(financialLedgerEvents)).toEqual(audits);
    expect(await caller.getByWeek({ vaId: 42, weekStart: validWeek.weekStart })).toEqual(winner);
  });
  it('also rejects a runtime caller missing the revision at the core boundary', async () => {
    const f = fixture();
    const { expectedRevision: _revision, ...missingRevision } = validWeek;
    await expect(saveWeeklyPayLog(f.db, admin, missingRevision as any)).rejects.toMatchObject({ status: 400 });
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]); expect(f.inserts).toEqual([]);
  });
  it('propagates stale edit conflicts after an automatic increment and accepts a freshly loaded shared revision', async () => {
    const f = fixture();
    const caller = payLogRouter.createCaller(context());
    const initial = await caller.upsert({ ...validWeek, demeritD1: 1 } as any);
    const loadedRevision = weeklyPayRevision(initial);
    expect(loadedRevision).toEqual(expect.any(String));
    const { log: incremented } = await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'adapter-revision:d1:1');
    const audits = structuredClone(f.rows.get(financialLedgerEvents));
    await expect(caller.upsert({ ...validWeek, expectedRevision: loadedRevision, demeritD1: 1 } as any))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/changed.*reload/i) });
    expect(f.rows.get(weeklyPayLog)).toEqual([incremented]);
    expect(f.rows.get(financialLedgerEvents)).toEqual(audits);
    const current = await caller.getByWeek({ vaId: 42, weekStart: validWeek.weekStart });
    expect(current).toMatchObject({ demeritD1: '2.00', projectedPay: '80.00' });
    const currentRevision = weeklyPayRevision(current);
    expect(currentRevision).not.toBe(loadedRevision);
    const saved = await caller.upsert({ ...validWeek, expectedRevision: currentRevision, demeritD1: 2, meritM2: 1 } as any);
    expect(saved).toMatchObject({ demeritD1: '2.00', meritM2: '1.00', projectedPay: '87.50' });
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(audits!.length + 1);
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

describe('payment cycle reads use fresh persisted authority', () => {
  const worker = { id: 42, role: 'worker', openId: 'worker-42' } as User;
  function fixture(hooks: Parameters<typeof timerTestDatabase>[1] = {}) {
    const store = timerTestDatabase(new Map<unknown, any[]>([
      [users, [structuredClone(admin),structuredClone(worker),{ id: 9,role: 'admin' }]],
      [vaProfiles, [{ id: 7,userId: 42,founderId: 8,status: 'active' },
        { id: 6,userId: 42,founderId: 9,status: 'inactive' }]],
      [paymentCycles, [
        { id: 1,founderId: 8,cycleStart: new Date('2026-10-01Z'),isPaid: true },
        { id: 2,founderId: 8,cycleStart: new Date('2026-10-17Z'),isPaid: false },
        { id: 3,founderId: 9,cycleStart: new Date('2026-09-01Z'),isPaid: false },
        { id: 4,founderId: 42,cycleStart: new Date('2026-09-01Z'),isPaid: false },
        { id: 5,founderId: 7,cycleStart: new Date('2026-09-01Z'),isPaid: false },
      ]],
    ]),hooks);
    controls.getDb.mockResolvedValue(store.db);
    return store;
  }
  const methods = ['getAllCycles','getCurrentCycle'] as const;

  it.each(methods)('keeps %s scoped to the admin own founder ID', async method => {
    const f = fixture(); const result = await paymentRouter.createCaller(context())[method]();
    expect(result).toEqual(method === 'getAllCycles' ? f.rows.get(paymentCycles)!.slice(0,2) : f.rows.get(paymentCycles)![1]);
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
  });

  it.each(methods)('lets a canonical worker read %s for its founder, not user/profile ID aliases or inactive history', async method => {
    const f = fixture(); const result = await paymentRouter.createCaller(context(worker))[method]();
    expect(result).toEqual(method === 'getAllCycles' ? f.rows.get(paymentCycles)!.slice(0,2) : f.rows.get(paymentCycles)![1]);
    expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
  });

  it.each(methods)('returns honest empty %s only when the verified founder has no matching cycles', async method => {
    const f = fixture(); f.rows.set(paymentCycles,f.rows.get(paymentCycles)!.filter(row => row.founderId !== 8));
    expect(await paymentRouter.createCaller(context(worker))[method]()).toEqual(method === 'getAllCycles' ? [] : null);
  });

  it.each(methods)('fails %s when the database is unavailable rather than disguising it as empty history', async method => {
    await expect(paymentRouter.createCaller(context())[method]()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it.each(methods)('rejects stale admin authority in %s from the persisted account', async method => {
    const f = fixture(); f.rows.get(users)!.find(row => row.id === admin.id)!.role = 'worker';
    await expect(paymentRouter.createCaller(context())[method]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
  });

  it.each(methods)('rejects a deleted admin account in %s even if the session still names it', async method => {
    const f = fixture(); f.rows.set(users,f.rows.get(users)!.filter(row => row.id !== admin.id));
    await expect(paymentRouter.createCaller(context())[method]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['no active profile','ambiguous active profiles','missing worker account','changed worker role',
    'missing founder','non-admin founder','invalid founder'] as const)('rejects %s without guessing a payment founder', async defect => {
    const f = fixture();
    if (defect === 'no active profile') f.rows.get(vaProfiles)![0].status = 'inactive';
    if (defect === 'ambiguous active profiles') f.rows.get(vaProfiles)![1].status = 'active';
    if (defect === 'missing worker account') f.rows.set(users,f.rows.get(users)!.filter(row => row.id !== worker.id));
    if (defect === 'changed worker role') f.rows.get(users)!.find(row => row.id === worker.id)!.role = 'admin';
    if (defect === 'missing founder') f.rows.set(users,f.rows.get(users)!.filter(row => row.id !== admin.id));
    if (defect === 'non-admin founder') f.rows.get(users)!.find(row => row.id === admin.id)!.role = 'worker';
    if (defect === 'invalid founder') f.rows.get(vaProfiles)![0].founderId = 0;
    for (const method of methods) {
      await expect(paymentRouter.createCaller(context(worker))[method]()).rejects.toMatchObject({
        code: defect === 'ambiguous active profiles' ? 'PRECONDITION_FAILED' : 'FORBIDDEN',
      });
    }
    expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
  });

  it.each(['offboard','founder relink','profile relink','profile ambiguity','founder role','worker role'] as const)
    ('rechecks %s between profile observation and locked authority resolution', async change => {
      let changed = false;
      const f = fixture({ beforeLock: async table => {
        if (changed || table !== users) return;
        changed = true;
        if (change === 'offboard') f.rows.get(vaProfiles)![0].status = 'inactive';
        if (change === 'founder relink') f.rows.get(vaProfiles)![0].founderId = 9;
        if (change === 'profile relink') f.rows.get(vaProfiles)![0].userId = 99;
        if (change === 'profile ambiguity') f.rows.get(vaProfiles)!.push({ id: 10,userId: 42,founderId: 8,status: 'active' });
        if (change === 'founder role') f.rows.get(users)!.find(row => row.id === admin.id)!.role = 'worker';
        if (change === 'worker role') f.rows.get(users)!.find(row => row.id === worker.id)!.role = 'admin';
      } });
      await expect(paymentRouter.createCaller(context(worker)).getAllCycles()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(changed).toBe(true); expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
    });
});
