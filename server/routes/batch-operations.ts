/**
 * Batch Operations API Routes
 * Handles bulk task operations with progress tracking
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  createBatchOperation,
  executeBatchOperation,
  getBatchOperationStatus,
  cancelBatchOperation,
  SUPPORTED_BATCH_OPERATION_TYPES,
  type BatchOperationParams,
} from '../services/batch-operations-service';
import { log } from '../utils/logger';
import { expensiveOperationRateLimiter } from '../middleware/rate-limiter';
import { requireAuthenticated, requestUser } from '../middleware/auth';
import { resolveBatchSchedule } from '../schedulingApi';
import { findUnownedBatchTaskIds } from '../batchOperationAuthorization';
import * as schedulingDb from '../db/scheduling';

const router = Router();
router.use(requireAuthenticated);

/**
 * POST /api/batch-operations/start
 * Start a new batch operation
 */
router.post('/start', expensiveOperationRateLimiter, async (req: any, res: Response) => {
  try {
    const user = requestUser(req)!;

    const { operationType, taskIds, description, parameters } = req.body;

    if (!operationType) {
      return res.status(400).json({ error: 'Operation type is required' });
    }

    if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 250) {
      return res.status(400).json({ error: 'Task IDs array is required and must not be empty' });
    }

    const normalizedTaskIds = [...new Set(taskIds.map((value: unknown) =>
      typeof value === 'string' ? value.trim() : ''
    ).filter((value: string) => value.length > 0 && value.length <= 128))];
    if (normalizedTaskIds.length !== taskIds.length) {
      return res.status(400).json({ error: 'Every task ID must be a unique non-empty string of at most 128 characters' });
    }

    const validOperationTypes = ['re_analyze', 'reschedule', 'conflict_resolution', 'optimization'];
    if (!validOperationTypes.includes(operationType)) {
      return res.status(400).json({
        error: `Invalid operation type. Must be one of: ${validOperationTypes.join(', ')}`,
      });
    }
    if (!SUPPORTED_BATCH_OPERATION_TYPES.includes(operationType)) {
      return res.status(501).json({
        error: `${operationType} is not implemented and will not be reported as completed`,
        supportedOperationTypes: SUPPORTED_BATCH_OPERATION_TYPES,
      });
    }
    if (operationType === 'reschedule' && normalizedTaskIds.some((taskId) => !resolveBatchSchedule(parameters, taskId))) {
      return res.status(400).json({
        error: 'Batch reschedule requires a valid schedule per task or a preferredDate with a duration between 0.25 and 24 hours',
      });
    }

    const assignedTasks = await schedulingDb.getUserTasks({
      id: user.id,
      openId: user.openId,
      role: user.role,
    });
    const unownedTaskIds = findUnownedBatchTaskIds(assignedTasks, normalizedTaskIds);
    if (unownedTaskIds.length > 0) {
      return res.status(403).json({
        error: 'Every batch task must be assigned to your account',
      });
    }

    const params: BatchOperationParams = {
      userId: String(user.id),
      userOpenId: user.openId,
      operationType,
      taskIds: normalizedTaskIds,
      description,
      parameters,
    };

    const operationId = await createBatchOperation(params);

    // Execute in background
    setImmediate(() => {
      executeBatchOperation(operationId, params).catch((error) => {
        log.error('Background batch operation failed', error, {
          operationId,
          operationType,
        });
      });
    });

    res.json({
      success: true,
      operationId,
      message: 'Batch operation started',
    });
  } catch (error) {
    log.error('Failed to start batch operation', error as Error, {
      userId: req.user?.openId,
    });
    res.status(500).json({ error: 'Failed to start batch operation' });
  }
});

/**
 * GET /api/batch-operations/:operationId/status
 * Get batch operation status
 */
router.get('/:operationId/status', async (req: Request, res: Response) => {
  try {
    const { operationId } = req.params;

    if (!operationId) {
      return res.status(400).json({ error: 'Operation ID is required' });
    }

    const user = requestUser(req)!;
    const status = await getBatchOperationStatus(operationId, user.openId);

    if (!status) {
      return res.status(404).json({ error: 'Batch operation not found' });
    }

    res.json({
      success: true,
      operation: status,
    });
  } catch (error) {
    log.error('Failed to get batch operation status', error as Error, {
      operationId: req.params.operationId,
    });
    res.status(500).json({ error: 'Failed to get operation status' });
  }
});

/**
 * POST /api/batch-operations/:operationId/cancel
 * Cancel a batch operation
 */
router.post('/:operationId/cancel', async (req: Request, res: Response) => {
  try {
    const { operationId } = req.params;

    if (!operationId) {
      return res.status(400).json({ error: 'Operation ID is required' });
    }

    const user = requestUser(req)!;
    const cancelled = await cancelBatchOperation(operationId, user.openId);
    if (!cancelled) {
      return res.status(404).json({ error: 'Running batch operation not found' });
    }

    res.json({
      success: true,
      message: 'Batch operation cancelled',
    });
  } catch (error) {
    log.error('Failed to cancel batch operation', error as Error, {
      operationId: req.params.operationId,
    });
    res.status(500).json({ error: 'Failed to cancel operation' });
  }
});

export default router;
