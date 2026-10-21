import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { financialLedgerEvents, paymentCycles, weeklyPayLog, users, vaProfiles, timeDayReviews, vagueReplyFlags } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';
import { getWeeklyPayLogs, incrementWeeklyD1, saveWeeklyPayLog, settlePaymentCycle } from './financialLedger';
import { weeklyPayRevision } from '../shared/financialRevision';

const actor = { id: 7, role: 'admin' as const };
const input = { vaId: 42, weekStart: '2026-10-19', weekEnd: '2026-10-25', expectedRevision: null };
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
  it.each([undefined, 12, {}])('requires an explicit revision and rejects invalid revision %j without writes', async expectedRevision => {
    const f = fixture();
    await expect(saveWeeklyPayLog(f.db, actor, { ...input, expectedRevision } as any)).rejects.toMatchObject({ status: 400 });
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
  });

  it('rejects an omitted revision rather than inferring create intent', async () => {
    const f = fixture();
    const { expectedRevision: _revision, ...withoutRevision } = input;
    await expect(saveWeeklyPayLog(f.db, actor, withoutRevision)).rejects.toMatchObject({ status: 400 });
    expect(f.inserts).toEqual([]); expect(f.updates).toEqual([]);
  });

  it('normalizes equivalent persisted numeric/date representations without using update timestamps', async () => {
    const f = fixture();
    const { log } = await saveWeeklyPayLog(f.db, actor, input);
    const equivalent = { ...log, weekStart: '2026-10-19', weekEnd: '2026-10-25T00:00:00.000Z',
      meritM1: 0, demeritD1: '0', updatedAt: new Date('2030-01-01T01:00:00Z') };
    expect(weeklyPayRevision(equivalent)).toBe(weeklyPayRevision(log));
    expect(weeklyPayRevision(null)).toBeNull();
    for (const change of [{ id: log.id + 1 }, { founderId: 8 }, { vaId: 43 },
      { notes: 'Different note' }, { paymentCycleId: 1 }, { demeritD1: '1.00' }, { weekEnd: '2026-10-26' }]) {
      expect(weeklyPayRevision({ ...log, ...change })).not.toBe(weeklyPayRevision(log));
    }
  });

  it('rejects a stale founder form after an automated D1 increment without overwriting the charge or audit', async () => {
    const f = fixture();
    const first = await saveWeeklyPayLog(f.db, actor, input);
    const loadedRevision = weeklyPayRevision(first.log);
    await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:stale-form');
    const beforeRows = structuredClone(f.rows.get(weeklyPayLog));
    const beforeEvents = structuredClone(f.rows.get(financialLedgerEvents));
    const updates = f.updates.length, inserts = f.inserts.length;
    await expect(saveWeeklyPayLog(f.db, actor, { ...input, expectedRevision: loadedRevision, meritM2: 1 }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed since this form was loaded/) });
    expect(f.rows.get(weeklyPayLog)).toEqual(beforeRows);
    expect(f.rows.get(financialLedgerEvents)).toEqual(beforeEvents);
    expect(f.updates).toHaveLength(updates); expect(f.inserts).toHaveLength(inserts);
    const refreshed = f.rows.get(weeklyPayLog)![0];
    expect((await saveWeeklyPayLog(f.db, actor, { ...input, expectedRevision: weeklyPayRevision(refreshed), demeritD1: 1, meritM2: 1 })).log)
      .toMatchObject({ id: first.log.id, demeritD1: '1.00', meritM2: '1.00', projectedPay: '92.50' });
  });

  it('does not let an absent-row form overwrite a row created after it loaded', async () => {
    const f = fixture();
    await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:created-after-load');
    const beforeRows = structuredClone(f.rows.get(weeklyPayLog));
    const beforeEvents = structuredClone(f.rows.get(financialLedgerEvents));
    await expect(saveWeeklyPayLog(f.db, actor, { ...input, expectedRevision: weeklyPayRevision(null) })).rejects.toMatchObject({ status: 409 });
    expect(f.rows.get(weeklyPayLog)).toEqual(beforeRows);
    expect(f.rows.get(financialLedgerEvents)).toEqual(beforeEvents);
  });

  it('runs the source callback after financial locks and commits its marker with the increment', async () => {
    const f = fixture();
    f.rows.set(vagueReplyFlags, [{ id: 1, vaId: 42, demeritIssued: false }]);
    const marker = vi.fn(async (tx: any) => {
      expect(tx).toBe(f.db);
      const statements = f.db.execute.mock.calls.map(([query]: any[]) => new PgDialect().sqlToQuery(query).sql);
      expect(statements[0]).toContain('pg_advisory_xact_lock');
      expect(statements[1]).toContain('LOCK TABLE public.time_day_reviews IN SHARE MODE');
      await tx.update(vagueReplyFlags).set({ demeritIssued: true }).where(eq(vagueReplyFlags.id, 1));
    });
    const result = await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:1', marker);
    expect(marker).toHaveBeenCalledOnce();
    expect(result.log.demeritD1).toBe('1.00');
    expect(f.rows.get(vagueReplyFlags)![0].demeritIssued).toBe(true);
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });

  it('does not invoke or repair a source marker when replaying an already committed event', async () => {
    const f = fixture();
    const first = await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:1');
    f.rows.set(vagueReplyFlags, [{ id: 1, vaId: 42, demeritIssued: false }]);
    const marker = vi.fn(async (tx: any) => {
      await tx.update(vagueReplyFlags).set({ demeritIssued: true }).where(eq(vagueReplyFlags.id, 1));
    });
    expect(await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:1', marker))
      .toMatchObject({ outcome: 'unchanged', log: { id: first.log.id, demeritD1: '1.00' } });
    expect(marker).not.toHaveBeenCalled();
    expect(f.rows.get(vagueReplyFlags)![0].demeritIssued).toBe(false);
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });

  it('does not invoke the source callback on a conflicting replay key', async () => {
    const f = fixture();
    await incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:1');
    const marker = vi.fn();
    await expect(incrementWeeklyD1(f.db, 42, '2026-10-21', 2, 'flag:1', marker)).rejects.toMatchObject({ status: 409 });
    expect(marker).not.toHaveBeenCalled();
    expect(f.rows.get(weeklyPayLog)![0].demeritD1).toBe('1.00');
  });

  it('rolls back callback changes when the callback rejects a new increment', async () => {
    const f = fixture();
    f.rows.set(vagueReplyFlags, [{ id: 1, vaId: 42, demeritIssued: false }]);
    const before = structuredClone(f.rows.get(weeklyPayLog));
    await expect(incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:1', async tx => {
      await tx.update(vagueReplyFlags).set({ demeritIssued: true }).where(eq(vagueReplyFlags.id, 1));
      throw new Error('Source no longer chargeable');
    })).rejects.toThrow('Source no longer chargeable');
    expect(f.rows.get(vagueReplyFlags)![0].demeritIssued).toBe(false);
    expect(f.rows.get(weeklyPayLog)).toEqual(before);
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(0);
  });

  it('rolls back a callback marker when the mandatory increment audit fails', async () => {
    const f = fixture(true);
    f.rows.set(vagueReplyFlags, [{ id: 1, vaId: 42, demeritIssued: false }]);
    await expect(incrementWeeklyD1(f.db, 42, '2026-10-21', 1, 'flag:1', async tx => {
      await tx.update(vagueReplyFlags).set({ demeritIssued: true }).where(eq(vagueReplyFlags.id, 1));
    })).rejects.toThrow('Synthetic persistence failure');
    expect(f.rows.get(vagueReplyFlags)![0].demeritIssued).toBe(false);
    expect(f.rows.get(weeklyPayLog)).toEqual([]);
    expect(f.rows.get(financialLedgerEvents)).toEqual([]);
  });
  it('uses UI count weights, integer cents and raw negative estimates', async () => {
    const f = fixture();
    const { log } = await saveWeeklyPayLog(f.db, actor, { ...input, meritM1: 1, meritM2: 1, demeritD1: 30 });
    expect(log).toMatchObject({ totalMerits: '12.50', totalDemerits: '150.00', projectedPay: '-47.50', demeritD1: '30.00' });
    expect(f.rows.get(financialLedgerEvents)).toHaveLength(1);
  });
  it('retains row ID and does not append another audit on an identical save', async () => {
    const f = fixture();
    const first = await saveWeeklyPayLog(f.db, actor, input);
    const second = await saveWeeklyPayLog(f.db, actor, { ...input, expectedRevision: weeklyPayRevision(first.log) });
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
    await expect(saveWeeklyPayLog(f.db, actor, { weekStart: input.weekStart, weekEnd: input.weekEnd, expectedRevision: null })).rejects.toMatchObject({ status: 400 });
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
    await expect(saveWeeklyPayLog(f.db, actor, { ...input, expectedRevision: weeklyPayRevision(f.rows.get(weeklyPayLog)![0]),
      paymentCycleId: null, demeritD1: 1 })).rejects.toMatchObject({ status: 409 });
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
