import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  Play,
  Download,
  RefreshCw,
  Filter,
  Search,
  ArrowLeft,
  Trash2,
  Clock,
  CheckSquare,
  MessageSquare,
  X,
  AlertTriangle,
} from "lucide-react";
import { GoalInterviewDialog } from "@/components/GoalInterviewDialog";
import { AresConfigurationPanel } from "@/components/AresConfigurationPanel";
import { Link } from "wouter";
import { useLoadingQueue } from "@/contexts/LoadingQueueContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idBoard: string;
  idList: string;
  boardName?: string;
  listName?: string;
  hasAPTLSS: boolean;
  selected: boolean;
  due?: string;
  badges?: { attachments: number };
}

interface TrelloBoard {
  id: string;
  name: string;
  cardCount: number;
  selected: boolean;
}

interface TrelloWorkspace {
  id: string;
  name: string;
  boardCount: number;
  cardCount?: number;
  boards: { id: string; name: string; cardCount?: number }[];
  selected: boolean;
}

interface GenerationProgress {
  total: number;
  completed: number;
  failed: number;
  jobId?: string;
  current?: string;
  status:
    | "idle"
    | "submitting"
    | "running"
    | "completed"
    | "completed_with_errors"
    | "failed";
  completedAt?: string | null;
}

interface GenerationJobStatusResponse {
  jobId: string;
  status: "running" | "completed" | "completed_with_errors" | "failed";
  progress: { total: number; completed: number; failed: number };
  completedAt?: string | null;
}

interface AutoLoadProgress {
  isLoading: boolean;
  current: number;
  total: number;
  loaded: number;
  skipped: number;
  failed: number;
  failedBoards: { id: string; name: string; workspaceName: string }[];
  skippedCards: {
    cardId: string;
    cardName: string;
    boardName: string;
    reason: string;
  }[];
  currentBoard: string;
  cancelled?: boolean;
  startTime?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HISTORY_REFRESH_MS = 5000;
const CARDS_STORAGE_KEY = "aptlss_loaded_cards";
const WORKSPACE_SELECTION_KEY = "aptlss_selected_workspaces";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeRemaining(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${minutes}m ${secs}s`;
}

function getJobBadgeVariant(
  status: string
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "completed") return "default";
  if (status === "running" || status === "submitting") return "secondary";
  if (status === "completed_with_errors") return "outline";
  return "destructive";
}

async function fetchBoardCards(boardId: string): Promise<any[]> {
  const response = await fetch(`/api/trello/boards/${boardId}/cards`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Invalid response format");
  return data;
}

function mapRawCard(raw: any, boardName: string): TrelloCard {
  return {
    id: raw.id,
    name: raw.name,
    desc: raw.desc || "",
    idBoard: raw.idBoard,
    idList: raw.idList,
    boardName,
    listName: raw.listName || "",
    hasAPTLSS: raw.checklists?.some((cl: any) => cl.name === "APTLSS") || false,
    selected: false,
    due: raw.due,
    badges: raw.badges,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface WorkspaceSelectorDialogProps {
  open: boolean;
  onClose: () => void;
  workspaces: TrelloWorkspace[];
  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  onLoad: () => void;
  isLoading: boolean;
}

function WorkspaceSelectorDialog({
  open,
  onClose,
  workspaces,
  selected,
  onSelectionChange,
  onLoad,
  isLoading,
}: WorkspaceSelectorDialogProps) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const filtered = useMemo(
    () =>
      workspaces.filter(w =>
        w.name.toLowerCase().includes(search.toLowerCase())
      ),
    [workspaces, search]
  );

  const totalBoards = workspaces
    .filter(w => selected.has(w.id))
    .reduce((s, w) => s + w.boardCount, 0);

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    checked ? next.add(id) : next.delete(id);
    onSelectionChange(next);
  };

  const selectFiltered = () => {
    const next = new Set(selected);
    filtered.forEach(w => next.add(w.id));
    onSelectionChange(next);
  };

  const clearFiltered = () => {
    const next = new Set(selected);
    filtered.forEach(w => next.delete(w.id));
    onSelectionChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Workspaces to Load</DialogTitle>
          <DialogDescription>
            Choose which workspaces to load cards from. Loading fewer workspaces
            is faster.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Search workspaces..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={selectFiltered}>
              <CheckSquare className="h-3 w-3 mr-1" />
              {search ? "Select Filtered" : "Select All"}
            </Button>
            <Button size="sm" variant="outline" onClick={clearFiltered}>
              {search ? "Clear Filtered" : "Clear All"}
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1 border rounded-md p-2">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No workspaces match "{search}"
              </p>
            ) : (
              filtered.map(workspace => (
                <label
                  key={workspace.id}
                  className="flex items-center gap-2 p-2 hover:bg-muted/50 rounded cursor-pointer"
                >
                  <Checkbox
                    checked={selected.has(workspace.id)}
                    onCheckedChange={checked => toggle(workspace.id, !!checked)}
                  />
                  <span className="flex-1 text-sm">{workspace.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {workspace.boardCount} boards •{" "}
                    {workspace.boards?.reduce(
                      (s, b: any) => s + (b.cardCount || 0),
                      0
                    ) || 0}{" "}
                    cards
                  </span>
                </label>
              ))
            )}
          </div>

          <p className="text-sm text-muted-foreground">
            {selected.size} workspace{selected.size !== 1 ? "s" : ""} selected (
            {totalBoards} boards)
            {search && (
              <span className="ml-2">
                · Showing {filtered.length} of {workspaces.length}
              </span>
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={selected.size === 0 || isLoading} onClick={onLoad}>
            <Download className="h-4 w-4 mr-2" />
            Load Selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface AutoLoadProgressCardProps {
  progress: AutoLoadProgress;
  onCancel: () => void;
  onRetryFailed: () => void;
  onDismiss: () => void;
  onRetryBoard: (board: {
    id: string;
    name: string;
    workspaceName: string;
  }) => void;
}

function AutoLoadProgressCard({
  progress,
  onCancel,
  onRetryFailed,
  onDismiss,
  onRetryBoard,
}: AutoLoadProgressCardProps) {
  const pct =
    progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  const estimatedRemaining = useMemo(() => {
    if (!progress.isLoading || !progress.startTime || progress.current < 2)
      return null;
    const elapsed = (Date.now() - progress.startTime) / 1000;
    const avg = elapsed / progress.current;
    return formatTimeRemaining((progress.total - progress.current) * avg);
  }, [progress]);

  return (
    <Card className="bg-primary/5 border-primary/20">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {progress.isLoading && (
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            )}
            <div>
              <p className="font-medium">
                {progress.isLoading ? "Loading cards…" : "Loading complete"}
              </p>
              <p className="text-sm text-muted-foreground">
                {progress.currentBoard || "Preparing…"}
              </p>
            </div>
          </div>
          <div className="text-right text-sm">
            <p className="font-medium">
              {progress.current} / {progress.total} boards
            </p>
            <p className="text-muted-foreground">{Math.round(pct)}%</p>
            {progress.isLoading && estimatedRemaining && (
              <p className="text-xs text-muted-foreground flex items-center justify-end gap-1 mt-1">
                <Clock className="h-3 w-3" />~{estimatedRemaining} remaining
              </p>
            )}
          </div>
        </div>

        <Progress value={pct} className="h-2" />

        <div className="flex items-center justify-between text-sm">
          <div className="flex gap-4">
            <span className="text-green-600">✓ Loaded: {progress.loaded}</span>
            <span className="text-blue-600">⊘ Skipped: {progress.skipped}</span>
            {progress.failed > 0 && (
              <span className="text-red-600">✗ Failed: {progress.failed}</span>
            )}
            {progress.cancelled && (
              <span className="text-amber-600">⚠ Cancelled</span>
            )}
          </div>
          <div className="flex gap-2">
            {progress.isLoading && (
              <Button size="sm" variant="destructive" onClick={onCancel}>
                Cancel
              </Button>
            )}
            {!progress.isLoading && progress.failedBoards.length > 0 && (
              <Button size="sm" variant="outline" onClick={onRetryFailed}>
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry {progress.failedBoards.length} Failed
              </Button>
            )}
            {!progress.isLoading && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        </div>

        {!progress.isLoading && progress.skippedCards.length > 0 && (
          <div className="border-t pt-3">
            <p className="text-sm font-medium text-blue-600 mb-2">
              Skipped Cards ({progress.skippedCards.length}):
            </p>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {progress.skippedCards.map(card => (
                <div
                  key={card.cardId}
                  className="text-xs text-muted-foreground bg-blue-50 dark:bg-blue-950/20 px-2 py-1.5 rounded"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <p className="font-medium text-blue-700 dark:text-blue-300 truncate">
                        {card.cardName}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {card.boardName}
                      </p>
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                        Reason: {card.reason}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!progress.isLoading && progress.failedBoards.length > 0 && (
          <div className="border-t pt-3">
            <p className="text-sm font-medium text-red-600 mb-2">
              Failed Boards:
            </p>
            <div className="max-h-32 overflow-y-auto space-y-1">
              {progress.failedBoards.map(board => (
                <div
                  key={`${board.id}-${board.workspaceName}`}
                  className="text-xs text-muted-foreground flex items-center justify-between bg-red-50 dark:bg-red-950/20 px-2 py-1 rounded"
                >
                  <span>
                    {board.workspaceName} / {board.name}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => onRetryBoard(board)}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface CardRowProps {
  card: TrelloCard;
  onToggle: (id: string) => void;
  onInterview: (id: string, name: string) => void;
}

function CardRow({ card, onToggle, onInterview }: CardRowProps) {
  return (
    <Card className={card.selected ? "border-primary" : ""}>
      <CardContent className="py-4">
        <div className="flex items-start gap-4">
          <Checkbox
            checked={card.selected}
            onCheckedChange={() => onToggle(card.id)}
            className="mt-1"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <a
                href={`https://trello.com/c/${card.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium truncate hover:text-primary hover:underline transition-colors"
                onClick={e => e.stopPropagation()}
              >
                {card.name}
              </a>
              {card.hasAPTLSS && (
                <Badge variant="secondary" className="shrink-0">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Has APTLSS
                </Badge>
              )}
              {card.due && new Date(card.due) < new Date() && (
                <Badge variant="destructive" className="shrink-0 text-xs">
                  Overdue
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground line-clamp-2">
              {card.desc || "No description"}
            </p>
            <div className="flex gap-2 mt-2 flex-wrap">
              {card.boardName && (
                <Badge variant="outline" className="text-xs">
                  {card.boardName}
                </Badge>
              )}
              {card.listName && (
                <Badge variant="outline" className="text-xs">
                  {card.listName}
                </Badge>
              )}
            </div>
          </div>
          {/* Interview button on hover-friendly right side */}
          <Button
            size="sm"
            variant="ghost"
            onClick={e => {
              e.stopPropagation();
              onInterview(card.id, card.name);
            }}
            className="shrink-0 gap-1 text-muted-foreground hover:text-foreground"
            title="Start Goal Interview"
          >
            <MessageSquare className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">Interview</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

//  Main Component

export default function APTLSSManagement() {
  const { addOperation, updateOperation } = useLoadingQueue();

  //  Data state
  const [workspaces, setWorkspaces] = useState<TrelloWorkspace[]>([]);
  const [boards, setBoards] = useState<TrelloBoard[]>([]);
  const [cards, setCards] = useState<TrelloCard[]>([]);

  //  UI / filter state
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterBoard, setFilterBoard] = useState<string>("all");

  //  Generation progress
  const [progress, setProgress] = useState<GenerationProgress>({
    total: 0,
    completed: 0,
    failed: 0,
    status: "idle",
  });

  //  History
  const [history, setHistory] = useState<any[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<any>(null);

  //  Settings
  const [settings, setSettings] = useState({
    skipExisting: true,
    validateBeforeGenerate: true,
    autoReminder: false,
    batchSize: 10,
    scheduledTime: "",
    scheduledJobs: [] as any[],
  });

  //  Auto-load
  const [autoLoadProgress, setAutoLoadProgress] =
    useState<AutoLoadProgress | null>(null);
  const cancelLoadRef = useRef(false);

  //  Workspace load progress
  const [wsLoadProgress, setWsLoadProgress] = useState<{
    isLoading: boolean;
    loaded: number;
    total: number;
    totalBoards: number;
    totalCards: number;
    failed: number;
    currentWorkspace: string;
  } | null>(null);

  //  Workspace selector dialog
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);
  const [selectedWorkspacesForLoad, setSelectedWorkspacesForLoad] = useState<
    Set<string>
  >(new Set());

  //  Goal interview
  const [interviewCardId, setInterviewCardId] = useState<string | null>(null);
  const [interviewCardName, setInterviewCardName] = useState<string>("");
  const [clarifiedGoal, setClarifiedGoal] = useState<any | null>(null);
  const [clarifiedCardId, setClarifiedCardId] = useState<string | null>(null);

  //  Clear-cache confirmation
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  //  Derived / memoised
  const filteredCards = useMemo(() => {
    const seen = new Set<string>();
    return cards.filter(card => {
      if (seen.has(card.id)) return false;
      seen.add(card.id);
      const matchesSearch =
        !searchTerm ||
        card.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        card.desc.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesBoard =
        filterBoard === "all" || card.idBoard === filterBoard;
      return matchesSearch && matchesBoard;
    });
  }, [cards, searchTerm, filterBoard]);

  const selectedCount = useMemo(
    () => cards.filter(c => c.selected).length,
    [cards]
  );
  const progressPercent =
    progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
  const activeJob =
    Array.isArray(history) ? (history.find((job: any) => job.id === progress.jobId) ?? null) : null;

  // Unique boards for the filter dropdown
  const boardOptions = useMemo(() => {
    const map = new Map<string, string>();
    cards.forEach(c => {
      if (c.idBoard && c.boardName) map.set(c.idBoard, c.boardName);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [cards]);

  //  Persistence
  // Load from localStorage on mount
  useEffect(() => {
    const savedCards = localStorage.getItem(CARDS_STORAGE_KEY);
    if (savedCards) {
      try {
        const parsed = JSON.parse(savedCards);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setCards(parsed);
          toast.success(`Restored ${parsed.length} cards from cache`);
        }
      } catch {
        localStorage.removeItem(CARDS_STORAGE_KEY);
      }
    }

    const savedWs = localStorage.getItem(WORKSPACE_SELECTION_KEY);
    if (savedWs) {
      try {
        const parsed = JSON.parse(savedWs);
        if (Array.isArray(parsed))
          setSelectedWorkspacesForLoad(new Set(parsed));
      } catch {
        localStorage.removeItem(WORKSPACE_SELECTION_KEY);
      }
    }
  }, []);

  // Debounced save to localStorage (avoid serialising on every card toggle)
  const saveCardsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (cards.length === 0) return;
    if (saveCardsTimer.current) clearTimeout(saveCardsTimer.current);
    saveCardsTimer.current = setTimeout(() => {
      localStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify(cards));
    }, 500);
    return () => {
      if (saveCardsTimer.current) clearTimeout(saveCardsTimer.current);
    };
  }, [cards]);

  useEffect(() => {
    if (selectedWorkspacesForLoad.size > 0) {
      localStorage.setItem(
        WORKSPACE_SELECTION_KEY,
        JSON.stringify(Array.from(selectedWorkspacesForLoad))
      );
    }
  }, [selectedWorkspacesForLoad]);

  //  Initial data load
  useEffect(() => {
    void loadWorkspaces();
    void loadBoards();
    void loadHistory();
    void loadScheduledJobs();
  }, []);

  // Auto-load all cards when workspaces are loaded
  useEffect(() => {
    if (
      workspaces.length > 0 &&
      cards.length === 0 &&
      autoLoadProgress === null
    ) {
      void autoLoadAllCards(false);
    }
  }, [workspaces.length, cards.length, autoLoadProgress]);

  //  History auto-refresh
  useEffect(() => {
    const hasActive = history.some((j: any) => j.status === "running");
    if (!hasActive) return;
    const id = window.setInterval(() => void loadHistory(), HISTORY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [history]);

  //  Job details auto-refresh
  useEffect(() => {
    const selectedJob = history.find((job: any) => job.id === selectedJobId);
    if (!selectedJobId || selectedJob?.status !== "running") return;
    const id = window.setInterval(
      () => void toggleJobDetails(selectedJobId, true),
      HISTORY_REFRESH_MS
    );
    return () => window.clearInterval(id);
  }, [selectedJobId, history]);

  //  Generation status polling
  useEffect(() => {
    if (
      !progress.jobId ||
      (progress.status !== "running" && progress.status !== "submitting")
    )
      return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/aptlss/status/${progress.jobId}`);
        if (!res.ok) return;
        const data = (await res.json()) as GenerationJobStatusResponse;
        setProgress(prev => ({
          ...prev,
          total: data.progress.total,
          completed: data.progress.completed,
          failed: data.progress.failed,
          status: data.status,
          completedAt: data.completedAt ?? null,
        }));
        if (data.status !== "running") await loadHistory();
      } catch (err) {
        console.error("Failed to poll generation status:", err);
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 2000);
    return () => window.clearInterval(id);
  }, [progress.jobId, progress.status]);

  //  API helpers
  const loadWorkspaces = async () => {
    setLoading(true);
    setWsLoadProgress({
      isLoading: true,
      loaded: 0,
      total: 0,
      totalBoards: 0,
      totalCards: 0,
      failed: 0,
      currentWorkspace: "Fetching workspace list…",
    });
    try {
      const res = await fetch("/api/trello/workspaces");
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || res.statusText);
      }
      const data = await res.json();
      if (!Array.isArray(data))
        throw new Error(data.error || "Invalid response format");

      // Update total so the progress bar has a denominator immediately
      setWsLoadProgress(prev =>
        prev
          ? {
              ...prev,
              total: data.length,
              currentWorkspace: "Processing workspaces…",
            }
          : null
      );

      const mapped: TrelloWorkspace[] = [];
      let failedCount = 0;

      for (let i = 0; i < data.length; i++) {
        const w = data[i];
        try {
          mapped.push({
            id: w.id,
            name: w.name,
            boardCount: w.boardCount || 0,
            cardCount: w.cardCount || 0,
            boards: w.boards || [],
            selected: false,
          });
        } catch {
          failedCount++;
        }

        if (i % 5 === 0 || i === data.length - 1) {
          const totalBoards = mapped.reduce((s, ws) => s + ws.boardCount, 0);
          const totalCards = mapped.reduce(
            (s, ws) => s + (ws.cardCount || 0),
            0
          );
          setWsLoadProgress(prev =>
            prev
              ? {
                  ...prev,
                  currentWorkspace: w.name,
                  loaded: i + 1,
                  totalBoards,
                  totalCards,
                  failed: failedCount,
                }
              : null
          );
        }
      }

      setWorkspaces(mapped);
      setWsLoadProgress(prev =>
        prev ? { ...prev, isLoading: false, currentWorkspace: "" } : null
      );
      toast.success(`Loaded ${mapped.length} workspaces`);
    } catch (err) {
      toast.error("Failed to load workspaces");
      console.error(err);
      setWsLoadProgress(prev =>
        prev
          ? { ...prev, isLoading: false, failed: (prev.failed ?? 0) + 1 }
          : null
      );
    } finally {
      setLoading(false);
    }
  };

  const loadBoards = async () => {
    try {
      const res = await fetch("/api/trello/boards");
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setBoards(
        data.map((b: any) => ({
          id: b.id,
          name: b.name,
          cardCount: b.cardCount || 0,
          selected: false,
        }))
      );
    } catch (err) {
      console.error("Failed to load boards:", err);
    }
  };

  const loadHistory = async () => {
    try {
      const res = await fetch("/api/aptlss/history");
      const data = await res.json();
      setHistory(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Error loading history:", err);
    }
  };

  const loadScheduledJobs = async () => {
    try {
      const res = await fetch("/api/aptlss/scheduled");
      const jobs = await res.json();
      setSettings(prev => ({ ...prev, scheduledJobs: jobs }));
    } catch (err) {
      console.error("Error loading scheduled jobs:", err);
    }
  };

  const toggleJobDetails = async (jobId: string, keepOpen = false) => {
    if (!keepOpen && selectedJobId === jobId) {
      setSelectedJobId(null);
      setJobDetails(null);
      return;
    }
    try {
      const res = await fetch(`/api/aptlss/history/${jobId}`);
      const data = await res.json();
      setJobDetails(data);
      if (!keepOpen) setSelectedJobId(jobId);
    } catch (err) {
      console.error("Error loading job details:", err);
      toast.error("Failed to load job details");
    }
  };

  const retryFailedItems = async (jobId: string) => {
    try {
      const res = await fetch(`/api/aptlss/history/${jobId}/retry`, {
        method: "POST",
      });
      const result = await res.json();
      if (result.success) {
        toast.success(`Retrying ${result.itemsToRetry} failed items`);
        void loadHistory();
      } else {
        toast.info(result.message || "No items to retry");
      }
    } catch (err) {
      console.error("Error retrying items:", err);
      toast.error("Failed to retry items");
    }
  };

  //  Card selection helpers
  const toggleCardSelection = useCallback((cardId: string) => {
    setCards(prev =>
      prev.map(c => (c.id === cardId ? { ...c, selected: !c.selected } : c))
    );
  }, []);

  const selectAllCards = () =>
    setCards(prev => prev.map(c => ({ ...c, selected: true })));
  const deselectAllCards = () =>
    setCards(prev => prev.map(c => ({ ...c, selected: false })));

  const selectAllFiltered = () => {
    const ids = new Set(filteredCards.map(c => c.id));
    setCards(prev =>
      prev.map(c => (ids.has(c.id) ? { ...c, selected: true } : c))
    );
    toast.success(`Selected ${ids.size} filtered cards`);
  };

  const selectWithoutAPTLSS = () => {
    const count = cards.filter(c => !c.hasAPTLSS).length;
    setCards(prev => prev.map(c => ({ ...c, selected: !c.hasAPTLSS })));
    toast.success(`Selected ${count} cards without APTLSS`);
  };

  const selectOverdue = () => {
    const now = new Date();
    const count = cards.filter(c => c.due && new Date(c.due) < now).length;
    setCards(prev =>
      prev.map(c => ({ ...c, selected: !!(c.due && new Date(c.due) < now) }))
    );
    toast.success(`Selected ${count} overdue cards`);
  };

  const selectWithAttachments = () => {
    const count = cards.filter(c => (c.badges?.attachments ?? 0) > 0).length;
    setCards(prev =>
      prev.map(c => ({ ...c, selected: (c.badges?.attachments ?? 0) > 0 }))
    );
    toast.success(`Selected ${count} cards with attachments`);
  };

  //  Cache
  const clearCache = () => {
    localStorage.removeItem(CARDS_STORAGE_KEY);
    setCards([]);
    setAutoLoadProgress(null);
    setShowClearConfirm(false);
    toast.success("Card cache cleared");
  };

  //  Board card loading (shared)
  const loadCardsForBoard = async (boardId: string, boardName: string) => {
    try {
      const raw = await fetchBoardCards(boardId);
      const newCards = raw.map(c => mapRawCard(c, boardName));
      setCards(prev => {
        const existingIds = new Set(prev.map(c => c.id));
        return [...prev, ...newCards.filter(c => !existingIds.has(c.id))];
      });
      toast.success(`Loaded ${newCards.length} cards from ${boardName}`);
    } catch (err) {
      console.error("Error loading cards:", err);
      toast.error(`Failed to load cards from ${boardName}`);
    }
  };

  //  Auto-load all cards
  const cancelAutoLoad = () => {
    cancelLoadRef.current = true;
    toast.info("Cancelling load operation");
  };

  const autoLoadAllCards = async (selectedOnly = false) => {
    if (workspaces.length === 0) {
      if (!selectedOnly) {
        // Silent fail for auto-load, show error for manual load
        return;
      }
      toast.error("No workspaces available. Please refresh first.");
      return;
    }

    cancelLoadRef.current = false;

    const allBoards: {
      id: string;
      name: string;
      workspaceName: string;
      cardCount: number;
    }[] = [];
    for (const ws of workspaces) {
      if (selectedOnly && !selectedWorkspacesForLoad.has(ws.id)) continue;
      for (const board of ws.boards) {
        allBoards.push({
          id: board.id,
          name: board.name,
          workspaceName: ws.name,
          cardCount: board.cardCount || 0,
        });
      }
    }

    if (allBoards.length === 0) {
      toast.error(
        selectedOnly ? "No boards in selected workspaces." : "No boards found."
      );
      return;
    }

    const existingIds = new Set(cards.map(c => c.id));
    const skippedCardsList: {
      cardId: string;
      cardName: string;
      boardName: string;
      reason: string;
    }[] = [];

    setAutoLoadProgress({
      isLoading: true,
      current: 0,
      total: allBoards.length,
      loaded: 0,
      skipped: 0,
      failed: 0,
      failedBoards: [],
      skippedCards: [],
      currentBoard: "",
      cancelled: false,
      startTime: Date.now(),
    });

    const opId = "aptlss-load-cards";
    addOperation(opId, `Loading cards from ${allBoards.length} boards`);
    setShowWorkspaceSelector(false);

    const newCards: TrelloCard[] = [];
    const failedBoards: { id: string; name: string; workspaceName: string }[] =
      [];
    let loadedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < allBoards.length; i++) {
      if (cancelLoadRef.current) {
        setAutoLoadProgress(prev =>
          prev ? { ...prev, isLoading: false, cancelled: true } : null
        );
        updateOperation(opId, { status: "cancelled" });
        toast.warning(`Load cancelled. ${loadedCount} cards loaded.`);
        if (newCards.length > 0) setCards(prev => [...prev, ...newCards]);
        return;
      }

      const board = allBoards[i];
      setAutoLoadProgress(prev =>
        prev
          ? {
              ...prev,
              current: i + 1,
              currentBoard: `${board.workspaceName} / ${board.name}`,
            }
          : null
      );
      updateOperation(opId, {
        progress: Math.round(((i + 1) / allBoards.length) * 100),
        current: i + 1,
        total: allBoards.length,
      });

      let success = false;
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        try {
          if (attempt > 0)
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          const raw = await fetchBoardCards(board.id);
          for (const card of raw) {
            if (existingIds.has(card.id)) {
              skippedCount++;
              skippedCardsList.push({
                cardId: card.id,
                cardName: card.name,
                boardName: board.name,
                reason: "Already cached in your system",
              });
            } else {
              newCards.push(mapRawCard(card, board.name));
              existingIds.add(card.id);
              loadedCount++;
            }
          }
          success = true;
        } catch (err) {
          console.error(
            `Attempt ${attempt + 1} failed for ${board.name}:`,
            err
          );
        }
      }

      if (!success) failedBoards.push(board);

      setAutoLoadProgress(prev =>
        prev
          ? {
              ...prev,
              loaded: loadedCount,
              skipped: skippedCount,
              failed: failedBoards.length,
              failedBoards: [...failedBoards],
              skippedCards: skippedCardsList,
            }
          : null
      );
    }

    if (newCards.length > 0) setCards(prev => [...prev, ...newCards]);
    setAutoLoadProgress(prev => (prev ? { ...prev, isLoading: false } : null));

    if (failedBoards.length === 0) {
      updateOperation(opId, { status: "completed", progress: 100 });
      toast.success(
        `Loaded ${loadedCount} new cards (${skippedCount} already cached)`
      );
    } else {
      updateOperation(opId, { status: "failed", progress: 100 });
      toast.warning(
        `Loaded ${loadedCount} cards, ${failedBoards.length} boards failed`
      );
    }
  };

  const retryFailedBoards = async () => {
    if (!autoLoadProgress || autoLoadProgress.failedBoards.length === 0) return;
    const toRetry = [...autoLoadProgress.failedBoards];
    const existingIds = new Set(cards.map(c => c.id));

    setAutoLoadProgress(prev =>
      prev
        ? {
            ...prev,
            isLoading: true,
            current: 0,
            total: toRetry.length,
            failedBoards: [],
            failed: 0,
            skippedCards: [],
          }
        : null
    );

    const newCards: TrelloCard[] = [];
    const stillFailed: { id: string; name: string; workspaceName: string }[] =
      [];
    let loadedCount = 0;

    for (let i = 0; i < toRetry.length; i++) {
      const board = toRetry[i];
      setAutoLoadProgress(prev =>
        prev
          ? {
              ...prev,
              current: i + 1,
              currentBoard: `${board.workspaceName} / ${board.name}`,
            }
          : null
      );

      let success = false;
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        try {
          if (attempt > 0)
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          const raw = await fetchBoardCards(board.id);
          for (const card of raw) {
            if (!existingIds.has(card.id)) {
              newCards.push(mapRawCard(card, board.name));
              existingIds.add(card.id);
              loadedCount++;
            }
          }
          success = true;
        } catch (err) {
          console.error(
            `Retry attempt ${attempt + 1} failed for ${board.name}:`,
            err
          );
        }
      }
      if (!success) stillFailed.push(board);

      setAutoLoadProgress(prev =>
        prev
          ? {
              ...prev,
              loaded: prev.loaded + loadedCount,
              failed: stillFailed.length,
              failedBoards: [...stillFailed],
            }
          : null
      );
    }

    if (newCards.length > 0) setCards(prev => [...prev, ...newCards]);
    setAutoLoadProgress(prev => (prev ? { ...prev, isLoading: false } : null));

    if (stillFailed.length === 0) {
      toast.success(`Retry successful! Loaded ${loadedCount} cards`);
    } else {
      toast.warning(
        `Loaded ${loadedCount} cards, ${stillFailed.length} boards still failing`
      );
    }
  };

  const retryOneBoard = async (board: {
    id: string;
    name: string;
    workspaceName: string;
  }) => {
    try {
      const raw = await fetchBoardCards(board.id);
      const existingIds = new Set(cards.map(c => c.id));
      const newCards = raw
        .filter(c => !existingIds.has(c.id))
        .map(c => mapRawCard(c, board.name));
      if (newCards.length > 0) setCards(prev => [...prev, ...newCards]);
      setAutoLoadProgress(prev =>
        prev
          ? {
              ...prev,
              failedBoards: prev.failedBoards.filter(b => b.id !== board.id),
              failed: prev.failed - 1,
              loaded: prev.loaded + newCards.length,
            }
          : null
      );
      toast.success(`Loaded ${newCards.length} cards from ${board.name}`);
    } catch {
      toast.error(`Failed to retry ${board.name}`);
    }
  };

  //  Generation
  const startGeneration = async () => {
    const selected = cards.filter(c => c.selected);
    if (selected.length === 0) {
      toast.error("Please select at least one card");
      return;
    }

    setProgress({
      total: selected.length,
      completed: 0,
      failed: 0,
      status: "submitting",
    });
    toast.info(`Starting APTLSS generation for ${selected.length} cards`);

    try {
      const res = await fetch("/api/aptlss/generate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          cardIds: selected.map(c => c.id),
          settings: { ...settings, clarifiedGoal },
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Failed to generate APTLSS");

      setProgress({
        jobId: data.jobId,
        total: data.total || selected.length,
        completed: data.completed || 0,
        failed: data.failed || 0,
        current: "",
        status: data.failed > 0 ? "completed_with_errors" : "completed",
        completedAt: new Date().toISOString(),
      });

      await loadHistory();
      await loadScheduledJobs();
      setSelectedJobId(data.jobId);
      await toggleJobDetails(data.jobId, true);

      if (data.failed > 0) {
        toast.warning(
          `APTLSS generation completed with ${data.failed} failure(s)`
        );
      } else {
        toast.success(
          `Generated APTLSS for ${data.completed || selected.length} cards`
        );
      }
    } catch (err) {
      console.error("Failed to generate APTLSS:", err);
      toast.error(
        err instanceof Error ? err.message : "Failed to generate APTLSS"
      );
      setProgress(prev => ({ ...prev, status: "failed" }));
    }
  };

  //  Render
  return (
    <div className="container mx-auto py-4 md:py-6 space-y-4 md:space-y-6">
      {/*  Header  */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4">
        <div className="flex items-center gap-2 md:gap-4">
          <Link href="/">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 md:h-10 md:w-10"
            >
              <ArrowLeft className="h-4 w-4 md:h-5 md:w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl md:text-3xl font-bold">APTLSS Management</h1>
            <p className="text-xs md:text-sm text-muted-foreground">
              Select cards and generate APTLSS checklists in bulk
            </p>
          </div>
        </div>
        <Button
          onClick={() => {
            void loadWorkspaces();
            void loadBoards();
          }}
          variant="outline"
          disabled={loading}
          className="w-full md:w-auto"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/*  Generation Progress Card  */}
      {progress.status !== "idle" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 text-lg md:text-xl">
              <span>Generation Progress</span>
              <div className="flex items-center gap-2">
                <Badge variant={getJobBadgeVariant(progress.status)}>
                  {progress.status.replace(/_/g, " ")}
                </Badge>
                {(progress.status === "completed" ||
                  progress.status === "completed_with_errors" ||
                  progress.status === "failed") && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() =>
                      setProgress({
                        total: 0,
                        completed: 0,
                        failed: 0,
                        status: "idle",
                      })
                    }
                    title="Dismiss"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardTitle>
            <CardDescription className="text-xs md:text-sm">
              {progress.jobId
                ? `Job ${progress.jobId}`
                : "Submitting generation request"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={progressPercent} className="h-2" />
            <div className="flex justify-between text-sm">
              <span>
                Completed: {progress.completed}/{progress.total}
              </span>
              <span>Failed: {progress.failed}</span>
              <span>{Math.round(progressPercent)}%</span>
            </div>
            {progress.status === "submitting" && (
              <p className="text-sm text-muted-foreground">
                The server is creating the batch job and will respond with the
                final result when processing finishes.
              </p>
            )}
            {progress.status === "running" && (
              <p className="text-sm text-muted-foreground">
                Polling server for live job status
              </p>
            )}
            {progress.status === "completed_with_errors" && (
              <p className="text-sm text-amber-700">
                Batch finished with partial failures. Review the History tab to
                retry failed cards.
              </p>
            )}
            {progress.status === "failed" && (
              <p className="text-sm text-red-700">
                Request failed before the batch completed. Check the History tab
                for partial records.
              </p>
            )}
            {progress.completedAt && (
              <p className="text-xs text-muted-foreground">
                Last updated: {new Date(progress.completedAt).toLocaleString()}
              </p>
            )}
            {activeJob?.failedCards > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => retryFailedItems(activeJob.id)}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry {activeJob.failedCards} Failed Items
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/*  Main Tabs  */}
      <Tabs defaultValue="workspaces" className="flex-1">
        <Card>
          <CardHeader>
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
              <TabsTrigger value="cards">
                Cards
                {cards.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {cards.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
          </CardHeader>
          <CardContent>
            {/*  Workspaces Tab  */}
            <TabsContent value="workspaces" className="space-y-4">
              {/* Workspace load progress */}
              {wsLoadProgress && (
                <Card className="bg-primary/5 border-primary/20">
                  <CardContent className="py-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {wsLoadProgress.isLoading && (
                          <Loader2 className="h-5 w-5 animate-spin text-primary" />
                        )}
                        <div>
                          <p className="font-medium">
                            {wsLoadProgress.isLoading
                              ? "Loading workspaces…"
                              : "Workspaces loaded"}
                          </p>
                          {wsLoadProgress.currentWorkspace ? (
                            <p className="text-sm text-muted-foreground truncate max-w-xs">
                              {wsLoadProgress.currentWorkspace}
                            </p>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              {wsLoadProgress.isLoading ? "Preparing…" : "Done"}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="text-right text-sm">
                        <p className="font-medium">
                          {wsLoadProgress.loaded}
                          {wsLoadProgress.total > 0
                            ? ` / ${wsLoadProgress.total}`
                            : ""}{" "}
                          workspaces
                        </p>
                        {wsLoadProgress.total > 0 && (
                          <p className="text-muted-foreground">
                            {Math.round(
                              (wsLoadProgress.loaded / wsLoadProgress.total) *
                                100
                            )}
                            %
                          </p>
                        )}
                      </div>
                    </div>

                    {wsLoadProgress.total > 0 && (
                      <Progress
                        value={
                          (wsLoadProgress.loaded / wsLoadProgress.total) * 100
                        }
                        className="h-2"
                      />
                    )}

                    <div className="flex items-center justify-between text-sm">
                      <div className="flex gap-4">
                        <span className="text-green-600">
                          ✓ Workspaces: {wsLoadProgress.loaded}
                        </span>
                        <span className="text-blue-600">
                          ⊞ Boards: {wsLoadProgress.totalBoards}
                        </span>
                        <span className="text-muted-foreground">
                          🗂 Cards: {wsLoadProgress.totalCards.toLocaleString()}
                        </span>
                        {wsLoadProgress.failed > 0 && (
                          <span className="text-red-600">
                            ✗ Failed: {wsLoadProgress.failed}
                          </span>
                        )}
                      </div>
                      {!wsLoadProgress.isLoading && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setWsLoadProgress(null)}
                        >
                          Dismiss
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {workspaces.length} workspaces available
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadWorkspaces()}
                  disabled={wsLoadProgress?.isLoading}
                >
                  <RefreshCw
                    className={`h-4 w-4 mr-2 ${wsLoadProgress?.isLoading ? "animate-spin" : ""}`}
                  />
                  Load Workspaces
                </Button>
              </div>

              <div className="grid gap-4">
                {workspaces.length === 0 && !wsLoadProgress ? (
                  <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                      No workspaces loaded. Click Refresh to load.
                    </CardContent>
                  </Card>
                ) : workspaces.length === 0 &&
                  wsLoadProgress?.isLoading ? null : (
                  workspaces.map(workspace => (
                    <Card key={workspace.id}>
                      <CardHeader>
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div>
                            <CardTitle className="text-lg">
                              {workspace.name}
                            </CardTitle>
                            <CardDescription>
                              {workspace.boardCount} boards{" "}
                              {workspace.boards?.reduce(
                                (s, b: any) => s + (b.cardCount || 0),
                                0
                              ) || 0}{" "}
                              total cards
                            </CardDescription>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              // Load all boards in this workspace
                              const boardsToLoad = workspace.boards;
                              if (boardsToLoad.length === 0) return;
                              Promise.all(
                                boardsToLoad.map(b =>
                                  loadCardsForBoard(b.id, b.name)
                                )
                              ).then(() =>
                                toast.success(
                                  `Loaded all boards from ${workspace.name}`
                                )
                              );
                            }}
                            disabled={loading}
                          >
                            <Download className="h-4 w-4 mr-2" />
                            Load All Boards
                          </Button>
                        </div>
                      </CardHeader>
                      {workspace.boards && workspace.boards.length > 0 && (
                        <CardContent>
                          <div className="space-y-2">
                            <p className="text-sm font-medium text-muted-foreground mb-2">
                              Boards:
                            </p>
                            <div className="grid gap-2">
                              {workspace.boards.map((board: any) => (
                                <div
                                  key={board.id}
                                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-accent/50 transition-colors"
                                >
                                  <div>
                                    <p className="font-medium">{board.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {board.cardCount || 0} cards
                                    </p>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      loadCardsForBoard(board.id, board.name)
                                    }
                                  >
                                    Load Cards
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        </CardContent>
                      )}
                    </Card>
                  ))
                )}
              </div>
            </TabsContent>

            {/*  Cards Tab  */}
            <TabsContent value="cards" className="space-y-4">
              {/* Auto-load progress */}
              {autoLoadProgress && (
                <AutoLoadProgressCard
                  progress={autoLoadProgress}
                  onCancel={cancelAutoLoad}
                  onRetryFailed={retryFailedBoards}
                  onDismiss={() => setAutoLoadProgress(null)}
                  onRetryBoard={retryOneBoard}
                />
              )}

              {/* Clarified goal indicator */}
              {clarifiedGoal && (
                <div className="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-md text-sm text-green-800 dark:text-green-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>
                    Goal clarified for{" "}
                    <strong>
                      {clarifiedCardId
                        ? (cards.find(c => c.id === clarifiedCardId)?.name ??
                          "card")
                        : "card"}
                    </strong>
                    . This goal will be used for the next generation.
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 ml-auto shrink-0"
                    onClick={() => {
                      setClarifiedGoal(null);
                      setClarifiedCardId(null);
                    }}
                    title="Clear clarified goal"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}

              {/* Summary + load actions */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm text-muted-foreground">
                  {cards.length > 0
                    ? `${cards.length} cards loaded  ${filteredCards.length} shown  ${selectedCount} selected`
                    : `Total cards across all workspaces: ${workspaces.reduce((s, w) => s + (w.boards?.reduce((bs, b: any) => bs + (b.cardCount || 0), 0) || 0), 0)}`}
                </p>
                <div className="flex gap-2 flex-wrap">
                  {cards.length > 0 && (
                    <Button
                      onClick={() => setShowClearConfirm(true)}
                      variant="outline"
                      size="sm"
                      disabled={autoLoadProgress?.isLoading}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Clear Cache
                    </Button>
                  )}
                  <Button
                    onClick={() => setShowWorkspaceSelector(true)}
                    variant="outline"
                    size="sm"
                    disabled={
                      autoLoadProgress?.isLoading || workspaces.length === 0
                    }
                  >
                    <Filter className="h-4 w-4 mr-2" />
                    Select Workspaces
                  </Button>
                  <Button
                    onClick={() => autoLoadAllCards(false)}
                    variant="default"
                    size="sm"
                    disabled={
                      autoLoadProgress?.isLoading || workspaces.length === 0
                    }
                  >
                    {autoLoadProgress?.isLoading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    {autoLoadProgress?.isLoading ? "Loading" : "Load All Cards"}
                  </Button>
                </div>
              </div>

              {/* Filters + selection actions */}
              <Card>
                <CardContent className="pt-6">
                  <div className="flex flex-col md:flex-row gap-4">
                    <div className="flex-1">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Search cards"
                          value={searchTerm}
                          onChange={e => setSearchTerm(e.target.value)}
                          className="pl-10"
                        />
                      </div>
                    </div>
                    {boardOptions.length > 0 && (
                      <Select
                        value={filterBoard}
                        onValueChange={setFilterBoard}
                      >
                        <SelectTrigger className="w-full md:w-48">
                          <SelectValue placeholder="Filter by board" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Boards</SelectItem>
                          {boardOptions.map(b => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="flex gap-2 flex-wrap mt-4">
                    <Button
                      onClick={selectAllCards}
                      variant="outline"
                      size="sm"
                    >
                      Select All
                    </Button>
                    {(searchTerm || filterBoard !== "all") && (
                      <Button
                        onClick={selectAllFiltered}
                        variant="outline"
                        size="sm"
                      >
                        Select Filtered ({filteredCards.length})
                      </Button>
                    )}
                    <Button
                      onClick={deselectAllCards}
                      variant="outline"
                      size="sm"
                    >
                      Deselect All
                    </Button>
                    <Button
                      onClick={selectWithoutAPTLSS}
                      variant="outline"
                      size="sm"
                    >
                      Without APTLSS
                    </Button>
                    <Button onClick={selectOverdue} variant="outline" size="sm">
                      Overdue
                    </Button>
                    <Button
                      onClick={selectWithAttachments}
                      variant="outline"
                      size="sm"
                    >
                      With Attachments
                    </Button>
                    <Button
                      onClick={startGeneration}
                      disabled={
                        selectedCount === 0 ||
                        progress.status === "running" ||
                        progress.status === "submitting"
                      }
                      size="sm"
                    >
                      {progress.status === "running" ||
                      progress.status === "submitting" ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4 mr-2" />
                      )}
                      Generate ({selectedCount})
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Card list */}
              <div className="grid gap-3">
                {filteredCards.length === 0 ? (
                  <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                      {cards.length === 0
                        ? 'No cards loaded. Use "Load All Cards" or select workspaces above.'
                        : "No cards match the current filters."}
                    </CardContent>
                  </Card>
                ) : (
                  filteredCards.map(card => (
                    <CardRow
                      key={card.id}
                      card={card}
                      onToggle={toggleCardSelection}
                      onInterview={(id, name) => {
                        setInterviewCardId(id);
                        setInterviewCardName(name);
                      }}
                    />
                  ))
                )}
              </div>
            </TabsContent>

            {/*  History Tab  */}
            <TabsContent value="history" className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-muted-foreground">
                  View past generation jobs and retry failed items
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadHistory()}
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh
                </Button>
              </div>

              <div className="space-y-4">
                {history.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      No generation history yet. Start a batch generation to see
                      results here.
                    </CardContent>
                  </Card>
                ) : (
                  history.map((job: any) => (
                    <Card key={job.id}>
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <div>
                            <CardTitle className="text-base">
                              Job {job.id}
                            </CardTitle>
                            <CardDescription>
                              {new Date(job.createdAt).toLocaleString()}
                            </CardDescription>
                          </div>
                          <Badge variant={getJobBadgeVariant(job.status)}>
                            {job.status.replace(/_/g, " ")}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-4">
                          <Progress
                            value={
                              job.totalCards > 0
                                ? ((job.completedCards + job.failedCards) /
                                    job.totalCards) *
                                  100
                                : 0
                            }
                            className="h-2"
                          />
                          <div className="grid grid-cols-3 gap-4 text-sm">
                            <div>
                              <p className="text-muted-foreground">Total</p>
                              <p className="font-medium">{job.totalCards}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Completed</p>
                              <p className="font-medium text-green-600">
                                {job.completedCards}
                              </p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Failed</p>
                              <p className="font-medium text-red-600">
                                {job.failedCards}
                              </p>
                            </div>
                          </div>
                          {job.completedAt && (
                            <p className="text-xs text-muted-foreground">
                              Completed at{" "}
                              {new Date(job.completedAt).toLocaleString()}
                            </p>
                          )}
                          {job.failedCards > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => retryFailedItems(job.id)}
                            >
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Retry {job.failedCards} Failed Items
                            </Button>
                          )}
                          {selectedJobId === job.id && jobDetails && (
                            <div className="mt-4 space-y-2">
                              <p className="text-sm font-medium">
                                Item Details:
                              </p>
                              <div className="max-h-[300px] overflow-y-auto space-y-2">
                                {jobDetails.items.map((item: any) => (
                                  <div
                                    key={item.id}
                                    className="flex items-center justify-between p-3 border rounded text-sm"
                                  >
                                    <div className="flex-1">
                                      <p className="font-medium">
                                        {item.cardName}
                                      </p>
                                      {item.boardName && (
                                        <p className="text-xs text-muted-foreground">
                                          {item.boardName}
                                        </p>
                                      )}
                                      {item.error && (
                                        <p className="text-xs text-red-600 mt-1">
                                          Error: {item.error}
                                        </p>
                                      )}
                                    </div>
                                    <Badge
                                      variant={
                                        item.status === "completed"
                                          ? "default"
                                          : item.status === "failed"
                                            ? "destructive"
                                            : "secondary"
                                      }
                                    >
                                      {item.status}
                                    </Badge>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleJobDetails(job.id)}
                          >
                            {selectedJobId === job.id ? "Hide" : "Show"} Details
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </TabsContent>

            {/*  Settings Tab  */}
            <TabsContent value="settings" className="space-y-4">
              {/* ARES Configuration */}
              <Card>
                <CardHeader>
                  <CardTitle>ARES Configuration</CardTitle>
                  <CardDescription>
                    Manage Automated Requirement Evaluation System settings
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <AresConfigurationPanel
                    cardId=""
                    cardName="APTLSS Configuration"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Generation Settings</CardTitle>
                  <CardDescription>
                    Configure how APTLSS checklists are generated
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Skip Existing APTLSS</Label>
                      <p className="text-sm text-muted-foreground">
                        Don't regenerate for cards that already have APTLSS
                      </p>
                    </div>
                    <Switch
                      checked={settings.skipExisting}
                      onCheckedChange={checked =>
                        setSettings(prev => ({
                          ...prev,
                          skipExisting: checked,
                        }))
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Validate Before Generate</Label>
                      <p className="text-sm text-muted-foreground">
                        Run ARES validation before generating APTLSS
                      </p>
                    </div>
                    <Switch
                      checked={settings.validateBeforeGenerate}
                      onCheckedChange={checked =>
                        setSettings(prev => ({
                          ...prev,
                          validateBeforeGenerate: checked,
                        }))
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Enable Auto-Reminder</Label>
                      <p className="text-sm text-muted-foreground">
                        Automatically set up reminders for generated APTLSS
                      </p>
                    </div>
                    <Switch
                      checked={settings.autoReminder}
                      onCheckedChange={checked =>
                        setSettings(prev => ({
                          ...prev,
                          autoReminder: checked,
                        }))
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </CardContent>
        </Card>
      </Tabs>

      {/*  Workspace Selector Dialog  */}
      <WorkspaceSelectorDialog
        open={showWorkspaceSelector}
        onClose={() => setShowWorkspaceSelector(false)}
        workspaces={workspaces}
        selected={selectedWorkspacesForLoad}
        onSelectionChange={setSelectedWorkspacesForLoad}
        onLoad={() => autoLoadAllCards(true)}
        isLoading={autoLoadProgress?.isLoading ?? false}
      />

      {/*  Clear Cache Confirmation Dialog  */}
      <Dialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Clear Card Cache?
            </DialogTitle>
            <DialogDescription>
              This will remove all {cards.length} loaded cards from the local
              cache. You will need to reload them from Trello. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowClearConfirm(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={clearCache}>
              Clear Cache
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*  Goal Interview Dialog  */}
      <GoalInterviewDialog
        open={interviewCardId !== null}
        onOpenChange={open => {
          if (!open) {
            setInterviewCardId(null);
            setInterviewCardName("");
          }
        }}
        cardId={interviewCardId || ""}
        cardName={interviewCardName}
        onComplete={finalGoal => {
          toast.success(
            "Goal clarified! It will be used for the next generation."
          );
          setClarifiedGoal(finalGoal);
          setClarifiedCardId(interviewCardId);
        }}
      />
    </div>
  );
}
