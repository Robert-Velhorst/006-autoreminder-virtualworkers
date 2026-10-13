/**
 * Cache Warming Service
 * 
 * Pre-loads frequently accessed data into cache on server startup
 * to improve performance and reduce initial API calls.
 */

import { getDb } from '../db';
import { 
  atisCards, 
  atisBoards, 
  vaProfiles,
  holidays,
  users,
} from '../../drizzle/schema';
import { sql } from 'drizzle-orm';

interface CacheWarmingStats {
  totalCards: number;
  totalBoards: number;
  totalWorkers: number;
  totalHolidays: number;
  totalUsers: number;
  startTime: number;
  endTime: number;
  duration: number;
  mode: 'database_buffer_preload';
}

let refreshInterval: NodeJS.Timeout | null = null;
let warmUpInFlight: Promise<CacheWarmingStats> | null = null;

/**
 * Warm up cache with frequently accessed data
 */
export function warmUpCache(): Promise<CacheWarmingStats> {
  if (warmUpInFlight) return warmUpInFlight;

  const operation = runCacheWarmUp();
  warmUpInFlight = operation;
  const clearInFlight = () => {
    if (warmUpInFlight === operation) warmUpInFlight = null;
  };
  void operation.then(clearInFlight, clearInFlight);
  return operation;
}

async function runCacheWarmUp(): Promise<CacheWarmingStats> {
  const startTime = Date.now();
  console.log('[CacheWarming] Starting cache warm-up...');

  try {
    const db = await getDb();
    if (!db) {
      throw new Error('Database connection failed');
    }

    // Warm up ATIS cards cache
    console.log('[CacheWarming] Warming up ATIS cards...');
    const cards = await db.select()
      .from(atisCards)
      .limit(100); // Load top 100 cards
    console.log(`[CacheWarming] Loaded ${cards.length} ATIS cards`);

    // Warm up boards cache
    console.log('[CacheWarming] Warming up boards...');
    const boards = await db.select()
      .from(atisBoards)
      .limit(50); // Load top 50 boards
    console.log(`[CacheWarming] Loaded ${boards.length} boards`);

    // Warm up VA profiles cache
    console.log('[CacheWarming] Warming up VA profiles...');
    const workers = await db.select()
      .from(vaProfiles)
      .limit(100); // Load top 100 workers
    console.log(`[CacheWarming] Loaded ${workers.length} VA profiles`);

    // Warm up holidays cache
    console.log('[CacheWarming] Warming up holidays...');
    const holidays_data = await db.select()
      .from(holidays)
      .limit(1000); // Load all holidays
    console.log(`[CacheWarming] Loaded ${holidays_data.length} holidays`);

    // Warm up users cache
    console.log('[CacheWarming] Warming up users...');
    const users_data = await db.select()
      .from(users)
      .limit(100); // Load top 100 users
    console.log(`[CacheWarming] Loaded ${users_data.length} users`);

    // Pre-compute statistics
    console.log('[CacheWarming] Computing statistics...');
    const cardStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(atisCards);
    
    const boardStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(atisBoards);

    const workerStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(vaProfiles);

    const holidayStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(holidays);

    const userStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(users);

    const endTime = Date.now();
    const duration = endTime - startTime;

    const stats: CacheWarmingStats = {
      totalCards: cardStats[0]?.count || 0,
      totalBoards: boardStats[0]?.count || 0,
      totalWorkers: workerStats[0]?.count || 0,
      totalHolidays: holidayStats[0]?.count || 0,
      totalUsers: userStats[0]?.count || 0,
      startTime,
      endTime,
      duration,
      mode: 'database_buffer_preload',
    };

    console.log('[CacheWarming] Cache warm-up completed in', duration, 'ms');
    console.log('[CacheWarming] Statistics:', stats);

    return stats;
  } catch (error) {
    console.error('[CacheWarming] Error during cache warm-up:', error);
    throw error;
  }
}

/**
 * Get cache warming statistics
 */
export async function getCacheWarmingStats(): Promise<Partial<CacheWarmingStats>> {
  try {
    const db = await getDb();
    if (!db) {
      return {};
    }

    const cardStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(atisCards);
    
    const boardStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(atisBoards);

    const workerStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(vaProfiles);

    const holidayStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(holidays);

    const userStats = await db.select({
      count: sql<number>`count(*)`,
    })
      .from(users);

    return {
      totalCards: cardStats[0]?.count || 0,
      totalBoards: boardStats[0]?.count || 0,
      totalWorkers: workerStats[0]?.count || 0,
      totalHolidays: holidayStats[0]?.count || 0,
      totalUsers: userStats[0]?.count || 0,
    };
  } catch (error) {
    console.error('[CacheWarming] Error getting statistics:', error);
    return {};
  }
}

/**
 * Schedule periodic cache refresh
 */
export function scheduleCacheRefresh(intervalMinutes: number = 60): NodeJS.Timeout {
  const normalizedInterval = Math.min(24 * 60, Math.max(5, Math.floor(intervalMinutes)));
  if (refreshInterval) clearInterval(refreshInterval);
  console.log(`[CacheWarming] Scheduling database buffer preload every ${normalizedInterval} minutes`);
  
  refreshInterval = setInterval(async () => {
    try {
      console.log('[CacheWarming] Running scheduled cache refresh...');
      await warmUpCache();
    } catch (error) {
      console.error('[CacheWarming] Error during scheduled refresh:', error);
    }
  }, normalizedInterval * 60 * 1000);
  refreshInterval.unref();
  return refreshInterval;
}

export function stopCacheRefresh(): void {
  if (!refreshInterval) return;
  clearInterval(refreshInterval);
  refreshInterval = null;
}
