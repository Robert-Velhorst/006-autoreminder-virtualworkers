import { describe, expect, it } from 'vitest';
import { appRouter } from './routers';
import type { TrpcContext } from './_core/context';

function context(user: TrpcContext['user']): TrpcContext {
  return { user, req: { headers: {} } as TrpcContext['req'], res: {} as TrpcContext['res'] };
}

describe('auth.me public identity boundary', () => {
  it.each(['user', 'admin', 'worker'] as const)('exposes only public identity fields for %s', async role => {
    const now = new Date('2026-10-21T10:00:00Z');
    const user = {
      id: 7, openId: 'synthetic-account', name: 'Synthetic User', email: 'user@example.invalid',
      loginMethod: 'local', role, createdAt: now, updatedAt: now, lastSignedIn: now,
      passwordHash: 'synthetic-password-hash', sessionEpoch: '42',
      futurePrivateField: 'must-not-be-returned',
    };
    const result = await appRouter.createCaller(context(user)).auth.me();
    expect(result).toEqual({
      id: 7, openId: user.openId, name: user.name, email: user.email,
      loginMethod: user.loginMethod, role, createdAt: now, updatedAt: now, lastSignedIn: now,
    });
    for (const key of ['passwordHash', 'sessionEpoch', 'futurePrivateField']) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it('returns null for anonymous or legacy mock contexts', async () => {
    expect(await appRouter.createCaller(context(null)).auth.me()).toBeNull();
    const mock = { loginMethod: 'mock' } as TrpcContext['user'];
    expect(await appRouter.createCaller(context(mock)).auth.me()).toBeNull();
  });
});
