import { describe, expect, it } from 'vitest';
import { reconcileWeeklyRows, prepareApprovedWeeklySource, archiveApprovedWeeklySource, type WeeklyReconciliationPlan } from './approvedWeeklyReconciliation';
import type mysql from 'mysql2';
import type { Client } from 'pg';

function fixture(): WeeklyReconciliationPlan {
  return { version: 1, approval: 'The owner confirms one EUR allowance for this worker.',
    sourceBackupSha256: 'a'.repeat(64), ownerId: '7', workerId: '8', currency: 'EUR', amount: '90.00',
    originals: ['11', '12', '13'].map(id => ({ id, founderId: '8', vaId: '8',
      weekStart: '2026-01-04', weekEnd: '2026-01-10', baseAmount: '90.00', projectedPay: '90.00',
      totalMerits: '0.00', totalDemerits: '0.00', meritM1: '0.00', demeritD1: '0.00',
      notes: null, paymentCycleId: null, createdAt: `2026-01-0${Number(id) - 6} 12:00:00`,
      updatedAt: `2026-01-0${Number(id) - 6} 12:00:00` })) };
}

describe('explicit historical weekly reconciliation', () => {
  function sourceFixture(options: { links?: number; collision?: number; ownerRole?: string; drift?: boolean } = {}) {
    const plan = fixture(); const calls: string[] = [];
    const source = { promise: () => ({ query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('COLUMN_NAME AS name')) return [Object.keys(plan.originals[0]!).map(name => ({ name }))];
      if (sql.startsWith('SELECT CAST')) return [options.drift ? [] : plan.originals];
      if (sql.startsWith('SELECT id, role')) return [[{ id: 7, role: options.ownerRole ?? 'admin' }, { id: 8, role: 'worker' }]];
      if (sql.includes('SELECT DISTINCT TABLE_NAME')) return [[{ tableName: 'flags', columnName: 'weeklyPayLogId' }]];
      if (sql.startsWith('SELECT COUNT(*) AS n FROM `flags`')) return [[{ n: options.links ?? 0 }]];
      if (sql.startsWith('SELECT COUNT(*) AS n FROM weekly_pay_log')) return [[{ n: options.collision ?? 0 }]];
      return [[]];
    } }) } as unknown as mysql.Connection;
    return { plan, calls, source };
  }
  it('uses only temporary DDL and writes, with no snapshot-committing ALTER/RENAME', async () => {
    const f = sourceFixture(); await prepareApprovedWeeklySource(f.source, f.plan);
    const writes = f.calls.filter(sql => /^(CREATE|INSERT|DELETE|DROP|ALTER|RENAME|UPDATE)/.test(sql));
    expect(writes).toHaveLength(7);
    expect(writes.every(sql => /^(CREATE TEMPORARY TABLE|DROP TEMPORARY TABLE|INSERT INTO (va_reviewed_weekly|weekly_pay_log)|DELETE FROM va_reviewed_weekly)/.test(sql))).toBe(true);
    expect(f.calls.some(sql => /^(ALTER|RENAME|UPDATE|COMMIT)/.test(sql))).toBe(false);
  });
  it.each([{ links: 1 }, { collision: 1 }, { ownerRole: 'worker' }, { drift: true }])('refuses unsafe source before temporary writes: %j', async options => {
    const f = sourceFixture(options);
    await expect(prepareApprovedWeeklySource(f.source, f.plan)).rejects.toThrow();
    expect(f.calls.some(sql => /^(CREATE|INSERT|DELETE|DROP)/.test(sql))).toBe(false);
  });
  it('writes and verifies the complete archive, refusing failed readback without committing', async () => {
    const f = sourceFixture(); const result = await prepareApprovedWeeklySource(f.source, f.plan);
    const calls: string[] = []; const values: unknown[] = [];
    const target = { query: async (sql: string, args?: unknown[]) => {
      calls.push(sql); if (sql.startsWith('INSERT')) values.push(...args!);
      return { rows: [{ n: '0' }] };
    } } as unknown as Client;
    await expect(archiveApprovedWeeklySource(target, result)).rejects.toThrow('archive verification');
    expect(JSON.parse(values[2] as string)).toEqual(f.plan.originals);
    expect(calls.filter(sql => sql.startsWith('REVOKE'))).toHaveLength(2);
    expect(calls.some(sql => /COMMIT|ON CONFLICT|DELETE|UPDATE/.test(sql))).toBe(false);
  });
  it('preserves every original and anchors one owner-confirmed allowance without changing input', () => {
    const plan = fixture(); const before = structuredClone(plan);
    const result = reconcileWeeklyRows(plan, [...plan.originals].reverse());
    expect(plan).toEqual(before);
    expect(result.originals).toEqual(plan.originals);
    expect(result.canonical).toMatchObject({ id: '11', founderId: '7', vaId: '8', baseAmount: '90.00', projectedPay: '90.00' });
    expect(result.canonical.notes).toContain('EUR 90.00');
    expect(result.planSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects source drift, missing rows and extra rows', () => {
    const p = fixture();
    for (const actual of [p.originals.slice(1), [...p.originals, { ...p.originals[0]!, id: '14' }],
      p.originals.map(r => ({ ...r, updatedAt: '2026-02-01 00:00:00' }))]) {
      expect(() => reconcileWeeklyRows(p, actual)).toThrow('source changed');
    }
  });
  it.each(['baseAmount', 'projectedPay', 'vaId', 'founderId', 'weekStart', 'paymentCycleId', 'meritM1', 'notes'])(
    'rejects nonidentical business field %s', field => {
      const p = fixture(); p.originals[1]![field] = 'different';
      expect(() => reconcileWeeklyRows(p, p.originals)).toThrow('not identical');
    });
  it.each(['baseAmount', 'projectedPay', 'totalMerits', 'totalDemerits', 'meritM1', 'demeritD1', 'paymentCycleId', 'notes', 'vaId'])(
    'rejects identical rows with unapproved meaning %s', field => {
      const p = fixture(); p.originals.forEach(r => { r[field] = '1.00'; });
      expect(() => reconcileWeeklyRows(p, p.originals)).toThrow('meaning differs');
    });
  it('rejects missing approval, currency guessing, duplicate IDs and nonpositive amounts', () => {
    for (const change of [{ approval: '' }, { sourceBackupSha256: 'bad' }, { amount: '0.00' },
      { amount: '-90.00' }, { currency: 'USD' }, { ownerId: '8' }, { ownerId: '-1' }, { version: 2 }]) {
      const p = Object.assign(fixture(), change) as WeeklyReconciliationPlan;
      expect(() => reconcileWeeklyRows(p, p.originals)).toThrow('Invalid');
    }
    const p = fixture(); p.originals[1]!.id = '11';
    expect(() => reconcileWeeklyRows(p, p.originals)).toThrow('Invalid');
  });
});
