import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ increment: vi.fn(), database: {}, end: vi.fn(async () => {}), pool: vi.fn() }));
vi.mock('./financialLedger', () => ({ incrementWeeklyD1: controls.increment }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: () => controls.database }));
vi.mock('pg', () => ({ Pool: class {
  constructor() { controls.pool(); }
  on() {}
  end = controls.end;
} }));
import { closeDb, incrementPayLogD1 } from './db';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:fixture@127.0.0.1:35432/recovery_test');
  controls.increment.mockResolvedValue({ log: { id: 7, projectedPay: '-5.00' } });
});
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); });
describe('canonical D1 compatibility wrapper (all database access mocked)', () => {
  it('forwards exact event identity and preserves a negative projected estimate', async () => {
    expect(await incrementPayLogD1(42, '2026-10-25', 1, 'reply-monitor:vague:1')).toEqual({ id: 7, projectedPay: -5 });
    expect(controls.increment).toHaveBeenCalledExactlyOnceWith(controls.database, 42, '2026-10-25', 1, 'reply-monitor:vague:1');
  });
  it('passes the transaction callback unchanged to the canonical ledger', async () => {
    const guard = vi.fn(async () => {});
    await incrementPayLogD1(42, '2026-10-25', 1, 'reply-monitor:unsigned:1', guard);
    expect(controls.increment).toHaveBeenCalledExactlyOnceWith(controls.database, 42, '2026-10-25', 1, 'reply-monitor:unsigned:1', guard);
  });
  it('propagates financial failure rather than returning a fabricated balance', async () => {
    const error = new Error('Ledger conflict');
    controls.increment.mockRejectedValue(error);
    await expect(incrementPayLogD1(42, '2026-10-25', 1, 'reply-monitor:vague:1')).rejects.toBe(error);
  });
  it('fails without configured database access instead of returning the base amount', async () => {
    vi.stubEnv('DATABASE_URL', '');
    await expect(incrementPayLogD1(42, '2026-10-25', 1, 'reply-monitor:vague:1')).rejects.toThrow();
    expect(controls.increment).not.toHaveBeenCalled();
    expect(controls.pool).not.toHaveBeenCalled();
  });
});
