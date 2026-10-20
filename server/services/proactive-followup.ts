/**
 * Proactive Follow-up System
 * 
 * Manages smart follow-ups that respect worker boundaries:
 * - Only sends follow-ups after a configurable grace period
 * - Tracks expected vs actual update times
 * - Avoids micromanaging by respecting work schedules
 */

import { getDb } from '../db';
import { vaProfiles, timeEntries } from '../../drizzle/schema.postgres';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { sendProactiveCheckIn } from './ai-chatbot-handler';
import { isTrelloCommentAutomationEnabled, postTrelloComment } from './trello-chatbot';

// Default grace period in minutes (15 minutes past expected update time)
const DEFAULT_GRACE_PERIOD_MINUTES = 15;

// Configuration for follow-up settings
interface FollowUpConfig {
  gracePeriodMinutes: number;
  maxFollowUpsPerDay: number;
  respectWorkingHours: boolean;
  enableAIResponses: boolean;
}

let followUpConfig: FollowUpConfig = {
  gracePeriodMinutes: DEFAULT_GRACE_PERIOD_MINUTES,
  maxFollowUpsPerDay: 3,
  respectWorkingHours: true,
  enableAIResponses: true,
};

// Proactive work can generate an LLM message before attempting a comment.
// Keep the policy decision at the processor boundary so disabled outbound
// automation also avoids that otherwise unnecessary model work.
export function isProactiveFollowUpAutomationEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  return isTrelloCommentAutomationEnabled(env);
}

// Track pending follow-ups
interface PendingFollowUp {
  cardId: string;
  cardName: string;
  vaId: number;
  vaName: string;
  expectedUpdateTime: Date;
  gracePeriodEnd: Date;
  followUpsSent: number;
  lastFollowUpTime: Date | null;
}

// In-memory store for pending follow-ups (would be DB in production)
const pendingFollowUps: Map<string, PendingFollowUp> = new Map();

/**
 * Get follow-up configuration
 */
export function getFollowUpConfig(): FollowUpConfig {
  return { ...followUpConfig };
}

/**
 * Update follow-up configuration
 */
export function setFollowUpConfig(config: Partial<FollowUpConfig>): void {
  followUpConfig = { ...followUpConfig, ...config };
}

/**
 * Calculate when a worker's shift ends based on their profile
 */
async function getWorkerShiftEnd(vaId: number): Promise<Date | null> {
  const db = await getDb();
  if (!db) return null;
  
  try {
    const profiles = await db
      .select()
      .from(vaProfiles)
      .where(eq(vaProfiles.id, vaId))
      .limit(1);
    
    if (profiles.length === 0) return null;
    
    const profile = profiles[0];
    const now = new Date();
    
    // Get worker's end hour (default to 18:00 / 6 PM)
    const endHour = profile.workEndHour || 18;
    
    // Create a date for today at the worker's end time
    const shiftEnd = new Date(now);
    shiftEnd.setHours(endHour, 0, 0, 0);
    
    // If we're past the shift end, it's tomorrow
    if (now > shiftEnd) {
      shiftEnd.setDate(shiftEnd.getDate() + 1);
    }
    
    return shiftEnd;
  } catch (error) {
    console.error('[ProactiveFollowup] Error getting worker shift end:', error);
    return null;
  }
}

/**
 * Check if current time is within worker's working hours
 */
async function isWithinWorkingHours(vaId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true; // Default to allowing if we can't check
  
  try {
    const profiles = await db
      .select()
      .from(vaProfiles)
      .where(eq(vaProfiles.id, vaId))
      .limit(1);
    
    if (profiles.length === 0) return true;
    
    const profile = profiles[0];
    const now = new Date();
    const currentHour = now.getHours();
    
    const startHour = profile.workStartHour || 9;
    const endHour = profile.workEndHour || 18;
    
    return currentHour >= startHour && currentHour < endHour;
  } catch (error) {
    console.error('[ProactiveFollowup] Error checking working hours:', error);
    return true;
  }
}

/**
 * Schedule a follow-up for a card
 */
export async function scheduleFollowUp(
  cardId: string,
  cardName: string,
  vaId: number,
  vaName: string,
  expectedUpdateTime: Date
): Promise<void> {
  const gracePeriodEnd = new Date(expectedUpdateTime);
  gracePeriodEnd.setMinutes(gracePeriodEnd.getMinutes() + followUpConfig.gracePeriodMinutes);
  
  const followUp: PendingFollowUp = {
    cardId,
    cardName,
    vaId,
    vaName,
    expectedUpdateTime,
    gracePeriodEnd,
    followUpsSent: 0,
    lastFollowUpTime: null,
  };
  
  pendingFollowUps.set(cardId, followUp);
  console.log(`[ProactiveFollowup] Scheduled follow-up for card ${cardId} at ${gracePeriodEnd.toISOString()}`);
}

/**
 * Cancel a scheduled follow-up (e.g., when worker provides update)
 */
export function cancelFollowUp(cardId: string): boolean {
  const existed = pendingFollowUps.has(cardId);
  pendingFollowUps.delete(cardId);
  if (existed) {
    console.log(`[ProactiveFollowup] Cancelled follow-up for card ${cardId}`);
  }
  return existed;
}

/**
 * Record that a worker provided an update (cancels pending follow-up)
 */
export function recordWorkerUpdate(cardId: string, vaId: number): void {
  cancelFollowUp(cardId);
  console.log(`[ProactiveFollowup] Recorded update from VA ${vaId} for card ${cardId}`);
}

/**
 * Check and send due follow-ups
 */
export async function processPendingFollowUps(): Promise<number> {
  if (!isProactiveFollowUpAutomationEnabled()) {
    console.log('[ProactiveFollowup] Outbound automation is disabled; skipping pending follow-ups');
    return 0;
  }

  const now = new Date();
  let followUpsSent = 0;
  
  for (const [cardId, followUp] of Array.from(pendingFollowUps.entries())) {
    // Check if grace period has passed
    if (now < followUp.gracePeriodEnd) {
      continue;
    }
    
    // Check if we've hit the max follow-ups for this card
    if (followUp.followUpsSent >= followUpConfig.maxFollowUpsPerDay) {
      console.log(`[ProactiveFollowup] Max follow-ups reached for card ${cardId}`);
      continue;
    }
    
    // Check working hours if configured
    if (followUpConfig.respectWorkingHours) {
      const withinHours = await isWithinWorkingHours(followUp.vaId);
      if (!withinHours) {
        console.log(`[ProactiveFollowup] Skipping follow-up for ${cardId} - outside working hours`);
        continue;
      }
    }
    
    // Send the follow-up
    const isOverdue = followUp.followUpsSent > 0;
    let success = false;
    
    if (followUpConfig.enableAIResponses) {
      // Use AI-generated follow-up
      success = await sendProactiveCheckIn(
        cardId,
        followUp.vaName,
        isOverdue,
        followUp.vaId
      );
    } else {
      // Use simple template follow-up
      const message = isOverdue
        ? `⏰ **Follow-up**\n\n@${followUp.vaName} Hi! I haven't received an update on "${followUp.cardName}" yet. Could you let me know how things are going? If you're blocked on something, I'm here to help!`
        : `👋 **Check-in**\n\n@${followUp.vaName} Hi! Just checking in on "${followUp.cardName}". How's progress? Let me know if you need any assistance!`;
      
      success = await postTrelloComment(cardId, message);
    }
    
    if (success) {
      followUp.followUpsSent++;
      followUp.lastFollowUpTime = now;
      
      // Schedule next follow-up (double the grace period each time)
      const nextGracePeriod = followUpConfig.gracePeriodMinutes * Math.pow(2, followUp.followUpsSent);
      followUp.gracePeriodEnd = new Date(now.getTime() + nextGracePeriod * 60000);
      
      followUpsSent++;
      console.log(`[ProactiveFollowup] Sent follow-up #${followUp.followUpsSent} for card ${cardId}`);
    }
  }
  
  return followUpsSent;
}

/**
 * Schedule end-of-day follow-ups for all active workers
 */
export async function scheduleEndOfDayFollowUps(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  try {
    // Get all active workers
    const workers = await db
      .select()
      .from(vaProfiles)
      .where(eq(vaProfiles.status, 'active'));
    
    for (const worker of workers) {
      const shiftEnd = await getWorkerShiftEnd(worker.id);
      if (!shiftEnd) continue;
      
      // Get cards the worker is actively working on (has time entries today)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const activeCards = await db
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.vaId, worker.userId),
            gte(timeEntries.startTime, today)
          )
        )
        .groupBy(timeEntries.taskId);
      
      for (const entry of activeCards) {
        // Schedule follow-up for shift end
        await scheduleFollowUp(
          entry.taskId,
          entry.taskId, // We'd need to fetch the actual card name
          worker.id,
          worker.name,
          shiftEnd
        );
      }
    }
    
    console.log('[ProactiveFollowup] Scheduled end-of-day follow-ups');
  } catch (error) {
    console.error('[ProactiveFollowup] Error scheduling EOD follow-ups:', error);
  }
}

/**
 * Get all pending follow-ups
 */
export function getPendingFollowUps(): PendingFollowUp[] {
  return Array.from(pendingFollowUps.values());
}

/**
 * Start the follow-up processor (runs every minute)
 */
let processorInterval: NodeJS.Timeout | null = null;

export function startFollowUpProcessor(): void {
  if (processorInterval) {
    console.log('[ProactiveFollowup] Processor already running');
    return;
  }
  
  // Process pending follow-ups every minute
  processorInterval = setInterval(async () => {
    const sent = await processPendingFollowUps();
    if (sent > 0) {
      console.log(`[ProactiveFollowup] Processed ${sent} follow-ups`);
    }
  }, 60000); // Every minute
  
  console.log('[ProactiveFollowup] Started follow-up processor');
}

export function stopFollowUpProcessor(): void {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
    console.log('[ProactiveFollowup] Stopped follow-up processor');
  }
}

export default {
  getFollowUpConfig,
  setFollowUpConfig,
  scheduleFollowUp,
  cancelFollowUp,
  recordWorkerUpdate,
  processPendingFollowUps,
  scheduleEndOfDayFollowUps,
  getPendingFollowUps,
  startFollowUpProcessor,
  stopFollowUpProcessor,
};
