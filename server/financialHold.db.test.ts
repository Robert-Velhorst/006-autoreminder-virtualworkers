import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ pool: vi.fn() }));
vi.mock('pg', async original => ({ ...(await original<typeof import('pg')>()), Pool: mocks.pool }));
vi.mock('./_core/env', () => ({ ENV: {} }));
import { incrementPayLogD1 } from './db';
import { FINANCIAL_PAUSED_MESSAGE } from '../shared/financialAvailability';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('blocks the automatic D1 DB wrapper before pool creation or source callback', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('FINANCIAL_FEATURES_ENABLED', 'false');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/never_connect');
  const callback = vi.fn();
  await expect(incrementPayLogD1(2, '2026-10-19', 1, 'hold-test', callback))
    .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: FINANCIAL_PAUSED_MESSAGE });
  expect(mocks.pool).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
});
