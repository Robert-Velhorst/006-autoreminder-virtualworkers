/**
 * Retry utility with exponential backoff for handling transient failures
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: any, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000, // 1 second
  maxDelayMs: 30000, // 30 seconds
  backoffMultiplier: 2,
  retryableStatuses: [429, 500, 502, 503, 504], // Rate limit + server errors
  onRetry: () => {},
};

const ALLOWED_OUTBOUND_ORIGINS = new Map([
  ['api.trello.com', 'https://api.trello.com'],
  ['trello.com', 'https://trello.com'],
  ['www.trello.com', 'https://www.trello.com'],
  ['attachments.trello.com', 'https://attachments.trello.com'],
  ['trello-attachments.s3.amazonaws.com', 'https://trello-attachments.s3.amazonaws.com'],
  ['chat.openai.com', 'https://chat.openai.com'],
  ['chatgpt.com', 'https://chatgpt.com'],
  ['g.co', 'https://g.co'],
  ['gemini.google.com', 'https://gemini.google.com'],
  ['claude.ai', 'https://claude.ai'],
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const ALLOWED_CROSS_ORIGIN_REDIRECTS = new Set([
  'https://g.co>https://gemini.google.com',
  'https://chat.openai.com>https://chatgpt.com',
  'https://attachments.trello.com>https://trello-attachments.s3.amazonaws.com',
]);

class UnsafeOutboundUrlError extends Error {}

function hasAllowedOutboundPath(hostname: string, pathname: string): boolean {
  if (
    hostname === 'api.trello.com' ||
    hostname === 'trello.com' ||
    hostname === 'www.trello.com' ||
    hostname === 'attachments.trello.com' ||
    hostname === 'trello-attachments.s3.amazonaws.com'
  ) {
    // Trello endpoints and attachment object paths vary by resource. Their
    // origin remains fixed to the server-owned allowlist below.
    return true;
  }
  if (hostname === 'chat.openai.com' || hostname === 'chatgpt.com' || hostname === 'claude.ai') {
    return /^\/share\/[A-Za-z0-9_-]+\/?$/.test(pathname);
  }
  if (hostname === 'g.co') {
    return /^\/gemini\/share\/[A-Za-z0-9_-]+\/?$/.test(pathname);
  }
  if (hostname === 'gemini.google.com') {
    return /^\/share\/[A-Za-z0-9_-]+\/?$/.test(pathname);
  }
  return false;
}

function parseAllowedOutboundUrl(input: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new UnsafeOutboundUrlError('Outbound URL is invalid');
  }

  const approvedOrigin = ALLOWED_OUTBOUND_ORIGINS.get(parsed.hostname);
  if (
    parsed.protocol !== 'https:' ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !approvedOrigin ||
    !hasAllowedOutboundPath(parsed.hostname, parsed.pathname)
  ) {
    throw new UnsafeOutboundUrlError('Outbound URL host is not allowed');
  }

  // Rebuild the request from a server-owned origin. User-controlled URL text
  // can select an approved destination, but cannot supply the fetch hostname.
  const safeUrl = new URL(approvedOrigin);
  safeUrl.pathname = parsed.pathname;
  safeUrl.search = parsed.search;
  return safeUrl;
}

async function fetchAllowedOutboundUrl(url: string, init?: RequestInit): Promise<Response> {
  let currentUrl = parseAllowedOutboundUrl(url);
  let currentInit: RequestInit = { ...init, redirect: 'manual' };

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await fetch(currentUrl, currentInit);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw new UnsafeOutboundUrlError('Outbound request exceeded the redirect limit');
    }

    const nextUrl = parseAllowedOutboundUrl(new URL(location, currentUrl));
    if (nextUrl.origin !== currentUrl.origin) {
      const redirectPair = `${currentUrl.origin}>${nextUrl.origin}`;
      if (!ALLOWED_CROSS_ORIGIN_REDIRECTS.has(redirectPair)) {
        throw new UnsafeOutboundUrlError('Outbound redirect destination is not allowed');
      }

      const method = (currentInit.method || 'GET').toUpperCase();
      if ((method !== 'GET' && method !== 'HEAD') || currentInit.body !== undefined) {
        throw new UnsafeOutboundUrlError('Outbound request cannot redirect across origins');
      }

      // Never carry arbitrary caller headers or the source URL's credentials
      // to another origin. The S3 destination may need its own signed query.
      const safeHeaders = new Headers();
      const requestHeaders = new Headers(currentInit.headers);
      for (const name of ['accept', 'accept-language', 'user-agent']) {
        const value = requestHeaders.get(name);
        if (value !== null) safeHeaders.set(name, value);
      }
      const sourceUrl = currentUrl;
      const sourceCredentialValues = new Set(
        Array.from(sourceUrl.searchParams)
          .filter(([name]) => /^(key|token|api[_-]?key|access[_-]?token)$/i.test(name))
          .map(([, value]) => value),
      );
      let decodedPathname = nextUrl.pathname;
      try {
        decodedPathname = decodeURIComponent(decodedPathname);
      } catch {
        throw new UnsafeOutboundUrlError('Outbound redirect path is invalid');
      }
      if (Array.from(sourceCredentialValues).some((value) => value !== '' && decodedPathname.includes(value))) {
        throw new UnsafeOutboundUrlError('Outbound redirect reflected a credential');
      }
      for (const [nextName, nextValue] of Array.from(nextUrl.searchParams)) {
        if (
          /^(key|token|api[_-]?key|access[_-]?token)$/i.test(nextName) ||
          sourceCredentialValues.has(nextValue)
        ) {
          nextUrl.searchParams.delete(nextName);
        }
      }
      currentInit = { ...currentInit, headers: safeHeaders };
    }

    currentUrl = nextUrl;
    const method = (currentInit.method || 'GET').toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      const headers = new Headers(currentInit.headers);
      headers.delete('content-length');
      headers.delete('content-type');
      currentInit = { ...currentInit, method: 'GET', body: undefined, headers };
    }
  }
}

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
  parseAllowedOutboundUrl(url);
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetchAllowedOutboundUrl(url, init);

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
      if (error instanceof UnsafeOutboundUrlError) {
        throw error;
      }
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
