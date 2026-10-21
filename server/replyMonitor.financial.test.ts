import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { financialLedgerEvents, paymentCycles, timeDayReviews, unsignedMessageFlags, users, vaProfiles, vagueReplyFlags, weeklyPayLog } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';
import { incrementWeeklyD1 } from './financialLedger';

const controls = vi.hoisted(() => ({ getDb: vi.fn(), increment: vi.fn() }));
vi.mock('./db', () => ({ getDb: controls.getDb, incrementPayLogD1: controls.increment }));
import { autoDemeritUnsignedFlag, autoDemeritVagueReplyFlag, autoDemeriteExpiredUnsignedFlags, autoDemeriteExpiredVagueFlags } from './replyMonitorDb';

const cases = [
  { kind: 'vague', table: vagueReplyFlags, expired: autoDemeriteExpiredVagueFlags, single: autoDemeritVagueReplyFlag },
  { kind: 'unsigned', table: unsignedMessageFlags, expired: autoDemeriteExpiredUnsignedFlags, single: autoDemeritUnsignedFlag },
];
const now = new Date('2026-10-25T23:30:00Z');
const flaggedAt = new Date('2026-10-25T19:00:00Z');
function flag(id = 1, changes: Record<string, unknown> = {}) {
  return { id, vaId: 42, flaggedAt, resolvedAt: null, demeritIssued: false, ...changes };
}
function fixture(table: typeof vagueReplyFlags | typeof unsignedMessageFlags, changes: {
  beforeLock?: (table: unknown, rows: Map<unknown, any[]>) => void;
  failAudit?: () => boolean;
} = {}) {
  const rows = new Map<unknown, any[]>([
    [users, [{ id: 8, role: 'admin' }, { id: 42, role: 'worker' }]],
    [vaProfiles, [{ id: 7, userId: 42, founderId: 8, status: 'active' }]],
    [table, [flag()]], [weeklyPayLog, []], [paymentCycles, []], [timeDayReviews, []], [financialLedgerEvents, []],
  ]);
  const store = timerTestDatabase(rows, {
    beforeLock: async locked => { changes.beforeLock?.(locked, rows); },
    afterInsert: inserted => { if (inserted === financialLedgerEvents && changes.failAudit?.()) throw new Error('Audit unavailable'); },
  });
  // Serialize this in-memory fixture's transactions. This tests adapter behavior,
  // not PostgreSQL lock execution; the core native suite owns real lock proof.
  const transaction = store.db.transaction.getMockImplementation();
  let tail = Promise.resolve();
  store.db.transaction.mockImplementation(async (work: any) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await transaction(work); } finally { release(); }
  });
  controls.getDb.mockResolvedValue(store.db);
  controls.increment.mockImplementation(async (worker, dateKey, count, eventKey, beforeIncrement) => {
    const { log } = await incrementWeeklyD1(store.db, worker, dateKey, count, eventKey, beforeIncrement);
    return { id: log.id, projectedPay: Number(log.projectedPay) };
  });
  return store;
}
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe.each(cases)('$kind flag financial adapter', ({ kind, table, expired, single }) => {
  it('commits one canonical charge and marker under concurrent repeated calls', async () => {
    const f = fixture(table);
    expect((await Promise.all([expired(42), expired(42)])).sort()).toEqual([0, 1]);
    expect(f.rows.get(weeklyPayLog)).toEqual([expect.objectContaining({ vaId: 42, founderId: 8,
      demeritD1: '1.00', totalDemerits: '5.00', projectedPay: '85.00' })]);
    expect(f.rows.get(financialLedgerEvents)).toEqual([expect.objectContaining({ kind: 'd1_incremented', eventKey: `reply-monitor:${kind}:1` })]);
    expect(f.rows.get(table)![0]).toMatchObject({ resolvedBy: 'auto_demerit', demeritIssued: true });
    expect(await expired(42)).toBe(0);
    await single(1);
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });
  it('rolls the marker and weekly amount back on audit failure and safely retries later', async () => {
    let failAudit = true;
    const f = fixture(table, { failAudit: () => failAudit });
    await expect(expired(42)).rejects.toThrow('Audit unavailable');
    expect(f.rows.get(table)![0]).toMatchObject({ resolvedAt: null, demeritIssued: false });
    expect(f.rows.get(weeklyPayLog)).toEqual([]); expect(f.rows.get(financialLedgerEvents)).toEqual([]);
    failAudit = false;
    vi.setSystemTime(new Date('2026-10-27T03:00:00Z'));
    expect(await expired(42)).toBe(1);
    expect(controls.increment.mock.calls.map(call => call.slice(0, 4))).toEqual([
      [42, '2026-10-25', 1, `reply-monitor:${kind}:1`],
      [42, '2026-10-25', 1, `reply-monitor:${kind}:1`],
    ]);
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });
  it('requires review for an unmarked event replay without a second charge or silent marker repair', async () => {
    const f = fixture(table);
    expect(await expired(42)).toBe(1);
    Object.assign(f.rows.get(table)![0], { resolvedAt: null, demeritIssued: false });
    vi.setSystemTime(new Date('2026-10-27T03:00:00Z'));
    await expect(expired(42)).rejects.toThrow('owner review required');
    expect(f.rows.get(weeklyPayLog)![0].demeritD1).toBe('1.00');
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
    expect(f.rows.get(table)![0].demeritIssued).toBe(false);
  });
  it('does not duplicate a committed charge when its acknowledgement is lost', async () => {
    const f = fixture(table);
    const increment = controls.increment.getMockImplementation()!;
    controls.increment.mockImplementationOnce(async (...args) => {
      await increment(...args);
      throw new Error('Commit acknowledgement lost');
    });
    await expect(expired(42)).rejects.toThrow('Commit acknowledgement lost');
    expect(await expired(42)).toBe(0);
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
    expect(f.rows.get(weeklyPayLog)![0].demeritD1).toBe('1.00');
    expect(f.rows.get(table)![0].demeritIssued).toBe(true);
  });
  it('does not charge a manually resolved flag that wins before the locked recheck', async () => {
    const f = fixture(table, { beforeLock: (locked, rows) => {
      if (locked === table) Object.assign(rows.get(table)![0], { resolvedAt: now, resolvedBy: 'manual' });
    } });
    expect(await expired(42)).toBe(0);
    expect(f.rows.get(weeklyPayLog)).toEqual([]); expect(f.rows.get(financialLedgerEvents)).toEqual([]);
  });
  it('rejects a worker identity changed before the locked recheck without charging either worker', async () => {
    const f = fixture(table, { beforeLock: (locked, rows) => { if (locked === table) rows.get(table)![0].vaId = 99; } });
    await expect(expired(42)).rejects.toThrow('Reply flag identity changed');
    expect(f.rows.get(weeklyPayLog)).toEqual([]); expect(f.rows.get(financialLedgerEvents)).toEqual([]);
    expect(f.rows.get(table)![0].demeritIssued).toBe(false);
  });
  it('propagates settled-period refusal without marking or charging the flag', async () => {
    const f = fixture(table);
    f.rows.get(paymentCycles)!.push({ id: 1, founderId: 8, cycleStart: new Date('2026-10-19T00:00:00Z'),
      cycleEnd: new Date('2026-10-25T00:00:00Z'), isPaid: true });
    await expect(expired(42)).rejects.toMatchObject({ status: 409 });
    expect(f.rows.get(table)![0]).toMatchObject({ resolvedAt: null, demeritIssued: false });
    expect(f.rows.get(weeklyPayLog)).toEqual([]); expect(f.rows.get(financialLedgerEvents)).toEqual([]);
  });
  it('leaves future, resolved, previously charged and other-worker flags unchanged', async () => {
    const f = fixture(table);
    f.rows.set(table, [flag(1, { flaggedAt: now }), flag(2, { resolvedAt: now }), flag(3, { demeritIssued: true }), flag(4, { vaId: 43 })]);
    expect(await expired(42)).toBe(0);
    expect(controls.increment).not.toHaveBeenCalled();
  });
  it('fails visibly when the database is unavailable', async () => {
    controls.getDb.mockResolvedValue(null);
    await expect(expired(42)).rejects.toThrow('Database not available');
    await expect(single(1)).rejects.toThrow('Database not available');
    expect(controls.increment).not.toHaveBeenCalled();
  });
});

it('uses separate vague and unsigned event identities even when their numeric IDs match', async () => {
  const f = fixture(vagueReplyFlags);
  f.rows.set(unsignedMessageFlags, [flag()]);
  expect(await Promise.all([autoDemeriteExpiredVagueFlags(42), autoDemeriteExpiredUnsignedFlags(42)])).toEqual([1, 1]);
  expect(f.rows.get(weeklyPayLog)![0]).toMatchObject({ demeritD1: '2.00', projectedPay: '80.00' });
  expect(f.rows.get(financialLedgerEvents)!.map(row => row.eventKey).sort())
    .toEqual(['reply-monitor:unsigned:1', 'reply-monitor:vague:1']);
});
