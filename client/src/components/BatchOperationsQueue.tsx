import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Loader2, 
  Trash2, 
  Eye,
  EyeOff,
  RotateCcw
} from 'lucide-react';
import { BatchOperationsProgress } from './BatchOperationsProgress';
import type { NormalizedBatchOperation } from '@/lib/batch-operations-client';

type BatchOperation = NormalizedBatchOperation;

interface BatchOperationsQueueProps {
  operations: BatchOperation[];
  onCancel?: (jobId: string) => Promise<void>;
  onRetry?: (jobId: string) => Promise<void>;
  onPauseToggle?: (jobId: string) => Promise<void>;
  onClear?: () => Promise<void>;
  isLoading?: boolean;
}

export const BatchOperationsQueue: React.FC<BatchOperationsQueueProps> = ({
  operations = [],
  onCancel,
  onRetry,
  onPauseToggle,
  onClear,
  isLoading = false
}) => {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set());
  const [isClearing, setIsClearing] = useState(false);

  const runningOps = operations.filter(op => op.status === 'running');
  const pendingOps = operations.filter(op => op.status === 'pending');
  const completedOps = operations.filter(op => op.status === 'completed');
  const failedOps = operations.filter(op => op.status === 'failed');
  const cancelledOps = operations.filter(op => op.status === 'cancelled');

  const toggleHideStatus = (status: string) => {
    const newHidden = new Set(hiddenStatuses);
    if (newHidden.has(status)) {
      newHidden.delete(status);
    } else {
      newHidden.add(status);
    }
    setHiddenStatuses(newHidden);
  };

  const handleClear = useCallback(async () => {
    if (!onClear) return;
    setIsClearing(true);
    try {
      await onClear();
    } finally {
      setIsClearing(false);
    }
  }, [onClear]);

  const getFilteredOps = (ops: BatchOperation[]) => {
    return ops.filter(op => !hiddenStatuses.has(op.status));
  };

  const renderOperationList = (ops: BatchOperation[], statusLabel: string) => {
    const filtered = getFilteredOps(ops);
    if (filtered.length === 0) return null;

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-sm font-semibold">{statusLabel}</h3>
          <Badge variant="outline">{filtered.length}</Badge>
        </div>
        <div className="space-y-2">
          {filtered.map(op => (
            <div key={op.jobId} className="border rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedJobId(expandedJobId === op.jobId ? null : op.jobId)}
                className="w-full p-3 hover:bg-muted/50 transition-colors text-left"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="font-medium text-sm">
                      {op.operationType.replace(/_/g, ' ').toUpperCase()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {op.completedTasks}/{op.totalTasks} tasks • {op.progress}%
                    </div>
                  </div>
                  <Badge variant="outline" className="ml-2">
                    {op.status}
                  </Badge>
                </div>
              </button>
              {expandedJobId === op.jobId && (
                <div className="border-t p-3 bg-muted/30">
                  <BatchOperationsProgress
                    operation={op}
                    onCancel={onCancel}
                    onRetry={onRetry}
                    onPauseToggle={onPauseToggle}
                    isPaused={op.isPaused}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (operations.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center py-8">
            <div className="text-muted-foreground mb-2">No batch operations</div>
            <p className="text-sm text-muted-foreground">
              Batch operations will appear here when you start them
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Batch Operations Queue</CardTitle>
            <CardDescription>
              {runningOps.length} running • {pendingOps.length} pending • {completedOps.length} completed
            </CardDescription>
          </div>
          {completedOps.length > 0 && onClear && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleClear}
              disabled={isClearing}
            >
              {isClearing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Clear Completed
                </>
              )}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="all" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="all">
              All
              <Badge variant="outline" className="ml-1 text-xs">
                {operations.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="running" disabled={runningOps.length === 0}>
              Running
              <Badge variant="outline" className="ml-1 text-xs">
                {runningOps.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="pending" disabled={pendingOps.length === 0}>
              Pending
              <Badge variant="outline" className="ml-1 text-xs">
                {pendingOps.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="completed" disabled={completedOps.length === 0}>
              Completed
              <Badge variant="outline" className="ml-1 text-xs">
                {completedOps.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="failed" disabled={failedOps.length === 0}>
              Failed
              <Badge variant="outline" className="ml-1 text-xs">
                {failedOps.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <div className="mt-4 space-y-4">
            {/* Visibility Controls */}
            <div className="flex gap-2 flex-wrap">
              {['running', 'pending', 'completed', 'failed', 'cancelled'].map(status => {
                const count = operations.filter(op => op.status === status).length;
                if (count === 0) return null;
                return (
                  <button
                    key={status}
                    onClick={() => toggleHideStatus(status)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs border hover:bg-muted/50 transition-colors"
                  >
                    {hiddenStatuses.has(status) ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                    {status}
                  </button>
                );
              })}
            </div>

            {/* Tab Contents */}
            <TabsContent value="all" className="space-y-6">
              {runningOps.length > 0 && renderOperationList(runningOps, 'Running Operations')}
              {pendingOps.length > 0 && renderOperationList(pendingOps, 'Pending Operations')}
              {completedOps.length > 0 && renderOperationList(completedOps, 'Completed Operations')}
              {failedOps.length > 0 && renderOperationList(failedOps, 'Failed Operations')}
              {cancelledOps.length > 0 && renderOperationList(cancelledOps, 'Cancelled Operations')}
            </TabsContent>

            <TabsContent value="running">
              {renderOperationList(runningOps, 'Running Operations')}
            </TabsContent>

            <TabsContent value="pending">
              {renderOperationList(pendingOps, 'Pending Operations')}
            </TabsContent>

            <TabsContent value="completed">
              {renderOperationList(completedOps, 'Completed Operations')}
            </TabsContent>

            <TabsContent value="failed">
              {renderOperationList(failedOps, 'Failed Operations')}
            </TabsContent>
          </div>
        </Tabs>
      </CardContent>
    </Card>
  );
};

export default BatchOperationsQueue;
