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

export type LegacyTimerClosureInput = {
  entryId: number; trackedUserId: number; trackedProfileId: number | null; actorUserId: number;
  expectedFounderId: number; expectedLegacyVaId: number | null; expectedTrackedProfileId: number | null;
  endTime: string; reason: string; evidenceReference: string; execute: boolean;
};

function closureInput(input: LegacyTimerClosureInput) {
  for (const id of [input.entryId, input.trackedUserId, input.actorUserId, input.expectedFounderId]) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new TimerConflict(400, 'Positive identity IDs are required');
  }
  for (const id of [input.trackedProfileId, input.expectedLegacyVaId, input.expectedTrackedProfileId]) {
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new TimerConflict(400, 'Explicit positive or null profile/provenance IDs are required');
  }
  if (typeof input.execute !== 'boolean') throw new TimerConflict(400, 'Explicit execution mode is required');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const evidenceReference = typeof input.evidenceReference === 'string' ? input.evidenceReference.trim() : '';
  if (reason.length < 10 || reason.length > 2000) throw new TimerConflict(400, 'A closure reason of 10 to 2000 characters is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/.test(evidenceReference)) {
    throw new TimerConflict(400, 'A non-secret source evidence reference is required');
  }
  // Accept explicit UTC instants only, at PostgreSQL/JS's shared millisecond precision.
  const match = typeof input.endTime === 'string' && /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.exec(input.endTime);
  const endTime = new Date(input.endTime);
  if (!match || !Number.isFinite(endTime.getTime()) || endTime.toISOString().slice(0, 10) !== match[1]
    || endTime.getUTCFullYear() < 1) throw new TimerConflict(400, 'Supply the actual end time as a valid UTC ISO timestamp, never an estimated current time');
  return { reason, evidenceReference, endTime: endTime.toISOString() };
}

/** Offline recovery: one identity-resolution UPDATE also closes the row, never occupying an active slot. */
export async function resolveAndCloseLegacyTimer(db: TimerDatabase, input: LegacyTimerClosureInput) {
  const proposed = closureInput(input);
  return db.transaction(async tx => {
    const privilege = await tx.execute<{ allowed: boolean }>(sql`SELECT has_table_privilege(current_user, 'public.time_entries', 'TRIGGER') AS allowed`);
    if (privilege.rows[0]?.allowed !== true) throw new TimerConflict(403, 'A privileged operator database connection is required');
    const accounts = [];
    for (const id of [...new Set([input.actorUserId, input.trackedUserId, input.expectedFounderId])].sort((a, b) => a - b)) {
      const [account] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).for('update');
      if (!account) throw new TimerConflict(409, 'Referenced account does not exist');
      accounts.push(account);
    }
    if (accounts.find(row => row.id === input.actorUserId)?.role !== 'admin') throw new TimerConflict(403, 'An operator administrator is required');
    if (input.trackedProfileId !== null) {
      const [profile] = await tx.select().from(vaProfiles).where(eq(vaProfiles.id, input.trackedProfileId)).for('update');
      if (!profile || profile.userId !== input.trackedUserId || profile.founderId !== input.expectedFounderId) {
        throw new TimerConflict(409, 'The supplied historical profile requires separate ownership review');
      }
    }
    const [before] = await tx.select().from(timeEntries).where(eq(timeEntries.id, input.entryId)).for('update');
    if (!before || before.founderId !== input.expectedFounderId || before.vaId !== input.expectedLegacyVaId || before.isVoided) {
      throw new TimerConflict(409, 'Entry, provenance, or historical founder does not match');
    }
    // Read naive database timestamps as UTC in SQL, independent of the operator's OS timezone.
    const timing = await tx.execute<{ validStart: boolean; validEnd: boolean; sameEnd: boolean; original: Record<string, unknown> }>(sql`
      SELECT (t."startTime" AT TIME ZONE 'UTC') <= ${proposed.endTime}::timestamptz AS "validStart",
        ${proposed.endTime}::timestamptz <= clock_timestamp() AS "validEnd",
        (t."endTime" AT TIME ZONE 'UTC') = ${proposed.endTime}::timestamptz AS "sameEnd",
        jsonb_build_object('trackedUserId',t."trackedUserId",'trackedProfileId',t."trackedProfileId",
          'legacyVaId',t."vaId",'founderId',t."founderId",'taskId',t."taskId",'cardId',t."cardId",
          'startTime',t."startTime",'endTime',t."endTime",'durationSeconds',t."durationSeconds",
          'durationMinutes',t."durationMinutes",'source',t.source,'isVoided',t."isVoided") AS original
      FROM time_entries t WHERE t.id=${before.id}`);
    const state = timing.rows[0];
    if (state?.validStart !== true || state.validEnd !== true) throw new TimerConflict(400, 'Actual end time must be at or after the recorded start and not in the future');
    if (before.endTime !== null) {
      const events = await tx.select().from(timeEntryEvents).where(and(eq(timeEntryEvents.timeEntryId, before.id), eq(timeEntryEvents.eventType, 'legacy_timer_closed')));
      const exact = events.some(event => {
        try {
          const original = JSON.parse(event.beforeJson ?? 'null');
          const after = JSON.parse(event.afterJson ?? 'null');
          const metadata = JSON.parse(event.metadataJson ?? 'null');
          return event.reason === proposed.reason && original?.trackedUserId === null
            && original?.trackedProfileId === input.expectedTrackedProfileId && original?.legacyVaId === input.expectedLegacyVaId
            && after?.endTime === proposed.endTime && after?.trackedUserId === input.trackedUserId && after?.trackedProfileId === input.trackedProfileId
            && metadata?.actorUserId === input.actorUserId && metadata?.expectedFounderId === input.expectedFounderId
            && metadata?.evidenceReference === proposed.evidenceReference;
        } catch { return false; }
      });
      if (!exact || state.sameEnd !== true || before.trackedUserId !== input.trackedUserId || before.trackedProfileId !== input.trackedProfileId) {
        throw new TimerConflict(409, 'Existing closure does not match this attestation; no historical fields were changed');
      }
      return { executed: false, alreadyClosed: true, entryId: before.id };
    }
    if (before.trackedUserId !== null || before.trackedProfileId !== input.expectedTrackedProfileId) {
      throw new TimerConflict(409, 'Only the explicitly reviewed unresolved open row can be recovered');
    }
    // Offline corrections must not alter the meaning of an already settled/locked period.
    // SHARE conflicts with settlement INSERT/UPDATE, including new overlapping periods.
    await tx.execute(sql`LOCK TABLE public.payment_cycles, public.time_day_reviews, public.weekly_pay_log IN SHARE MODE`);
    const settlement = await tx.execute<{ settled: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM payment_cycles c WHERE c."founderId"=${before.founderId} AND c."isPaid" AND (
        (c."cycleStart" <= ${proposed.endTime}::timestamptz AT TIME ZONE 'UTC'
          AND c."cycleEnd" + INTERVAL '1 day' > (SELECT "startTime" FROM time_entries WHERE id=${before.id}))
        OR EXISTS (SELECT 1 FROM weekly_pay_log w WHERE w."paymentCycleId"=c.id
          AND w."founderId"=${before.founderId} AND w."vaId"=${input.trackedUserId}
          AND w."weekStart" <= ${proposed.endTime}::timestamptz AT TIME ZONE 'UTC'
          AND w."weekEnd" + INTERVAL '1 day' > (SELECT "startTime" FROM time_entries WHERE id=${before.id}))))
      OR EXISTS (SELECT 1 FROM time_day_reviews r WHERE (r.status='locked' OR r."lockedAt" IS NOT NULL)
        AND r."dateKey" >= (SELECT "startTime"::date::text FROM time_entries WHERE id=${before.id})
        AND r."dateKey" <= (${proposed.endTime}::timestamptz AT TIME ZONE 'UTC')::date::text) AS settled`);
    if (settlement.rows[0]?.settled !== false) throw new TimerConflict(409, 'A settled payment or locked review period requires separate financial reconciliation; no timer history was changed');
    const after = { trackedUserId: input.trackedUserId, trackedProfileId: input.trackedProfileId, endTime: proposed.endTime };
    if (!input.execute) return { executed: false, entryId: before.id, proposed: after };
    const transaction = await tx.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
    const metadataJson = JSON.stringify({ actorUserId: input.actorUserId, expectedFounderId: input.expectedFounderId,
      evidenceReference: proposed.evidenceReference, evidenceKind: 'operator_attestation', transactionId: transaction.rows[0].id });
    await tx.insert(timeEntryEvents).values({ timeEntryId: before.id, eventType: 'identity_resolution', reason: proposed.reason,
      beforeJson: JSON.stringify(state.original), afterJson: JSON.stringify(after), metadataJson });
    await tx.insert(timeEntryEvents).values({ timeEntryId: before.id, eventType: 'legacy_timer_closed', reason: proposed.reason,
      beforeJson: JSON.stringify(state.original), afterJson: JSON.stringify({ ...state.original, ...after }), metadataJson });
    const changed = await tx.update(timeEntries).set({ trackedUserId: input.trackedUserId, trackedProfileId: input.trackedProfileId,
      endTime: sql`${proposed.endTime}::timestamptz AT TIME ZONE 'UTC'`, updatedAt: sql`${timeEntries.updatedAt}` })
      .where(and(eq(timeEntries.id, before.id), isNull(timeEntries.trackedUserId), isNull(timeEntries.endTime))).returning({ id: timeEntries.id });
    if (changed.length !== 1) throw new TimerConflict(409, 'Entry changed while the closure was reviewed');
    return { executed: true, entryId: before.id, closed: true };
  });
}
