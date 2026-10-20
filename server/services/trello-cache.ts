/**
 * Trello Data Cache Service
 *
 * Three-tier caching strategy:
 *   L1 — Redis (distributed, survives restarts, shared across instances)
 *   L2 — PostgreSQL via Drizzle ORM (persistent, single-instance fallback)
 *   L3 — In-process Map (test environment only)
 *
 * If REDIS_URL is not set, L1 is skipped transparently.
 * If DATABASE_URL is not set, L2 is skipped and L3 is used (tests).
 */

import { getDb } from '../db';
import { getRedis, isRedisAvailable } from './redis';
import { 
  trelloCacheMetadata, 
  trelloCachedTasks, 
  trelloCachedBoards, 
  trelloCachedCards 
} from '../../drizzle/schema.postgres';
import { eq, and, lt } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

function redisTaskKey(userId: number, userOpenId: string): string {
  return `trello:tasks:${userId}:${userOpenId}`;
}

function redisMetaKey(userId: number, userOpenId: string, cacheKey: string): string {
  return `trello:meta:${userId}:${userOpenId}:${cacheKey}`;
}

async function getFromRedis(key: string): Promise<any | null> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setInRedis(key: string, value: any, ttlSeconds: number): Promise<void> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return;
  }

  await setSerializedInRedis(key, serialized, ttlSeconds);
}

async function setSerializedInRedis(key: string, serialized: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.set(key, serialized, 'EX', ttlSeconds);
  } catch {
    // non-fatal
  }
}

async function deleteFromRedis(...keys: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.del(...keys);
  } catch {
    // non-fatal
  }
}

export interface CacheOptions {
  ttlSeconds?: number;
  forceRefresh?: boolean;
}

export interface CacheStats {
  cacheKey: string;
  hitCount: number;
  missCount: number;
  hitRate: number;
  lastFetched: Date | null;
  expiresAt: Date | null;
}

// MEDIUMTEXT is capped at 16 MiB. Leave space for character encoding and
// future response metadata rather than allowing a cache write to fail.
export const MAX_TASK_CACHE_BYTES = 12 * 1024 * 1024;

export function isTaskCachePayloadWithinLimit(tasks: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(tasks), 'utf8') <= MAX_TASK_CACHE_BYTES;
  } catch {
    return false;
  }
}

type MemoryCacheEntry = {
  data: any;
  cachedAt: Date;
  expiresAt: Date;
};

type MemoryMetadataEntry = {
  cacheKey: string;
  hitCount: number;
  missCount: number;
  lastFetched: Date | null;
  expiresAt: Date | null;
  ttlSeconds: number;
  updatedAt: Date;
};

const memoryCache = new Map<string, MemoryCacheEntry>();
const memoryMetadata = new Map<string, MemoryMetadataEntry>();
let lastSeenTestName: string | null = null;

if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
  void import('vitest')
    .then(({ beforeEach }) => {
      beforeEach(() => {
        memoryCache.clear();
        memoryMetadata.clear();
        lastSeenTestName = null;
      });
    })
    .catch(() => {
      // Test harness may not be available in some execution modes.
    });
}

function buildMemoryKey(userId: number, userOpenId: string, cacheKey: string): string {
  return `${userId}:${userOpenId}:${cacheKey}`;
}

function getMemoryMetadataForUser(userId: number, userOpenId: string): MemoryMetadataEntry[] {
  const prefix = `${userId}:${userOpenId}:`;
  return Array.from(memoryMetadata.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value);
}

function setMemoryMetadata(
  userId: number,
  userOpenId: string,
  cacheKey: string,
  updater: (current: MemoryMetadataEntry | undefined) => MemoryMetadataEntry
): MemoryMetadataEntry {
  const key = buildMemoryKey(userId, userOpenId, cacheKey);
  const next = updater(memoryMetadata.get(key));
  memoryMetadata.set(key, next);
  return next;
}

function deleteMemoryCache(userId: number, userOpenId: string, cacheKey?: string): number {
  const prefix = `${userId}:${userOpenId}:`;
  const keys = Array.from(memoryCache.keys()).filter((key) =>
    cacheKey ? key === buildMemoryKey(userId, userOpenId, cacheKey) : key.startsWith(prefix),
  );

  for (const key of keys) {
    memoryCache.delete(key);
  }

  const metadataKeys = Array.from(memoryMetadata.keys()).filter((key) =>
    cacheKey ? key === buildMemoryKey(userId, userOpenId, cacheKey) : key.startsWith(prefix),
  );

  for (const key of metadataKeys) {
    memoryMetadata.delete(key);
  }

  return Math.max(keys.length, metadataKeys.length);
}

function resetMemoryCacheForNewTest(): void {
  const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  if (!isTestEnv) return;

  const currentTestName = (globalThis as any)?.expect?.getState?.()?.currentTestName ?? null;
  if (!currentTestName || currentTestName === lastSeenTestName) {
    return;
  }

  memoryCache.clear();
  memoryMetadata.clear();
  lastSeenTestName = currentTestName;
}

/**
 * Get cached tasks for a user
 * Read order: Redis (L1) → PostgreSQL (L2) → in-process Map (L3/test)
 */
export async function getCachedTasks(
  userId: number,
  userOpenId: string,
  options: CacheOptions = {}
): Promise<any | null> {
  const { ttlSeconds = 300, forceRefresh = false } = options;

  if (forceRefresh) {
    await invalidateCache(userId, userOpenId, 'tasks');
    return null;
  }

  // --- L1: Redis ---
  const rKey = redisTaskKey(userId, userOpenId);
  const redisData = await getFromRedis(rKey);
  if (redisData !== null) {
    await recordCacheHit(userId, userOpenId, 'tasks');
    return redisData;
  }

  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    const now = new Date();
    const metadataKey = buildMemoryKey(userId, userOpenId, 'tasks');
    const metadata = memoryMetadata.get(metadataKey);

    if (!metadata) {
      await recordCacheMiss(userId, userOpenId, 'tasks', ttlSeconds);
      return null;
    }

    if (metadata.expiresAt && metadata.expiresAt < now) {
      await recordCacheMiss(userId, userOpenId, 'tasks', ttlSeconds);
      return null;
    }

    const cachedTasks = memoryCache.get(metadataKey);
    if (!cachedTasks) {
      await recordCacheMiss(userId, userOpenId, 'tasks', ttlSeconds);
      return null;
    }

    await recordCacheHit(userId, userOpenId, 'tasks');
    return cachedTasks.data;
  }

  // --- L2: PostgreSQL ---
  const now = new Date();

  // Check if cache exists and is valid
  const cacheMetadata = await db
    .select()
    .from(trelloCacheMetadata)
    .where(
      and(
        eq(trelloCacheMetadata.userId, userId),
        eq(trelloCacheMetadata.userOpenId, userOpenId),
        eq(trelloCacheMetadata.cacheKey, 'tasks')
      )
    )
    .limit(1);

  if (cacheMetadata.length === 0) {
    // Cache miss - no metadata
    await recordCacheMiss(userId, userOpenId, 'tasks', ttlSeconds);
    return null;
  }

  const metadata = cacheMetadata[0];

  // Check if cache is expired
  if (new Date(metadata.expiresAt) < now) {
    // Cache expired
    await recordCacheMiss(userId, userOpenId, 'tasks', ttlSeconds);
    return null;
  }

  // Get cached tasks
  const cachedTasks = await db
    .select()
    .from(trelloCachedTasks)
    .where(
      and(
        eq(trelloCachedTasks.userId, userId),
        eq(trelloCachedTasks.userOpenId, userOpenId)
      )
    )
    .limit(1);

  if (cachedTasks.length === 0) {
    // Cache miss - no data
    await recordCacheMiss(userId, userOpenId, 'tasks', ttlSeconds);
    return null;
  }

  // Cache hit
  await recordCacheHit(userId, userOpenId, 'tasks');

  try {
    const parsed = JSON.parse(cachedTasks[0].taskData);
    // Backfill Redis so subsequent reads are faster
    const remainingTtl = Math.max(
      1,
      Math.floor((new Date(metadata.expiresAt).getTime() - now.getTime()) / 1000)
    );
    await setInRedis(rKey, parsed, remainingTtl);
    return parsed;
  } catch (error) {
    console.error('Error parsing cached task data:', error);
    await invalidateCache(userId, userOpenId, 'tasks');
    return null;
  }
}

/**
 * Set cached tasks for a user
 * Write order: Redis (L1) + PostgreSQL (L2) in parallel, or in-process Map (L3/test)
 */
export async function setCachedTasks(
  userId: number,
  userOpenId: string,
  tasks: any,
  ttlSeconds: number = 300
): Promise<void> {
  let serializedTasks: string;
  try {
    serializedTasks = JSON.stringify(tasks);
  } catch (error) {
    console.warn('[Trello cache] Skipping a non-serializable task response:', error);
    return;
  }

  if (Buffer.byteLength(serializedTasks, 'utf8') > MAX_TASK_CACHE_BYTES) {
    console.warn('[Trello cache] Skipping an oversized task response that exceeds the durable cache limit');
    return;
  }

  // Cache persistence is an optimization. It must never make a successful
  // Trello scheduling response fail after the external request completed.
  void setSerializedInRedis(redisTaskKey(userId, userOpenId), serializedTasks, ttlSeconds);

  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const key = buildMemoryKey(userId, userOpenId, 'tasks');

    memoryCache.set(key, {
      data: tasks,
      cachedAt: now,
      expiresAt,
    });

    setMemoryMetadata(userId, userOpenId, 'tasks', (current) => ({
      cacheKey: 'tasks',
      hitCount: current?.hitCount ?? 0,
      missCount: current?.missCount ?? 0,
      lastFetched: now,
      expiresAt,
      ttlSeconds,
      updatedAt: now,
    }));
    return;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  try {
    // Delete existing cache
    await db
      .delete(trelloCachedTasks)
      .where(
        and(
          eq(trelloCachedTasks.userId, userId),
          eq(trelloCachedTasks.userOpenId, userOpenId)
        )
      );

    // Insert new cache
    await db.insert(trelloCachedTasks).values({
      userId,
      userOpenId,
      taskData: serializedTasks,
      cachedAt: now,
      expiresAt,
    });

    // Update or create metadata
    const existingMetadata = await db
      .select()
      .from(trelloCacheMetadata)
      .where(
        and(
          eq(trelloCacheMetadata.userId, userId),
          eq(trelloCacheMetadata.userOpenId, userOpenId),
          eq(trelloCacheMetadata.cacheKey, 'tasks')
        )
      )
      .limit(1);

    if (existingMetadata.length > 0) {
      await db
        .update(trelloCacheMetadata)
        .set({
          lastFetched: now,
          expiresAt,
          ttlSeconds,
          updatedAt: now,
        })
        .where(eq(trelloCacheMetadata.id, existingMetadata[0].id));
    } else {
      await db.insert(trelloCacheMetadata).values({
        userId,
        userOpenId,
        cacheKey: 'tasks',
        lastFetched: now,
        expiresAt,
        ttlSeconds,
        hitCount: 0,
        missCount: 0,
      });
    }
  } catch (error) {
    console.warn('[Trello cache] Durable cache write failed; returning live scheduling data without caching it:', error);
  }
}

/**
 * Invalidate cache for a specific key
 */
export async function invalidateCache(
  userId: number,
  userOpenId: string,
  cacheKey: string
): Promise<void> {
  // Always clear Redis first (fast, non-blocking)
  if (cacheKey === 'tasks') {
    void deleteFromRedis(redisTaskKey(userId, userOpenId));
  }
  void deleteFromRedis(redisMetaKey(userId, userOpenId, cacheKey));

  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    deleteMemoryCache(userId, userOpenId, cacheKey);
    return;
  }

  // Delete cache data based on key
  if (cacheKey === 'tasks') {
    await db
      .delete(trelloCachedTasks)
      .where(
        and(
          eq(trelloCachedTasks.userId, userId),
          eq(trelloCachedTasks.userOpenId, userOpenId)
        )
      );
  } else if (cacheKey === 'boards') {
    await db
      .delete(trelloCachedBoards)
      .where(
        and(
          eq(trelloCachedBoards.userId, userId),
          eq(trelloCachedBoards.userOpenId, userOpenId)
        )
      );
  } else if (cacheKey.startsWith('cards:')) {
    const boardId = cacheKey.split(':')[1];
    await db
      .delete(trelloCachedCards)
      .where(
        and(
          eq(trelloCachedCards.userId, userId),
          eq(trelloCachedCards.userOpenId, userOpenId),
          eq(trelloCachedCards.boardId, boardId)
        )
      );
  }

  // Delete metadata
  await db
    .delete(trelloCacheMetadata)
    .where(
      and(
        eq(trelloCacheMetadata.userId, userId),
        eq(trelloCacheMetadata.userOpenId, userOpenId),
        eq(trelloCacheMetadata.cacheKey, cacheKey)
      )
    );
}

/**
 * Invalidate all cache for a user
 */
export async function invalidateAllCache(
  userId: number,
  userOpenId: string
): Promise<void> {
  // Clear all known Redis keys for this user
  void deleteFromRedis(
    redisTaskKey(userId, userOpenId),
    redisMetaKey(userId, userOpenId, 'tasks'),
    redisMetaKey(userId, userOpenId, 'boards'),
  );

  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    deleteMemoryCache(userId, userOpenId);
    return;
  }

  await db
    .delete(trelloCachedTasks)
    .where(
      and(
        eq(trelloCachedTasks.userId, userId),
        eq(trelloCachedTasks.userOpenId, userOpenId)
      )
    );

  await db
    .delete(trelloCachedBoards)
    .where(
      and(
        eq(trelloCachedBoards.userId, userId),
        eq(trelloCachedBoards.userOpenId, userOpenId)
      )
    );

  await db
    .delete(trelloCachedCards)
    .where(
      and(
        eq(trelloCachedCards.userId, userId),
        eq(trelloCachedCards.userOpenId, userOpenId)
      )
    );

  await db
    .delete(trelloCacheMetadata)
    .where(
      and(
        eq(trelloCacheMetadata.userId, userId),
        eq(trelloCacheMetadata.userOpenId, userOpenId)
      )
    );
}

/**
 * Clean up expired cache entries
 */
export async function cleanupExpiredCache(): Promise<number> {
  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    const now = new Date();
    let deletedCount = 0;

    for (const [key, metadata] of Array.from(memoryMetadata.entries())) {
      if (metadata.expiresAt && metadata.expiresAt < now) {
        memoryMetadata.delete(key);
        memoryCache.delete(key);
        deletedCount++;
      }
    }

    return deletedCount;
  }
  const now = new Date();

  // Get expired cache keys
  const expiredMetadata = await db
    .select()
    .from(trelloCacheMetadata)
    .where(lt(trelloCacheMetadata.expiresAt, now));

  let deletedCount = 0;

  for (const metadata of expiredMetadata) {
    await invalidateCache(metadata.userId, metadata.userOpenId, metadata.cacheKey);
    deletedCount++;
  }

  return deletedCount;
}

/**
 * Get cache statistics for a user
 */
export async function getCacheStats(
  userId: number,
  userOpenId: string
): Promise<CacheStats[]> {
  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    return getMemoryMetadataForUser(userId, userOpenId).map((m) => ({
      cacheKey: m.cacheKey,
      hitCount: m.hitCount,
      missCount: m.missCount,
      hitRate: m.hitCount + m.missCount > 0
        ? (m.hitCount / (m.hitCount + m.missCount)) * 100
        : 0,
      lastFetched: m.lastFetched,
      expiresAt: m.expiresAt,
    }));
  }

  const metadata = await db
    .select()
    .from(trelloCacheMetadata)
    .where(
      and(
        eq(trelloCacheMetadata.userId, userId),
        eq(trelloCacheMetadata.userOpenId, userOpenId)
      )
    );

  return metadata.map((m: any) => ({
    cacheKey: m.cacheKey,
    hitCount: m.hitCount,
    missCount: m.missCount,
    hitRate: m.hitCount + m.missCount > 0 
      ? (m.hitCount / (m.hitCount + m.missCount)) * 100 
      : 0,
    lastFetched: m.lastFetched,
    expiresAt: m.expiresAt,
  }));
}

/**
 * Record cache hit
 */
async function recordCacheHit(
  userId: number,
  userOpenId: string,
  cacheKey: string
): Promise<void> {
  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    const key = buildMemoryKey(userId, userOpenId, cacheKey);
    const metadata = memoryMetadata.get(key);
    if (metadata) {
      metadata.hitCount += 1;
      metadata.updatedAt = new Date();
      memoryMetadata.set(key, metadata);
    }
    return;
  }

  const metadata = await db
    .select()
    .from(trelloCacheMetadata)
    .where(
      and(
        eq(trelloCacheMetadata.userId, userId),
        eq(trelloCacheMetadata.userOpenId, userOpenId),
        eq(trelloCacheMetadata.cacheKey, cacheKey)
      )
    )
    .limit(1);

  if (metadata.length > 0) {
    await db
      .update(trelloCacheMetadata)
      .set({
        hitCount: metadata[0].hitCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(trelloCacheMetadata.id, metadata[0].id));
  }
}

/**
 * Record cache miss
 */
async function recordCacheMiss(
  userId: number,
  userOpenId: string,
  cacheKey: string,
  ttlSeconds: number
): Promise<void> {
  const db = await getDb();
  if (!db) {
    resetMemoryCacheForNewTest();
    const now = new Date();
    const key = buildMemoryKey(userId, userOpenId, cacheKey);
    const existing = memoryMetadata.get(key);
    if (existing) {
      existing.missCount += 1;
      existing.updatedAt = now;
      memoryMetadata.set(key, existing);
    } else {
      memoryMetadata.set(key, {
        cacheKey,
        hitCount: 0,
        missCount: 1,
        lastFetched: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        ttlSeconds,
        updatedAt: now,
      });
    }
    return;
  }

  const metadata = await db
    .select()
    .from(trelloCacheMetadata)
    .where(
      and(
        eq(trelloCacheMetadata.userId, userId),
        eq(trelloCacheMetadata.userOpenId, userOpenId),
        eq(trelloCacheMetadata.cacheKey, cacheKey)
      )
    )
    .limit(1);

  if (metadata.length > 0) {
    await db
      .update(trelloCacheMetadata)
      .set({
        missCount: metadata[0].missCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(trelloCacheMetadata.id, metadata[0].id));
  } else {
    // Create metadata on first miss
    const now = new Date();
    await db.insert(trelloCacheMetadata).values({
      userId,
      userOpenId,
      cacheKey,
      lastFetched: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      ttlSeconds,
      hitCount: 0,
      missCount: 1,
    });
  }
}
