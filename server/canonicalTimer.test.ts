import { describe, expect, it, vi } from 'vitest';
import { users, vaProfiles, timeEntries, timeEntryEvents, type User } from '../drizzle/schema.postgres';
import { closeCanonicalTimer, correctCanonicalTimer, insertCanonicalTimer, requireEntryId,
  timeCompleteness, withTimerAccountTransaction } from './canonicalTimer';
import { timerTestDatabase } from './test/timerDatabase';
import { recordedSeconds } from '../shared/timerDuration';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resolveAndCloseLegacyTimer, type LegacyTimerClosureInput } from './timerIdentityReview';
import { timerReviewDatabaseUrl, runTimerIdentityReview } from '../scripts/review-timer-identity';

const actor = { id: 42, role: 'worker' } as User;
function fixture(afterInsert?: (table: unknown) => void) {
  const rows = new Map<unknown, any[]>([
    [users, [{ id: 7, role: 'admin' }, actor]],
    [vaProfiles, [{ id: 3, userId: 42, founderId: 7, status: 'active' }]],
    [timeEntries, [{ id: 1, taskId: 'card', cardId: 'card', trackedUserId: 42, trackedProfileId: 3,
      vaId: null, founderId: 7, startTime: new Date('2026-10-01T10:00:00Z'), endTime: null,
      durationSeconds: null, notes: 'private notes', isVoided: false }]],
    [timeEntryEvents, []],
  ]);
  return timerTestDatabase(rows, { afterInsert });
}

describe('canonical timer transaction behavior', () => {
  it.each([undefined, null, '1', 0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid exact entry ID %s', value => {
    expect(() => requireEntryId(value)).toThrow('Reload the active timer');
  });
  it('does not implicitly switch an existing active timer', async () => {
    const { db, inserts } = fixture();
    await expect(withTimerAccountTransaction(db, actor, tx => insertCanonicalTimer(tx, {
      taskId: 'next', vaId: null, trackedUserId: 42, trackedProfileId: 3, founderId: 7, startTime: new Date(),
    }))).rejects.toMatchObject({ status: 409 });
    expect(inserts).toEqual([]);
  });
  it('keeps stale exact STOP on entry A from closing later active entry B', async () => {
    const { db, rows } = fixture();
    const afterClose = vi.fn();
    const stopped = await closeCanonicalTimer(db, actor, 1, 'stop', { afterClose });
    rows.get(timeEntries)!.push({ ...stopped.entry, id: 2, endTime: null });
    expect(await closeCanonicalTimer(db, actor, 1, 'pause', { afterClose })).toMatchObject({ alreadyStopped: true, paused: false, entry: { id: 1 } });
    expect(rows.get(timeEntries)!.find(row => row.id === 2).endTime).toBeNull();
    expect(afterClose).toHaveBeenCalledTimes(1);
    expect(rows.get(timeEntryEvents)).toHaveLength(1);
    expect(JSON.stringify(rows.get(timeEntryEvents))).not.toContain('private notes');
  });
  it('rolls back closure if its audit insert fails', async () => {
    const { db, rows } = fixture(table => { if (table === timeEntryEvents) throw new Error('synthetic audit failure'); });
    await expect(closeCanonicalTimer(db, actor, 1, 'stop')).rejects.toThrow('synthetic audit failure');
    expect(rows.get(timeEntries)![0].endTime).toBeNull();
    expect(rows.get(timeEntryEvents)).toEqual([]);
  });
  it.each(['inactive', 'reassigned', 'promoted'])('lets the historical founder close after subject is %s', async condition => {
    const { db, rows } = fixture();
    if (condition === 'inactive') rows.get(vaProfiles)![0].status = 'inactive';
    if (condition === 'reassigned') rows.get(vaProfiles)![0].founderId = 99;
    if (condition === 'promoted') rows.get(users)![1] = { id: 42, role: 'admin' };
    expect(await closeCanonicalTimer(db, { id: 7, role: 'admin' }, 1, 'stop', { founderManaged: true }))
      .toMatchObject({ entry: { id: 1, founderId: 7 } });
    expect(rows.get(vaProfiles)![0].founderId).toBe(condition === 'reassigned' ? 99 : 7);
  });
  it('prevents a promoted worker or reassigned worker from correcting past-tenant entries', async () => {
    const { db, rows } = fixture();
    rows.get(timeEntries)![0].endTime = new Date();
    rows.get(vaProfiles)![0].founderId = 99;
    await expect(correctCanonicalTimer(db, actor, 1, { durationSeconds: 60 })).rejects.toMatchObject({ status: 404 });
    rows.get(users)![1] = { id: 42, role: 'admin' };
    await expect(closeCanonicalTimer(db, { id: 42, role: 'admin' }, 1, 'stop')).rejects.toMatchObject({ status: 409 });
  });
  it('counts unknown history without assigning legacy aliases to accounts', async () => {
    const { db, rows } = fixture();
    rows.get(timeEntries)!.push({ ...rows.get(timeEntries)![0], id: 2, vaId: 42, trackedUserId: null, endTime: new Date() });
    expect(await timeCompleteness(db, 7)).toEqual({ complete: false, unresolvedEntryCount: 1 });
    expect(await timeCompleteness(db, 99)).toEqual({ complete: true, unresolvedEntryCount: 0 });
  });
  it.each([
    { endTime: null, durationSeconds: 600, expected: 0 },
    { endTime: new Date(), isVoided: true, durationSeconds: 600, expected: 0 },
    { endTime: new Date(), durationSeconds: 61, durationMinutes: 2, expected: 61 },
    { endTime: new Date(), durationMinutes: 2, expected: 120 },
    { endTime: new Date(), durationSeconds: -5, expected: 0 },
    { startTime: '2026-10-01T09:00:00.123Z', endTime: '2026-10-01T09:37:00.000Z', expected: 2220 },
    { startTime: '2026-10-01T09:00:00.000Z', endTime: '2026-10-01T09:00:00.400Z', expected: 0 },
    { startTime: '2026-10-01T09:00:00.000Z', endTime: '2026-10-01T09:00:00.600Z', expected: 1 },
    { startTime: 'invalid', endTime: 'invalid', expected: 0 },
    { startTime: '2026-10-01T10:00:00Z', endTime: '2026-10-01T09:00:00Z', expected: 0 },
    { startTime: '2026-10-01T09:00:00Z', endTime: '2026-10-01T10:00:00Z', durationSeconds: 61, expected: 61 },
  ])('applies the shared duration policy %#', ({ expected, ...entry }) => {
    expect(recordedSeconds(entry)).toBe(expected);
  });
});

const closure = (): LegacyTimerClosureInput => ({ entryId: 1, trackedUserId: 42, trackedProfileId: 3,
  actorUserId: 7, expectedFounderId: 7, expectedLegacyVaId: 3, expectedTrackedProfileId: null,
  endTime: '2026-10-01T10:37:00Z', reason: 'Confirmed actual stop from retained operator record',
  evidenceReference: 'operator-record:stop-1', execute: true });

function legacyFixture(options: { allowed?: boolean; settled?: boolean; rejectAudit?: boolean; rejectUpdate?: boolean } = {}) {
  const fake = fixture(table => { if (options.rejectAudit && table === timeEntryEvents) throw new Error('synthetic audit failure'); });
  const row = fake.rows.get(timeEntries)![0];
  Object.assign(row, { trackedUserId: null, trackedProfileId: null, vaId: 3, source: 'legacy',
    durationMinutes: 37, durationSeconds: null, updatedAt: new Date('2026-10-01T10:01:00Z') });
  const dialect = new PgDialect();
  fake.db.execute.mockImplementation(async (statement: any) => {
    const query = dialect.sqlToQuery(statement);
    if (query.sql.includes('has_table_privilege')) return { rows: [{ allowed: options.allowed !== false }] };
    if (query.sql.includes('clock_timestamp')) {
      const current = fake.rows.get(timeEntries)![0];
      const proposed = new Date(query.params[0] as string);
      return { rows: [{ validStart: proposed >= current.startTime, validEnd: proposed.getTime() <= Date.now(),
        sameEnd: current.endTime?.getTime() === proposed.getTime(), original: {
          trackedUserId: current.trackedUserId, trackedProfileId: current.trackedProfileId,
          legacyVaId: current.vaId, founderId: current.founderId, taskId: current.taskId, cardId: current.cardId,
          startTime: current.startTime.toISOString(), endTime: current.endTime?.toISOString() ?? null,
          durationSeconds: current.durationSeconds, durationMinutes: current.durationMinutes, source: current.source, isVoided: current.isVoided,
        } }] };
    }
    if (query.sql.startsWith('LOCK TABLE')) return { rows: [] };
    if (query.sql.includes(' AS settled')) return { rows: [{ settled: options.settled === true }] };
    if (query.sql.includes('txid_current')) return { rows: [{ id: 'synthetic-transaction' }] };
    throw new Error('Unexpected recovery SQL');
  });
  const update = fake.db.update.getMockImplementation();
  fake.db.update.mockImplementation((table: unknown) => {
    const query = update(table), set = query.set;
    query.set = (values: any) => {
      if (options.rejectUpdate) throw new Error('synthetic update failure');
      return set({ ...values, endTime: new Date(dialect.sqlToQuery(values.endTime).params[0] as string),
        updatedAt: fake.rows.get(timeEntries)![0].updatedAt });
    };
    return query;
  });
  return fake;
}

describe('audited offline legacy timer closure', () => {
  it('dry-runs without changing identity, timestamps, durations or audits', async () => {
    const { db, rows } = legacyFixture(); const original = structuredClone(rows.get(timeEntries));
    expect(await resolveAndCloseLegacyTimer(db, { ...closure(), execute: false })).toMatchObject({ executed: false, proposed: { endTime: '2026-10-01T10:37:00.000Z' } });
    expect(rows.get(timeEntries)).toEqual(original); expect(rows.get(timeEntryEvents)).toEqual([]);
  });
  it('resolves and closes in one UPDATE, preserving original duration and private notes', async () => {
    const { db, rows, updates } = legacyFixture(); const original = structuredClone(rows.get(timeEntries)![0]);
    expect(await resolveAndCloseLegacyTimer(db, closure())).toEqual({ executed: true, entryId: 1, closed: true });
    expect(rows.get(timeEntries)![0]).toEqual({ ...original, trackedUserId: 42, trackedProfileId: 3, endTime: new Date('2026-10-01T10:37:00Z') });
    expect(updates).toHaveLength(1);
    expect(rows.get(timeEntryEvents)!.map(event => event.eventType)).toEqual(['identity_resolution', 'legacy_timer_closed']);
    const audit = rows.get(timeEntryEvents)![1];
    expect(JSON.parse(audit.beforeJson)).toMatchObject({ legacyVaId: 3, founderId: 7, trackedUserId: null, trackedProfileId: null, endTime: null, durationSeconds: null, durationMinutes: 37 });
    expect(JSON.parse(audit.metadataJson)).toMatchObject({ actorUserId: 7, evidenceReference: closure().evidenceReference, evidenceKind: 'operator_attestation' });
    expect(JSON.stringify(rows.get(timeEntryEvents))).not.toContain('private notes');
  });
  it('treats an exact committed retry as a no-op, not another closure or repricing', async () => {
    const { db, rows } = legacyFixture(); await resolveAndCloseLegacyTimer(db, closure());
    const original = structuredClone(rows.get(timeEntries));
    expect(await resolveAndCloseLegacyTimer(db, closure())).toEqual({ executed: false, alreadyClosed: true, entryId: 1 });
    expect(rows.get(timeEntries)).toEqual(original); expect(rows.get(timeEntryEvents)).toHaveLength(2);
  });
  it.each([{ reason: 'Different attested reason' }, { evidenceReference: 'operator-record:other' },
    { endTime: '2026-10-01T10:38:00Z' }, { trackedProfileId: null }, { expectedTrackedProfileId: 3 }])(
    'rejects a changed replay attestation %#', async change => {
      const { db, rows } = legacyFixture(); await resolveAndCloseLegacyTimer(db, closure());
      const original = structuredClone(rows.get(timeEntries));
      await expect(resolveAndCloseLegacyTimer(db, { ...closure(), ...change })).rejects.toMatchObject({ status: 409 });
      expect(rows.get(timeEntries)).toEqual(original); expect(rows.get(timeEntryEvents)).toHaveLength(2);
    });
  it.each([{ endTime: '' }, { endTime: '2026-02-31T10:37:00Z' }, { endTime: '2026-10-01T10:37:00' },
    { endTime: '2026-10-01T10:37:00.123456Z' }, { reason: 'short' }, { evidenceReference: 'https://operator.invalid/?token=secret' },
    { expectedLegacyVaId: undefined }, { expectedTrackedProfileId: undefined }, { trackedProfileId: undefined }])(
    'rejects missing/ambiguous operator proof before entering a transaction %#', async change => {
      const { db } = legacyFixture();
      await expect(resolveAndCloseLegacyTimer(db, { ...closure(), ...change } as LegacyTimerClosureInput)).rejects.toMatchObject({ status: 400 });
      expect(db.transaction).not.toHaveBeenCalled();
    });
  it.each(['2026-10-01T09:59:59Z', '9999-10-01T10:37:00Z'])('rejects out-of-range actual end %s', async endTime => {
    const { db, rows } = legacyFixture();
    await expect(resolveAndCloseLegacyTimer(db, { ...closure(), endTime })).rejects.toMatchObject({ status: 400 });
    expect(rows.get(timeEntryEvents)).toEqual([]);
  });
  it.each([{ allowed: false, status: 403 }, { settled: true, status: 409 }])('fails closed on privilege/settlement gates %#', async ({ status, ...options }) => {
    const { db, rows } = legacyFixture(options); const original = structuredClone(rows.get(timeEntries));
    await expect(resolveAndCloseLegacyTimer(db, closure())).rejects.toMatchObject({ status });
    expect(rows.get(timeEntries)).toEqual(original); expect(rows.get(timeEntryEvents)).toEqual([]);
  });
  it.each([{ expectedFounderId: 42 }, { expectedLegacyVaId: 42 }, { expectedTrackedProfileId: 3 }])('rejects mismatched provenance %#', async change => {
    const { db, rows } = legacyFixture();
    await expect(resolveAndCloseLegacyTimer(db, { ...closure(), ...change })).rejects.toMatchObject({ status: 409 });
    expect(rows.get(timeEntryEvents)).toEqual([]);
  });
  it.each([{ rejectAudit: true }, { rejectUpdate: true }])('rolls back identity, closure and both events on failure %#', async options => {
    const { db, rows } = legacyFixture(options); const original = structuredClone(rows.get(timeEntries));
    await expect(resolveAndCloseLegacyTimer(db, closure())).rejects.toThrow('synthetic');
    expect(rows.get(timeEntries)).toEqual(original); expect(rows.get(timeEntryEvents)).toEqual([]);
  });
  it('refuses a previously closed row without a matching recovery audit', async () => {
    const { db, rows } = legacyFixture(); rows.get(timeEntries)![0].endTime = new Date(closure().endTime);
    await expect(resolveAndCloseLegacyTimer(db, closure())).rejects.toMatchObject({ status: 409 });
  });
});

describe('offline timer CLI fixture boundary', () => {
  it('requires isolated loopback test targets outside explicit production mode', () => {
    expect(timerReviewDatabaseUrl({ DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:55436/recovery_test?sslmode=disable' })).toContain('/recovery_test');
    for (const url of ['postgresql://synthetic:synthetic@remote.invalid/recovery_test', 'postgresql://synthetic:synthetic@127.0.0.1/operator_data', 'mysql://synthetic:synthetic@localhost/recovery_test']) {
      expect(() => timerReviewDatabaseUrl({ DATABASE_URL: url })).toThrow();
    }
    expect(() => timerReviewDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://synthetic:synthetic@db.invalid/application?sslmode=disable' })).toThrow();
    expect(timerReviewDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://synthetic:synthetic@db.invalid/application?sslmode=verify-full' })).toContain('verify-full');
  });
  it('rejects closure flags in another mode and requires explicit nullable identities without opening a pool', async () => {
    await expect(runTimerIdentityReview(['resolve', '--end-time', closure().endTime], {})).rejects.toThrow('Closure flags');
    await expect(runTimerIdentityReview(['resolve-close'], {})).rejects.toThrow('Explicit positive ID or null');
    await expect(runTimerIdentityReview(['report', '--execute'], {})).rejects.toThrow('Report mode');
  });
});
