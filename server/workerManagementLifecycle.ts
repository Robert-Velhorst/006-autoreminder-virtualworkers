import { and, eq, isNull, or } from 'drizzle-orm';
import { users, vaProfiles, workerInvitations, workerLifecycleAudit } from '../drizzle/schema.postgres';
import type { getDb } from './db';

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ProfileInput = typeof vaProfiles.$inferInsert;

export class WorkerManagementError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function validateWorkerStatus(status: unknown) {
  if (status !== undefined && !['active', 'inactive', 'on_leave'].includes(status as string)) {
    throw new WorkerManagementError(400, 'Invalid worker status');
  }
}

export function validateWorkerEmail(email: unknown): asserts email is string {
  if (typeof email !== 'string' || email.length > 64 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new WorkerManagementError(400, 'A valid worker email is required');
  }
}

async function lockedWorker(tx: Transaction, founderId: number, vaId: number) {
  const [observed] = await tx.select().from(vaProfiles)
    .where(and(eq(vaProfiles.id, vaId), eq(vaProfiles.founderId, founderId)));
  if (!observed) throw new WorkerManagementError(404, 'VA not found');
  // Account locks precede profile locks, matching the session-epoch triggers.
  const accounts = await tx.select().from(users).where(eq(users.id, observed.userId)).for('update');
  if (accounts.length !== 1 || accounts[0].role !== 'worker') {
    throw new WorkerManagementError(409, 'The linked account is not a worker account');
  }
  const profiles = await tx.select().from(vaProfiles).where(eq(vaProfiles.userId, observed.userId))
    .orderBy(vaProfiles.id).for('update');
  if (profiles.length !== 1) throw new WorkerManagementError(409, 'The linked worker profile is ambiguous');
  const profile = profiles[0];
  if (profile.id !== vaId || profile.founderId !== founderId || profile.userId !== accounts[0].id) {
    throw new WorkerManagementError(409, 'Worker ownership changed; reload before trying again');
  }
  return { account: accounts[0], profile };
}

async function assertEmailAvailable(tx: Transaction, email: string, ownId?: number) {
  const matches = await tx.select().from(users).where(or(eq(users.openId, email), eq(users.email, email)));
  if (matches.some(account => account.id !== ownId)) throw new WorkerManagementError(409, 'Email already registered');
}

export async function createManagedWorker(db: Database, actorUserId: number, profile: Omit<ProfileInput, 'userId' | 'founderId'>, passwordHash: string) {
  validateWorkerEmail(profile.email);
  validateWorkerStatus(profile.status);
  const email = profile.email;
  return db.transaction(async tx => {
    await assertEmailAvailable(tx, email);
    const [account] = await tx.insert(users).values({ openId: email, email,
      name: profile.name, role: 'worker', loginMethod: 'local', passwordHash, lastSignedIn: new Date() })
      .returning({ id: users.id });
    if (!account) throw new Error('Worker account insert failed');
    const [created] = await tx.insert(vaProfiles).values({ ...profile, userId: account.id, founderId: actorUserId }).returning();
    if (!created) throw new Error('Worker profile insert failed');
    await tx.insert(workerLifecycleAudit).values({ actorUserId, userId: account.id, workerProfileId: created.id,
      founderId: actorUserId, action: 'create', previousStatus: null, nextStatus: created.status });
    return created.id;
  });
}

export async function updateManagedWorker(db: Database, actorUserId: number, vaId: number,
  updates: Partial<ProfileInput>, passwordHash?: string, offboard = false) {
  validateWorkerStatus(updates.status);
  if (updates.email !== undefined) validateWorkerEmail(updates.email);
  return db.transaction(async tx => {
    const { account, profile } = await lockedWorker(tx, actorUserId, vaId);
    const credentials: Partial<typeof users.$inferInsert> = {};
    if (passwordHash) credentials.passwordHash = passwordHash;
    if (updates.email !== undefined && updates.email !== profile.email) {
      validateWorkerEmail(updates.email);
      await assertEmailAvailable(tx, updates.email, account.id);
      credentials.openId = updates.email;
      credentials.email = updates.email;
    }
    if (Object.keys(credentials).length) {
      const changed = await tx.update(users).set(credentials)
        .where(and(eq(users.id, account.id), eq(users.role, 'worker'))).returning({ id: users.id });
      if (changed.length !== 1) throw new WorkerManagementError(409, 'Worker account changed');
    }
    const changed = await tx.update(vaProfiles).set(offboard ? { status: 'inactive' } : { ...updates, skills: updates.skills === undefined ? profile.skills : updates.skills })
      .where(and(eq(vaProfiles.id, vaId), eq(vaProfiles.userId, account.id), eq(vaProfiles.founderId, actorUserId))).returning();
    if (changed.length !== 1) throw new WorkerManagementError(409, 'Worker profile changed');
    if (offboard || (updates.status !== undefined && updates.status !== 'active')) {
      await tx.update(workerInvitations).set({ revokedAt: new Date() })
        .where(and(eq(workerInvitations.userId, account.id), isNull(workerInvitations.acceptedAt), isNull(workerInvitations.revokedAt)));
    }
    await tx.insert(workerLifecycleAudit).values({ actorUserId, userId: account.id, workerProfileId: vaId, founderId: actorUserId,
      action: offboard ? 'offboard' : profile.status !== 'active' && changed[0].status === 'active' ? 'reactivate' : 'update',
      previousStatus: profile.status, nextStatus: changed[0].status });
  });
}

export function workerManagementFailure(error: unknown): { status: number; error: string } | null {
  if (error instanceof WorkerManagementError) return { status: error.status, error: error.message };
  const pg = error as { code?: string; cause?: { code?: string } };
  if (pg?.code === '23505' || pg?.cause?.code === '23505') return { status: 409, error: 'Email already registered' };
  return null;
}
