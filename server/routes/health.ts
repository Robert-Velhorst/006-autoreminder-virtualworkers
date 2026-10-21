/**
 * Health Check Endpoint
 * Used by Docker healthcheck and monitoring systems
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { isDatabaseReachable } from "../db";
import { isRedisAvailable } from "../services/redis";

export const HEALTH_PROBE_TIMEOUT_MS = 2_500;

export function createBoundedHealthProbe(
  probe: () => Promise<boolean>,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS
): () => Promise<boolean> {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > HEALTH_PROBE_TIMEOUT_MS
  ) {
    throw new Error("Health probe timeout must be positive and at most 2500ms");
  }
  let pending: Promise<boolean> | null = null;

  return () => {
    if (pending) return pending;
    let resolve!: (healthy: boolean) => void;
    let reject!: (error: unknown) => void;
    let settled = false;
    const result = new Promise<boolean>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    pending = result;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref();

    // Timing out does not cancel the driver. Retain the shared failed result
    // until that call settles, rather than accumulating more pending queries.
    void Promise.resolve()
      .then(probe)
      .then(
        healthy => {
          clearTimeout(timer);
          pending = null;
          if (!settled) {
            settled = true;
            resolve(healthy === true);
          }
        },
        error => {
          clearTimeout(timer);
          pending = null;
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      );
    return result;
  };
}

export function createHealthRouter(
  options: {
    databaseProbe?: () => Promise<boolean>;
    timeoutMs?: number;
  } = {}
) {
  const router = Router();
  const databaseReachable = createBoundedHealthProbe(
    options.databaseProbe ?? (() => isDatabaseReachable()),
    options.timeoutMs
  );

  /**
   * GET /api/health
   * Basic health check
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const dbHealthy = await databaseReachable();

      // Check Redis connection (optional)
      const redisConfigured = Boolean(process.env.REDIS_URL?.trim());
      const redisHealthy = isRedisAvailable();
      const healthy = dbHealthy && (!redisConfigured || redisHealthy);

      const health = {
        status: healthy ? "healthy" : "unhealthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: dbHealthy ? "connected" : "disconnected",
        redis: !redisConfigured
          ? "not configured"
          : redisHealthy
            ? "connected"
            : "disconnected",
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          unit: "MB",
        },
      };

      const statusCode = healthy ? 200 : 503;
      res.status(statusCode).json(health);
    } catch {
      // Driver errors can include connection credentials and query data.
      console.error("[Health] Health check failed");
      res.status(503).json({
        status: "unhealthy",
        error: "Health check failed",
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * GET /api/health/ready
   * Readiness check (for Kubernetes)
   */
  router.get("/ready", async (req: Request, res: Response) => {
    try {
      if (!(await databaseReachable())) {
        return res.status(503).json({
          ready: false,
          reason: "Database not available",
        });
      }

      if (process.env.REDIS_URL?.trim() && !isRedisAvailable()) {
        return res.status(503).json({
          ready: false,
          reason: "Redis is configured but not connected",
        });
      }

      res.json({
        ready: true,
        timestamp: new Date().toISOString(),
      });
    } catch {
      console.error("[Health] Readiness check failed");
      res.status(503).json({
        ready: false,
        reason: "Readiness check failed",
      });
    }
  });

  /**
   * GET /api/health/live
   * Liveness check (for Kubernetes)
   */
  router.get("/live", (req: Request, res: Response) => {
    res.json({
      alive: true,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

export default createHealthRouter();
