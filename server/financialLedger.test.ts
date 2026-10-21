import { describe, expect, it } from 'vitest';
import { financialLedgerEvents, paymentCycles, weeklyPayLog, users, vaProfiles, timeDayReviews } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';
import { getWeeklyPayLogs, incrementWeeklyD1, saveWeeklyPayLog, settlePaymentCycle } from './financialLedger';

const actor = { id: 7, role: 'admin' as const };
const input = { vaId: 42, weekStart: '2026-10-19', weekEnd: '2026-10-25' };
function fixture(failAudit = false, failSuccessor = false) {
  return timerTestDatabase(new Map<unknown, any[]>([
    [users, [{ id: 7, role: 'admin', openId: 'founder-7' }, { id: 8, role: 'admin' }, { id: 42, role: 'worker' }]],
    [vaProfiles, [{ id: 3, userId: 42, founderId: 7, status: 'active' }]],
    [weeklyPayLog, []], [paymentCycles, []], [financialLedgerEvents, []], [timeDayReviews, []],
  ]), { afterInsert: table => {
    if (failAudit && table === financialLedgerEvents || failSuccessor && table === paymentCycles) throw new Error('Synthetic persistence failure');
  } });
}
const cycle = (changes: Record<string, unknown> = {}) => ({ id: 1, founderId: 7, predecessorCycleId: null,
  cycleStart: new Date('2026-10-19T00:00:00Z'), cycleEnd: new Date('2026-11-01T00:00:00Z'), isPaid: false, ...changes });

describe('canonical financial ledger', () => {
  it('uses UI count weights, integer cents and raw negative estimates', async () => {
    const f = fixture();
    const { log } = await saveWeeklyPayLog(f.db, actor, { ...input, meritM1: 1, meritM2: 1, demeritD1: 30 });
    expect(log).toMatchObject({ totalMerits: '12.50', totalDemerits: '150.00', projectedPay: '-47.50', demeritD1: '30.00' });
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });
  it('retains row ID and does not append another audit on an identical save', async () => {
    const f = fixture();
    const first = await saveWeeklyPayLog(f.db, actor, input);
    const second = await saveWeeklyPayLog(f.db, actor, input);
    expect(second).toMatchObject({ outcome: 'unchanged', log: { id: first.log.id } });
    expect(f.rows.get(weeklyPayLog)).toHaveLength(1); expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 999999])('rejects invalid or overflowing count %s with no writes', async demeritD1 => {
    const f = fixture();
    await expect(saveWeeklyPayLog(f.db, actor, { ...input, demeritD1 })).rejects.toMatchObject({ status: 400 });
    expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
  });
  it('does not guess a worker for administrator reads or writes', async () => {
    const f = fixture();
    expect(await getWeeklyPayLogs(f.db, actor)).toEqual([]);
    await expect(saveWeeklyPayLog(f.db, actor, { weekStart: input.weekStart, weekEnd: input.weekEnd })).rejects.toMatchObject({ status: 400 });
    expect(f.inserts).toEqual([]);
  });
  it('rejects cross-founder reads and writes without retagging history', async () => {
    const f = fixture();
    await saveWeeklyPayLog(f.db, actor, input);
    const before = structuredClone(f.rows.get(weeklyPayLog));
    const stranger = { id: 8, role: 'admin' as const };
    await expect(getWeeklyPayLogs(f.db, stranger, { vaId: 42 })).rejects.toMatchObject({ status: 403 });
    await expect(saveWeeklyPayLog(f.db, stranger, input)).rejects.toMatchObject({ status: 403 });
    expect(f.rows.get(weeklyPayLog)).toEqual(before);
  });
  it('rechecks actor and worker authority rather than trusting input roles', async () => {
    const f = fixture(); f.rows.get(users)![0].role = 'worker';
    await expect(saveWeeklyPayLog(f.db, actor, input)).rejects.toMatchObject({ status: 403 });
    expect(f.inserts).toEqual([]);
  });
  it.each(['linked', 'overlap', 'locked'] as const)('rejects changes to %s periods including detachment', async mode => {
    const f = fixture();
    const saved = await saveWeeklyPayLog(f.db, actor, input);
    if (mode === 'locked') f.rows.get(timeDayReviews)!.push({ dateKey: input.weekStart, status: 'locked', lockedAt: null });
    else {
      f.rows.get(paymentCycles)!.push(cycle({ isPaid: true, ...(mode === 'linked'
        ? { cycleStart: new Date('2026-11-02T00:00:00Z'), cycleEnd: new Date('2026-11-15T00:00:00Z') } : {}) }));
      if (mode === 'linked') f.rows.get(weeklyPayLog)![0].paymentCycleId = 1;
    }
    await expect(saveWeeklyPayLog(f.db, actor, { ...input, paymentCycleId: null, demeritD1: 1 })).rejects.toMatchObject({ status: 409 });
    expect(f.rows.get(weeklyPayLog)![0].id).toBe(saved.log.id);
    expect(f.rows.get(weeklyPayLog)![0].demeritD1).toBe('0.00');
  });
  it('settles and creates one linked successor atomically, with idempotent retry', async () => {
    const f = fixture(); f.rows.get(paymentCycles)!.push(cycle());
    const first = await settlePaymentCycle(f.db, actor, { cycleId: 1 });
    const replay = await settlePaymentCycle(f.db, actor, { cycleId: 1 });
    expect(first).toMatchObject({ outcome: 'settled', successor: { predecessorCycleId: 1 } });
    expect(replay).toMatchObject({ outcome: 'already_settled', successor: { id: first.successor.id } });
    expect(f.rows.get(paymentCycles)).toHaveLength(2); expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });
  it.each(['audit', 'successor'] as const)('rolls back settlement when %s persistence fails', async failure => {
    const f = fixture(failure === 'audit', failure === 'successor'); f.rows.get(paymentCycles)!.push(cycle());
    await expect(settlePaymentCycle(f.db, actor, { cycleId: 1 })).rejects.toThrow('Synthetic persistence failure');
    expect(f.rows.get(paymentCycles)).toEqual([cycle()]); expect(f.rows.get(financialLedgerEvents)).toEqual([]);
  });
  it('rolls back a weekly save when its audit fails', async () => {
    const f = fixture(true);
    await expect(saveWeeklyPayLog(f.db, actor, input)).rejects.toThrow('Synthetic persistence failure');
    expect(f.rows.get(weeklyPayLog)).toEqual([]); expect(f.rows.get(financialLedgerEvents)).toEqual([]);
  });
  it('increments existing counters and deduplicates only a matching event key', async () => {
    const f = fixture();
    await incrementWeeklyD1(f.db, 42, '2026-10-21', 20, 'flag-1');
    expect(await incrementWeeklyD1(f.db, 42, '2026-10-21', 20, 'flag-1')).toMatchObject({ outcome: 'unchanged' });
    await expect(incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag-1')).rejects.toMatchObject({ status: 409 });
    const next = await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag-2');
    expect(next.log).toMatchObject({ demeritD1: '21.00', projectedPay: '-15.00' });
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(2);
  });
  it('rejects ambiguous pre-migration weekly identity before writing', async () => {
    const f = fixture(); const { log } = await saveWeeklyPayLog(f.db, actor, input);
    f.rows.get(weeklyPayLog)!.push({ ...log, id: 2 });
    const count = f.inserts.length;
    await expect(saveWeeklyPayLog(f.db, actor, input)).rejects.toMatchObject({ status: 409 });
    expect(f.inserts).toHaveLength(count);
  });
});
