import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Timeline } from "@/components/Timeline";
import { OverflowTasks } from "@/components/OverflowTasks";
import { StatsPanel } from "@/components/StatsPanel";
import { WeeklyProgressDashboard } from "@/components/WeeklyProgressDashboard";
import { WorkloadHeatmap } from "@/components/WorkloadHeatmap";
import { Task, WeeklyStats } from "@/types";
import { CalendarDays, Bell, Search, RefreshCw, Settings, ListTodo, LogOut, User, Menu, X, Users, ChevronLeft, ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useWebSocket } from "@/hooks/useWebSocket";
import { MobileNav } from "@/components/MobileNav";
import { NotificationBell } from "@/components/NotificationBell";
import { TaskFilters, TaskFiltersState } from "@/components/TaskFilters";
import { LoadingQueueIndicator } from "@/components/LoadingQueueIndicator";
import { ConversationDialog } from "@/components/ConversationDialog";
import { BulkTaskActions } from "@/components/BulkTaskActions";
import { GoalInterviewDialog } from "@/components/GoalInterviewDialog";
import { taskCache, CACHE_KEYS } from "@/lib/taskCache";
import { AtisOperationClient, canStartAtisOperation, INITIAL_ATIS_OPERATION_VIEW, type AtisOperationView } from "@/lib/atis-operation";
import { AtisAnalysisDialog } from "@/components/AtisAnalysisDialog";
import { readCardUnderstanding } from "@/lib/atis-analysis";
import type { AtisAnalysisSelection } from "@shared/atisAnalysis";

// No longer using mock data - fetch from Trello API

export default function Home() {
  // The userAuth hooks provides authentication state
  // To implement login/logout functionality, simply call logout() or redirect to getLoginUrl()
  let { user, loading, error, isAuthenticated, logout } = useAuth({ redirectOnUnauthenticated: true });

  // Get current date for display
  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [taskLoadFailed, setTaskLoadFailed] = useState(false);
  const taskRequestInFlight = useRef(false);
  const taskSourceAvailable = useRef(false);
  const [atisOperation, setAtisOperation] = useState<AtisOperationView>(INITIAL_ATIS_OPERATION_VIEW);
  const atisClient = useRef<AtisOperationClient | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisSelection, setAnalysisSelection] = useState<AtisAnalysisSelection>({ mode: "pending", limit: 100 });
  const isSyncing = !canStartAtisOperation(atisOperation);
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [taskTypes, setTaskTypes] = useState<{ taskType: string; count: number }[]>([]);
  const [clients, setClients] = useState<{ client: string; count: number }[]>([]);
  const [filters, setFilters] = useState<TaskFiltersState>({
    filter: 'all',
    completionStatus: 'incomplete',
    taskType: null,
    complexity: null,
    client: null,
    sortBy: 'dueDate',
    sortOrder: 'asc',
  });
  const [overflowTasks, setOverflowTasks] = useState<any[]>([]);
  const [allExpanded, setAllExpanded] = useState(false);
  const [conversationCard, setConversationCard] = useState<{ cardId: string; cardName: string } | null>(null);
  const [interviewTask, setInterviewTask] = useState<Task | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [workers, setWorkers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [workerFilter, setWorkerFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'day' | 'week' | 'all'>('all');

  // Listen for conversation dialog events from TaskCard
  useEffect(() => {
    const handleOpenConversations = (e: CustomEvent<{ cardId: string; cardName: string }>) => {
      if (!taskSourceAvailable.current) return;
      setConversationCard(e.detail);
    };
    window.addEventListener('openConversations', handleOpenConversations as EventListener);
    return () => window.removeEventListener('openConversations', handleOpenConversations as EventListener);
  }, []);
  
  // Filter and sort tasks based on search query and filters
  const filteredTasks = useMemo(() => {
    let result = [...tasks];
    
    // Exclude tasks from inactive lists (Done, Completed, Archive, Info)
    const inactiveKeywords = ['done', 'completed', 'complete', 'archive', 'archived', 'info'];
    result = result.filter(task => {
      if (!task.listName) return true;
      const normalized = task.listName.toLowerCase().trim();
      return !inactiveKeywords.some(kw => normalized === kw || normalized.includes(kw));
    });
    
    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(task => 
        task.description?.toLowerCase().includes(query) ||
        task.cardName?.toLowerCase().includes(query) ||
        task.goal?.toLowerCase().includes(query) ||
        (task.isPriority ? 'priority high' : '').toLowerCase().includes(query)
      );
    }
    
    // Apply status filter
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    
    if (filters.filter === 'overdue') {
      result = result.filter(t => t.date && new Date(t.date) < now);
    } else if (filters.filter === 'today') {
      result = result.filter(t => t.date && new Date(t.date) >= todayStart && new Date(t.date) < todayEnd);
    } else if (filters.filter === 'upcoming') {
      result = result.filter(t => t.date && new Date(t.date) >= now);
    } else if (filters.filter === 'on-hold') {
      result = result.filter(t => t.listName && t.listName.toLowerCase() === 'on-hold');
    }
    
    // Apply task type filter
    if (filters.completionStatus === 'completed') {
      result = result.filter(t => t.isCompleted);
    } else if (filters.completionStatus === 'incomplete') {
      result = result.filter(t => !t.isCompleted);
    }

    // Apply task type filter
    if (filters.taskType) {
      result = result.filter(t => t.taskType === filters.taskType);
    }
    
    // Apply complexity filter
    if (filters.complexity) {
      result = result.filter(t => t.complexity === filters.complexity);
    }
    
    // Apply client filter
    if (filters.client) {
      result = result.filter(t => t.client === filters.client);
    }
    
    // Apply worker filter — match against Trello memberIds array
    if (workerFilter) {
      result = result.filter(t => Array.isArray((t as any).memberIds) && (t as any).memberIds.includes(workerFilter));
    }
    
    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      
      if (filters.sortBy === 'dueDate') {
        const dateA = a.date ? new Date(a.date).getTime() : Infinity;
        const dateB = b.date ? new Date(b.date).getTime() : Infinity;
        comparison = dateA - dateB;
      } else if (filters.sortBy === 'estimatedTime') {
        comparison = (a.durationHours || 0) - (b.durationHours || 0);
      } else if (filters.sortBy === 'complexity') {
        const complexityOrder = { simple: 1, medium: 2, complex: 3 };
        const orderA = a.complexity ? complexityOrder[a.complexity] : 2;
        const orderB = b.complexity ? complexityOrder[b.complexity] : 2;
        comparison = orderA - orderB;
      } else if (filters.sortBy === 'client') {
        const clientA = a.client || 'zzz'; // Put tasks without client at end
        const clientB = b.client || 'zzz';
        comparison = clientA.localeCompare(clientB);
      }
      
      return filters.sortOrder === 'asc' ? comparison : -comparison;
    });
    
    return result;
  }, [tasks, searchQuery, filters, workerFilter]);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [stats, setStats] = useState<WeeklyStats>({
    totalTasks: 0,
    completedTasks: 0,
    totalHours: 0,
    completedHours: 0,
    accuracy: 100
  });

  // Stable WebSocket callbacks — must be useCallback so their references don't change on every render.
  // If they were inline arrow functions, useWebSocket's useEffect dependency array would see a new function
  // reference on every render and disconnect/reconnect the socket in an infinite loop.
  const handleTaskCompleted = useCallback((data: any) => {
    console.log('Received task completion from WebSocket:', data);
    taskCache.invalidate(CACHE_KEYS.TIMELINE_TASKS);
    setTasks(prevTasks =>
      prevTasks.map(task =>
        task.id === data.taskId
          ? { ...task, isCompleted: data.isCompleted }
          : task
      )
    );
    toast.info(`Task ${data.isCompleted ? 'completed' : 'uncompleted'} by another client`);
  }, []);

  const handleCacheInvalidated = useCallback(() => {
    console.log('Cache invalidated, reloading tasks');
    taskCache.invalidate(CACHE_KEYS.TIMELINE_TASKS);
    toast.info('Tasks updated, reloading...');
    window.location.reload();
  }, []);

  // WebSocket connection for real-time updates
  const { status: wsStatus } = useWebSocket({
    onTaskCompleted: handleTaskCompleted,
    onCacheInvalidated: handleCacheInvalidated,
  });

  const applyReschedule = async () => {
    if (!taskSourceAvailable.current || isRescheduling) return;

    setIsRescheduling(true);
    try {
      const response = await fetch('/api/reschedule/apply', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to reschedule tasks');
      }

      toast.success(data.message || 'Tasks will be rescheduled on next refresh');
      window.location.reload();
    } catch (error) {
      toast.error(`Rescheduling failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsRescheduling(false);
    }
  };

  const fetchTasks = useCallback(async (forceRefresh = false) => {
    if (taskRequestInFlight.current) return;
    taskRequestInFlight.current = true;
    taskSourceAvailable.current = false;
    setConversationCard(null);
    setInterviewTask(null);
    setIsLoadingTasks(true);
    try {
      if (forceRefresh) taskCache.invalidate(CACHE_KEYS.TIMELINE_TASKS);
      // Check cache first
      const cachedTasks = taskCache.get(CACHE_KEYS.TIMELINE_TASKS);
      if (cachedTasks) {
        console.log('[TaskCache] Using cached tasks');
        setTasks(cachedTasks.tasks);
        setClients(cachedTasks.clients);
        setStats(cachedTasks.stats);
        setOverflowTasks(cachedTasks.overflowTasks);
        setHasLoadedTasks(true);
        setTaskLoadFailed(false);
        taskSourceAvailable.current = true;
        return;
      }

      const atisResponse = await fetch(`/api/atis/timeline-tasks?filter=all`, {
        credentials: 'include',
      });
      if (!atisResponse.ok) {
        await atisResponse.arrayBuffer();
        throw new Error('Failed to load the ATIS work queue');
      }
      const atisData = await atisResponse.json();
      const scheduledTasks = atisData?.scheduled ?? atisData?.tasks;
      const overflowTasks = atisData?.overflow ?? [];
      if (!Array.isArray(scheduledTasks) || !Array.isArray(overflowTasks)) {
        throw new Error('Invalid work queue response');
      }
      const atisTasks: Task[] = scheduledTasks.map((t: any) => ({
            id: `atis-${t.id}`,
            cardId: t.trelloId,
            cardName: t.name,
            stepIndex: 0,
            description: t.goal || t.description || t.name,
            durationHours: (t.estimatedMinutes || 30) / 60,
            startTime: '',
            endTime: '',
            date: t.dueDate ? new Date(t.dueDate).toISOString().split('T')[0] : '',
            isCompleted: false,
            isArchived: false,
            isBlocker: t.status === 'overdue',
            isPriority: t.complexity === 'complex' || t.status === 'overdue',
            priorityLevel: t.status === 'overdue' ? 'CRITICAL' : t.complexity === 'complex' ? 'HIGH' : 'NORMAL',
            hasDutch: false,
            attachments: [],
            goal: t.goal,
            deliverable: t.deliverable,
            taskType: t.taskType,
            complexity: t.complexity,
            boardName: t.boardName,
            listName: t.listName,
            url: t.url,
            checklist: t.checklist || [],
            hasUnderstanding: t.hasUnderstanding,
            confidenceScore: t.confidenceScore,
            atisCardId: t.atisCardId || t.id,
            memberIds: t.memberIds || [],
            synced: false,
      }));
      const clientCounts = new Map<string, number>();
      atisTasks.forEach(t => {
        if (t.client) {
          clientCounts.set(t.client, (clientCounts.get(t.client) || 0) + 1);
        }
      });
      const clientsList = Array.from(clientCounts.entries())
        .map(([client, count]) => ({ client, count }))
        .sort((a, b) => b.count - a.count);
      const metrics = atisData.metrics || {};
      const totalTasksCount = metrics.totalScheduled || atisData.total || atisTasks.length;
      const completedTasks = atisTasks.filter(t => t.isCompleted).length;
      const totalHours = (metrics.totalScheduledMinutes || 0) / 60;
      const completedHours = atisTasks.filter(t => t.isCompleted).reduce((acc, t) => acc + t.durationHours, 0);

      const stats = {
        totalTasks: totalTasksCount,
        completedTasks,
        totalHours,
        completedHours,
        accuracy: 100
      };
      // Cache the fetched data for 5 minutes
      const cacheData = {
        tasks: atisTasks,
        clients: clientsList,
        stats,
        overflowTasks: overflowTasks && overflowTasks.length > 0 ? overflowTasks : [],
      };
      taskCache.set(CACHE_KEYS.TIMELINE_TASKS, cacheData);
      setTasks(atisTasks);
      setClients(clientsList);
      setOverflowTasks(cacheData.overflowTasks);
      setStats(stats);
      setHasLoadedTasks(true);
      setTaskLoadFailed(false);
      taskSourceAvailable.current = true;
      console.log('[TaskCache] Cached tasks for 5 minutes');

      try {
        const typesResponse = await fetch('/api/atis/task-types', {
          credentials: 'include',
        });
        if (typesResponse.ok) {
          const types = await typesResponse.json();
          setTaskTypes(types);
        }
      } catch (e) {
        console.error('Failed to fetch task types:', e);
      }
      return;
    } catch {
      taskCache.invalidate(CACHE_KEYS.TIMELINE_TASKS);
      taskSourceAvailable.current = false;
      setTaskLoadFailed(true);
      toast.error('Work queue unavailable. Please try again.');
    } finally {
      taskRequestInFlight.current = false;
      setIsLoadingTasks(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && user) {
      void fetchTasks();
    }
  }, [fetchTasks, isAuthenticated, user]);

  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const client = new AtisOperationClient({
      chainUnderstanding: false,
      onState: setAtisOperation,
      onCompleted: async operation => {
        const counts = operation.result;
        if (operation.kind === 'sync') {
          const hasCounts = [counts?.totalBoards, counts?.totalCards].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
          toast.success(hasCounts ? `Synced ${counts!.totalBoards} boards and ${counts!.totalCards} cards from Trello` : 'Trello sync completed.');
          setAnalysisSelection({ mode: "pending", limit: 100 });
          setAnalysisOpen(true);
        } else {
          const processed = counts?.processed;
          toast.success(typeof processed === 'number' && Number.isFinite(processed) && processed >= 0 ? `AI analyzed ${processed} cards` : 'Card analysis completed.', {
            description: typeof counts?.failed === 'number' && counts.failed > 0 ? `${counts.failed} cards could not be analyzed.` : undefined,
          });
        }
        await fetchTasks(true);
      },
    });
    atisClient.current = client;
    void client.resume();
    return () => {
      client.stop();
      if (atisClient.current === client) atisClient.current = null;
    };
  }, [fetchTasks, isAuthenticated, user?.id]);

  const syncFromTrello = useCallback(async () => {
    if (!taskSourceAvailable.current) return;
    await atisClient.current?.startSync();
  }, [fetchTasks]);

  const handleOpenInterview = (task: Task) => {
    if (!taskSourceAvailable.current) return;
    setInterviewTask(task);
  };

  const handleInterviewComplete = async (finalGoal: any) => {
    if (!taskSourceAvailable.current || !interviewTask) return;
    const target = interviewTask;
    try {
      let cardId = target.atisCardId;
      if (!cardId && target.cardId) {
        const response = await fetch(`/api/atis/cards/by-trello/${encodeURIComponent(target.cardId)}`, { credentials: "include", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error();
        cardId = (await response.json()).id;
      }
      if (!cardId) throw new Error();
      setAnalysisSelection({ mode: "single", cardId, limit: 1, guidance: {
        goal: finalGoal?.goal, deliverable: finalGoal?.deliverable, successCriteria: finalGoal?.successCriteria,
      } });
      setAnalysisOpen(true);
      setInterviewTask(null);
    } catch { toast.error("Card identity unavailable. Your interview remains open; refresh before requesting analysis."); }
  };

  const handleToggleTask = async (id: string) => {
    if (!taskSourceAvailable.current) return;
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    const newCompletedState = !task.isCompleted;

    // Optimistically update UI
    setTasks(tasks.map(t => 
      t.id === id ? { ...t, isCompleted: newCompletedState } : t
    ));

    try {
      // Check if we have required Trello fields
      if (!task.cardId) {
        console.warn('Task missing cardId, updating locally only');
        toast.success(newCompletedState ? 'Task completed!' : 'Task marked incomplete');
        return;
      }

      // If we have checklist fields, sync to Trello
      if (task.checklistId && task.checkItemId) {
        const response = await fetch(`/api/trello/tasks/${id}/complete`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            isCompleted: newCompletedState,
            cardId: task.cardId,
            checklistId: task.checklistId,
            checkItemId: task.checkItemId,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to update task in Trello');
        }
      } else {
        // Fallback: update card status directly if no checklist
        console.warn('Task missing checklist fields, updating card status directly');
        const response = await fetch(`/api/trello/cards/${task.cardId}/status`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            isCompleted: newCompletedState,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to update card status');
        }
      }

      toast.success(newCompletedState ? 'Task completed!' : 'Task marked incomplete');
    } catch (error) {
      console.error('Error syncing task status:', error);
      // Revert on error
      setTasks(tasks.map(t => 
        t.id === id ? { ...t, isCompleted: !newCompletedState } : t
      ));
      toast.error(`Failed to sync with Trello: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container py-3 md:py-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 md:h-10 md:w-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary font-bold text-sm md:text-xl">
              VA
            </div>
            <div className="hidden md:block flex-1">
              <h2 className="font-bold text-base md:text-lg leading-tight">
                {new Date().getHours() < 12 ? 'Good Morning' : new Date().getHours() < 17 ? 'Good Afternoon' : 'Good Evening'}, {user?.name?.split(' ')[0] || 'there'}! {new Date().getHours() < 12 ? '☀️' : new Date().getHours() < 17 ? '🌤️' : '🌙'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {hasLoadedTasks ? (
                  <>You have <span className="font-bold text-primary">{tasks.filter(t => !t.isCompleted).length} tasks</span> remaining.{taskLoadFailed && ' Last successful result; may be out of date.'}</>
                ) : isLoadingTasks ? 'Loading work queue...' : 'Task count unavailable.'}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="hidden md:flex"
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              {sidebarOpen ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
            </Button>
          </div>
          
          <div className="flex items-center gap-2 md:gap-4">
            {/* Search - hidden on mobile */}
            <div className="relative hidden lg:block">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search tasks..." 
                className="pl-9 w-64 bg-secondary/50 border-none" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="absolute right-1 top-1 h-6 w-6"
                  onClick={() => setSearchQuery('')}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
            
            {/* Desktop navigation */}
            <div className="hidden md:flex items-center gap-2">
              <Link href="/aptlss">
                <Button variant="ghost" size="icon" title="APTLSS Management">
                  <ListTodo className="h-5 w-5" />
                </Button>
              </Link>
              <Link href="/founder">
                <Button variant="ghost" size="icon" title="VA Management">
                  <Users className="h-5 w-5" />
                </Button>
              </Link>
              <Link href="/settings">
                <Button variant="ghost" size="icon" title="Settings">
                  <Settings className="h-5 w-5" />
              </Button>
              </Link>
            </div>
            
            {/* Mobile menu button */}
            <MobileNav user={user} onLogout={logout} />
            
            {/* Loading Queue Indicator */}
            <div className="hidden md:flex">
              <LoadingQueueIndicator />
            </div>
            
            {/* Notification Bell with history */}
            <div className="hidden md:flex">
              <NotificationBell />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                  <Avatar>
                    <AvatarImage src={user?.email ? `https://www.gravatar.com/avatar/${user.email}?d=mp` : undefined} />
                    <AvatarFallback>{user?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'U'}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" align="end" forceMount>
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">{user?.name || 'User'}</p>
                    <p className="text-xs leading-none text-muted-foreground">{user?.email || ''}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <Link href="/settings">
                  <DropdownMenuItem>
                    <Settings className="mr-2 h-4 w-4" />
                    <span>Settings</span>
                  </DropdownMenuItem>
                </Link>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => logout()} className="text-destructive">
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="flex-1 container py-4 md:py-8">
        {atisOperation.status !== 'idle' && (
          <section role={['unconfirmed', 'failed', 'interrupted'].includes(atisOperation.status) ? 'alert' : 'status'} className="mb-4 border-b pb-4 space-y-2" aria-label="Sync and analysis status">
            <p className="text-sm">{atisOperation.message}</p>
            {atisOperation.operation && <p className="text-xs text-muted-foreground">Operation #{atisOperation.operation.id}</p>}
            {atisOperation.status === 'unconfirmed' && (
              <Button variant="outline" size="sm" disabled={atisOperation.busy} onClick={() => void atisClient.current?.resume()}>
                <RefreshCw className="size-4 mr-2" /> Check status
              </Button>
            )}
            {atisOperation.status === 'interrupted' && (
              <Button variant="outline" size="sm" disabled={atisOperation.busy} onClick={() => { if (atisOperation.operation?.kind === 'sync') void atisClient.current?.acknowledgeAndRestart(); else { setAnalysisSelection({ mode: "pending", limit: 100 }); setAnalysisOpen(true); } }}>
                <RefreshCw className="size-4 mr-2" /> Acknowledge interruption and restart {atisOperation.operation?.kind === 'sync' ? 'sync' : 'analysis'}
              </Button>
            )}
            {atisOperation.status === 'completed' && atisOperation.operation?.kind === 'sync' && !atisOperation.busy && (
              <Button variant="outline" size="sm" onClick={() => { setAnalysisSelection({ mode: "pending", limit: 100 }); setAnalysisOpen(true); }}>
                <RefreshCw className="size-4 mr-2" /> Analyze synced cards
              </Button>
            )}
          </section>
        )}
        {taskLoadFailed && (
          <section role="alert" aria-labelledby="work-queue-error-heading" className="mb-4 border border-destructive/40 rounded-lg p-4 space-y-2">
            <h2 id="work-queue-error-heading" className="text-lg font-semibold">Work queue unavailable</h2>
            <p className="text-sm text-muted-foreground">
              {hasLoadedTasks
                ? 'Refresh failed. The last successfully loaded work queue and metrics may be out of date. Task actions are paused until access is checked again.'
                : 'We could not load your work queue. Task counts and completion metrics are unavailable.'}
            </p>
            <Button variant="outline" size="sm" onClick={() => void fetchTasks(true)} disabled={isLoadingTasks}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingTasks ? 'animate-spin' : ''}`} />
              {isLoadingTasks ? 'Retrying...' : 'Try again'}
            </Button>
          </section>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-8">
          {/* Left Sidebar - Stats - Collapsible */}
          <div className={`transition-all duration-300 ${sidebarOpen ? 'lg:col-span-4' : 'lg:col-span-0'} ${sidebarOpen ? 'block' : 'hidden'} space-y-4 md:space-y-8 order-2 lg:order-1`}>
            {/* Action Buttons */}
            <div className="flex flex-col gap-2">
              <Button 
                className="w-full"
                onClick={() => window.scrollTo({ top: document.querySelector('.timeline-section')?.getBoundingClientRect().top! + window.scrollY - 100, behavior: 'smooth' })}
              >
                View Weekly Schedule
              </Button>
              <Button 
                variant="outline" 
                className="w-full"
                onClick={applyReschedule}
                disabled={isRescheduling || isLoadingTasks || taskLoadFailed || !hasLoadedTasks}
              >
                {isRescheduling ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span className="ml-2">Reschedule</span>
              </Button>
            </div>
            
            {hasLoadedTasks && <StatsPanel stats={stats} />}
            
            {/* Weekly Progress Dashboard */}
            {hasLoadedTasks && <WeeklyProgressDashboard />}
            

          </div>

          {/* Main Content - Timeline */}
          <div className={`transition-all duration-300 ${sidebarOpen ? 'lg:col-span-8' : 'lg:col-span-12'} order-1 lg:order-2`}>
            <div className="timeline-section bg-card rounded-2xl shadow-sm border min-h-[400px] md:min-h-[600px] relative overflow-hidden">
              <div aria-hidden="true" className="absolute top-0 left-0 right-0 h-20 md:h-32 bg-muted/20" />
              <div className="relative z-10 p-4 md:p-6">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-2 md:gap-4 mb-4">
                  <h2 className="text-lg md:text-xl font-bold">Workload Timeline</h2>
                  <div className="flex gap-1 md:gap-2">
                    <Button 
                      variant={viewMode === 'all' ? 'outline' : 'ghost'} 
                      size="sm" 
                      className="text-xs md:text-sm"
                      onClick={() => setViewMode('all')}
                    >
                      All
                    </Button>
                    <Button 
                      variant={viewMode === 'day' ? 'outline' : 'ghost'} 
                      size="sm" 
                      className="text-xs md:text-sm"
                      onClick={() => setViewMode('day')}
                    >
                      Day
                    </Button>
                    <Button 
                      variant={viewMode === 'week' ? 'outline' : 'ghost'} 
                      size="sm" 
                      className="text-xs md:text-sm"
                      onClick={() => setViewMode('week')}
                    >
                      Week
                    </Button>
                  </div>
                </div>
                


                {/* Original Task Filters */}
                {hasLoadedTasks && <div className="mb-4">
                  <TaskFilters
                    filters={filters}
                    onFiltersChange={setFilters}
                    taskTypes={taskTypes}
                    clients={clients}
                    totalTasks={tasks.length}
                    filteredCount={filteredTasks.length}
                  />
                </div>}
                
                {/* Search results info */}
                {hasLoadedTasks && searchQuery && (
                  <div className="mb-4 p-3 bg-secondary/50 rounded-lg flex items-center justify-between">
                    <span className="text-sm">
                      {filteredTasks.length === 0 
                        ? `No tasks found for "${searchQuery}"`
                        : `Found ${filteredTasks.length} task${filteredTasks.length === 1 ? '' : 's'} matching "${searchQuery}"`
                      }
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setSearchQuery('')}>
                      Clear search
                    </Button>
                  </div>
                )}
                
                {/* Overflow Tasks Alert */}
                {!taskLoadFailed && !isLoadingTasks && overflowTasks.length > 0 && (
                  <div className="mb-4">
                    <OverflowTasks tasks={overflowTasks} />
                  </div>
                )}
                
                {/* Expand All / Collapse All buttons */}
                {filteredTasks.length > 0 && (
                  <div className="flex items-center justify-end gap-2 mb-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAllExpanded(true)}
                      disabled={allExpanded}
                      className="text-xs"
                    >
                      Expand All
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAllExpanded(false)}
                      disabled={!allExpanded}
                      className="text-xs"
                    >
                      Collapse All
                    </Button>
                  </div>
                )}
                
                {isLoadingTasks && hasLoadedTasks && <p role="status" className="mb-4 text-sm text-muted-foreground">Refreshing work queue...</p>}
                {hasLoadedTasks && (taskLoadFailed || isLoadingTasks) && <section aria-label="Last loaded work" className="border-t py-4">
                  <h3 className="text-sm font-medium">Last loaded work (read-only)</h3>
                  <ul className="mt-2 divide-y text-sm text-muted-foreground">
                    {filteredTasks.map(task => <li key={task.id} className="py-2 break-words">{task.cardName}</li>)}
                    {overflowTasks.map((task, index) => <li key={`overflow-${index}`} className="py-2 break-words">{task.name || task.cardName}</li>)}
                  </ul>
                </section>}
                {!taskLoadFailed && !isLoadingTasks && hasLoadedTasks && <Timeline
                  tasks={filteredTasks} 
                  onToggleTask={handleToggleTask} 
                  isLoading={isLoadingTasks && !hasLoadedTasks}
                  onRefresh={() => void fetchTasks(true)}
                  onSync={() => void syncFromTrello()}
                  isSyncing={isSyncing}
                  allExpanded={allExpanded}
                  onExpandChange={(expanded: boolean) => setAllExpanded(expanded)}
                  onStartInterview={handleOpenInterview}
                  viewMode={viewMode}
                />}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Conversation Dialog */}
      <AtisAnalysisDialog open={analysisOpen} onOpenChange={setAnalysisOpen} selection={analysisSelection} resumeOnMount
        onCompleted={async (job, signal) => {
          if (analysisSelection.mode === "single" && analysisSelection.cardId && job.items.some(item => item.cardId === analysisSelection.cardId && ["generated", "fallback"].includes(item.state))) await readCardUnderstanding(analysisSelection.cardId, signal);
          signal.throwIfAborted();
          await fetchTasks(true);
        }} />
      <ConversationDialog
        open={!!conversationCard}
        onOpenChange={(open) => !open && setConversationCard(null)}
        cardId={conversationCard?.cardId || null}
        cardName={conversationCard?.cardName || null}
      />

      <GoalInterviewDialog
        open={!!interviewTask}
        onOpenChange={(open) => {
          if (!open) {
            setInterviewTask(null);
          }
        }}
        cardId={interviewTask?.cardId || ''}
        cardName={interviewTask?.cardName || ''}
        onComplete={handleInterviewComplete}
      />
    </div>
  );
}
