import { describe, expect, it } from 'vitest';
import type { User } from '../../drizzle/schema.postgres';
import { timeTrackingOwnership } from './time-tracking';

function user(role: User['role']): User {
  return {
    id: 42,
    openId: 'test-user',
    name: 'Test user',
    email: null,
    loginMethod: 'local',
    role,
    passwordHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
}

describe('timeTrackingOwnership', () => {
  it('keeps worker time scoped to the signed-in worker and records the owning founder', () => {
    expect(timeTrackingOwnership(user('worker'), 9)).toEqual({ vaId: 42, founderId: 9 });
  });

  it('does not let an admin profile redirect the admin compatibility timer', () => {
    expect(timeTrackingOwnership(user('admin'), 9)).toEqual({ vaId: 42, founderId: 42 });
  });

  it('uses the worker account as a safe fallback when no profile is available', () => {
    expect(timeTrackingOwnership(user('worker'))).toEqual({ vaId: 42, founderId: 42 });
  });
});
