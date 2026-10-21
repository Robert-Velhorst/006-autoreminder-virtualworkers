import { and, eq, isNull, sql } from 'drizzle-orm';
import { timeEntries, timeEntryEvents, users, vaProfiles } from '../drizzle/schema.postgres';
import { TimerConflict, type TimerDatabase } from './canonicalTimer';

export async function timerIdentityReviewReport(db: TimerDatabase) {
  const entries = await db.select({ id: timeEntries.id, legacyVaId: timeEntries.vaId,
    founderId: timeEntries.founderId, startTime: timeEntries.startTime, endTime: timeEntries.endTime,
    isVoided: timeEntries.isVoided }).from(timeEntries).where(isNull(timeEntries.trackedUserId)).orderBy(timeEntries.id);
  const duplicates = await db.select({ trackedUserId: timeEntries.trackedUserId, count: sql<number>`count(*)::int` })
    .from(timeEntries).where(and(isNull(timeEntries.endTime), eq(timeEntries.isVoided, false)))
    .groupBy(timeEntries.trackedUserId).having(sql`count(*) > 1`);
  return { ready: !entries.some(row => row.endTime === null && !row.isVoided) && !duplicates.length,
    unresolvedEntryCount: entries.length, entries, activeGroupsRequiringReview: duplicates,
    policy: 'No owner is inferred from legacyVaId, source, or current profile membership.' };
}

export async function resolveTimerIdentity(db: TimerDatabase, input: {
  entryId: number; trackedUserId: number; trackedProfileId?: number; actorUserId: number;
  expectedFounderId: number; evidenceReference: string; execute: boolean;
}) {
  for (const value of [input.entryId, input.trackedUserId, input.actorUserId, input.expectedFounderId]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TimerConflict(400, 'Positive identity IDs are required');
  }
  if (input.trackedProfileId !== undefined && (!Number.isSafeInteger(input.trackedProfileId) || input.trackedProfileId <= 0)) {
    throw new TimerConflict(400, 'Invalid profile ID');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/.test(input.evidenceReference)) {
    throw new TimerConflict(400, 'A non-secret evidence reference is required; do not supply notes or credentials');
  }
  return db.transaction(async tx => {
    const privileges = await tx.execute<{ allowed: boolean }>(sql`SELECT has_table_privilege(current_user, 'public.time_entries', 'TRIGGER') AS allowed`);
    if (privileges.rows[0]?.allowed !== true) throw new TimerConflict(403, 'A privileged operator database connection is required');
    const accounts = [];
    for (const id of [...new Set([input.actorUserId, input.trackedUserId, input.expectedFounderId])].sort((a, b) => a - b)) {
      const [account] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).for('update');
      if (!account) throw new TimerConflict(409, 'Referenced account does not exist');
      accounts.push(account);
    }
    if (accounts.find(row => row.id === input.actorUserId)?.role !== 'admin') throw new TimerConflict(403, 'An operator administrator is required');
    if (input.trackedProfileId !== undefined) {
      const [profile] = await tx.select().from(vaProfiles).where(eq(vaProfiles.id, input.trackedProfileId)).for('update');
      if (!profile || profile.userId !== input.trackedUserId || profile.founderId !== input.expectedFounderId) {
        throw new TimerConflict(409, 'The supplied historical profile requires separate ownership review');
      }
    }
    const [before] = await tx.select().from(timeEntries).where(eq(timeEntries.id, input.entryId)).for('update');
    if (!before || before.founderId !== input.expectedFounderId) throw new TimerConflict(409, 'Entry or historical founder does not match');
    if (before.trackedUserId !== null) {
      if (before.trackedUserId !== input.trackedUserId || before.trackedProfileId !== (input.trackedProfileId ?? null)) {
        throw new TimerConflict(409, 'A resolved timer identity cannot be reassigned');
      }
      return { executed: false, alreadyResolved: true, entryId: before.id };
    }
    const after = { trackedUserId: input.trackedUserId, trackedProfileId: input.trackedProfileId ?? null };
    if (before.endTime === null && !before.isVoided) {
      const active = await tx.select({ id: timeEntries.id }).from(timeEntries).where(and(
        eq(timeEntries.trackedUserId, input.trackedUserId), isNull(timeEntries.endTime), eq(timeEntries.isVoided, false),
      ));
      if (active.length) {
        if (input.execute) throw new TimerConflict(409, 'An active canonical entry already exists. No identity, duration, or stop time was changed.');
        return { executed: false, entryId: before.id, proposed: after, blockedByActiveEntryIds: active.map(row => row.id) };
      }
    }
    if (!input.execute) return { executed: false, entryId: before.id, proposed: after };
    const transaction = await tx.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
    await tx.insert(timeEntryEvents).values({ timeEntryId: before.id, eventType: 'identity_resolution',
      beforeJson: JSON.stringify({ trackedUserId: null, trackedProfileId: before.trackedProfileId,
        legacyVaId: before.vaId, founderId: before.founderId }), afterJson: JSON.stringify(after),
      metadataJson: JSON.stringify({ actorUserId: input.actorUserId, evidenceReference: input.evidenceReference, transactionId: transaction.rows[0].id }) });
    const changed = await tx.update(timeEntries).set({ ...after, updatedAt: before.updatedAt }).where(and(eq(timeEntries.id, before.id), isNull(timeEntries.trackedUserId)))
      .returning({ id: timeEntries.id });
    if (changed.length !== 1) throw new TimerConflict(409, 'Entry changed while ownership was reviewed');
    return { executed: true, entryId: before.id };
  });
}
