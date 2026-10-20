import { randomInt, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import * as schema from '../drizzle/schema';
import { 
  getCachedTasks, 
  setCachedTasks, 
  invalidateCache, 
  invalidateAllCache,
  getCacheStats,
  cleanupExpiredCache
} from './services/trello-cache';
import { 
  trelloCacheMetadata, 
  trelloCachedTasks 
} from '../drizzle/schema';
import { eq } from 'drizzle-orm';

const backend = vi.hoisted(() => ({ db: null as MySql2Database<typeof schema> | null }));
vi.mock('./db', () => ({ getDb: async () => backend.db }));
vi.mock('./services/redis', () => ({ getRedis: () => null, isRedisAvailable: () => false }));

// Only this opt-in selects MySQL. Never inherit DATABASE_URL or load an .env file.
const testDatabaseUrl = process.env.APTLSS_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  if (url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['/aptlss_test', '/recovery_test'].includes(url.pathname)) {
    throw new Error('Cache integration tests require an explicit loopback aptlss_test or recovery_test database');
  }
}

for (const mode of ['memory', 'mysql'] as const) {
describe.skipIf(mode === 'mysql' && !testDatabaseUrl)(`Trello Cache Service (${mode})`, () => {
  let testUserId: number;
  let testUserOpenId: string;
  let pool: Pool | undefined;
  let readyDb: MySql2Database<typeof schema> | undefined;
  let connection: PoolConnection | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (mode !== 'mysql') return;
    vi.stubEnv('DATABASE_URL', testDatabaseUrl!);
    const actual = await vi.importActual<typeof import('./db')>('./db');
    closeDatabase = actual.closeDb;
    const db = await actual.getDb();
    expect(db, 'Explicit MySQL tests must never fall back to memory').not.toBeNull();
    readyDb = db!;
    pool = (db as MySql2Database<typeof schema> & { $client: Pool }).$client;
    const [identity] = await pool.query('SELECT DATABASE() AS name');
    expect((identity as unknown as { name: string }[])[0].name)
      .toBe(new URL(testDatabaseUrl!).pathname.slice(1));
  });

  beforeEach(async () => {
    testUserId = randomInt(1_000_000, 2_000_000_000);
    testUserOpenId = `cache-test-${randomUUID()}`;
    backend.db = null;
    if (mode !== 'mysql') return;
    connection = await pool!.getConnection();
    await connection.beginTransaction();
    backend.db = drizzle(connection, { schema, mode: 'default' });
  });

  afterEach(async () => {
    vi.useRealTimers();
    backend.db = null;
    // Even global expired-cache cleanup stays inside the fixture transaction.
    const current = connection;
    connection = undefined;
    if (current) {
      try { await current.rollback(); }
      finally { current.release(); }
      expect(await readyDb!.select().from(trelloCachedTasks)
        .where(eq(trelloCachedTasks.userOpenId, testUserOpenId))).toHaveLength(0);
      expect(await readyDb!.select().from(trelloCacheMetadata)
        .where(eq(trelloCacheMetadata.userOpenId, testUserOpenId))).toHaveLength(0);
    }
  });

  afterAll(async () => {
    try { await closeDatabase?.(); }
    finally { vi.unstubAllEnvs(); }
  });

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
      if (backend.db) {
        const rows = await backend.db.select().from(trelloCachedTasks)
          .where(eq(trelloCachedTasks.userOpenId, testUserOpenId));
        const metadata = await backend.db.select().from(trelloCacheMetadata)
          .where(eq(trelloCacheMetadata.userOpenId, testUserOpenId));
        expect(rows).toHaveLength(1);
        expect(metadata).toHaveLength(1);
        expect(metadata[0].hitCount).toBe(1);
      }
    });

    it('should return null on cache miss', async () => {
      const cachedData = await getCachedTasks(testUserId, testUserOpenId);
      expect(cachedData).toBeNull();
    });

    it('should return null for expired cache', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache with very short TTL
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 1);

      // Advance expiry without faking network timers or delaying the suite.
      vi.setSystemTime(Date.now() + 1500);

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
    it('should preserve another user cache when invalidating one user', async () => {
      const otherOpenId = `cache-test-${randomUUID()}`;
      const tasks = { tasks: [{ id: 'scoped-task', title: 'Scoped task' }], timezone: 'UTC' };
      await setCachedTasks(testUserId, testUserOpenId, tasks, 300);
      await setCachedTasks(testUserId, otherOpenId, tasks, 300);

      await invalidateAllCache(testUserId, testUserOpenId);

      expect(await getCachedTasks(testUserId, testUserOpenId)).toBeNull();
      expect(await getCachedTasks(testUserId, otherOpenId)).toEqual(tasks);
      if (backend.db) {
        expect(await backend.db.select().from(trelloCachedTasks)
          .where(eq(trelloCachedTasks.userOpenId, testUserOpenId))).toHaveLength(0);
        expect(await backend.db.select().from(trelloCachedTasks)
          .where(eq(trelloCachedTasks.userOpenId, otherOpenId))).toHaveLength(1);
      }
    });

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
      vi.useFakeTimers({ toFake: ['Date'] });
      const testTasks = {
        tasks: [{ id: '1', title: 'Task 1' }],
        timezone: 'UTC'
      };

      // Set cache with short TTL
      await setCachedTasks(testUserId, testUserOpenId, testTasks, 1);

      vi.setSystemTime(Date.now() + 1500);

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
      expect((cachedData as unknown as typeof largeTasks).tasks).toHaveLength(1000);
    });
  });
});
}
