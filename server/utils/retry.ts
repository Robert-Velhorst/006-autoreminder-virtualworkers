/**
 * Retry utility with exponential backoff for handling transient failures
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableStatuses?: number[];
  timeoutMs?: number;
  onRetry?: (attempt: number, error: any, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000, // 1 second
  maxDelayMs: 30000, // 30 seconds
  backoffMultiplier: 2,
  retryableStatuses: [429, 500, 502, 503, 504], // Rate limit + server errors
  timeoutMs: 15_000,
  onRetry: () => {},
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  multiplier: number
): number {
  // Exponential backoff: delay = initialDelay * (multiplier ^ attempt)
  const exponentialDelay = initialDelay * Math.pow(multiplier, attempt);
  
  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  
  // Add jitter (random ±25%) to prevent thundering herd
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  
  return Math.floor(cappedDelay + jitter);
}

/**
 * Retry a fetch request with exponential backoff
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Create a fresh timeout for each attempt. A caller-provided signal keeps
      // its existing cancellation semantics.
      const requestInit = init?.signal
        ? init
        : { ...init, signal: AbortSignal.timeout(opts.timeoutMs) };
      const response = await fetch(url, requestInit);

      // If response is successful or non-retryable error, return immediately
      if (response.ok || !opts.retryableStatuses.includes(response.status)) {
        return response;
      }

      // Clone response to read body without consuming it
      const clonedResponse = response.clone();
      let errorMessage = `HTTP ${response.status}`;
      
      try {
        const errorBody = await clonedResponse.text();
        errorMessage = errorBody || errorMessage;
      } catch {
        // Ignore errors reading body
      }

      lastError = new Error(errorMessage);
      lastError.status = response.status;

      // Don't retry on last attempt
      if (attempt === opts.maxRetries) {
        return response;
      }

      // Calculate delay and wait before retry
      const delayMs = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier
      );

      opts.onRetry(attempt + 1, lastError, delayMs);
      await sleep(delayMs);

    } catch (error: any) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === opts.maxRetries) {
        throw error;
      }

      // Calculate delay and wait before retry
      const delayMs = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier
      );

      opts.onRetry(attempt + 1, error, delayMs);
      await sleep(delayMs);
    }
  }

  // Should never reach here, but throw last error just in case
  throw lastError;
}

/**
 * Retry any async function with exponential backoff
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options?: Omit<RetryOptions, 'retryableStatuses'>
): Promise<T> {
  const operation = (async () => {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: any;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;

        // Don't retry on last attempt
        if (attempt === opts.maxRetries) {
          throw error;
        }

        // Calculate delay and wait before retry
        const delayMs = calculateDelay(
          attempt,
          opts.initialDelayMs,
          opts.maxDelayMs,
          opts.backoffMultiplier
        );

        opts.onRetry(attempt + 1, error, delayMs);
        await sleep(delayMs);
      }
    }

    throw lastError;
  })();

  operation.catch(() => {});
  return operation;
}
