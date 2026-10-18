/**
 * Chatbot Scheduler Service
 * 
 * Handles scheduled check-ins and automated reminders for workers.
 * Sends progress questions at configured times and EOD summaries.
 */

import { getDb } from '../db';
import { eq, and, sql, lte, isNotNull } from 'drizzle-orm';
import { atisCards, atisCardUnderstanding, vaProfiles } from '../../drizzle/schema.postgres';
import { sendScheduledCheckin, sendEODSummary, postTrelloComment } from './trello-chatbot';
import { getVATimezone, isWithinWorkingHours, convertToVATimezone } from './timezone-detection';

interface ScheduledCheckin {
  cardId: string;
  workerId?: number;
  workerName?: string;
  checkinType: 'morning' | 'midday' | 'eod';
  scheduledTime: Date;
}

/**
 * Get cards that are due soon and need check-ins
 */
async function getCardsNeedingCheckin(): Promise<Array<{
  trelloId: string;
  name: string;
  dueDate: Date;
  assignedWorkerId?: number;
  assignedWorkerName?: string;
}>> {
  try {
    const db = await getDb();
    if (!db) return [];

    // Get cards with due dates in the next 7 days that have APTLSS analysis
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const cards = await db
      .select({
        trelloId: atisCards.trelloId,
        name: atisCards.name,
        dueDate: atisCards.dueDate,
      })
      .from(atisCards)
      .innerJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
      .where(
        and(
          isNotNull(atisCards.dueDate),
          lte(atisCards.dueDate, weekFromNow)
        )
      );

    return cards.map((card: any) => ({
      trelloId: card.trelloId,
      name: card.name,
      dueDate: card.dueDate!,
    }));
  } catch (error) {
    console.error('[ChatbotScheduler] Error getting cards for checkin:', error);
    return [];
  }
}

/**
 * Get all workers with their check-in preferences
 */
async function getWorkersWithPreferences(): Promise<Array<{
  id: number;
  name: string;
  workStartHour: number;
  workEndHour: number;
  timezone: string;
}>> {
  try {
    const db = await getDb();
    if (!db) return [];

    const workers = await db
      .select({
        id: vaProfiles.id,
        name: vaProfiles.name,
        workStartHour: vaProfiles.workStartHour,
        workEndHour: vaProfiles.workEndHour,
        timezone: vaProfiles.timezone,
      })
      .from(vaProfiles)
      .where(eq(vaProfiles.status, 'active'));

    // Enhance with timezone detection for workers without explicit timezone
    const enhancedWorkers = await Promise.all(
      workers.map(async (w: any) => {
        // Use timezone detection if timezone is default or not set
        let timezone = w.timezone;
        if (!timezone || timezone === 'UTC' || timezone === 'Asia/Manila') {
          const detectedTz = await getVATimezone(w.id);
          if (detectedTz) {
            timezone = detectedTz;
          }
        }
        
        return {
          id: w.id,
          name: w.name,
          workStartHour: w.workStartHour || 9,
          workEndHour: w.workEndHour || 18,
          timezone: timezone || 'Asia/Manila',
        };
      })
    );
    
    return enhancedWorkers;
  } catch (error) {
    console.error('[ChatbotScheduler] Error getting workers:', error);
    return [];
  }
}

/**
 * Check if it's time for a morning check-in for a worker
 */
function isMorningCheckinTime(workerTimezone: string, workStartHour: number): boolean {
  try {
    const now = new Date();
    const workerTime = new Date(now.toLocaleString('en-US', { timeZone: workerTimezone }));
    const hour = workerTime.getHours();
    const minute = workerTime.getMinutes();
    
    // Morning check-in: 30 minutes after work start
    return hour === workStartHour && minute >= 30 && minute < 35;
  } catch {
    return false;
  }
}

/**
 * Check if it's time for a midday check-in for a worker
 */
function isMiddayCheckinTime(workerTimezone: string): boolean {
  try {
    const now = new Date();
    const workerTime = new Date(now.toLocaleString('en-US', { timeZone: workerTimezone }));
    const hour = workerTime.getHours();
    const minute = workerTime.getMinutes();
    
    // Midday check-in: around 1 PM
    return hour === 13 && minute >= 0 && minute < 5;
  } catch {
    return false;
  }
}

/**
 * Check if it's time for an EOD summary for a worker
 */
function isEODTime(workerTimezone: string, workEndHour: number): boolean {
  try {
    const now = new Date();
    const workerTime = new Date(now.toLocaleString('en-US', { timeZone: workerTimezone }));
    const hour = workerTime.getHours();
    const minute = workerTime.getMinutes();
    
    // EOD summary: 30 minutes before work end
    return hour === workEndHour - 1 && minute >= 30 && minute < 35;
  } catch {
    return false;
  }
}

/**
 * Send morning check-in message
 */
async function sendMorningCheckin(cardId: string, workerName?: string): Promise<boolean> {
  let text = `☀️ **Good Morning!**\n\n`;
  
  if (workerName) {
    text += `Hi @${workerName}! `;
  }
  
  text += `Ready to start the day?\n\n`;
  text += `📋 **Today's Focus:**\n`;
  text += `Type **@bot status** to see your current progress and next steps.\n\n`;
  text += `Have a productive day! 💪`;

  return postTrelloComment(cardId, text);
}

/**
 * Send midday check-in message
 */
async function sendMiddayCheckin(cardId: string, workerName?: string): Promise<boolean> {
  return sendScheduledCheckin(cardId, workerName);
}

/**
 * Run the scheduler tick - called every 5 minutes
 */
export async function runSchedulerTick(): Promise<{
  checkinsSent: number;
  eodSent: number;
  errors: number;
}> {
  const results = {
    checkinsSent: 0,
    eodSent: 0,
    errors: 0,
  };

  try {
    const workers = await getWorkersWithPreferences();
    const cards = await getCardsNeedingCheckin();

    if (cards.length === 0 || workers.length === 0) {
      return results;
    }

    for (const worker of workers) {
      // Check for morning check-in time
      if (isMorningCheckinTime(worker.timezone, worker.workStartHour)) {
        console.log(`[ChatbotScheduler] Morning check-in time for ${worker.name}`);
        
        // Send check-in to cards due soon
        for (const card of cards.slice(0, 3)) { // Limit to 3 cards per check-in
          try {
            const sent = await sendMorningCheckin(card.trelloId, worker.name);
            if (sent) results.checkinsSent++;
          } catch (error) {
            console.error(`[ChatbotScheduler] Error sending morning checkin:`, error);
            results.errors++;
          }
        }
      }

      // Check for midday check-in time
      if (isMiddayCheckinTime(worker.timezone)) {
        console.log(`[ChatbotScheduler] Midday check-in time for ${worker.name}`);
        
        for (const card of cards.slice(0, 2)) { // Limit to 2 cards
          try {
            const sent = await sendMiddayCheckin(card.trelloId, worker.name);
            if (sent) results.checkinsSent++;
          } catch (error) {
            console.error(`[ChatbotScheduler] Error sending midday checkin:`, error);
            results.errors++;
          }
        }
      }

      // Check for EOD summary time
      if (isEODTime(worker.timezone, worker.workEndHour)) {
        console.log(`[ChatbotScheduler] EOD summary time for ${worker.name}`);
        
        for (const card of cards.slice(0, 5)) { // Send EOD for up to 5 cards
          try {
            const sent = await sendEODSummary(card.trelloId);
            if (sent) results.eodSent++;
          } catch (error) {
            console.error(`[ChatbotScheduler] Error sending EOD summary:`, error);
            results.errors++;
          }
        }
      }
    }
  } catch (error) {
    console.error('[ChatbotScheduler] Error in scheduler tick:', error);
    results.errors++;
  }

  return results;
}

/**
 * Start the chatbot scheduler
 * Runs every 5 minutes to check for scheduled check-ins
 */
let schedulerInterval: NodeJS.Timeout | null = null;

export function startChatbotScheduler(): void {
  if (schedulerInterval) {
    console.log('[ChatbotScheduler] Scheduler already running');
    return;
  }

  console.log('[ChatbotScheduler] Starting scheduler (5 minute intervals)');
  
  // Run immediately on start
  runSchedulerTick().then(results => {
    console.log(`[ChatbotScheduler] Initial tick: ${results.checkinsSent} check-ins, ${results.eodSent} EOD summaries, ${results.errors} errors`);
  });

  // Then run every 5 minutes
  schedulerInterval = setInterval(async () => {
    const results = await runSchedulerTick();
    if (results.checkinsSent > 0 || results.eodSent > 0) {
      console.log(`[ChatbotScheduler] Tick: ${results.checkinsSent} check-ins, ${results.eodSent} EOD summaries`);
    }
  }, 5 * 60 * 1000);
}

export function stopChatbotScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[ChatbotScheduler] Scheduler stopped');
  }
}

/**
 * Manually trigger a check-in for a specific card
 */
export async function triggerManualCheckin(
  cardId: string, 
  workerName?: string,
  type: 'morning' | 'midday' | 'eod' = 'midday'
): Promise<boolean> {
  switch (type) {
    case 'morning':
      return sendMorningCheckin(cardId, workerName);
    case 'midday':
      return sendMiddayCheckin(cardId, workerName);
    case 'eod':
      return sendEODSummary(cardId);
    default:
      return sendMiddayCheckin(cardId, workerName);
  }
}

export default {
  startChatbotScheduler,
  stopChatbotScheduler,
  runSchedulerTick,
  triggerManualCheckin,
};
