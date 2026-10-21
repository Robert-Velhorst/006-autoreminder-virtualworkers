import type { Express, RequestHandler } from 'express';
import healthRoutes from '../routes/health';
import { getPendingRequestQueueCap } from './requestQueueCapacity';

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function createRequestAdmissionLimiter(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const maxConcurrent = positiveInteger(env.MAX_CONCURRENT_REQUESTS, 100, 10_000);
  const timeoutMs = positiveInteger(env.REQUEST_QUEUE_TIMEOUT_MS, 30_000, 300_000);
  const maxPending = getPendingRequestQueueCap(env);
  let active = 0;
  let draining = false;
  const waiting = new Set<() => void>();

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (active < maxConcurrent && waiting.size) {
        const grant = waiting.values().next().value!;
        waiting.delete(grant);
        grant();
      }
    } finally { draining = false; }
  }

  return (req, res, next) => {
    let state: 'waiting' | 'active' | 'settled' = 'waiting';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnected = () => req.aborted || res.destroyed || res.writableEnded;
    const cleanup = () => {
      clearTimeout(timer);
      waiting.delete(grant);
      req.removeListener('aborted', settle);
      res.removeListener('close', settle);
      res.removeListener('finish', settle);
    };
    function settle() {
      if (state === 'settled') return;
      const heldSlot = state === 'active';
      state = 'settled';
      cleanup();
      if (heldSlot) active--;
      drain();
    }
    function grant() {
      if (state !== 'waiting') return;
      if (disconnected()) { settle(); return; }
      clearTimeout(timer);
      state = 'active';
      active++;
      // Lifecycle listeners are installed before acquisition, including direct grants.
      if (disconnected()) { settle(); return; }
      try { next(); } catch (error) { settle(); throw error; }
    }
    function refuse() {
      if (state !== 'waiting') return;
      const closed = disconnected();
      settle();
      if (closed) return;
      const retryAfter = Math.ceil(timeoutMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(503).json({ error: 'Server busy - please retry in a moment', retryAfter });
    }

    req.once('aborted', settle);
    res.once('close', settle);
    res.once('finish', settle);
    if (disconnected()) { settle(); return; }
    if (active < maxConcurrent && waiting.size === 0) { grant(); return; }
    if (waiting.size >= maxPending) { refuse(); return; }
    waiting.add(grant);
    timer = setTimeout(refuse, timeoutMs);
    timer.unref?.();
  };
}

/** This same mounting order is exercised by composed HTTP saturation tests. */
export function configureRequestAdmission(app: Express, env: NodeJS.ProcessEnv = process.env) {
  app.use('/api/health', healthRoutes);
  app.use('/readyz', healthRoutes);
  app.use(createRequestAdmissionLimiter(env));
}
