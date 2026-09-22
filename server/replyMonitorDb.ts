/**
 * DB helper functions for the Reply Monitor feature.
 * Covers: reply_threads, vague_reply_flags, unsigned_message_flags
 */

import { getDb, incrementPayLogD1 } from "./db";
import { sql } from "drizzle-orm";

/** Get today's date in EAT (UTC+3) as YYYY-MM-DD */
function todayEAT(): string {
  return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export type ReplySource = "trello" | "upwork";

export const MAX_REPLY_MONITOR_PAGE_SIZE = 200;

export function normalizeReplyMonitorLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit as number), 1), MAX_REPLY_MONITOR_PAGE_SIZE);
}

function parameterizedSql(statement: string, values: unknown[]) {
  const fragments = statement.split("?");
  if (fragments.length !== values.length + 1) {
    throw new Error("SQL placeholder count does not match the supplied values");
  }
  const chunks = [sql.raw(fragments[0])];
  for (const [index, value] of values.entries()) {
    chunks.push(sql`${value}`, sql.raw(fragments[index + 1]));
  }
  return sql.join(chunks);
}

function executeStatement(db: any, statement: string, values: unknown[] = []) {
  return db.execute(parameterizedSql(statement, values));
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
  const toStr = (d: Date | null) =>
    d ? d.toISOString().slice(0, 19).replace("T", " ") : null;
  const lastNonWorkerText = (data.lastNonWorkerText || "").slice(0, 2000);
  try {
    await executeStatement(db,
      `INSERT INTO reply_threads
         (vaId, source, cardId, cardName, cardUrl, boardName, listName,
          lastNonWorkerMsgAt, lastNonWorkerAuthor, lastNonWorkerText,
          lastWorkerReplyAt, lastNonJoyceMsgAt, lastNonJoyceAuthor,
          lastNonJoyceText, lastJoyceReplyAt, status, demerited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         cardName = VALUES(cardName),
         cardUrl = VALUES(cardUrl),
         boardName = VALUES(boardName),
         listName = VALUES(listName),
         lastNonWorkerMsgAt = VALUES(lastNonWorkerMsgAt),
         lastNonWorkerAuthor = VALUES(lastNonWorkerAuthor),
         lastNonWorkerText = VALUES(lastNonWorkerText),
         lastWorkerReplyAt = VALUES(lastWorkerReplyAt),
         lastNonJoyceMsgAt = VALUES(lastNonJoyceMsgAt),
         lastNonJoyceAuthor = VALUES(lastNonJoyceAuthor),
         lastNonJoyceText = VALUES(lastNonJoyceText),
         lastJoyceReplyAt = VALUES(lastJoyceReplyAt),
         status = VALUES(status),
         demerited = VALUES(demerited),
         updatedAt = NOW()`,
      [
        vaId, data.source, data.cardId, data.cardName, data.cardUrl,
        data.boardName, data.listName,
        toStr(data.lastNonWorkerMsgAt), data.lastNonWorkerAuthor,
        lastNonWorkerText, toStr(data.lastWorkerReplyAt),
        toStr(data.lastNonWorkerMsgAt), data.lastNonWorkerAuthor,
        lastNonWorkerText, toStr(data.lastWorkerReplyAt),
        data.status, data.demerited ? 1 : 0,
      ]
    );
  } catch (e) {
    console.error("[DB] upsertReplyThread failed:", e);
    throw e;
  }
}

export async function deactivateMissingTrelloReplyThreads(vaId: number, activeCardIds: string[]): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ids = Array.from(new Set(activeCardIds.filter(Boolean)));
  const placeholders = ids.map(() => "?").join(", ");
  const condition = ids.length ? `AND cardId NOT IN (${placeholders})` : "";
  const result = await executeStatement(db,
    `UPDATE reply_threads
     SET status = 'inactive', updatedAt = NOW()
     WHERE vaId = ? AND source = 'trello' AND status IN ('pending', 'overdue') ${condition}`,
    [vaId, ...ids],
  );
  const data = Array.isArray(result) ? result[0] : result;
  return Number((data as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

// Alias for Upwork
export const upsertUpworkThread = upsertReplyThread;

export async function getPendingReplyThreads(vaId: number): Promise<ReplyThreadRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const rows = await executeStatement(db,
      `SELECT id, vaId, source, cardId, cardName, cardUrl, boardName, listName,
              lastNonWorkerMsgAt, lastNonWorkerAuthor, lastNonWorkerText,
              lastWorkerReplyAt, status, demerited, updatedAt
       FROM reply_threads
       WHERE status IN ('pending', 'overdue') AND vaId = ?
       ORDER BY lastNonWorkerMsgAt ASC`,
      [vaId]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    return (Array.isArray(data) ? data : []).map((r: any) => ({
      ...r,
      lastNonWorkerMsgAt: r.lastNonWorkerMsgAt ? new Date(r.lastNonWorkerMsgAt) : null,
      lastWorkerReplyAt: r.lastWorkerReplyAt ? new Date(r.lastWorkerReplyAt) : null,
      updatedAt: new Date(r.updatedAt),
      demerited: Boolean(r.demerited),
    }));
  } catch {
    return [];
  }
}

export async function getAllReplyThreads(vaId: number, limit = 100): Promise<ReplyThreadRow[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = normalizeReplyMonitorLimit(limit, 100);
  try {
    const rows = await executeStatement(db,
      `SELECT id, vaId, source, cardId, cardName, cardUrl, boardName, listName,
              lastNonWorkerMsgAt, lastNonWorkerAuthor, lastNonWorkerText,
              lastWorkerReplyAt, status, demerited, updatedAt
       FROM reply_threads
       WHERE vaId = ?
       ORDER BY lastNonWorkerMsgAt DESC
       LIMIT ?`,
      [vaId, safeLimit]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    return (Array.isArray(data) ? data : []).map((r: any) => ({
      ...r,
      lastNonWorkerMsgAt: r.lastNonWorkerMsgAt ? new Date(r.lastNonWorkerMsgAt) : null,
      lastWorkerReplyAt: r.lastWorkerReplyAt ? new Date(r.lastWorkerReplyAt) : null,
      updatedAt: new Date(r.updatedAt),
      demerited: Boolean(r.demerited),
    }));
  } catch {
    return [];
  }
}

export async function markReplyThreadReplied(vaId: number, cardId: string, source: ReplySource): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await executeStatement(db,
      `UPDATE reply_threads SET status = 'replied', updatedAt = NOW()
       WHERE cardId = ? AND source = ? AND vaId = ?`,
      [cardId, source, vaId]
    );
  } catch (e) {
    console.error("[DB] markReplyThreadReplied failed:", e);
  }
}

export async function markReplyThreadDemerited(vaId: number, cardId: string, source: ReplySource): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await executeStatement(db,
      `UPDATE reply_threads SET demerited = 1, updatedAt = NOW()
       WHERE cardId = ? AND source = ? AND vaId = ?`,
      [cardId, source, vaId]
    );
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
  const flaggedAtStr = data.flaggedAt.toISOString().slice(0, 19).replace("T", " ");
  try {
    const result = await executeStatement(db,
      `INSERT IGNORE INTO vague_reply_flags
         (vaId, source, cardId, cardName, cardUrl, actionId, messageText, flaggedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vaId, data.source, data.cardId, data.cardName, data.cardUrl,
        data.actionId, data.messageText.slice(0, 2000), flaggedAtStr,
      ]
    );
    const res = Array.isArray(result) ? result[0] : result;
    return (res as any)?.insertId ?? null;
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
    const rows = await executeStatement(db,
      `SELECT id, vaId, source, cardId, cardName, cardUrl, actionId, messageText,
              flaggedAt, resolvedAt, resolvedBy, demeritIssued, demeritIssuedAt
       FROM vague_reply_flags
       WHERE resolvedAt IS NULL AND vaId = ?
       ORDER BY flaggedAt ASC`,
      [vaId]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    return (Array.isArray(data) ? data : []).map((r: any) => ({
      ...r,
      flaggedAt: new Date(r.flaggedAt),
      resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
      demeritIssued: Boolean(r.demeritIssued),
      demeritIssuedAt: r.demeritIssuedAt ? new Date(r.demeritIssuedAt) : null,
    }));
  } catch {
    return [];
  }
}

export async function resolveVagueReplyFlag(vaId: number, id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await executeStatement(db,
      `UPDATE vague_reply_flags
       SET resolvedAt = NOW(), resolvedBy = 'manual', updatedAt = NOW()
       WHERE id = ? AND vaId = ?`,
      [id, vaId]
    );
  } catch (e) {
    console.error("[DB] resolveVagueReplyFlag failed:", e);
  }
}

export async function autoDemeritVagueReplyFlag(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await executeStatement(db,
      `UPDATE vague_reply_flags
       SET resolvedAt = NOW(), resolvedBy = 'auto_demerit',
           demeritIssued = 1, demeritIssuedAt = NOW(), updatedAt = NOW()
       WHERE id = ?`,
      [id]
    );
  } catch (e) {
    console.error("[DB] autoDemeritVagueReplyFlag failed:", e);
  }
}

export async function getAllVagueReplyFlags(vaId: number, limit = 50): Promise<VagueFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = normalizeReplyMonitorLimit(limit, 50);
  try {
    const rows = await executeStatement(db,
      `SELECT id, vaId, source, cardId, cardName, cardUrl, actionId, messageText,
              flaggedAt, resolvedAt, resolvedBy, demeritIssued, demeritIssuedAt
       FROM vague_reply_flags
       WHERE vaId = ?
       ORDER BY flaggedAt DESC
       LIMIT ?`,
      [vaId, safeLimit]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    return (Array.isArray(data) ? data : []).map((r: any) => ({
      ...r,
      flaggedAt: new Date(r.flaggedAt),
      resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
      demeritIssued: Boolean(r.demeritIssued),
      demeritIssuedAt: r.demeritIssuedAt ? new Date(r.demeritIssuedAt) : null,
    }));
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
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  try {
    const rows = await executeStatement(db,
      `SELECT id FROM vague_reply_flags
       WHERE resolvedAt IS NULL AND demeritIssued = 0 AND flaggedAt <= ? AND vaId = ?`,
      [ONE_HOUR_AGO, vaId]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    const expired: Array<{ id: number }> = Array.isArray(data) ? data : [];
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
  const flaggedAtStr = data.flaggedAt.toISOString().slice(0, 19).replace("T", " ");
  try {
    const result = await executeStatement(db,
      `INSERT IGNORE INTO unsigned_message_flags
         (vaId, source, cardId, cardName, cardUrl, actionId, messageText, flaggedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vaId, data.source, data.cardId, data.cardName, data.cardUrl,
        data.actionId, data.messageText.slice(0, 2000), flaggedAtStr,
      ]
    );
    const res = Array.isArray(result) ? result[0] : result;
    return (res as any)?.insertId ?? null;
  } catch (e) {
    console.error("[DB] insertUnsignedFlag failed:", e);
    return null;
  }
}

export async function getActiveUnsignedFlags(vaId: number): Promise<UnsignedFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const rows = await executeStatement(db,
      `SELECT id, vaId, source, cardId, cardName, cardUrl, actionId, messageText,
              flaggedAt, resolvedAt, resolvedBy, demeritIssued, demeritIssuedAt
       FROM unsigned_message_flags
       WHERE resolvedAt IS NULL AND vaId = ?
       ORDER BY flaggedAt ASC`,
      [vaId]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    return (Array.isArray(data) ? data : []).map((r: any) => ({
      ...r,
      flaggedAt: new Date(r.flaggedAt),
      resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
      demeritIssued: Boolean(r.demeritIssued),
      demeritIssuedAt: r.demeritIssuedAt ? new Date(r.demeritIssuedAt) : null,
    }));
  } catch {
    return [];
  }
}

export async function resolveUnsignedFlag(vaId: number, id: number, note?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await executeStatement(db,
      `UPDATE unsigned_message_flags
       SET resolvedAt = NOW(), resolvedBy = 'manual',
           resolutionNote = ?, updatedAt = NOW()
       WHERE id = ? AND vaId = ?`,
      [note ?? null, id, vaId]
    );
  } catch (e) {
    console.error("[DB] resolveUnsignedFlag failed:", e);
  }
}

export async function autoDemeritUnsignedFlag(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await executeStatement(db,
      `UPDATE unsigned_message_flags
       SET resolvedAt = NOW(), resolvedBy = 'auto_demerit',
           demeritIssued = 1, demeritIssuedAt = NOW(), updatedAt = NOW()
       WHERE id = ?`,
      [id]
    );
  } catch (e) {
    console.error("[DB] autoDemeritUnsignedFlag failed:", e);
  }
}

export async function getAllUnsignedFlags(vaId: number, limit = 50): Promise<UnsignedFlagRow[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = normalizeReplyMonitorLimit(limit, 50);
  try {
    const rows = await executeStatement(db,
      `SELECT id, vaId, source, cardId, cardName, cardUrl, actionId, messageText,
              flaggedAt, resolvedAt, resolvedBy, demeritIssued, demeritIssuedAt
       FROM unsigned_message_flags
       WHERE vaId = ?
       ORDER BY flaggedAt DESC
       LIMIT ?`,
      [vaId, safeLimit]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    return (Array.isArray(data) ? data : []).map((r: any) => ({
      ...r,
      flaggedAt: new Date(r.flaggedAt),
      resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
      demeritIssued: Boolean(r.demeritIssued),
      demeritIssuedAt: r.demeritIssuedAt ? new Date(r.demeritIssuedAt) : null,
    }));
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
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  try {
    const rows = await executeStatement(db,
      `SELECT id FROM unsigned_message_flags
       WHERE resolvedAt IS NULL AND demeritIssued = 0 AND flaggedAt <= ? AND vaId = ?`,
      [ONE_HOUR_AGO, vaId]
    );
    const data = Array.isArray(rows) ? rows[0] : rows;
    const expired: Array<{ id: number }> = Array.isArray(data) ? data : [];
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
