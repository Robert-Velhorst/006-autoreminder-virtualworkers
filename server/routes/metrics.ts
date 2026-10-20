import express, { Request, Response } from 'express';
import { getCacheStats } from '../services/trello-cache';
import { requestQueue } from '../services/request-queue';
import { websocketService } from '../services/websocket';
import { requireAdmin } from '../middleware/auth';

interface AggregatedCacheStats {
  hits: number;
  misses: number;
  totalRequests: number;
  lastUpdated: string;
}

const router = express.Router();
router.use('/metrics', requireAdmin);

/**
 * Get comprehensive performance metrics
 */
router.get('/metrics/performance', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get cache statistics
    const cacheStatsArray = await getCacheStats(user.id, user.openId);
    
    // Aggregate cache stats from all cache keys
    const cacheStats: AggregatedCacheStats = cacheStatsArray.reduce(
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
    const queueStats = {
      totalRequests: queueMetrics.totalRequests,
      uniqueRequests: queueMetrics.totalRequests - queueMetrics.deduplicatedRequests,
      activeRequests: queueMetrics.activeRequests,
      pendingRequests: queueMetrics.activeRequests,
    };
    
    // Get WebSocket statistics
    const wsConnectedClients = websocketService.getConnectedClientsCount();
    const wsUserClients = websocketService.getUserClientsCount(user.openId);
    const wsConnectedUsers = websocketService.getConnectedUsers();

    // Calculate derived metrics
    const cacheHitRate = cacheStats.totalRequests > 0
      ? (cacheStats.hits / cacheStats.totalRequests) * 100
      : 0;
    
    const cacheMissRate = cacheStats.totalRequests > 0
      ? (cacheStats.misses / cacheStats.totalRequests) * 100
      : 0;

    const queueDeduplicationRate = queueStats.totalRequests > 0
      ? ((queueStats.totalRequests - queueStats.uniqueRequests) / queueStats.totalRequests) * 100
      : 0;

    // Estimate API calls saved
    const apiCallsSaved = cacheStats.hits + (queueStats.totalRequests - queueStats.uniqueRequests);
    const observedRequests = cacheStats.totalRequests + queueStats.totalRequests;
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
        missRate: Math.round(cacheMissRate * 10) / 10,
        lastUpdated: cacheStats.lastUpdated as string,
      },
      queue: {
        totalRequests: queueStats.totalRequests,
        uniqueRequests: queueStats.uniqueRequests,
        deduplicatedRequests: queueStats.totalRequests - queueStats.uniqueRequests,
        deduplicationRate: Math.round(queueDeduplicationRate * 10) / 10,
        activeRequests: queueStats.activeRequests,
        pendingRequests: queueStats.pendingRequests,
      },
      websocket: {
        connected: wsConnectedClients > 0,
        totalClients: wsConnectedClients,
        userClients: wsUserClients,
        totalUsers: wsConnectedUsers.length,
        status: wsConnectedClients > 0 ? 'healthy' : 'disconnected',
      },
      performance: {
        apiCallsSaved,
        apiCallReduction: Math.round(apiCallReduction * 10) / 10,
        timeSavedMs: timeSaved,
        timeSavedSeconds: Math.round(timeSaved / 1000),
        avgCacheHitTime,
        avgApiCallTime,
      },
      summary: {
        overallHealth: cacheHitRate > 50 && wsConnectedClients > 0 ? 'excellent' : 
                       cacheHitRate > 20 ? 'good' : 'poor',
        recommendations: generateRecommendations(cacheHitRate, queueDeduplicationRate, wsConnectedClients),
      },
    };

    res.json(metrics);
  } catch (error) {
    console.error('Error fetching performance metrics:', error);
    res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

/**
 * Get historical metrics (last 24 hours)
 */
router.get('/metrics/history', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const cacheStatsArray = await getCacheStats(user.id, user.openId);
    const cacheStats = cacheStatsArray.reduce(
      (acc, stat) => ({
        hits: acc.hits + stat.hitCount,
        misses: acc.misses + stat.missCount,
        totalRequests: acc.totalRequests + stat.hitCount + stat.missCount,
      }),
      { hits: 0, misses: 0, totalRequests: 0 }
    );

    const queueMetrics = requestQueue.getMetrics();
    const wsConnectedClients = websocketService.getConnectedClientsCount();

    const currentCacheHitRate = cacheStats.totalRequests > 0
      ? (cacheStats.hits / cacheStats.totalRequests) * 100
      : 0;
    const observedRequests = cacheStats.totalRequests + queueMetrics.totalRequests;
    const currentApiReduction = observedRequests > 0
      ? ((cacheStats.hits + queueMetrics.deduplicatedRequests) / observedRequests) * 100
      : 0;

    res.json({
      history: [{
        timestamp: new Date().toISOString(),
        cacheHitRate: Math.round(currentCacheHitRate * 10) / 10,
        apiCallReduction: Math.round(currentApiReduction * 10) / 10,
        activeConnections: wsConnectedClients,
      }],
      historical: false,
      note: 'Durable metric snapshots are not configured; this contains the current measured snapshot only.',
    });
  } catch (error) {
    console.error('Error fetching metrics history:', error);
    res.status(500).json({ error: 'Failed to fetch metrics history' });
  }
});

/**
 * Reset metrics (for testing)
 */
router.post('/metrics/reset', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden - admin only' });
    }

    requestQueue.resetMetrics();

    res.json({ success: true, message: 'Metrics reset successfully' });
  } catch (error) {
    console.error('Error resetting metrics:', error);
    res.status(500).json({ error: 'Failed to reset metrics' });
  }
});

/**
 * Generate recommendations based on metrics
 */
function generateRecommendations(
  cacheHitRate: number,
  queueDeduplicationRate: number,
  wsConnectedClients: number
): string[] {
  const recommendations: string[] = [];

  if (cacheHitRate < 50) {
    recommendations.push('Cache hit rate is low. Consider increasing cache TTL or warming cache on startup.');
  }

  if (queueDeduplicationRate < 20) {
    recommendations.push('Request deduplication rate is low. Most requests are unique, which is expected for diverse workloads.');
  }

  if (wsConnectedClients === 0) {
    recommendations.push('No WebSocket connections detected. Real-time updates are not active.');
  }

  if (recommendations.length === 0) {
    recommendations.push('All systems operating optimally! 🎉');
  }

  return recommendations;
}

export default router;
