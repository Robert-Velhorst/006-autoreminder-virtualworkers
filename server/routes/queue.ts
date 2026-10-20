import { Router } from 'express';
import type { Request, Response } from 'express';
import { requestQueue } from '../services/request-queue';
import { requireAdmin } from '../middleware/auth';

const router = Router();
router.use('/queue', requireAdmin);

// Get queue metrics
router.get('/queue/metrics', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const metrics = requestQueue.getMetrics();
    const pendingKeys = requestQueue.getPendingKeys();

    res.json({
      ...metrics,
      pendingRequests: pendingKeys.map(key => ({
        key,
        age: requestQueue.getPendingAge(key)
      }))
    });
  } catch (error) {
    console.error('Error getting queue metrics:', error);
    res.status(500).json({ error: 'Failed to get queue metrics' });
  }
});

// Reset queue metrics (admin only)
router.post('/queue/reset', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden - admin only' });
    }

    requestQueue.resetMetrics();
    
    res.json({ 
      success: true, 
      message: 'Queue metrics reset successfully' 
    });
  } catch (error) {
    console.error('Error resetting queue metrics:', error);
    res.status(500).json({ error: 'Failed to reset queue metrics' });
  }
});

// Clear all pending requests (admin only)
router.post('/queue/clear', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden - admin only' });
    }

    requestQueue.clearAll();
    
    res.json({ 
      success: true, 
      message: 'All pending requests cleared' 
    });
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(500).json({ error: 'Failed to clear queue' });
  }
});

export default router;
