/**
 * Chatbot Conversation History Service
 * 
 * Stores and retrieves conversation history for the Trello chatbot.
 * Tracks commands, responses, and worker engagement.
 */

import { getDb } from '../db';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { chatbotCheckinResponses, chatbotConversations } from '../../drizzle/schema.postgres';
import { BotCommand, BotResponse } from './trello-chatbot';
type ConversationRow = typeof chatbotConversations.$inferSelect;

export interface ConversationRecord {
  id?: number;
  cardTrelloId: string;
  cardName?: string;
  boardTrelloId?: string;
  command: string;
  commandArgs?: string[];
  authorTrelloId?: string;
  authorName?: string;
  incomingCommentId?: string;
  responseCommentId?: string;
  responseText?: string;
  responseStatus: 'success' | 'failed' | 'pending';
  responseError?: string;
  receivedAt: Date;
  respondedAt?: Date;
  responseTimeMs?: number;
}

export interface CheckinResponseRecord {
  conversationId: number;
  cardTrelloId: string;
  workerTrelloId?: string;
  workerName?: string;
  workerId?: number;
  responseCommentId?: string;
  responseText?: string;
  reportedProgress?: string;
  reportedBlockers?: string;
  estimatedCompletion?: string;
  checkinSentAt: Date;
  responseReceivedAt: Date;
  responseTimeMinutes?: number;
}

function mapConversation(row: ConversationRow): ConversationRecord {
  let commandArgs: string[] | undefined;
  if (typeof row.commandArgs === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.commandArgs);
      if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) {
        commandArgs = parsed;
      }
    } catch {
      commandArgs = undefined;
    }
  }

  return {
    id: row.id,
    cardTrelloId: row.cardTrelloId,
    cardName: row.cardName ?? undefined,
    boardTrelloId: row.boardTrelloId ?? undefined,
    command: row.command,
    commandArgs,
    authorTrelloId: row.authorTrelloId ?? undefined,
    authorName: row.authorName ?? undefined,
    incomingCommentId: row.incomingCommentId ?? undefined,
    responseCommentId: row.responseCommentId ?? undefined,
    responseText: row.responseText ?? undefined,
    responseStatus: row.responseStatus,
    responseError: row.responseError ?? undefined,
    receivedAt: row.receivedAt,
    respondedAt: row.respondedAt ?? undefined,
    responseTimeMs: row.responseTimeMs ?? undefined,
  };
}

/**
 * Store a conversation record
 */
export async function storeConversation(record: ConversationRecord): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const [inserted] = await db
      .insert(chatbotConversations)
      .values({
        cardTrelloId: record.cardTrelloId,
        cardName: record.cardName ?? null,
        boardTrelloId: record.boardTrelloId ?? null,
        command: record.command,
        commandArgs: record.commandArgs ? JSON.stringify(record.commandArgs) : null,
        authorTrelloId: record.authorTrelloId ?? null,
        authorName: record.authorName ?? null,
        incomingCommentId: record.incomingCommentId ?? null,
        responseCommentId: record.responseCommentId ?? null,
        responseText: record.responseText ?? null,
        responseStatus: record.responseStatus,
        responseError: record.responseError ?? null,
        receivedAt: record.receivedAt,
        respondedAt: record.respondedAt ?? null,
        responseTimeMs: record.responseTimeMs ?? null,
      })
      .returning({ id: chatbotConversations.id });
    return inserted?.id ?? null;
  } catch (error) {
    console.error('[ChatbotHistory] Error storing conversation:', error);
    return null;
  }
}

/**
 * Update a conversation with response details
 */
export async function updateConversationResponse(
  conversationId: number,
  responseCommentId: string,
  responseText: string,
  status: 'success' | 'failed',
  error?: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    const respondedAt = new Date();
    
    // Get the received time to calculate response time
    const [conversation] = await db
      .select({ receivedAt: chatbotConversations.receivedAt })
      .from(chatbotConversations)
      .where(eq(chatbotConversations.id, conversationId))
      .limit(1);
    const receivedAt = conversation?.receivedAt;
    
    const responseTimeMs = receivedAt 
      ? respondedAt.getTime() - new Date(receivedAt).getTime()
      : null;

    await db.update(chatbotConversations).set({
      responseCommentId,
      responseText,
      responseStatus: status,
      responseError: error ?? null,
      respondedAt,
      responseTimeMs,
    }).where(eq(chatbotConversations.id, conversationId));
  } catch (error) {
    console.error('[ChatbotHistory] Error updating conversation response:', error);
  }
}

/**
 * Store a check-in response from a worker
 */
export async function storeCheckinResponse(record: CheckinResponseRecord): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const responseTimeMinutes = record.responseTimeMinutes || 
      Math.round((record.responseReceivedAt.getTime() - record.checkinSentAt.getTime()) / 60000);

    const [inserted] = await db
      .insert(chatbotCheckinResponses)
      .values({
        conversationId: record.conversationId,
        cardTrelloId: record.cardTrelloId,
        workerTrelloId: record.workerTrelloId ?? null,
        workerName: record.workerName ?? null,
        workerId: record.workerId ?? null,
        responseCommentId: record.responseCommentId ?? null,
        responseText: record.responseText ?? null,
        reportedProgress: record.reportedProgress ?? null,
        reportedBlockers: record.reportedBlockers ?? null,
        estimatedCompletion: record.estimatedCompletion ?? null,
        checkinSentAt: record.checkinSentAt,
        responseReceivedAt: record.responseReceivedAt,
        responseTimeMinutes,
      })
      .returning({ id: chatbotCheckinResponses.id });
    return inserted?.id ?? null;
  } catch (error) {
    console.error('[ChatbotHistory] Error storing checkin response:', error);
    return null;
  }
}

/**
 * Get recent conversations for a card
 */
export async function getCardConversations(
  cardTrelloId: string,
  limit: number = 10
): Promise<ConversationRecord[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const rows = await db.select().from(chatbotConversations)
      .where(eq(chatbotConversations.cardTrelloId, cardTrelloId))
      .orderBy(desc(chatbotConversations.receivedAt))
      .limit(limit);
    return rows.map(mapConversation);
  } catch (error) {
    console.error('[ChatbotHistory] Error getting card conversations:', error);
    return [];
  }
}

/**
 * Get conversations by author
 */
export async function getAuthorConversations(
  authorTrelloId: string,
  limit: number = 50
): Promise<ConversationRecord[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const rows = await db.select().from(chatbotConversations)
      .where(eq(chatbotConversations.authorTrelloId, authorTrelloId))
      .orderBy(desc(chatbotConversations.receivedAt))
      .limit(limit);
    return rows.map(mapConversation);
  } catch (error) {
    console.error('[ChatbotHistory] Error getting author conversations:', error);
    return [];
  }
}

/**
 * Get check-in responses for a worker
 */
export async function getWorkerCheckinResponses(
  workerId: number,
  limit: number = 50
): Promise<CheckinResponseRecord[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const rows = await db.select().from(chatbotCheckinResponses)
      .where(eq(chatbotCheckinResponses.workerId, workerId))
      .orderBy(desc(chatbotCheckinResponses.responseReceivedAt))
      .limit(limit);
    return rows.map(row => ({
      conversationId: row.conversationId,
      cardTrelloId: row.cardTrelloId,
      workerTrelloId: row.workerTrelloId ?? undefined,
      workerName: row.workerName ?? undefined,
      workerId: row.workerId ?? undefined,
      responseCommentId: row.responseCommentId ?? undefined,
      responseText: row.responseText ?? undefined,
      reportedProgress: row.reportedProgress ?? undefined,
      reportedBlockers: row.reportedBlockers ?? undefined,
      estimatedCompletion: row.estimatedCompletion ?? undefined,
      checkinSentAt: row.checkinSentAt,
      responseReceivedAt: row.responseReceivedAt,
      responseTimeMinutes: row.responseTimeMinutes ?? undefined,
    }));
  } catch (error) {
    console.error('[ChatbotHistory] Error getting worker checkin responses:', error);
    return [];
  }
}

/**
 * Get pending check-ins (sent but not yet responded to)
 */
export async function getPendingCheckins(
  maxAgeHours: number = 24
): Promise<Array<{
  conversationId: number;
  cardTrelloId: string;
  authorName: string;
  receivedAt: Date;
}>> {
  const db = await getDb();
  if (!db) return [];

  try {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    
    return await db.select({
      conversationId: chatbotConversations.id,
      cardTrelloId: chatbotConversations.cardTrelloId,
      authorName: sql<string>`coalesce(${chatbotConversations.authorName}, 'Unknown')`,
      receivedAt: chatbotConversations.receivedAt,
    })
      .from(chatbotConversations)
      .leftJoin(chatbotCheckinResponses, eq(chatbotConversations.id, chatbotCheckinResponses.conversationId))
      .where(and(
        inArray(chatbotConversations.command, ['checkin', 'check', 'update']),
        eq(chatbotConversations.responseStatus, 'success'),
        gt(chatbotConversations.receivedAt, cutoff),
        isNull(chatbotCheckinResponses.id),
      ))
      .orderBy(chatbotConversations.receivedAt);
  } catch (error) {
    console.error('[ChatbotHistory] Error getting pending checkins:', error);
    return [];
  }
}

/**
 * Calculate response rate for a worker
 */
export async function getWorkerResponseRate(
  workerId: number,
  days: number = 30
): Promise<{
  totalCheckins: number;
  responded: number;
  responseRate: number;
  avgResponseMinutes: number;
}> {
  const db = await getDb();
  if (!db) {
    return { totalCheckins: 0, responded: 0, responseRate: 0, avgResponseMinutes: 0 };
  }

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const [data] = await db.select({
      totalCheckins: sql<number>`count(*)::int`,
      responded: sql<number>`count(*) filter (where ${chatbotCheckinResponses.responseReceivedAt} is not null)::int`,
      avgResponseMinutes: sql<number | null>`avg(${chatbotCheckinResponses.responseTimeMinutes})`,
    })
      .from(chatbotCheckinResponses)
      .where(and(
        eq(chatbotCheckinResponses.workerId, workerId),
        gt(chatbotCheckinResponses.checkinSentAt, cutoff),
      ));
    
    const totalCheckins = Number(data.totalCheckins) || 0;
    const responded = Number(data.responded) || 0;
    const avgResponseMinutes = Number(data.avgResponseMinutes) || 0;
    
    return {
      totalCheckins,
      responded,
      responseRate: totalCheckins > 0 ? (responded / totalCheckins) * 100 : 0,
      avgResponseMinutes: Math.round(avgResponseMinutes),
    };
  } catch (error) {
    console.error('[ChatbotHistory] Error calculating worker response rate:', error);
    return { totalCheckins: 0, responded: 0, responseRate: 0, avgResponseMinutes: 0 };
  }
}

/**
 * Get command usage statistics
 */
export async function getCommandStats(
  days: number = 30
): Promise<Record<string, number>> {
  const db = await getDb();
  if (!db) return {};

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const count = sql<number>`count(*)::int`;
    const rows = await db.select({ command: chatbotConversations.command, count })
      .from(chatbotConversations)
      .where(gt(chatbotConversations.receivedAt, cutoff))
      .groupBy(chatbotConversations.command)
      .orderBy(desc(count));
    const stats: Record<string, number> = {};
    
    for (const row of rows) {
      stats[row.command] = Number(row.count);
    }
    
    return stats;
  } catch (error) {
    console.error('[ChatbotHistory] Error getting command stats:', error);
    return {};
  }
}

/**
 * Helper to create conversation record from bot command
 */
export function createConversationFromCommand(cmd: BotCommand): ConversationRecord {
  return {
    cardTrelloId: cmd.cardId,
    command: cmd.command,
    commandArgs: cmd.args,
    authorTrelloId: cmd.authorId,
    authorName: cmd.authorName,
    incomingCommentId: cmd.commentId,
    responseStatus: 'pending',
    receivedAt: new Date(),
  };
}

export default {
  storeConversation,
  updateConversationResponse,
  storeCheckinResponse,
  getCardConversations,
  getAuthorConversations,
  getWorkerCheckinResponses,
  getPendingCheckins,
  getWorkerResponseRate,
  getCommandStats,
  createConversationFromCommand,
};
