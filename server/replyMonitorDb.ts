/**
 * DB helper functions for the Reply Monitor feature.
 * Covers: reply_threads, vague_reply_flags, unsigned_message_flags
 */

import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { replyThreads, unsignedMessageFlags, vagueReplyFlags } from "../drizzle/schema.postgres";
import { getDb, incrementPayLogD1 } from "./db";

/** Get today's date in EAT (UTC+3) as YYYY-MM-DD */
function todayEAT(): string {
  return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export type ReplySource = "trello" | "upwork";

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
  status: string;
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
  if (!db) return;
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
  }
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
      .limit(Math.min(500, Math.max(1, Math.trunc(limit)))) as ReplyThreadRow[];
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

export async function resolveVagueReplyFlag(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.update(vagueReplyFlags).set({ resolvedAt: new Date(), resolvedBy: "manual", updatedAt: new Date() })
      .where(eq(vagueReplyFlags.id, id));
  } catch (e) {
    console.error("[DB] resolveVagueReplyFlag failed:", e);
  }
}

export async function autoDemeritVagueReplyFlag(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    const now = new Date();
    await db.update(vagueReplyFlags).set({
      resolvedAt: now, resolvedBy: "auto_demerit", demeritIssued: true,
      demeritIssuedAt: now, updatedAt: now,
    }).where(eq(vagueReplyFlags.id, id));
  } catch (e) {
    console.error("[DB] autoDemeritVagueReplyFlag failed:", e);
  }
}

export async function getAllVagueReplyFlags(vaId: number, limit = 50): Promise<VagueFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(vagueReplyFlags).where(eq(vagueReplyFlags.vaId, vaId))
      .orderBy(desc(vagueReplyFlags.flaggedAt))
      .limit(Math.min(500, Math.max(1, Math.trunc(limit)))) as VagueFlagRow[];
  } catch {
    return [];
  }
}

/**
 * Auto-demerit any vague reply flags that have been unresolved for >1 hour.
 */
export async function autoDemeriteExpiredVagueFlags(vaId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  try {
    const expired = await db.select({ id: vagueReplyFlags.id }).from(vagueReplyFlags).where(and(
      isNull(vagueReplyFlags.resolvedAt), eq(vagueReplyFlags.demeritIssued, false),
      lte(vagueReplyFlags.flaggedAt, oneHourAgo), eq(vagueReplyFlags.vaId, vaId),
    ));
    for (const row of expired) {
      await autoDemeritVagueReplyFlag(row.id);
      await incrementPayLogD1(vaId, todayEAT(), 1).catch(() => {});
    }
    return expired.length;
  } catch (e) {
    console.error("[DB] autoDemeriteExpiredVagueFlags failed:", e);
    return 0;
  }
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

export async function resolveUnsignedFlag(id: number, note?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.update(unsignedMessageFlags).set({
      resolvedAt: new Date(), resolvedBy: "manual", resolutionNote: note ?? null, updatedAt: new Date(),
    }).where(eq(unsignedMessageFlags.id, id));
  } catch (e) {
    console.error("[DB] resolveUnsignedFlag failed:", e);
  }
}

export async function autoDemeritUnsignedFlag(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    const now = new Date();
    await db.update(unsignedMessageFlags).set({
      resolvedAt: now, resolvedBy: "auto_demerit", demeritIssued: true,
      demeritIssuedAt: now, updatedAt: now,
    }).where(eq(unsignedMessageFlags.id, id));
  } catch (e) {
    console.error("[DB] autoDemeritUnsignedFlag failed:", e);
  }
}

export async function getAllUnsignedFlags(vaId: number, limit = 50): Promise<UnsignedFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(unsignedMessageFlags).where(eq(unsignedMessageFlags.vaId, vaId))
      .orderBy(desc(unsignedMessageFlags.flaggedAt))
      .limit(Math.min(500, Math.max(1, Math.trunc(limit)))) as UnsignedFlagRow[];
  } catch {
    return [];
  }
}

/**
 * Auto-demerit any unsigned message flags that have been unresolved for >1 hour.
 */
export async function autoDemeriteExpiredUnsignedFlags(vaId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  try {
    const expired = await db.select({ id: unsignedMessageFlags.id }).from(unsignedMessageFlags).where(and(
      isNull(unsignedMessageFlags.resolvedAt), eq(unsignedMessageFlags.demeritIssued, false),
      lte(unsignedMessageFlags.flaggedAt, oneHourAgo), eq(unsignedMessageFlags.vaId, vaId),
    ));
    for (const row of expired) {
      await autoDemeritUnsignedFlag(row.id);
      await incrementPayLogD1(vaId, todayEAT(), 1).catch(() => {});
    }
    return expired.length;
  } catch (e) {
    console.error("[DB] autoDemeriteExpiredUnsignedFlags failed:", e);
    return 0;
  }
}
