/**
 * DB helper functions for the Reply Monitor feature.
 * Covers: reply_threads, vague_reply_flags, unsigned_message_flags
 */

import { and, asc, desc, eq, inArray, isNull, lte, notInArray } from "drizzle-orm";
import { replyThreads, unsignedMessageFlags, vagueReplyFlags } from "../drizzle/schema.postgres";
import { getDb, incrementPayLogD1 } from "./db";
import { assertFinancialFeaturesEnabled } from './financialAvailability';

const REPLY_FLAG_GRACE_MS = 60 * 60 * 1000;
class FlagNoLongerChargeable extends Error {}

async function chargeReplyFlag(table: typeof vagueReplyFlags | typeof unsignedMessageFlags,
  kind: 'vague' | 'unsigned', id: number, workerUserId?: number): Promise<boolean> {
  assertFinancialFeaturesEnabled();
  if (!Number.isSafeInteger(id) || id <= 0
    || (workerUserId !== undefined && (!Number.isSafeInteger(workerUserId) || workerUserId <= 0))) {
    throw new Error('A positive reply flag and worker identity is required');
  }
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [observed] = await db.select().from(table).where(and(eq(table.id, id),
    ...(workerUserId === undefined ? [] : [eq(table.vaId, workerUserId)]))).limit(1);
  if (!observed || observed.resolvedAt !== null || observed.demeritIssued) return false;
  const flaggedAt = observed.flaggedAt.getTime();
  if (!Number.isFinite(flaggedAt)) throw new Error('Reply flag timestamp is invalid');
  if (flaggedAt > Date.now() - REPLY_FLAG_GRACE_MS) return false;
  // Preserve the existing EAT accounting convention, but bind the charge date
  // to this event's expiry, not retry time (which may cross a day/week boundary).
  const dateKey = new Date(flaggedAt + REPLY_FLAG_GRACE_MS + 3 * 3600000).toISOString().slice(0, 10);
  let marked = false;
  try {
    await incrementPayLogD1(observed.vaId, dateKey, 1, `reply-monitor:${kind}:${id}`, async tx => {
      // The ledger owns account/financial locks first. This callback runs inside
      // that transaction; a ledger failure rolls back the flag marker as well.
      const [current] = await tx.select().from(table).where(eq(table.id, id)).limit(1).for('update');
      if (!current || current.resolvedAt !== null || current.demeritIssued) throw new FlagNoLongerChargeable();
      if (current.vaId !== observed.vaId || current.flaggedAt.getTime() !== flaggedAt) {
        throw new Error('Reply flag identity changed before its financial charge');
      }
      const now = new Date();
      if (current.flaggedAt.getTime() > now.getTime() - REPLY_FLAG_GRACE_MS) throw new FlagNoLongerChargeable();
      const result = await tx.update(table).set({ resolvedAt: now, resolvedBy: 'auto_demerit', demeritIssued: true,
        demeritIssuedAt: now, updatedAt: now }).where(and(eq(table.id, id), eq(table.vaId, observed.vaId),
        isNull(table.resolvedAt), eq(table.demeritIssued, false)));
      if (result.rowCount !== 1) throw new Error('Reply flag charge marker was not recorded');
      marked = true;
    });
    if (marked) return true;
    // Replays do not execute the ledger callback. A concurrent successful call
    // already marked the source; an inconsistent legacy marker needs review,
    // not an automatic repair or a second charge.
    const [replayed] = await db.select().from(table).where(eq(table.id, id)).limit(1);
    if (replayed?.vaId === observed.vaId && replayed.flaggedAt.getTime() === flaggedAt
      && replayed.demeritIssued && replayed.resolvedAt !== null && replayed.resolvedBy === 'auto_demerit') return false;
    throw new Error('Existing financial event has no matching reply flag charge marker; owner review required');
  } catch (error) {
    if (error instanceof FlagNoLongerChargeable) return false;
    throw error;
  }
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export type ReplySource = "trello" | "upwork";

export const MAX_REPLY_MONITOR_PAGE_SIZE = 200;
export function normalizeReplyMonitorLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit as number), 1), MAX_REPLY_MONITOR_PAGE_SIZE);
}

// ─── Reply Threads ────────────────────────────────────────────────────────────

export interface ReplyThreadRow {
  id: number;
  vaId: number;
  source: string;
  cardId: string;
  cardName: string;
  cardUrl: string;
  boardName: string;
  listName: string;
  lastNonWorkerMsgAt: Date | null;
  lastNonWorkerAuthor: string;
  lastNonWorkerText: string;
  lastWorkerReplyAt: Date | null;
  status: "pending" | "replied" | "overdue" | "inactive";
  demerited: boolean;
  updatedAt: Date;
}

/**
 * Upsert a reply thread row. Matches on (source, cardId, vaId).
 */
export async function upsertReplyThread(vaId: number, data: {
  source: ReplySource;
  cardId: string;
  cardName: string;
  cardUrl: string;
  boardName: string;
  listName: string;
  lastNonWorkerMsgAt: Date | null;
  lastNonWorkerAuthor: string;
  lastNonWorkerText: string;
  lastWorkerReplyAt: Date | null;
  status: "pending" | "replied" | "overdue";
  demerited: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!data.lastNonWorkerMsgAt) {
    console.warn("[DB] upsertReplyThread skipped without a received-message timestamp");
    return;
  }
  try {
    await db.insert(replyThreads).values({
      vaId,
      ...data,
      lastNonWorkerMsgAt: data.lastNonWorkerMsgAt,
      lastNonWorkerText: (data.lastNonWorkerText || "").slice(0, 2000),
    }).onConflictDoUpdate({
      target: [replyThreads.vaId, replyThreads.cardId, replyThreads.source],
      set: {
        cardName: data.cardName,
        cardUrl: data.cardUrl,
        boardName: data.boardName,
        listName: data.listName,
        lastNonWorkerMsgAt: data.lastNonWorkerMsgAt,
        lastNonWorkerAuthor: data.lastNonWorkerAuthor,
        lastNonWorkerText: (data.lastNonWorkerText || "").slice(0, 2000),
        lastWorkerReplyAt: data.lastWorkerReplyAt,
        status: data.status,
        demerited: data.demerited,
        updatedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[DB] upsertReplyThread failed:", e);
    throw e;
  }
}

export async function deactivateMissingTrelloReplyThreads(vaId: number, activeCardIds: string[]): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ids = [...new Set(activeCardIds.filter(Boolean))];
  const result = await db.update(replyThreads).set({ status: "inactive", updatedAt: new Date() })
    .where(and(eq(replyThreads.vaId, vaId), eq(replyThreads.source, "trello"),
      inArray(replyThreads.status, ["pending", "overdue"]),
      ...(ids.length ? [notInArray(replyThreads.cardId, ids)] : [])));
  return result.rowCount ?? 0;
}

// Alias for Upwork
export const upsertUpworkThread = upsertReplyThread;

export async function getPendingReplyThreads(vaId: number): Promise<ReplyThreadRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(replyThreads).where(and(
      eq(replyThreads.vaId, vaId),
      // Keep the operator queue limited to threads that still need follow-up.
      inArray(replyThreads.status, ["pending", "overdue"]),
    )).orderBy(asc(replyThreads.lastNonWorkerMsgAt)) as ReplyThreadRow[];
  } catch {
    return [];
  }
}

export async function getAllReplyThreads(vaId: number, limit = 100): Promise<ReplyThreadRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(replyThreads).where(eq(replyThreads.vaId, vaId))
      .orderBy(desc(replyThreads.lastNonWorkerMsgAt))
      .limit(normalizeReplyMonitorLimit(limit, 100)) as ReplyThreadRow[];
  } catch {
    return [];
  }
}

export async function markReplyThreadReplied(vaId: number, cardId: string, source: ReplySource): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.update(replyThreads).set({ status: "replied", updatedAt: new Date() })
      .where(and(eq(replyThreads.cardId, cardId), eq(replyThreads.source, source), eq(replyThreads.vaId, vaId)));
  } catch (e) {
    console.error("[DB] markReplyThreadReplied failed:", e);
  }
}

export async function markReplyThreadDemerited(vaId: number, cardId: string, source: ReplySource): Promise<void> {
  assertFinancialFeaturesEnabled();
  const db = await getDb();
  if (!db) return;
  try {
    await db.update(replyThreads).set({ demerited: true, updatedAt: new Date() })
      .where(and(eq(replyThreads.cardId, cardId), eq(replyThreads.source, source), eq(replyThreads.vaId, vaId)));
  } catch (e) {
    console.error("[DB] markReplyThreadDemerited failed:", e);
  }
}

// ─── Vague Reply Flags ────────────────────────────────────────────────────────

export interface VagueFlagRow {
  id: number;
  vaId: number;
  source: string;
  cardId: string;
  cardName: string;
  cardUrl: string;
  actionId: string;
  messageText: string;
  flaggedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  demeritIssued: boolean;
  demeritIssuedAt: Date | null;
}

/**
 * Insert or ignore a vague reply flag (deduped by actionId).
 */
export async function insertVagueReplyFlag(vaId: number, data: {
  source: ReplySource;
  cardId: string;
  cardName: string;
  cardUrl: string;
  actionId: string;
  messageText: string;
  flaggedAt: Date;
}): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [inserted] = await db.insert(vagueReplyFlags).values({
      vaId,
      ...data,
      messageText: data.messageText.slice(0, 2000),
    }).onConflictDoNothing({ target: vagueReplyFlags.actionId }).returning({ id: vagueReplyFlags.id });
    return inserted?.id ?? null;
  } catch (e) {
    console.error("[DB] insertVagueReplyFlag failed:", e);
    return null;
  }
}

// Alias for Upwork
export const upsertUpworkVagueFlag = insertVagueReplyFlag;

export async function getActiveVagueReplyFlags(vaId: number): Promise<VagueFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(vagueReplyFlags).where(and(
      isNull(vagueReplyFlags.resolvedAt), eq(vagueReplyFlags.vaId, vaId),
    )).orderBy(asc(vagueReplyFlags.flaggedAt)) as VagueFlagRow[];
  } catch {
    return [];
  }
}

export async function resolveVagueReplyFlag(vaId: number, id: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.update(vagueReplyFlags).set({
    resolvedAt: new Date(), resolvedBy: "manual", updatedAt: new Date(),

  }).where(and(eq(vagueReplyFlags.id, id), eq(vagueReplyFlags.vaId, vaId), isNull(vagueReplyFlags.resolvedAt)));
  if (result.rowCount === 1) return true;
  const [owned] = await db.select({ id: vagueReplyFlags.id }).from(vagueReplyFlags)
    .where(and(eq(vagueReplyFlags.id, id), eq(vagueReplyFlags.vaId, vaId))).limit(1);
  return Boolean(owned);
}

export async function autoDemeritVagueReplyFlag(id: number): Promise<void> {
  await chargeReplyFlag(vagueReplyFlags, 'vague', id);
}
export async function getAllVagueReplyFlags(vaId: number, limit = 50): Promise<VagueFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(vagueReplyFlags).where(eq(vagueReplyFlags.vaId, vaId))
      .orderBy(desc(vagueReplyFlags.flaggedAt))
      .limit(normalizeReplyMonitorLimit(limit, 50)) as VagueFlagRow[];
  } catch {
    return [];
  }
}

/**
 * Auto-demerit any vague reply flags that have been unresolved for >1 hour.
 */
export async function autoDemeriteExpiredVagueFlags(vaId: number): Promise<number> {
  assertFinancialFeaturesEnabled();
  if (!Number.isSafeInteger(vaId) || vaId <= 0) throw new Error('A positive worker identity is required');
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const oneHourAgo = new Date(Date.now() - REPLY_FLAG_GRACE_MS);
  const expired = await db.select({ id: vagueReplyFlags.id }).from(vagueReplyFlags).where(and(
    isNull(vagueReplyFlags.resolvedAt), eq(vagueReplyFlags.demeritIssued, false),
    lte(vagueReplyFlags.flaggedAt, oneHourAgo), eq(vagueReplyFlags.vaId, vaId),
  ));
  let charged = 0;
  for (const row of expired) {
    if (await chargeReplyFlag(vagueReplyFlags, 'vague', row.id, vaId)) charged++;
  }
  return charged;
}
// Alias used by upworkMonitor
export const autoDemeriteExpiredUpworkFlags = autoDemeriteExpiredVagueFlags;

// Stubs for any legacy imports
export const getUpworkPendingThreads = getPendingReplyThreads;
export const getUpworkActiveVagueFlags = getActiveVagueReplyFlags;

// ─── Unsigned Message Flags ───────────────────────────────────────────────────

export interface UnsignedFlagRow {
  id: number;
  vaId: number;
  source: string;
  cardId: string;
  cardName: string;
  cardUrl: string;
  actionId: string;
  messageText: string;
  flaggedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  demeritIssued: boolean;
  demeritIssuedAt: Date | null;
}

/**
 * Insert or ignore an unsigned message flag (deduped by actionId).
 */
export async function insertUnsignedFlag(vaId: number, data: {
  source: ReplySource;
  cardId: string;
  cardName: string;
  cardUrl: string;
  actionId: string;
  messageText: string;
  flaggedAt: Date;
}): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [inserted] = await db.insert(unsignedMessageFlags).values({
      vaId,
      ...data,
      messageText: data.messageText.slice(0, 2000),
    }).onConflictDoNothing({ target: unsignedMessageFlags.actionId }).returning({ id: unsignedMessageFlags.id });
    return inserted?.id ?? null;
  } catch (e) {
    console.error("[DB] insertUnsignedFlag failed:", e);
    return null;
  }
}

export async function getActiveUnsignedFlags(vaId: number): Promise<UnsignedFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(unsignedMessageFlags).where(and(
      isNull(unsignedMessageFlags.resolvedAt), eq(unsignedMessageFlags.vaId, vaId),
    )).orderBy(asc(unsignedMessageFlags.flaggedAt)) as UnsignedFlagRow[];
  } catch {
    return [];
  }
}

export async function resolveUnsignedFlag(vaId: number, id: number, note?: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.update(unsignedMessageFlags).set({
    resolvedAt: new Date(), resolvedBy: "manual", updatedAt: new Date(),
    resolutionNote: note ?? null,
  }).where(and(eq(unsignedMessageFlags.id, id), eq(unsignedMessageFlags.vaId, vaId), isNull(unsignedMessageFlags.resolvedAt)));
  if (result.rowCount === 1) return true;
  const [owned] = await db.select({ id: unsignedMessageFlags.id }).from(unsignedMessageFlags)
    .where(and(eq(unsignedMessageFlags.id, id), eq(unsignedMessageFlags.vaId, vaId))).limit(1);
  return Boolean(owned);
}

export async function autoDemeritUnsignedFlag(id: number): Promise<void> {
  await chargeReplyFlag(unsignedMessageFlags, 'unsigned', id);
}
export async function getAllUnsignedFlags(vaId: number, limit = 50): Promise<UnsignedFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(unsignedMessageFlags).where(eq(unsignedMessageFlags.vaId, vaId))
      .orderBy(desc(unsignedMessageFlags.flaggedAt))
      .limit(normalizeReplyMonitorLimit(limit, 50)) as UnsignedFlagRow[];
  } catch {
    return [];
  }
}

/**
 * Auto-demerit any unsigned message flags that have been unresolved for >1 hour.
 */
export async function autoDemeriteExpiredUnsignedFlags(vaId: number): Promise<number> {
  assertFinancialFeaturesEnabled();
  if (!Number.isSafeInteger(vaId) || vaId <= 0) throw new Error('A positive worker identity is required');
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const oneHourAgo = new Date(Date.now() - REPLY_FLAG_GRACE_MS);
  const expired = await db.select({ id: unsignedMessageFlags.id }).from(unsignedMessageFlags).where(and(
    isNull(unsignedMessageFlags.resolvedAt), eq(unsignedMessageFlags.demeritIssued, false),
    lte(unsignedMessageFlags.flaggedAt, oneHourAgo), eq(unsignedMessageFlags.vaId, vaId),
  ));
  let charged = 0;
  for (const row of expired) {
    if (await chargeReplyFlag(unsignedMessageFlags, 'unsigned', row.id, vaId)) charged++;
  }
  return charged;
}
