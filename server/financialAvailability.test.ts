import { afterEach, describe, expect, it, vi } from 'vitest';
import { financialFeaturesEnabled } from './financialAvailability';
import { FINANCIAL_PAUSED_MESSAGE } from '../shared/financialAvailability';
import { getWeeklyPayLog, getWeeklyPayLogs, incrementWeeklyD1, saveWeeklyPayLog, settlePaymentCycle } from './financialLedger';
import { readPaymentCycles } from './financialReadService';

afterEach(() => vi.unstubAllEnvs());

describe('financial availability', () => {
  it.each([
    ['production', undefined, false], ['production', 'true', true],
    ['production', 'false', false], ['production', '', false], ['production', 'TRUE', false],
    ['test', undefined, true], ['development', undefined, true],
    ['test', 'false', false], ['development', 'false', false], ['test', 'invalid', false],
  ])('%s / %s => %s', (mode, flag, enabled) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('FINANCIAL_FEATURES_ENABLED', flag);
    expect(financialFeaturesEnabled()).toBe(enabled);
  });

  it.each(['explicit hold', 'production default'])('blocks all direct services before DB access: %s', async mode => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FINANCIAL_FEATURES_ENABLED', mode === 'explicit hold' ? 'false' : undefined);
    const db = { transaction: vi.fn(), select: vi.fn(), insert: vi.fn(), update: vi.fn() } as any;
    const actor = { id: 1, role: 'admin' as const };
    const callback = vi.fn();
    const operations = [
      () => getWeeklyPayLogs(db, actor, { vaId: 2 }),
      () => getWeeklyPayLog(db, actor, { vaId: 2, weekStart: '2026-10-19' }),
      () => readPaymentCycles(db, actor),
      () => readPaymentCycles(db, actor, true),
      () => saveWeeklyPayLog(db, actor, { vaId: 2, weekStart: '2026-10-19', weekEnd: '2026-10-25', expectedRevision: null }),
      () => settlePaymentCycle(db, actor, { cycleId: 1 }),
      () => incrementWeeklyD1(db, 2, '2026-10-19', 1, 'hold-test', callback),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: FINANCIAL_PAUSED_MESSAGE });
    }
    for (const method of Object.values(db)) expect(method).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});
