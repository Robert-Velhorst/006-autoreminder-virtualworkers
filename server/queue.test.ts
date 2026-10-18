import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestQueue } from './services/request-queue';

describe('Request Queue Service', () => {
  let queue: RequestQueue;

  beforeEach(() => {
    queue = new RequestQueue();
  });

  afterEach(() => {
    queue.clearAll();
  });

  describe('Basic functionality', () => {
    it('should execute a request successfully', async () => {
      const result = await queue.execute('test-key', async () => {
        return 'success';
      });

      expect(result).toBe('success');
    });

    it('should handle async operations', async () => {
      const result = await queue.execute('test-key', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'delayed-success';
      });

      expect(result).toBe('delayed-success');
    });

    it('should propagate errors from executor', async () => {
      await expect(
        queue.execute('test-key', async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');
    });
  });

  describe('Deduplication', () => {
    it('should deduplicate simultaneous identical requests', async () => {
      let executionCount = 0;

      const executor = async () => {
        executionCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return `result-${executionCount}`;
      };

      // Fire 3 identical requests simultaneously
      const promises = [
        queue.execute('same-key', executor),
        queue.execute('same-key', executor),
        queue.execute('same-key', executor),
      ];

      const results = await Promise.all(promises);

      // All should get the same result
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
      
      // Executor should only run once
      expect(executionCount).toBe(1);
    });

    it('should not deduplicate requests with different keys', async () => {
      let executionCount = 0;

      const executor = async () => {
        executionCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return `result-${executionCount}`;
      };

      // Fire 3 requests with different keys simultaneously
      const promises = [
        queue.execute('key-1', executor),
        queue.execute('key-2', executor),
        queue.execute('key-3', executor),
      ];

      const results = await Promise.all(promises);

      // All should get different results (not equal)
      expect(results[0]).not.toEqual(results[1]);
      expect(results[1]).not.toEqual(results[2]);
      expect(results[0]).not.toEqual(results[2]);
      
      // Executor should run 3 times
      expect(executionCount).toBe(3);
    });

    it('should allow new request after previous completes', async () => {
      let executionCount = 0;

      const executor = async () => {
        executionCount++;
        return `result-${executionCount}`;
      };

      // First request
      const result1 = await queue.execute('test-key', executor);
      expect(result1).toBe('result-1');

      // Second request (after first completes)
      const result2 = await queue.execute('test-key', executor);
      expect(result2).toBe('result-2');

      // Should have executed twice
      expect(executionCount).toBe(2);
    });
  });

  describe('Metrics tracking', () => {
    it('should track total requests', async () => {
      await queue.execute('key-1', async () => 'result');
      await queue.execute('key-2', async () => 'result');
      await queue.execute('key-3', async () => 'result');

      const metrics = queue.getMetrics();
      expect(metrics.totalRequests).toBe(3);
    });

    it('should track deduplicated requests', async () => {
      const executor = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'result';
      };

      // Fire 5 identical requests
      await Promise.all([
        queue.execute('same-key', executor),
        queue.execute('same-key', executor),
        queue.execute('same-key', executor),
        queue.execute('same-key', executor),
        queue.execute('same-key', executor),
      ]);

      const metrics = queue.getMetrics();
      expect(metrics.totalRequests).toBe(5);
      expect(metrics.deduplicatedRequests).toBe(4); // 4 out of 5 were deduplicated
      expect(metrics.deduplicationRate).toBeCloseTo(80, 0); // 80%
    });

    it('should calculate deduplication rate correctly', async () => {
      const executor = async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'result';
      };

      // 3 identical requests (2 deduplicated)
      await Promise.all([
        queue.execute('key-1', executor),
        queue.execute('key-1', executor),
        queue.execute('key-1', executor),
      ]);

      // 2 unique requests (0 deduplicated)
      await queue.execute('key-2', executor);
      await queue.execute('key-3', executor);

      const metrics = queue.getMetrics();
      expect(metrics.totalRequests).toBe(5);
      expect(metrics.deduplicatedRequests).toBe(2);
      expect(metrics.deduplicationRate).toBeCloseTo(40, 0); // 40%
    });

    it('should track active requests', async () => {
      const slowExecutor = async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return 'result';
      };

      // Start a slow request
      const promise = queue.execute('slow-key', slowExecutor);

      // Check metrics while request is active
      const metrics = queue.getMetrics();
      expect(metrics.activeRequests).toBe(1);

      // Wait for completion
      await promise;

      // Check metrics after completion
      const metricsAfter = queue.getMetrics();
      expect(metricsAfter.activeRequests).toBe(0);
    });

    it('should reset metrics', async () => {
      await queue.execute('key-1', async () => 'result');
      await queue.execute('key-2', async () => 'result');

      let metrics = queue.getMetrics();
      expect(metrics.totalRequests).toBe(2);

      queue.resetMetrics();

      metrics = queue.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.deduplicatedRequests).toBe(0);
    });
  });

  describe('Timeout handling', () => {
    it('should timeout long-running requests', async () => {
      const slowExecutor = async () => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        return 'result';
      };

      // Catch the rejection properly
      let error: Error | null = null;
      try {
        await queue.execute('slow-key', slowExecutor, 500); // 500ms timeout
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Request timeout');

      const metrics = queue.getMetrics();
      expect(metrics.timeoutErrors).toBe(1);
    });

    it('should not timeout fast requests', async () => {
      const fastExecutor = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'result';
      };

      const result = await queue.execute('fast-key', fastExecutor, 500);
      expect(result).toBe('result');

      const metrics = queue.getMetrics();
      expect(metrics.timeoutErrors).toBe(0);
    });
  });

  describe('Queue inspection', () => {
    it('should report pending request keys', async () => {
      const slowExecutor = async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return 'result';
      };

      // Start slow requests
      const promise1 = queue.execute('key-1', slowExecutor);
      const promise2 = queue.execute('key-2', slowExecutor);

      // Check pending keys
      const pendingKeys = queue.getPendingKeys();
      expect(pendingKeys).toContain('key-1');
      expect(pendingKeys).toContain('key-2');
      expect(pendingKeys).toHaveLength(2);

      // Wait for completion
      await Promise.all([promise1, promise2]);

      // Should be empty after completion
      const pendingKeysAfter = queue.getPendingKeys();
      expect(pendingKeysAfter).toHaveLength(0);
    });

    it('should check if request is pending', async () => {
      const slowExecutor = async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return 'result';
      };

      expect(queue.isPending('test-key')).toBe(false);

      const promise = queue.execute('test-key', slowExecutor);
      expect(queue.isPending('test-key')).toBe(true);

      await promise;
      expect(queue.isPending('test-key')).toBe(false);
    });

    it('should report pending request age', async () => {
      vi.useFakeTimers();
      const promise = queue.execute('test-key', async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return 'result';
      });
      const handledPromise = promise.catch(() => undefined);

      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(queue.getPendingAge('test-key')).toBe(100);

        await vi.advanceTimersByTimeAsync(100);
        await expect(promise).resolves.toBe('result');
        expect(queue.getPendingAge('test-key')).toBeNull();
      } finally {
        if (queue.isPending('test-key')) queue.clearAll();
        await handledPromise;
        vi.useRealTimers();
      }
    });
  });

  describe('Error handling', () => {
    it('should handle errors in deduplicated requests', async () => {
      const errorExecutor = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        throw new Error('Test error');
      };

      // Fire 3 identical requests
      const promises = [
        queue.execute('error-key', errorExecutor),
        queue.execute('error-key', errorExecutor),
        queue.execute('error-key', errorExecutor),
      ];

      // All should reject with the same error
      await expect(promises[0]).rejects.toThrow('Test error');
      await expect(promises[1]).rejects.toThrow('Test error');
      await expect(promises[2]).rejects.toThrow('Test error');
    });

    it('should clear pending requests on clearAll', async () => {
      const slowExecutor = async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        return 'result';
      };

      const promise = queue.execute('test-key', slowExecutor);

      // Clear all pending
      queue.clearAll();

      // Should reject - catch properly
      let error: Error | null = null;
      try {
        await promise;
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).not.toBeNull();
      expect(error?.message).toBe('Queue cleared');

      // Should have no pending requests
      expect(queue.getPendingKeys()).toHaveLength(0);
    });
  });
});
