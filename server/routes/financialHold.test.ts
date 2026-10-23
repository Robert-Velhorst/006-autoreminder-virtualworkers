import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrpcContext } from '../_core/context';
import { FINANCIAL_PAUSED_MESSAGE } from '../../shared/financialAvailability';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), profile: vi.fn() }));
vi.mock('../db', () => ({ getDb: mocks.getDb }));
vi.mock('../workerOperatorContext', async original => ({
  ...(await original<typeof import('../workerOperatorContext')>()),
  getActiveWorkerProfileResolution: mocks.profile,
}));
import { paymentRouter, payLogRouter } from './manus';
import { autoDemeritUnsignedFlag, autoDemeritVagueReplyFlag, autoDemeriteExpiredUnsignedFlags,
  autoDemeriteExpiredVagueFlags, autoDemeriteExpiredUpworkFlags, markReplyThreadDemerited } from '../replyMonitorDb';

const context = (role: 'admin' | 'worker' | null): TrpcContext => ({
  req: {}, res: {}, user: role ? { id: role === 'admin' ? 1 : 2, role, openId: 'hold-test' } : null,
} as TrpcContext);
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('financial route hold', () => {
  it('blocks automatic charge adapters and demerit markers before DB access', async () => {
    vi.stubEnv('FINANCIAL_FEATURES_ENABLED', 'false');
    const operations = [
      () => autoDemeritUnsignedFlag(1), () => autoDemeritVagueReplyFlag(1),
      () => autoDemeriteExpiredUnsignedFlags(2), () => autoDemeriteExpiredVagueFlags(2),
      () => autoDemeriteExpiredUpworkFlags(2), () => markReplyThreadDemerited(2, 'card', 'trello'),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: FINANCIAL_PAUSED_MESSAGE });
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it.each(['admin', 'worker'] as const)('rejects every financial route before DB or profile lookup for %s', async role => {
    vi.stubEnv('FINANCIAL_FEATURES_ENABLED', 'false');
    const payment = paymentRouter.createCaller(context(role));
    const pay = payLogRouter.createCaller(context(role));
    const operations = [
      () => payment.getAllCycles(), () => payment.getCurrentCycle(), () => payment.markPaid({ cycleId: 1 }),
      () => pay.getAll({ vaId: 2 }), () => pay.getByWeek({ vaId: 2, weekStart: '2026-10-19' }),
      () => pay.upsert({ vaId: 2, weekStart: '2026-10-19', weekEnd: '2026-10-25', expectedRevision: null }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: FINANCIAL_PAUSED_MESSAGE });
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it('requires authentication for availability and does not resolve profiles or DB', async () => {
    vi.stubEnv('FINANCIAL_FEATURES_ENABLED', 'false');
    await expect(paymentRouter.createCaller(context(null)).availability()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(paymentRouter.createCaller(context('worker')).availability()).resolves.toEqual({ enabled: false });
    vi.stubEnv('FINANCIAL_FEATURES_ENABLED', 'true');
    await expect(paymentRouter.createCaller(context('admin')).availability()).resolves.toEqual({ enabled: true });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it('preserves enabled dev route behavior', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('FINANCIAL_FEATURES_ENABLED', undefined);
    mocks.getDb.mockResolvedValue(null);
    await expect(paymentRouter.createCaller(context('admin')).getCurrentCycle()).rejects.toMatchObject({ message: 'DB not available' });
    expect(mocks.getDb).toHaveBeenCalledOnce();
  });
});
