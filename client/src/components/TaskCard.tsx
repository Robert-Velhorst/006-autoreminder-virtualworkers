import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Clock, AlertTriangle, Lock, Globe, FileText, Brain, Target, Sparkles, ExternalLink, ChevronDown, ChevronRight, RefreshCw, Check, CloudUpload, Play, ListChecks, Loader2, MessageSquare, MessageCircle } from "lucide-react";
import { Timer } from "@/components/Timer";
import { toast } from "sonner";
import { Task } from "@/types";
import { AtisAnalysisDialog } from "@/components/AtisAnalysisDialog";
import { readCardUnderstanding } from "@/lib/atis-analysis";
import { cn } from "@/lib/utils";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";

interface TaskCardProps {
  task: Task;
  onToggle: (id: string) => void;
  isExpanded?: boolean;
  onExpandChange?: (expanded: boolean) => void;
  onStartInterview?: (task: Task) => void;
  role?: 'worker' | 'admin';
  onSaveHandoff?: (taskId: string, notes: string) => Promise<void>;
  onAskFounder?: (taskId: string, question: string) => Promise<void>;
}

// APTLSS type colors and labels
const aptlssTypeInfo: Record<string, { color: string; label: string; bgColor: string }> = {
  A: { color: "text-blue-700", label: "Action", bgColor: "bg-blue-100" },
  P: { color: "text-purple-700", label: "Process", bgColor: "bg-purple-100" },
  T: { color: "text-green-700", label: "Task", bgColor: "bg-green-100" },
  L: { color: "text-yellow-700", label: "Learn", bgColor: "bg-yellow-100" },
  S: { color: "text-orange-700", label: "Support", bgColor: "bg-orange-100" },
};

// Batch loader for conversation counts to prevent 429 Rate Limiting errors
let pendingCardIds: string[] = [];
let batchTimeout: any = null;
let batchCallbacks: ((counts: Record<string, number>) => void)[] = [];

const fetchConversationCountsBatch = (cardId: string, callback: (count: number) => void) => {
  pendingCardIds.push(cardId);
  
  const resolver = (counts: Record<string, number>) => {
    callback(counts[cardId] || 0);
  };
  batchCallbacks.push(resolver);

  if (!batchTimeout) {
    batchTimeout = setTimeout(async () => {
      const idsToFetch = [...pendingCardIds];
      const callbacksToCall = [...batchCallbacks];
      
      // Reset batch state
      pendingCardIds = [];
      batchCallbacks = [];
      batchTimeout = null;

      try {
        const response = await fetch('/api/trello-webhook/conversation-counts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardIds: idsToFetch }),
        });
        if (response.ok) {
          const data = await response.json();
          const counts = data.counts || {};
          callbacksToCall.forEach(cb => cb(counts));
        } else {
          callbacksToCall.forEach(cb => cb({}));
        }
      } catch (error) {
        console.error('Failed to fetch conversation counts batch:', error);
        callbacksToCall.forEach(cb => cb({}));
      }
    }, 50); // Batch requests within the same 50ms render tick
  }
};

export function TaskCard({ task, onToggle, isExpanded, onExpandChange, onStartInterview, role = 'admin', onSaveHandoff, onAskFounder }: TaskCardProps) {
  const [cardExpanded, setCardExpanded] = useState(isExpanded ?? false);
  const [notes, setNotes] = useState(task.handoffNotes || '');
  const [question, setQuestion] = useState('');
  const [isAskOpen, setIsAskOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(task.synced || false);
  const [syncingStep, setSyncingStep] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [analysisCardId, setAnalysisCardId] = useState<number | null>(null);
  const [conversationCount, setConversationCount] = useState<number | null>(null);

  const [localChecklist, setLocalChecklist] = useState<any[]>(task.checklist || []);
  const [localHasUnderstanding, setLocalHasUnderstanding] = useState(task.hasUnderstanding);

  const [stepCompletions, setStepCompletions] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    task.checklist?.forEach(item => {
      initial[item.id] = item.completed || false;
    });
    return initial;
  });

  // Sync state with task prop changes
  useEffect(() => {
    setLocalChecklist(task.checklist || []);
    setLocalHasUnderstanding(task.hasUnderstanding);
    
    const initial: Record<string, boolean> = {};
    task.checklist?.forEach(item => {
      initial[item.id] = item.completed || false;
    });
    setStepCompletions(initial);
  }, [task]);
  
  // Inline editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState(task.cardName);
  const [isSyncingTitle, setIsSyncingTitle] = useState(false);

  // Load conversation count when card mounts
  useEffect(() => {
    if (task.cardId) {
      loadConversationCount();
    }
  }, [task.cardId]);

  const loadConversationCount = () => {
    if (!task.cardId) return;
    fetchConversationCountsBatch(task.cardId, (count) => {
      setConversationCount(count);
    });
  };

  // Sync with external isExpanded prop
  useEffect(() => {
    if (isExpanded !== undefined) {
      setCardExpanded(isExpanded);
    }
  }, [isExpanded]);

  // Load latest checklist and completion status from backend when card expands
  useEffect(() => {
    if (cardExpanded && task.atisCardId) {
      refreshCardData();
    }
  }, [cardExpanded, task.atisCardId]);

  const refreshCardData = async () => {
    if (!task.atisCardId) return;
    
    try {
      // 1. Fetch latest understanding (checklist)
      const uResponse = await fetch(`/api/atis/card/${task.atisCardId}/understanding`);
      let currentChecklist = localChecklist;
      if (uResponse.ok) {
        const data = await uResponse.json();
        if (data.aptlssChecklist) {
          try {
            const parsed = JSON.parse(data.aptlssChecklist);
            if (Array.isArray(parsed) && parsed.length > 0) {
              currentChecklist = parsed.map((item: any, index: number) => ({
                id: `${task.atisCardId}-step-${index}`,
                step: item.name || item.step || item.description || 'Step',
                timeMinutes: item.estimatedMinutes || item.timeMinutes || item.time || 15,
                aptlssType: item.priority || item.aptlssType || item.type || 'T',
                completed: false,
              }));
              setLocalChecklist(currentChecklist);
              setLocalHasUnderstanding(true);
            }
          } catch (e) {
            console.error('Failed to parse checklist:', e);
          }
        }
      }

      // Keep analysis explicit. Expanding a card must not spend AI quota or mutate
      // the card's planning state in the background.
      if (!uResponse.ok || currentChecklist.length <= 1) {
        setLocalHasUnderstanding(false);
      }

      // 2. Fetch completion status and apply to currentChecklist
      const cResponse = await fetch(`/api/atis/checklist/status/${task.atisCardId}`);
      if (cResponse.ok) {
        const data = await cResponse.json();
        if (data.completedSteps && Array.isArray(data.completedSteps)) {
          const newCompletions: Record<string, boolean> = {};
          currentChecklist.forEach((item, index) => {
            const isCompleted = data.completedSteps.some((c: any) => c.stepIndex === index);
            newCompletions[item.id] = isCompleted;
          });
          setStepCompletions(newCompletions);
        }
      }
    } catch (error) {
      console.error('Failed to refresh card data:', error);
    }
  };

  const handleCardExpandChange = (expanded: boolean) => {
    setCardExpanded(expanded);
    onExpandChange?.(expanded);
  };

  const handleSyncToTrello = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Determine if we want to sync ATIS checklist or local edits
    // For now, let's keep the existing checklist sync and add a toast for it
    if (!task.atisCardId) {
      toast.error('No ATIS card ID available');
      return;
    }

    setSyncing(true);
    try {
      const response = await fetch(`/api/atis/sync-checklist/${task.atisCardId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replaceExisting: true, preserveCompleted: true }),
      });

      const result = await response.json();

      if (result.success) {
        setSynced(true);
        toast.success(`Synced ${result.itemsCreated} checklist items to Trello`);
      } else {
        toast.error(result.error || 'Failed to sync checklist');
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to sync checklist');
    } finally {
      setSyncing(false);
    }
  };

  const saveTitleToTrello = async () => {
    if (!task.cardId || editedTitle.trim() === task.cardName) {
      setIsEditingTitle(false);
      return;
    }

    setIsSyncingTitle(true);
    try {
      const response = await fetch(`/api/trello/cards/${task.cardId}/update`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editedTitle.trim() }),
      });

      if (!response.ok) throw new Error('Failed to update title');
      
      toast.success('Card title synced to Trello');
      // In a real app we'd update the cache here or rely on the webhook
      setIsEditingTitle(false);
    } catch (error) {
      console.error(error);
      toast.error('Failed to sync title to Trello');
      setEditedTitle(task.cardName);
    } finally {
      setIsSyncingTitle(false);
    }
  };

  const handleReanalyze = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setReanalyzing(true);
    try {
      const id = task.atisCardId || (task.cardId ? await getAtisCardId(task.cardId) : null);
      if (!id) throw new Error("Card identity is unavailable. Refresh before analysis.");
      setAnalysisCardId(id);
    } catch {
      toast.error("Card identity is unavailable. Refresh before analysis.");
    } finally { setReanalyzing(false); }
  };

  const refreshAnalyzedCard = async (id: number, signal: AbortSignal) => {
    const result = await readCardUnderstanding(id, signal);
    signal.throwIfAborted();
    if (result?.aptlssChecklist) {
      const parsed = typeof result.aptlssChecklist === "string" ? JSON.parse(result.aptlssChecklist) : result.aptlssChecklist;
      if (Array.isArray(parsed)) {
        setLocalChecklist(parsed.map((item: any, index: number) => ({
          id: `${id}-step-${index}`, step: item.name || item.step || item.description || "Step",
          timeMinutes: item.estimatedMinutes || item.timeMinutes || item.time || 15,
          aptlssType: item.priority || item.aptlssType || item.type || "T", completed: false,
        })));
        setLocalHasUnderstanding(true);
        const status = await fetch(`/api/atis/checklist/status/${id}`, { credentials: "include", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        if (status.ok) {
          const saved = await status.json();
          signal.throwIfAborted();
          const completions: Record<string, boolean> = {};
          parsed.forEach((_: unknown, index: number) => { completions[`${id}-step-${index}`] = Array.isArray(saved.completedSteps) && saved.completedSteps.some((row: any) => row.stepIndex === index); });
          setStepCompletions(completions);
        }
      }
    }
  };

  // Helper to get ATIS card ID from Trello ID
  const getAtisCardId = async (trelloId: string): Promise<number | null> => {
    try {
      const response = await fetch(`/api/atis/cards/by-trello/${trelloId}`);
      if (response.ok) {
        const data = await response.json();
        return data.id;
      }
    } catch (error) {
      console.error('Failed to get ATIS card ID:', error);
    }
    return null;
  };

  const handleStepToggle = async (stepId: string, stepIndex: number) => {
    if (!task.atisCardId) {
      // Local-only toggle if no card ID
      setStepCompletions(prev => ({
        ...prev,
        [stepId]: !prev[stepId]
      }));
      return;
    }

    setSyncingStep(stepId);
    const newValue = !stepCompletions[stepId];
    
    // Optimistic update
    setStepCompletions(prev => ({
      ...prev,
      [stepId]: newValue
    }));

    try {
      // Save to backend
      const response = await fetch('/api/atis/checklist/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: task.atisCardId,
          stepIndex: stepIndex,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save');
      }

      const result = await response.json();
      
      // Also sync to Trello if we have the checklist info
      if (task.trelloChecklistId) {
        try {
          const syncResponse = await fetch(`/api/atis/checklist/sync-completion/${task.atisCardId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stepIndex: stepIndex,
              completed: newValue,
            }),
          });
          if (!syncResponse.ok) {
            throw new Error('Failed to sync checklist step to Trello');
          }
        } catch (syncError) {
          // Don't fail the whole operation if Trello sync fails
          console.warn('Trello sync failed:', syncError);
        }
      }

      // Show subtle feedback
      if (newValue) {
        toast.success('Step completed', { duration: 1500 });
      }
    } catch (error: any) {
      // Revert on error
      setStepCompletions(prev => ({
        ...prev,
        [stepId]: !newValue
      }));
      toast.error('Failed to save step completion');
    } finally {
      setSyncingStep(null);
    }
  };
  
  const priorityColors = {
    CRITICAL: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    URGENT: "bg-orange-500 text-white hover:bg-orange-600",
    HIGH: "bg-yellow-500 text-white hover:bg-yellow-600",
    NORMAL: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  };

  const complexityColors = {
    simple: "bg-green-100 text-green-700",
    medium: "bg-yellow-100 text-yellow-700",
    complex: "bg-red-100 text-red-700",
  };

  const taskTypeIcons: Record<string, string> = {
    admin: "📋",
    creation: "✏️",
    research: "🔍",
    technical: "⚙️",
    communication: "💬",
    meeting: "📅",
    review: "👁️",
    finance: "💰",
    legal: "⚖️",
  };

  const formatDuration = (hours: number) => {
    if (hours < 1) {
      return `${Math.round(hours * 60)}m`;
    }
    return `${hours.toFixed(1)}h`;
  };

  // Format relative time for analyzed timestamp
  const formatRelativeTime = (date: string | Date | undefined) => {
    if (!date) return null;
    const now = new Date();
    const analyzed = new Date(date);
    const diffMs = now.getTime() - analyzed.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return analyzed.toLocaleDateString();
  };

  const isStale = (date: string | Date | undefined) => {
    if (!date) return false;
    const analyzed = new Date(date);
    const diffDays = Math.floor((new Date().getTime() - analyzed.getTime()) / (1000 * 60 * 60 * 24));
    return diffDays > 7;
  };

  const completedSteps = Object.values(stepCompletions).filter(Boolean).length;
  const totalSteps = localChecklist?.length || 0;
  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  // Calculate total time from checklist
  const totalMinutes = localChecklist?.reduce((sum, item) => sum + (item.timeMinutes || 0), 0) || Math.round(task.durationHours * 60);

  return (
    <><AtisAnalysisDialog open={analysisCardId !== null} onOpenChange={open => { if (!open) setAnalysisCardId(null); }}
      selection={{ mode: "single", cardId: analysisCardId ?? undefined, limit: 1 }} title="Review card analysis"
      onCompleted={async (job, signal) => { if (analysisCardId && job.items.some(item => item.cardId === analysisCardId && ["generated", "fallback"].includes(item.state))) await refreshAnalyzedCard(analysisCardId, signal); }} />
    <Card 
      className={cn(
        "mb-4 transition-all duration-200 border-l-4 overflow-hidden",
        task.isCompleted ? "opacity-60 border-l-green-500" : 
        task.priorityLevel === 'CRITICAL' ? "border-l-destructive" :
        task.priorityLevel === 'URGENT' ? "border-l-orange-500" :
        "border-l-primary"
      )}
    >
      <Collapsible open={cardExpanded} onOpenChange={handleCardExpandChange}>
        {/* Card Header - Always visible */}
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-3 cursor-pointer hover:bg-muted/30 transition-colors">
            <div className="flex items-start gap-3">
              {/* Expand/Collapse Icon */}
              <div className="flex-shrink-0 mt-1">
                {cardExpanded ? (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              
              {/* Checkbox for entire card */}
              <div onClick={(e) => e.stopPropagation()} className="mt-0.5">
                <Checkbox 
                  checked={task.isCompleted} 
                  onCheckedChange={() => onToggle(task.id)}
                  className="h-5 w-5 rounded-full"
                />
              </div>
              
              {/* Card Name & Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className={cn(
                    "text-base font-semibold leading-tight flex items-center",
                    task.isCompleted && "line-through text-muted-foreground"
                  )}>
                    {isEditingTitle ? (
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          autoFocus
                          type="text"
                          className="border rounded px-2 py-1 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                          value={editedTitle}
                          onChange={(e) => setEditedTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveTitleToTrello();
                            if (e.key === 'Escape') {
                              setEditedTitle(task.cardName);
                              setIsEditingTitle(false);
                            }
                          }}
                          disabled={isSyncingTitle}
                        />
                        {isSyncingTitle && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      </div>
                    ) : (
                      <span 
                        className="cursor-pointer hover:underline decoration-dashed underline-offset-4 decoration-muted-foreground/50"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsEditingTitle(true);
                        }}
                      >
                        {task.cardName}
                      </span>
                    )}
                  </CardTitle>
                  
                  {/* Priority Badge */}
                  <Badge className={cn("text-xs", priorityColors[task.priorityLevel])}>
                    {task.priorityLevel}
                  </Badge>
                  
                  {/* AI Analysis status badge */}
                  {!localHasUnderstanding && (
                    <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-300 bg-amber-50">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      Plan needs review
                    </Badge>
                  )}
                  
                  {/* Blocked Badge */}
                  {task.rejectionReason?.includes('Blocked') && (
                    <Badge variant="destructive" className="text-xs gap-1">
                      <Lock className="h-3 w-3" />
                      Blocked
                    </Badge>
                  )}
                  
                  {/* Worker Assignment Badge */}
                  {task.assignedToName && (
                    <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700 border-blue-200" title={task.assignedToEmail}>
                      {task.assignedToName}
                    </Badge>
                  )}

                </div>
                
                {/* Board & List info */}
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  {task.boardName && <span className="truncate">{task.boardName}</span>}
                  {task.listName && (
                    <>
                      <span>•</span>
                      <span className="truncate">{task.listName}</span>
                    </>
                  )}
                </div>
                
                {/* Rejection Reason (if any) */}
                {task.rejectionReason && (
                  <div className="mt-1 text-xs text-red-600 flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {task.rejectionReason}
                  </div>
                )}
                
                {/* Quick stats row */}
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  {/* Steps count */}
                  {totalSteps > 0 && (
                    <span className="flex items-center gap-1">
                      <ListChecks className="h-3.5 w-3.5" />
                      {completedSteps}/{totalSteps} steps
                    </span>
                  )}
                  
                  {/* Total Duration */}
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {totalMinutes >= 60 ? `${(totalMinutes / 60).toFixed(1)}h` : `${totalMinutes}m`}
                  </span>
                  
                  {/* Task Type */}
                  {task.taskType && (
                    <span className="flex items-center gap-1">
                      <span>{taskTypeIcons[task.taskType] || '📌'}</span>
                      <span className="capitalize">{task.taskType}</span>
                    </span>
                  )}
                  
                  {/* Complexity */}
                  {task.complexity && (
                    <span className={cn("px-1.5 py-0.5 rounded text-xs", complexityColors[task.complexity])}>
                      {task.complexity}
                    </span>
                  )}
                  

                </div>
                
                {/* Progress bar - always visible */}
                {totalSteps > 0 && (
                  <div className="mt-2">
                    <Progress value={progress} className="h-1.5" />
                  </div>
                )}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        
        {/* Expanded Content - Checklist Steps */}
        <CollapsibleContent>
          <CardContent className="pt-0 pb-4">
            {/* AI Goal - if available */}
            {task.goal && (
              <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg p-3 border border-purple-100 mb-4 ml-10">
                <div className="flex items-start gap-2">
                  <Target className="h-4 w-4 text-purple-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-purple-900">Goal</p>
                    <p className="text-sm text-purple-700">{task.goal}</p>
                  </div>
                </div>
                {task.deliverable && (
                  <div className="flex items-start gap-2 mt-2">
                    <Sparkles className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-blue-900">Deliverable</p>
                      <p className="text-sm text-blue-700">{task.deliverable}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* APTLSS Checklist Steps - Always visible when expanded */}
            {localChecklist && localChecklist.length > 0 && (
              <div className="ml-10 space-y-1">
                <div className="flex items-center gap-2 mb-3 text-sm font-medium text-muted-foreground">
                  <ListChecks className="h-4 w-4" />
                  <span>Checklist Steps</span>
                </div>
                
                <div className="space-y-2">
                  {localChecklist.map((item, index) => {
                    const typeInfo = aptlssTypeInfo[item.aptlssType] || { color: "text-gray-700", label: item.aptlssType, bgColor: "bg-gray-100" };
                    const isCompleted = stepCompletions[item.id];
                    const isSyncing = syncingStep === item.id;
                    
                    return (
                      <div 
                        key={item.id} 
                        className={cn(
                          "flex items-start gap-3 p-3 rounded-lg border transition-all",
                          isCompleted 
                            ? "bg-green-50/50 border-green-200" 
                            : "bg-muted/30 border-transparent hover:border-muted-foreground/20"
                        )}
                      >
                        {/* Step checkbox */}
                        <div onClick={(e) => e.stopPropagation()} className="relative">
                          {isSyncing ? (
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                          ) : (
                            <Checkbox 
                              checked={isCompleted}
                              onCheckedChange={() => handleStepToggle(item.id, index)}
                              className="h-5 w-5 mt-0.5"
                            />
                          )}
                        </div>
                        
                        {/* Step number & type badge */}
                        <div className="flex-shrink-0 flex flex-col items-center gap-1">
                          <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
                          <span className={cn(
                            "text-xs font-medium px-2 py-0.5 rounded-full",
                            typeInfo.bgColor,
                            typeInfo.color
                          )}>
                            {item.aptlssType}
                          </span>
                        </div>
                        
                        {/* Step content */}
                        <div className="flex-1 min-w-0">
                          <p className={cn(
                            "text-sm leading-relaxed",
                            isCompleted && "line-through text-muted-foreground"
                          )}>
                            {item.step}
                          </p>
                          
                          {/* Step metadata */}
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {item.timeMinutes}m
                            </span>
                            <span className={cn("capitalize", typeInfo.color)}>
                              {typeInfo.label}
                            </span>
                          </div>
                        </div>
                        
                        {/* Completion indicator */}
                        {isCompleted && !isSyncing && (
                          <Check className="h-5 w-5 text-green-500 flex-shrink-0" />
                        )}
                      </div>
                    );
                  })}
                </div>
                
                {/* Total time summary */}
                <div className="flex items-center justify-between pt-3 mt-3 border-t text-sm">
                  <span className="text-muted-foreground">Total estimated time</span>
                  <span className="font-medium">
                    {totalMinutes >= 60 ? `${(totalMinutes / 60).toFixed(1)} hours` : `${totalMinutes} minutes`}
                  </span>
                </div>
              </div>
            )}

            {/* No checklist - show description or analyzing state */}
            {(!localChecklist || localChecklist.length === 0) && (
              <div className="ml-10">
                {!localHasUnderstanding ? (
                  <div className="flex items-center gap-2 py-4 text-amber-600">
                    <Brain className="h-4 w-4" />
                    <div>
                      <p className="text-sm font-medium">No detailed AI checklist yet</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Use Re-analyze when you are ready to create or refresh the card plan.</p>
                    </div>
                  </div>
                ) : task.description ? (
                  <p className="text-sm text-muted-foreground">{task.description}</p>
                ) : null}
              </div>
            )}

            {/* Worker Handoff Notes Section */}
            {role === 'worker' && !task.isCompleted && (
              <div className="ml-10 mt-4 space-y-2 border-t pt-4">
                <label className="text-xs font-semibold text-muted-foreground block">Where did you leave off? (Handoff notes)</label>
                <Textarea 
                  placeholder="Type notes on what was completed or what is pending..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => onSaveHandoff?.(task.id, notes)}
                  className="h-20 text-sm resize-none"
                />
              </div>
            )}

            {/* Actions row */}
            <div className="pt-4 mt-4 border-t flex items-center justify-between gap-2 ml-10">
              {/* Time Tracking Timer */}
              {!task.isCompleted && (
                <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                  <Timer 
                    taskId={task.id} 
                    taskName={task.cardName}
                    estimatedHours={task.durationHours}
                    compact={true}
                  />
                </div>
              )}

              {/* Re-analyze button */}
              {role === 'admin' && (task.atisCardId || task.cardId) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={handleReanalyze}
                  disabled={reanalyzing}
                >
                  {reanalyzing ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading preview...
                    </>
                  ) : (
                    <>
                      <Brain className="h-3 w-3" />
                      Re-analyze
                    </>
                  )}
                </Button>
              )}

              {/* Goal interview button */}
              {role === 'admin' && task.cardId && onStartInterview && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartInterview(task);
                  }}
                >
                  <MessageSquare className="h-3 w-3" />
                  Clarify Goal
                </Button>
              )}

              {/* Ask Founder button (Worker mode) */}
              {role === 'worker' && !task.isCompleted && (
                <Dialog open={isAskOpen} onOpenChange={setIsAskOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" className="text-xs gap-1" onClick={(e) => e.stopPropagation()}>
                      <MessageCircle className="h-4 w-4" />
                      Ask Founder
                    </Button>
                  </DialogTrigger>
                  <DialogContent onClick={(e) => e.stopPropagation()}>
                    <DialogHeader>
                      <DialogTitle>Ask Founder</DialogTitle>
                      <DialogDescription>
                        Send a question about {task.cardName}. The system will automatically include the task context.
                      </DialogDescription>
                    </DialogHeader>
                    <Textarea
                      placeholder="Type your question here..."
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      className="min-h-[100px]"
                    />
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAskOpen(false)}>Cancel</Button>
                      <Button onClick={() => {
                        onAskFounder?.(task.id, question);
                        setIsAskOpen(false);
                        setQuestion('');
                      }}>Send to Founder</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              {/* Sync to Trello button */}
              {localChecklist && localChecklist.length > 0 && task.atisCardId && (
                <Button
                  variant={synced ? "outline" : "default"}
                  size="sm"
                  className={cn(
                    "text-xs gap-1",
                    synced && "text-green-600 border-green-200 bg-green-50 hover:bg-green-100"
                  )}
                  onClick={handleSyncToTrello}
                  disabled={syncing}
                >
                  {syncing ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      Syncing...
                    </>
                  ) : synced ? (
                    <>
                      <Check className="h-3 w-3" />
                      Synced
                    </>
                  ) : (
                    <>
                      <CloudUpload className="h-3 w-3" />
                      Sync to Trello
                    </>
                  )}
                </Button>
              )}

              {/* View Conversations button */}
              {task.cardId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 relative"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Open conversation dialog - dispatch custom event
                    window.dispatchEvent(new CustomEvent('openConversations', { 
                      detail: { cardId: task.cardId, cardName: task.cardName } 
                    }));
                  }}
                >
                  <MessageSquare className="h-3 w-3" />
                  Conversations
                  {conversationCount !== null && conversationCount > 0 && (
                    <Badge 
                      variant="secondary" 
                      className="ml-1 h-4 min-w-4 px-1 text-[10px] bg-purple-100 text-purple-700"
                    >
                      {conversationCount > 99 ? '99+' : conversationCount}
                    </Badge>
                  )}
                </Button>
              )}

              {/* Open in Trello link */}
              {task.url && (
                <a 
                  href={task.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 ml-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in Trello
                </a>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card></>
  );
}
