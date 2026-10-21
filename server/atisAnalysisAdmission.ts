import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { atisAnalysisItems, atisAnalysisRequests, atisCards, atisCardUnderstanding, users } from '../drizzle/schema.postgres';
import type { AtisAnalysisGuidance, AtisAnalysisItemState, AtisAnalysisJob, AtisAnalysisPreview, AtisAnalysisSelection } from '../shared/atisAnalysis';
import { ATIS_ANALYSIS_MAX_CARDS, ATIS_ANALYSIS_PREVIEW_TTL_MS } from '../shared/atisAnalysis';
import { getDb } from './db';
import { AtisOperationRecoveryRequired, AtisOperationRequestConflict, getActiveAtisOperations, getAtisAnalysisOperation, startAtisOperation } from './atisOperations';
import { ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobOwnershipReader } from './scheduledJobRuntime';
import { processCardUnderstandingOutcome } from './services/atis-understanding';

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Request = typeof atisAnalysisRequests.$inferSelect;
type Status = 400 | 403 | 404 | 409 | 503;
const messages = {
  INVALID_SELECTION: 'Invalid or ambiguous analysis selection.',
  FORBIDDEN: 'An active administrator account is required.',
  NOT_FOUND: 'Analysis request not found.',
  APPROVAL_CHANGED: 'Account authority changed; create a new analysis preview.',
  EXPIRED: 'Analysis preview expired; create a new preview.',
  EMPTY: 'The preview contains no eligible cards.',
  REQUEST_CONFLICT: 'Analysis confirmation conflicts with an existing request.',
  RECOVERY_REQUIRED: 'Review and acknowledge the interrupted analysis operation before starting a replacement.',
  UNAVAILABLE: 'Analysis admission is unavailable; read its status before retrying.',
} as const;
export class AtisAnalysisAdmissionError extends Error {
  constructor(public readonly status: Status, public readonly code: keyof typeof messages) {
    super(messages[code]); this.name = 'AtisAnalysisAdmissionError';
  }
}
function fail(status: Status, code: keyof typeof messages): never { throw new AtisAnalysisAdmissionError(status, code); }
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
async function database(): Promise<Database> { const db = await getDb(); if (!db) fail(503, 'UNAVAILABLE'); return db; }
function sanitized(error: unknown): never {
  if (error instanceof AtisAnalysisAdmissionError) throw error;
  if (error instanceof AtisOperationRecoveryRequired) fail(409, 'RECOVERY_REQUIRED');
  if (error instanceof AtisOperationRequestConflict) fail(409, 'REQUEST_CONFLICT');
  const pg = error as { code?: string; cause?: { code?: string } };
  if ((pg?.cause?.code ?? pg?.code) === '23505') fail(409, 'REQUEST_CONFLICT');
  fail(503, 'UNAVAILABLE');
}
async function authority(reader: ScheduledJobOwnershipReader, ownerUserId: number, epoch?: string, lock = false) {
  if (!positiveId(ownerUserId)) fail(403, 'FORBIDDEN');
  const query = reader.select({ id: users.id, role: users.role, epoch: users.sessionEpoch }).from(users)
    .where(eq(users.id, ownerUserId)).limit(1);
  const [actor] = await (lock ? query.for('share') : query);
  if (!actor || actor.role !== 'admin') fail(403, 'FORBIDDEN');
  if (epoch !== undefined && actor.epoch !== epoch) fail(409, 'APPROVAL_CHANGED');
  return actor;
}

export function normalizeAtisAnalysisSelection(input: AtisAnalysisSelection): AtisAnalysisSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'INVALID_SELECTION');
  const allowed = ['mode','cardId','cardIds','boardId','forceAll','minConfidence','limit','afterCardId','guidance'];
  if (Object.keys(input).some(key => !allowed.includes(key))
    || !['pending','low_confidence','reanalyze','single','active_placeholders'].includes(input.mode)) fail(400, 'INVALID_SELECTION');
  const limit = input.limit ?? (input.mode === 'single' ? 1 : ATIS_ANALYSIS_MAX_CARDS);
  if (!positiveId(limit) || limit > ATIS_ANALYSIS_MAX_CARDS || (input.mode === 'single' && limit !== 1)) fail(400, 'INVALID_SELECTION');
  for (const id of [input.cardId,input.boardId]) if (id !== undefined && !positiveId(id)) fail(400, 'INVALID_SELECTION');
  if (input.afterCardId !== undefined && (!Number.isSafeInteger(input.afterCardId) || input.afterCardId < 0)) fail(400, 'INVALID_SELECTION');
  if (input.forceAll !== undefined && typeof input.forceAll !== 'boolean') fail(400, 'INVALID_SELECTION');
  if (input.minConfidence !== undefined && (!Number.isSafeInteger(input.minConfidence) || input.minConfidence < 0 || input.minConfidence > 100)) fail(400, 'INVALID_SELECTION');
  if (input.cardIds !== undefined && (!Array.isArray(input.cardIds) || !input.cardIds.length
    || input.cardIds.length > 1000 || input.cardIds.some(id => !positiveId(id)))) fail(400, 'INVALID_SELECTION');
  const cardIds = input.cardIds && [...new Set(input.cardIds)].sort((a,b) => a-b);
  if ((input.mode === 'single') !== (input.cardId !== undefined)
    || (input.mode === 'single' && [cardIds,input.boardId,input.afterCardId,input.minConfidence,input.forceAll].some(value => value !== undefined))
    || (cardIds !== undefined && input.boardId !== undefined)
    || (input.forceAll === true && (input.mode !== 'reanalyze' || cardIds !== undefined || input.boardId !== undefined || input.minConfidence !== undefined))
    || (input.minConfidence !== undefined && (!['reanalyze','low_confidence'].includes(input.mode) || cardIds !== undefined || input.boardId !== undefined))) fail(400, 'INVALID_SELECTION');
  let guidance: AtisAnalysisGuidance | undefined;
  if (input.guidance !== undefined) {
    const value = input.guidance;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['goal','deliverable','successCriteria'].includes(key))) fail(400, 'INVALID_SELECTION');
    for (const text of [value.goal,value.deliverable]) if (text !== undefined && (typeof text !== 'string' || text.length > 4000)) fail(400, 'INVALID_SELECTION');
    if (value.successCriteria !== undefined && (!Array.isArray(value.successCriteria) || value.successCriteria.length > 20
      || value.successCriteria.some(text => typeof text !== 'string' || text.length > 500))) fail(400, 'INVALID_SELECTION');
    guidance = { ...(value.goal === undefined ? {} : { goal: value.goal.trim() }),
      ...(value.deliverable === undefined ? {} : { deliverable: value.deliverable.trim() }),
      ...(value.successCriteria === undefined ? {} : { successCriteria: value.successCriteria.map(text => text.trim()) }) };
  }
  return { mode: input.mode,limit,
    ...(input.cardId === undefined ? {} : { cardId: input.cardId }), ...(cardIds ? { cardIds } : {}),
    ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
    ...(input.forceAll === undefined ? {} : { forceAll: input.forceAll }),
    ...(input.minConfidence === undefined ? {} : { minConfidence: input.minConfidence }),
    ...(input.afterCardId === undefined ? {} : { afterCardId: input.afterCardId }), ...(guidance ? { guidance } : {}) };
}

function activeCard(): SQL {
  return sql`${atisCards.isArchived} = 0 AND LOWER(${atisCards.listName}) NOT LIKE ALL
    (ARRAY['%done%','%completed%','%complete%','%archive%','%archived%','%info%'])`;
}
export function atisAnalysisSelectionPredicate(selection: AtisAnalysisSelection) {
  const filters = [activeCard()];
  if (selection.afterCardId !== undefined) filters.push(gt(atisCards.id,selection.afterCardId));
  if (selection.cardId !== undefined) filters.push(eq(atisCards.id,selection.cardId));
  if (selection.cardIds) filters.push(inArray(atisCards.id,selection.cardIds));
  if (selection.boardId !== undefined) filters.push(eq(atisCards.boardId,selection.boardId));
  if (selection.mode === 'pending') filters.push(or(isNull(atisCardUnderstanding.id),lt(atisCardUnderstanding.confidenceScore,30))!);
  if (selection.mode === 'low_confidence') filters.push(lt(atisCardUnderstanding.confidenceScore,selection.minConfidence ?? 30));
  if (selection.mode === 'active_placeholders') filters.push(sql`CASE
    WHEN ${atisCardUnderstanding.aptlssChecklist} IS JSON ARRAY
    THEN json_array_length(${atisCardUnderstanding.aptlssChecklist}::json) <= 1 ELSE true END`);
  if (selection.mode === 'reanalyze' && !selection.forceAll && !selection.cardIds && selection.boardId === undefined) {
    filters.push(sql`(${atisCardUnderstanding.id} IS NULL OR ${atisCardUnderstanding.confidenceScore} <= ${selection.minConfidence ?? 0}
      OR ${atisCardUnderstanding.aptlssChecklist} IS NULL)`);
  }
  return and(...filters)!;
}

export async function createAtisAnalysisPreview(ownerUserId: number, input: AtisAnalysisSelection): Promise<AtisAnalysisPreview> {
  try {
    const selection = normalizeAtisAnalysisSelection(input), db = await database();
    const request = await db.transaction(async tx => {
      const actor = await authority(tx,ownerUserId,undefined,true);
      const predicate = atisAnalysisSelectionPredicate(selection);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::integer` }).from(atisCards)
        .leftJoin(atisCardUnderstanding,eq(atisCards.id,atisCardUnderstanding.cardId)).where(predicate);
      const cards = await tx.select({ id: atisCards.id,name: atisCards.name }).from(atisCards)
        .leftJoin(atisCardUnderstanding,eq(atisCards.id,atisCardUnderstanding.cardId)).where(predicate)
        .orderBy(asc(atisCards.id)).limit(selection.limit!);
      const remaining = count - cards.length;
      const [row] = await tx.insert(atisAnalysisRequests).values({ id: randomUUID(),ownerUserId,actorEpoch: actor.epoch,
        selection,cards,matched: count,remaining,nextAfterCardId: remaining > 0 ? cards.at(-1)?.id : null,
        expiresAt: sql`clock_timestamp() + (${ATIS_ANALYSIS_PREVIEW_TTL_MS}::double precision * interval '1 millisecond')` }).returning();
      return row;
    }, { isolationLevel: 'repeatable read' });
    const interrupted = (await getActiveAtisOperations()).find(operation => operation.kind === 'understanding' && operation.state === 'interrupted');
    return { id: request.id,expiresAt: request.expiresAt.toISOString(),matched: request.matched,total: request.cards.length,
      remaining: request.remaining,cards: request.cards,
      ...(request.nextAfterCardId === null ? {} : { nextAfterCardId: request.nextAfterCardId }),
      ...(interrupted ? { recoveryOperationId: interrupted.id } : {}) };
  } catch (error) { sanitized(error); }
}

async function ownedRequest(db: ScheduledJobOwnershipReader, ownerUserId: number, id: string) {
  if (!uuid(id)) return null;
  const [request] = await db.select().from(atisAnalysisRequests)
    .where(and(eq(atisAnalysisRequests.id,id),eq(atisAnalysisRequests.ownerUserId,ownerUserId))).limit(1);
  return request ?? null;
}

function actorContext(context: ScheduledJobContext, db: Database, request: Request): ScheduledJobContext {
  const revoked = new AbortController();
  return { ...context,signal: AbortSignal.any([context.signal,revoked.signal]),
    assertOwnership: async reader => {
      await context.assertOwnership(reader);
      if (revoked.signal.aborted) throw new ScheduledJobLeaseLostError();
      try { await authority(reader ?? db,request.ownerUserId,request.actorEpoch,reader !== undefined); }
      catch { revoked.abort(); throw new ScheduledJobLeaseLostError(); }
    } };
}

async function executeAnalysis(db: Database, request: Request, original: ScheduledJobContext) {
  const context = actorContext(original,db,request);
  const items = await db.select().from(atisAnalysisItems).where(eq(atisAnalysisItems.requestId,request.id)).orderBy(asc(atisAnalysisItems.cardId));
  if (items.length > ATIS_ANALYSIS_MAX_CARDS || items.length !== request.cards.length
    || items.some((item,index) => item.cardId !== request.cards[index].id)) throw new ScheduledJobLeaseLostError();
  for (const item of items) {
    await context.assertOwnership();
    if (item.state !== 'pending') throw new ScheduledJobLeaseLostError();
    const call = await db.transaction(async tx => {
      await context.assertOwnership(tx);
      const [card] = await tx.select({ id: atisCards.id }).from(atisCards).where(and(eq(atisCards.id,item.cardId),activeCard())).limit(1);
      const [changed] = await tx.update(atisAnalysisItems).set(card ? { state: 'calling',attemptedAt: sql`clock_timestamp()` }
        : { state: 'missing',completedAt: sql`clock_timestamp()` }).where(and(eq(atisAnalysisItems.id,item.id),eq(atisAnalysisItems.state,'pending'))).returning({ id: atisAnalysisItems.id });
      if (!changed) throw new ScheduledJobLeaseLostError();
      await context.assertOwnership(tx);
      return Boolean(card);
    });
    if (!call) continue;
    try {
      await context.assertOwnership();
      const { kind: state } = await processCardUnderstandingOutcome(item.cardId,{ context,guidance: request.selection.guidance });
      await db.transaction(async tx => {
        await context.assertOwnership(tx);
        const [changed] = await tx.update(atisAnalysisItems).set({ state,completedAt: sql`clock_timestamp()` })
          .where(and(eq(atisAnalysisItems.id,item.id),eq(atisAnalysisItems.state,'calling'))).returning({ id: atisAnalysisItems.id });
        if (!changed) throw new ScheduledJobLeaseLostError();
        await context.assertOwnership(tx);
      });
    } catch {
      // Once calling is committed, an unacknowledged service/write outcome is
      // uncertain. Keep its marker and require the existing interruption review.
      throw new ScheduledJobLeaseLostError();
    }
  }
  const settled = await db.select({ state: atisAnalysisItems.state }).from(atisAnalysisItems).where(eq(atisAnalysisItems.requestId,request.id));
  return { processed: settled.filter(item => item.state === 'generated' || item.state === 'fallback').length,
    failed: settled.filter(item => item.state === 'failed').length };
}

export async function confirmAtisAnalysisPreview(ownerUserId: number, previewId: string,
  input: { requestKey: string; acknowledgeInterruptedOperationId?: number }): Promise<AtisAnalysisJob> {
  try {
    if (!input || typeof input.requestKey !== 'string' || input.requestKey.trim() !== input.requestKey
      || input.requestKey.length < 1 || input.requestKey.length > 128
      || (input.acknowledgeInterruptedOperationId !== undefined && !positiveId(input.acknowledgeInterruptedOperationId))) fail(400,'INVALID_SELECTION');
    const db = await database();
    const request = await ownedRequest(db,ownerUserId,previewId);
    if (!request) fail(404,'NOT_FOUND');
    await authority(db,ownerUserId,request.actorEpoch);
    const hash = createHash('sha256').update(input.requestKey).digest('hex');
    const replay = async () => {
      const fresh = await ownedRequest(db,ownerUserId,previewId);
      if (!fresh?.confirmedAt) return null;
      if (fresh.requestKeyHash !== hash) fail(409,'REQUEST_CONFLICT');
      return getAtisAnalysisJob(ownerUserId,previewId);
    };
    const existing = await replay();
    if (existing) return existing;
    try {
      await startAtisOperation({ kind: 'understanding',ownerUserId,request: { analysisRequestId: previewId },
        acknowledgeInterruptedOperationId: input.acknowledgeInterruptedOperationId,
        admission: async (context,tx) => {
          await context.assertOwnership(tx);
          await authority(tx,ownerUserId,request.actorEpoch,true);
          const [fresh] = await tx.select()
            .from(atisAnalysisRequests).where(and(eq(atisAnalysisRequests.id,previewId),eq(atisAnalysisRequests.ownerUserId,ownerUserId))).for('update');
          if (!fresh) fail(404,'NOT_FOUND');
          if (fresh.confirmedAt) fail(409,'REQUEST_CONFLICT');
          // Evaluate the DB clock after acquiring the row lock, not in a
          // SELECT expression that could have been evaluated before a lock wait.
          const [{ expired }] = await tx.select({ expired: sql<boolean>`${atisAnalysisRequests.expiresAt} <= clock_timestamp()` })
            .from(atisAnalysisRequests).where(eq(atisAnalysisRequests.id,previewId));
          if (expired) fail(409,'EXPIRED');
          if (!fresh.cards.length) fail(409,'EMPTY');
          await tx.update(atisAnalysisRequests).set({ confirmedAt: sql`clock_timestamp()`,requestKeyHash: hash }).where(eq(atisAnalysisRequests.id,previewId));
          await tx.insert(atisAnalysisItems).values(fresh.cards.map(card => ({ requestId: previewId,cardId: card.id,cardName: card.name,state: 'pending' })));
          await context.assertOwnership(tx);
        },
      }, context => executeAnalysis(db,request,context));
    } catch (error) {
      const committed = await replay();
      if (committed) return committed;
      throw error;
    }
    const job = await replay();
    if (!job) fail(503,'UNAVAILABLE');
    return job;
  } catch (error) { sanitized(error); }
}

export async function getAtisAnalysisJob(ownerUserId: number, id: string): Promise<AtisAnalysisJob | null> {
  try {
    const db = await database(), request = await ownedRequest(db,ownerUserId,id);
    if (!request?.confirmedAt) return null;
    await authority(db,ownerUserId);
    const operation = await getAtisAnalysisOperation(ownerUserId,id);
    const rows = await db.select().from(atisAnalysisItems).where(eq(atisAnalysisItems.requestId,id)).orderBy(asc(atisAnalysisItems.cardId));
    const live = operation?.state === 'running';
    const items = rows.map(item => ({ cardId: item.cardId,cardName: item.cardName,
      state: (item.state === 'calling' && !live ? 'uncertain' : item.state) as AtisAnalysisItemState }));
    const count = (state: AtisAnalysisItemState) => items.filter(item => item.state === state).length;
    const uncertain = count('uncertain'), pending = count('pending') + count('calling');
    const membershipMatches = items.length === request.cards.length
      && items.every((item,index) => item.cardId === request.cards[index].id);
    const state = uncertain > 0 || !operation || !membershipMatches ? 'interrupted'
      : operation.state === 'completed' && pending > 0 ? 'interrupted' : operation.state;
    return { id,...(operation ? { operationId: operation.id } : {}),state,matched: request.matched,total: request.cards.length,
      remaining: request.remaining,...(request.nextAfterCardId === null ? {} : { nextAfterCardId: request.nextAfterCardId }),
      processed: count('generated') + count('fallback'),generated: count('generated'),fallback: count('fallback'),
      missing: count('missing'),failed: count('failed'),uncertain,pending,items,
      ...(state === 'failed' ? { error: 'Analysis stopped before all selected cards settled.' } : {}),
      ...(state === 'interrupted' ? { error: 'Analysis outcome is unverified; review before explicitly starting a replacement.' } : {}) };
  } catch (error) { sanitized(error); }
}
