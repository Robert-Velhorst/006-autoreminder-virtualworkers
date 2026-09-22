/**
 * Batch Operations API Client
 * Handles all communication with the backend batch operations service
 */

export type BatchOperationType = 're_analyze' | 'reschedule' | 'conflict_resolution' | 'optimization';
export type BatchOperationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BatchOperationRequest {
  operationType: Extract<BatchOperationType, 're_analyze' | 'reschedule'>;
  taskIds?: string[];
  options?: Record<string, any>;
  priority?: 'low' | 'normal' | 'high';
}

export interface BatchOperationResponse {
  jobId: string;
  operationType: BatchOperationType;
  status: BatchOperationStatus;
  progress?: number;
  totalTasks: number;
  completedTasks?: number;
  failedTasks?: number;
  currentTaskIndex?: number;
  currentTaskName?: string;
  elapsedTimeSeconds?: number;
  estimatedTimeSeconds?: number;
  errorLog?: string[];
  results?: Record<string, unknown>;
  createdAt: string | Date;
  startedAt?: string | Date;
  completedAt?: string | Date;
  isPaused?: boolean;
  pausedAt?: string | Date;
}

export interface BatchOperationTask {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  error?: string;
}

export interface NormalizedBatchOperation extends Omit<BatchOperationResponse, 'createdAt' | 'startedAt' | 'completedAt' | 'pausedAt'> {
  progress: number;
  completedTasks: number;
  failedTasks: number;
  currentTaskIndex: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  pausedAt?: Date;
  tasks: BatchOperationTask[];
}

export type BatchOperationProgress = NormalizedBatchOperation;

function normalizeNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeDate(value: string | Date | undefined) {
  if (!value) return undefined;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : undefined;
}

export function normalizeBatchOperationResponse(response: BatchOperationResponse): NormalizedBatchOperation {
  return {
    ...response,
    progress: normalizeNumber(response.progress),
    completedTasks: normalizeNumber(response.completedTasks),
    failedTasks: normalizeNumber(response.failedTasks),
    currentTaskIndex: normalizeNumber(response.currentTaskIndex),
    createdAt: normalizeDate(response.createdAt) ?? new Date(0),
    startedAt: normalizeDate(response.startedAt),
    completedAt: normalizeDate(response.completedAt),
    pausedAt: normalizeDate(response.pausedAt),
    tasks: [],
  };
}

export function getBatchTaskPosition(currentTaskIndex: number, totalTasks: number): number {
  if (totalTasks <= 0) return 0;
  return Math.min(totalTasks, Math.max(1, normalizeNumber(currentTaskIndex, 1)));
}

export function selectBatchOperationForPause<TOperation extends { jobId: string; status: string }>(
  operations: readonly TOperation[],
  requestedJobId?: string,
) {
  if (requestedJobId) {
    return operations.find((operation) => operation.jobId === requestedJobId && operation.status === 'running') ?? null;
  }
  return operations.find((operation) => operation.status === 'running') ?? null;
}

class BatchOperationsClient {
  private baseUrl = '/api/scheduling';

  /**
   * Start a new batch operation
   */
  async startBatchOperation(request: BatchOperationRequest): Promise<BatchOperationResponse> {
    const response = await fetch(`${this.baseUrl}/batch-start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();
        throw new Error(error.error || error.message || 'Failed to start batch operation');
      } else {
        throw new Error(`Failed to start batch operation (HTTP ${response.status})`);
      }
    }

    return response.json();
  }

  /**
   * Get batch operation progress
   */
  async getBatchProgress(jobId: string): Promise<BatchOperationProgress> {
    const response = await fetch(`${this.baseUrl}/batch/${jobId}`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get batch progress');
    }

    return response.json();
  }

  /**
   * Cancel a batch operation
   */
  async cancelBatchOperation(jobId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/batch/${jobId}/cancel`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to cancel batch operation');
    }
  }

  /**
   * Pause a batch operation
   */
  async pauseBatchOperation(jobId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/batch/${jobId}/pause`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to pause batch operation');
    }
  }

  /**
   * Resume a paused batch operation
   */
  async resumeBatchOperation(jobId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/batch/${jobId}/resume`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to resume batch operation');
    }
  }

  /**
   * Get all batch operations for current user
   */
  async getAllBatchOperations(): Promise<BatchOperationResponse[]> {
    const response = await fetch(`${this.baseUrl}/batch-history`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get batch operations');
    }

    // Check if response is JSON before parsing
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      console.error('[BatchOperationsClient] Invalid content type:', contentType);
      throw new Error('Invalid response format: expected JSON');
    }

    const data = await response.json();
    // Handle both direct array and wrapped response
    return Array.isArray(data) ? data : (data.operations || []);
  }

  /**
   * Reschedule a single task
   */
  async rescheduleSingleTask(
    taskId: string,
    newStartTime: Date,
    newEndTime: Date,
    reason = 'Manual reschedule',
  ): Promise<{ success: boolean; conflictDetected: boolean; message: string }> {
    const response = await fetch(`${this.baseUrl}/reschedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        taskId,
        newStartTime: newStartTime.toISOString(),
        newEndTime: newEndTime.toISOString(),
        reason,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to reschedule task');
    }

    const result = await response.json();
    return {
      success: Boolean(result.success),
      conflictDetected: Boolean(result.hadConflicts),
      message: result.message || 'Task rescheduled',
    };
  }

  /**
   * Undo a task reschedule
   */
  async undoReschedule(taskId: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${this.baseUrl}/undo/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to undo reschedule');
    }

    return response.json();
  }

  /**
   * Get schedule history for a task
   */
  async getScheduleHistory(taskId: string): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/history/${encodeURIComponent(taskId)}`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get schedule history');
    }

    const result = await response.json();
    return Array.isArray(result) ? result : (result.history || []);
  }

  /**
   * Get keyboard shortcuts
   */
  async getKeyboardShortcuts(): Promise<Record<string, string>> {
    const response = await fetch(`${this.baseUrl}/shortcuts`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get keyboard shortcuts');
    }

    return response.json();
  }

  /**
   * Save keyboard shortcut customization
   */
  async saveKeyboardShortcut(action: string, keys: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/shortcuts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ action, keys }),
    });

    if (!response.ok) {
      throw new Error('Failed to save keyboard shortcut');
    }
  }

  /**
   * Get performance metrics
   */
  async getPerformanceMetrics(): Promise<Record<string, any>> {
    const response = await fetch(`${this.baseUrl}/metrics`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to get performance metrics');
    }

    return response.json();
  }
}

// Singleton instance
let instance: BatchOperationsClient | null = null;

export function getBatchOperationsClient(): BatchOperationsClient {
  if (!instance) {
    instance = new BatchOperationsClient();
  }
  return instance;
}

export default BatchOperationsClient;
