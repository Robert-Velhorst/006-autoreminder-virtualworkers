import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Loader2, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  Pause, 
  Play, 
  X,
  Clock,
  Zap
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  getBatchTaskPosition,
  type BatchOperationTask,
  type NormalizedBatchOperation,
} from '@/lib/batch-operations-client';

type Task = BatchOperationTask;
type BatchOperation = NormalizedBatchOperation;

interface BatchOperationsProgressProps {
  operation: BatchOperation;
  onCancel?: (jobId: string) => Promise<void>;
  onRetry?: (jobId: string) => Promise<void>;
  isPaused?: boolean;
  onPauseToggle?: (jobId: string) => Promise<void>;
}

const getStatusColor = (status: string) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800 border-green-300';
    case 'failed':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'running':
      return 'bg-blue-100 text-blue-800 border-blue-300';
    case 'pending':
      return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'cancelled':
      return 'bg-gray-100 text-gray-800 border-gray-300';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-300';
  }
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    case 'failed':
      return <XCircle className="h-5 w-5 text-red-600" />;
    case 'running':
      return <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />;
    case 'pending':
      return <Clock className="h-5 w-5 text-yellow-600" />;
    case 'cancelled':
      return <X className="h-5 w-5 text-gray-600" />;
    default:
      return null;
  }
};

const getOperationLabel = (type: string) => {
  switch (type) {
    case 're_analyze':
      return 'Re-Analyze Tasks';
    case 'reschedule':
      return 'Reschedule Tasks';
    case 'conflict_resolution':
      return 'Resolve Conflicts';
    case 'optimization':
      return 'Optimize Schedule';
    default:
      return 'Batch Operation';
  }
};

export const BatchOperationsProgress: React.FC<BatchOperationsProgressProps> = ({
  operation,
  onCancel,
  onRetry,
  isPaused = false,
  onPauseToggle
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (operation.status !== 'running' || !operation.startedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [operation.status, operation.startedAt]);

  const persistedElapsed = operation.elapsedTimeSeconds || 0;
  const startedAt = operation.startedAt?.getTime();
  const elapsedTime = operation.status === 'running' && startedAt
    ? Math.max(persistedElapsed, Math.floor((now - startedAt) / 1000))
    : persistedElapsed;
  const estimatedTotal = operation.estimatedTimeSeconds || 0;
  const remainingTime = Math.max(0, estimatedTotal - elapsedTime);
  const successRate = operation.totalTasks > 0 
    ? Math.round((operation.completedTasks / operation.totalTasks) * 100)
    : 0;

  const handleCancel = useCallback(async () => {
    if (!onCancel) return;
    setIsLoading(true);
    try {
      await onCancel(operation.jobId);
    } finally {
      setIsLoading(false);
    }
  }, [operation.jobId, onCancel]);

  const handleRetry = useCallback(async () => {
    if (!onRetry) return;
    setIsLoading(true);
    try {
      await onRetry(operation.jobId);
    } finally {
      setIsLoading(false);
    }
  }, [operation.jobId, onRetry]);

  const handlePauseToggle = useCallback(async () => {
    if (!onPauseToggle) return;
    setIsLoading(true);
    try {
      await onPauseToggle(operation.jobId);
    } finally {
      setIsLoading(false);
    }
  }, [operation.jobId, onPauseToggle]);

  const failedTasks = operation.tasks.filter(t => t.status === 'failed');
  const completedTasks = operation.tasks.filter(t => t.status === 'completed');
  const runningTasks = operation.tasks.filter(t => t.status === 'running');

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {getStatusIcon(operation.status)}
            <div>
              <CardTitle className="flex items-center gap-2">
                {getOperationLabel(operation.operationType)}
                <Badge className={getStatusColor(operation.status)}>
                  {operation.status.charAt(0).toUpperCase() + operation.status.slice(1)}
                </Badge>
              </CardTitle>
              <CardDescription>
                Started {formatDistanceToNow(new Date(operation.createdAt), { addSuffix: true })}
              </CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            {operation.status === 'running' && onPauseToggle && (
              <Button
                size="sm"
                variant="outline"
                onClick={handlePauseToggle}
                disabled={isLoading}
              >
                {isPaused ? (
                  <>
                    <Play className="h-4 w-4 mr-1" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-4 w-4 mr-1" />
                    Pause
                  </>
                )}
              </Button>
            )}
            {operation.status === 'running' && onCancel && (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleCancel}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <X className="h-4 w-4 mr-1" />
                    Cancel
                  </>
                )}
              </Button>
            )}
            {operation.status === 'failed' && onRetry && (
              <Button
                size="sm"
                variant="default"
                onClick={handleRetry}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Zap className="h-4 w-4 mr-1" />
                    Retry
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Overall Progress</span>
            <span className="text-sm font-semibold">{operation.progress}%</span>
          </div>
          <Progress value={operation.progress} className="h-3" />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
            <div className="text-xs text-blue-600 font-medium">Total Tasks</div>
            <div className="text-2xl font-bold text-blue-900">{operation.totalTasks}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-3 border border-green-200">
            <div className="text-xs text-green-600 font-medium">Completed</div>
            <div className="text-2xl font-bold text-green-900">{operation.completedTasks}</div>
          </div>
          <div className="bg-red-50 rounded-lg p-3 border border-red-200">
            <div className="text-xs text-red-600 font-medium">Failed</div>
            <div className="text-2xl font-bold text-red-900">{operation.failedTasks}</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-3 border border-purple-200">
            <div className="text-xs text-purple-600 font-medium">Success Rate</div>
            <div className="text-2xl font-bold text-purple-900">{successRate}%</div>
          </div>
        </div>

        {/* Time Information */}
        {(elapsedTime > 0 || remainingTime > 0) && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Elapsed Time</span>
              <div className="font-semibold">
                {Math.floor(elapsedTime / 60)}m {elapsedTime % 60}s
              </div>
            </div>
            {remainingTime > 0 && (
              <div>
                <span className="text-muted-foreground">Estimated Remaining</span>
                <div className="font-semibold">
                  {Math.floor(remainingTime / 60)}m {remainingTime % 60}s
                </div>
              </div>
            )}
            {operation.completedAt && (
              <div>
                <span className="text-muted-foreground">Completed At</span>
                <div className="font-semibold">
                  {format(new Date(operation.completedAt), 'HH:mm:ss')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Current Task */}
        {operation.currentTaskName && operation.status === 'running' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="text-xs text-blue-600 font-medium mb-1">Currently Processing</div>
            <div className="text-sm font-semibold text-blue-900 truncate">
              {operation.currentTaskName}
            </div>
            <div className="text-xs text-blue-600 mt-1">
              Task {getBatchTaskPosition(operation.currentTaskIndex, operation.totalTasks)} of {operation.totalTasks}
            </div>
          </div>
        )}

        {/* Error Messages */}
        {operation.errorLog && operation.errorLog.length > 0 && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <div className="font-semibold mb-2">Errors ({operation.errorLog.length})</div>
              <div className="space-y-1 text-sm max-h-32 overflow-y-auto">
                {operation.errorLog.slice(0, 3).map((error, idx) => (
                  <div key={idx} className="text-xs">
                    • {error}
                  </div>
                ))}
                {operation.errorLog.length > 3 && (
                  <div className="text-xs text-muted-foreground">
                    ... and {operation.errorLog.length - 3} more errors
                  </div>
                )}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Task List */}
        {operation.tasks.length > 0 && <div className="space-y-2">
          <button
            onClick={() => setExpandedTasks(!expandedTasks)}
            className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors"
          >
            <span>Task Details</span>
            <Badge variant="outline">
              {completedTasks.length}/{operation.totalTasks}
            </Badge>
          </button>

          {expandedTasks && (
            <div className="space-y-2 mt-3 max-h-64 overflow-y-auto">
              {operation.tasks.map((task, idx) => (
                <div
                  key={task.id}
                  className="flex items-center gap-3 p-2 rounded border text-sm"
                >
                  <div className="flex-shrink-0">
                    {task.status === 'completed' && (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    )}
                    {task.status === 'failed' && (
                      <XCircle className="h-4 w-4 text-red-600" />
                    )}
                    {task.status === 'running' && (
                      <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
                    )}
                    {task.status === 'pending' && (
                      <Clock className="h-4 w-4 text-yellow-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{task.name}</div>
                    {task.error && (
                      <div className="text-xs text-red-600 truncate">{task.error}</div>
                    )}
                  </div>
                  <Badge variant="outline" className="flex-shrink-0">
                    {task.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>}

        {/* Results Summary */}
        {operation.status === 'completed' && operation.results && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <div className="text-sm font-semibold text-green-900 mb-2">
              {operation.failedTasks > 0
                ? 'Batch operation completed with issues'
                : '✓ Batch operation completed successfully'}
            </div>
            <div className="text-xs text-green-700">
              Processed {operation.completedTasks} tasks in{' '}
              {operation.elapsedTimeSeconds ? `${Math.floor(operation.elapsedTimeSeconds / 60)}m` : 'N/A'}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default BatchOperationsProgress;
