import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { financialLedgerEvents, paymentCycles, weeklyPayLog, timeDayReviews, users, vaProfiles, type User } from '../drizzle/schema.postgres';
import type { getDb } from './db';
import { parseDateKey } from './utils/date-only';
import { weeklyPayRevision } from '../shared/financialRevision';
import { assertFinancialFeaturesEnabled } from './financialAvailability';

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Cycle = typeof paymentCycles.$inferSelect;
type WeeklyLog = typeof weeklyPayLog.$inferSelect;
export type FinancialActor = Pick<User, 'id' | 'role'>;
export type WeeklyLogResult = { log: WeeklyLog; outcome: 'created' | 'changed' | 'unchanged' };
export class FinancialError extends Error {
  constructor(public status: number, message: string, public code = 'FINANCIAL_CONFLICT') { super(message); this.name = 'FinancialError'; }
}
export function financialFailure(error: unknown): { status: number; error: string; code: string } | null {
  if (error instanceof FinancialError) return { status: error.status, error: error.message, code: error.code };
  const value = error as { code?: string; cause?: { code?: string } } | null;
  if ((value?.cause?.code ?? value?.code) === '23505') return { status: 409, error: 'Financial identity conflict; reload before trying again', code: 'FINANCIAL_CONFLICT' };
  return null;
}
export const PAY_COUNT_WEIGHTS_CENTS = {
  meritM1: 500, meritM2: 750, meritM3: 100, meritStreak: 1000,
  demeritD1: 500, demeritD2: 1000, demeritD3: 500, demeritD4: 500,
  demeritD5: 1000, demeritD6: 500, demeritD7: 500, demeritD8: 1000,
  demeritD9: 1500, demeritD10: 1500, demeritD11: 1500,
} as const;
export type PayCountKey = keyof typeof PAY_COUNT_WEIGHTS_CENTS;
export type WeeklyPayInput = Partial<Record<PayCountKey, number>> & {
  vaId?: number; weekStart: string; weekEnd: string; paymentCycleId?: number | null; notes?: string | null;
  expectedRevision?: string | null;
};
const countKeys = Object.keys(PAY_COUNT_WEIGHTS_CENTS) as PayCountKey[];
const MONEY_MAX_CENTS = 99_999_999;
function fail(status: number, message: string): never { throw new FinancialError(status, message); }
function positiveId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(400, 'A positive account or record ID is required');
}
function date(value: string) {
  try { return parseDateKey(value); } catch { return fail(400, 'A valid YYYY-MM-DD calendar date is required'); }
}
const key = (value: Date) => value.toISOString().slice(0, 10);
function addDays(value: Date, days: number) { const result = new Date(value); result.setUTCDate(result.getUTCDate() + days); return result; }
const overlaps = (start: Date, end: Date, otherStart: Date, otherEnd: Date) => start <= otherEnd && end >= otherStart;
function uniqueRows<T>(rows: T[], identity: (row: T) => string) {
  const seen = new Set<string>();
  for (const row of rows) { const id = identity(row); if (seen.has(id)) fail(409, 'Ambiguous financial records require explicit owner review'); seen.add(id); }
}
function admin(actor: FinancialActor) { if (actor.role !== 'admin') fail(403, 'Administrator access required'); }
function profileFor(rows: Array<typeof vaProfiles.$inferSelect>) {
  const active = rows.filter(row => row.status === 'active');
  if (active.length !== 1) fail(409, 'Worker must have exactly one active profile');
  return active[0];
}

// Account -> profile -> founder financial fence -> cycle -> weekly row. Every
// financial writer, including the automated increment, uses this same order.
async function lockScope(tx: Transaction, actor: FinancialActor, workerUserId?: number) {
  positiveId(actor.id);
  if (actor.role !== 'admin' && actor.role !== 'worker') fail(403, 'Financial access denied');
  if (workerUserId !== undefined) positiveId(workerUserId);
  if (actor.role === 'worker' && workerUserId !== actor.id) fail(403, 'Worker access denied');
  const observed = workerUserId === undefined ? null
    : profileFor(await tx.select().from(vaProfiles).where(eq(vaProfiles.userId, workerUserId)));
  const founderId = actor.role === 'admin' ? actor.id : observed!.founderId;
  const accounts = new Map<number, User>();
  for (const id of [...new Set([actor.id, founderId, ...(workerUserId === undefined ? [] : [workerUserId])])].sort((a, b) => a - b)) {
    positiveId(id);
    const [account] = await tx.select().from(users).where(eq(users.id, id)).for('no key update');
    if (account) accounts.set(id, account);
  }
  const freshActor = accounts.get(actor.id);
  if (!freshActor || freshActor.role !== actor.role) fail(403, 'Account permissions changed; reload before trying again');
  if (accounts.get(founderId)?.role !== 'admin') fail(403, 'Financial founder is unavailable');
  if (observed) {
    const profiles = await tx.select().from(vaProfiles).where(eq(vaProfiles.userId, workerUserId!))
      .orderBy(vaProfiles.id).for('update');
    const fresh = profileFor(profiles);
    if (fresh.id !== observed.id || fresh.founderId !== founderId || fresh.userId !== workerUserId
      || accounts.get(workerUserId!)?.role !== 'worker') fail(403, 'Worker does not belong to this founder');
  }
  const fence = JSON.stringify(['financial_ledger', founderId]);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${fence}, 0))`);
  // A row-only review check would not fence insertion of a newly locked date.
  await tx.execute(sql`LOCK TABLE public.time_day_reviews IN SHARE MODE`);
  const cycles = await tx.select().from(paymentCycles).where(eq(paymentCycles.founderId, founderId)).orderBy(paymentCycles.id).for('update');
  uniqueRows(cycles, row => `${key(row.cycleStart)}:${key(row.cycleEnd)}`);
  const logs = await tx.select().from(weeklyPayLog).where(eq(weeklyPayLog.founderId, founderId)).orderBy(weeklyPayLog.id).for('update');
  uniqueRows(logs, row => `${row.vaId}:${key(row.weekStart)}`);
  return { founderId, actor: freshActor, cycles, logs };
}
type Scope = Awaited<ReturnType<typeof lockScope>>;
async function requireUnlockedDays(tx: Transaction, start: Date, end: Date) {
  const reviews = await tx.select().from(timeDayReviews);
  if (reviews.some(row => (row.status === 'locked' || row.lockedAt != null)
    && row.dateKey >= key(start) && row.dateKey <= key(end))) fail(409, 'Locked review period requires separate financial reconciliation');
}
async function requireEditable(tx: Transaction, scope: Scope, start: Date, end: Date, before?: WeeklyLog) {
  const periods = [{ start, end }, ...(before ? [{ start: before.weekStart, end: before.weekEnd }] : [])];
  if (scope.cycles.some(cycle => cycle.isPaid && (cycle.id === before?.paymentCycleId
    || periods.some(period => overlaps(period.start, period.end, cycle.cycleStart, cycle.cycleEnd))))) {
    fail(409, 'Settled payment period requires separate financial reconciliation');
  }
  // A dangling/foreign historic link cannot silently be detached or retagged.
  if (before?.paymentCycleId && !scope.cycles.some(cycle => cycle.id === before.paymentCycleId)) fail(409, 'Ledger cycle ownership requires explicit review');
  for (const period of periods) await requireUnlockedDays(tx, period.start, period.end);
}
async function audit(tx: Transaction, scope: Scope, kind: 'cycle_settled' | 'weekly_saved' | 'd1_incremented',
  before: Record<string, unknown> | null, after: Record<string, unknown>, ids: { cycleId?: number; weeklyLogId?: number; eventKey?: string; requestHash?: string } = {}) {
  await tx.insert(financialLedgerEvents).values({ founderId: scope.founderId, actorUserId: scope.actor.id,
    kind, beforeJson: before, afterJson: after, ...ids });
}
function countsAndEstimate(input: Partial<Record<PayCountKey, number>>) {
  const counts = {} as Record<PayCountKey, string>;
  let merits = 0, demerits = 0;
  for (const field of countKeys) {
    const count = input[field] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count > 999_999) fail(400, 'Pay counters must be bounded nonnegative integers');
    counts[field] = count.toFixed(2);
    const cents = count * PAY_COUNT_WEIGHTS_CENTS[field];
    if (field.startsWith('merit')) merits += cents; else demerits += cents;
  }
  const projected = 9000 + merits - demerits;
  if ([merits, demerits, projected].some(value => !Number.isSafeInteger(value) || Math.abs(value) > MONEY_MAX_CENTS)) fail(400, 'Pay estimate exceeds supported numeric precision');
  return { ...counts, baseAmount: '90.00', totalMerits: (merits / 100).toFixed(2),
    totalDemerits: (demerits / 100).toFixed(2), projectedPay: (projected / 100).toFixed(2) };
}

export async function settlePaymentCycle(db: Database, actor: FinancialActor, input: { cycleId: number }) {
  assertFinancialFeaturesEnabled();
  admin(actor); positiveId(input.cycleId);
  return db.transaction(async tx => {
    const scope = await lockScope(tx, actor);
    const before = scope.cycles.find(row => row.id === input.cycleId);
    if (!before) fail(404, 'Payment cycle not found');
    const successors = scope.cycles.filter(row => row.predecessorCycleId === before.id);
    if (successors.length > 1) fail(409, 'Ambiguous cycle successor requires review');
    if (before.isPaid) {
      if (successors.length !== 1) fail(409, 'Historic settlement has no verified successor; owner review required');
      return { cycle: before, successor: successors[0], outcome: 'already_settled' as const };
    }
    if (successors.length || scope.cycles.some(row => row.id !== before.id && overlaps(before.cycleStart, before.cycleEnd, row.cycleStart, row.cycleEnd))) {
      fail(409, 'Overlapping or pre-existing cycle requires owner review');
    }
    await requireUnlockedDays(tx, before.cycleStart, before.cycleEnd);
    const cycleStart = addDays(before.cycleEnd, 1);
    const cycleEnd = addDays(cycleStart, 13);
    while (cycleEnd.getUTCDay() !== 5) cycleEnd.setUTCDate(cycleEnd.getUTCDate() + 1);
    if (scope.cycles.some(row => overlaps(cycleStart, cycleEnd, row.cycleStart, row.cycleEnd))) fail(409, 'Successor period already exists; owner review required');
    const [cycle] = await tx.update(paymentCycles).set({ isPaid: true, paidAt: new Date(), paidBy: scope.actor.openId })
      .where(and(eq(paymentCycles.id, before.id), eq(paymentCycles.founderId, scope.founderId), eq(paymentCycles.isPaid, false))).returning();
    if (!cycle) fail(409, 'Payment cycle changed');
    const [successor] = await tx.insert(paymentCycles).values({ founderId: scope.founderId, predecessorCycleId: before.id,
      cycleStart, cycleEnd, baseAmount: '90.00', isPaid: false }).returning();
    if (!successor) fail(409, 'Payment successor was not recorded');
    await audit(tx, scope, 'cycle_settled', { ...before }, { cycle, successor }, { cycleId: before.id });
    return { cycle, successor, outcome: 'settled' as const };
  });
}

async function saveInScope(tx: Transaction, scope: Scope, input: WeeklyPayInput,
  kind: 'weekly_saved' | 'd1_incremented' = 'weekly_saved', event?: { eventKey: string; requestHash: string }): Promise<WeeklyLogResult> {
  positiveId(input.vaId);
  const weekStart = date(input.weekStart), weekEnd = date(input.weekEnd);
  if (key(addDays(weekStart, 6)) !== key(weekEnd)) fail(400, 'A seven-day weekly period is required');
  if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== 'string' || input.notes.length > 10000)) fail(400, 'Invalid ledger notes');
  const before = scope.logs.find(row => row.vaId === input.vaId && key(row.weekStart) === input.weekStart);
  if (before && key(before.weekEnd) !== input.weekEnd) fail(409, 'Existing weekly period cannot be rewritten');
  if (scope.logs.some(row => row.vaId === input.vaId && row.id !== before?.id && overlaps(weekStart, weekEnd, row.weekStart, row.weekEnd))) fail(409, 'Overlapping weekly ledgers require owner review');
  const paymentCycleId = input.paymentCycleId === undefined ? before?.paymentCycleId ?? null : input.paymentCycleId;
  if (paymentCycleId !== null) {
    positiveId(paymentCycleId);
    const cycle = scope.cycles.find(row => row.id === paymentCycleId);
    if (!cycle) fail(404, 'Payment cycle not found');
    if (cycle.isPaid) fail(409, 'Settled payment period requires separate financial reconciliation');
  }
  const values = { vaId: input.vaId, founderId: scope.founderId, weekStart, weekEnd, paymentCycleId,
    ...countsAndEstimate(input), notes: input.notes === undefined ? before?.notes ?? null : input.notes };
  const same = before && Object.entries(values).every(([field, value]) => value instanceof Date
    ? key(value) === key(before[field as keyof WeeklyLog] as Date) : before[field as keyof WeeklyLog] === value);
  // Even a nominal no-op must not detach, recompute or mutate settled history.
  await requireEditable(tx, scope, weekStart, weekEnd, before);
  if (same && !event) return { log: before, outcome: 'unchanged' };
  const [log] = before ? await tx.update(weeklyPayLog).set({ ...values, updatedAt: new Date() })
    .where(and(eq(weeklyPayLog.id, before.id), eq(weeklyPayLog.founderId, scope.founderId))).returning()
    : await tx.insert(weeklyPayLog).values(values).returning();
  if (!log) fail(409, 'Weekly ledger was not recorded');
  await audit(tx, scope, kind, before ? { ...before } : null, { ...log }, { weeklyLogId: log.id, ...event });
  return { log, outcome: before ? 'changed' : 'created' };
}

export async function saveWeeklyPayLog(db: Database, actor: FinancialActor, input: WeeklyPayInput): Promise<WeeklyLogResult> {
  assertFinancialFeaturesEnabled();
  admin(actor); positiveId(input.vaId);
  if (!Object.prototype.hasOwnProperty.call(input, 'expectedRevision')
    || (input.expectedRevision !== null && typeof input.expectedRevision !== 'string')) {
    fail(400, 'A loaded weekly ledger revision is required; reload before saving');
  }
  // Validate estimates before acquiring resources; no silent coercion of counters.
  countsAndEstimate(input);
  return db.transaction(async tx => {
    const scope = await lockScope(tx, actor, input.vaId);
    const weekStart = key(date(input.weekStart));
    const existing = scope.logs.find(row => row.vaId === input.vaId && key(row.weekStart) === weekStart) ?? null;
    if (input.expectedRevision !== weeklyPayRevision(existing)) {
      fail(409, 'Weekly ledger changed since this form was loaded; reload and review before saving');
    }
    return saveInScope(tx, scope, input);
  });
}
type ReadInput = { vaId?: number; weekStart?: string; limit?: number };
export async function getWeeklyPayLogs(db: Database, actor: FinancialActor, input: ReadInput = {}): Promise<WeeklyLog[]> {
  assertFinancialFeaturesEnabled();
  const workerId = actor.role === 'worker' ? actor.id : input.vaId;
  if (actor.role === 'worker' && input.vaId !== undefined && input.vaId !== actor.id) fail(403, 'Worker access denied');
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) fail(400, 'Ledger limit must be between 1 and 100');
  if (input.weekStart !== undefined) date(input.weekStart);
  return db.transaction(async tx => {
    const scope = await lockScope(tx, actor, workerId);
    if (workerId === undefined) return [];
    return scope.logs.filter(row => row.vaId === workerId && (!input.weekStart || key(row.weekStart) === input.weekStart))
      .sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime()).slice(0, input.limit ?? 10);
  });
}
export async function getWeeklyPayLog(db: Database, actor: FinancialActor, input: ReadInput & { weekStart: string }): Promise<WeeklyLog | null> {
  return (await getWeeklyPayLogs(db, actor, { ...input, limit: 1 }))[0] ?? null;
}

export async function incrementWeeklyD1(db: Database, workerUserId: number, dateKey: string, count: number, eventKey?: string,
  beforeIncrement?: (tx: Transaction) => Promise<void>): Promise<WeeklyLogResult> {
  assertFinancialFeaturesEnabled();
  positiveId(workerUserId); const day = date(dateKey);
  if (!Number.isSafeInteger(count) || count <= 0) fail(400, 'A positive integer D1 increment is required');
  if (eventKey !== undefined && (typeof eventKey !== 'string' || eventKey.trim() !== eventKey || eventKey.length < 3 || eventKey.length > 256)) fail(400, 'Invalid financial event key');
  const weekStart = addDays(day, -(day.getUTCDay() + 6) % 7);
  const requestHash = createHash('sha256').update(JSON.stringify(['d1', workerUserId, dateKey, count])).digest('hex');
  return db.transaction(async tx => {
    const scope = await lockScope(tx, { id: workerUserId, role: 'worker' }, workerUserId);
    const before = scope.logs.find(row => row.vaId === workerUserId && key(row.weekStart) === key(weekStart));
    if (eventKey !== undefined) {
      const [existing] = await tx.select().from(financialLedgerEvents).where(and(eq(financialLedgerEvents.founderId, scope.founderId), eq(financialLedgerEvents.eventKey, eventKey)));
      if (existing) {
        if (existing.kind !== 'd1_incremented' || existing.requestHash !== requestHash || !before || existing.weeklyLogId !== before.id) fail(409, 'Financial event key conflicts with its recorded request');
        return { log: before, outcome: 'unchanged' };
      }
    }
    const counts = Object.fromEntries(countKeys.map(field => [field, before ? Number(before[field]) : 0])) as Record<PayCountKey, number>;
    counts.demeritD1 += count;
    // Source markers are committed with a new charge only, never repaired as a
    // side effect of replaying an already committed ledger event.
    await beforeIncrement?.(tx);
    return saveInScope(tx, scope, { vaId: workerUserId, weekStart: key(weekStart), weekEnd: key(addDays(weekStart, 6)), ...counts },
      'd1_incremented', eventKey === undefined ? undefined : { eventKey, requestHash });
  });
}
