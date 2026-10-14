import "./envBootstrap";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import localAuthRoutes from "../routes/local-auth.js";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { sdk } from "./sdk";
import { serveStatic } from "./static";
import aptlssRoutes from "../routes/aptlss.js";
import workingHoursRoutes from "../routes/working-hours.js";
import holidaysRoutes from "../routes/holidays.js";
import rescheduleRoutes from "../routes/reschedule.js";
import cacheRoutes from "../routes/cache.js";
import queueRoutes from "../routes/queue.js";
import metricsRoutes from "../routes/metrics.js";
import vaManagementRoutes from "../routes/va-management.js";
import atisRoutes from "../routes/atis.js";
import notificationPreferencesRoutes from "../routes/notification-preferences.js";
import notificationHistoryRoutes from "../routes/notification-history.js";
import timeTrackingRoutes from "../routes/time-tracking.js";
import trelloWebhookRoutes from "../routes/trello-webhook.js";
import trelloWebhookBulkRoutes from "../routes/trello-webhook-bulk.js";
import trelloConfigRoutes from "../routes/trello-config.js";
import trelloBoardsRoutes from "../routes/trello-boards.js";
import handoffRoutes from "../routes/handoff.js";
import communicationRoutes from "../routes/communication.js";
import analyticsRoutes from "../routes/analytics.js";
import reportsRoutes from "../routes/reports.js";
import interviewEnhancedRoutes from "../routes/interview-enhanced.js";
import performanceOptimizationRoutes from "../routes/performance-optimization.js";
import advancedSchedulingRoutes from "../routes/advanced-scheduling.js";
import atisPhasesRoutes from "../routes/atis-phases.js";
import batchOperationsRoutes from "../routes/batch-operations.js";
import healthRoutes from "../routes/health.js";
import { websocketService } from "../services/websocket.js";
import {
  getRequestBodyLimit,
  securityHeaders,
} from "../middleware/security.js";
import {
  warmUpCache,
  scheduleCacheRefresh,
} from "../services/cache-warming.js";
import { initializeRedis, closeRedis } from "../services/redis.js";
import { startBriefingScheduler } from "../services/briefing-scheduler.js";
import { startManusScheduler } from "../services/manus-scheduler.js";
import {
  apiRateLimiter,
  authRateLimiter,
  aptlssGenerationRateLimiter,
} from "../middleware/rate-limiter.js";
import { log } from "../utils/logger.js";
import { registerBrowserTabRoutes } from "../browserTabRoutes.js";
import { assertLocalAuthBypassConfiguration } from "./localAuthBypass.js";
import { assertProductionConfiguration } from "./productionConfig.js";
import { isDatabaseReachable } from "../db.js";

const apiIpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
});

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

// ---------------------------------------------------------------------------
// Concurrency limiter — replaces the old hard-503 approach.
//
// Instead of immediately rejecting requests over MAX_CONNECTIONS, we queue
// them and process them as slots free up.  Requests that wait longer than
// QUEUE_TIMEOUT_MS are rejected with 503 so the queue never grows unbounded.
// ---------------------------------------------------------------------------
function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

const MAX_CONCURRENT = positiveInteger(
  process.env.MAX_CONCURRENT_REQUESTS,
  100,
  10_000
);
const QUEUE_TIMEOUT_MS = positiveInteger(
  process.env.REQUEST_QUEUE_TIMEOUT_MS,
  30_000,
  300_000
);

let activeRequests = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++;
      resolve();
      return;
    }

    // Queue the request with a timeout guard
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = waitQueue.indexOf(tryAcquire);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error("Request queue timeout"));
    }, QUEUE_TIMEOUT_MS);

    const tryAcquire = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeRequests++;
      resolve();
    };

    waitQueue.push(tryAcquire);
  });
}

function releaseSlot(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waitQueue.shift();
  if (next) next();
}

function concurrencyLimiter(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  acquireSlot()
    .then(() => {
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        releaseSlot();
      };
      res.once("finish", releaseOnce);
      res.once("close", releaseOnce);
      next();
    })
    .catch(() => {
      console.warn(
        `[Server] Request queue full (${waitQueue.length} waiting, ${activeRequests} active)`
      );
      res.status(503).json({
        error: "Server busy — please retry in a moment",
        retryAfter: Math.ceil(QUEUE_TIMEOUT_MS / 1000),
      });
    });
}

async function startServer() {
  assertProductionConfiguration();
  assertLocalAuthBypassConfiguration();
  if (process.env.NODE_ENV === "production" && !(await isDatabaseReachable())) {
    throw new Error("PostgreSQL connectivity check failed during startup");
  }
  const app = express();
  app.set("trust proxy", 1);
  const server = createServer(app);

  app.use(securityHeaders);

  // Concurrency limiter — queues excess requests instead of hard-rejecting them
  app.use(concurrencyLimiter);

  const requestBodyLimit = getRequestBodyLimit();
  app.use(express.json({ limit: requestBodyLimit }));
  app.use(express.urlencoded({ limit: requestBodyLimit, extended: true }));

  // Health probes must remain public and must not consume the UI/API rate budget.
  app.use("/api/health", healthRoutes);

  // Bound authentication work before credentials are resolved.
  app.use("/api", apiIpRateLimiter);

  // Authentication middleware for all /api routes
  app.use("/api", async (req: any, res, next) => {
    try {
      req.user = await sdk.authenticateRequest(req);
    } catch (error) {
      // Authentication is optional, continue without user
      req.user = null;
    }
    next();
  });

  // Authenticated users receive independent API budgets even behind one proxy.
  app.use("/api", apiRateLimiter);

  // OAuth callback under /api/oauth/callback (Manus OAuth - kept for compatibility)
  registerOAuthRoutes(app);
  // Browser-extension collector uses its own scoped bearer token.
  registerBrowserTabRoutes(app);
  // Local auth routes (username/password login - works without Manus) with strict rate limiting
  app.use("/api/auth", authRateLimiter, localAuthRoutes);
  // Only APTLSS mutations are generation-limited; reads and unrelated APIs
  // must not share the five-per-minute generation budget.
  app.use("/api", aptlssGenerationRateLimiter, aptlssRoutes);
  // Working Hours Settings API
  app.use("/api/working-hours", workingHoursRoutes);
  // VA Management API
  app.use("/api/va", vaManagementRoutes);
  // Holidays API
  app.use("/api/holidays", holidaysRoutes);
  // Reschedule API
  app.use("/api/reschedule", rescheduleRoutes);
  // Cache Management API
  app.use("/api", cacheRoutes);
  // Queue Metrics API
  app.use("/api", queueRoutes);
  // Performance Metrics API
  app.use("/api", metricsRoutes);
  // ATIS (Adaptive Task Intelligence System) API with strict rate limiting
  app.use("/api/atis", apiRateLimiter, atisRoutes);
  // Notification Preferences API
  app.use("/api/notification-preferences", notificationPreferencesRoutes);
  // Notification History API
  app.use("/api/notifications", notificationHistoryRoutes);
  // Time Tracking API
  app.use("/api", timeTrackingRoutes);
  // Trello Bulk Webhook API — MUST be mounted before the base trello-webhook
  // router, otherwise Express matches /api/trello-webhook/bulk against the
  // base router first and the bulk route is never reached.
  app.use("/api/trello-webhook/bulk", trelloWebhookBulkRoutes);
  // Trello Webhook API (for chatbot)
  app.use("/api/trello-webhook", trelloWebhookRoutes);
  // Chatbot API (alias for trello-webhook)
  app.use("/api/chatbot", trelloWebhookRoutes);
  // Trello Configuration API
  app.use("/api/trello", trelloConfigRoutes);
  // Trello Boards API (for board selector)
  app.use("/api/trello-boards", trelloBoardsRoutes);
  app.use("/api/handoff", handoffRoutes);
  app.use("/api/communication", communicationRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/reports", reportsRoutes);
  // Enhanced Interview System API
  app.use("/api/interview", interviewEnhancedRoutes);
  // Performance Optimization API
  app.use("/api/performance", performanceOptimizationRoutes);
  // Advanced Scheduling API
  app.use("/api/scheduling", advancedSchedulingRoutes);
  // ATIS Phases 3-10 API
  app.use("/api/atis/phases", atisPhasesRoutes);
  // Batch Operations API
  app.use("/api/batch-operations", batchOperationsRoutes);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // Add 404 handler for unmatched API routes before Vite middleware
  app.use("/api", (req, res) => {
    console.log(
      `[Server] 404 - Unmatched API route: ${req.method} ${req.path}`
    );
    res.status(404).json({ error: "API endpoint not found", path: req.path });
  });

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite.js");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Initialize Redis (must happen before WebSocket so the adapter can be attached)
  await initializeRedis();

  // Initialize WebSocket server
  websocketService.initialize(server);

  // Warm up cache on startup
  try {
    await warmUpCache();
    log.info("Cache warming completed");
    // Schedule periodic cache refresh every 60 minutes
    scheduleCacheRefresh(60);
    log.info("Periodic cache refresh scheduled");
    // Start automated schedulers
    startBriefingScheduler();
    startManusScheduler();
  } catch (error) {
    log.error("Cache warming failed", error as Error);
  }

  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, async () => {
    log.info(`Server running on http://${host}:${port}/`, {
      port,
      host,
      environment: process.env.NODE_ENV,
    });
  });

  // Graceful shutdown handling
  const gracefulShutdown = async () => {
    log.info("Shutting down gracefully...");

    // Close WebSocket connections
    const io = websocketService.getIO();
    if (io) {
      io.close();
      log.info("WebSocket server closed");
    }

    // Close Redis connections
    await closeRedis();

    // Close HTTP server
    server.close(() => {
      log.info("HTTP server closed");
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      log.fatal("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  // Handle uncaught exceptions
  process.on("uncaughtException", error => {
    log.fatal("Uncaught exception", error);
    gracefulShutdown();
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason, promise) => {
    log.error("Unhandled rejection", reason as Error, {
      promise: String(promise),
    });
  });
}

startServer().catch(error => {
  log.fatal("Failed to start server", error);
  process.exit(1);
});
