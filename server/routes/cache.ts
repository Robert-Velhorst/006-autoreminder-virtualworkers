import { Router } from 'express';
import type { Request, Response } from 'express';
import { 
  getCacheStats, 
  invalidateCache, 
  invalidateAllCache, 
  cleanupExpiredCache 
} from '../services/trello-cache';
import { requireAdmin } from '../middleware/auth';

const router = Router();
router.use('/cache', requireAdmin);

// Get cache statistics
router.get('/cache/stats', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const stats = await getCacheStats(user.id, user.openId);
    res.json(stats);
  } catch (error) {
    console.error('Error getting cache stats:', error);
    res.status(500).json({ error: 'Failed to get cache statistics' });
  }
});

// Invalidate specific cache
router.delete('/cache/:cacheKey', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { cacheKey } = req.params;
    await invalidateCache(user.id, user.openId, cacheKey);
    
    res.json({ 
      success: true, 
      message: `Cache '${cacheKey}' invalidated successfully` 
    });
  } catch (error) {
    console.error('Error invalidating cache:', error);
    res.status(500).json({ error: 'Failed to invalidate cache' });
  }
});

// Invalidate all cache for user
router.delete('/cache', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await invalidateAllCache(user.id, user.openId);
    
    res.json({ 
      success: true, 
      message: 'All cache invalidated successfully' 
    });
  } catch (error) {
    console.error('Error invalidating all cache:', error);
    res.status(500).json({ error: 'Failed to invalidate cache' });
  }
});

// Cleanup expired cache (admin only)
router.post('/cache/cleanup', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden - admin only' });
    }

    const deletedCount = await cleanupExpiredCache();
    
    res.json({ 
      success: true, 
      message: `Cleaned up ${deletedCount} expired cache entries` 
    });
  } catch (error) {
    console.error('Error cleaning up cache:', error);
    res.status(500).json({ error: 'Failed to cleanup cache' });
  }
});

export default router;
