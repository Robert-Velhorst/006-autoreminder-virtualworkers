/**
 * Redis Client Service
 *
 * Provides a shared Redis client with graceful degradation.
 * If REDIS_URL is not configured, all operations are no-ops and the app
 * falls back to the PostgreSQL-backed cache layer transparently.
 *
 * Usage:
 *   import { getRedis, isRedisAvailable } from './redis';
 *   const redis = getRedis();
 *   if (redis) { await redis.set('key', 'value', 'EX', 300); }
 */

import Redis from 'ioredis';

let _pubClient: Redis | null = null;
let _subClient: Redis | null = null;
let _initialized = false;

function createClient(url: string): Redis {
  const client = new Redis(url, {
    // Retry with exponential backoff, max 3 attempts
    retryStrategy: (times: number) => {
      if (times > 3) return null; // stop retrying, let it fail gracefully
      return Math.min(times * 200, 2000);
    },
    // Don't throw on connection failure — emit error event instead
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  client.on('connect', () => console.log('[Redis] Connected'));
  client.on('ready', () => console.log('[Redis] Ready'));
  client.on('error', (err: any) => console.warn('[Redis] Error (non-fatal):', err?.message || err));
  client.on('close', () => console.warn('[Redis] Connection closed'));
  client.on('reconnecting', () => console.log('[Redis] Reconnecting...'));

  return client;
}

/**
 * Initialize Redis connections. Called once at server startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initializeRedis(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[Redis] REDIS_URL not set — running without Redis (PostgreSQL cache fallback active)');
    return;
  }

  try {
    _pubClient = createClient(url);
    _subClient = createClient(url);

    // Attempt connection with a 2-second timeout guard — if Redis hangs, proceed without blocking
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    await Promise.race([
      Promise.all([
        _pubClient.connect().catch((err: any) => {
          console.warn('[Redis] Pub client failed to connect:', err.message);
          _pubClient = null;
        }),
        _subClient.connect().catch((err: any) => {
          console.warn('[Redis] Sub client failed to connect:', err.message);
          _subClient = null;
        }),
      ]),
      timeout,
    ]);

    if (_pubClient && _subClient) {
      console.log('[Redis] Both pub/sub clients connected successfully');
    }
  } catch (err: any) {
    console.warn('[Redis] Initialization failed (non-fatal):', err.message);
    _pubClient = null;
    _subClient = null;
  }
}

/**
 * Get the primary Redis client (for cache reads/writes).
 * Returns null if Redis is not configured or unavailable.
 */
export function getRedis(): Redis | null {
  return _pubClient;
}

/**
 * Get the pub client (for Socket.IO adapter).
 */
export function getRedisPubClient(): Redis | null {
  return _pubClient;
}

/**
 * Get the sub client (for Socket.IO adapter).
 */
export function getRedisSubClient(): Redis | null {
  return _subClient;
}

/**
 * Returns true if Redis is configured and connected.
 */
export function isRedisAvailable(): boolean {
  return _pubClient !== null && _pubClient.status === 'ready';
}

/**
 * Gracefully close Redis connections. Called during server shutdown.
 */
export async function closeRedis(): Promise<void> {
  const clients = [_pubClient, _subClient].filter(Boolean) as Redis[];
  await Promise.all(clients.map((c) => c.quit().catch(() => {})));
  _pubClient = null;
  _subClient = null;
  _initialized = false;
  console.log('[Redis] Connections closed');
}
