/**
 * Batch Operations Service
 * Handles bulk task operations with progress tracking
 */

import { nanoid } from 'nanoid';
import { getDb } from '../db';
import { batchOperations } from '../../drizzle/schema.postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { websocketService } from './websocket';
import { invalidateCache } from './trello-cache';
import { log } from '../utils/logger';
import * as schedulingDb from '../db/scheduling';
import { resolveBatchSchedule } from '../schedulingApi';

export type BatchOperationType = 're_analyze' | 'reschedule' | 'conflict_resolution' | 'optimization';
export type BatchOperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export const SUPPORTED_BATCH_OPERATION_TYPES = ['re_analyze', 'reschedule'] as const;

export interface BatchOperationParams {
  userId: string;
  userOpenId: string;
  operationType: BatchOperationType;
  taskIds: string[];
  description?: string;
  parameters?: Record<string, any>;
}

export interface BatchOperationResult {
  operationId: string;
  status: BatchOperationStatus;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  progress: number;
  results?: any[];
  errors?: string[];
}

/**
 * Create a new batch operation
 */
export async function createBatchOperation(params: BatchOperationParams): Promise<string> {
  if (!SUPPORTED_BATCH_OPERATION_TYPES.includes(params.operationType as (typeof SUPPORTED_BATCH_OPERATION_TYPES)[number])) {
    throw new Error(`Batch operation ${params.operationType} is not implemented`);
  }

  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const operationId = nanoid();
  const now = new Date();

  await db.insert(batchOperations).values({
    id: operationId,
    userId: params.userOpenId,
    operationType: params.operationType,
    description: params.description || `Batch ${params.operationType}`,
    totalTasks: params.taskIds.length,
    completedTasks: 0,
    failedTasks: 0,
    status: 'pending',
    progress: '0.00',
    currentTaskIndex: 0,
    estimatedTimeSeconds: params.taskIds.length * 5, // Estimate 5 seconds per task
    elapsedTimeSeconds: 0,
    parameters: JSON.stringify(params.parameters || {}),
    createdAt: now,
    updatedAt: now,
  });

  log.info('Batch operation created', {
    operationId,
    operationType: params.operationType,
    totalTasks: params.taskIds.length,
    userId: params.userOpenId,
  });

  return operationId;
}

/**
 * Update batch operation progress
 */
async function updateBatchProgress(
  operationId: string,
  updates: {
    completedTasks?: number;
    failedTasks?: number;
    currentTaskIndex?: number;
    currentTaskName?: string;
    status?: BatchOperationStatus;
    results?: any;
    errorLog?: any;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const operation = await db
    .select()
    .from(batchOperations)
    .where(eq(batchOperations.id, operationId))
    .limit(1);

  if (operation.length === 0) return;

  const current = operation[0];
  const totalTasks = current.totalTasks;
  const completedTasks = updates.completedTasks ?? current.completedTasks;
  const failedTasks = updates.failedTasks ?? current.failedTasks;
  const progress = ((completedTasks + failedTasks) / totalTasks) * 100;

  const updateData: any = {
    ...updates,
    progress: progress.toFixed(2),
    updatedAt: new Date(),
  };

  if (updates.status === 'completed' || updates.status === 'failed') {
    updateData.completedAt = new Date();
  }

  if (updates.results) {
    updateData.results = JSON.stringify(updates.results);
  }

  if (updates.errorLog) {
    updateData.errorLog = JSON.stringify(updates.errorLog);
  }

  await db
    .update(batchOperations)
    .set(updateData)
    .where(eq(batchOperations.id, operationId));

  // Emit progress update via WebSocket
  websocketService.emitToUser(current.userId, 'batch:progress', {
    operationId,
    status: updates.status || current.status,
    progress: parseFloat(progress.toFixed(2)),
    completedTasks,
    failedTasks,
    totalTasks,
    currentTaskName: updates.currentTaskName,
  });
}

/**
 * Execute batch re-analysis operation
 */
async function executeBatchReAnalysis(
  operationId: string,
  taskIds: string[],
  userId: string,
  userOpenId: string
): Promise<void> {
  const results: any[] = [];
  const errors: string[] = [];
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i];

    try {
      await updateBatchProgress(operationId, {
        currentTaskIndex: i,
        currentTaskName: `Task ${taskId}`,
      });

      // Import ATIS service dynamically to avoid circular dependencies
      const { runAllPhases } = await import('./atis-phases-service');
      const { createAnalysisSession } = await import('../db/atis-phases');

      // Create analysis session
      const sessionId = await createAnalysisSession(taskId, userId);

      // Run analysis (this will take time)
      const result = await runAllPhases(taskId, userId, `Re-analysis of task ${taskId}`, sessionId);

      results.push({ taskId, success: true, sessionId, result });
      completed++;

      await updateBatchProgress(operationId, {
        completedTasks: completed,
        failedTasks: failed,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Task ${taskId}: ${errorMessage}`);
      failed++;

      log.error('Batch re-analysis failed for task', error as Error, {
        operationId,
        taskId,
      });

      await updateBatchProgress(operationId, {
        completedTasks: completed,
        failedTasks: failed,
      });
    }
  }

  await updateBatchProgress(operationId, {
    status: failed === taskIds.length ? 'failed' : 'completed',
    results,
    errorLog: errors,
  });
}

/**
 * Execute batch reschedule operation
 */
async function executeBatchReschedule(
  operationId: string,
  taskIds: string[],
  userId: number,
  userOpenId: string,
  parameters?: Record<string, any>,
): Promise<void> {
  const results: any[] = [];
  const errors: string[] = [];
  let completed = 0;
  let failed = 0;

  const actor = await schedulingDb.getScheduleActorByOpenId(userOpenId);
  if (!actor) throw new Error('Batch operation owner not found');

  for (let index = 0; index < taskIds.length; index++) {
    const taskId = taskIds[index];
    try {
      await updateBatchProgress(operationId, {
        currentTaskIndex: index,
        currentTaskName: `Task ${taskId}`,
      });

      const schedule = resolveBatchSchedule(parameters, taskId);
      if (!schedule) throw new Error('A valid task schedule is required');
      const result = await schedulingDb.rescheduleTaskForActor(
        actor,
        taskId,
        schedule.startTime,
        schedule.endTime,
        { reason: 'Batch reschedule', source: 'batch' },
      );
      if (!result) throw new Error('Task assignment not found or not owned by this user');

      results.push({
        taskId,
        success: true,
        historyId: result.historyId,
        previousStartTime: result.previousStartTime,
        previousEndTime: result.previousEndTime,
        newStartTime: result.newStartTime,
        newEndTime: result.newEndTime,
      });
      completed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Task ${taskId}: ${message}`);
      failed++;
      log.error('Batch reschedule failed for task', error as Error, { operationId, taskId });
    }

    await updateBatchProgress(operationId, {
      completedTasks: completed,
      failedTasks: failed,
    });
  }

  if (completed > 0) await invalidateCache(userId, userOpenId, 'tasks');

  await updateBatchProgress(operationId, {
    status: failed === taskIds.length ? 'failed' : 'completed',
    completedTasks: completed,
    failedTasks: failed,
    results,
    errorLog: errors,
  });

  log.info('Batch reschedule completed', { operationId, completed, failed });
}

/**
 * Execute a batch operation
 */
export async function executeBatchOperation(
  operationId: string,
  params: BatchOperationParams
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  try {
    // Mark as running
    await updateBatchProgress(operationId, {
      status: 'running',
    });

    const userId = parseInt(params.userId, 10);
    if (!Number.isFinite(userId)) {
      throw new Error('Invalid user ID');
    }

    // Execute based on operation type
    switch (params.operationType) {
      case 're_analyze':
        await executeBatchReAnalysis(operationId, params.taskIds, params.userId, params.userOpenId);
        break;

      case 'reschedule':
        await executeBatchReschedule(operationId, params.taskIds, userId, params.userOpenId, params.parameters);
        break;

      case 'conflict_resolution':
      case 'optimization':
        throw new Error(`Batch operation ${params.operationType} is not implemented`);

      default:
        throw new Error(`Unknown operation type: ${params.operationType}`);
    }

    log.info('Batch operation completed', {
      operationId,
      operationType: params.operationType,
    });
  } catch (error) {
    log.error('Batch operation failed', error as Error, {
      operationId,
      operationType: params.operationType,
    });

    await updateBatchProgress(operationId, {
      status: 'failed',
      errorLog: { error: error instanceof Error ? error.message : String(error) },
    });

    throw error;
  }
}

/**
 * Get batch operation status
 */
export async function getBatchOperationStatus(
  operationId: string,
  ownerOpenId?: string
): Promise<BatchOperationResult | null> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const ownerFilter = ownerOpenId
    ? and(eq(batchOperations.id, operationId), eq(batchOperations.userId, ownerOpenId))
    : eq(batchOperations.id, operationId);
  const operations = await db
    .select()
    .from(batchOperations)
    .where(ownerFilter)
    .limit(1);

  if (operations.length === 0) {
    return null;
  }

  const operation = operations[0];

  return {
    operationId: operation.id,
    status: operation.status as BatchOperationStatus,
    totalTasks: operation.totalTasks,
    completedTasks: operation.completedTasks,
    failedTasks: operation.failedTasks,
    progress: parseFloat(operation.progress),
    results: operation.results ? JSON.parse(operation.results) : undefined,
    errors: operation.errorLog ? JSON.parse(operation.errorLog) : undefined,
  };
}

/**
 * Cancel a batch operation
 */
export async function cancelBatchOperation(operationId: string, ownerOpenId?: string): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const filters = [eq(batchOperations.id, operationId)];
  if (ownerOpenId) filters.push(eq(batchOperations.userId, ownerOpenId));
  filters.push(inArray(batchOperations.status, ['pending', 'running']));

  const result = await db
    .update(batchOperations)
    .set({
      status: 'cancelled',
      updatedAt: new Date(),
    })
    .where(and(...filters))
    .returning({ id: batchOperations.id });

  const changed = result.length > 0;
  if (changed) log.info('Batch operation cancelled', { operationId, ownerOpenId });
  return changed;
}
