import { Task } from "@/types";
import { TaskCard } from "./TaskCard";
import { AtisAnalysisDialog } from "./AtisAnalysisDialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TimelineSkeleton, EmptyState } from "./Skeletons";
import { CalendarX, RefreshCw, CheckSquare, Square, Brain, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface TimelineProps {
  tasks: Task[];
  onToggleTask: (id: string) => void;
  isLoading?: boolean;
  onRefresh?: () => void;
  onSync?: () => void;
  isSyncing?: boolean;
  allExpanded?: boolean;
  onExpandChange?: (expanded: boolean) => void;
  onStartInterview?: (task: Task) => void;
  viewMode?: 'day' | 'week' | 'all';
}

export function Timeline({ tasks, onToggleTask, isLoading, onRefresh, onSync, isSyncing, allExpanded, onExpandChange, onStartInterview, viewMode = 'all' }: TimelineProps) {
  // Track individual card expansion states
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  
  // Batch selection state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [batchReanalyzing, setBatchReanalyzing] = useState(false);
  const [analysisIds, setAnalysisIds] = useState<number[] | null>(null);

  // Sync with allExpanded prop
  useEffect(() => {
    if (allExpanded !== undefined) {
      if (allExpanded) {
        // Expand all cards
        setExpandedCards(new Set(tasks.map(t => t.id)));
      } else {
        // Collapse all cards
        setExpandedCards(new Set());
      }
    }
  }, [allExpanded, tasks]);

  // Clear selection when exiting selection mode
  useEffect(() => {
    if (!selectionMode) {
      setSelectedTasks(new Set());
    }
  }, [selectionMode]);

  const handleCardExpandChange = (taskId: string, expanded: boolean) => {
    setExpandedCards(prev => {
      const newSet = new Set(prev);
      if (expanded) {
        newSet.add(taskId);
      } else {
        newSet.delete(taskId);
      }
      
      // Notify parent if all cards are now expanded or collapsed
      if (onExpandChange) {
        const allNowExpanded = newSet.size === tasks.length;
        const allNowCollapsed = newSet.size === 0;
        if (allNowExpanded && !allExpanded) {
          onExpandChange(true);
        } else if (allNowCollapsed && allExpanded) {
          onExpandChange(false);
        }
      }
      
      return newSet;
    });
  };

  const handleTaskSelect = (taskId: string, checked: boolean) => {
    setSelectedTasks(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(taskId);
      } else {
        newSet.delete(taskId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    const allTaskIds = tasks.map(t => t.id);
    setSelectedTasks(new Set(allTaskIds));
  };

  const handleClearSelection = () => {
    setSelectedTasks(new Set());
  };

  const handleBatchReanalyze = async () => {
    if (!selectedTasks.size || selectedTasks.size > 100) {
      toast.error("Select between 1 and 100 cards per request. No cards were submitted.");
      return;
    }
    setBatchReanalyzing(true);
    try {
      const ids = await Promise.all(Array.from(selectedTasks).map(async taskId => {
        const task = tasks.find(item => item.id === taskId);
        if (task?.atisCardId) return task.atisCardId;
        if (!task?.cardId) throw new Error();
        const response = await fetch(`/api/atis/cards/by-trello/${encodeURIComponent(task.cardId)}`, { credentials: "include", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error();
        const row = await response.json();
        if (!Number.isSafeInteger(row.id) || row.id <= 0) throw new Error();
        return row.id as number;
      }));
      setAnalysisIds([...new Set(ids)]);
    } catch { toast.error("Some selected card identities could not be loaded. Refresh before previewing; no analysis was requested."); }
    finally { setBatchReanalyzing(false); }
  };

  // Show skeleton while loading
  if (isLoading) {
    return (
      <div className="relative pl-8 py-4">
        <TimelineSkeleton />
      </div>
    );
  }

  // Show empty state when no tasks
  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={CalendarX}
        title="No tasks scheduled"
        description="Your timeline is empty. Sync your Trello boards to load tasks, or refresh if you've already synced."
        action={
          <div className="flex gap-2 flex-wrap justify-center">
            {onSync && (
              <Button onClick={onSync} disabled={isSyncing}>
                {isSyncing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {isSyncing ? 'Syncing from Trello…' : 'Sync from Trello'}
              </Button>
            )}
            {onRefresh && (
              <Button onClick={onRefresh} variant="outline">
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh Tasks
              </Button>
            )}
          </div>
        }
      />
    );
  }

  // Filter tasks based on viewMode
  const filteredTasksByView = tasks.filter(task => {
    // If viewMode is 'all', show all tasks
    if (viewMode === 'all') return true;
    
    // If task has no date or empty date string, show it in all views
    if (!task.date || task.date.trim() === '') return true;
    
    try {
      const taskDate = new Date(task.date);
      // Check if date is valid
      if (isNaN(taskDate.getTime())) return true;
      
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
      
      if (viewMode === 'day') {
        // Show only today's tasks
        return taskDate >= todayStart && taskDate < todayEnd;
      } else if (viewMode === 'week') {
        // Show tasks for this week (Sunday to Saturday)
        const weekStart = new Date(todayStart);
        // Get day of week (0 = Sunday, 1 = Monday, etc.)
        const dayOfWeek = weekStart.getDay();
        // Calculate days to subtract to get to Sunday
        const daysToSubtract = dayOfWeek === 0 ? 0 : dayOfWeek;
        weekStart.setDate(weekStart.getDate() - daysToSubtract);
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
        return taskDate >= weekStart && taskDate < weekEnd;
      }
      
      return true;
    } catch (error) {
      // If date parsing fails, show the task
      console.error('[Timeline] Error parsing task date:', task.date, error);
      return true;
    }
  });

  return (
    <div className="relative">
      <AtisAnalysisDialog open={analysisIds !== null} onOpenChange={open => { if (!open) setAnalysisIds(null); }}
        selection={{ mode: "reanalyze", cardIds: analysisIds ?? undefined, forceAll: false, limit: 100 }}
        onCompleted={() => { onRefresh?.(); }} />
      {/* Batch Selection Controls */}
      <div className="flex items-center justify-between mb-4 px-2">
        <div className="flex items-center gap-2">
          <Button
            variant={selectionMode ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectionMode(!selectionMode)}
            className="text-xs"
          >
            {selectionMode ? (
              <>
                <X className="h-3.5 w-3.5 mr-1" />
                Exit Selection
              </>
            ) : (
              <>
                <CheckSquare className="h-3.5 w-3.5 mr-1" />
                Select Cards
              </>
            )}
          </Button>
          
          {selectionMode && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSelectAll}
                className="text-xs"
              >
                Select All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearSelection}
                className="text-xs"
                disabled={selectedTasks.size === 0}
              >
                Clear
              </Button>
            </>
          )}
        </div>

        {selectionMode && selectedTasks.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {selectedTasks.size} selected
            </span>
            <Button
              size="sm"
              onClick={handleBatchReanalyze}
              disabled={batchReanalyzing}
              className="text-xs gap-1"
            >
              {batchReanalyzing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading selected card identities...
                </>
              ) : (
                <>
                  <Brain className="h-3.5 w-3.5" />
                  Re-analyze Selected
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      <div className="relative pl-8 py-4">
        {/* Vertical Line */}
        <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />
        
        <ScrollArea className="h-[calc(100vh-250px)] pr-4">
          <div className="space-y-8">
            {filteredTasksByView.map((task, index) => (
              <div key={task.id} className="relative">
                {/* Selection Checkbox - shown in selection mode */}
                {selectionMode && (
                  <div 
                    className="absolute -left-[4rem] top-6 z-10"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selectedTasks.has(task.id)}
                      onCheckedChange={(checked) => handleTaskSelect(task.id, checked as boolean)}
                      className={cn(
                        "h-5 w-5 border-2",
                        selectedTasks.has(task.id) && "bg-primary border-primary"
                      )}
                    />
                  </div>
                )}

                {/* Timeline Dot */}
                <div className={cn(
                  "absolute -left-[2.25rem] top-6 h-4 w-4 rounded-full border-2 border-background",
                  task.isCompleted ? "bg-green-500" : 
                  task.priorityLevel === 'CRITICAL' ? "bg-destructive" :
                  "bg-primary",
                  selectionMode && selectedTasks.has(task.id) && "ring-2 ring-primary ring-offset-2"
                )} />
                
                {/* Time Label - hidden in selection mode */}
                {!selectionMode && (
                  <div className="absolute -left-[6rem] top-5 text-xs font-mono text-muted-foreground w-12 text-right">
                    {task.startTime || '--:--'}
                  </div>
                )}
                
                <div 
                  className={cn(
                    "transition-all",
                    selectionMode && "cursor-pointer",
                    selectionMode && selectedTasks.has(task.id) && "ring-2 ring-primary rounded-lg"
                  )}
                  onClick={selectionMode ? () => handleTaskSelect(task.id, !selectedTasks.has(task.id)) : undefined}
                >
                  <TaskCard 
                    task={task} 
                    onToggle={onToggleTask}
                    isExpanded={expandedCards.has(task.id)}
                    onExpandChange={(expanded) => handleCardExpandChange(task.id, expanded)}
                    onStartInterview={onStartInterview}
                  />
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
