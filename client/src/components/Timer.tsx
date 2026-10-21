import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, Square, Clock, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface TimerProps {
  taskId: string;
  taskName?: string;
  estimatedHours?: number;
  onTimeUpdate?: (minutes: number) => void;
  compact?: boolean;
}

interface ActiveTimer {
  id: number;
  taskId: string;
  startTime: string;
  notes?: string;
}

export function Timer({ taskId, taskName, estimatedHours, onTimeUpdate, compact = false }: TimerProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const activeTimerSnapshot = useRef<ActiveTimer | null>(null);
  const updateActiveTimer = useCallback((entry: ActiveTimer | null) => {
    activeTimerSnapshot.current = entry;
    setActiveTimer(entry);
  }, []);
  const [loading, setLoading] = useState(true);
  const [totalTrackedMinutes, setTotalTrackedMinutes] = useState<number | null>(null);
  const [historyStatus, setHistoryStatus] = useState<string | null>('Loading history...');
  const [verifiedTaskId, setVerifiedTaskId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const readVersion = useRef(0);
  const currentTaskId = useRef(taskId);
  currentTaskId.current = taskId;
  const isRunning = activeTimer?.taskId === taskId;
  const validEntryId = Number.isSafeInteger(activeTimer?.id) && Number(activeTimer?.id) > 0;
  const controlsUnavailable = pending || Boolean(statusError) || Boolean(actionError) || verifiedTaskId !== taskId;

  // Format seconds to HH:MM:SS
  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Format minutes to hours display
  const formatMinutesToHours = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  };

  const reloadTimer = useCallback(async () => {
    const version = ++readVersion.current;
    setLoading(true);
    setTotalTrackedMinutes(null);
    setHistoryStatus('Loading history...');
    const currentRead = () => version === readVersion.current && currentTaskId.current === taskId;
    const activeRead = (async () => {
      try {
        const activeResponse = await fetch('/api/time-tracking/active');
        if (!activeResponse.ok) throw new Error('Timer status unavailable');
        const data = await activeResponse.json();
        if (typeof data.active !== 'boolean' || (data.active && (!data.entry
          || typeof data.entry.taskId !== 'string' || !Number.isFinite(new Date(data.entry.startTime).getTime())))) {
          throw new Error('Timer status unavailable');
        }
        if (!currentRead()) return;
        updateActiveTimer(data.active ? data.entry : null);
        setElapsedSeconds(data.active && data.entry.taskId === taskId
          ? Math.max(0, Math.floor((Date.now() - new Date(data.entry.startTime).getTime()) / 1000)) : 0);
        setVerifiedTaskId(taskId);
        setStatusError(null);
        setActionError(null);
      } catch {
        if (currentRead()) {
          setStatusError('Timer status could not be loaded. Reload it before changing timers.');
        }
      } finally {
        if (currentRead()) setLoading(false);
      }
    })();
    void (async () => {
      try {
        const response = await fetch(`/api/time-tracking/task/${encodeURIComponent(taskId)}`);
        if (!response.ok) throw new Error('History unavailable');
        const total = await response.json();
        if (!currentRead()) return;
        if (total.complete === false || total.unresolvedEntryCount > 0) {
          setHistoryStatus('History needs owner review');
          return;
        }
        if (total.complete !== true || total.unresolvedEntryCount !== 0
          || !Number.isFinite(total.totalMinutes) || total.totalMinutes < 0) throw new Error('History unavailable');
        setTotalTrackedMinutes(total.totalMinutes);
        setHistoryStatus(null);
      } catch {
        if (currentRead()) setHistoryStatus('History unavailable');
      }
    })();
    await activeRead;
  }, [taskId, updateActiveTimer]);
  const latestReload = useRef(reloadTimer);
  latestReload.current = reloadTimer;

  useEffect(() => {
    void reloadTimer();
    return () => { readVersion.current++; };
  }, [reloadTimer]);

  // Timer tick effect
  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (isRunning) {
      interval = setInterval(() => {
        setElapsedSeconds(prev => {
          const newValue = prev + 1;
          // Notify parent every minute
          if (newValue % 60 === 0 && onTimeUpdate) {
            onTimeUpdate(Math.floor(newValue / 60));
          }
          return newValue;
        });
      }, 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRunning, onTimeUpdate]);

  const handleStart = async () => {
    if (inFlight.current || controlsUnavailable || activeTimer) return;
    inFlight.current = true;
    setPending(true);
    setActionError(null);
    try {
      const response = await fetch('/api/time-tracking/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, notes: taskName }),
      });

      if (!response.ok) {
        if (response.status === 409) await latestReload.current();
        setActionError(response.status === 409
          ? 'Timer status changed. Review it and stop the running timer before starting another.'
          : 'Timer start was not confirmed. Reload status before trying again.');
        return;
      }

      const data = await response.json();
      if (data.success !== true || !Number.isSafeInteger(data.entry?.id) || data.entry.id <= 0 || data.entry.taskId !== taskId) {
        throw new Error('Timer start not confirmed');
      }
      if (currentTaskId.current === taskId) updateActiveTimer(data.entry);
      await latestReload.current();
      toast.success('Timer started');
    } catch {
      setActionError('Timer start was not confirmed. Reload status before trying again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const transitionTimer = async (action: 'pause' | 'stop') => {
    if (inFlight.current || controlsUnavailable) return;
    // Bind the request to the entry on screen, never to a later active entry.
    const entryId = activeTimer?.id;
    if (!isRunning || !Number.isSafeInteger(entryId) || Number(entryId) <= 0) {
      setActionError('This timer could not be identified. Reload its status before trying again.');
      return;
    }
    inFlight.current = true;
    setPending(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/time-tracking/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId }),
      });

      if (!response.ok) {
        if (response.status === 409) await latestReload.current();
        setActionError(response.status === 409
          ? 'Timer status changed. Review the current timer before trying again.'
          : 'The timer change was not confirmed. Reload status before trying again.');
        return;
      }
      const result = await response.json();
      if (result.success !== true || result.entry?.id !== entryId) {
        throw new Error('Timer change not confirmed');
      }
      if (activeTimerSnapshot.current?.id === entryId) {
        updateActiveTimer(null);
        setElapsedSeconds(0);
      }
      await latestReload.current();
      toast.success(action === 'pause' ? 'Timer paused' : 'Timer stopped');
    } catch {
      setActionError('The timer change was not confirmed. Reload status before trying again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const handlePause = () => transitionTimer('pause');
  const handleStop = () => transitionTimer('stop');

  const notice = statusError || actionError || (activeTimer && !validEntryId
    ? 'This timer could not be identified. Reload its status before trying again.'
    : activeTimer && !isRunning ? 'Another task has a running timer. Stop it before starting this task.' : null);
  const statusPanel = notice && <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
    <span>{notice}</span>
    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={pending || loading}
      title="Reload timer status" aria-label="Reload timer status" onClick={() => void reloadTimer()}>
      <RefreshCw className="h-3 w-3" />
    </Button>
  </div>;

  // Calculate progress vs estimate
  const totalMinutesIncludingCurrent = totalTrackedMinutes === null ? null
    : totalTrackedMinutes + (isRunning ? Math.floor(elapsedSeconds / 60) : 0);
  const estimatedMinutes = (estimatedHours || 0) * 60;
  const progressPercent = estimatedMinutes > 0 && totalMinutesIncludingCurrent !== null
    ? Math.min(100, Math.round((totalMinutesIncludingCurrent / estimatedMinutes) * 100))
    : 0;
  const isOverEstimate = totalMinutesIncludingCurrent !== null && totalMinutesIncludingCurrent > estimatedMinutes && estimatedMinutes > 0;
  const historyPanel = historyStatus && <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
    <span>{historyStatus}</span>
    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={pending || loading || historyStatus === 'Loading history...'}
      title="Reload time history" aria-label="Reload time history" onClick={() => void reloadTimer()}>
      <RefreshCw className="h-3 w-3" />
    </Button>
  </div>;

  if (loading || (verifiedTaskId !== taskId && !statusError)) {
    return (
      <div className={cn("flex items-center gap-2", compact ? "text-xs" : "text-sm")}>
        <Clock className="h-4 w-4 animate-pulse" />
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <>
            <span className="font-mono text-sm text-primary animate-pulse">
              {formatTime(elapsedSeconds)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handlePause}
              disabled={controlsUnavailable || !validEntryId}
              title="Pause"
            >
              <Pause className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleStop}
              disabled={controlsUnavailable || !validEntryId}
              title="Stop"
            >
              <Square className="h-3 w-3" />
            </Button>
          </>
        ) : (
          <>
            {totalTrackedMinutes !== null && totalTrackedMinutes > 0 && (
              <span className="text-xs text-muted-foreground">
                {formatMinutesToHours(totalTrackedMinutes)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleStart}
              disabled={controlsUnavailable || Boolean(activeTimer)}
              title="Start Timer"
            >
              <Play className="h-3 w-3" />
            </Button>
          </>
        )}
      </div>
      {statusPanel}
      {historyPanel}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 bg-secondary/30 rounded-lg">
      {/* Timer Display */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className={cn("h-5 w-5", isRunning && "text-primary animate-pulse")} />
          <span className="font-medium">Time Tracking</span>
        </div>
        <span className={cn(
          "font-mono text-xl",
          isRunning && "text-primary"
        )}>
          {formatTime(elapsedSeconds)}
        </span>
      </div>

      {/* Controls */}
      {statusPanel}
      {historyPanel}
      <div className="flex items-center gap-2">
        {!isRunning ? (
          <Button
            variant="default"
            size="sm"
            className="flex-1"
            onClick={handleStart}
            disabled={controlsUnavailable || Boolean(activeTimer)}
          >
            <Play className="h-4 w-4 mr-1" />
            Start
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handlePause}
              disabled={controlsUnavailable || !validEntryId}
            >
              <Pause className="h-4 w-4 mr-1" />
              Pause
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1"
              onClick={handleStop}
              disabled={controlsUnavailable || !validEntryId}
            >
              <Square className="h-4 w-4 mr-1" />
              Stop
            </Button>
          </>
        )}
      </div>

      {/* Progress vs Estimate */}
      {estimatedHours && estimatedHours > 0 && totalMinutesIncludingCurrent !== null && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Progress vs Estimate</span>
            <span className={cn(isOverEstimate && "text-destructive font-medium")}>
              {formatMinutesToHours(totalMinutesIncludingCurrent)} / {estimatedHours}h
              {isOverEstimate && ' (over)'}
            </span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div 
              className={cn(
                "h-full transition-all duration-300",
                isOverEstimate ? "bg-destructive" : "bg-primary"
              )}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Total Tracked */}
      <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t">
        <span>Total Tracked</span>
        <span className="font-medium">
          {totalMinutesIncludingCurrent === null ? 'Unavailable' : formatMinutesToHours(totalMinutesIncludingCurrent)}
        </span>
      </div>
    </div>
  );
}

export default Timer;
