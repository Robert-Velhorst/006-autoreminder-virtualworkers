/**
 * Request Queue Service
 * Batches and deduplicates simultaneous API requests to reduce external API calls
 */

interface PendingRequest<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  executor: () => Promise<T>;
  timestamp: number;
  timeout: NodeJS.Timeout;
}

interface QueueMetrics {
  totalRequests: number;
  deduplicatedRequests: number;
  activeRequests: number;
  timeoutErrors: number;
  deduplicationRate: number;
}

class RequestQueue {
  private pendingRequests: Map<string, PendingRequest<any>> = new Map();
  private processingChain: Promise<void> = Promise.resolve();
  private metrics = {
    totalRequests: 0,
    deduplicatedRequests: 0,
    timeoutErrors: 0,
  };
  private readonly defaultTimeout = 60000; // 60 seconds
  private readonly maxPendingRequests: number;

  constructor(maxPendingRequests = Number(process.env.REQUEST_QUEUE_MAX_PENDING ?? 250)) {
    this.maxPendingRequests = Number.isFinite(maxPendingRequests)
      ? Math.max(1, Math.floor(maxPendingRequests))
      : 250;
  }

  /**
   * Execute a request with deduplication
   * If an identical request is already in progress, return the same promise
   */
  async execute<T>(
    key: string,
    executor: () => Promise<T>,
    timeoutMs: number = this.defaultTimeout
  ): Promise<T> {
    this.metrics.totalRequests++;

    // Check if identical request is already pending
    const existing = this.pendingRequests.get(key);
    if (existing) {
      this.metrics.deduplicatedRequests++;
      console.log(`[RequestQueue] Deduplicating request: ${key}`);
      return existing.promise;
    }

    if (this.pendingRequests.size >= this.maxPendingRequests) {
      throw new Error(`Request queue is at capacity (${this.maxPendingRequests} pending requests)`);
    }

    // Create new pending request
    let resolveFunc: (value: T) => void;
    let rejectFunc: (error: any) => void;

    const promise = new Promise<T>((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    // Set timeout
    const timeout = setTimeout(() => {
      this.metrics.timeoutErrors++;
      this.pendingRequests.delete(key);
      rejectFunc(new Error(`Request timeout after ${timeoutMs}ms: ${key}`));
    }, timeoutMs);

    const pending: PendingRequest<T> = {
      promise,
      resolve: resolveFunc!,
      reject: rejectFunc!,
      executor,
      timestamp: Date.now(),
      timeout,
    };

    this.pendingRequests.set(key, pending);

    console.log(`[RequestQueue] Executing new request: ${key}`);

    this.processingChain = this.processingChain
      .then(() => this.processPendingRequest(key))
      .catch(() => {
        // Shared promise handles the failure.
      });

    return pending.promise;
  }

  private async processPendingRequest(key: string): Promise<void> {
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      return;
    }

    try {
      const result = await pending.executor();

      if (!this.pendingRequests.has(key)) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(key);
      pending.resolve(result);
    } catch (error) {
      if (!this.pendingRequests.has(key)) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(key);
      pending.reject(error);
    }
  }

  /**
   * Get current queue metrics
   */
  getMetrics(): QueueMetrics {
    const deduplicationRate = this.metrics.totalRequests > 0
      ? (this.metrics.deduplicatedRequests / this.metrics.totalRequests) * 100
      : 0;

    return {
      totalRequests: this.metrics.totalRequests,
      deduplicatedRequests: this.metrics.deduplicatedRequests,
      activeRequests: this.pendingRequests.size,
      timeoutErrors: this.metrics.timeoutErrors,
      deduplicationRate,
    };
  }

  /**
   * Reset metrics (useful for testing)
   */
  resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      deduplicatedRequests: 0,
      timeoutErrors: 0,
    };
  }

  /**
   * Clear all pending requests (useful for cleanup)
   */
  clearAll(): void {
    this.pendingRequests.forEach((pending, key) => {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Queue cleared'));
    });
    this.pendingRequests.clear();
    this.processingChain = Promise.resolve();
  }

  /**
   * Get pending request keys (for debugging)
   */
  getPendingKeys(): string[] {
    return Array.from(this.pendingRequests.keys());
  }

  /**
   * Check if a request is pending
   */
  isPending(key: string): boolean {
    return this.pendingRequests.has(key);
  }

  /**
   * Get age of pending request in milliseconds
   */
  getPendingAge(key: string): number | null {
    const pending = this.pendingRequests.get(key);
    if (!pending) return null;
    return Date.now() - pending.timestamp;
  }
}

// Singleton instance
const requestQueue = new RequestQueue();

export { requestQueue, RequestQueue };
export type { QueueMetrics };
