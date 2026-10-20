/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse and DDoS attacks
 */

import { Request, Response, NextFunction } from 'express';
import { getRedis, isRedisAvailable } from '../services/redis';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

type RedisRateLimitClient = {
  eval(script: string, numberOfKeys: number, ...arguments_: string[]): Promise<unknown>;
};

export function getRateLimitIdentifier(input: {
  ip?: string;
  user?: { id?: number | string; openId?: string } | null;
}) {
  const localUserId = input.user?.id;
  if (typeof localUserId === "number" || (typeof localUserId === "string" && localUserId.trim())) {
    return `user:${localUserId}`;
  }
  const openId = input.user?.openId?.trim();
  if (openId) return `user:${openId}`;
  return `ip:${input.ip || "unknown"}`;
}

// In-memory fallback when Redis is not available
const memoryStore = new Map<string, RateLimitInfo>();

/**
 * Clean up expired entries from memory store
 */
function cleanupMemoryStore(): void {
  const now = Date.now();
  for (const [key, info] of Array.from(memoryStore.entries())) {
    if (info.resetTime < now) {
      memoryStore.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupMemoryStore, 5 * 60 * 1000).unref();

const REDIS_INCREMENT_WITH_EXPIRY = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return { count, redis.call('PTTL', KEYS[1]) }
`;

const REDIS_REFUND = `
  local count = redis.call('GET', KEYS[1])
  if not count then return 0 end
  if tonumber(count) > 0 then return redis.call('DECR', KEYS[1]) end
  return 0
`;

function toFiniteInteger(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

/**
 * Redis needs one atomic increment-plus-expiry operation. A GET followed by a
 * SET loses increments when parallel requests hit different Node processes.
 */
export async function consumeRedisRateLimit(
  redis: RedisRateLimitClient,
  key: string,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitInfo> {
  const result = await redis.eval(REDIS_INCREMENT_WITH_EXPIRY, 1, key, String(windowMs));
  if (!Array.isArray(result) || result.length < 2) throw new Error('Unexpected Redis rate-limit response');
  const count = toFiniteInteger(result[0], 1);
  const ttlMs = toFiniteInteger(result[1], windowMs) || windowMs;
  return { count, resetTime: now + ttlMs };
}

/**
 * Node's event loop is single-threaded, so incrementing the in-memory entry
 * synchronously keeps concurrent async middleware calls from overwriting it.
 */
export function consumeMemoryRateLimit(key: string, windowMs: number, now = Date.now()): RateLimitInfo {
  const existing = memoryStore.get(key);
  if (!existing || existing.resetTime < now) {
    const fresh = { count: 1, resetTime: now + windowMs };
    memoryStore.set(key, fresh);
    return { ...fresh };
  }
  existing.count += 1;
  return { ...existing };
}

async function consumeRateLimit(key: string, windowMs: number): Promise<RateLimitInfo> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      return await consumeRedisRateLimit(redis, key, windowMs);
    } catch (error) {
      console.error('[RateLimit] Redis error:', error);
    }
  }
  return consumeMemoryRateLimit(key, windowMs);
}

async function refundRateLimit(key: string): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.eval(REDIS_REFUND, 1, key);
      return;
    } catch (error) {
      console.error('[RateLimit] Redis error:', error);
    }
  }
  const existing = memoryStore.get(key);
  if (existing && existing.resetTime >= Date.now()) {
    existing.count = Math.max(0, existing.count - 1);
  }
}

/**
 * Create rate limiter middleware
 */
export function createRateLimiter(config: RateLimitConfig) {
  const {
    windowMs,
    maxRequests,
    message = 'Too many requests, please try again later',
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
  } = config;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Generate key based on IP and user ID (if authenticated)
      const identifier = getRateLimitIdentifier({
        user: (req as Request & { user?: { id?: number | string; openId?: string } | null }).user,
        ip: req.ip,
      });
      const key = `ratelimit:${req.path}:${identifier}`;
      
      const info = await consumeRateLimit(key, windowMs);
      const now = Date.now();

      // The counter includes this request, so the first request beyond the
      // budget is the one rejected.
      if (info.count > maxRequests) {
        const retryAfter = Math.ceil((info.resetTime - now) / 1000);
        
        res.setHeader('X-RateLimit-Limit', maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', info.resetTime.toString());
        res.setHeader('Retry-After', retryAfter.toString());
        
        res.status(429).json({
          error: message,
          retryAfter,
          limit: maxRequests,
          windowMs,
        });
        return;
      }
      
      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - info.count).toString());
      res.setHeader('X-RateLimit-Reset', info.resetTime.toString());
      
      // Handle skip options
      if (skipSuccessfulRequests || skipFailedRequests) {
        const originalSend = res.send;
        res.send = function (body: any): Response {
          const statusCode = res.statusCode;
          const shouldSkip =
            (skipSuccessfulRequests && statusCode < 400) ||
            (skipFailedRequests && statusCode >= 400);
          
          if (shouldSkip) {
            void refundRateLimit(key);
          }
          
          return originalSend.call(this, body);
        };
      }
      
      next();
    } catch (error) {
      console.error('[RateLimit] Error:', error);
      // On error, allow the request through
      next();
    }
  };
}

/**
 * Preset rate limiters for common use cases
 */

// Strict rate limit for authentication endpoints
export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5, // 5 attempts per 15 minutes
  message: 'Too many authentication attempts, please try again later',
  skipSuccessfulRequests: true,
});

const ANONYMOUS_AUTH_READ_PROBE_PATHS = new Set([
  "/owner-bootstrap/status",
  "/trello/client-key",
]);

/**
 * The login form performs these two public, read-only checks on every render.
 * They do not attempt authentication and must not exhaust the five-attempt
 * authentication budget that protects the POST endpoints.
 */
export function isAnonymousAuthReadProbe(method: string, path: string) {
  return method.toUpperCase() === "GET" && ANONYMOUS_AUTH_READ_PROBE_PATHS.has(path);
}

export function authRateLimiterWithReadProbeBypass(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (isAnonymousAuthReadProbe(req.method, req.path)) return next();
  return authRateLimiter(req, res, next);
}

// Standard rate limit for API endpoints
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60, // 60 requests per minute
  message: 'Too many requests, please slow down',
});

/**
 * auth.me is a public, read-only session check used to decide whether the
 * login screen or an authenticated portal should render. It must not consume
 * the shared anonymous API budget, otherwise a page refresh burst can make
 * the login page itself report a spurious rate-limit error.
 */
export function isAnonymousSessionProbe(method: string, path: string, user: unknown): boolean {
  return method.toUpperCase() === "GET" && path === "/trpc/auth.me" && !user;
}

/**
 * Public login-screen reads are mounted below the global /api limiter as well
 * as the stricter /api/auth limiter. Keep both limiters from charging those
 * idempotent probes while preserving the budget for actual auth attempts.
 */
export function isAnonymousApiReadProbe(method: string, path: string, user: unknown): boolean {
  if (isAnonymousSessionProbe(method, path, user)) return true;
  if (user) return false;

  const authScopedPath = path.startsWith("/auth/") ? path.slice("/auth".length) : path;
  return isAnonymousAuthReadProbe(method, authScopedPath);
}

export function apiRateLimiterWithAnonymousSessionProbeBypass(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (isAnonymousApiReadProbe(req.method, req.path, (req as Request & { user?: unknown }).user)) {
    return next();
  }
  return apiRateLimiter(req, res, next);
}

// Strict rate limit for expensive operations
export const expensiveOperationRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // 10 requests per minute
  message: 'Too many expensive operations, please wait before retrying',
});

// Lenient rate limit for read operations
export const readRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 120, // 120 requests per minute
  message: 'Too many requests, please slow down',
  skipFailedRequests: true,
});

// Very strict rate limit for APTLSS generation
export const aptlssRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 5, // 5 generations per minute
  message: 'Too many APTLSS generation requests, please wait before retrying',
});

export function isAptlssExpensiveRequest(method: string, path: string) {
  return method.toUpperCase() !== 'GET' && path.startsWith('/aptlss/');
}

export const aptlssGenerationRateLimiter = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!isAptlssExpensiveRequest(req.method, req.path)) return next();
  return aptlssRateLimiter(req, res, next);
};

// Strict rate limit for ATIS analysis
export const atisRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 3, // 3 analyses per minute
  message: 'Too many ATIS analysis requests, please wait before retrying',
});
