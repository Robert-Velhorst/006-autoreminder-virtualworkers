import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  getCachedTasks, 
  setCachedTasks, 
  invalidateCache, 
  invalidateAllCache,
  getCacheStats,
  cleanupExpiredCache,
  MAX_TASK_CACHE_BYTES,
  isTaskCachePayloadWithinLimit,
} from './services/trello-cache';
import { getDb } from './db';
import { 
  trelloCacheMetadata, 
  trelloCachedTasks 
} from '../drizzle/schema';
import { eq, and } from 'drizzle-orm';

describe('Trello Cache Service', () => {
  const testUserId = 999;
  const testUserOpenId = 'test-user-cache';

  // Clean up test data before and after each test
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  async function cleanupTestData() {
    const db = await getDb();
    if (!db) return;

    await db.delete(trelloCachedTasks)
      .where(eq(trelloCachedTasks.userOpenId, testUserOpenId));

    await db.delete(trelloCacheMetadata)
      .where(eq(trelloCacheMetadata.userOpenId, testUserOpenId));
  }

  describe('setCachedTasks and getCachedTasks', () => {
    it('should cache and retrieve tasks successfully', async () => {
      const testTasks = {
        tasks: [
          { id: '1', title: 'Task 1', isCompleted: false },
          { id: '2', title: 'Task 2', isCompleted: true }
        ],
        timezone: 'UTC'
      };

      // Set cache
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 300);

      // Get from cache
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);

      expect(cachedData).not.toBeNull();
      expect(cachedData).toEqual(testTasks);
    });

    it('should return null on cache miss', async () => {
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).toBeNull();
    });

    it('should return null for expired cache', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache with very short TTL
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 1);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Should return null for expired cache
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).toBeNull();
    });

    it('should force refresh when forceRefresh is true', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 300);

      // Force refresh should return null
      const cachedData = await getCachedTasks(testUserId, testUserOpenId, { 
        forceRefresh: true 
      });
      expect(cachedData).toBeNull();
    });

    it('should update existing cache', async () => {
      const tasks1 = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      const tasks2 = {
        tasks: [{ id: '2', title: 'Task 2' }],
        timezone: 'America/New_York'
      };

      // Set initial cache
      await setCachedTasks(testUserId, testUserOpenId, tasks1, 300);

      // Update cache
      await setCachedTasks(testUserId, testUserOpenId, tasks2, 300);

      // Should get updated data
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).toEqual(tasks2);
    });
  });

  describe('invalidateCache', () => {
    it('should invalidate specific cache key', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 300);

      // Verify cache exists
      let cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).not.toBeNull();

      // Invalidate cache
      await invalidateCache(testUserId, testUserOpenId, 'tasks');

      // Verify cache is gone
      cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).toBeNull();
    });
  });

  describe('invalidateAllCache', () => {
    it('should invalidate all cache for user', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 300);

      // Verify cache exists
      let cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).not.toBeNull();

      // Invalidate all cache
      await invalidateAllCache(testUserId, testUserOpenId);

      // Verify cache is gone
      cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).toBeNull();
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 300);

      // Get from cache (hit)
      await getCachedTasks(testUserId, testUserOpenId);

      // Get stats
      const stats = await getCacheStats(testUserId, testUserOpenId);

      expect(stats).toHaveLength(1);
      expect(stats[0].cacheKey).toBe('tasks');
      expect(stats[0].hitCount).toBe(1);
      expect(stats[0].missCount).toBe(0);
      expect(stats[0].hitRate).toBe(100);
    });

    it('should track cache misses', async () => {
      // Attempt to get non-existent cache (miss)
      await getCachedTasks(testUserId, testUserOpenId);

      // Get stats
      const stats = await getCacheStats(testUserId, testUserOpenId);

      expect(stats).toHaveLength(1);
      expect(stats[0].missCount).toBe(1);
      expect(stats[0].hitCount).toBe(0);
      expect(stats[0].hitRate).toBe(0);
    });

    it('should calculate hit rate correctly', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 300);

      // 3 hits
      await getCachedTasks(testUserId, testUserOpenId);
      await getCachedTasks(testUserId, testUserOpenId);
      await getCachedTasks(testUserId, testUserOpenId);

      // Get stats after hits
      const stats = await getCacheStats(testUserId, testUserOpenId);

      expect(stats).toHaveLength(1);
      expect(stats[0]).toBeDefined();
      expect(stats[0].hitCount).toBe(3);
      expect(stats[0].missCount).toBe(0);
      expect(stats[0].hitRate).toBe(100); // 3/3 = 100%
    });
  });

  describe('cleanupExpiredCache', () => {
    it('should clean up expired cache entries', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache with short TTL
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 1);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Run cleanup
      const deletedCount = await cleanupExpiredCache();

      // Should have deleted at least 1 entry
      expect(deletedCount).toBeGreaterThanOrEqual(1);

      // Verify cache is gone
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).toBeNull();
    });

    it('should not delete valid cache entries', async () => {
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache with long TTL
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 300);

      // Run cleanup
      await cleanupExpiredCache();

      // Cache should still exist
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).not.toBeNull();
    });
  });

  describe('Cache performance', () => {
    it('should handle large datasets efficiently', async () => {
      // Generate large dataset
      const largeTasks = {
        tasks: Array.from({ length: 1000 }, (_, i) => ({
          id: `task-${i}`,
          title: `Task ${i}`,
          isCompleted: i % 2 === 0
        })),
        timezone: 'UTC'
      };

      const startTime = Date.now();

      // Set cache
      await setCachedTasks(testUserId, testUserOpenId, largeTasks, 300);

      // Get from cache
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within reasonable time (< 1 second)
      expect(duration).toBeLessThan(1000);
      expect(cachedData).not.toBeNull();
      expect(cachedData.tasks).toHaveLength(1000);
    });

    it('does not persist an oversized task response that cannot fit in the durable cache', async () => {
      const oversizedTasks = {
        tasks: [{ id: 'oversized', description: 'x'.repeat(MAX_TASK_CACHE_BYTES) }],
        timezone: 'UTC',
      };

      expect(isTaskCachePayloadWithinLimit(oversizedTasks)).toBe(false);

      await setCachedTasks(testUserId, testUserOpenId, oversizedTasks, 300);

      expect(await getCachedTasks(testUserId, testUserOpenId)).toBeNull();
    });
  });
});
