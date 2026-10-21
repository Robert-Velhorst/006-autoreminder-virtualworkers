import { and, eq, isNull, sql } from 'drizzle-orm';
import { users, vaProfiles, timeEntries, timeEntryEvents } from '../drizzle/schema.postgres';
import type { User } from '../drizzle/schema.postgres';
import type { getDb } from './db';

export type TimerDatabase = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type TimerTransaction = Parameters<Parameters<TimerDatabase['transaction']>[0]>[0];
export class TimerConflict extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function requireEntryId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TimerConflict(400, 'A positive entryId is required. Reload the active timer before trying again.');
  }
  return Number(value);
}

export function timerFailure(error: unknown) {
  if (error instanceof TimerConflict) return { status: error.status, error: error.message };
  const pg = error as { code?: string; cause?: { code?: string } };
  const code = pg?.cause?.code ?? pg?.code;
  if (code === '23505') return { status: 409, error: 'Timer already active. Stop the previous entry before starting another.' };
  if (code === 'PT409') return { status: 409, error: 'Timer ownership requires operator review before tracking can continue.' };
  return null;
}

export async function lockTimerAccount(tx: TimerTransaction, actor: Pick<User, 'id' | 'role'>, subjectId = actor.id, expectedFounderId?: number) {
  const ids = [...new Set([actor.id, subjectId])].sort((a, b) => a - b);
  const accounts = [];
  for (const id of ids) {
    const [account] = await tx.select().from(users).where(eq(users.id, id)).for('update');
    if (!account) throw new TimerConflict(403, 'Timer account is unavailable');
    accounts.push(account);
  }
  const freshActor = accounts.find(account => account.id === actor.id)!;
  if (freshActor.role !== actor.role) throw new TimerConflict(403, 'Account permissions changed; reload before trying again');
  if (subjectId !== actor.id && freshActor.role !== 'admin') throw new TimerConflict(403, 'Admin access required');
  const subject = accounts.find(account => account.id === subjectId)!;
  if (subject.role !== 'worker') {
    if (subjectId !== actor.id) throw new TimerConflict(403, 'The linked account is not a worker account');
    if (expectedFounderId !== undefined && expectedFounderId !== actor.id) throw new TimerConflict(409, 'Timer belongs to a previous founder');
    return { account: subject, profile: null, founderId: actor.id };
  }
  const profiles = await tx.select().from(vaProfiles).where(eq(vaProfiles.userId, subjectId)).orderBy(vaProfiles.id).for('update');
  const active = profiles.filter(profile => profile.status === 'active');
  if (active.length !== 1) throw new TimerConflict(403, 'Exactly one active worker profile is required');
  const profile = active[0];
  if (expectedFounderId !== undefined && profile.founderId !== expectedFounderId) throw new TimerConflict(409, 'Worker founder ownership changed');
  if (subjectId !== actor.id && profile.founderId !== actor.id) throw new TimerConflict(404, 'Worker profile not found');
  return { account: subject, profile, founderId: profile.founderId };
}

export async function assertTimerIdentityReady(tx: Pick<TimerDatabase, 'select'>) {
  const unresolved = await tx.select({ id: timeEntries.id }).from(timeEntries)
    .where(and(isNull(timeEntries.trackedUserId), isNull(timeEntries.endTime), eq(timeEntries.isVoided, false))).limit(1);
  if (unresolved.length) throw new TimerConflict(409, 'Active legacy timers require operator ownership review');
}

export async function withTimerAccountTransaction<T>(db: TimerDatabase, actor: Pick<User, 'id' | 'role'>,
  work: (tx: TimerTransaction, locked: Awaited<ReturnType<typeof lockTimerAccount>>) => Promise<T>,
  subjectId = actor.id, expectedFounderId?: number) {
  return db.transaction(async tx => {
    const locked = await lockTimerAccount(tx, actor, subjectId, expectedFounderId);
    return work(tx, locked);
  });
}

export async function insertCanonicalTimer(tx: TimerTransaction, values: typeof timeEntries.$inferInsert) {
  if (!values.trackedUserId) throw new TimerConflict(409, 'Canonical timer owner is required');
  await assertTimerIdentityReady(tx);
  const active = await tx.select({ id: timeEntries.id }).from(timeEntries).where(and(
    eq(timeEntries.trackedUserId, values.trackedUserId), isNull(timeEntries.endTime), eq(timeEntries.isVoided, false),
  )).limit(1);
  if (active.length) throw new TimerConflict(409, 'Timer already active. Stop the previous entry before starting another.');
  const [entry] = await tx.insert(timeEntries).values(values).returning();
  if (!entry) throw new Error('Timer insert returned no row');
  return entry;
}

export async function correctCanonicalTimer(db: TimerDatabase, actor: User, entryId: number,
  correction: { void?: boolean; durationSeconds?: number }) {
  requireEntryId(entryId);
  return db.transaction(async tx => {
    const locked = await lockTimerAccount(tx, actor);
    const [before] = await tx.select().from(timeEntries).where(and(eq(timeEntries.id, entryId),
      eq(timeEntries.trackedUserId, actor.id), eq(timeEntries.founderId, locked.founderId))).for('update');
    if (!before) throw new TimerConflict(404, 'Time entry not found');
    if (!before.endTime) throw new TimerConflict(409, 'Stop this exact timer before editing its history');
    if (correction.void && before.isVoided) return before;
    const seconds = correction.durationSeconds;
    const values = correction.void ? { isVoided: true, voidedAt: new Date(), voidReason: 'Explicit user correction' }
      : { durationSeconds: seconds, durationMinutes: Math.round(seconds! / 60), endTime: new Date(before.startTime.getTime() + seconds! * 1000) };
    const [after] = await tx.update(timeEntries).set(values).where(and(eq(timeEntries.id, entryId),
      eq(timeEntries.trackedUserId, actor.id), eq(timeEntries.founderId, locked.founderId))).returning();
    if (!after) throw new TimerConflict(409, 'Time entry changed');
    const snapshot = (row: typeof before) => JSON.stringify({ durationSeconds: row.durationSeconds,
      durationMinutes: row.durationMinutes, endTime: row.endTime, isVoided: row.isVoided });
    await tx.insert(timeEntryEvents).values({ timeEntryId: entryId, eventType: correction.void ? 'manual_void' : 'manual_duration',
      beforeJson: snapshot(before), afterJson: snapshot(after), metadataJson: JSON.stringify({ actorUserId: actor.id }) });
    return after;
  });
}

export async function closeCanonicalTimer(db: TimerDatabase, actor: Pick<User, 'id' | 'role'>,
  entryId: number, transition: 'stop' | 'pause', options: { cardId?: string; notes?: string | null; founderManaged?: boolean;
    afterClose?: (tx: TimerTransaction, entry: typeof timeEntries.$inferSelect) => Promise<void> } = {}) {
  requireEntryId(entryId);
  return db.transaction(async tx => {
    const [observed] = await tx.select().from(timeEntries).where(eq(timeEntries.id, entryId));
    if (!observed || (!options.founderManaged && observed.trackedUserId !== actor.id)
      || (options.founderManaged && (actor.role !== 'admin' || observed.founderId !== actor.id))) {
      throw new TimerConflict(404, 'Time entry not found');
    }
    if (observed.trackedUserId === null) throw new TimerConflict(409, 'This entry requires operator ownership review');
    if (options.founderManaged) {
      // Historical closure is not a new grant of worker eligibility. Inactive,
      // reassigned, or promoted subjects must not strand the old founder's timer.
      for (const id of [...new Set([actor.id, observed.trackedUserId])].sort((a, b) => a - b)) {
        const [account] = await tx.select().from(users).where(eq(users.id, id)).for('update');
        if (!account || (id === actor.id && account.role !== 'admin')) throw new TimerConflict(403, 'Admin access required');
      }
    } else {
      await lockTimerAccount(tx, actor, observed.trackedUserId, observed.founderId);
    }
    const [entry] = await tx.select().from(timeEntries).where(and(eq(timeEntries.id, entryId),
      eq(timeEntries.trackedUserId, observed.trackedUserId), eq(timeEntries.founderId, observed.founderId))).for('update');
    if (!entry || entry.isVoided || (options.cardId !== undefined && (entry.cardId ?? entry.taskId) !== options.cardId)) {
      throw new TimerConflict(409, 'Timer identity or state changed; reload before trying again');
    }
    if (entry.endTime) return { success: true, entry, alreadyStopped: true, alreadyPaused: /\(paused\)\s*$/.test(entry.notes ?? ''),
      paused: /\(paused\)\s*$/.test(entry.notes ?? ''), taskId: entry.taskId };
    const now = new Date();
    const seconds = Math.max(0, Math.round((now.getTime() - entry.startTime.getTime()) / 1000));
    const notes = transition === 'pause' ? `${entry.notes ?? ''}${entry.notes ? ' ' : ''}(paused)` : options.notes ?? entry.notes;
    const changed = await tx.update(timeEntries).set({ endTime: now, durationSeconds: seconds, durationMinutes: Math.round(seconds / 60), notes })
      .where(and(eq(timeEntries.id, entryId), eq(timeEntries.trackedUserId, entry.trackedUserId!),
        eq(timeEntries.founderId, entry.founderId), isNull(timeEntries.endTime), eq(timeEntries.isVoided, false))).returning();
    if (changed.length !== 1) throw new TimerConflict(409, 'Timer changed before it could be closed');
    await tx.insert(timeEntryEvents).values({ timeEntryId: entry.id, eventType: 'timer_closed', reason: transition,
      beforeJson: JSON.stringify({ endTime: null }),
      afterJson: JSON.stringify({ endTime: changed[0].endTime, durationSeconds: seconds }),
      metadataJson: JSON.stringify({ actorUserId: actor.id, trackedUserId: entry.trackedUserId, founderId: entry.founderId }) });
    await options.afterClose?.(tx, changed[0]);
    return { success: true, entry: changed[0], paused: transition === 'pause', taskId: entry.taskId };
  });
}

export async function timeCompleteness(db: Pick<TimerDatabase, 'select'>, founderId?: number) {
  const [result] = await db.select({ count: sql<number>`count(*)::int` }).from(timeEntries).where(and(
    isNull(timeEntries.trackedUserId), eq(timeEntries.isVoided, false),
    founderId === undefined ? undefined : eq(timeEntries.founderId, founderId),
  ));
  const unresolvedEntryCount = Number(result?.count ?? 0);
  return { complete: unresolvedEntryCount === 0, unresolvedEntryCount };
}
