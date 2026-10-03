/**
 * Redis Client Service
 *
 * Provides a shared Redis client with graceful degradation.
 * If REDIS_URL is not configured, all operations are no-ops and the app
 * falls back to the MySQL-backed cache layer transparently.
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

function createClient(url: string, subscriptionsOnly = false): Redis {
  const client = new Redis(url, {
    // Recover after sustained outages without queuing application commands.
    retryStrategy: (times: number) => {
      return Math.min(times * 200, 2000);
    },
    // Don't throw on connection failure — emit error event instead
    lazyConnect: true,
    // Only the dedicated Socket.IO subscriber retains its fixed channel
    // subscriptions. Cache reads and published application events never queue.
    enableOfflineQueue: subscriptionsOnly,
    maxRetriesPerRequest: subscriptionsOnly ? null : 1,
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
    console.log('[Redis] REDIS_URL not set — running without Redis (MySQL cache fallback active)');
    return;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const pubClient = _pubClient = createClient(url);
    const subClient = _subClient = createClient(url, true);

    // Attempt connection with a 2-second timeout guard — if Redis hangs, proceed without blocking
    const timeout = new Promise(resolve => { timeoutHandle = setTimeout(resolve, 2000); });
    await Promise.race([
      Promise.all([
        pubClient.connect().catch(() => {
          console.warn('[Redis] Pub client is reconnecting after initial connection failure');
        }),
        subClient.connect().catch(() => {
          console.warn('[Redis] Sub client is reconnecting after initial connection failure');
        }),
      ]),
      timeout,
    ]);

    if (_pubClient === pubClient && _subClient === subClient && isRedisAvailable()) {
      console.log('[Redis] Both pub/sub clients connected successfully');
    }
  } catch {
    console.warn('[Redis] Initialization failed (non-fatal)');
    _pubClient?.disconnect();
    _subClient?.disconnect();
    _pubClient = null;
    _subClient = null;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
 * Returns true only when both realtime Redis connections are ready.
 */
export function isRedisAvailable(): boolean {
  return _pubClient?.status === 'ready' && _subClient?.status === 'ready';
}

/**
 * Gracefully close Redis connections. Called during server shutdown.
 */
export async function closeRedis(): Promise<void> {
  const clients = [_pubClient, _subClient].filter(Boolean) as Redis[];
  _pubClient = null;
  _subClient = null;
  _initialized = false;
  await Promise.all(clients.map(async client => {
    if (client.status !== 'ready') {
      client.disconnect();
      return;
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.quit(),
        new Promise(resolve => { timeoutHandle = setTimeout(resolve, 2000); }),
      ]);
    } catch { /* A broken connection must not prevent shutdown. */ }
    finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      client.disconnect();
    }
  }));
  console.log('[Redis] Connections closed');
}
