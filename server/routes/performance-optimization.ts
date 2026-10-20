/**
 * Performance Optimization Route
 * 
 * Endpoints for cache warming, performance monitoring, and optimization controls.
 */

import { Router, Request, Response } from 'express';
import { warmUpCache, getCacheWarmingStats } from '../services/cache-warming';
import { getCacheStats } from '../services/trello-cache';
import { requestQueue } from '../services/request-queue';
import { websocketService } from '../services/websocket';
import { requireAdmin } from '../middleware/auth';
import { normalizeCacheRefreshInterval } from '../operational-control-validation';
import { updateMaintenanceSetting } from '../maintenanceCenter';

const router = Router();
router.use(requireAdmin);

/**
 * POST /api/performance/cache-warm
 * Manually trigger cache warming
 */
router.post('/cache-warm', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    console.log('[Performance] Cache warming initiated by', user.email);
    const stats = await warmUpCache();

    return res.json({
      success: true,
      message: 'Cache warming completed',
      stats,
    });
  } catch (error) {
    console.error('[Performance] Error during cache warming:', error);
    return res.status(500).json({ error: 'Cache warming failed' });
  }
});

/**
 * GET /api/performance/cache-stats
 * Get cache warming statistics
 */
router.get('/cache-stats', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const stats = await getCacheWarmingStats();
    return res.json(stats);
  } catch (error) {
    console.error('[Performance] Error fetching cache stats:', error);
    return res.status(500).json({ error: 'Failed to fetch cache statistics' });
  }
});

/**
 * GET /api/performance/metrics
 * Get comprehensive performance metrics
 */
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get cache statistics
    const cacheStatsArray = await getCacheStats(user.id, user.openId);
    const cacheStats = cacheStatsArray.reduce(
      (acc, stat) => ({
        hits: acc.hits + stat.hitCount,
        misses: acc.misses + stat.missCount,
        totalRequests: acc.totalRequests + stat.hitCount + stat.missCount,
        lastUpdated: stat.lastFetched?.toISOString() || acc.lastUpdated,
      }),
      { hits: 0, misses: 0, totalRequests: 0, lastUpdated: new Date().toISOString() }
    );

    // Get queue statistics
    const queueMetrics = requestQueue.getMetrics();

    // Get WebSocket statistics
    const wsConnectedClients = websocketService.getConnectedClientsCount();
    const wsUserClients = websocketService.getUserClientsCount(user.openId);
    const wsConnectedUsers = websocketService.getConnectedUsers();

    // Calculate derived metrics
    const cacheHitRate = cacheStats.totalRequests > 0
      ? (cacheStats.hits / cacheStats.totalRequests) * 100
      : 0;

    const queueDeduplicationRate = queueMetrics.deduplicationRate;

    // Estimate API calls saved
    const apiCallsSaved = cacheStats.hits + queueMetrics.deduplicatedRequests;
    const observedRequests = cacheStats.totalRequests + queueMetrics.totalRequests;
    const apiCallReduction = observedRequests > 0
      ? (apiCallsSaved / observedRequests) * 100
      : 0;

    // Response time improvements (estimated)
    const avgCacheHitTime = 50; // ms
    const avgApiCallTime = 3000; // ms
    const timeSaved = cacheStats.hits * (avgApiCallTime - avgCacheHitTime);

    const metrics = {
      cache: {
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        totalRequests: cacheStats.totalRequests,
        hitRate: Math.round(cacheHitRate * 10) / 10,
        lastUpdated: cacheStats.lastUpdated,
      },
      queue: {
        totalRequests: queueMetrics.totalRequests,
        uniqueRequests: queueMetrics.totalRequests - queueMetrics.deduplicatedRequests,
        deduplicatedRequests: queueMetrics.deduplicatedRequests,
        deduplicationRate: Math.round(queueDeduplicationRate * 10) / 10,
        activeRequests: queueMetrics.activeRequests,
      },
      websocket: {
        connected: wsConnectedClients > 0,
        totalClients: wsConnectedClients,
        userClients: wsUserClients,
        totalUsers: wsConnectedUsers.length,
        status: wsConnectedClients > 0 ? 'healthy' : 'disconnected',
      },
      optimization: {
        apiCallsSaved,
        apiCallReduction: Math.round(apiCallReduction * 10) / 10,
        timeSavedMs: Math.round(timeSaved),
        timeSavedHours: Math.round((timeSaved / (1000 * 60 * 60)) * 100) / 100,
      },
    };

    return res.json(metrics);
  } catch (error) {
    console.error('[Performance] Error fetching metrics:', error);
    return res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

/**
 * POST /api/performance/cache-refresh-schedule
 * Schedule periodic cache refresh
 */
router.post('/cache-refresh-schedule', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const interval = normalizeCacheRefreshInterval(req.body?.intervalMinutes);
    if (!interval.ok) return res.status(400).json({ error: interval.error });
    const intervalMinutes = interval.value;

    console.log('[Performance] Saving cache refresh every', intervalMinutes, 'minutes');
    await updateMaintenanceSetting("database_preload", true, intervalMinutes);

    return res.json({
      success: true,
      message: `Cache refresh saved every ${intervalMinutes} minutes`,
    });
  } catch (error) {
    console.error('[Performance] Error scheduling cache refresh:', error);
    return res.status(500).json({ error: 'Failed to schedule cache refresh' });
  }
});

/**
 * GET /api/performance/queue-status
 * Get request queue status
 */
router.get('/queue-status', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const metrics = requestQueue.getMetrics();
    return res.json({
      totalRequests: metrics.totalRequests,
      activeRequests: metrics.activeRequests,
      deduplicatedRequests: metrics.deduplicatedRequests,
      deduplicationRate: metrics.totalRequests > 0
        ? Math.round(((metrics.deduplicatedRequests / metrics.totalRequests) * 100) * 10) / 10
        : 0,
    });
  } catch (error) {
    console.error('[Performance] Error fetching queue status:', error);
    return res.status(500).json({ error: 'Failed to fetch queue status' });
  }
});

/**
 * GET /api/performance/websocket-status
 * Get WebSocket connection status
 */
router.get('/websocket-status', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const totalClients = websocketService.getConnectedClientsCount();
    const userClients = websocketService.getUserClientsCount(user.openId);
    const connectedUsers = websocketService.getConnectedUsers();

    return res.json({
      totalClients,
      userClients,
      connectedUsers: connectedUsers.length,
      status: totalClients > 0 ? 'healthy' : 'disconnected',
      connectedUsersList: connectedUsers,
    });
  } catch (error) {
    console.error('[Performance] Error fetching WebSocket status:', error);
    return res.status(500).json({ error: 'Failed to fetch WebSocket status' });
  }
});

export default router;
