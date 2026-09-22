import { toast } from "sonner";
import RecentUpdatesWidget from "@/components/manus/RecentUpdatesWidget";
import { InfoTooltip } from "@/components/manus/InfoTooltip";
import ActionAlerts from "@/components/manus/ActionAlerts";
import RobertDecisionQueue from "@/components/manus/RobertDecisionQueue";
import { ConversationDialog } from "@/components/ConversationDialog";
import TimeTracker from "@/components/manus/TimeTracker";
import WebhookHealthPanel from "@/components/manus/WebhookHealthPanel";
import TriagePage, { useTriageCounts } from "./TriagePage";
import TasksTab from "./TasksTab";
import DecisionsTab from "./RulesTab";
import StandardsTab from "./StandardsTab";
import PaymentTracker from "./PaymentTracker";
import SundayChecklist from "./SundayChecklist";
import WeeklyPayCalculator from "./WeeklyPayCalculator";
import ComplianceTracker from "./ComplianceTracker";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useWebSocket } from "@/hooks/useWebSocket";
import { TaskCard } from "@/components/TaskCard";
import { Task } from "@/types";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useTheme } from "@/contexts/ThemeContext";
import {
  Clock,
  Mail,
  MessageSquare,
  Briefcase,
  Coffee,
  Utensils,
  Moon,
  Sun,
  Keyboard,
  LogOut,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  TrendingUp,
  Activity,
  Award,
  Zap,
  Flame,
  Timer,
  ArrowRight,
  GitBranch,
  Settings,
  BookOpen,
  Battery,
  ListTodo,
  RefreshCw,
  Calendar,
  Target,
  Heart,
  ChevronDown,
  ChevronUp,
  Shield,
} from "lucide-react";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

// ─── Today's compliance chip for the header ─────────────────────────────────
function TodayComplianceChip() {
  const { data: history = [] } = trpc.compliance.getHistory.useQuery({ limit: 1 });
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = history.find(r => {
    const d = typeof r.snapshotDate === 'string' ? r.snapshotDate : new Date(r.snapshotDate).toISOString().slice(0, 10);
    return d === today;
  });
  if (!todayRow) return null;
  const pct = todayRow.compliancePct;
  const colorClass = pct >= 90
    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
    : pct >= 70
    ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
    : "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400";
  return (
    <span className={`hidden sm:inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full border ${colorClass}`}>
      {pct}% today
    </span>
  );
}

// ─── Compliance badge for the Performance sidebar item ───────────────────────
function ComplianceBadge() {
  const { data } = trpc.compliance.getRollingAvg.useQuery({ days: 7 });
  const avg = data?.avg;
  if (avg === undefined) return null;
  const color = avg >= 90
    ? "bg-emerald-500"
    : avg >= 70
    ? "bg-amber-500"
    : "bg-red-500";
  return (
    <span className={`ml-auto min-w-[28px] h-[18px] px-1.5 rounded-full text-[9px] font-bold text-white flex items-center justify-center leading-none ${color}`}>
      {avg}%
    </span>
  );
}

// ─── No-due-date badge for the Triage sidebar item ───────────────────────────
function NoDueDateBadge() {
  // Share the same cache entry as ActionAlerts (5 min staleTime) — no extra fetch needed.
  const { data } = trpc.trello.actionAlerts.useQuery(undefined, { staleTime: 5 * 60_000 });
  const count = data?.noDueDateCards?.length ?? 0;
  if (count === 0) return null;
  return (
    <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold text-white flex items-center justify-center leading-none bg-amber-500">
      {count}
    </span>
  );
}

/** Red badge on the Reply Monitor nav item showing total active flags. */
function ReplyMonitorBadge() {
  // All three share cache with the ReplyMonitor page queries (15 min staleTime).
  // No extra network requests are made when the ReplyMonitor page is already mounted.
  const { data: badgeSetting } = trpc.settings.getReplyMonitorBadge.useQuery(undefined, { staleTime: 5 * 60_000 });
  const { data: pendingThreads } = trpc.replyMonitor.getPendingThreads.useQuery(undefined, { staleTime: 15 * 60_000, enabled: badgeSetting?.enabled !== false });
  const { data: vagueFlags } = trpc.replyMonitor.getActiveVagueFlags.useQuery(undefined, { staleTime: 15 * 60_000, enabled: badgeSetting?.enabled !== false });
  const { data: unsignedFlags } = trpc.replyMonitor.getActiveUnsignedFlags.useQuery(undefined, { staleTime: 15 * 60_000, enabled: badgeSetting?.enabled !== false });

  if (!badgeSetting?.enabled) return null;

  const count = (pendingThreads?.length ?? 0) + (vagueFlags?.length ?? 0) + (unsignedFlags?.length ?? 0);
  if (count === 0) return null;

  return (
    <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold text-white flex items-center justify-center leading-none bg-red-500">
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Combined badge on the Triage sidebar item: shows reply + email counts as two pills. */
function TriageSidebarBadge() {
  const { replyCount, emailCount } = useTriageCounts();
  return (
    <span className="ml-auto flex items-center gap-0.5">
      {replyCount > 0 && (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold text-white flex items-center justify-center leading-none bg-red-500">
          {replyCount > 99 ? '99+' : replyCount}
        </span>
      )}
      {emailCount > 0 && (
        <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold text-white flex items-center justify-center leading-none bg-amber-500">
          {emailCount > 99 ? '99+' : emailCount}
        </span>
      )}
    </span>
  );
}
// ─── Projected pay chip for the sidebar footer ───────────────────────────────
const MERIT_AMOUNTS: Record<string, number> = { meritM1: 5, meritM2: 7.5, meritM3: 1, meritStreak: 10 };
const DEMERIT_AMOUNTS: Record<string, number> = { demeritD1: 5, demeritD2: 10, demeritD3: 5, demeritD4: 5, demeritD5: 10, demeritD6: 5, demeritD7: 5, demeritD8: 10, demeritD9: 15, demeritD10: 15, demeritD11: 15 };

function ProjectedPayChip() {
  // Get the current week start (Monday) and end (Sunday)
  const { weekStart, weekEnd } = useMemo(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const start = new Date(d);
    start.setDate(d.getDate() + diff);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      weekStart: start.toISOString().slice(0, 10),
      weekEnd: end.toISOString().slice(0, 10),
    };
  }, []);
  const utils = trpc.useUtils();
  const { data: payData, isLoading } = trpc.payLog.getByWeek.useQuery({ weekStart }, { staleTime: 5 * 60_000 });
  const createWeekLog = trpc.payLog.upsert.useMutation({
    onSuccess: () => utils.payLog.getByWeek.invalidate({ weekStart }),
  });
  // Auto-create a zero-row for this week so the Weekly Pay Calculator is pre-populated
  useEffect(() => {
    if (!isLoading && payData === null) {
      createWeekLog.mutate({
        weekStart, weekEnd,
        meritM1: 0, meritM2: 0, meritM3: 0, meritStreak: 0,
        demeritD1: 0, demeritD2: 0, demeritD3: 0, demeritD4: 0,
        demeritD5: 0, demeritD6: 0, demeritD7: 0, demeritD8: 0,
        demeritD9: 0, demeritD10: 0, demeritD11: 0,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, payData === null]);
  // Show brief loading indicator; fall back to base $90 if no row exists yet this week
  if (isLoading) return <span className="text-xs text-muted-foreground">…</span>;
  // Calculate projected pay using same formula as WeeklyPayCalculator
  // Base is $90/week; merits add, demerits subtract
  // Use empty object fallback so chip shows $90.00 base when no row exists yet
  const safeData = (payData ?? {}) as Record<string, unknown>;
  const totalMerits = Object.entries(MERIT_AMOUNTS).reduce((sum, [key, amt]) => sum + (Number(safeData[key]) || 0) * amt, 0);
  const totalDemerits = Object.entries(DEMERIT_AMOUNTS).reduce((sum, [key, amt]) => sum + (Number(safeData[key]) || 0) * amt, 0);
  const rawProjected = 90 - totalDemerits + totalMerits;
  const isNegative = rawProjected < 0;
  const isWarning = rawProjected < 90 && rawProjected >= 0;
  return (
    <span className={`text-xs font-semibold tabular-nums ${
      isNegative ? "text-red-600 dark:text-red-400" :
      isWarning ? "text-amber-600 dark:text-amber-400" :
      "text-emerald-600 dark:text-emerald-400"
    }`}>
      {isNegative ? `-$${Math.abs(rawProjected).toFixed(2)}` : `$${rawProjected.toFixed(2)}`}
    </span>
  );
}

// ─── Compliance trend arrow for the Overview ─────────────────────────────────
function ComplianceTrendChip() {
  const { data: history = [] } = trpc.compliance.getHistory.useQuery({ limit: 14 });
  const { data: rollingData } = trpc.compliance.getRollingAvg.useQuery({ days: 7 });
  const avg7 = rollingData?.avg;
  if (avg7 === undefined || history.length < 2) return null;
  // Compare last 7 days avg vs previous 7 days avg
  const sorted = [...history].sort((a, b) => new Date(a.snapshotDate).getTime() - new Date(b.snapshotDate).getTime());
  const recent7 = sorted.slice(-7);
  const prev7 = sorted.slice(-14, -7);
  const recentAvg = recent7.length ? Math.round(recent7.reduce((s, r) => s + r.compliancePct, 0) / recent7.length) : avg7;
  const prevAvg = prev7.length ? Math.round(prev7.reduce((s, r) => s + r.compliancePct, 0) / prev7.length) : recentAvg;
  const delta = recentAvg - prevAvg;
  const isUp = delta > 0;
  const isFlat = delta === 0;
  const colorClass = avg7 >= 90
    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
    : avg7 >= 70
    ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
    : "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${colorClass}`}>
      {isFlat ? "→" : isUp ? "↑" : "↓"} {avg7}% 7-day avg
      {!isFlat && <span className="text-[10px] opacity-70">({delta > 0 ? "+" : ""}{delta}%)</span>}
    </span>
  );
}

// ─── Trello Power-Up setup ──────────────────────────────────────────────────
function useTrelloClientKey() {
  const [clientApiKey, setClientApiKey] = useState("");

  useEffect(() => {
    fetch("/api/auth/trello/client-key")
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.apiKey) setClientApiKey(data.apiKey);
      })
      .catch(err => console.error("Failed to load Trello client key:", err));
  }, []);

  return clientApiKey;
}

function TrelloClientKeyCopyField() {
  const clientApiKey = useTrelloClientKey();

  if (!clientApiKey) {
    return (
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        Configure <code>TRELLO_API_KEY</code> on the server before completing this step.
      </p>
    );
  }

  return (
    <code
      className="block cursor-pointer select-all break-all rounded border border-border bg-background px-2 py-1.5 text-xs text-amber-400 transition-colors hover:border-amber-500/50"
      onClick={() => { void navigator.clipboard.writeText(clientApiKey); }}
      title="Click to copy"
    >
      {clientApiKey}
    </code>
  );
}

// ─── Daily Goal Settings ─────────────────────────────────────────────────────
function DailyGoalSettings() {
  const { data: goalData, refetch } = trpc.settings.getDailyGoal.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const setGoalMutation = trpc.settings.setDailyGoal.useMutation({
    onSuccess: (data) => {
      toast.success(`Daily goal updated to ${data.hours}h`);
      refetch();
    },
    onError: (e) => toast.error(`Failed to save: ${e.message}`),
  });

  const currentHours = goalData?.hours ?? 9;
  const [localHours, setLocalHours] = useState<number>(currentHours);

  useEffect(() => {
    setLocalHours(currentHours);
  }, [currentHours]);

  const handleSave = () => {
    if (localHours < 1 || localHours > 24) {
      toast.error("Daily goal must be between 1 and 24 hours");
      return;
    }
    setGoalMutation.mutate({ hours: localHours });
  };

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
      <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
        <Target className="w-4 h-4 text-emerald-500" />
        Daily Hour Goal
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Set Worker's daily target hours. The Time Tracker progress ring, bar chart dashed line, and "goal met" colouring all update automatically. Recommended range: 9–10 hours/day. Overtime is still tracked if she goes past 10h.
      </p>
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <input
            type="range"
            min={1}
            max={14}
            step={0.5}
            value={localHours}
            onChange={(e) => setLocalHours(parseFloat(e.target.value))}
            className="w-full accent-emerald-500"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>1h</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">9–10h recommended</span>
            <span>14h</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <input
            type="number"
            min={1}
            max={14}
            step={0.5}
            value={localHours}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) setLocalHours(v);
            }}
            className="w-16 h-9 text-center text-sm font-bold border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          />
          <span className="text-sm text-muted-foreground">h/day</span>
          <Button
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={handleSave}
            disabled={setGoalMutation.isPending || localHours === currentHours}
          >
            {setGoalMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {localHours !== currentHours && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
          Unsaved change: {localHours}h/day (currently {currentHours}h)
        </p>
      )}
    </div>
  );
}

// ─── Daily Schedule Settings ───────────────────────────────────────────────
interface BreakSlot { name: string; startTime: string; durationMinutes: number; icon?: string; }
interface ScheduleSettings { startTime: string; endTime: string; breaks: BreakSlot[]; typingPractice?: boolean; typingPracticeMinutes?: number; }

const BREAK_ICONS = ["☕", "🍽️", "🌙", "🍵", "🥤", "🪴", "🧃", "🍎", "🍪", "🍺"];

function DailyScheduleSettings({ onGoToSchedule }: { onGoToSchedule?: () => void }) {
  const { data: saved, refetch } = trpc.settings.getSchedule.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const setScheduleMutation = trpc.settings.setSchedule.useMutation({
    onSuccess: () => { toast.success("Schedule saved"); refetch(); },
    onError: (e) => toast.error(`Failed to save: ${e.message}`),
  });

  const [local, setLocal] = useState<ScheduleSettings | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState<number | null>(null);

  useEffect(() => {
    if (saved && !local) setLocal(saved as ScheduleSettings);
  }, [saved]);

  const s: ScheduleSettings = local ?? (saved as ScheduleSettings) ?? { startTime: "08:00", endTime: "23:00", breaks: [], typingPractice: true, typingPracticeMinutes: 30 };
  const typingOn = s.typingPractice !== false;
  const typingMins = s.typingPracticeMinutes ?? 30;

  const updateBreak = (idx: number, field: keyof BreakSlot, value: string | number) => {
    const breaks = [...s.breaks];
    breaks[idx] = { ...breaks[idx], [field]: value };
    setLocal({ ...s, breaks });
  };

  const addBreak = () => setLocal({ ...s, breaks: [...s.breaks, { name: "Break", startTime: "12:00", durationMinutes: 30, icon: "☕" }] });
  const removeBreak = (idx: number) => { setIconPickerOpen(null); setLocal({ ...s, breaks: s.breaks.filter((_, i) => i !== idx) }); };

  const isDirty = JSON.stringify(local) !== JSON.stringify(saved);

  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Clock className="w-4 h-4 text-sky-500" />
          Daily Schedule
        </h3>
        {onGoToSchedule && (
          <button onClick={onGoToSchedule} className="text-xs text-sky-500 hover:text-sky-400 flex items-center gap-1 transition-colors">
            Go to Daily Schedule <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Configure Worker's work start/end time and break slots. The Day Timeline updates automatically.
      </p>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Work Start</label>
            <input type="time" value={s.startTime} onChange={e => setLocal({ ...s, startTime: e.target.value })}
              className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-sky-500/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Log Off</label>
            <input type="time" value={s.endTime} onChange={e => setLocal({ ...s, endTime: e.target.value })}
              className="w-full h-9 px-3 text-sm border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-sky-500/50" />
          </div>
        </div>

        {/* Typing Practice */}
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-foreground flex items-center gap-2">
              <Keyboard className="w-3.5 h-3.5 text-purple-500" />
              Typing Practice (EOD)
            </label>
            <button
              onClick={() => setLocal({ ...s, typingPractice: !typingOn })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                typingOn ? 'bg-purple-500' : 'bg-muted'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                typingOn ? 'translate-x-4' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
          {typingOn && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Duration:</label>
              <input type="number" min={5} max={120} step={5} value={typingMins}
                onChange={e => setLocal({ ...s, typingPracticeMinutes: parseInt(e.target.value) || 30 })}
                className="w-16 h-7 px-2 text-xs text-center border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-purple-500/50" />
              <span className="text-xs text-muted-foreground">min</span>
            </div>
          )}
        </div>

        {/* Breaks */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-foreground">Breaks</label>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addBreak}>+ Add Break</Button>
          </div>
          <div className="space-y-2">
            {s.breaks.map((brk, idx) => (
              <div key={idx} className="space-y-1.5">
                <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-2 items-center">
                  {/* Icon picker trigger */}
                  <button
                    onClick={() => setIconPickerOpen(iconPickerOpen === idx ? null : idx)}
                    className="w-8 h-8 rounded-md border border-border bg-background hover:bg-muted flex items-center justify-center text-base transition-colors"
                    title="Pick icon"
                  >
                    {brk.icon || "☕"}
                  </button>
                  <input type="text" placeholder="Name" value={brk.name}
                    onChange={e => updateBreak(idx, "name", e.target.value)}
                    className="h-8 px-2 text-xs border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-sky-500/50" />
                  <input type="time" value={brk.startTime}
                    onChange={e => updateBreak(idx, "startTime", e.target.value)}
                    className="h-8 px-2 text-xs border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-sky-500/50" />
                  <div className="flex items-center gap-1">
                    <input type="number" min={5} max={480} step={5} value={brk.durationMinutes}
                      onChange={e => updateBreak(idx, "durationMinutes", parseInt(e.target.value) || 30)}
                      className="w-16 h-8 px-2 text-xs text-center border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-sky-500/50" />
                    <span className="text-xs text-muted-foreground">min</span>
                  </div>
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10" onClick={() => removeBreak(idx)}>
                    <span className="text-sm">×</span>
                  </Button>
                </div>
                {/* Icon picker popover */}
                {iconPickerOpen === idx && (
                  <div className="flex flex-wrap gap-1.5 p-2 bg-card border border-border rounded-lg shadow-md">
                    {BREAK_ICONS.map(em => (
                      <button key={em} onClick={() => { updateBreak(idx, "icon", em); setIconPickerOpen(null); }}
                        className={`w-8 h-8 text-base rounded-md hover:bg-muted flex items-center justify-center transition-colors ${
                          brk.icon === em ? 'bg-sky-500/20 ring-1 ring-sky-500' : ''
                        }`}>
                        {em}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {s.breaks.length === 0 && <p className="text-xs text-muted-foreground italic">No breaks configured.</p>}
          </div>
        </div>

        <div className="flex justify-end">
          <Button size="sm" className="bg-sky-600 hover:bg-sky-700 text-white"
            onClick={() => setScheduleMutation.mutate(s)}
            disabled={setScheduleMutation.isPending || !isDirty}>
            {setScheduleMutation.isPending ? "Saving…" : "Save Schedule"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Reply Monitor Badge Settings ──────────────────────────────────────────
function ReplyMonitorBadgeSettings() {
  const utils = trpc.useUtils();
  const { data: badgeSetting, isLoading } = trpc.settings.getReplyMonitorBadge.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const setMutation = trpc.settings.setReplyMonitorBadge.useMutation({
    onSuccess: (data) => {
      toast.success(data.enabled ? "Reply Monitor badge enabled" : "Reply Monitor badge disabled");
      utils.settings.getReplyMonitorBadge.invalidate();
    },
    onError: (e) => toast.error(`Failed to update: ${e.message}`),
  });

  const enabled = badgeSetting?.enabled ?? true;

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex-1 mr-4">
          <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-red-500" />
            Reply Monitor Sidebar Badge
          </h3>
          <p className="text-xs text-muted-foreground">
            Show a red count badge on the Reply Monitor nav item when there are active unanswered threads, vague flags, or unsigned message flags.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setMutation.mutate({ enabled: checked })}
          disabled={isLoading || setMutation.isPending}
          aria-label="Toggle Reply Monitor sidebar badge"
        />
      </div>
    </div>
  );
}

// ─── Operational Policies Settings ─────────────────────────────────────────
const POLICY_CATEGORY_LABELS: Record<string, string> = {
  stall: "Stall Detection",
  follow_up: "Auto Follow-Up Drafts",
  escalation: "Escalation Rules",
  autopilot: "Autopilot Level",
  done_gate: "Done Quality Gate",
  scheduling: "Confidence Thresholds",
  default_action: "Default Action Rules (per APTLSS State)",
  general: "General",
};

function OperationalPoliciesSettings() {
  const utils = trpc.useUtils();
  const { data: policies, isLoading } = trpc.aptlss.getPolicies.useQuery(undefined, { staleTime: 60_000 });
  const updateMutation = trpc.aptlss.updatePolicy.useMutation({
    onSuccess: () => { utils.aptlss.getPolicies.invalidate(); toast.success("Policy updated"); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });
  const toggleMutation = trpc.aptlss.togglePolicy.useMutation({
    onSuccess: () => utils.aptlss.getPolicies.invalidate(),
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });
  const [editing, setEditing] = useState<Record<string, string>>({});

  if (isLoading) return <div className="rounded-xl border border-border/50 bg-card/50 p-5"><p className="text-xs text-muted-foreground">Loading policies…</p></div>;

  const grouped = (policies ?? []).reduce((acc, p) => {
    const cat = p.category ?? "general";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(p);
    return acc;
  }, {} as Record<string, typeof policies>);

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-5 space-y-5">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <Shield className="w-4 h-4 text-indigo-500" />
        APTLSS Operational Policies
      </h3>
      <p className="text-xs text-muted-foreground -mt-3">
        Configure thresholds, autopilot level, done-gate rules, and follow-up timing. Changes take effect immediately.
      </p>
      {Object.entries(grouped).map(([cat, catPolicies]) => (
        <div key={cat} className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{POLICY_CATEGORY_LABELS[cat] ?? cat}</p>
          {(catPolicies ?? []).map(policy => (
            <div key={policy.ruleKey} className="flex items-start gap-3 bg-background/50 rounded-lg p-3 border border-border/30">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground">{policy.label}</p>
                {policy.description && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{policy.description}</p>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <input
                  type="text"
                  value={editing[policy.ruleKey] ?? policy.value ?? ""}
                  onChange={(e) => setEditing(prev => ({ ...prev, [policy.ruleKey]: e.target.value }))}
                  onBlur={() => {
                    const val = editing[policy.ruleKey];
                    if (val !== undefined && val !== policy.value) {
                      updateMutation.mutate({ ruleKey: policy.ruleKey, value: val });
                    }
                  }}
                  className="w-20 text-xs bg-background border border-border rounded px-2 py-1 text-right font-mono focus:outline-none focus:border-indigo-500"
                />
                <Switch
                  checked={policy.enabled === 1}
                  onCheckedChange={(checked) => toggleMutation.mutate({ ruleKey: policy.ruleKey, enabled: checked })}
                  aria-label={`Toggle ${policy.label}`}
                />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Default Action Rules Settings (GAP E) ─────────────────────────────────
const APTLSS_STATES = [
  "NEW_UNTRIAGED", "READY_TO_START", "IN_PROGRESS", "WAITING_FOR_WORKER",
  "WAITING_FOR_ROBERT", "WAITING_FOR_EXTERNAL_PARTY", "BLOCKED_BY_OTHER_CARD",
  "STALLED", "OVERDUE", "READY_FOR_REVIEW", "READY_FOR_DONE",
  "DONE_CONFIRMED", "NEEDS_RESTRUCTURING", "NEEDS_ARCHIVE",
] as const;

const BUILT_IN_DEFAULT_ACTIONS: Record<string, string> = {
  NEW_UNTRIAGED: "Generate an APTLSS plan to break this card into actionable steps.",
  READY_TO_START: "Pick the highest-priority open step and start working on it.",
  IN_PROGRESS: "Continue the current open step. Update checklist when done.",
  WAITING_FOR_WORKER: "Answer the pending question in the card comments.",
  WAITING_FOR_ROBERT: "Notify Robert that a decision is needed on this card.",
  WAITING_FOR_EXTERNAL_PARTY: "Check if the follow-up deadline has passed. If yes, send a follow-up message.",
  BLOCKED_BY_OTHER_CARD: "Check the blocking card. If resolved, unblock and resume.",
  STALLED: "Leave a comment explaining why progress has stalled. Escalate if needed.",
  OVERDUE: "Immediately prioritise this card. Notify Robert if it cannot be completed today.",
  READY_FOR_REVIEW: "Ask Robert to review and approve before moving to Done.",
  READY_FOR_DONE: "Verify all done-gate criteria are met, then move the card to Done.",
  DONE_CONFIRMED: "Archive this card at the end of the week.",
  NEEDS_RESTRUCTURING: "Open the card and fix the flagged issue (add description, due date, or split into smaller cards).",
  NEEDS_ARCHIVE: "Mark the card as complete in Trello and move it to the Archive list.",
};

function DefaultActionsSettings() {
  const utils = trpc.useUtils();
  const { data: customActions } = trpc.aptlss.getAllDefaultActions.useQuery(undefined, { staleTime: 60_000 });
  const updateMutation = trpc.aptlss.updatePolicy.useMutation({
    onSuccess: () => { utils.aptlss.getAllDefaultActions.invalidate(); toast.success("Default action updated"); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);

  const customMap = (customActions ?? []).reduce((acc, p) => {
    acc[p.ruleKey] = p.value ?? "";
    return acc;
  }, {} as Record<string, string>);

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Zap className="w-4 h-4 text-violet-500" />
          Default Action Rules
        </h3>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setExpanded(v => !v)}>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 mr-1" /> : <ChevronDown className="w-3.5 h-3.5 mr-1" />}
          {expanded ? "Collapse" : "Expand all 14 states"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-1">
        Customise the recommended action shown in the Daily Actions banner for each APTLSS state. Leave blank to use the built-in default.
      </p>
      {expanded && (
        <div className="space-y-2">
          {APTLSS_STATES.map(state => {
            const ruleKey = `default_action_${state.toLowerCase()}`;
            const customVal = customMap[ruleKey] ?? "";
            const builtIn = BUILT_IN_DEFAULT_ACTIONS[state] ?? "";
            const displayVal = editing[ruleKey] ?? customVal;
            return (
              <div key={state} className="bg-background/50 rounded-lg p-3 border border-border/30 space-y-1.5">
                <p className="text-xs font-mono font-semibold text-foreground">{state}</p>
                <p className="text-[10px] text-muted-foreground italic">{builtIn}</p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Custom override (leave blank for built-in default)…"
                    value={displayVal}
                    onChange={(e) => setEditing(prev => ({ ...prev, [ruleKey]: e.target.value }))}
                    onBlur={() => {
                      const val = editing[ruleKey];
                      if (val !== undefined && val !== customVal) {
                        updateMutation.mutate({ ruleKey, value: val });
                      }
                    }}
                    className="flex-1 text-xs bg-background border border-border rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                  />
                  {customVal && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground hover:text-red-500"
                      onClick={() => {
                        setEditing(prev => ({ ...prev, [ruleKey]: "" }));
                        updateMutation.mutate({ ruleKey, value: "" });
                      }}
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Ready for Done Panel (GAP H) ─────────────────────────────────────────────
function ReadyForDonePanel() {
  const { data: cards } = trpc.aptlss.getReadyForDone.useQuery(undefined, { staleTime: 5 * 60_000 });
  if (!cards || cards.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Ready for Done ({cards.length})</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
        <p className="text-xs text-muted-foreground mb-2">These cards have passed all done-gate checks. Verify and move them to Done in Trello.</p>
        {cards.map(card => (
          <div key={card.cardId} className="flex items-center gap-2 p-2.5 bg-background/50 rounded-lg border border-emerald-500/20">
            <CheckCircle className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{card.cardName}</p>
              {card.stateReason && <p className="text-[10px] text-muted-foreground">{card.stateReason}</p>}
            </div>
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold flex-shrink-0">
              {new Date(card.calculatedAt).toLocaleDateString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Worker Performance Panel ───────────────────────────────────────────────
function WorkerPerformancePanel() {
  const { data: performance, isLoading } = trpc.aptlss.getWorkerPerformance.useQuery(undefined, { staleTime: 5 * 60_000 });
  if (isLoading) return null;
  if (!performance || performance.length === 0) return null;

  const grouped = performance.reduce((acc, p) => {
    if (!acc[p.workerId]) acc[p.workerId] = [];
    acc[p.workerId].push(p);
    return acc;
  }, {} as Record<string, typeof performance>);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Worker Performance Signals</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="space-y-3">
        {Object.entries(grouped).map(([workerId, signals]) => {
          const latest = signals[0];
          const score = Math.max(0, 100 - (latest.stalledCardsCount * 10) - (latest.missedDeadlines * 15) - (latest.reworkCount * 8) - (latest.unclearHandovers * 5));
          const scoreColor = score >= 80 ? "text-emerald-600 dark:text-emerald-400" : score >= 60 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
          return (
            <div key={workerId} className="rounded-xl border border-border/50 bg-card/50 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-foreground">{latest.workerName}</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Week {latest.weekKey}</span>
                  <span className={`text-lg font-bold ${scoreColor}`}>{score}</span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Stalled", value: latest.stalledCardsCount, bad: latest.stalledCardsCount > 2 },
                  { label: "Missed Deadlines", value: latest.missedDeadlines, bad: latest.missedDeadlines > 1 },
                  { label: "Rework", value: latest.reworkCount, bad: latest.reworkCount > 1 },
                  { label: "Escalations", value: latest.robertEscalationsCount, bad: latest.robertEscalationsCount > 2 },
                  { label: "Unclear Handovers", value: latest.unclearHandovers, bad: latest.unclearHandovers > 1 },
                  { label: "Checklist Items", value: latest.checklistItemsCompleted, bad: false },
                ].map(item => (
                  <div key={item.label} className={`rounded-lg p-2 text-center ${item.bad ? "bg-red-500/10 border border-red-500/30" : "bg-muted/30"}`}>
                    <p className={`text-sm font-bold ${item.bad ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{item.value}</p>
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                  </div>
                ))}
              </div>
              {latest.notes && <p className="text-xs text-muted-foreground mt-2 italic">{latest.notes}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Weekly Analysis Panel ───────────────────────────────────────────────────
function WeeklyAnalysisPanel() {
  const { data: latestAnalysis, isLoading } = trpc.aptlss.getLatestWeeklyAnalysis.useQuery(undefined, { staleTime: 10 * 60_000 });
  const { data: history } = trpc.aptlss.getWeeklyAnalysisHistory.useQuery(undefined, { staleTime: 10 * 60_000 });
  const [selectedWeekKey, setSelectedWeekKey] = useState<string | null>(null);

  const analysis = selectedWeekKey
    ? (history ?? []).find(h => h.weekKey === selectedWeekKey) ?? latestAnalysis
    : latestAnalysis;

  if (isLoading || !analysis) return null;

  let noProgressCards: { cardId: string; cardName: string; state: string }[] = [];
  let recurringBlockers: { reason: string; count: number; cards: string[] }[] = [];
  let processImprovements: string[] = [];
  try { noProgressCards = JSON.parse(analysis.noProgressCards ?? "[]"); } catch { /* ignore */ }
  try { recurringBlockers = JSON.parse(analysis.recurringBlockers ?? "[]"); } catch { /* ignore */ }
  try { processImprovements = JSON.parse(analysis.processImprovements ?? "[]"); } catch { /* ignore */ }

  const historyList = history ?? [];

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Weekly Analysis</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      {/* History selector */}
      {historyList.length > 1 && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          {historyList.map(h => (
            <button
              key={h.weekKey}
              onClick={() => setSelectedWeekKey(h.weekKey === latestAnalysis?.weekKey ? null : h.weekKey)}
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full border transition-colors ${
                (selectedWeekKey === h.weekKey || (!selectedWeekKey && h.weekKey === latestAnalysis?.weekKey))
                  ? "bg-blue-500/20 border-blue-500/50 text-blue-700 dark:text-blue-300"
                  : "bg-muted/30 border-border/40 text-muted-foreground hover:border-blue-500/30"
              }`}
            >
              {h.weekKey}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-foreground">Week {analysis.weekKey}</p>
          <span className="text-xs text-muted-foreground">{new Date(analysis.createdAt).toLocaleDateString()}</span>
        </div>
        <p className="text-xs text-muted-foreground">{analysis.summary}</p>
        {noProgressCards.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1">No-Progress Cards ({noProgressCards.length})</p>
            <div className="space-y-1">
              {noProgressCards.slice(0, 5).map(c => (
                <div key={c.cardId} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                  {c.cardName} <span className="text-amber-500">({c.state})</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {recurringBlockers.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 mb-1">Recurring Blockers ({recurringBlockers.length})</p>
            <div className="space-y-1">
              {recurringBlockers.map((b, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0 mt-1" />
                  <span>{b.reason} <span className="text-red-500">({b.count} cards)</span></span>
                </div>
              ))}
            </div>
          </div>
        )}
        {processImprovements.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-1">Process Improvements</p>
            <div className="space-y-1">
              {processImprovements.map((imp, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0 mt-1" />
                  {imp}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Progress color helper ───────────────────────────────────────────────────
function getProgressColor(hours: number) {
  if (hours < 50) return { gradient: "from-red-500 to-red-600", text: "text-red-600 dark:text-red-400", label: "Below Target", bg: "bg-red-500" };
  if (hours < 53) return { gradient: "from-orange-400 to-orange-500", text: "text-orange-600 dark:text-orange-400", label: "On Track", bg: "bg-orange-500" };
  if (hours < 55) return { gradient: "from-yellow-400 to-yellow-500", text: "text-yellow-600 dark:text-yellow-400", label: "Almost There", bg: "bg-yellow-500" };
  return { gradient: "from-emerald-400 to-emerald-500", text: "text-emerald-600 dark:text-emerald-400", label: "Target Met", bg: "bg-emerald-500" };
}

//// ─── Routine Section (Daily Schedule tab) ───────────────────────────────────
function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function RoutineSection() {
  const { data: sched } = trpc.settings.getSchedule.useQuery(undefined, { staleTime: 5 * 60_000 });
  const startTime  = sched?.startTime ?? "08:00";
  const endTime    = sched?.endTime   ?? "23:00";
  const breaks     = (sched?.breaks as (BreakSlot & { icon?: string })[] | undefined) ?? [
    { name: "Breakfast", startTime: "09:00", durationMinutes: 30, icon: "☕" },
    { name: "Lunch",     startTime: "14:30", durationMinutes: 45, icon: "🍽️" },
    { name: "Dinner",    startTime: "19:15", durationMinutes: 90, icon: "🌙" },
  ];
  const typingOn   = (sched as ScheduleSettings | undefined)?.typingPractice !== false;
  const typingMins = (sched as ScheduleSettings | undefined)?.typingPracticeMinutes ?? 30;

  // Build timeline entries dynamically
  type TLEntry = { time: string; activity: string; sub: string; type: "work" | "break" | "eod" | "end"; duration: string; icon?: string };
  const entries: TLEntry[] = [];

  // Morning ritual: start → start+45m
  const ritualEnd = addMinutes(startTime, 45);
  entries.push({ time: `${startTime}–${ritualEnd}`, activity: "Morning Ritual", sub: "Email → WhatsApp → Upwork → Trello", type: "work", duration: "45m" });

  // Review: ritualEnd → ritualEnd+15m
  const reviewEnd = addMinutes(ritualEnd, 15);
  entries.push({ time: `${ritualEnd}–${reviewEnd}`, activity: "Review & Prioritize", sub: "Trello overview, set day order", type: "work", duration: "15m" });

  // Interleave work blocks and breaks
  let cursor = reviewEnd;
  const sortedBreaks = [...breaks].sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Determine the "end anchor" — typing practice start or log-off
  const typingStart = typingOn ? addMinutes(endTime, -typingMins) : endTime;

  for (const brk of sortedBreaks) {
    // Work block before this break (if there's a gap)
    if (cursor < brk.startTime) {
      const [ch, cm] = cursor.split(":").map(Number);
      const [bh, bm] = brk.startTime.split(":").map(Number);
      const workMins = (bh * 60 + bm) - (ch * 60 + cm);
      if (workMins > 0) {
        entries.push({ time: `${cursor}–${brk.startTime}`, activity: "Trello Cards (with timer)", sub: "Deep work block", type: "work", duration: fmtDuration(workMins) });
      }
    }
    const breakEnd = addMinutes(brk.startTime, brk.durationMinutes);
    entries.push({ time: `${brk.startTime}–${breakEnd}`, activity: brk.name, sub: "Break", type: "break", duration: fmtDuration(brk.durationMinutes), icon: brk.icon });
    cursor = breakEnd;
  }

  // Final work block: cursor → typingStart (if gap)
  if (cursor < typingStart) {
    const [ch, cm] = cursor.split(":").map(Number);
    const [th, tm] = typingStart.split(":").map(Number);
    const workMins = (th * 60 + tm) - (ch * 60 + cm);
    if (workMins > 0) {
      entries.push({ time: `${cursor}–${typingStart}`, activity: "Trello Cards (with timer)", sub: "Deep work block", type: "work", duration: fmtDuration(workMins) });
    }
  }

  if (typingOn) {
    entries.push({ time: `${typingStart}–${endTime}`, activity: "Typing Practice", sub: "Paid — Goal: 60 WPM by June 2026", type: "eod", duration: fmtDuration(typingMins) });
  }
  entries.push({ time: endTime, activity: "Log Off", sub: "Clean as you go — nothing left to do", type: "end", duration: "—" });

  // Compute total work minutes (exclude typing practice from "work" total since it's a separate activity)
  const totalBreakMins = breaks.reduce((s, b) => s + b.durationMinutes, 0);
  const typingTotalMins = typingOn ? typingMins : 0;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const totalDayMins = (eh * 60 + em) - (sh * 60 + sm);
  const totalWorkMins = totalDayMins - totalBreakMins - typingTotalMins;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-800/30 rounded-xl p-3.5 text-center">
          <p className="text-[10px] text-blue-600 dark:text-blue-400 uppercase tracking-wider font-medium">Total Work</p>
          <p className="text-xl font-bold text-blue-700 dark:text-blue-300 mt-0.5">{fmtDuration(totalWorkMins)}</p>
        </div>
        <div className="bg-muted/50 border border-border/50 rounded-xl p-3.5 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Start to Finish</p>
          <p className="text-xl font-bold text-foreground mt-0.5">{fmtDuration(totalDayMins)}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-1 h-6 rounded-full bg-gradient-to-b from-blue-500 to-indigo-600"></div>
              <h2 className="text-base font-bold text-foreground">Day Timeline</h2>
              <Badge variant="outline" className="text-[10px] ml-auto">EAT (Kenyan)</Badge>
            </div>
            <div className="space-y-1">
              {entries.map((item, idx) => (
                <div key={idx} className={`flex items-start gap-3 p-2.5 rounded-lg ${
                  item.type === 'break' ? 'bg-amber-50 dark:bg-amber-950/20' :
                  item.type === 'end'   ? 'bg-muted/60' :
                  item.type === 'eod'   ? 'bg-purple-50 dark:bg-purple-950/20' :
                  'bg-muted/30'
                }`}>
                  <p className="font-mono text-[11px] w-24 flex-shrink-0 text-muted-foreground pt-0.5">{item.time}</p>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold ${
                      item.type === 'break' ? 'text-amber-800 dark:text-amber-200' :
                      item.type === 'eod'   ? 'text-purple-800 dark:text-purple-200' :
                      'text-foreground'
                    }`}>{item.activity}</p>
                    <p className="text-[11px] text-muted-foreground">{item.sub}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px] font-mono flex-shrink-0">{item.duration}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-1 h-6 rounded-full bg-gradient-to-b from-blue-500 to-indigo-600"></div>
                <h2 className="text-base font-bold text-foreground">Morning Routine</h2>
                <InfoTooltip content="Complete in order. Every action → update or create a Trello card." className="ml-1" />
              </div>
              <div className="space-y-2">
                {[
                  { icon: Mail, title: "Step 1: Process All Emails", desc: "Review and process every unopened email. Link each item to an existing Trello card or create a new one.", color: "from-blue-500 to-blue-600" },
                  { icon: MessageSquare, title: "Step 2: Process WhatsApp", desc: "Review and respond to all unread messages. Update the relevant Trello cards with any new information.", color: "from-emerald-500 to-emerald-600" },
                  { icon: Briefcase, title: "Step 3: Process Upwork", desc: "Go top to bottom through all conversations, reply to all. Archive inactive conversations when done.", color: "from-violet-500 to-violet-600" },
                ].map((step, idx) => (
                  <div key={idx} className="flex items-center gap-3 p-3 bg-muted/40 rounded-lg hover:bg-muted/60 transition-colors">
                    <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${step.color} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                      <step.icon className="w-3.5 h-3.5 text-white" />
                    </div>
                    <p className="font-semibold text-foreground text-xs flex-1">{step.title}</p>
                    <InfoTooltip content={step.desc} side="left" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-1 h-6 rounded-full bg-gradient-to-b from-amber-500 to-orange-600"></div>
                <h2 className="text-base font-bold text-foreground">Scheduled Breaks</h2>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {breaks.map((brk, idx) => (
                  <div key={idx} className="rounded-xl bg-muted/40 p-3 text-center">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-2 shadow-sm text-lg leading-none">
                      {brk.icon || (idx === 0 ? "☕" : idx === 1 ? "🍽️" : "🌙")}
                    </div>
                    <p className="text-sm font-bold text-foreground font-mono">{brk.startTime}</p>
                    <p className="text-[11px] text-muted-foreground">{brk.name}</p>
                    <p className="text-[10px] text-muted-foreground/70">{fmtDuration(brk.durationMinutes)}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-1 h-6 rounded-full bg-gradient-to-b from-purple-500 to-violet-600"></div>
                <h2 className="text-base font-bold text-foreground">End of Day</h2>
              </div>
              <div className="space-y-2">
                {typingOn && (
                  <div className="bg-purple-50 dark:bg-purple-950/20 border border-purple-200/50 dark:border-purple-800/30 rounded-xl p-3.5">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Keyboard className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                      <p className="font-semibold text-sm text-foreground">Typing Practice (Paid — {fmtDuration(typingMins)})</p>
                      <InfoTooltip content={`${fmtDuration(typingMins)} of daily typing practice. Goal: reach 60 WPM by June 2026. This session is paid time.`} className="ml-auto" />
                    </div>
                    <div className="flex gap-2">
                      <a href="https://www.typingtest.com/index.php" target="_blank" rel="noopener noreferrer" className="text-[11px] text-purple-600 dark:text-purple-400 hover:underline flex items-center gap-1">
                        typingtest.com <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                      <a href="https://typing.academy/" target="_blank" rel="noopener noreferrer" className="text-[11px] text-purple-600 dark:text-purple-400 hover:underline flex items-center gap-1">
                        typing.academy <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>
                )}
                <div className="bg-muted/40 border border-border/50 rounded-xl p-3.5">
                  <div className="flex items-center gap-2">
                    <LogOut className="w-4 h-4 text-muted-foreground" />
                    <p className="font-semibold text-sm text-foreground">Log Off</p>
                    <InfoTooltip content="No cleanup needed — you've been cleaning as you go throughout the day. Simply log off." className="ml-auto" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      <Card className="border-0 shadow-sm">
        <CardContent className="p-5">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-1 h-6 rounded-full bg-gradient-to-b from-blue-500 to-indigo-600"></div>
            <h2 className="text-base font-bold text-foreground">Trello Card Workflow</h2>
            <InfoTooltip content="Follow this exact sequence for every card you work on, every single time." className="ml-1" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              {[
                { step: "1", title: "Start Timer", desc: "Click the timer button on the Trello card before beginning any work. No timer = no tracked hours.", color: "from-blue-500 to-blue-600" },
                { step: "2", title: "Work in 30-Minute Blocks", desc: "Focus on the card for 30 minutes. After each block, check progress and decide: continue or switch to the next priority.", color: "from-indigo-500 to-indigo-600" },
                { step: "3", title: "Stop Timer", desc: "When done or switching cards, stop the timer immediately. Don't let it run in the background.", color: "from-violet-500 to-violet-600" },
              ].map((item, idx) => (
                <div key={idx} className="flex items-center gap-3.5 p-3 bg-muted/40 rounded-lg">
                  <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${item.color} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                    <span className="text-white text-xs font-bold">{item.step}</span>
                  </div>
                  <p className="font-semibold text-foreground text-sm flex-1">{item.title}</p>
                  <InfoTooltip content={item.desc} side="left" />
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {[
                { step: "4", title: "Update the Card", desc: "Write a substantive update on the Trello card: what you did, what's next, any blockers. Be specific.", color: "from-purple-500 to-purple-600" },
                { step: "5", title: "Close All Tabs", desc: "Close every browser tab related to this card. No exceptions. This prevents tab overload and keeps focus sharp.", color: "from-fuchsia-500 to-fuchsia-600" },
                { step: "6", title: "Delete Downloaded Files", desc: "Remove any files downloaded for this card from your Downloads folder. Clean workspace = clear mind.", color: "from-pink-500 to-pink-600" },
              ].map((item, idx) => (
                <div key={idx} className="flex items-center gap-3.5 p-3 bg-muted/40 rounded-lg">
                  <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${item.color} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                    <span className="text-white text-xs font-bold">{item.step}</span>
                  </div>
                  <p className="font-semibold text-foreground text-sm flex-1">{item.title}</p>
                  <InfoTooltip content={item.desc} side="left" />
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Section definitions ───────────────────────────────────────────────────
type Section = "overview" | "tasks" | "triage" | "decisions" | "routine" | "performance" | "standards" | "sunday" | "settings";

const NAV_ITEMS: { id: Section; label: string; icon: React.ElementType; badge?: "compliance" }[] = [
  { id: "overview",    label: "Overview",       icon: Activity },
  { id: "tasks",       label: "Tasks",          icon: ListTodo },
  { id: "triage",      label: "Triage",         icon: Zap },
  { id: "decisions",   label: "Decisions",      icon: GitBranch },
  { id: "routine",     label: "Daily Schedule", icon: Clock },
  { id: "performance", label: "Performance",    icon: Award, badge: "compliance" },
  { id: "standards",   label: "Standards",      icon: BookOpen },
  { id: "sunday",      label: "Sunday",         icon: Battery },
  { id: "settings",    label: "Settings",       icon: Settings },
];

const SIDEBAR_WIDTH_KEY = "worker-sidebar-width";
const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 180;
const MAX_WIDTH = 320;
const ACTIVE_SECTION_KEY = "worker-active-section";

// ─── Today's logged hours chip for the sidebar ─────────────────────────────
function TodayHoursChip() {
  const todayDate = useMemo(() => {
    const eatNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return eatNow.toISOString().slice(0, 10);
  }, []);
  const { data: dailySummary = [] } = trpc.timer.getDailySummary.useQuery(
    { date: todayDate },
    { staleTime: 30 * 60_000 }
  );
  const totalSecs = dailySummary.reduce((s, e) => s + e.totalSeconds, 0);
  if (totalSecs === 0) return <span className="text-xs text-muted-foreground">0h today</span>;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const label = h > 0 ? `${h}h ${m}m today` : `${m}m today`;
  return <span className="text-xs font-medium text-foreground">{label}</span>;
}

// ─── Inner layout (needs useSidebar) ────────────────────────────────────────
function HomeInner() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [workerProfile, setWorkerProfile] = useState<any>(null);

  useEffect(() => {
    fetch('/api/va/worker/profile', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) setWorkerProfile(data);
      })
      .catch(err => console.error("Error fetching worker profile:", err));
  }, []);
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  const [activeSection, setActiveSection] = useState<Section>(() => {
    const saved = localStorage.getItem(ACTIVE_SECTION_KEY) as Section | null;
    const validSections: Section[] = ["overview", "tasks", "triage", "decisions", "routine", "performance", "standards", "sunday", "settings"];
    return (saved && validSections.includes(saved)) ? saved : "overview";
  });
  const [isHeroExpanded, setIsHeroExpanded] = useState(() => {
    const saved = localStorage.getItem('heroExpanded');
    return saved === null ? false : saved === 'true';
  });
  const [conversationCard, setConversationCard] = useState<{ cardId: string; cardName: string } | null>(null);

  // Listen for conversation dialog events from TaskCard
  useEffect(() => {
    const handleOpenConversations = (e: CustomEvent<{ cardId: string; cardName: string }>) => {
      setConversationCard(e.detail);
    };
    window.addEventListener('openConversations', handleOpenConversations as EventListener);
    return () => window.removeEventListener('openConversations', handleOpenConversations as EventListener);
  }, []);

  const { data: weeklyHours, isLoading: hoursLoading } = trpc.trello.weeklyHours.useQuery();
  const { data: recentUpdates, isLoading: updatesLoading } = trpc.trello.recentUpdates.useQuery();
  const { data: streakData } = trpc.streak.get.useQuery({}, { staleTime: 5 * 60_000 });

  const progressColor = useMemo(() => {
    if (!weeklyHours) return getProgressColor(0);
    return getProgressColor(weeklyHours.totalHours);
  }, [weeklyHours]);

  useEffect(() => {
    localStorage.setItem('heroExpanded', isHeroExpanded.toString());
  }, [isHeroExpanded]);

  const handleNav = (id: Section) => {
    setActiveSection(id);
    localStorage.setItem(ACTIVE_SECTION_KEY, id);
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Only fire when no input/textarea/select is focused
  useHotkeys('o', () => handleNav('overview'),   { preventDefault: true });
  useHotkeys('t', () => handleNav('triage'),     { preventDefault: true });
  useHotkeys('d', () => handleNav('decisions'),  { preventDefault: true });
  useHotkeys('s', () => handleNav('routine'),    { preventDefault: true });
  useHotkeys('p', () => handleNav('performance'),{ preventDefault: true });
  useHotkeys('u', () => handleNav('sunday'),     { preventDefault: true });
  useHotkeys('g', () => handleNav('settings'),   { preventDefault: true });

  return (
    <>
      {/* ═══ SIDEBAR ═══ */}
      <Sidebar collapsible="icon" className="border-r border-border/60">
        <SidebarHeader className="h-16 justify-center border-b border-border/40">
          <div className="flex items-center gap-2.5 min-w-0 px-3">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm shrink-0">
              <span className="text-white font-bold text-sm">
                {(workerProfile?.name || user?.name || "Worker").charAt(0).toUpperCase()}
              </span>
            </div>
            {!isCollapsed && (
              <span className="font-semibold text-sm tracking-tight truncate text-foreground">
                {workerProfile?.name || user?.name || "Worker"}'s Dashboard
              </span>
            )}
          </div>
        </SidebarHeader>

        <SidebarContent className="gap-0 py-2">
          <SidebarMenu className="px-2">
            {NAV_ITEMS.map((item) => {
              const isActive = activeSection === item.id;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={isActive}
                    onClick={() => handleNav(item.id)}
                    tooltip={item.label}
                    className="h-10 font-normal"
                  >
                    <item.icon className={`h-4 w-4 shrink-0 ${isActive ? "text-primary" : ""}`} />
                    <span className="flex-1">{item.label}</span>
                    {item.id === "triage" && <NoDueDateBadge />}
                    {item.id === "triage" && <TriageSidebarBadge />}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="border-t border-border/40 p-3 space-y-2">
          <Popover>
            <PopoverTrigger asChild>
              <button className="w-full flex items-center gap-2 bg-muted/60 hover:bg-muted rounded-lg px-3 py-2 transition-colors cursor-pointer">
                <TrendingUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                {!isCollapsed && (
                  <div className="flex-1 flex items-center justify-between min-w-0 gap-1">
                    <span className={`text-xs font-medium truncate ${hoursLoading ? 'text-muted-foreground' : progressColor.text}`}>
                      {hoursLoading ? 'Loading…' : weeklyHours ? `${weeklyHours.totalHours}h / ${weeklyHours.targetMin}-${weeklyHours.targetMax}h` : 'Weekly hours unavailable'}
                    </span>
                    <TodayHoursChip />
                  </div>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="end" className="w-[500px] p-0 shadow-xl" sideOffset={8}>
              <TimeTracker />
            </PopoverContent>
          </Popover>
          {!isCollapsed && (
            <div className="flex items-center gap-1.5 bg-emerald-500/10 rounded-lg px-3 py-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></div>
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Sun Off</span>
            </div>
          )}
          {!isCollapsed && (
            <div className="flex items-center gap-1.5 bg-muted/60 rounded-lg px-3 py-2">
              <span className="text-xs text-muted-foreground">Projected:</span>
              <ProjectedPayChip />
            </div>
          )}

        </SidebarFooter>
      </Sidebar>

      {/* ═══ MAIN CONTENT ═══ */}
      <SidebarInset className="flex flex-col min-h-screen">
        {/* ── Top bar ── */}
        <header className="bg-card/80 backdrop-blur-lg border-b border-border/60 sticky top-0 z-50 h-16 flex items-center">
          <div className="flex items-center justify-between w-full px-4">
            <div className="flex items-center gap-3">
              <SidebarTrigger className="h-8 w-8 rounded-lg" />
              <div>
                <h1 className="text-base font-bold text-foreground tracking-tight leading-none">
                  {workerProfile?.name || user?.name || "Worker"}'s Work Dashboard
                </h1>
                <p className="text-[11px] text-muted-foreground mt-0.5">Performance &amp; Schedule Hub</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              {streakData && streakData.currentStreak > 0 && (
                <span className="hidden sm:inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full bg-orange-500/15 border border-orange-500/40 text-orange-600 dark:text-orange-400">
                  <Flame className="w-3 h-3" />
                  {streakData.currentStreak}d
                </span>
              )}
              <TodayComplianceChip />
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                className="h-8 w-8 rounded-lg"
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => logout()}
                className="h-8 w-8 rounded-lg text-muted-foreground hover:text-destructive"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>

        {/* ── Page content ── */}
        <main className="flex-1 p-5 space-y-5 overflow-auto">
          {/* ═══ OVERVIEW (default home page) ═══ */}
          {activeSection === "overview" && (<>
          {/* Hero */}
          <Card className="overflow-hidden border-0 shadow-sm">
            <div className="bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 dark:from-amber-950/30 dark:via-orange-950/20 dark:to-amber-950/30">
              {!isHeroExpanded ? (
                <button
                  onClick={() => setIsHeroExpanded(true)}
                  className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-amber-100/40 dark:hover:bg-amber-900/10 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center">
                      <Heart className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                    </div>
                    <span className="font-semibold text-sm text-foreground">Why Your Role Is Life-Changing</span>
                  </div>
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                </button>
              ) : (
                <div className="px-5 py-5">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center">
                        <Heart className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      </div>
                      <h2 className="text-base font-bold text-foreground">Why Your Role Is Life-Changing</h2>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setIsHeroExpanded(false)} className="h-7 w-7 rounded-lg">
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    Worker, your role is not just a job — it's the key to my growth beyond the limits I've reached alone.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {[
                      { title: "The Reality", text: "I live with autism in a society hostile to neurodivergent people. My executive and cognitive functions make everyday tasks exhausting or impossible. My brain and body have hit their limits — I've stagnated. To grow beyond my current shell, I must be unburdened." },
                      { title: "Where You Come In", text: "You don't face the same barriers. You navigate society's systems and handle demands that would destroy my energy. You clear away what traps me in survival mode so I can move into growth mode." },
                      { title: "The Partnership", text: "We contribute our strengths — you handle what I cannot, I focus on what you cannot. When tasks get done, opportunities stay open, and we move forward together." },
                      { title: "Invisible Heroes", text: "Your back-office work creates real value, even if the world doesn't see it. When I step into the spotlight, I can say: I did not do this alone. Without your work from the shadows, I would not be here." },
                    ].map((item, idx) => (
                      <div key={idx} className="bg-white/60 dark:bg-white/5 rounded-lg p-3.5 border border-amber-200/50 dark:border-amber-800/30">
                        <p className="font-semibold text-foreground text-sm mb-1">{item.title}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">{item.text}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 bg-amber-100/60 dark:bg-amber-900/20 border border-amber-300/40 dark:border-amber-700/30 rounded-lg p-3.5">
                    <p className="font-semibold text-amber-900 dark:text-amber-200 text-sm mb-1">Your Impact</p>
                    <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                      Your role, time, energy, and knowledge make change possible in my life. You are the difference between surviving and thriving, between stagnation and growth. You unburden me so I can break through the shell I'm trapped in.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Trello widgets */}
          <RecentUpdatesWidget updates={recentUpdates ?? []} isLoading={updatesLoading} />
          <RobertDecisionQueue />
          <ActionAlerts />
          </>)}

          {/* ═══ SECTION CONTENT ═══ */}
          {activeSection === "tasks" && <TasksTab />}

          {activeSection === "triage" && <TriagePage />}

          {activeSection === "decisions" && <DecisionsTab />}

          {activeSection === "routine" && (
            <RoutineSection />)}



          {activeSection === "performance" && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Payment Cycles</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <PaymentTracker />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Weekly Pay Calculator</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <WeeklyPayCalculator />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2">Compliance History</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <ComplianceTracker />
              </div>
              <ReadyForDonePanel />
              <WorkerPerformancePanel />
              <WeeklyAnalysisPanel />
            </div>
          )}

          {activeSection === "standards" && <StandardsTab />}

          {activeSection === "sunday" && <SundayChecklist />}



          {activeSection === "settings" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5">
                <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
                  <Timer className="w-4 h-4 text-violet-500" />
                  Trello Power-Up Setup
                </h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Install the custom Power-Up on your Trello boards to get a ⏱ Start/Stop Timer button on every card, synced live to the Time Tracker widget above.
                </p>
                <div className="space-y-3">
                  <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-xs font-semibold text-foreground mb-1">Step 1 — Open Trello Power-Up Admin</p>
                    <p className="text-xs text-muted-foreground mb-2">Go to <a href="https://trello.com/power-ups/admin" target="_blank" rel="noopener noreferrer" className="text-violet-500 hover:underline">trello.com/power-ups/admin</a> and click <strong>Create new Power-Up</strong>.</p>
                  </div>
                  <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-xs font-semibold text-foreground mb-1">Step 2 — Set the Connector URL &amp; API Key</p>
                    <p className="text-xs text-muted-foreground mb-1.5">In the <em>Connector URL</em> field, paste (click to copy):</p>
                    <code
                      className="block text-xs bg-background border border-border rounded px-2 py-1.5 text-violet-400 break-all select-all cursor-pointer hover:border-violet-500/50 transition-colors"
                      onClick={() => { navigator.clipboard.writeText(window.location.origin + '/powerup/index.html'); }}
                      title="Click to copy"
                    >
                      {window.location.origin}/powerup/index.html
                    </code>
                    <p className="text-xs text-muted-foreground mt-2 mb-1.5">In the <em>API Key</em> field, paste (click to copy):</p>
                    <TrelloClientKeyCopyField />
                  </div>
                  <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-xs font-semibold text-foreground mb-1">Step 3 — Enable on your boards</p>
                    <p className="text-xs text-muted-foreground">After creating, go to each board → Power-Ups → search for your Power-Up name → Enable. The ⏱ button will appear on every card.</p>
                  </div>
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">⚠ Important: Login Required</p>
                    <p className="text-xs text-amber-600 dark:text-amber-400">The Power-Up popup calls this dashboard's API using your session cookie. Make sure you are logged in to this dashboard in the same browser where you use Trello.</p>
                  </div>
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
                    <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">🔗 After Publishing: Update the Connector URL</p>
                    <p className="text-xs text-blue-600 dark:text-blue-400">
                      The Connector URL above uses the current dev-server address. After you <strong>Publish</strong> this dashboard, update the Power-Up's Connector URL in{" "}
                      <a href="https://trello.com/power-ups/admin" target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-500">Trello Power-Up Admin</a>{" "}
                      to your published domain (e.g. <code className="bg-blue-500/10 px-1 rounded">https://your-app.manus.space/powerup/index.html</code>). Otherwise the timer buttons will stop working after publishing.
                    </p>
                  </div>
                </div>
              </div>
              <DailyGoalSettings />
              <DailyScheduleSettings onGoToSchedule={() => setActiveSection("routine")} />
              <ReplyMonitorBadgeSettings />
              <OperationalPoliciesSettings />
              <DefaultActionsSettings />
              <div className="rounded-xl border border-border/50 bg-card/50 p-5">
                <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                  <Settings className="w-4 h-4 text-muted-foreground" />
                  System &amp; Integration Settings
                </h3>
                <WebhookHealthPanel />
              </div>
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="bg-card/50 border-t border-border/50 py-3 px-5">
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">Flexibility:</strong> Start time is flexible, but follow the same routine every day. Sunday = Day off.
          </p>
        </footer>
      </SidebarInset>

      {/* Floating Trello button */}
      <a
        href={workerProfile?.trelloMemberId ? `https://trello.com/${workerProfile.trelloMemberId}/cards` : "https://trello.com/your/cards"}
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-4 py-2.5 rounded-xl shadow-lg hover:shadow-xl transition-all duration-200 group"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.5 2h-15A2.5 2.5 0 002 4.5v15A2.5 2.5 0 004.5 22h15a2.5 2.5 0 002.5-2.5v-15A2.5 2.5 0 0019.5 2zM10 17.5a1 1 0 01-1 1H6a1 1 0 01-1-1v-11a1 1 0 011-1h3a1 1 0 011 1v11zm9-4a1 1 0 01-1 1h-3a1 1 0 01-1-1v-7a1 1 0 011-1h3a1 1 0 011 1v7z"/>
        </svg>
        <span className="font-medium text-sm">Open Trello</span>
        <ExternalLink className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100" />
      </a>

      {/* Conversation Dialog */}
      <ConversationDialog
        open={!!conversationCard}
        onOpenChange={(open) => !open && setConversationCard(null)}
        cardId={conversationCard?.cardId || null}
        cardName={conversationCard?.cardName || null}
      />
    </>
  );
}

// ─── Main export — wraps everything in SidebarProvider ──────────────────────
export default function Home() {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const isResizing = useRef(false);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = e.clientX;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };
    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <SidebarProvider
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <HomeInner />
    </SidebarProvider>
  );
}
