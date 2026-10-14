/**
 * DB helpers for the APTLSS Audit Log and Admin Sync Log.
 *
 * The audit log records every automated action the system takes on a Trello card
 * so that Robert and Joyce can trace "what did the system do and why?".
 *
 * The sync log records each maintenance job run / webhook delivery for the
 * admin monitoring tab.
 */
import { getDb } from "./db";
import {
  aptlssAuditLog,
  adminSyncLog,
  type AptlssAuditLog,
  type InsertAptlssAuditLog,
  type AdminSyncLog,
  type InsertAdminSyncLog,
} from "../drizzle/schema.postgres";
import { eq, desc, and, gte, sql } from "drizzle-orm";

// ─── Audit Log ────────────────────────────────────────────────────────────────

/** Append one audit log entry. Fire-and-forget safe (errors are swallowed). */
export async function logAuditAction(entry: Omit<InsertAptlssAuditLog, "id" | "createdAt">): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(aptlssAuditLog).values(entry as InsertAptlssAuditLog);
  } catch {
    // Non-fatal — audit log failures must never break the main flow
  }
}

/** Get the most recent N audit log entries for a specific card. */
export async function getCardAuditLog(vaId: number, cardId: string, limit = 20): Promise<AptlssAuditLog[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(aptlssAuditLog)
    .where(and(eq(aptlssAuditLog.cardId, cardId), eq(aptlssAuditLog.vaId, vaId)))
    .orderBy(desc(aptlssAuditLog.createdAt))
    .limit(limit);
}

/** Get the most recent N audit log entries across all cards for a worker. */
export async function getRecentAuditLog(vaId: number, limit = 100): Promise<AptlssAuditLog[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(aptlssAuditLog)
    .where(eq(aptlssAuditLog.vaId, vaId))
    .orderBy(desc(aptlssAuditLog.createdAt))
    .limit(limit);
}

/** Count total audit log entries in the last N hours for a worker. */
export async function countRecentActions(vaId: number, hours = 24): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(aptlssAuditLog)
    .where(and(eq(aptlssAuditLog.vaId, vaId), gte(aptlssAuditLog.createdAt, since)));
  return rows[0]?.count ?? 0;
}

/** Prune audit log entries older than 90 days. */
export async function pruneOldAuditLog(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(aptlssAuditLog)
    .where(sql`${aptlssAuditLog.createdAt} < ${cutoff}`)
    .returning({ id: aptlssAuditLog.id });
  return result.length;
}

// ─── Admin Sync Log ───────────────────────────────────────────────────────────

/** Record a sync attempt (maintenance job run, webhook, manual refresh). */
export async function recordSyncAttempt(entry: Omit<InsertAdminSyncLog, "id" | "createdAt">): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(adminSyncLog).values(entry as InsertAdminSyncLog);
  } catch {
    // Non-fatal
  }
}

/** Get the most recent N sync log entries. */
export async function getRecentSyncLog(vaId: number, limit = 50): Promise<AdminSyncLog[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(adminSyncLog)
    .where(eq(adminSyncLog.vaId, vaId))
    .orderBy(desc(adminSyncLog.createdAt))
    .limit(limit);
}

/** Get the last successful sync entry. */
export async function getLastSuccessfulSync(vaId: number): Promise<AdminSyncLog | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(adminSyncLog)
    .where(and(eq(adminSyncLog.success, true), eq(adminSyncLog.vaId, vaId)))
    .orderBy(desc(adminSyncLog.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Get sync statistics for the last 24 hours. */
export async function getSyncStats24h(vaId: number): Promise<{
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  totalCardsProcessed: number;
  totalActionsTaken: number;
  totalSkippedLowConfidence: number;
}> {
  const db = await getDb();
  if (!db) return { totalRuns: 0, successRuns: 0, failedRuns: 0, totalCardsProcessed: 0, totalActionsTaken: 0, totalSkippedLowConfidence: 0 };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(adminSyncLog)
    .where(and(eq(adminSyncLog.vaId, vaId), gte(adminSyncLog.createdAt, since)));
  return {
    totalRuns: rows.length,
    successRuns: rows.filter(r => r.success).length,
    failedRuns: rows.filter(r => !r.success).length,
    totalCardsProcessed: rows.reduce((s, r) => s + r.cardsProcessed, 0),
    totalActionsTaken: rows.reduce((s, r) => s + r.actionsTaken, 0),
    totalSkippedLowConfidence: rows.reduce((s, r) => s + r.cardsSkippedLowConfidence, 0),
  };
}
