/**
 * Chatbot Analytics Service
 *
 * Aggregates and calculates analytics for the Trello chatbot.
 * Tracks command usage, response rates, and worker engagement.
 */

import { and, desc, eq, gte, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { chatbotAnalytics, chatbotCheckinResponses, chatbotConversations } from '../../drizzle/schema.postgres';
import { getDb } from '../db';

export interface DailyAnalytics {
  date: string;
  totalCommands: number;
  commandBreakdown: Record<string, number>;
  successfulResponses: number;
  failedResponses: number;
  avgResponseTimeMs: number;
  checkinsSent: number;
  checkinsResponded: number;
  responseRate: number;
  avgCheckinResponseMinutes: number;
  uniqueWorkers: number;
  uniqueCards: number;
}

export interface WorkerEngagement {
  workerId: number;
  workerName: string;
  totalCheckins: number;
  responded: number;
  responseRate: number;
  avgResponseMinutes: number;
  lastActivity: Date | null;
}

export interface OverallStats {
  totalConversations: number;
  totalCommands: Record<string, number>;
  avgResponseTimeMs: number;
  totalCheckins: number;
  totalResponses: number;
  overallResponseRate: number;
  avgCheckinResponseMinutes: number;
  activeWorkers: number;
  activeCards: number;
  topCommands: Array<{ command: string; count: number }>;
}

/** Get analytics for a specific date. */
export async function getDailyAnalytics(date: Date): Promise<DailyAnalytics | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const dateStr = date.toISOString().split('T')[0];
    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const commandRows = await db
      .select({
        command: chatbotConversations.command,
        count: sql<number>`count(*)::int`,
        successful: sql<number>`count(*) filter (where ${chatbotConversations.responseStatus} = 'success')::int`,
        failed: sql<number>`count(*) filter (where ${chatbotConversations.responseStatus} = 'failed')::int`,
        avgResponseTime: sql<number | null>`avg(${chatbotConversations.responseTimeMs})`,
      })
      .from(chatbotConversations)
      .where(and(gte(chatbotConversations.receivedAt, startOfDay), lt(chatbotConversations.receivedAt, endOfDay)))
      .groupBy(chatbotConversations.command);

    const [uniqueData] = await db
      .select({
        uniqueWorkers: sql<number>`count(distinct ${chatbotConversations.authorTrelloId})::int`,
        uniqueCards: sql<number>`count(distinct ${chatbotConversations.cardTrelloId})::int`,
      })
      .from(chatbotConversations)
      .where(and(gte(chatbotConversations.receivedAt, startOfDay), lt(chatbotConversations.receivedAt, endOfDay)));

    const [checkinData] = await db
      .select({
        totalCheckins: sql<number>`count(*)::int`,
        responded: sql<number>`count(${chatbotCheckinResponses.id})::int`,
        avgResponseMinutes: sql<number | null>`avg(${chatbotCheckinResponses.responseTimeMinutes})`,
      })
      .from(chatbotConversations)
      .leftJoin(chatbotCheckinResponses, eq(chatbotConversations.id, chatbotCheckinResponses.conversationId))
      .where(and(
        inArray(chatbotConversations.command, ['checkin', 'check', 'update']),
        gte(chatbotConversations.receivedAt, startOfDay),
        lt(chatbotConversations.receivedAt, endOfDay),
      ));

    const commandBreakdown: Record<string, number> = {};
    let totalCommands = 0;
    let successfulResponses = 0;
    let failedResponses = 0;
    let totalResponseTime = 0;
    let responseCount = 0;

    for (const row of commandRows) {
      commandBreakdown[row.command] = Number(row.count);
      totalCommands += Number(row.count);
      successfulResponses += Number(row.successful);
      failedResponses += Number(row.failed);
      if (row.avgResponseTime != null) {
        totalResponseTime += Number(row.avgResponseTime) * Number(row.count);
        responseCount += Number(row.count);
      }
    }

    const totalCheckins = Number(checkinData?.totalCheckins) || 0;
    const checkinsResponded = Number(checkinData?.responded) || 0;

    return {
      date: dateStr,
      totalCommands,
      commandBreakdown,
      successfulResponses,
      failedResponses,
      avgResponseTimeMs: responseCount > 0 ? Math.round(totalResponseTime / responseCount) : 0,
      checkinsSent: totalCheckins,
      checkinsResponded,
      responseRate: totalCheckins > 0 ? Math.round((checkinsResponded / totalCheckins) * 100) : 0,
      avgCheckinResponseMinutes: Math.round(Number(checkinData?.avgResponseMinutes) || 0),
      uniqueWorkers: Number(uniqueData?.uniqueWorkers) || 0,
      uniqueCards: Number(uniqueData?.uniqueCards) || 0,
    };
  } catch (error) {
    console.error('[ChatbotAnalytics] Error getting daily analytics:', error);
    return null;
  }
}

/** Get analytics for a date range. */
export async function getAnalyticsRange(startDate: Date, endDate: Date): Promise<DailyAnalytics[]> {
  const analytics: DailyAnalytics[] = [];
  const current = new Date(startDate);

  while (current <= endDate) {
    const daily = await getDailyAnalytics(current);
    if (daily) analytics.push(daily);
    current.setDate(current.getDate() + 1);
  }

  return analytics;
}

/** Get worker engagement metrics. */
export async function getWorkerEngagement(days: number = 30): Promise<WorkerEngagement[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const totalCheckins = sql<number>`count(*)::int`;
    const rows = await db
      .select({
        workerId: chatbotCheckinResponses.workerId,
        workerName: chatbotCheckinResponses.workerName,
        totalCheckins,
        responded: sql<number>`count(*) filter (where ${chatbotCheckinResponses.responseReceivedAt} is not null)::int`,
        avgResponseMinutes: sql<number | null>`avg(${chatbotCheckinResponses.responseTimeMinutes})`,
        lastActivity: sql<Date | null>`max(${chatbotCheckinResponses.responseReceivedAt})`,
      })
      .from(chatbotCheckinResponses)
      .where(and(gt(chatbotCheckinResponses.checkinSentAt, cutoff), isNotNull(chatbotCheckinResponses.workerId)))
      .groupBy(chatbotCheckinResponses.workerId, chatbotCheckinResponses.workerName)
      .orderBy(desc(totalCheckins));

    return rows.map(row => {
      const total = Number(row.totalCheckins) || 0;
      const responded = Number(row.responded) || 0;
      return {
        workerId: Number(row.workerId),
        workerName: row.workerName || 'Unknown',
        totalCheckins: total,
        responded,
        responseRate: total > 0 ? Math.round((responded / total) * 100) : 0,
        avgResponseMinutes: Math.round(Number(row.avgResponseMinutes) || 0),
        lastActivity: row.lastActivity ? new Date(row.lastActivity) : null,
      };
    });
  } catch (error) {
    console.error('[ChatbotAnalytics] Error getting worker engagement:', error);
    return [];
  }
}

/** Get overall statistics. */
export async function getOverallStats(days: number = 30): Promise<OverallStats> {
  const db = await getDb();
  const defaultStats: OverallStats = {
    totalConversations: 0,
    totalCommands: {},
    avgResponseTimeMs: 0,
    totalCheckins: 0,
    totalResponses: 0,
    overallResponseRate: 0,
    avgCheckinResponseMinutes: 0,
    activeWorkers: 0,
    activeCards: 0,
    topCommands: [],
  };
  if (!db) return defaultStats;

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [convData] = await db
      .select({
        totalConversations: sql<number>`count(*)::int`,
        avgResponseTime: sql<number | null>`avg(${chatbotConversations.responseTimeMs})`,
        activeWorkers: sql<number>`count(distinct ${chatbotConversations.authorTrelloId})::int`,
        activeCards: sql<number>`count(distinct ${chatbotConversations.cardTrelloId})::int`,
      })
      .from(chatbotConversations)
      .where(gt(chatbotConversations.receivedAt, cutoff));

    const commandCount = sql<number>`count(*)::int`;
    const cmdRows = await db
      .select({ command: chatbotConversations.command, count: commandCount })
      .from(chatbotConversations)
      .where(gt(chatbotConversations.receivedAt, cutoff))
      .groupBy(chatbotConversations.command)
      .orderBy(desc(commandCount));

    const totalCommands: Record<string, number> = {};
    const topCommands: Array<{ command: string; count: number }> = [];
    for (const row of cmdRows) {
      totalCommands[row.command] = Number(row.count);
      topCommands.push({ command: row.command, count: Number(row.count) });
    }

    const [checkinData] = await db
      .select({
        totalCheckins: sql<number>`count(*)::int`,
        totalResponses: sql<number>`count(*) filter (where ${chatbotCheckinResponses.responseReceivedAt} is not null)::int`,
        avgResponseMinutes: sql<number | null>`avg(${chatbotCheckinResponses.responseTimeMinutes})`,
      })
      .from(chatbotCheckinResponses)
      .where(gt(chatbotCheckinResponses.checkinSentAt, cutoff));

    const totalCheckins = Number(checkinData?.totalCheckins) || 0;
    const totalResponses = Number(checkinData?.totalResponses) || 0;
    return {
      totalConversations: Number(convData?.totalConversations) || 0,
      totalCommands,
      avgResponseTimeMs: Math.round(Number(convData?.avgResponseTime) || 0),
      totalCheckins,
      totalResponses,
      overallResponseRate: totalCheckins > 0 ? Math.round((totalResponses / totalCheckins) * 100) : 0,
      avgCheckinResponseMinutes: Math.round(Number(checkinData?.avgResponseMinutes) || 0),
      activeWorkers: Number(convData?.activeWorkers) || 0,
      activeCards: Number(convData?.activeCards) || 0,
      topCommands: topCommands.slice(0, 5),
    };
  } catch (error) {
    console.error('[ChatbotAnalytics] Error getting overall stats:', error);
    return defaultStats;
  }
}

/** Update daily analytics rollup (called at end of day). */
export async function updateDailyRollup(date: Date): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    const analytics = await getDailyAnalytics(date);
    if (!analytics) return;

    // chatbot_analytics has no unique date constraint; the legacy MySQL upsert
    // therefore only conflicted on its generated primary key and never rolled a
    // date forward. Keep that behavior explicit instead of inventing a key.
    await db.insert(chatbotAnalytics).values({
      date,
      totalCommands: analytics.totalCommands,
      statusCommands: analytics.commandBreakdown.status || 0,
      checkinCommands: (analytics.commandBreakdown.checkin || 0)
        + (analytics.commandBreakdown.check || 0)
        + (analytics.commandBreakdown.update || 0),
      remindCommands: (analytics.commandBreakdown.remind || 0)
        + (analytics.commandBreakdown.reminder || 0)
        + (analytics.commandBreakdown.ping || 0),
      timeCommands: (analytics.commandBreakdown.time || 0)
        + (analytics.commandBreakdown.timer || 0)
        + (analytics.commandBreakdown.hours || 0),
      progressCommands: (analytics.commandBreakdown.progress || 0)
        + (analytics.commandBreakdown.report || 0),
      helpCommands: (analytics.commandBreakdown.help || 0) + (analytics.commandBreakdown['?'] || 0),
      unknownCommands: Object.entries(analytics.commandBreakdown)
        .filter(([cmd]) => ![
          'status', 'checkin', 'check', 'update', 'remind', 'reminder', 'ping',
          'time', 'timer', 'hours', 'progress', 'report', 'help', '?',
        ].includes(cmd))
        .reduce((sum, [, count]) => sum + count, 0),
      successfulResponses: analytics.successfulResponses,
      failedResponses: analytics.failedResponses,
      avgResponseTimeMs: analytics.avgResponseTimeMs,
      checkinsSent: analytics.checkinsSent,
      checkinsResponded: analytics.checkinsResponded,
      avgCheckinResponseMinutes: analytics.avgCheckinResponseMinutes,
      uniqueWorkers: analytics.uniqueWorkers,
      uniqueCards: analytics.uniqueCards,
      updatedAt: new Date(),
    });

    console.log(`[ChatbotAnalytics] Updated daily rollup for ${analytics.date}`);
  } catch (error) {
    console.error('[ChatbotAnalytics] Error updating daily rollup:', error);
  }
}

export default {
  getDailyAnalytics,
  getAnalyticsRange,
  getWorkerEngagement,
  getOverallStats,
  updateDailyRollup,
};
