import React, { useState, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { 
  AlertTriangle,
  Loader2, 
  Calendar, 
  Zap,
  HelpCircle,
  Settings,
  RotateCcw
} from 'lucide-react';
import { AdvancedSchedulingCalendar } from '@/components/AdvancedSchedulingCalendar';
import { BatchOperationsQueue } from '@/components/BatchOperationsQueue';
import { useBatchOperations } from '@/hooks/useBatchOperations';
import { getBatchOperationsClient, selectBatchOperationForPause } from '@/lib/batch-operations-client';
import { ConflictDetectionSettings, type ConflictDetectionConfig } from '@/components/scheduling-settings/ConflictDetectionSettings';
import { BatchOperationDefaults, type BatchOperationDefaultsConfig } from '@/components/scheduling-settings/BatchOperationDefaults';
import { KeyboardShortcutsSettings, type KeyboardShortcut } from '@/components/scheduling-settings/KeyboardShortcutsSettings';
import { PerformanceMetrics } from '@/components/scheduling-settings/PerformanceMetrics';

const DEFAULT_SHORTCUTS: (KeyboardShortcut & { isCustom?: boolean })[] = [
  // Navigation
  { action: 'focus-calendar', keys: 'Ctrl+1', description: 'Focus calendar view', category: 'navigation' },
  { action: 'focus-queue', keys: 'Ctrl+2', description: 'Focus batch operations queue', category: 'navigation' },
  { action: 'focus-shortcuts', keys: 'Ctrl+?', description: 'Show keyboard shortcuts', category: 'navigation' },

  // Scheduling
  { action: 'reschedule-task', keys: 'Ctrl+R', description: 'Reschedule selected task', category: 'scheduling' },
  { action: 'undo-reschedule', keys: 'Ctrl+Z', description: 'Undo last reschedule', category: 'scheduling' },
  { action: 'view-history', keys: 'Ctrl+H', description: 'View schedule history', category: 'scheduling' },
  { action: 'next-day', keys: 'Right Arrow', description: 'Move to next day', category: 'scheduling' },
  { action: 'prev-day', keys: 'Left Arrow', description: 'Move to previous day', category: 'scheduling' },

  // Batch Operations
  { action: 'start-batch', keys: 'Ctrl+B', description: 'Start batch operation', category: 'batch' },
  { action: 'pause-batch', keys: 'Ctrl+P', description: 'Pause running batch', category: 'batch' },
  { action: 'resume-batch', keys: 'Ctrl+Shift+P', description: 'Resume paused batch', category: 'batch' },
  { action: 'cancel-batch', keys: 'Ctrl+X', description: 'Cancel running batch', category: 'batch' },
  { action: 'batch-reanalyze', keys: 'Ctrl+Shift+R', description: 'Batch re-analyze tasks', category: 'batch' },
  { action: 'batch-reschedule', keys: 'Ctrl+Shift+S', description: 'Batch reschedule tasks', category: 'batch' },

  // General
  { action: 'refresh', keys: 'F5', description: 'Refresh all data', category: 'general' },
  { action: 'settings', keys: 'Ctrl+,', description: 'Open settings', category: 'general' },
];

type SchedulingAssignment = {
  taskId: string;
  cardName: string;
  vaId: number | null;
  priority: string;
  status: string;
  complexity?: string | number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
};

type CalendarTask = {
  id: string;
  title: string;
  cardTrelloId?: string;
  startTime: Date;
  endTime: Date;
  priority: 'critical' | 'high' | 'medium' | 'low';
  complexity?: number;
  status: 'pending' | 'in-progress' | 'completed';
};

type CalendarHistory = {
  id: string;
  taskId: string;
  previousStartTime?: Date;
  previousEndTime?: Date;
  newStartTime: Date;
  newEndTime: Date;
  reason?: string;
  hadConflicts: boolean;
  createdAt: Date;
};

async function readApiError(response: Response) {
  const body = await response.json().catch(() => null);
  return body?.error || body?.message || `Request failed with status ${response.status}`;
}

function normalizePriority(priority: string): CalendarTask['priority'] {
  const value = priority.toLowerCase();
  if (value === 'critical' || value === 'urgent' || value === 'drop_everything') return 'critical';
  if (value === 'high') return 'high';
  if (value === 'low') return 'low';
  return 'medium';
}

function normalizeStatus(status: string): CalendarTask['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in-progress';
  return 'pending';
}

export default function AdvancedScheduling() {
  const [activeTab, setActiveTab] = useState('calendar');
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [shortcuts, setShortcuts] = useState<KeyboardShortcut[]>(DEFAULT_SHORTCUTS);
  const [isLoadingShortcuts, setIsLoadingShortcuts] = useState(false);
  const [showConflictSettings, setShowConflictSettings] = useState(false);
  const [showBatchDefaults, setShowBatchDefaults] = useState(false);
  const [showKeyboardSettings, setShowKeyboardSettings] = useState(false);
  const [showPerformanceMetrics, setShowPerformanceMetrics] = useState(false);
  const [calendarTasks, setCalendarTasks] = useState<CalendarTask[]>([]);
  const [scheduleHistory, setScheduleHistory] = useState<CalendarHistory[]>([]);
  const [isLoadingCalendar, setIsLoadingCalendar] = useState(true);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  const {
    operations,
    isLoading: isLoadingOps,
    error: opsError,
    cancelBatchOperation,
    pauseBatchOperation,
    resumeBatchOperation,
    loadOperations,
  } = useBatchOperations({ autoLoad: true, pollInterval: 5000 });

  const client = getBatchOperationsClient();

  const loadCalendarTasks = useCallback(async () => {
    setIsLoadingCalendar(true);
    setCalendarError(null);
    try {
      const response = await fetch('/api/va/assignments', { credentials: 'include' });
      if (!response.ok) throw new Error(await readApiError(response));
      const assignments = await response.json() as SchedulingAssignment[];
      if (!Array.isArray(assignments)) throw new Error('Scheduling assignments response is invalid');

      const tasks = assignments
        .filter((assignment) => assignment.vaId && assignment.scheduledStart && assignment.scheduledEnd)
        .map((assignment): CalendarTask => ({
          id: assignment.taskId,
          title: assignment.cardName,
          cardTrelloId: assignment.taskId.split(':')[0],
          startTime: new Date(assignment.scheduledStart!),
          endTime: new Date(assignment.scheduledEnd!),
          priority: normalizePriority(assignment.priority),
          complexity: typeof assignment.complexity === 'number' ? assignment.complexity : undefined,
          status: normalizeStatus(assignment.status),
        }))
        .filter((task) => Number.isFinite(task.startTime.getTime()) && Number.isFinite(task.endTime.getTime()));
      setCalendarTasks(tasks);
    } catch (error) {
      setCalendarTasks([]);
      setCalendarError(error instanceof Error ? error.message : 'Failed to load scheduled assignments');
    } finally {
      setIsLoadingCalendar(false);
    }
  }, []);

  React.useEffect(() => {
    void loadCalendarTasks();
  }, [loadCalendarTasks]);

  const handleTaskReschedule = useCallback(async (
    taskId: string,
    newStartTime: Date,
    newEndTime: Date,
    reason?: string,
  ) => {
    const task = calendarTasks.find((item) => item.id === taskId);
    const response = await fetch('/api/scheduling/reschedule', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        cardTrelloId: task?.cardTrelloId,
        newStartTime: newStartTime.toISOString(),
        newEndTime: newEndTime.toISOString(),
        reason,
      }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const result = await response.json();

    setCalendarTasks((current) => current.map((item) => item.id === taskId
      ? { ...item, startTime: newStartTime, endTime: newEndTime }
      : item));
    setScheduleHistory((current) => [{
      id: result.historyId,
      taskId,
      previousStartTime: result.previousStartTime ? new Date(result.previousStartTime) : undefined,
      previousEndTime: result.previousEndTime ? new Date(result.previousEndTime) : undefined,
      newStartTime,
      newEndTime,
      reason,
      hadConflicts: Boolean(result.hadConflicts),
      createdAt: new Date(),
    }, ...current.filter((entry) => entry.taskId !== taskId)]);
  }, [calendarTasks]);

  const handleUndoReschedule = useCallback(async (taskId: string) => {
    const response = await fetch(`/api/scheduling/undo/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const result = await response.json();
    const restoredStartTime = new Date(result.restoredStartTime);
    const restoredEndTime = new Date(result.restoredEndTime);
    setCalendarTasks((current) => current.map((item) => item.id === taskId
      ? { ...item, startTime: restoredStartTime, endTime: restoredEndTime }
      : item));
    setScheduleHistory((current) => current.filter((entry) => entry.taskId !== taskId));
  }, []);

  // Load keyboard shortcuts
  const loadShortcuts = useCallback(async () => {
    try {
      setIsLoadingShortcuts(true);
      const loaded = await client.getKeyboardShortcuts();
      // Merge loaded shortcuts with defaults
      const merged = DEFAULT_SHORTCUTS.map(def => ({
        ...def,
        keys: loaded[def.action] || def.keys,
      }));
      setShortcuts(merged);
    } catch (err) {
      console.error('Failed to load shortcuts:', err);
      // Keep defaults on error
    } finally {
      setIsLoadingShortcuts(false);
    }
  }, [client]);

  React.useEffect(() => {
    void loadShortcuts();
  }, [loadShortcuts]);

  const getPrimaryRunningOperation = useCallback(() => {
    return operations.find(op => op.status === 'running') || null;
  }, [operations]);

  const handlePauseToggle = useCallback(async (requestedJobId?: string) => {
    const active = selectBatchOperationForPause(operations, requestedJobId);
    if (!active) return;

    if (active.isPaused) {
      await resumeBatchOperation(active.jobId);
    } else {
      await pauseBatchOperation(active.jobId);
    }
  }, [operations, pauseBatchOperation, resumeBatchOperation]);

  // Handle keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`;

      // Find matching shortcut
      const shortcut = shortcuts.find(s => s.keys === key);
      if (!shortcut) return;

      e.preventDefault();

      switch (shortcut.action) {
        case 'focus-calendar':
          setActiveTab('calendar');
          break;
        case 'focus-queue':
          setActiveTab('queue');
          break;
        case 'pause-batch':
          void handlePauseToggle();
          break;
        case 'resume-batch': {
          const active = getPrimaryRunningOperation();
          if (active?.isPaused) {
            void resumeBatchOperation(active.jobId);
          }
          break;
        }
        case 'cancel-batch': {
          const active = getPrimaryRunningOperation();
          if (active) {
            void cancelBatchOperation(active.jobId);
          }
          break;
        }
        case 'focus-shortcuts':
          setShowShortcutsHelp(prev => !prev);
          break;
        case 'refresh':
          loadOperations();
          break;
        default:
          console.log('Shortcut triggered:', shortcut.action);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, showShortcutsHelp, loadOperations, handlePauseToggle, getPrimaryRunningOperation, cancelBatchOperation, resumeBatchOperation]);

  const runningOps = operations.filter(op => op.status === 'running');
  const pendingOps = operations.filter(op => op.status === 'pending');

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Advanced Scheduling</h1>
            <p className="text-muted-foreground">
              Manage task schedules with drag-and-drop calendar and batch operations
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setShowShortcutsHelp(!showShortcutsHelp)}
              title="Keyboard shortcuts (Ctrl+?)"
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => { loadOperations(); void loadCalendarTasks(); }}
              disabled={isLoadingOps || isLoadingCalendar}
              aria-label="Refresh scheduling data"
            >
              {isLoadingOps || isLoadingCalendar ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* Status Bar */}
        <div className="flex gap-4">
          {runningOps.length > 0 && (
            <Badge variant="default" className="bg-green-600">
              <Zap className="h-3 w-3 mr-1" />
              {runningOps.length} Running
            </Badge>
          )}
          {pendingOps.length > 0 && (
            <Badge variant="secondary">
              <Calendar className="h-3 w-3 mr-1" />
              {pendingOps.length} Pending
            </Badge>
          )}
          {opsError && (
            <Badge variant="destructive">
              Error: {opsError.message}
            </Badge>
          )}
        </div>
      </div>

      {/* Keyboard Shortcuts Help */}
      {showShortcutsHelp && (
        <Card className="border-blue-200 bg-blue-50 dark:bg-blue-950 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-lg">Keyboard Shortcuts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {['navigation', 'scheduling', 'batch', 'general'].map(category => (
                <div key={category}>
                  <h3 className="font-semibold mb-3 capitalize">{category}</h3>
                  <div className="space-y-2">
                    {shortcuts
                      .filter(s => s.category === category)
                      .map(s => (
                        <div key={s.action} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{s.description}</span>
                          <kbd className="px-2 py-1 bg-background border rounded text-xs font-mono">
                            {s.keys}
                          </kbd>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="calendar" className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Calendar
          </TabsTrigger>
          <TabsTrigger value="queue" className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Batch Queue
            {runningOps.length > 0 && (
              <Badge variant="default" className="ml-2 text-xs">
                {runningOps.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Calendar Tab */}
        <TabsContent value="calendar" className="space-y-4">
          {calendarError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Scheduling data unavailable</AlertTitle>
              <AlertDescription>{calendarError}</AlertDescription>
            </Alert>
          )}
          {!calendarError && !isLoadingCalendar && calendarTasks.length === 0 && (
            <Alert>
              <Calendar className="h-4 w-4" />
              <AlertTitle>No scheduled assignments</AlertTitle>
              <AlertDescription>
                Assign a worker and set both a start and end time before a task appears on this calendar.
              </AlertDescription>
            </Alert>
          )}
          <AdvancedSchedulingCalendar 
            tasks={calendarTasks}
            scheduleHistory={scheduleHistory}
            isLoading={isLoadingCalendar}
            onTaskReschedule={handleTaskReschedule}
            onUndo={handleUndoReschedule}
          />
        </TabsContent>

        {/* Batch Queue Tab */}
        <TabsContent value="queue" className="space-y-4">
          <BatchOperationsQueue
            operations={operations}
            onCancel={cancelBatchOperation}
            onPauseToggle={handlePauseToggle}
            isLoading={isLoadingOps}
          />
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Scheduling Settings</CardTitle>
              <CardDescription>Configure advanced scheduling options</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Conflict Detection */}
              <div className="space-y-2">
                <h3 className="font-semibold">Conflict Detection</h3>
                <p className="text-sm text-muted-foreground">
                  Automatically detect and warn about scheduling conflicts
                </p>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowConflictSettings(true)}
                >
                  Configure
                </Button>
              </div>

              {/* Batch Operation Defaults */}
              <div className="space-y-2">
                <h3 className="font-semibold">Batch Operation Defaults</h3>
                <p className="text-sm text-muted-foreground">
                  Set default options for batch operations
                </p>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowBatchDefaults(true)}
                >
                  Configure
                </Button>
              </div>

              {/* Keyboard Shortcuts */}
              <div className="space-y-2">
                <h3 className="font-semibold">Keyboard Shortcuts</h3>
                <p className="text-sm text-muted-foreground">
                  Customize keyboard shortcuts for common actions
                </p>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowKeyboardSettings(true)}
                >
                  Customize Shortcuts
                </Button>
              </div>

              {/* Performance Metrics */}
              <div className="space-y-2">
                <h3 className="font-semibold">Performance Metrics</h3>
                <p className="text-sm text-muted-foreground">
                  View scheduling performance and optimization suggestions
                </p>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowPerformanceMetrics(true)}
                >
                  View Metrics
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Settings Dialogs */}
      <ConflictDetectionSettings
        open={showConflictSettings}
        onOpenChange={setShowConflictSettings}
      />

      <BatchOperationDefaults
        open={showBatchDefaults}
        onOpenChange={setShowBatchDefaults}
      />

      <KeyboardShortcutsSettings
        open={showKeyboardSettings}
        onOpenChange={setShowKeyboardSettings}
      />

      <PerformanceMetrics
        open={showPerformanceMetrics}
        onOpenChange={setShowPerformanceMetrics}
      />
    </div>
  );
}
