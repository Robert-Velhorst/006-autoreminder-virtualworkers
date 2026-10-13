import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  Archive,
  BrainCircuit,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FileCheck2,
  Gauge,
  GripVertical,
  History,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Loader2,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sun,
  Timer,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getWorkLaneRank } from "@shared/workLanePriority";
import { formatWorkerDate } from "@shared/workerTime";
import { toast } from "sonner";

type OperatorCard = {
  cardId: string;
  cardName: string;
  cardUrl: string;
  boardName: string;
  listName: string;
  nextBestAction: string | null;
  planSummary: string | null;
  primaryState: string | null;
  stateReason: string | null;
  actionability: string | null;
  priorityScore: number;
  priorityTier: string;
  confidenceScore: number | null;
  confidenceReason: string | null;
  recommendations: string[];
  uncertainties: string[];
  evidenceSummary: {
    sources: Array<{
      key: "trello" | "communication" | "gmail" | "google_drive" | "time";
      label: string;
      count: number;
      status: "linked" | "live" | "missing";
      detail: string;
    }>;
    issues: Array<{
      id: string;
      title: string;
      detail: string;
      resolution: string;
      severity: "high" | "medium" | "low";
    }>;
    forecast: {
      p50Minutes: number | null;
      p90Minutes: number | null;
      sampleSize: number;
      uncertainty: string | null;
    } | null;
    confidenceProfile: {
      targetScore: number | null;
      ceiling: number | null;
      gapToTarget: number | null;
      dimensions: Partial<Record<"evidence" | "forecast" | "humanValidation" | "consistency", number>>;
      blockers: string[];
    } | null;
  };
  waitingReason: {
    waitingOn: string;
    nextAction: string;
    confidenceScore: number;
    followUpAt: Date | string | null;
  } | null;
  steps: Array<{
    id: number;
    stepNumber: number;
    title: string;
    status: string;
    category: string;
    requiresRobert: boolean;
    completionCriteria: string | null;
    riskIfSkipped: string | null;
  }>;
};

const NAVIGATION = [
  { path: "/worker", label: "Today", description: "Now and next", icon: LayoutDashboard },
  { path: "/worker/plan", label: "Plan My Day", description: "Time blocks", icon: CalendarDays },
  { path: "/worker/decisions", label: "Decisions", description: "Required outcomes", icon: BrainCircuit },
  { path: "/worker/evidence", label: "Evidence", description: "Connected facts", icon: FileCheck2 },
] as const;

function priorityTone(tier: string) {
  if (tier === "CRITICAL" || tier === "HIGH") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (tier === "BLOCKED") return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  if (tier === "MEDIUM") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0]}` : parts[0]?.slice(0, 2) || "W").toUpperCase();
}

function evidenceTone(status: "linked" | "live" | "missing") {
  if (status === "linked") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "live") return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function uncertaintyTone(severity: "high" | "medium" | "low") {
  if (severity === "high") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (severity === "medium") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
}

function formatDuration(minutes: number | null) {
  if (minutes === null) return "Unknown";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export default function WorkerOperator({ view = "today" }: { view?: "today" | "plan" | "decisions" | "evidence" | "settings" }) {
  const [, navigate] = useLocation();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const context = trpc.operator.getContext.useQuery(undefined, { staleTime: 5 * 60_000 });
  const apiHealth = trpc.system.health.useQuery(
    { timestamp: 0 },
    { retry: 1, staleTime: 30_000, refetchInterval: 60_000 },
  );
  const workerName = context.data?.displayName || user?.name || "Worker";
  const founderName = context.data?.founderName || "Founder";
  const timeZone = context.data?.timezone || "UTC";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className={`fixed inset-y-0 left-0 z-50 flex border-r bg-background transition-[width,transform] duration-200 ${collapsed ? "w-16" : "w-60"} ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}>
        <div className="flex w-full flex-col">
          <div className="flex h-16 items-center gap-3 border-b px-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-blue-600 font-semibold text-white">{initials(workerName)}</div>
            {!collapsed && <div className="min-w-0"><div className="truncate font-semibold">{workerName}</div><div className="truncate text-xs text-muted-foreground">Worker operator</div></div>}
          </div>
          <nav className="flex-1 space-y-1 p-2">
            {NAVIGATION.map((item) => {
              const active = item.path === "/worker" ? view === "today" : item.path.endsWith(view);
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => { navigate(item.path); setMobileOpen(false); }}
                  title={collapsed ? item.label : undefined}
                  className={`flex h-12 w-full items-center gap-3 rounded-md px-3 text-left transition-colors ${active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
                >
                  <item.icon className={`size-4 shrink-0 ${active ? "text-blue-500" : ""}`} />
                  {!collapsed && <span className="min-w-0"><span className="block text-sm font-medium">{item.label}</span><span className="block truncate text-[11px] text-muted-foreground">{item.description}</span></span>}
                </button>
              );
            })}
          </nav>
          <div className="border-t p-2">
            <button
              type="button"
              onClick={() => navigate("/worker/settings")}
              className={`flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm hover:bg-accent hover:text-foreground ${view === "settings" ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            >
              <Settings className="size-4" />{!collapsed && "Settings"}
            </button>
            <button type="button" onClick={logout} className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <LogOut className="size-4" />{!collapsed && "Sign out"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="hidden h-10 items-center justify-center border-t text-muted-foreground hover:text-foreground md:flex"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
      </aside>
      {mobileOpen && <button type="button" aria-label="Close navigation" className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />}

      <div className={`transition-[padding] duration-200 ${collapsed ? "md:pl-16" : "md:pl-60"}`}>
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur md:px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="size-4" /></Button>
            <div><div className="text-sm font-semibold">Worker Operator</div><div className="text-xs text-muted-foreground">{workerName} · {formatWorkerDate(new Date(), timeZone)}</div></div>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</Button>
        </header>
        <main className="mx-auto w-full max-w-[1280px] p-4 md:p-6">
          {(apiHealth.error || (apiHealth.data && apiHealth.data.runtime !== "unified-node")) && (
            <Alert variant="destructive" className="mb-5">
              <AlertTriangle className="size-4" />
              <AlertTitle>Backend connection unavailable</AlertTitle>
              <AlertDescription>
                This portal must be served by the unified Node application. Requests are not reaching the expected backend; check the container deployment and API domain before using operational actions.
              </AlertDescription>
            </Alert>
          )}
          {view === "today" && <TodayView onOpenPlan={() => navigate("/worker/plan")} onOpenDecisions={() => navigate("/worker/decisions")} />}
          {view === "plan" && <PlanView founderName={founderName} timeZone={timeZone} />}
          {view === "decisions" && <DecisionsView founderName={founderName} />}
          {view === "evidence" && <EvidenceView />}
          {view === "settings" && <WorkerSettingsView />}
        </main>
      </div>
    </div>
  );
}

function TodayView({ onOpenPlan, onOpenDecisions }: { onOpenPlan: () => void; onOpenDecisions: () => void }) {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<OperatorCard | null>(null);
  const actionQuery = trpc.trello.actionAlerts.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const intelligenceQuery = trpc.operator.getWorkQueueContext.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const timerQuery = trpc.timer.getActive.useQuery(undefined, { staleTime: 15_000 });
  const planQuery = trpc.operator.getDailyPlan.useQuery(undefined, { staleTime: 60_000 });
  const browserQuery = trpc.operator.getBrowserTabStatus.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const startTimer = trpc.timer.start.useMutation({
    onSuccess: () => { void utils.timer.getActive.invalidate(); toast.success("Timer started"); },
    onError: (error) => toast.error(error.message),
  });

  const cards = useMemo(() => {
    const alertCards = [
      ...(actionQuery.data?.onHoldCards ?? []),
      ...(actionQuery.data?.doingCards ?? []),
      ...(actionQuery.data?.overdueCards ?? []),
    ];
    const alerts = new Map(alertCards.map((card) => [card.id, card]));
    return [...(intelligenceQuery.data?.cards ?? [])]
      .map((card) => {
        const alert = alerts.get(card.cardId);
        return {
          ...card,
          boardName: card.boardName || alert?.boardName || "Unknown board",
          listName: card.listName || alert?.listName || "Unknown list",
        } as OperatorCard;
      })
      .sort((left, right) => {
        const lane = getWorkLaneRank(left.listName) - getWorkLaneRank(right.listName);
        return lane || right.priorityScore - left.priorityScore;
      });
  }, [actionQuery.data, intelligenceQuery.data]);
  useEffect(() => {
    if (!selected) return;
    const refreshed = cards.find((card) => card.cardId === selected.cardId);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [cards, selected]);
  const now = cards[0] ?? null;
  const next = cards.slice(1, 4);
  const openDecisions = cards.reduce((total, card) => total + card.steps.filter((step) => step.requiresRobert && step.status !== "complete").length, 0);
  const plan = planQuery.data?.schedule;

  const begin = (card: OperatorCard) => startTimer.mutate({
    cardId: card.cardId,
    cardName: card.cardName,
    cardUrl: card.cardUrl,
    boardName: card.boardName,
    listName: card.listName,
  });
  const refreshEvidence = async () => {
    const [intelligenceResult, actionResult] = await Promise.all([
      intelligenceQuery.refetch(),
      actionQuery.refetch(),
    ]);
    if (intelligenceResult.error || actionResult.error) {
      toast.error(intelligenceResult.error?.message ?? actionResult.error?.message ?? "Evidence refresh failed");
      return;
    }
    toast.success("Card evidence refreshed");
  };

  return (
    <div className="space-y-5">
      <PageHeading title="Today" description="Work from one trusted sequence. Context and deeper actions stay out of the execution path." />
      {browserQuery.data?.shouldWarn && (
        <Alert className="border-amber-500/40 bg-amber-500/5">
          <Archive className="size-4 text-amber-500" />
          <AlertTitle>Close excess browser tabs before end of day</AlertTitle>
          <AlertDescription>{browserQuery.data.actionableTabs} actionable tabs are open; the limit is {browserQuery.data.allowedTabs}.</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <Card className="gap-0 rounded-lg border-blue-500/30 py-0">
            <CardHeader className="border-b py-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-emerald-500"><span className="size-2 rounded-full bg-emerald-500" />Now</div>
            </CardHeader>
            <CardContent className="p-5">
              {intelligenceQuery.isLoading ? <QueueSkeleton /> : now ? (
                <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_180px]">
                  <button type="button" className="min-w-0 text-left" onClick={() => setSelected(now)}>
                    <div className="mb-2 flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{now.cardName}</h2><Badge variant="outline" className={priorityTone(now.priorityTier)}>{now.priorityTier}</Badge></div>
                    <p className="text-sm text-muted-foreground">{now.boardName} · {now.listName}</p>
                    <div className="mt-4 border-l-2 border-blue-500 pl-3"><div className="text-[11px] font-semibold uppercase text-muted-foreground">Exactly next</div><p className="mt-1 text-sm font-medium">{now.nextBestAction || "Review the card and define the next concrete action."}</p></div>
                    {now.waitingReason && <p className="mt-3 text-xs text-amber-600 dark:text-amber-300">Waiting evidence: {now.waitingReason.nextAction}</p>}
                  </button>
                  <div className="flex flex-col justify-end gap-2">
                    <Button onClick={() => begin(now)} disabled={startTimer.isPending || timerQuery.data?.cardId === now.cardId}>
                      {startTimer.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                      {timerQuery.data?.cardId === now.cardId ? "Timer running" : "Start timer"}
                    </Button>
                    <Button variant="outline" onClick={() => setSelected(now)}>Open details</Button>
                  </div>
                </div>
              ) : (
                <EmptyState title="No trusted work item yet" detail={intelligenceQuery.error?.message ?? "Generate APTLSS plans or connect Trello to build the queue."} />
              )}
            </CardContent>
          </Card>

          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Next up</CardTitle><CardDescription>Only the next three cards are shown.</CardDescription></CardHeader>
            <CardContent className="p-0">
              {next.length ? next.map((card, index) => (
                <button key={card.cardId} type="button" onClick={() => setSelected(card)} className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent/40">
                  <span className="flex size-6 items-center justify-center rounded border text-xs text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0"><span className="block truncate text-sm font-medium">{card.cardName}</span><span className="block truncate text-xs text-muted-foreground">{card.listName} · {card.nextBestAction ?? "Review next action"}</span></span>
                  <Badge variant="outline" className={priorityTone(card.priorityTier)}>{card.priorityTier}</Badge>
                </button>
              )) : <div className="p-5 text-sm text-muted-foreground">No additional cards queued.</div>}
            </CardContent>
          </Card>

          <QueueLanes cards={cards} onSelect={setSelected} />
        </div>

        <aside className="space-y-3">
          <ContextMetric icon={CalendarDays} label="Plan health" value={plan ? `${plan.planHealth.confidence}%` : "Not generated"} detail={plan ? `${plan.planHealth.scheduledMinutes} min scheduled` : "Create today's time blocks"} onClick={onOpenPlan} />
          <ContextMetric icon={Timer} label="Time now" value={timerQuery.data ? "Tracking" : "Stopped"} detail={timerQuery.data?.cardName ?? "No active timer"} />
          <ContextMetric icon={BrainCircuit} label="Decisions" value={`${openDecisions} open`} detail="Outcome required to close" onClick={onOpenDecisions} />
          <ContextMetric icon={Archive} label="Browser hygiene" value={browserQuery.data?.connected ? `${browserQuery.data.actionableTabs} tabs` : "Disconnected"} detail={browserQuery.data?.connected ? `Limit ${browserQuery.data.allowedTabs}` : "Collector has not reported"} />
        </aside>
      </div>
      <CardInspector
        card={selected}
        onClose={() => setSelected(null)}
        onStart={begin}
        onRefresh={refreshEvidence}
        refreshing={intelligenceQuery.isFetching || actionQuery.isFetching}
      />
    </div>
  );
}

function QueueLanes({ cards, onSelect }: { cards: OperatorCard[]; onSelect: (card: OperatorCard) => void }) {
  const lanes = [
    { key: "on-hold", label: "On-hold first", cards: cards.filter((card) => getWorkLaneRank(card.listName) === 0) },
    { key: "doing", label: "Doing second", cards: cards.filter((card) => getWorkLaneRank(card.listName) === 1) },
    { key: "todo", label: "To-do third", cards: cards.filter((card) => getWorkLaneRank(card.listName) === 2) },
  ];
  return (
    <Card className="gap-0 rounded-lg py-0">
      <CardHeader className="border-b py-4"><CardTitle className="text-sm">Queue lanes</CardTitle><CardDescription>Collapsed by default to keep the sequence readable.</CardDescription></CardHeader>
      <CardContent className="p-0">
        {lanes.map((lane) => <Lane key={lane.key} label={lane.label} cards={lane.cards} onSelect={onSelect} />)}
      </CardContent>
    </Card>
  );
}

function Lane({ label, cards, onSelect }: { label: string; cards: OperatorCard[]; onSelect: (card: OperatorCard) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between border-b px-4 py-3 text-sm hover:bg-accent/40">
        <span className="font-medium">{label}</span><span className="flex items-center gap-2 text-muted-foreground">{cards.length}{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {cards.length ? cards.map((card) => (
          <button key={card.cardId} type="button" onClick={() => onSelect(card)} className="flex w-full items-center justify-between gap-3 border-b bg-muted/20 px-6 py-2.5 text-left text-sm hover:bg-accent/50">
            <span className="truncate">{card.cardName}</span><span className="shrink-0 text-xs text-muted-foreground">{card.priorityScore}</span>
          </button>
        )) : <div className="border-b bg-muted/20 px-6 py-3 text-xs text-muted-foreground">No cards in this lane.</div>}
      </CollapsibleContent>
    </Collapsible>
  );
}

const INSPECTOR_WIDTH_KEY = "worker-operator-inspector-width-v1";
const INSPECTOR_DEFAULT_WIDTH = 640;
const INSPECTOR_MIN_WIDTH = 440;
const INSPECTOR_MAX_WIDTH = 1_040;

function CardInspector({
  card,
  onClose,
  onStart,
  onRefresh,
  refreshing,
}: {
  card: OperatorCard | null;
  onClose: () => void;
  onStart: (card: OperatorCard) => void;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}) {
  const utils = trpc.useUtils();
  const [preferredWidth, setPreferredWidth] = useState(INSPECTOR_DEFAULT_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1_280 : window.innerWidth);
  const [rawEvidenceOpen, setRawEvidenceOpen] = useState(false);
  const [assertion, setAssertion] = useState("");
  const cardEvidence = trpc.operator.getCardEvidence.useQuery(
    { cardId: card?.cardId ?? "", limit: 30 },
    { enabled: Boolean(card), staleTime: 60_000 },
  );
  const verification = trpc.operator.getVerificationFollowups.useQuery(
    card ? { cardId: card.cardId } : undefined,
    { enabled: Boolean(card), staleTime: 30_000 },
  );
  const recordAssertion = trpc.operator.recordEvidenceAssertion.useMutation({
    onSuccess: () => {
      setAssertion("");
      void utils.operator.getCardEvidence.invalidate();
      void utils.operator.getWorkQueueContext.invalidate();
      toast.success("Evidence note recorded for verification");
    },
    onError: (error) => toast.error(error.message),
  });
  const resizeState = useRef<{ startX: number; startWidth: number; nextWidth: number } | null>(null);

  useEffect(() => {
    const storedValue = window.localStorage.getItem(INSPECTOR_WIDTH_KEY);
    const stored = storedValue === null ? Number.NaN : Number(storedValue);
    if (Number.isFinite(stored)) {
      setPreferredWidth(Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, stored)));
    }
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const desktopMax = Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, viewportWidth - 64));
  const panelWidth = viewportWidth < 768
    ? Math.max(0, viewportWidth - 8)
    : Math.max(INSPECTOR_MIN_WIDTH, Math.min(preferredWidth, desktopMax));
  const wide = panelWidth >= 720;
  const evidenceSummary = card?.evidenceSummary ?? {
    sources: [
      { key: "trello" as const, label: "Trello", count: 0, status: "missing" as const, detail: "Refresh to check current evidence" },
      { key: "communication" as const, label: "Messages", count: 0, status: "missing" as const, detail: "Refresh to check current evidence" },
      { key: "gmail" as const, label: "Gmail", count: 0, status: "missing" as const, detail: "Refresh to check current evidence" },
      { key: "google_drive" as const, label: "Drive", count: 0, status: "missing" as const, detail: "Refresh to check current evidence" },
      { key: "time" as const, label: "Time", count: 0, status: "missing" as const, detail: "Refresh to check current evidence" },
    ],
    issues: (card?.uncertainties ?? []).map((detail, index) => ({
      id: `legacy-uncertainty-${index}`,
      title: "Assessment gap",
      detail,
      resolution: "Refresh the evidence check before relying on this assessment.",
      severity: "medium" as const,
    })),
    forecast: null,
    confidenceProfile: null,
  };

  const saveWidth = (value: number) => {
    const width = Math.max(INSPECTOR_MIN_WIDTH, Math.min(desktopMax, value));
    setPreferredWidth(width);
    window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(Math.round(width)));
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (viewportWidth < 768) return;
    event.preventDefault();
    resizeState.current = {
      startX: event.clientX,
      startWidth: panelWidth,
      nextWidth: panelWidth,
    };
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: PointerEvent) => {
      const state = resizeState.current;
      if (!state) return;
      state.nextWidth = Math.max(
        INSPECTOR_MIN_WIDTH,
        Math.min(desktopMax, state.startWidth + state.startX - moveEvent.clientX),
      );
      setPreferredWidth(state.nextWidth);
    };
    const stop = () => {
      const state = resizeState.current;
      resizeState.current = null;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (state) saveWidth(state.nextWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      saveWidth(panelWidth + 40);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      saveWidth(panelWidth - 40);
    } else if (event.key === "Home") {
      event.preventDefault();
      saveWidth(INSPECTOR_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      saveWidth(desktopMax);
    }
  };

  return (
    <Sheet open={Boolean(card)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        className="gap-0 overflow-hidden border-l p-0 shadow-2xl sm:max-w-none"
        style={{ width: panelWidth, maxWidth: "none" }}
      >
        <div
          role="separator"
          aria-label="Resize card details"
          aria-orientation="vertical"
          aria-valuemin={INSPECTOR_MIN_WIDTH}
          aria-valuemax={desktopMax}
          aria-valuenow={Math.round(panelWidth)}
          tabIndex={0}
          title="Drag to resize. Double-click to reset."
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={() => saveWidth(INSPECTOR_DEFAULT_WIDTH)}
          className="group absolute inset-y-0 left-0 z-20 hidden w-4 -translate-x-1/2 cursor-col-resize items-center justify-center outline-none md:flex"
        >
          <span className="flex h-14 w-3 items-center justify-center rounded-sm border bg-background text-muted-foreground shadow-sm transition-colors group-hover:border-blue-500 group-hover:text-blue-500 group-focus-visible:ring-2 group-focus-visible:ring-blue-500">
            <GripVertical className="size-3" />
          </span>
        </div>
        {card && <>
          <div className="border-b bg-background px-5 py-4">
            <SheetHeader className="gap-2 p-0 pr-10">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={priorityTone(card.priorityTier)}>{card.priorityTier}</Badge>
                <Badge variant="outline">{card.primaryState ?? "Unknown state"}</Badge>
              </div>
              <SheetTitle className="text-lg leading-snug">{card.cardName}</SheetTitle>
              <SheetDescription>{card.boardName} / {card.listName}</SheetDescription>
            </SheetHeader>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-6 px-5 py-5">
              <section className="border-l-2 border-blue-500 pl-4">
                <InspectorLabel>Exactly next</InspectorLabel>
                <p className="text-sm font-medium">{card.nextBestAction ?? "No next action recorded."}</p>
              </section>

              <div className={wide ? "grid grid-cols-2 gap-6" : "space-y-6"}>
                <section>
                  <InspectorLabel>Assessment</InspectorLabel>
                  <p className="text-sm leading-relaxed">{card.stateReason ?? card.planSummary ?? "No assessment context available."}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="outline" className={priorityTone(card.priorityTier)}>{card.priorityTier} / {card.priorityScore}</Badge>
                    {card.confidenceScore !== null && <Badge variant="outline">{card.confidenceScore}% confidence</Badge>}
                  </div>
                </section>

                <section>
                  <div className="flex items-center justify-between gap-3">
                    <InspectorLabel>Confidence</InspectorLabel>
                    {evidenceSummary.confidenceProfile?.targetScore && (
                      <span className="text-xs text-muted-foreground">Target {evidenceSummary.confidenceProfile.targetScore}%</span>
                    )}
                  </div>
                  <Progress value={card.confidenceScore ?? 0} className="mt-2 h-2" />
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {card.confidenceReason ?? "No confidence explanation recorded."}
                  </p>
                  {evidenceSummary.confidenceProfile?.blockers.length ? (
                    <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                      {evidenceSummary.confidenceProfile.blockers.slice(0, 3).map((blocker) => <li key={blocker}>- {blocker}</li>)}
                    </ul>
                  ) : null}
                </section>
              </div>

              <section>
                <div className="flex items-center justify-between gap-3">
                  <InspectorLabel>Evidence coverage</InspectorLabel>
                  <Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={refreshing}>
                    <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                </div>
                <div className={`mt-2 grid gap-2 ${wide ? "grid-cols-5" : "grid-cols-2"}`}>
                  {evidenceSummary.sources.map((source) => (
                    <div key={source.key} className="min-w-0 rounded-md border bg-muted/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold">{source.label}</span>
                        <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${evidenceTone(source.status)}`}>
                          {source.status}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{source.detail}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between gap-3">
                  <InspectorLabel>Uncertainty controls</InspectorLabel>
                  <Badge variant="outline">{evidenceSummary.issues.length} open</Badge>
                </div>
                {evidenceSummary.issues.length ? (
                  <div className={`mt-2 grid gap-3 ${wide ? "grid-cols-2" : "grid-cols-1"}`}>
                    {evidenceSummary.issues.map((issue) => (
                      <div key={issue.id} className="rounded-md border p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-2">
                            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                            <h3 className="text-sm font-semibold">{issue.title}</h3>
                          </div>
                          <Badge variant="outline" className={uncertaintyTone(issue.severity)}>{issue.severity}</Badge>
                        </div>
                        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{issue.detail}</p>
                        <div className="mt-3 border-t pt-3">
                          <div className="text-[11px] font-semibold uppercase text-muted-foreground">How to resolve</div>
                          <p className="mt-1 text-sm leading-relaxed">{issue.resolution}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
                    <ShieldCheck className="size-4 text-emerald-500" />
                    No material uncertainty remains in the currently connected evidence.
                  </div>
                )}
              </section>

              <section>
                <div className="flex items-center justify-between gap-3">
                  <InspectorLabel>Verification follow-ups</InspectorLabel>
                  <Badge variant="outline">{verification.data?.length ?? 0} open</Badge>
                </div>
                {verification.data?.length ? <div className="mt-2 space-y-2">{verification.data.map((followup) => <div key={followup.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3"><p className="text-sm font-medium">{followup.title}</p><p className="mt-1 text-sm text-muted-foreground">{followup.question}</p></div>)}</div> : <p className="mt-2 text-sm text-muted-foreground">No conflicting evidence needs a worker response.</p>}
              </section>

              <section>
                <Collapsible open={rawEvidenceOpen} onOpenChange={setRawEvidenceOpen}>
                  <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border p-3 text-left hover:bg-accent/30">
                    <span><span className="block text-sm font-semibold">Raw linked evidence</span><span className="block text-xs text-muted-foreground">Exact retained detail, shown only when needed.</span></span>{rawEvidenceOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3 border-x border-b p-3">
                    {cardEvidence.isLoading ? <QueueSkeleton /> : cardEvidence.data?.length ? cardEvidence.data.map((item) => <div key={item.id} className="rounded-md border p-3"><div className="flex items-start justify-between gap-3"><span className="text-sm font-medium">{item.title}</span><Badge variant="outline">{item.source}</Badge></div>{item.summary && <p className="mt-2 text-sm text-muted-foreground">{item.summary}</p>}{item.content && <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs leading-relaxed">{item.content}</pre>}{item.sourceUrl && <a className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-300" href={item.sourceUrl} target="_blank" rel="noreferrer">Open source <ExternalLink className="size-3" /></a>}</div>) : <p className="text-sm text-muted-foreground">No graph-linked evidence has been retained for this card yet.</p>}
                    <div className="border-t pt-3"><Label htmlFor="evidence-assertion">Add a worker evidence note</Label><Textarea id="evidence-assertion" className="mt-2 min-h-24" value={assertion} onChange={(event) => setAssertion(event.target.value)} placeholder="Record what happened, including the exact source or reason. This does not change Trello." /><Button className="mt-2" size="sm" variant="outline" disabled={assertion.trim().length < 3 || recordAssertion.isPending} onClick={() => card && recordAssertion.mutate({ cardId: card.cardId, title: `Worker update: ${card.cardName}`, detail: assertion })}>{recordAssertion.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileCheck2 className="size-4" />}Record evidence note</Button></div>
                  </CollapsibleContent>
                </Collapsible>
              </section>

              {evidenceSummary.forecast && (
                <section>
                  <InspectorLabel>Remaining-time range</InspectorLabel>
                  <div className="mt-2 grid grid-cols-3 divide-x rounded-md border">
                    <MetricCell label="P50" value={formatDuration(evidenceSummary.forecast.p50Minutes)} />
                    <MetricCell label="P90" value={formatDuration(evidenceSummary.forecast.p90Minutes)} />
                    <MetricCell label="Samples" value={String(evidenceSummary.forecast.sampleSize)} />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Use P90 for commitments while uncertainty is medium or high.</p>
                </section>
              )}

              <section>
                <InspectorLabel>APTLSS steps</InspectorLabel>
                <div className={`mt-2 grid gap-2 ${wide ? "grid-cols-2" : "grid-cols-1"}`}>
                  {card.steps.length ? card.steps.map((step) => (
                    <div key={step.id} className="flex gap-2 rounded-md border p-3 text-sm">
                      <span className="text-muted-foreground">{step.stepNumber}.</span>
                      <span className="min-w-0 flex-1">{step.title}</span>
                      {step.requiresRobert && <Badge variant="outline">Decision</Badge>}
                    </div>
                  )) : <p className="text-sm text-muted-foreground">No structured steps recorded.</p>}
                </div>
              </section>
            </div>
          </div>
          <div className="grid shrink-0 gap-2 border-t bg-background p-4 sm:grid-cols-2">
            <Button onClick={() => onStart(card)}><Play className="size-4" />Start timer</Button>
            <Button variant="outline" asChild><a href={card.cardUrl} target="_blank" rel="noreferrer">Open Trello <ExternalLink className="size-4" /></a></Button>
          </div>
        </>}
      </SheetContent>
    </Sheet>
  );
}

function PlanView({ founderName, timeZone }: { founderName: string; timeZone: string }) {
  const utils = trpc.useUtils();
  const query = trpc.operator.getDailyPlan.useQuery(undefined, { staleTime: 60_000 });
  const mutation = trpc.operator.generateDailyPlan.useMutation({
    onSuccess: () => { void utils.operator.getDailyPlan.invalidate(); toast.success("Day plan generated"); },
    onError: (error) => toast.error(error.message),
  });
  const replan = trpc.operator.replanRemainingDay.useMutation({
    onSuccess: () => {
      void utils.operator.getDailyPlan.invalidate();
      toast.success("Remaining day replanned");
    },
    onError: (error) => toast.error(error.message),
  });
  const updatePlan = trpc.operator.updateDailyPlan.useMutation({
    onSuccess: () => {
      void utils.operator.getDailyPlan.invalidate();
      toast.success("Plan block updated");
    },
    onError: (error) => toast.error(error.message),
  });
  const [elapsed, setElapsed] = useState(0);
  const run = (force: boolean) => {
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
    mutation.mutate({ force }, { onSettled: () => window.clearInterval(timer) });
  };
  const plan = query.data?.schedule;
  const progress = mutation.isPending ? Math.min(92, 15 + elapsed * 8) : 0;
  const stage = elapsed < 2 ? "Loading APTLSS state" : elapsed < 5 ? "Protecting breaks and ranking lanes" : "Validating and saving blocks";
  const updateBlockStatus = (blockId: string, status: "done" | "skipped") => {
    if (!plan) return;
    const at = new Date().toISOString();
    updatePlan.mutate({
      ...plan,
      generatedAt: at,
      blocks: plan.blocks.map((block) => block.id === blockId ? { ...block, status } : block),
      auditTrail: [...plan.auditTrail, { at, action: `block_${status}`, detail: `Worker marked ${blockId} as ${status}.` }],
    });
  };
  return (
    <div className="space-y-5">
      <PageHeading title="Plan My Day" description="One agenda. Detail remains available inside each block instead of separate duplicate views." actions={<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => replan.mutate()} disabled={!plan || replan.isPending || mutation.isPending}>{replan.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Replan remaining</Button><Button onClick={() => run(Boolean(plan))} disabled={mutation.isPending || replan.isPending}>{mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{plan ? "Regenerate plan" : "Generate plan"}</Button></div>} />
      {mutation.isPending && <Card className="gap-3 rounded-lg p-5"><div className="flex justify-between text-sm"><span className="font-medium">{stage}</span><span className="text-muted-foreground">about {Math.max(1, 12 - elapsed)}s left</span></div><Progress value={progress} /><p className="text-xs text-muted-foreground">{progress}% complete · live estimate adjusts as validation runs</p></Card>}
      {query.isLoading ? <QueueSkeleton /> : !plan ? <Alert><Inbox className="size-4" /><AlertTitle>No saved plan</AlertTitle><AlertDescription>Generate from the current APTLSS plans, states, priorities, and configured schedule.</AlertDescription></Alert> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Today’s agenda</CardTitle><CardDescription>{plan.constraints.startTime}–{plan.constraints.endTime} · {timeZone} · configured breaks protected</CardDescription></CardHeader>
            <CardContent className="p-0">
              {plan.blocks.length ? plan.blocks.map((block) => (
                <div key={block.id} className="grid gap-3 border-b p-4 last:border-b-0 sm:grid-cols-[72px_minmax(0,1fr)_auto]">
                  <div className="text-sm font-medium">{block.startTime}<div className="text-xs font-normal text-muted-foreground">{block.endTime}</div></div>
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{block.cardName}</span><Badge variant="outline" className={priorityTone(block.priority)}>{block.priority}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{block.action}</p></div>
                  <div className="flex items-center gap-2"><Badge variant="outline">{block.status}</Badge>{block.status === "planned" && <><Button variant="ghost" size="icon" title="Mark block done" aria-label="Mark block done" disabled={updatePlan.isPending} onClick={() => updateBlockStatus(block.id, "done")}><Check className="size-4" /></Button><Button variant="ghost" size="icon" title="Skip block" aria-label="Skip block" disabled={updatePlan.isPending} onClick={() => updateBlockStatus(block.id, "skipped")}><ChevronRight className="size-4" /></Button></>}</div>
                </div>
              )) : <div className="p-6 text-sm text-muted-foreground">No work blocks are scheduled for this protected day.</div>}
            </CardContent>
          </Card>
          <div className="space-y-3">
            <ContextMetric icon={Gauge} label="Confidence" value={`${plan.planHealth.confidence}%`} detail="Evidence-backed, capped below certainty" />
            <ContextMetric icon={Clock3} label="Scheduled" value={`${Math.round(plan.planHealth.scheduledMinutes / 60 * 10) / 10}h`} detail={`${plan.planHealth.gaps} min remains available`} />
            <ContextMetric icon={BrainCircuit} label={`${founderName} items`} value={`${plan.robertItems.length}`} detail="Visible even when unscheduled" />
            <ContextMetric icon={ListTodo} label="Unscheduled" value={`${plan.unscheduledCards.length}`} detail="Retained for replanning" />
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionsView({ founderName }: { founderName: string }) {
  const utils = trpc.useUtils();
  const queue = trpc.aptlss.getDecisionQueue.useQuery(undefined, { staleTime: 30_000 });
  const history = trpc.operator.getDecisionHistory.useQuery({ limit: 20 }, { staleTime: 30_000 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [outcome, setOutcome] = useState("");
  const selected = queue.data?.items.find((item) => item.stepId === selectedId) ?? queue.data?.items[0] ?? null;
  const mutation = trpc.operator.recordDecisionOutcome.useMutation({
    onSuccess: () => {
      setOutcome("");
      setSelectedId(null);
      void utils.aptlss.getDecisionQueue.invalidate();
      void utils.operator.getDecisionHistory.invalidate();
      toast.success("Outcome recorded");
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="space-y-5">
      <PageHeading title="Decisions" description="Close a decision only by recording what was decided. Nothing is posted or moved in Trello." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Decision inbox</CardTitle><CardDescription>Highest-priority unresolved decision first.</CardDescription></CardHeader>
            <CardContent className="p-0">
              {queue.isLoading ? <div className="p-4"><QueueSkeleton /></div> : queue.data?.items.length ? queue.data.items.map((item, index) => (
                <button key={item.stepId} type="button" onClick={() => setSelectedId(item.stepId)} className={`grid w-full grid-cols-[28px_minmax(0,1fr)_auto] gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent/40 ${selected?.stepId === item.stepId ? "bg-accent/50" : ""}`}>
                  <span className="flex size-6 items-center justify-center rounded border text-xs">{index + 1}</span>
                  <span className="min-w-0"><span className="block truncate text-sm font-medium">{item.cardName}</span><span className="block truncate text-xs text-muted-foreground">{item.stepTitle}</span></span>
                  <Badge variant="outline" className={priorityTone(item.tier)}>{item.tier}</Badge>
                </button>
              )) : <EmptyState title="Decision inbox is clear" detail={`New ${founderName}-required APTLSS steps will appear here.`} />}
            </CardContent>
          </Card>
          <RecentOutcomes rows={history.data ?? []} />
        </div>
        <Card className="h-fit gap-4 rounded-lg p-5 lg:sticky lg:top-20">
          {selected ? <>
            <div><div className="text-xs font-semibold uppercase text-muted-foreground">Selected decision</div><h2 className="mt-1 font-semibold">{selected.cardName}</h2><p className="mt-1 text-sm text-muted-foreground">{selected.stepTitle}</p></div>
            <div className="rounded-md border bg-muted/30 p-3"><div className="text-[11px] font-semibold uppercase text-muted-foreground">Recommendation</div><p className="mt-1 text-sm">{selected.recommendedDecision || "No recommendation recorded; use the linked Trello context."}</p></div>
            <div><label htmlFor="decision-outcome" className="text-sm font-medium">Outcome <span className="text-destructive">*</span></label><Textarea id="decision-outcome" className="mt-2 min-h-28" value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="Record the exact decision and any condition that affects the next step." /></div>
            <Button onClick={() => mutation.mutate({ stepId: selected.stepId, outcome })} disabled={outcome.trim().length < 3 || mutation.isPending}>{mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}Record outcome</Button>
            <Button variant="outline" asChild><a href={selected.cardUrl} target="_blank" rel="noreferrer">Open Trello context <ExternalLink className="size-4" /></a></Button>
          </> : <EmptyState title="Select a decision" detail="The outcome inspector stays separate from the ordered inbox." />}
        </Card>
      </div>
    </div>
  );
}

function RecentOutcomes({ rows }: { rows: Array<{ id: number; cardName: string; outcome: string; resolvedAt: Date; recommendedDecision: string | null }> }) {
  const [open, setOpen] = useState(false);
  return <Card className="gap-0 rounded-lg py-0"><Collapsible open={open} onOpenChange={setOpen}><CollapsibleTrigger className="flex w-full items-center justify-between p-4 text-left"><span><span className="block text-sm font-semibold">Recent outcomes</span><span className="block text-xs text-muted-foreground">Durable resolution history</span></span>{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</CollapsibleTrigger><CollapsibleContent className="border-t">{rows.length ? rows.map((row) => <div key={row.id} className="border-b p-4 last:border-b-0"><div className="flex justify-between gap-3"><span className="text-sm font-medium">{row.cardName}</span><span className="shrink-0 text-xs text-muted-foreground">{new Date(row.resolvedAt).toLocaleDateString()}</span></div><p className="mt-1 text-sm">{row.outcome}</p>{row.recommendedDecision && <p className="mt-1 text-xs text-muted-foreground">Recommended: {row.recommendedDecision}</p>}</div>) : <div className="p-4 text-sm text-muted-foreground">No recorded outcomes yet.</div>}</CollapsibleContent></Collapsible></Card>;
}

function EvidenceView() {
  const status = trpc.operator.getBrowserTabStatus.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const history = trpc.operator.getBrowserTabEvidenceHistory.useQuery({ limit: 30 }, { retry: false, staleTime: 60_000 });
  const waiting = trpc.operator.getWaitingReasons.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const intelligence = trpc.operator.getWorkQueueContext.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const compliance = trpc.compliance.getHistory.useQuery({ limit: 7 }, { retry: false, staleTime: 60_000 });
  const email = trpc.emailInbox.getPendingCount.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const latest = compliance.data?.[0] ?? null;
  return (
    <div className="space-y-5">
      <PageHeading title="Evidence" description="Connected facts are visible here; execution actions remain in Today and Decisions." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ContextMetric icon={ShieldCheck} label="APTLSS cards" value={`${intelligence.data?.cards.length ?? 0}`} detail="Plans joined to states and scores" />
        <ContextMetric icon={Clock3} label="Waiting reasons" value={`${waiting.data?.length ?? 0}`} detail="Free-flow reasons interpreted" />
        <ContextMetric icon={Archive} label="Browser collector" value={status.data?.connected ? "Connected" : "Disconnected"} detail={status.data?.capturedAt ? `Last seen ${new Date(status.data.capturedAt).toLocaleTimeString()}` : "No inventory received"} />
        <ContextMetric icon={History} label="Daily compliance" value={latest ? `${latest.compliancePct}%` : "No snapshot"} detail={latest ? `${latest.evidenceCount} source facts checked` : "Record a verified snapshot"} />
      </div>
      <Card className="gap-0 rounded-lg py-0">
        <CardHeader className="border-b py-4"><CardTitle className="text-sm">Evidence boundaries</CardTitle><CardDescription>What the consolidated layer knows and what it still needs.</CardDescription></CardHeader>
        <CardContent className="divide-y p-0">
          <EvidenceRow label="Trello and APTLSS" status={intelligence.error ? "Needs attention" : "Connected"} detail={intelligence.error?.message ?? "Plans, card state, priority and open steps are joined by card ID."} />
          <EvidenceRow label="Waiting reasons" status="Operational" detail="Free-text is classified into actor, missing item, follow-up and next action with confidence and missing-information flags." />
          <EvidenceRow label="Browser tabs" status={status.data?.connected ? "Connected" : "Setup required"} detail={status.data?.connected ? `${status.data.actionableTabs} actionable tabs are currently visible.` : "Install and authorize the local collector before tab compliance can be trusted."} />
          <EvidenceRow label="Communication" status={latest?.verificationStatus ?? "No snapshot"} detail={latest ? `${latest.messageReplied}/${latest.messageTotal} messages answered; ${latest.messageNeedsClarification} need clarification.` : "No verified communication snapshot is available yet."} />
          <EvidenceRow label="Gmail processing" status={email.error ? "Needs attention" : `${email.data?.count ?? 0} pending`} detail={latest ? `${latest.emailCompleted}/${latest.emailTotal} retained emails were processed or archived for the latest snapshot.` : "Inbox tasks are retained without changing Gmail automatically."} />
          <EvidenceRow label="Time accountability" status={latest ? `${Math.round(latest.trackedSeconds / 360) / 10}h tracked` : "No snapshot"} detail={latest ? `${Math.round(latest.overtimeSeconds / 360) / 10}h overtime against the configured worker schedule.` : "Completed timer entries are included in the next snapshot."} />
          <EvidenceRow label="Browser history" status={`${history.data?.length ?? 0} days`} detail="End-of-day browser snapshots are retained separately from task and communication evidence." />
        </CardContent>
      </Card>
    </div>
  );
}

function WorkerSettingsView() {
  const utils = trpc.useUtils();
  const context = trpc.operator.getContext.useQuery(undefined, { staleTime: 5 * 60_000 });
  const policy = trpc.operator.getBrowserTabPolicy.useQuery(undefined, { staleTime: 60_000 });
  const browser = trpc.operator.getBrowserTabStatus.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const email = trpc.emailInbox.getPendingCount.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const apiHealth = trpc.system.health.useQuery(
    { timestamp: 0 },
    { retry: 1, staleTime: 30_000, refetchInterval: 60_000 },
  );
  const [enabled, setEnabled] = useState(true);
  const [maxOpenTabs, setMaxOpenTabs] = useState(5);
  const [warningMinutes, setWarningMinutes] = useState(30);
  const [staleMinutes, setStaleMinutes] = useState(10);
  const [includePinnedTabs, setIncludePinnedTabs] = useState(false);

  useEffect(() => {
    if (!policy.data) return;
    setEnabled(policy.data.enabled);
    setMaxOpenTabs(policy.data.maxOpenTabs);
    setWarningMinutes(policy.data.warningMinutesBeforeEnd);
    setStaleMinutes(policy.data.staleAfterMinutes);
    setIncludePinnedTabs(policy.data.includePinnedTabs);
  }, [policy.data]);

  const savePolicy = trpc.operator.setBrowserTabPolicy.useMutation({
    onSuccess: () => {
      void utils.operator.getBrowserTabPolicy.invalidate();
      void utils.operator.getBrowserTabStatus.invalidate();
      toast.success("Browser policy saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const collectorToken = trpc.operator.getBrowserCollectorToken.useMutation({
    onSuccess: async ({ token }) => {
      try {
        await navigator.clipboard.writeText(token);
        toast.success("Collector token copied");
      } catch {
        toast.error("Clipboard access was blocked");
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const worker = context.data;
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="space-y-5">
      <PageHeading title="Settings" description="Personal operating controls for this worker profile. Founder and system administration remain separate." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="gap-0 rounded-lg py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Browser organization</CardTitle>
            <CardDescription>Warn near the end of the working day when the connected browser exceeds the agreed limit.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-5">
            <div className="flex items-center justify-between gap-4">
              <div><Label htmlFor="browser-policy-enabled">End-of-day checks</Label><p className="mt-1 text-xs text-muted-foreground">Keep tab hygiene evidence active for this profile.</p></div>
              <Switch id="browser-policy-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberSetting id="max-open-tabs" label="Allowed tabs" value={maxOpenTabs} min={0} max={50} onChange={setMaxOpenTabs} />
              <NumberSetting id="warning-minutes" label="Warn before end" value={warningMinutes} min={0} max={240} suffix="min" onChange={setWarningMinutes} />
              <NumberSetting id="stale-minutes" label="Collector stale after" value={staleMinutes} min={2} max={120} suffix="min" onChange={setStaleMinutes} />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div><Label htmlFor="include-pinned">Count pinned tabs</Label><p className="mt-1 text-xs text-muted-foreground">Pinned reference tabs are excluded by default.</p></div>
              <Switch id="include-pinned" checked={includePinnedTabs} onCheckedChange={setIncludePinnedTabs} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => collectorToken.mutate()} disabled={collectorToken.isPending}>
                {collectorToken.isPending ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}Copy collector token
              </Button>
              <Button
                onClick={() => savePolicy.mutate({
                  enabled,
                  maxOpenTabs,
                  warningMinutesBeforeEnd: warningMinutes,
                  staleAfterMinutes: staleMinutes,
                  includePinnedTabs,
                })}
                disabled={savePolicy.isPending}
              >
                {savePolicy.isPending && <Loader2 className="size-4 animate-spin" />}Save policy
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Working schedule</CardTitle></CardHeader>
            <CardContent className="space-y-3 p-4 text-sm">
              <SettingSummary label="Timezone" value={worker?.timezone ?? "Loading"} />
              <SettingSummary label="Working window" value={worker ? `${worker.workStartTime}-${worker.workEndTime}` : "Loading"} />
              <SettingSummary label="Working days" value={worker?.workingDays.map((day) => dayLabels[day]).join(", ") || "Loading"} />
              <SettingSummary label="Protected breaks" value={worker ? `${worker.breaks.length}` : "Loading"} />
            </CardContent>
          </Card>
          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Evidence connections</CardTitle></CardHeader>
            <CardContent className="divide-y p-0">
              <ConnectionRow
                label="Backend API"
                value={apiHealth.data?.runtime === "unified-node" ? "Connected" : apiHealth.isLoading ? "Checking" : "Unavailable"}
                healthy={apiHealth.data?.runtime === "unified-node"}
              />
              <ConnectionRow label="Trello identity" value={worker?.trelloMemberId ? "Configured" : "Uses token owner"} healthy={Boolean(worker?.trelloMemberId)} />
              <ConnectionRow label="Gmail queue" value={`${email.data?.count ?? 0} pending`} healthy={!email.error} />
              <ConnectionRow label="Browser collector" value={browser.data?.connected ? "Connected" : browser.data?.collectorConfigured ? "Waiting for data" : "Setup required"} healthy={Boolean(browser.data?.connected)} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function NumberSetting({ id, label, value, min, max, suffix, onChange }: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><div className="relative"><Input id={id} type="number" min={min} max={max} value={value} onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || min)))} className={suffix ? "pr-12" : ""} />{suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{suffix}</span>}</div></div>;
}

function SettingSummary({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>;
}

function ConnectionRow({ label, value, healthy }: { label: string; value: string; healthy: boolean }) {
  return <div className="flex items-center justify-between gap-4 p-4"><span className="flex items-center gap-2 text-sm"><Monitor className="size-4 text-muted-foreground" />{label}</span><Badge variant="outline" className={healthy ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-300" : "border-amber-500/30 text-amber-600 dark:text-amber-300"}>{value}</Badge></div>;
}

function EvidenceRow({ label, status, detail }: { label: string; status: string; detail: string }) {
  return <div className="grid gap-2 p-4 sm:grid-cols-[180px_130px_minmax(0,1fr)] sm:items-center"><span className="text-sm font-medium">{label}</span><Badge variant="outline">{status}</Badge><span className="text-sm text-muted-foreground">{detail}</span></div>;
}

function PageHeading({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <div className="flex flex-col justify-between gap-3 border-b pb-4 sm:flex-row sm:items-end"><div><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>{actions}</div>;
}

function ContextMetric({ icon: Icon, label, value, detail, onClick }: { icon: typeof Activity; label: string; value: string; detail: string; onClick?: () => void }) {
  const content = <><div className="flex items-center justify-between text-xs font-semibold uppercase text-muted-foreground"><span>{label}</span><Icon className="size-4" /></div><div className="mt-2 text-lg font-semibold">{value}</div><div className="mt-1 text-xs text-muted-foreground">{detail}</div></>;
  return onClick ? <button type="button" onClick={onClick} className="w-full rounded-lg border bg-card p-4 text-left hover:border-blue-500/40 hover:bg-accent/20">{content}</button> : <div className="rounded-lg border bg-card p-4">{content}</div>;
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 p-3 text-center"><div className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</div><div className="mt-1 truncate text-sm font-semibold">{value}</div></div>;
}

function InspectorLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">{children}</div>;
}

function QueueSkeleton() {
  return <div className="space-y-3"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-16 w-full" /></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="p-6 text-center"><Inbox className="mx-auto size-5 text-muted-foreground" /><div className="mt-2 text-sm font-medium">{title}</div><div className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{detail}</div></div>;
}
