import { useState, useCallback, useEffect } from 'react';
import {
  getBatchOperationsClient,
  normalizeBatchOperationResponse,
  type BatchOperationRequest,
  type NormalizedBatchOperation,
} from '@/lib/batch-operations-client';
import { useBatchOperationUpdates } from './useBatchOperationUpdates';

type BatchOperation = NormalizedBatchOperation;

export function shouldPollBatchOperations(
  operations: readonly Pick<BatchOperation, 'status'>[],
) {
  return operations.some(operation => operation.status === 'pending' || operation.status === 'running');
}

interface UseBatchOperationsOptions {
  autoLoad?: boolean;
  pollInterval?: number;
}

export const useBatchOperations = (options: UseBatchOperationsOptions = {}) => {
  const { autoLoad = true, pollInterval = 5000 } = options;

  const [operations, setOperations] = useState<BatchOperation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const client = getBatchOperationsClient();

  // Load all batch operations
  const loadOperations = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const ops = await client.getAllBatchOperations();
      setOperations(ops.map(normalizeBatchOperationResponse));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      console.error('[useBatchOperations] Failed to load operations:', error);
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  // Start a new batch operation
  const startBatchOperation = useCallback(
    async (request: BatchOperationRequest) => {
      try {
        setError(null);
        const response = await client.startBatchOperation(request);
        const newOp = normalizeBatchOperationResponse(response);
        setOperations(prev => [newOp, ...prev]);
        return response;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [client]
  );

  // Cancel a batch operation
  const cancelBatchOperation = useCallback(
    async (jobId: string) => {
      try {
        setError(null);
        await client.cancelBatchOperation(jobId);
        setOperations(prev =>
          prev.map(op =>
            op.jobId === jobId ? { ...op, status: 'cancelled' as const } : op
          )
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [client]
  );

  // Pause a batch operation
  const pauseBatchOperation = useCallback(
    async (jobId: string) => {
      try {
        setError(null);
        await client.pauseBatchOperation(jobId);
        setOperations(prev =>
          prev.map(op =>
            op.jobId === jobId ? { ...op, isPaused: true } : op
          )
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [client]
  );

  // Resume a batch operation
  const resumeBatchOperation = useCallback(
    async (jobId: string) => {
      try {
        setError(null);
        await client.resumeBatchOperation(jobId);
        setOperations(prev =>
          prev.map(op =>
            op.jobId === jobId ? { ...op, isPaused: false } : op
          )
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      }
    },
    [client]
  );

  // Update operation progress from WebSocket
  const updateOperationProgress = useCallback((update: any) => {
    setOperations(prev =>
      prev.map(op =>
        op.jobId === update.jobId
          ? {
              ...op,
              progress: update.progress,
              status: update.status,
              completedTasks: update.completedTasks,
              failedTasks: update.failedTasks,
              currentTaskName: update.currentTaskName,
              currentTaskIndex: update.currentTaskIndex,
              elapsedTimeSeconds: update.elapsedTimeSeconds,
              estimatedTimeSeconds: update.estimatedTimeSeconds,
              errorLog: update.errorLog,
              results: update.results,
              isPaused: update.isPaused,
              pausedAt: update.pausedAt,
              completedAt: update.status === 'completed' ? new Date() : op.completedAt,
            }
          : op
      )
    );
  }, []);

  // Auto-load operations on mount
  useEffect(() => {
    if (autoLoad) {
      loadOperations();
    }
  }, [autoLoad, loadOperations]);

  const shouldPoll = shouldPollBatchOperations(operations);

  // WebSocket handles real-time updates. Poll only while a job is active so
  // an idle scheduling page does not request batch history every five seconds.
  useEffect(() => {
    if (!autoLoad || !shouldPoll) return;

    const interval = setInterval(() => {
      loadOperations();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [autoLoad, shouldPoll, pollInterval, loadOperations]);

  // One stable Socket.IO subscription handles all active jobs. Polling remains
  // as a durable fallback when real-time transport is unavailable.
  const activeJobIds = operations
    .filter(op => op.status === 'pending' || op.status === 'running')
    .map(op => op.jobId);
  useBatchOperationUpdates({
    jobIds: activeJobIds,
    onUpdate: updateOperationProgress,
  });

  return {
    operations,
    isLoading,
    error,
    loadOperations,
    startBatchOperation,
    cancelBatchOperation,
    pauseBatchOperation,
    resumeBatchOperation,
    updateOperationProgress,
  };
};

export default useBatchOperations;
