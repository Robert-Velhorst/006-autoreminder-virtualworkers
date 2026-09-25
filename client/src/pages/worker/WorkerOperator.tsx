import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  Archive,
  BrainCircuit,
  BellRing,
  CalendarDays,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getWorkLaneRank } from "@shared/workLanePriority";
import { orderWorkerCards, selectManagerPrimary, selectTodayQueue, workerCardIsWaiting } from "@shared/workerTodayGuidance";
import { managerStatusQueryOptions } from "@/lib/managerPilotAvailability";
import { dateKeyInTimeZone, formatWorkerDate } from "@shared/workerTime";
import { assessWorkerSourceChecks } from "@shared/workerSourceChecks";
import { describeWorkerIntegrationSync } from "@shared/workerIntegrationStatus";
import { toast } from "sonner";
import WorkerReminders from "./WorkerReminders";
import ManagerCoach from "@/components/ManagerCoach";
import ManagerShadowSettings from "@/components/ManagerShadowSettings";
import ManagerVerificationFollowups from "@/components/ManagerVerificationFollowups";
import WorkerPlanSuggestion, { workerPlanSuggestionIsCurrent } from "@/components/WorkerPlanSuggestion";

type OperatorCard = {
  cardId: string;
  cardName: string;
  cardUrl: string;
  trelloCache?: { cachedAt: string; expiresAt: string } | null;
  boardName: string;
  listName: string;
  dueAt?: string | null;
  overdue?: boolean;
  nextBestAction: string | null;
  primaryState: string | null;
  actionability: string | null;
  priorityScore: number;
  priorityTier: string;
  evidenceSummary: {
    sources: Array<{
      key: "trello" | "communication" | "gmail" | "google_drive" | "time";
      label: string;
      count: number;
      status: "linked" | "live" | "missing";
      detail: string;
    }>;
    forecast: {
      p50Minutes: number | null;
      p90Minutes: number | null;
    } | null;
  };
  waitingReason: {
    waitingOn: string;
    nextAction: string;
    followUpAt: Date | string | null;
  } | null;
  steps: Array<{
    id: number;
    stepNumber: number;
    title: string;
    status: string;
    category: string;
    requiresRobert: boolean;
    decisionDueAt: string | null;
    decisionDeferred: boolean;
    completionCriteria: string | null;
    riskIfSkipped: string | null;
  }>;
};

function nextInstruction(card: OperatorCard) {
  const step = card.steps.find(item => item.status !== "complete");
  if (/require.*approval|execute the highest.priority open step/i.test(card.nextBestAction ?? "")) {
    return step ? `${step.requiresRobert ? "Decision needed: " : "Next step: "}${step.title}` : "The next action is not specified. Open the task and record the missing question before starting.";
  }
  return card.nextBestAction || "Open the task and identify the next action before starting.";
}

function currentCompletionCriterion(card: OperatorCard) {
  return card.steps.find(item => item.status !== "complete")?.completionCriteria?.trim() || null;
}

const NAVIGATION = [
  { path: "/worker", label: "Today", description: "Now and next", icon: LayoutDashboard },
  { path: "/worker/plan", label: "Plan My Day", description: "Time blocks", icon: CalendarDays },
  { path: "/worker/decisions", label: "Decisions", description: "Required outcomes", icon: BrainCircuit },
  { path: "/worker/evidence", label: "Evidence", description: "Connected facts", icon: FileCheck2 },
  { path: "/worker/reminders", label: "Reminders", description: "Commitments and follow-up", icon: BellRing },
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

type BrowserConnectionSnapshot = {
  connected?: boolean;
  collectorConfigured?: boolean;
  status?: string | null;
  capturedAt?: Date | string | null;
  actionableTabs?: number;
};

function describeBrowserConnection(status?: BrowserConnectionSnapshot) {
  if (status?.connected) {
    return {
      label: "Connected",
      detail: `${status.actionableTabs ?? 0} actionable tabs are currently visible.`,
      healthy: true,
    };
  }

  if (status?.status === "stale") {
    const lastInventory = status.capturedAt
      ? `The last inventory was ${new Date(status.capturedAt).toLocaleString()}.`
      : "The last inventory is outside the configured freshness window.";
    return {
      label: "Stale",
      detail: `${lastInventory} Reopen the browser collector to refresh tab compliance.`,
      healthy: false,
    };
  }

  if (status?.collectorConfigured) {
    return {
      label: "Waiting for data",
      detail: "The collector token is configured, but no browser inventory has been received yet.",
      healthy: false,
    };
  }

  return {
    label: "Setup required",
    detail: "Install and authorize the local collector before tab compliance can be trusted.",
    healthy: false,
  };
}

function formatDuration(minutes: number | null) {
  if (minutes === null) return "Unknown";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export default function WorkerOperator({ view = "today" }: { view?: "today" | "plan" | "decisions" | "evidence" | "reminders" | "settings" }) {
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
        <main className={`mx-auto w-full min-w-0 p-4 md:p-6 ${view === "today" ? "" : "max-w-[1280px]"}`}>
          {(apiHealth.error || (apiHealth.data && apiHealth.data.runtime !== "unified-node")) && (
            <Alert variant="destructive" className="mb-5">
              <AlertTriangle className="size-4" />
              <AlertTitle>Backend connection unavailable</AlertTitle>
              <AlertDescription>
                This portal must be served by the unified Node application. Requests are not reaching the expected backend; check the container deployment and API domain before using operational actions.
              </AlertDescription>
            </Alert>
          )}
          {view === "today" && <TodayView timeZone={timeZone} onOpenPlan={() => navigate("/worker/plan")} onOpenDecisions={() => navigate("/worker/decisions")} />}
          {view === "plan" && <PlanView founderName={founderName} timeZone={timeZone} />}
          {view === "decisions" && <DecisionsView founderName={founderName} />}
          {view === "evidence" && <EvidenceView />}
          {view === "reminders" && <WorkerReminders />}
          {view === "settings" && <WorkerSettingsView />}
        </main>
      </div>
    </div>
  );
}

function TodayView({ timeZone, onOpenPlan, onOpenDecisions }: { timeZone: string; onOpenPlan: () => void; onOpenDecisions: () => void }) {
  const utils = trpc.useUtils();
  const [orderingTime, setOrderingTime] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setOrderingTime(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [selected, setSelected] = useState<OperatorCard | null>(null);
  const managerQuery = trpc.operator.getManagerStatus.useQuery(undefined, managerStatusQueryOptions);
  const actionQuery = trpc.trello.actionAlerts.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const intelligenceQuery = trpc.operator.getWorkQueueContext.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const googleQuery = trpc.operator.getGoogleEvidenceStatus.useQuery(undefined, { retry: false, staleTime: 60_000 });
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
    return orderWorkerCards([...(intelligenceQuery.data?.cards ?? [])]
      .map((card) => {
        const alert = alerts.get(card.cardId);
        return {
          ...card,
          boardName: card.boardName || alert?.boardName || "Unknown board",
          listName: card.listName || alert?.listName || "Unknown list",
        } as OperatorCard;
      }), orderingTime);
  }, [actionQuery.data, intelligenceQuery.data, orderingTime]);
  useEffect(() => {
    if (!selected) return;
    const refreshed = cards.find((card) => card.cardId === selected.cardId);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [cards, selected]);
  const primary = selectManagerPrimary(managerQuery.data?.snapshot);
  const { related, first: now, next } = selectTodayQueue(cards, primary?.cardId ?? null);
  const openDecisions = cards.reduce((total, card) => total + card.steps.filter((step) => step.requiresRobert && step.status !== "complete").length, 0);
  const plan = planQuery.data?.schedule;
  const planImpact = managerQuery.data?.snapshot?.proposal?.planningImpact;
  const hasCurrentSuggestion = !planQuery.isLoading && !planQuery.error && !managerQuery.error && !managerQuery.data?.error && workerPlanSuggestionIsCurrent({
    impact: planImpact,
    expectedPlanVersion: managerQuery.data?.snapshot?.planVersion,
    currentPlanVersion: planQuery.data?.planVersion,
    currentDateKey: dateKeyInTimeZone(orderingTime, timeZone),
    hasSavedPlan: !!plan,
    applied: managerQuery.data?.snapshot?.applied,
  });
  const isWaiting = workerCardIsWaiting;
  const canStart = (card: OperatorCard) => !(primary?.kind === "verification" && primary.cardId === card.cardId) && !isWaiting(card) && !timerQuery.isLoading && !timerQuery.error && !startTimer.isPending && timerQuery.data?.cardId !== card.cardId;
  const sourceChecksFor = (card: OperatorCard) => assessWorkerSourceChecks({
    sources: card.evidenceSummary.sources,
    trelloCache: card.trelloCache ?? null,
    gmail: googleQuery.data?.gmail ?? null,
    drive: googleQuery.data?.drive ?? null,
    googleConnectionReady: googleQuery.data?.credentialsReady ?? null,
    now: orderingTime,
  });
  const nowSources = now ? sourceChecksFor(now) : null;

  const begin = (card: OperatorCard) => { if (!canStart(card)) return; startTimer.mutate({
    cardId: card.cardId,
    cardName: card.cardName,
    cardUrl: card.cardUrl,
    boardName: card.boardName,
    listName: card.listName,
  }); };
  const refreshEvidence = async () => {
    const [intelligenceResult, actionResult, googleResult] = await Promise.all([
      intelligenceQuery.refetch(),
      actionQuery.refetch(),
      googleQuery.refetch(),
    ]);
    if (intelligenceResult.error || actionResult.error || googleResult.error) {
      toast.error(intelligenceResult.error?.message ?? actionResult.error?.message ?? googleResult.error?.message ?? "Source status reload failed");
      return;
    }
    toast.success("Saved source status reloaded. This does not sync external accounts.");
  };

  return (
    <div className="space-y-5">
      <PageHeading title="Today" description="" />
      <ManagerCoach />
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
              <div className="text-xs font-semibold uppercase text-muted-foreground">{primary ? "Other work you can continue" : now && isWaiting(now) ? "Waiting for a prerequisite" : "Next task"}</div>
            </CardHeader>
            <CardContent className="p-5">
              {intelligenceQuery.isLoading ? <QueueSkeleton /> : now ? (
                <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_180px]">
                  <button type="button" className="min-w-0 text-left" onClick={() => setSelected(now)}>
                    <div className="mb-2 flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{now.cardName}</h2><Badge variant="outline" className={priorityTone(now.priorityTier)}>{now.priorityTier}</Badge></div>
                    <p className="text-sm text-muted-foreground">{now.boardName} · {now.listName}</p>
                    <div className="mt-4 border-l-2 border-blue-500 pl-3"><div className="text-[11px] font-semibold uppercase text-muted-foreground">{isWaiting(now) ? "Prerequisite to check" : "Next action"}</div><p className="mt-1 text-sm font-medium">{nextInstruction(now)}</p></div>
                    {now.waitingReason && <p className="mt-3 text-xs text-amber-600 dark:text-amber-300">Waiting evidence: {now.waitingReason.nextAction}</p>}
                    {(currentCompletionCriterion(now) || now.evidenceSummary.forecast?.p50Minutes !== null && now.evidenceSummary.forecast?.p50Minutes !== undefined) && <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t pt-3 text-xs text-muted-foreground">
                      {currentCompletionCriterion(now) && <span><span className="font-semibold text-foreground">Done when:</span> {currentCompletionCriterion(now)}</span>}
                      {now.evidenceSummary.forecast?.p50Minutes !== null && now.evidenceSummary.forecast?.p50Minutes !== undefined && <span><span className="font-semibold text-foreground">Working estimate:</span> {formatDuration(now.evidenceSummary.forecast.p50Minutes)}{now.evidenceSummary.forecast.p90Minutes !== null ? ` to ${formatDuration(now.evidenceSummary.forecast.p90Minutes)}` : ""}</span>}
                    </div>}
                    {nowSources?.checks.some(check => check.status !== "current") && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">Source check needed. Open details to see what to verify before acting.</p>}
                  </button>
                  <div className="flex flex-col justify-end gap-2">
                    <Button onClick={() => begin(now)} disabled={!canStart(now)}>
                      {startTimer.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                      {timerQuery.data?.cardId === now.cardId ? "Timer running" : isWaiting(now) ? "Waiting - review first" : "Start timer"}
                    </Button>
                    <Button variant="outline" onClick={() => setSelected(now)}>Open details</Button>
                    {/^https?:\/\//i.test(now.cardUrl) && <a href={now.cardUrl} target="_blank" rel="noopener noreferrer" className="text-center text-xs font-medium text-primary underline">Open source card</a>}
                  </div>
                </div>
              ) : primary ? (
                <div className="space-y-3 text-sm"><p>No other task is ready to execute. Follow the work guidance above or review the waiting tasks below.</p>{related && <Button variant="outline" onClick={() => setSelected(related)}>Open related task</Button>}</div>
              ) : (
                <EmptyState title="No trusted work item yet" detail={intelligenceQuery.error?.message ?? "Generate APTLSS plans or connect Trello to build the queue."} />
              )}
            </CardContent>
          </Card>

          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Next up</CardTitle></CardHeader>
            <CardContent className="p-0">
              {intelligenceQuery.isLoading ? <QueueSkeleton /> : intelligenceQuery.error ? <p role="alert" className="p-4">Tasks could not be loaded. Refresh to try again.</p> : next.length ? next.map((card, index) => (
                <button key={card.cardId} type="button" onClick={() => setSelected(card)} className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-accent/40">
                  <span className="flex size-6 items-center justify-center rounded border text-xs text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0"><span className="block truncate text-sm font-medium">{card.cardName}</span><span className="block truncate text-xs text-muted-foreground">{card.listName} · {card.nextBestAction ?? "Review next action"}</span></span>
                  <Badge variant="outline" className={priorityTone(card.priorityTier)}>{card.priorityTier}</Badge>
                </button>
              )) : <div className="p-5 text-sm text-muted-foreground">No additional cards queued.</div>}
            </CardContent>
          </Card>

          {!intelligenceQuery.isLoading && !intelligenceQuery.error && <QueueLanes cards={cards} onSelect={setSelected} />}
        </div>

        <aside className="space-y-3">
          {planQuery.isLoading || timerQuery.isLoading || intelligenceQuery.isLoading || browserQuery.isLoading ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading your work summary...</p> : planQuery.error || timerQuery.error || intelligenceQuery.error || browserQuery.error ? <p role="alert" className="p-4 text-sm">Some work information is unavailable. Refresh before relying on these totals.</p> : <>
          <ContextMetric icon={CalendarDays} label="Day plan" value={plan ? (plan.planHealth.availableMinutes === 0 && !plan.blocks.length ? "Protected day" : "Available") : "Not generated"} detail={hasCurrentSuggestion ? planImpact?.planChanges?.length ? `${planImpact.planChanges.length} suggested changes to review` : "Plan suggestion to review" : plan ? `${plan.planHealth.scheduledMinutes} min scheduled` : "Create today's time blocks"} onClick={onOpenPlan} />
          <ContextMetric icon={Timer} label="Time now" value={timerQuery.data ? "Tracking" : "Stopped"} detail={timerQuery.data?.cardName ?? "No active timer"} />
          <ContextMetric icon={BrainCircuit} label="Decisions" value={`${openDecisions} open`} detail="Outcome required to close" onClick={onOpenDecisions} />
          <ContextMetric icon={Archive} label="Browser hygiene" value={browserQuery.data?.connected ? `${browserQuery.data.actionableTabs} tabs` : "Disconnected"} detail={browserQuery.data?.connected ? `Limit ${browserQuery.data.allowedTabs}` : "Collector has not reported"} />
          </>}
        </aside>
      </div>
      <CardInspector
        card={selected}
        sourceChecks={selected ? sourceChecksFor(selected) : null}
        timeZone={timeZone}
        onClose={() => setSelected(null)}
        onStart={begin}
        canStart={canStart}
        onRefresh={refreshEvidence}
        refreshing={intelligenceQuery.isFetching || actionQuery.isFetching || googleQuery.isFetching}
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
      <CardHeader className="border-b py-4"><CardTitle className="text-sm">All tasks</CardTitle></CardHeader>
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
            <span className="truncate">{card.cardName}</span>
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
  sourceChecks,
  timeZone,
  onClose,
  onStart,
  canStart,
  onRefresh,
  refreshing,
}: {
  card: OperatorCard | null;
  sourceChecks: ReturnType<typeof assessWorkerSourceChecks> | null;
  timeZone: string;
  onClose: () => void;
  onStart: (card: OperatorCard) => void;
  canStart: (card: OperatorCard) => boolean;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}) {
  const [preferredWidth, setPreferredWidth] = useState(INSPECTOR_DEFAULT_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1_280 : window.innerWidth);
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
    forecast: null,
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
                <p className="text-sm font-medium">{nextInstruction(card)}</p>
              </section>

              <section>
                <div className="flex items-center justify-between gap-3">
                  <InspectorLabel>Source checks</InspectorLabel>
                  <Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={refreshing}>
                    <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
                    Reload status
                  </Button>
                </div>
                <div className="mt-2 divide-y border-y">
                  {sourceChecks?.checks.map((check) => (
                    <div key={check.key} className="py-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{check.label}{check.key !== "trello" && <span className="ml-1 font-normal text-muted-foreground">({check.linkedCount} linked)</span>}</span>
                        <span className={check.status === "current" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                          {check.status === "current" ? "Checked" : check.status === "overdue" ? "Check overdue" : check.status === "disabled" ? "Sync off" : check.status === "disconnected" ? "Connection unavailable" : "Check time unknown"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{check.checkedLabel}: {check.checkedAt ? new Date(check.checkedAt).toLocaleString(undefined, { timeZone }) : "not recorded"}</p>
                      {check.nextAction && <p className="mt-1 text-xs">Next: {check.nextAction}</p>}
                    </div>
                  ))}
                </div>
                {sourceChecks?.coverageGap && <p className="mt-2 text-xs text-muted-foreground">{sourceChecks.coverageGap}</p>}
                <p className="mt-2 text-xs text-muted-foreground">Reloading status does not sync external accounts.</p>
              </section>

              <ManagerVerificationFollowups key={card.cardId} cardId={card.cardId} />

              <section>
                <InspectorLabel>Task steps</InspectorLabel>
                <div className={`mt-2 grid gap-2 ${wide ? "grid-cols-2" : "grid-cols-1"}`}>
                  {card.steps.length ? card.steps.map((step) => (
                    <div key={step.id} className="flex gap-2 rounded-md border p-3 text-sm">
                      <span className="text-muted-foreground">{step.stepNumber}.</span>
                      <span className="min-w-0 flex-1">
                        {step.title}
                        {step.requiresRobert && <span className="mt-1 block text-xs text-muted-foreground">Waiting for founder decision{step.decisionDeferred && step.decisionDueAt ? ` · review ${new Date(step.decisionDueAt).toLocaleString()}` : ""}</span>}
                      </span>
                      {step.requiresRobert && <Badge variant="outline">{step.decisionDeferred ? "Deferred" : "Decision"}</Badge>}
                    </div>
                  )) : <p className="text-sm text-muted-foreground">No structured steps recorded.</p>}
                </div>
              </section>
            </div>
          </div>
          <div className="grid shrink-0 gap-2 border-t bg-background p-4 sm:grid-cols-2">
            <Button disabled={!canStart(card)} onClick={() => onStart(card)}><Play className="size-4" />Start timer</Button>
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
  const manager = trpc.operator.getManagerStatus.useQuery(undefined, managerStatusQueryOptions);
  const mutation = trpc.operator.generateDailyPlan.useMutation({
    onSuccess: () => { void utils.operator.getDailyPlan.invalidate(); toast.success("Day plan generated"); },
    onError: (error) => toast.error(error.message),
  });
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!mutation.isPending) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [mutation.isPending]);
  const run = (force: boolean) => {
    setElapsed(0);
    mutation.mutate({ force });
  };
  const plan = query.data?.schedule;
  return (
    <div className="space-y-5">
      <PageHeading title="Plan My Day" description="" actions={<Button onClick={() => run(Boolean(plan))} disabled={mutation.isPending}>{mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{plan ? "Regenerate plan" : "Generate plan"}</Button>} />
      {mutation.isPending && <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-3 border-b p-4"><Loader2 className="size-4 animate-spin" /><span>Generating plan</span><span className="text-sm text-muted-foreground">{elapsed}s elapsed · completion estimate unavailable</span></div>}
      {query.error && <Alert variant="destructive"><AlertTitle>Plan could not be loaded</AlertTitle><AlertDescription>{query.error.message}<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></AlertDescription></Alert>}
      {mutation.error && <Alert variant="destructive"><AlertTitle>Plan generation could not be confirmed</AlertTitle><AlertDescription>{mutation.error.message} Reload the saved plan before retrying to check whether generation completed.</AlertDescription></Alert>}
      {!query.isLoading && !query.error && !manager.isLoading && !manager.error && !manager.data?.error && <WorkerPlanSuggestion
        impact={manager.data?.snapshot?.proposal?.planningImpact}
        expectedPlanVersion={manager.data?.snapshot?.planVersion}
        currentPlanVersion={query.data?.planVersion}
        currentDateKey={dateKeyInTimeZone(Date.now(), timeZone)}
        hasSavedPlan={!!plan}
        applied={manager.data?.snapshot?.applied}
      />}
      {query.isLoading ? <QueueSkeleton /> : !plan && !query.error ? <Alert><Inbox className="size-4" /><AlertTitle>No saved plan</AlertTitle><AlertDescription>Create a plan using your tasks and working hours.</AlertDescription></Alert> : plan ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Today’s agenda</CardTitle><CardDescription>{plan.constraints.startTime}–{plan.constraints.endTime} · {timeZone} · configured breaks protected</CardDescription></CardHeader>
            <CardContent className="p-0">
              {plan.blocks.length ? plan.blocks.map((block) => (
                <div key={block.id} className="grid gap-3 border-b p-4 last:border-b-0 sm:grid-cols-[72px_minmax(0,1fr)_auto]">
                  <div className="text-sm font-medium">{block.startTime}<div className="text-xs font-normal text-muted-foreground">{block.endTime}</div></div>
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{block.cardName}</span><Badge variant="outline" className={priorityTone(block.priority)}>{block.priority}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{block.action}</p></div>
                  <Badge variant="outline">{block.status}</Badge>
                </div>
              )) : <div className="p-6 text-sm text-muted-foreground">No work blocks are scheduled for this protected day.</div>}
            </CardContent>
          </Card>
          <div className="space-y-3">
            <ContextMetric icon={Gauge} label="Before you start" value={plan.planHealth.availableMinutes === 0 && !plan.blocks.length ? "Day off" : "Check sources"} detail={plan.planHealth.availableMinutes === 0 && !plan.blocks.length ? "No working time scheduled" : "Advice still requires source verification"} />
            <ContextMetric icon={Clock3} label="Scheduled" value={`${Math.round(plan.planHealth.scheduledMinutes / 60 * 10) / 10}h`} detail={`${plan.planHealth.gaps} min remains available`} />
            <ContextMetric icon={BrainCircuit} label={`${founderName} items`} value={`${plan.robertItems.length}`} detail="Visible even when unscheduled" />
            <ContextMetric icon={ListTodo} label="Unscheduled" value={`${plan.unscheduledCards.length}`} detail="Retained for replanning" />
            {!!plan.robertItems.length && <details className="border-t py-3"><summary className="cursor-pointer text-sm font-medium">Decision details ({plan.robertItems.length})</summary><ul className="mt-3 space-y-3 text-sm">{plan.robertItems.map(item => <li key={`${item.cardId}:${item.stepId}`}><p className="font-medium">{item.cardName}</p><p className="text-muted-foreground">{item.decision}</p></li>)}</ul></details>}
            {!!plan.unscheduledCards.length && <details className="border-t py-3"><summary className="cursor-pointer text-sm font-medium">Unscheduled details ({plan.unscheduledCards.length})</summary><ul className="mt-3 space-y-3 text-sm">{plan.unscheduledCards.map(item => <li key={item.cardId}><p className="font-medium">{item.cardName}</p><p className="text-muted-foreground">{item.reason}</p></li>)}</ul></details>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DecisionsView({ founderName }: { founderName: string }) {
  const queue = trpc.aptlss.getDecisionQueue.useQuery(undefined, { staleTime: 30_000 });
  const history = trpc.operator.getDecisionHistory.useQuery({ limit: 20 }, { staleTime: 30_000 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const selected = queue.data?.items.find((item) => item.stepId === selectedId) ?? queue.data?.items[0] ?? null;
  const decisionItems = queue.data?.items ?? [];
  const visibleDecisionItems = showAllDecisions ? decisionItems : decisionItems.slice(0, 8);
  return (
    <div className="space-y-5">
      <PageHeading title="Decisions" description={`These items await a decision from ${founderName}. Continue with other work until the outcome is recorded.`} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card className="gap-0 rounded-lg py-0">
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Awaiting founder</CardTitle><CardDescription>Highest-priority unresolved decision first.</CardDescription></CardHeader>
            <CardContent className="p-0">
              {queue.isLoading ? <div className="p-4"><QueueSkeleton /></div> : decisionItems.length ? <>
                {visibleDecisionItems.map((item, index) => (
                  <button key={item.stepId} type="button" onClick={() => setSelectedId(item.stepId)} className={`grid w-full grid-cols-[28px_minmax(0,1fr)_auto] gap-3 border-b px-4 py-3 text-left hover:bg-accent/40 ${selected?.stepId === item.stepId ? "bg-accent/50" : ""}`}>
                    <span className="flex size-6 items-center justify-center rounded border text-xs">{index + 1}</span>
                    <span className="min-w-0"><span className="block truncate text-sm font-medium">{item.cardName}</span><span className="block truncate text-xs text-muted-foreground">{item.stepTitle}</span></span>
                    <Badge variant="outline" className={priorityTone(item.tier)}>{item.tier}</Badge>
                  </button>
                ))}
                {decisionItems.length > 8 && <div className="p-3">
                  <Button className="w-full" variant="ghost" onClick={() => setShowAllDecisions((value) => !value)}>
                    {showAllDecisions ? "Show fewer decisions" : `Show ${decisionItems.length - 8} more decisions`}
                  </Button>
                </div>}
              </> : <EmptyState title="Decision inbox is clear" detail={`New ${founderName}-required APTLSS steps will appear here.`} />}
            </CardContent>
          </Card>
          <RecentOutcomes rows={history.data ?? []} />
        </div>
        <Card className="h-fit gap-4 rounded-lg p-5 lg:sticky lg:top-20">
          {selected ? <>
            <div><div className="text-xs font-semibold uppercase text-muted-foreground">Decision owner: {founderName}</div><h2 className="mt-1 font-semibold">{selected.cardName}</h2><p className="mt-1 text-sm text-muted-foreground">{selected.stepTitle}</p></div>
            <p className="text-sm">This step remains on hold. The founder records the decision; APTLSS then reassesses the card before you continue.</p>
            {/^https:\/\//i.test(selected.cardUrl) && <Button variant="outline" asChild><a href={selected.cardUrl} target="_blank" rel="noopener noreferrer">Open Trello context <ExternalLink className="size-4" /></a></Button>}
          </> : <EmptyState title="Select a decision" detail="The outcome inspector stays separate from the ordered inbox." />}
        </Card>
      </div>
    </div>
  );
}

function RecentOutcomes({ rows }: { rows: Array<{ id: number; cardName: string; outcome: string; resolvedAt: Date }> }) {
  const [open, setOpen] = useState(false);
  return <Card className="gap-0 rounded-lg py-0"><Collapsible open={open} onOpenChange={setOpen}><CollapsibleTrigger className="flex w-full items-center justify-between p-4 text-left"><span><span className="block text-sm font-semibold">Recent outcomes</span><span className="block text-xs text-muted-foreground">Durable resolution history</span></span>{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</CollapsibleTrigger><CollapsibleContent className="border-t">{rows.length ? rows.map((row) => <div key={row.id} className="border-b p-4 last:border-b-0"><div className="flex justify-between gap-3"><span className="text-sm font-medium">{row.cardName}</span><span className="shrink-0 text-xs text-muted-foreground">{new Date(row.resolvedAt).toLocaleDateString()}</span></div><p className="mt-1 text-sm">{row.outcome}</p></div>) : <div className="p-4 text-sm text-muted-foreground">No recorded outcomes yet.</div>}</CollapsibleContent></Collapsible></Card>;
}

function EvidenceView() {
  const status = trpc.operator.getBrowserTabStatus.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const history = trpc.operator.getBrowserTabEvidenceHistory.useQuery({ limit: 30 }, { retry: false, staleTime: 60_000 });
  const waiting = trpc.operator.getWaitingReasons.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const intelligence = trpc.operator.getWorkQueueContext.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const compliance = trpc.compliance.getHistory.useQuery({ limit: 7 }, { retry: false, staleTime: 60_000 });
  const email = trpc.emailInbox.getPendingCount.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const google = trpc.operator.getGoogleEvidenceStatus.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const latest = compliance.data?.[0] ?? null;
  const browserConnection = describeBrowserConnection(status.data);
  return (
    <div className="space-y-5">
      <PageHeading title="Evidence" description="" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ContextMetric icon={ShieldCheck} label="Tasks" value={`${intelligence.data?.cards.length ?? 0}`} detail="Tasks with recorded steps" />
        <ContextMetric icon={Clock3} label="Waiting reasons" value={`${waiting.data?.length ?? 0}`} detail="Recorded blockers and follow-ups" />
        <ContextMetric icon={Archive} label="Browser connection" value={browserConnection.label} detail={browserConnection.detail} />
        <ContextMetric icon={History} label="Daily compliance" value={latest ? `${latest.compliancePct}%` : "No snapshot"} detail={latest ? `${latest.evidenceCount} source facts checked` : "Record a verified snapshot"} />
      </div>
      <Card className="gap-0 rounded-lg py-0">
        <CardHeader className="border-b py-4"><CardTitle className="text-sm">Connected sources</CardTitle></CardHeader>
        <CardContent className="divide-y p-0">
          <EvidenceRow label="Trello tasks" status={intelligence.error ? "Needs attention" : "Connected"} detail={intelligence.error?.message ?? "Task status, priority and remaining steps."} />
          <EvidenceRow label="Waiting reasons" status="Operational" detail="Recorded reasons tasks are waiting and who needs to respond." />
          <EvidenceRow label="Browser tabs" status={browserConnection.label} detail={browserConnection.detail} />
          <EvidenceRow label="Communication" status={latest?.verificationStatus ?? "No snapshot"} detail={latest ? `${latest.messageReplied}/${latest.messageTotal} messages answered; ${latest.messageNeedsClarification} need clarification.` : "No verified communication snapshot is available yet."} />
          <EvidenceRow label="Gmail processing" status={!google.data?.credentialsReady ? "Setup required" : email.error ? "Needs attention" : `${email.data?.count ?? 0} pending`} detail={!google.data?.credentialsReady ? google.data?.setupMessage ?? "Google credentials have not been checked yet." : latest ? `${latest.emailCompleted}/${latest.emailTotal} retained emails were processed or archived for the latest snapshot.` : "Inbox tasks are retained without changing Gmail automatically."} />
          <EvidenceRow label="Google Drive" status={!google.data?.credentialsReady ? "Setup required" : google.data.drive.lastSyncedAt ? "Connected" : "Waiting for first sync"} detail={!google.data?.credentialsReady ? google.data?.setupMessage ?? "Google credentials have not been checked yet." : google.data.drive.lastSyncedAt ? `File list last checked ${new Date(google.data.drive.lastSyncedAt).toLocaleString()}. Only files matched to a task are included.` : "No Drive files have been checked for your tasks yet."} />
          <EvidenceRow label="Time accountability" status={latest ? `${Math.round(latest.trackedSeconds / 360) / 10}h tracked` : "No snapshot"} detail={latest ? `${Math.round(latest.overtimeSeconds / 360) / 10}h overtime against the configured worker schedule.` : "Completed timer entries are included in the next snapshot."} />
          <EvidenceRow label="Browser history" status={`${history.data?.length ?? 0} days`} detail="Your recorded end-of-day tab checks." />
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
  const google = trpc.operator.getGoogleEvidenceStatus.useQuery(undefined, { retry: false, staleTime: 60_000, refetchInterval: 60_000 });
  const apiHealth = trpc.system.health.useQuery(
    { timestamp: 0 },
    { retry: 1, staleTime: 30_000, refetchInterval: 60_000 },
  );
  const [enabled, setEnabled] = useState(true);
  const [maxOpenTabs, setMaxOpenTabs] = useState(5);
  const [warningMinutes, setWarningMinutes] = useState(30);
  const [staleMinutes, setStaleMinutes] = useState(10);
  const [includePinnedTabs, setIncludePinnedTabs] = useState(false);
  const [gmailEnabled, setGmailEnabled] = useState(true);
  const [gmailInterval, setGmailInterval] = useState(60);
  const [gmailLookback, setGmailLookback] = useState(30);
  const [driveEnabled, setDriveEnabled] = useState(true);
  const [driveInterval, setDriveInterval] = useState(180);
  const [driveLookback, setDriveLookback] = useState(30);
  const [driveFolderId, setDriveFolderId] = useState("");

  useEffect(() => {
    if (!policy.data) return;
    setEnabled(policy.data.enabled);
    setMaxOpenTabs(policy.data.maxOpenTabs);
    setWarningMinutes(policy.data.warningMinutesBeforeEnd);
    setStaleMinutes(policy.data.staleAfterMinutes);
    setIncludePinnedTabs(policy.data.includePinnedTabs);
  }, [policy.data]);

  useEffect(() => {
    if (!google.data) return;
    setGmailEnabled(google.data.settings.gmail.enabled);
    setGmailInterval(google.data.settings.gmail.intervalMinutes);
    setGmailLookback(google.data.settings.gmail.lookbackDays);
    setDriveEnabled(google.data.settings.drive.enabled);
    setDriveInterval(google.data.settings.drive.intervalMinutes);
    setDriveLookback(google.data.settings.drive.lookbackDays);
    setDriveFolderId(google.data.settings.drive.folderId ?? "");
  }, [google.data]);

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
  const saveGoogle = trpc.operator.updateGoogleEvidenceSettings.useMutation({
    onSuccess: () => {
      void utils.operator.getGoogleEvidenceStatus.invalidate();
      toast.success("Google evidence settings saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const syncGoogle = trpc.operator.syncGoogleEvidence.useMutation({
    onSuccess: (result) => {
      void utils.operator.getGoogleEvidenceStatus.invalidate();
      void utils.emailInbox.getPendingCount.invalidate();
      void utils.operator.getWorkQueueContext.invalidate();
      if (!result.configured) {
        toast.error(result.message ?? "Google evidence is not configured");
      } else if (result.message) {
        toast.error(result.message);
      } else {
        toast.success(`Evidence refreshed: ${result.gmail.imported} emails and ${result.drive.imported} Drive files checked`);
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const disconnectGoogle = trpc.operator.disconnectGoogleEvidence.useMutation({
    onSuccess: () => {
      void utils.operator.getGoogleEvidenceStatus.invalidate();
      toast.success("Google worker connection removed");
    },
    onError: (error) => toast.error(error.message),
  });
  const worker = context.data;
  const browserConnection = describeBrowserConnection(browser.data);
  const googleReady = google.data?.credentialsReady === true;
  const gmailSync = googleReady ? describeWorkerIntegrationSync({
    enabled: google.data!.gmail.enabled,
    intervalMinutes: google.data!.gmail.intervalMinutes,
    lastSyncedAt: google.data!.gmail.lastSyncedAt,
    lastError: google.data!.gmail.lastError,
  }) : null;
  const driveSync = googleReady ? describeWorkerIntegrationSync({
    enabled: google.data!.drive.enabled,
    intervalMinutes: google.data!.drive.intervalMinutes,
    lastSyncedAt: google.data!.drive.lastSyncedAt,
    lastError: google.data!.drive.lastError,
  }) : null;
  const connectionTime = (value: string | null | undefined) => formatIntegrationTime(value, worker?.timezone ?? "UTC");
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="space-y-5">
      <PageHeading title="Settings" description="" />
      <ManagerShadowSettings />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="gap-0 rounded-lg py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Browser organization</CardTitle>
            <CardDescription>Warn near the end of the working day when the connected browser exceeds the agreed limit.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-5">
            <details className="border-b pb-4" open={!browser.data?.collectorConfigured}>
              <summary className="cursor-pointer text-sm font-medium">Connect this work browser</summary>
              <div className="mt-3 space-y-3 text-sm text-muted-foreground">
                <Button variant="outline" asChild><a href="/downloads/worker-browser-collector.zip" download>Download browser collector</a></Button>
                <p>If you already installed an earlier version, replace the files in the same unpacked extension folder and click Reload on the browser's Extensions page. Keeping the same installation preserves its saved pairing.</p>
                <ol className="list-decimal space-y-2 pl-5"><li>Extract the download. In Chrome or Edge Extensions, enable developer mode and choose Load unpacked. Select the extracted folder.</li><li>Create a pairing token below. This replaces any previous token for this worker.</li><li>In the extension settings, enter this dashboard address: <span className="break-all font-mono">{window.location.origin}</span>. Paste the token, enable reporting and choose Save and test.</li></ol>
                <p>The collector reports tab counts, website domains and pinned state. It does not send page contents, URL paths or tab titles. Closing tabs always requires your selection and confirmation.</p>
              </div>
            </details>
            <div className="flex items-center justify-between gap-4">
              <div><Label htmlFor="browser-policy-enabled">End-of-day checks</Label><p className="mt-1 text-xs text-muted-foreground">Keep tab hygiene evidence active for this profile.</p></div>
              <Switch id="browser-policy-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberSetting id="max-open-tabs" label="Allowed tabs" value={maxOpenTabs} min={0} max={50} onChange={setMaxOpenTabs} />
              <NumberSetting id="warning-minutes" label="Warn before end" value={warningMinutes} min={0} max={240} suffix="min" onChange={setWarningMinutes} />
              <NumberSetting id="stale-minutes" label="Warn if disconnected for" value={staleMinutes} min={2} max={120} suffix="min" onChange={setStaleMinutes} />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div><Label htmlFor="include-pinned">Count pinned tabs</Label><p className="mt-1 text-xs text-muted-foreground">Pinned reference tabs are excluded by default.</p></div>
              <Switch id="include-pinned" checked={includePinnedTabs} onCheckedChange={setIncludePinnedTabs} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => collectorToken.mutate()} disabled={collectorToken.isPending}>
                {collectorToken.isPending ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}Create and copy pairing token
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
            <CardHeader className="border-b py-4"><CardTitle className="text-sm">Connection health</CardTitle><CardDescription>These checks show saved access and sync freshness, not proof that every source contains all task information.</CardDescription></CardHeader>
            <CardContent className="divide-y p-0">
              <ConnectionRow
                label="Dashboard connection"
                status={apiHealth.data?.runtime === "unified-node" ? "Connected" : apiHealth.isLoading ? "Checking" : "Unavailable"}
                detail={apiHealth.data?.runtime === "unified-node" ? "The dashboard API is responding." : "The dashboard API could not be confirmed. Refresh before relying on saved status."}
                tone={apiHealth.data?.runtime === "unified-node" ? "healthy" : apiHealth.isLoading ? "muted" : "critical"}
              />
              <ConnectionRow
                label="Trello"
                status={worker?.trelloMemberId ? "Member configured" : "Shared account"}
                detail="This is the saved account mapping; the task's source status shows whether cached Trello data is still usable."
                tone="muted"
              />
              <ConnectionRow
                label="Gmail"
                status={!google.data ? google.error ? "Unavailable" : "Checking" : !googleReady ? "Setup required" : email.error ? "Needs attention" : gmailSync!.label}
                detail={!google.data ? "Gmail status could not be loaded." : !googleReady ? google.data.setupMessage ?? "Connect Google for this worker." : `${gmailSync!.detail}${google.data.gmail.lastSyncedAt ? ` Last successful sync: ${connectionTime(google.data.gmail.lastSyncedAt)}.` : ""} ${email.data?.count ?? 0} pending message${email.data?.count === 1 ? "" : "s"}.`}
                tone={!google.data ? "critical" : !googleReady || email.error ? "critical" : gmailSync!.tone}
                href="#google-connection"
                linkLabel="Review Gmail settings"
              />
              <ConnectionRow
                label="Google Drive"
                status={!google.data ? google.error ? "Unavailable" : "Checking" : !googleReady ? "Setup required" : driveSync!.label}
                detail={!google.data ? "Drive status could not be loaded." : !googleReady ? google.data.setupMessage ?? "Connect Google for this worker." : `${driveSync!.detail}${google.data.drive.lastSyncedAt ? ` Last successful sync: ${connectionTime(google.data.drive.lastSyncedAt)}.` : ""} ${google.data.drive.folderScoped ? "Limited to the selected folder." : "Checks accessible file metadata."}`}
                tone={!google.data ? "critical" : !googleReady ? "critical" : driveSync!.tone}
                href="#google-connection"
                linkLabel="Review Drive settings"
              />
              <ConnectionRow
                label="Browser collector"
                status={browserConnection.label}
                detail={browserConnection.detail}
                tone={browserConnection.healthy ? "healthy" : "warning"}
              />
            </CardContent>
          </Card>
        </div>
      </div>
      <Card id="google-connection" className="gap-0 rounded-lg py-0 scroll-mt-20">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-sm">Google connection</CardTitle>
          <CardDescription>Read-only access. Nothing is sent, archived, labelled, or moved in Google.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 p-5">
          {!google.data?.credentialsReady && <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>Google connection needs setup</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{google.data?.setupMessage ?? "Checking the Google connection."}</span>{google.data?.clientConfigured && <Button size="sm" asChild><a href="/api/google-evidence/connect">Connect Google</a></Button>}</AlertDescription>
          </Alert>}
          <details><summary className="cursor-pointer text-sm font-medium">Google sync preferences</summary>
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <section className="space-y-4 rounded-md border p-4">
              <div className="flex items-center justify-between gap-4"><div><Label htmlFor="gmail-evidence-enabled">Gmail intake</Label><p className="mt-1 text-xs text-muted-foreground">Keeps only the newest message in each inbox thread.</p></div><Switch id="gmail-evidence-enabled" checked={gmailEnabled} onCheckedChange={setGmailEnabled} /></div>
              <div className="grid gap-4 sm:grid-cols-2"><NumberSetting id="gmail-interval" label="Check every" value={gmailInterval} min={15} max={1440} suffix="min" onChange={setGmailInterval} /><NumberSetting id="gmail-lookback" label="Look back" value={gmailLookback} min={1} max={90} suffix="days" onChange={setGmailLookback} /></div>
              <p className="text-xs text-muted-foreground">{google.data?.gmail.lastSyncedAt ? `Last checked ${new Date(google.data.gmail.lastSyncedAt).toLocaleString()}.` : "No Gmail data collected yet."}</p>
            </section>
            <section className="space-y-4 rounded-md border p-4">
              <div className="flex items-center justify-between gap-4"><div><Label htmlFor="drive-evidence-enabled">Drive metadata</Label><p className="mt-1 text-xs text-muted-foreground">Links files only when the card ID or full card title matches exactly.</p></div><Switch id="drive-evidence-enabled" checked={driveEnabled} onCheckedChange={setDriveEnabled} /></div>
              <div className="grid gap-4 sm:grid-cols-2"><NumberSetting id="drive-interval" label="Check every" value={driveInterval} min={15} max={1440} suffix="min" onChange={setDriveInterval} /><NumberSetting id="drive-lookback" label="Look back" value={driveLookback} min={1} max={90} suffix="days" onChange={setDriveLookback} /></div>
              <div className="space-y-2"><Label htmlFor="drive-folder-id">Optional folder ID</Label><Input id="drive-folder-id" value={driveFolderId} onChange={(event) => setDriveFolderId(event.target.value)} placeholder="All accessible files when empty" /><p className="text-xs text-muted-foreground">{google.data?.drive.lastSyncedAt ? `Last checked ${new Date(google.data.drive.lastSyncedAt).toLocaleString()}.` : "No Drive metadata collected yet."}</p></div>
            </section>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {google.data?.connectionMode === "worker" && <Button variant="outline" onClick={() => disconnectGoogle.mutate()} disabled={disconnectGoogle.isPending}>{disconnectGoogle.isPending && <Loader2 className="size-4 animate-spin" />}Disconnect Google</Button>}
            <Button variant="outline" onClick={() => syncGoogle.mutate({ gmail: gmailEnabled, drive: driveEnabled })} disabled={syncGoogle.isPending}>{syncGoogle.isPending && <Loader2 className="size-4 animate-spin" />}Sync now</Button>
            <Button onClick={() => saveGoogle.mutate({ gmail: { enabled: gmailEnabled, intervalMinutes: gmailInterval, lookbackDays: gmailLookback }, drive: { enabled: driveEnabled, intervalMinutes: driveInterval, lookbackDays: driveLookback, folderId: driveFolderId.trim() || null } })} disabled={saveGoogle.isPending}>{saveGoogle.isPending && <Loader2 className="size-4 animate-spin" />}Save sync preferences</Button>
          </div>
          </details>
        </CardContent>
      </Card>
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

function formatIntegrationTime(value: string | null | undefined, timeZone: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "time unknown";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
  } catch {
    return "time unknown";
  }
}

function ConnectionRow({ label, status, detail, tone, href, linkLabel }: {
  label: string;
  status: string;
  detail: string;
  tone: "healthy" | "warning" | "critical" | "muted";
  href?: string;
  linkLabel?: string;
}) {
  const toneClass = {
    healthy: "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
    warning: "border-amber-500/30 text-amber-700 dark:text-amber-300",
    critical: "border-red-500/30 text-red-700 dark:text-red-300",
    muted: "border-border text-muted-foreground",
  }[tone];
  return (
    <div className="grid gap-2 p-4 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] sm:items-start">
      <div className="flex min-w-0 items-center justify-between gap-3 sm:flex-col sm:items-start">
        <span className="flex items-center gap-2 text-sm font-medium"><Monitor className="size-4 shrink-0 text-muted-foreground" />{label}</span>
        <Badge variant="outline" className={toneClass}>{status}</Badge>
      </div>
      <div className="min-w-0 text-sm text-muted-foreground">
        <p>{detail}</p>
        {href && linkLabel && <a href={href} className="mt-1 inline-block font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">{linkLabel}</a>}
      </div>
    </div>
  );
}

function EvidenceRow({ label, status, detail }: { label: string; status: string; detail: string }) {
  return <div className="grid gap-2 p-4 sm:grid-cols-[180px_130px_minmax(0,1fr)] sm:items-center"><span className="text-sm font-medium">{label}</span><Badge variant="outline">{status}</Badge><span className="text-sm text-muted-foreground">{detail}</span></div>;
}

function PageHeading({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <div className="flex flex-col justify-between gap-3 border-b pb-4 sm:flex-row sm:items-end"><div><h1 className="text-2xl font-semibold">{title}</h1>{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}</div>{actions}</div>;
}

function ContextMetric({ icon: Icon, label, value, detail, onClick }: { icon: typeof Activity; label: string; value: string; detail: string; onClick?: () => void }) {
  const content = <><div className="flex items-center justify-between text-xs font-semibold uppercase text-muted-foreground"><span>{label}</span><Icon className="size-4" /></div><div className="mt-2 text-lg font-semibold">{value}</div><div className="mt-1 text-xs text-muted-foreground">{detail}</div></>;
  return onClick ? <button type="button" onClick={onClick} className="w-full rounded-lg border bg-card p-4 text-left hover:border-blue-500/40 hover:bg-accent/20">{content}</button> : <div className="rounded-lg border bg-card p-4">{content}</div>;
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
