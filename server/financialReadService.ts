import { TRPCError } from '@trpc/server';
import { and, asc, eq } from 'drizzle-orm';
import { paymentCycles, users, vaProfiles, type User } from '../drizzle/schema.postgres';
import type { getDb } from './db';
import { selectWorkerProfile } from './workerOperatorContext';

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Actor = Pick<User, 'id' | 'role'>;
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;
function denied(): never {
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Financial account access could not be verified' });
}

/** A worker's tracker uses its canonical founder, never the worker/profile ID as a founder ID. */
export async function readPaymentCycles(db: Database, actor: Actor, currentOnly = false) {
  if (!validId(actor.id) || (actor.role !== 'admin' && actor.role !== 'worker')) denied();
  return db.transaction(async tx => {
    const profileFields = { id: vaProfiles.id, userId: vaProfiles.userId, founderId: vaProfiles.founderId, status: vaProfiles.status };
    const observed = actor.role === 'worker' ? selectWorkerProfile(await tx.select(profileFields)
      .from(vaProfiles).where(eq(vaProfiles.userId, actor.id))) : null;
    if (actor.role === 'worker' && !observed) denied();
    const founderId = actor.role === 'admin' ? actor.id : observed!.founderId;
    if (!validId(founderId)) denied();

    // Match the writer's deterministic account-before-profile order. Shared
    // account locks also fence profile inserts/relinks via the lifecycle trigger.
    const accounts = new Map<number, { id: number; role: User['role'] }>();
    for (const id of [...new Set([actor.id, founderId])].sort((a, b) => a - b)) {
      const [account] = await tx.select({ id: users.id, role: users.role }).from(users)
        .where(eq(users.id, id)).for('share');
      if (account) accounts.set(id, account);
    }
    if (accounts.get(actor.id)?.role !== actor.role || accounts.get(founderId)?.role !== 'admin') denied();
    if (observed) {
      const fresh = selectWorkerProfile(await tx.select(profileFields).from(vaProfiles)
        .where(eq(vaProfiles.userId, actor.id)).orderBy(vaProfiles.id).for('share'));
      if (!fresh || fresh.id !== observed.id || fresh.userId !== actor.id || fresh.founderId !== founderId) denied();
    }

    const query = tx.select().from(paymentCycles)
      .where(currentOnly ? and(eq(paymentCycles.founderId, founderId), eq(paymentCycles.isPaid, false))
        : eq(paymentCycles.founderId, founderId))
      .orderBy(asc(paymentCycles.cycleStart), asc(paymentCycles.id));
    return currentOnly ? await query.limit(1) : await query;
  });
}
