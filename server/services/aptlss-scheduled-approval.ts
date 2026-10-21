import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { scheduledJobs, users } from '../../drizzle/schema.postgres';
import { isSessionEpoch } from '../_core/sessionIdentity';
import { getDb } from '../db';
import {
  type ScheduledJobContext,
  type ScheduledJobDatabase,
  type ScheduledJobOwnershipReader,
} from '../scheduledJobRuntime';
import type { AptlssGenerationSettings } from './aptlss-generation';

export type ScheduledGenerationApprovalSnapshot = {
  id: string;
  createdBy: string;
  cardIds: string;
  settings: string;
  scheduledTime: Date;
  approvedByUserId?: number | null;
  approvedSessionEpoch?: string | null;
  approvedAt?: Date | null;
  approvalHash?: string | null;
};
export type ScheduledGenerationApprovalReason =
  | 'approval_required'
  | 'approval_invalid'
  | 'approval_changed'
  | 'creator_missing'
  | 'creator_not_admin'
  | 'creator_identity_changed'
  | 'creator_epoch_changed';
export class ScheduledGenerationApprovalError extends Error {
  constructor(public readonly reason: ScheduledGenerationApprovalReason) {
    super(`Scheduled generation requires explicit approval: ${reason}`);
    this.name = 'ScheduledGenerationApprovalError';
  }
}
function fail(reason: ScheduledGenerationApprovalReason): never {
  throw new ScheduledGenerationApprovalError(reason);
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}
function approvalPayload(row: ScheduledGenerationApprovalSnapshot) {
  if (row.approvedByUserId == null || row.approvedSessionEpoch == null || row.approvedAt == null)
    fail('approval_required');
  if (
    !Number.isSafeInteger(row.approvedByUserId) ||
    row.approvedByUserId <= 0 ||
    !isSessionEpoch(row.approvedSessionEpoch) ||
    !(row.approvedAt instanceof Date) ||
    !Number.isFinite(row.approvedAt.getTime()) ||
    !(row.scheduledTime instanceof Date) ||
    !Number.isFinite(row.scheduledTime.getTime()) ||
    typeof row.id !== 'string' ||
    !row.id.trim() ||
    row.id.length > 64 ||
    typeof row.createdBy !== 'string' ||
    !row.createdBy.trim() ||
    row.createdBy.length > 64
  )
    fail('approval_invalid');
  let cards: unknown, settings: unknown;
  try {
    cards = JSON.parse(row.cardIds);
    settings = JSON.parse(row.settings);
  } catch {
    fail('approval_invalid');
  }
  if (
    !Array.isArray(cards) ||
    cards.length < 1 ||
    cards.length > 250 ||
    cards.some(
      (card) =>
        typeof card !== 'string' ||
        !card ||
        card !== card.trim() ||
        card.length > 64 ||
        !/^[a-zA-Z0-9_-]+$/.test(card),
    ) ||
    new Set(cards).size !== cards.length ||
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings)
  )
    fail('approval_invalid');
  const cardIds = (cards as string[]).slice().sort();
  return {
    version: 1,
    id: row.id,
    createdBy: row.createdBy,
    cardIds,
    settings,
    scheduledTime: row.scheduledTime.toISOString(),
    approvedByUserId: row.approvedByUserId,
    approvedSessionEpoch: row.approvedSessionEpoch,
    approvedAt: row.approvedAt.toISOString(),
  };
}

/** The hash is an integrity binding, never a substitute for persisted actor authority. */
export function approvalSnapshotHash(row: ScheduledGenerationApprovalSnapshot): string {
  return createHash('sha256')
    .update(canonicalJson(approvalPayload(row)))
    .digest('hex');
}
export function parseScheduledGenerationApproval(row: ScheduledGenerationApprovalSnapshot) {
  const payload = approvalPayload(row);
  if (!row.approvalHash) fail('approval_required');
  if (!/^[a-f0-9]{64}$/.test(row.approvalHash)) fail('approval_invalid');
  if (row.approvalHash !== approvalSnapshotHash(row)) fail('approval_changed');
  return {
    ...payload,
    settings: payload.settings as AptlssGenerationSettings & { maxRetries?: number },
    approvalHash: row.approvalHash,
  };
}

/** Supplied readers are nonlocking checkpoints, including provider-spanning card transactions. */
export async function assertScheduledGenerationApproval(
  row: ScheduledGenerationApprovalSnapshot,
  reader?: ScheduledJobOwnershipReader,
) {
  const approved = parseScheduledGenerationApproval(row);
  const db = reader ?? (await getDb());
  if (!db) throw new Error('Scheduled generation approval storage unavailable');
  const [actor] = await db
    .select({ id: users.id, openId: users.openId, role: users.role, sessionEpoch: users.sessionEpoch })
    .from(users)
    .where(eq(users.id, approved.approvedByUserId))
    .limit(1);
  if (!actor) fail('creator_missing');
  if (actor.openId !== approved.createdBy) fail('creator_identity_changed');
  if (actor.role !== 'admin') fail('creator_not_admin');
  if (actor.sessionEpoch !== approved.approvedSessionEpoch) fail('creator_epoch_changed');
  return approved;
}

export type ScheduledApprovalWriter = Pick<ScheduledJobDatabase, 'select' | 'insert' | 'update'>;
export function createScheduledGenerationApprovalContext(
  snapshot: ScheduledGenerationApprovalSnapshot,
  lease: ScheduledJobContext,
  db: ScheduledJobDatabase,
) {
  let failure: ScheduledGenerationApprovalError | undefined;
  const capture = (error: unknown): never => {
    if (error instanceof ScheduledGenerationApprovalError) failure ??= error;
    throw error;
  };
  const assertApproval = async (reader?: ScheduledJobOwnershipReader, afterWrite = false) => {
    try {
      await lease.assertOwnership(reader);
      if (failure) throw failure;
      // Validate the frozen approval before loading any newly approved replacement.
      parseScheduledGenerationApproval(snapshot);
      const currentReader = reader ?? db;
      const [current] = await currentReader
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, snapshot.id))
        .limit(1);
      if (
        !current ||
        (!afterWrite && !['pending', 'running'].includes(current.status)) ||
        current.approvalHash !== snapshot.approvalHash
      )
        fail('approval_changed');
      await assertScheduledGenerationApproval(current, currentReader);
      await lease.assertOwnership(reader);
    } catch (error) {
      capture(error);
    }
  };
  const context: ScheduledJobContext = {
    signal: lease.signal,
    assertOwnership: (reader) => assertApproval(reader),
  };
  const write = async (action: (writer: ScheduledApprovalWriter) => Promise<void>) => {
    try {
      const approved = parseScheduledGenerationApproval(snapshot);
      await db.transaction(async (tx) => {
        await lease.assertOwnership(tx);
        // These locks cover only database persistence, never model or Trello awaits.
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, approved.approvedByUserId))
          .limit(1)
          .for('share');
        await tx
          .select({ id: scheduledJobs.id })
          .from(scheduledJobs)
          .where(eq(scheduledJobs.id, snapshot.id))
          .limit(1)
          .for('share');
        await context.assertOwnership(tx);
        await action(tx);
        // The action may finalize the job; its frozen proof and actor must still be valid.
        // Provider checkpoints keep the stricter pending/running requirement above.
        await assertApproval(tx, true);
      });
    } catch (error) {
      capture(error);
    }
  };
  return {
    context,
    write,
    get failure() {
      return failure;
    },
  };
}

/** Only the still-owned execution lease may hold the exact approval it observed. */
export async function holdScheduledGenerationForApproval(
  snapshot: ScheduledGenerationApprovalSnapshot,
  reason: ScheduledGenerationApprovalError,
  lease: ScheduledJobContext,
  db: ScheduledJobDatabase,
) {
  return db.transaction(async (tx) => {
    await lease.assertOwnership(tx);
    const [current] = await tx
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, snapshot.id))
      .limit(1)
      .for('update');
    const stamp = (date: Date | null | undefined) => date?.getTime() ?? null;
    if (
      !current ||
      !['pending', 'running'].includes(current.status) ||
      current.createdBy !== snapshot.createdBy ||
      current.cardIds !== snapshot.cardIds ||
      current.settings !== snapshot.settings ||
      stamp(current.scheduledTime) !== stamp(snapshot.scheduledTime) ||
      (current.approvalHash ?? null) !== (snapshot.approvalHash ?? null) ||
      (current.approvedByUserId ?? null) !== (snapshot.approvedByUserId ?? null) ||
      (current.approvedSessionEpoch ?? null) !== (snapshot.approvedSessionEpoch ?? null) ||
      stamp(current.approvedAt) !== stamp(snapshot.approvedAt)
    )
      return false;
    await lease.assertOwnership(tx);
    await tx
      .update(scheduledJobs)
      .set({ status: 'awaiting_approval', error: reason.message, completedAt: null })
      .where(eq(scheduledJobs.id, snapshot.id));
    return true;
  });
}
