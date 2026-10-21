import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as schedulingDb from '../db/scheduling';
import { batchQueueProcessor } from '../services/batch-queue-processor.js';
import {
  buildSchedulingMetrics,
  normalizeHistoryLimit,
  resolveBatchSchedule,
  toBatchOperationResponse,
  toShortcutMap,
} from '../schedulingApi.js';
import { requestUser, requireAuthenticated } from '../middleware/auth';
import { assignmentFailure } from '../taskAssignmentMutation';

const router = Router();
router.use(requireAuthenticated);

function getScheduleActor(req: Request): schedulingDb.ScheduleActor | null {
  const user = requestUser(req);
  if (!user) return null;
  return { id: user.id, openId: user.openId, role: user.role };
}

function parseScheduleRange(startValue: unknown, endValue: unknown) {
  const startTime = new Date(String(startValue));
  const endTime = new Date(String(endValue));
  if (!Number.isFinite(startTime.getTime()) || !Number.isFinite(endTime.getTime())) return null;
  if (startTime >= endTime) return null;
  return { startTime, endTime };
}

/**
 * Advanced Scheduling Routes
 * Handles drag-and-drop rescheduling, batch operations, and conflict detection
 */

// ============================================
// CONFLICT DETECTION HELPERS
// ============================================

/**
 * Detect time overlaps between tasks
 */
async function detectTimeConflicts(
  taskId: string,
  newStartTime: Date,
  newEndTime: Date,
  actor: schedulingDb.ScheduleActor,
) {
  const userTasks = await schedulingDb.getUserTasks(actor);
  return userTasks.filter((task) => {
    if (task.taskId === taskId) return false;
    if (!task.startTime || !task.endTime) return false;

    const taskStart = new Date(task.startTime);
    const taskEnd = new Date(task.endTime);
    return newStartTime < taskEnd && newEndTime > taskStart;
  });
}

/**
 * Detect resource conflicts (same person assigned to multiple tasks)
 */
async function detectResourceConflicts(
  taskId: string,
  assignedTo: number,
  newStartTime: Date,
  newEndTime: Date,
  actor: schedulingDb.ScheduleActor,
) {
  const assignedTasks = await schedulingDb.getTasksByAssignee(actor, assignedTo);
  return assignedTasks.filter((task) => {
    if (task.taskId === taskId) return false;
    if (!task.startTime || !task.endTime) return false;

    const taskStart = new Date(task.startTime);
    const taskEnd = new Date(task.endTime);
    return newStartTime < taskEnd && newEndTime > taskStart;
  });
}

function uniqueConflicts(conflicts: schedulingDb.ScheduledTaskRecord[]) {
  return Array.from(new Map(conflicts.map((conflict) => [conflict.id, conflict])).values());
}

/**
 * Generate conflict resolution suggestions
 */
function generateResolutionSuggestions(
  conflicts: any[],
  newStartTime: Date,
  newEndTime: Date
): any[] {
  const suggestions: any[] = [];
  
  if (conflicts.length === 0) {
    return suggestions;
  }
  
  // Suggestion 1: Reschedule to earlier time
  const earlierTime = new Date(newStartTime.getTime() - 2 * 60 * 60 * 1000); // 2 hours earlier
  suggestions.push({
    type: 'reschedule_earlier',
    description: 'Reschedule 2 hours earlier',
    newStartTime: earlierTime,
    newEndTime: new Date(earlierTime.getTime() + (newEndTime.getTime() - newStartTime.getTime()))
  });
  
  // Suggestion 2: Reschedule to later time
  const laterTime = new Date(newEndTime.getTime() + 1 * 60 * 60 * 1000); // 1 hour after conflict ends
  suggestions.push({
    type: 'reschedule_later',
    description: 'Reschedule 1 hour after conflict',
    newStartTime: laterTime,
    newEndTime: new Date(laterTime.getTime() + (newEndTime.getTime() - newStartTime.getTime()))
  });
  
  // Suggestion 3: Split task into smaller chunks
  suggestions.push({
    type: 'split_task',
    description: 'Split task into smaller chunks',
    recommendation: 'Consider breaking this task into smaller subtasks to avoid conflicts'
  });
  
  return suggestions;
}

// ============================================
// RESCHEDULE ENDPOINTS
// ============================================

/**
 * POST /api/scheduling/reschedule
 * Reschedule a single task with conflict detection
 */
router.post('/reschedule', async (req: Request, res: Response) => {
  try {
    const { taskId, cardTrelloId, newStartTime, newEndTime, reason } = req.body;
    const actor = getScheduleActor(req);
    if (!actor) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate input
    if (!taskId || !newStartTime || !newEndTime) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const range = parseScheduleRange(newStartTime, newEndTime);
    if (!range) {
      return res.status(400).json({ error: 'Valid start and end times are required, with start before end' });
    }
    const { startTime, endTime } = range;

    const ownedTask = await schedulingDb.getScheduledTaskForActor(taskId, actor);
    if (!ownedTask) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    // Detect conflicts
    const timeConflicts = await detectTimeConflicts(taskId, startTime, endTime, actor);
    const resourceConflicts = await detectResourceConflicts(taskId, ownedTask.vaId, startTime, endTime, actor);
    const allConflicts = uniqueConflicts([...timeConflicts, ...resourceConflicts]);
    const hadConflicts = allConflicts.length > 0;
    
    // Generate resolution suggestions if conflicts exist
    const suggestions = hadConflicts ? generateResolutionSuggestions(allConflicts, startTime, endTime) : [];

    const result = await schedulingDb.rescheduleTaskForActor(actor, taskId, startTime, endTime, {
      cardTrelloId,
      reason: reason || 'Manual reschedule',
      source: 'manual',
      hadConflicts,
      conflictDetails: hadConflicts ? JSON.stringify(allConflicts) : undefined,
    });
    if (!result) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    res.json({
      success: true,
      taskId,
      historyId: result.historyId,
      previousStartTime: result.previousStartTime,
      previousEndTime: result.previousEndTime,
      newStartTime: startTime,
      newEndTime: endTime,
      hadConflicts,
      conflictCount: allConflicts.length,
      conflicts: hadConflicts ? allConflicts.map((c: any) => ({
        id: c.id,
        title: c.taskId,
        startTime: c.startTime,
        endTime: c.endTime,
        type: c.vaId === ownedTask.vaId ? 'resource' : 'time'
      })) : [],
      suggestions,
      message: hadConflicts 
        ? `Task rescheduled with ${allConflicts.length} conflict(s) detected`
        : 'Task rescheduled successfully'
    });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error, code: failure.code });
    console.error('[AdvancedScheduling] Error rescheduling task:', error);
    res.status(500).json({ error: 'Failed to reschedule task' });
  }
});

/**
 * POST /api/scheduling/undo/:taskId
 * Undo the last reschedule for a task
 */
router.post('/undo/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const actor = getScheduleActor(req);
    if (!actor) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await schedulingDb.undoLastRescheduleForActor(actor, taskId);
    if (!result) {
      return res.status(404).json({ error: 'No previous schedule found' });
    }

    res.json({
      success: true,
      taskId,
      historyId: result.historyId,
      restoredStartTime: result.newStartTime,
      restoredEndTime: result.newEndTime,
      message: 'Previous schedule restored'
    });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error, code: failure.code });
    console.error('[AdvancedScheduling] Error undoing reschedule:', error);
    res.status(500).json({ error: 'Failed to undo reschedule' });
  }
});

/**
 * GET /api/scheduling/history/:taskId
 * Get schedule history for a task
 */
router.get('/history/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const actor = getScheduleActor(req);
    if (!actor) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const history = await schedulingDb.getScheduleHistoryForActor(taskId, actor);
    if (!history) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    res.json({
      success: true,
      taskId,
      history,
      count: history.length
    });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error, code: failure.code });
    console.error('[AdvancedScheduling] Error getting schedule history:', error);
    res.status(500).json({ error: 'Failed to get schedule history' });
  }
});

/**
 * POST /api/scheduling/detect-conflicts
 * Detect conflicts for a proposed schedule
 */
router.post('/detect-conflicts', async (req: Request, res: Response) => {
  try {
    const { taskId, newStartTime, newEndTime } = req.body;
    const actor = getScheduleActor(req);
    if (!actor) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!taskId || !newStartTime || !newEndTime) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const range = parseScheduleRange(newStartTime, newEndTime);
    if (!range) {
      return res.status(400).json({ error: 'Valid start and end times are required, with start before end' });
    }
    const { startTime, endTime } = range;

    const ownedTask = await schedulingDb.getScheduledTaskForActor(taskId, actor);
    if (!ownedTask) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    // Detect conflicts
    const timeConflicts = await detectTimeConflicts(taskId, startTime, endTime, actor);
    const resourceConflicts = await detectResourceConflicts(taskId, ownedTask.vaId, startTime, endTime, actor);
    const allConflicts = uniqueConflicts([...timeConflicts, ...resourceConflicts]);
    const suggestions = allConflicts.length > 0 
      ? generateResolutionSuggestions(allConflicts, startTime, endTime)
      : [];

    res.json({
      success: true,
      taskId,
      hasConflicts: allConflicts.length > 0,
      conflictCount: allConflicts.length,
      conflicts: allConflicts.map((c: any) => ({
        id: c.id,
        title: c.taskId,
        startTime: c.startTime,
        endTime: c.endTime,
        type: c.vaId === ownedTask.vaId ? 'resource' : 'time'
      })),
      suggestions
    });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error, code: failure.code });
    console.error('[AdvancedScheduling] Error detecting conflicts:', error);
    res.status(500).json({ error: 'Failed to detect conflicts' });
  }
});

// ============================================
// BATCH OPERATIONS ENDPOINTS
// ============================================

/**
 * POST /api/scheduling/batch-start
 * Start a batch operation (re-analyze, reschedule, etc.)
 */
router.post('/batch-start', async (req: Request, res: Response) => {
  try {
    const { operationType, taskIds, description } = req.body;
    const parameters = req.body?.parameters ?? req.body?.options;
    const userOpenId = (req as any).user?.openId;

    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!operationType || !Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 250) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const normalizedTaskIds = [...new Set(taskIds.map((value: unknown) =>
      typeof value === 'string' ? value.trim() : ''
    ).filter((value: string) => value.length > 0 && value.length <= 128))];
    if (normalizedTaskIds.length !== taskIds.length) {
      return res.status(400).json({ error: 'Every task ID must be a unique non-empty string of at most 128 characters' });
    }

    const validOperationTypes = ['re_analyze', 'reschedule', 'conflict_resolution', 'optimization'];
    if (!validOperationTypes.includes(operationType)) {
      return res.status(400).json({ error: 'Invalid operation type' });
    }
    if (operationType === 'conflict_resolution' || operationType === 'optimization') {
      return res.status(501).json({
        error: `${operationType} is not implemented and will not be reported as completed`,
        supportedOperationTypes: ['re_analyze', 'reschedule'],
      });
    }
    if (operationType === 'reschedule' && normalizedTaskIds.some((taskId) => !resolveBatchSchedule(parameters, taskId))) {
      return res.status(400).json({
        error: 'Batch reschedule requires a valid schedule per task or a preferredDate with a duration between 0.25 and 24 hours',
      });
    }

    const actor = getScheduleActor(req)!;
    const assignments = await schedulingDb.getUserTasks(actor);
    if (normalizedTaskIds.some(taskId => !assignments.some(assignment => assignment.taskId === taskId))) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    // Create batch operation record only after canonical ownership checks.
    const jobId = await schedulingDb.createBatchOperation({
      userId: userOpenId,
      operationType,
      taskIds: normalizedTaskIds,
      description,
    });

    const jobParameters = parameters && typeof parameters === 'object'
      ? { ...parameters, description }
      : { description };
    void batchQueueProcessor.enqueueJob(jobId, userOpenId, operationType, normalizedTaskIds, jobParameters);

    const createdAt = new Date();
    res.json({
      success: true,
      jobId,
      operationType,
      status: 'pending',
      progress: 0,
      totalTasks: normalizedTaskIds.length,
      completedTasks: 0,
      failedTasks: 0,
      createdAt,
      message: 'Batch operation started'
    });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error, code: failure.code });
    console.error('[AdvancedScheduling] Error starting batch operation:', error);
    res.status(500).json({ error: 'Failed to start batch operation' });
  }
});

/**
 * GET /api/scheduling/batch/:jobId
 * Get batch operation progress
 */
router.get('/batch/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const userOpenId = (req as any).user?.openId;
    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const liveProgress = batchQueueProcessor.getJobProgress(jobId);
    const operation = await schedulingDb.getBatchOperation(jobId);

    if (!operation && !liveProgress) {
      return res.status(404).json({ error: 'Batch operation not found' });
    }

    if (!operation || operation.userId !== userOpenId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const elapsedSeconds = liveProgress?.elapsedSeconds
      ?? (operation?.startedAt
        ? Math.floor((Date.now() - operation.startedAt.getTime()) / 1000)
        : 0);

    const status = liveProgress?.status ?? operation?.status ?? 'pending';
    const progressValue = liveProgress?.progress ?? operation?.progress ?? 0;
    const totalTasks = liveProgress?.totalTasks ?? operation?.taskIds?.length ?? 0;
    const completedTasks = liveProgress?.completedTasks ?? operation?.completedTasks ?? 0;
    const failedTasks = liveProgress?.failedTasks ?? operation?.failedTasks ?? 0;
    const currentTaskName = liveProgress?.currentTaskName ?? operation?.currentTaskName;
    const elapsedTimeSeconds = liveProgress?.elapsedSeconds ?? operation?.elapsedTimeSeconds;
    const estimatedTimeSeconds = liveProgress?.estimatedTimeSeconds ?? operation?.estimatedTimeSeconds;
    const isPaused = liveProgress?.isPaused ?? false;
    const pausedAt = liveProgress?.pausedAt ? new Date(liveProgress.pausedAt) : undefined;

    res.json({
      success: true,
      jobId,
      status,
      progress: progressValue,
      totalTasks,
      completedTasks,
      failedTasks,
      currentTaskName,
      elapsedSeconds,
      elapsedTimeSeconds,
      estimatedTimeSeconds,
      isPaused,
      pausedAt
    });
  } catch (error) {
    console.error('[AdvancedScheduling] Error getting batch progress:', error);
    res.status(500).json({ error: 'Failed to get batch progress' });
  }
});

/**
 * GET /api/scheduling/batch-history
 * Get persisted batch operations for the authenticated user.
 */
router.get('/batch-history', async (req: Request, res: Response) => {
  try {
    const userOpenId = (req as any).user?.openId;
    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limit = normalizeHistoryLimit(req.query.limit);
    const operations = await schedulingDb.getBatchOperationHistory(userOpenId, limit);
    res.json({
      success: true,
      operations: operations.map(toBatchOperationResponse),
    });
  } catch (error) {
    console.error('[AdvancedScheduling] Error getting batch history:', error);
    res.status(500).json({ error: 'Failed to get batch operations' });
  }
});

/**
 * GET /api/scheduling/shortcuts
 * Get enabled keyboard shortcuts for the authenticated user.
 */
router.get('/shortcuts', async (req: Request, res: Response) => {
  try {
    const userOpenId = (req as any).user?.openId;
    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const shortcuts = await schedulingDb.getKeyboardShortcuts(userOpenId);
    res.json(toShortcutMap(shortcuts));
  } catch (error) {
    console.error('[AdvancedScheduling] Error getting keyboard shortcuts:', error);
    res.status(500).json({ error: 'Failed to get keyboard shortcuts' });
  }
});

/**
 * POST /api/scheduling/shortcuts
 * Save one keyboard shortcut without affecting unrelated actions.
 */
router.post('/shortcuts', async (req: Request, res: Response) => {
  try {
    const userOpenId = (req as any).user?.openId;
    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';
    const keys = typeof req.body?.keys === 'string' ? req.body.keys.trim() : '';
    if (!action || action.length > 100 || !keys || keys.length > 50) {
      return res.status(400).json({ error: 'Valid action and keys are required' });
    }

    await schedulingDb.upsertKeyboardShortcutForUser(userOpenId, action, keys);
    res.json({ success: true });
  } catch (error) {
    console.error('[AdvancedScheduling] Error saving keyboard shortcut:', error);
    res.status(500).json({ error: 'Failed to save keyboard shortcut' });
  }
});

/**
 * GET /api/scheduling/metrics
 * Derive live scheduling metrics from persisted batch history.
 */
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const userOpenId = (req as any).user?.openId;
    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const operations = await schedulingDb.getBatchOperationHistory(userOpenId, 200);
    res.json(buildSchedulingMetrics(operations));
  } catch (error) {
    console.error('[AdvancedScheduling] Error getting scheduling metrics:', error);
    res.status(500).json({ error: 'Failed to get performance metrics' });
  }
});

/**
 * POST /api/scheduling/batch/:jobId/cancel
 * Cancel a batch operation
 */
router.post('/batch/:jobId/cancel', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const userOpenId = (req as any).user?.openId;

    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify the job belongs to the user
    const operation = await schedulingDb.getBatchOperation(jobId);
    if (!operation) {
      return res.status(404).json({ error: 'Batch operation not found' });
    }

    if (operation.userId !== userOpenId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await batchQueueProcessor.cancelJob(jobId);
    await schedulingDb.cancelBatchOperation(jobId);

    res.json({
      success: true,
      jobId,
      message: 'Batch operation cancelled'
    });
  } catch (error) {
    console.error('[AdvancedScheduling] Error cancelling batch operation:', error);
    res.status(500).json({ error: 'Failed to cancel batch operation' });
  }
});

/**
 * POST /api/scheduling/batch/:jobId/pause
 * Pause a running batch operation
 */
router.post('/batch/:jobId/pause', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const userOpenId = (req as any).user?.openId;

    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const operation = await schedulingDb.getBatchOperation(jobId);
    if (!operation) {
      return res.status(404).json({ error: 'Batch operation not found' });
    }

    if (operation.userId !== userOpenId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await batchQueueProcessor.pauseJob(jobId);

    res.json({
      success: true,
      jobId,
      message: 'Batch operation paused'
    });
  } catch (error) {
    console.error('[AdvancedScheduling] Error pausing batch operation:', error);
    res.status(500).json({ error: 'Failed to pause batch operation' });
  }
});

/**
 * POST /api/scheduling/batch/:jobId/resume
 * Resume a paused batch operation
 */
router.post('/batch/:jobId/resume', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const userOpenId = (req as any).user?.openId;

    if (!userOpenId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const operation = await schedulingDb.getBatchOperation(jobId);
    if (!operation) {
      return res.status(404).json({ error: 'Batch operation not found' });
    }

    if (operation.userId !== userOpenId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await batchQueueProcessor.resumeJob(jobId);

    res.json({
      success: true,
      jobId,
      message: 'Batch operation resumed'
    });
  } catch (error) {
    console.error('[AdvancedScheduling] Error resuming batch operation:', error);
    res.status(500).json({ error: 'Failed to resume batch operation' });
  }
});

export default router;
