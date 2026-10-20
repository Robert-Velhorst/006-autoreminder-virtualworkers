/**
 * ActionAlerts — Live Trello-synced daily action reminders for the active worker.
 *
 * Three actionable panels only:
 *   1. Overdue Cards          — cards past their due date
 *   2. DOING Updates          — DOING cards that need a comment today
 *   3. ON-HOLD Review         — ON-HOLD cards to review daily
 *
 * Due-date status and "no due date" are shown as inline badges on each card row.
 * All cards are always fully visible — no hidden items, no scroll caps.
 *
 * Priority hero: the panel with the most urgent pending items is highlighted.
 * Priority order: Overdue > DOING pending > ON-HOLD pending
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  MessageSquarePlus,
  PauseCircle,
  Flame,
  Building2,
  CalendarClock,
  Send,
  X,
  CalendarCheck,
  CalendarX,
  Search,
  BellOff,
  BellRing,
  CheckSquare,
  Wrench,
  ArrowRight,
  Lightbulb,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDueBadge(due: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!due) return { label: "No due date", className: "text-amber-600 dark:text-amber-400 font-medium" };
  const now = Date.now();
  const dueMs = new Date(due).getTime();
  const diffDays = (dueMs - now) / (1000 * 60 * 60 * 24);
  if (diffDays < 0)
    return { label: "Overdue", className: "text-red-600 dark:text-red-400 font-semibold" };
  if (diffDays < 1)
    return { label: "Due today", className: "text-orange-600 dark:text-orange-400 font-semibold" };
  if (diffDays < 3)
    return { label: `Due in ${Math.ceil(diffDays)}d`, className: "text-yellow-600 dark:text-yellow-400" };
  return {
    label: `Due ${new Date(due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    className: "text-muted-foreground",
  };
}

function getCardAgeBadge(dateLastActivity: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!dateLastActivity) return { label: "", className: "" };
  const days = Math.floor((Date.now() - new Date(dateLastActivity).getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return { label: "Active today", className: "text-emerald-600 dark:text-emerald-400" };
  if (days === 1) return { label: "1d idle", className: "text-yellow-600 dark:text-yellow-400" };
  if (days <= 3) return { label: `${days}d idle`, className: "text-yellow-600 dark:text-yellow-400" };
  if (days <= 7) return { label: `${days}d idle`, className: "text-orange-600 dark:text-orange-400" };
  return { label: `${days}d idle`, className: "text-red-600 dark:text-red-400 font-semibold" };
}

function getTodayEAT(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function minutesUntilDeadline(): number {
  const eatNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const deadline = new Date(eatNow);
  deadline.setHours(23, 0, 0, 0);
  return Math.max(0, Math.floor((deadline.getTime() - eatNow.getTime()) / 60000));
}

function DeadlineCountdown({ allDone }: { allDone: boolean }) {
  const [mins, setMins] = useState(minutesUntilDeadline);
  useEffect(() => {
    const id = setInterval(() => setMins(minutesUntilDeadline()), 60_000);
    return () => clearInterval(id);
  }, []);
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  const urgent = mins < 120;
  if (allDone) return null;
  return (
    <span
      className={`text-xs font-medium tabular-nums px-2 py-0.5 rounded-full border ${
        urgent
          ? "text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10"
          : "text-muted-foreground border-border"
      }`}
    >
      <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />
      {hours > 0 ? `${hours}h ${rem}m` : `${rem}m`} left
    </span>
  );
}

function StreakBadge({ streak }: { streak: number }) {
  if (streak === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-500/15 border border-orange-500/40 text-orange-600 dark:text-orange-400">
      <Flame className="w-3 h-3" />
      {streak} day{streak !== 1 ? "s" : ""}
    </span>
  );
}

function SyncDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex h-2 w-2 flex-shrink-0">
      {active && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      )}
      <span
        className={`relative inline-flex rounded-full h-2 w-2 ${
          active ? "bg-emerald-500" : "bg-muted-foreground/30"
        }`}
      />
    </span>
  );
}

// ── Quick Comment box ────────────────────────────────────────────────────────

function QuickComment({
  cardId,
  onSuccess,
  onClose,
}: {
  cardId: string;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const utils = trpc.useUtils();
  const postComment = trpc.trello.postComment.useMutation({
    onSuccess: () => {
      toast.success("Comment posted to Trello");
      setText("");
      onSuccess();
      // Invalidate actionAlerts so the card flips to "updated today"
      utils.trello.actionAlerts.invalidate();
    },
    onError: (err) => {
      toast.error("Failed to post comment", { description: err.message });
    },
  });

  const { user } = useAuth();
  const workerName = user?.name || "Worker";
  const firstWord = workerName.split(" ")[0].toLowerCase();

  const cleanPattern = (str: string) => str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const namePattern = [
    cleanPattern(firstWord),
    cleanPattern(workerName.toLowerCase()),
  ].filter(Boolean).join("|");
  const SIGNATURE_RE = new RegExp(`~\\s*(${namePattern})\\s*$`, 'i');
  const hasSignature = SIGNATURE_RE.test(text.trim());

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!hasSignature) {
      toast.error("Signature required", {
        description: `End your comment with "~ ${workerName}" or "~ ${firstWord}" before posting.`,
      });
      return;
    }
    postComment.mutate({ cardId, text: trimmed });
  };

  return (
    <div className="mt-1 mb-1.5 ml-6 rounded-lg border border-blue-500/30 bg-blue-500/5 p-2.5 space-y-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type your daily update…"
        className="text-xs min-h-[60px] resize-none bg-background/60 border-border/60 focus:border-blue-500/60"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit();
          if (e.key === "Escape") onClose();
        }}
        autoFocus
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">Ctrl+Enter to send · Esc to cancel</span>
          {text.trim().length > 0 && !hasSignature && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30">
              Missing signature — end with "~ {workerName}"
            </span>
          )}
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
            Posts through the configured dashboard integration
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!text.trim() || postComment.isPending}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-3 h-3" />
            {postComment.isPending ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── APTLSS Urgency Chip ─────────────────────────────────────────────────────

function UrgencyChip({ tier, progressPct, remainingMinutes }: { tier?: string; progressPct?: number; remainingMinutes?: number }) {
  if (!tier) return null;
  const configs: Record<string, { bg: string; text: string; label: string }> = {
    CRITICAL: { bg: 'bg-red-500/15 border-red-500/40', text: 'text-red-600 dark:text-red-400', label: 'CRITICAL' },
    HIGH:     { bg: 'bg-orange-500/15 border-orange-500/40', text: 'text-orange-600 dark:text-orange-400', label: 'HIGH' },
    MEDIUM:   { bg: 'bg-amber-500/15 border-amber-500/40', text: 'text-amber-600 dark:text-amber-400', label: 'MED' },
    LOW:      { bg: 'bg-slate-500/15 border-slate-500/40', text: 'text-slate-500 dark:text-slate-400', label: 'LOW' },
    BLOCKED:  { bg: 'bg-purple-500/15 border-purple-500/40', text: 'text-purple-600 dark:text-purple-400', label: 'BLOCKED' },
  };
  const cfg = configs[tier] ?? configs.MEDIUM;
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
      {progressPct !== undefined && progressPct > 0 && (
        <span className="opacity-70">·{progressPct}%</span>
      )}
      {remainingMinutes !== undefined && remainingMinutes > 0 && (
        <span className="opacity-70">·{remainingMinutes}m</span>
      )}
    </span>
  );
}

// ── Card row ─────────────────────────────────────────────────────────────────

function CardRow({
  href,
  name,
  boardName,
  listName,
  dueBadge,
  extraBadge,
  icon,
  strikethrough,
  dimmed,
  leftSlot,
  urgencyTier,
  progressPct,
  remainingMinutes,
}: {
  href: string;
  name: string;
  boardName?: string;
  listName?: string;
  dueBadge?: { label: string; className: string };
  extraBadge?: { label: string; className: string };
  icon: React.ReactNode;
  strikethrough?: boolean;
  dimmed?: boolean;
  leftSlot?: React.ReactNode;
  urgencyTier?: string;
  progressPct?: number;
  remainingMinutes?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      {leftSlot}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center gap-2 flex-1 px-3 py-2.5 rounded-lg border transition-colors group ${
          dimmed
            ? "bg-muted/10 border-border/20 opacity-55 hover:opacity-80"
            : "bg-muted/20 border-border/40 hover:bg-muted/40 hover:border-border/70"
        }`}
      >
        <span className="flex-shrink-0">{icon}</span>
        <span
          className={`text-xs flex-1 truncate ${
            strikethrough ? "line-through text-muted-foreground" : "text-foreground"
          }`}
        >
          {name}
        </span>
        {/* Board › List chip */}
        {(boardName || listName) && (
          <span className="text-[9px] text-muted-foreground/60 flex-shrink-0 bg-muted/50 px-1.5 py-0.5 rounded flex items-center gap-0.5 max-w-[100px] truncate">
            <Building2 className="w-2 h-2 flex-shrink-0" />
            <span className="truncate">{boardName}{listName ? ` › ${listName}` : ""}</span>
          </span>
        )}
        {/* Extra badge (age, overdue days, etc.) */}
        {extraBadge && extraBadge.label && (
          <span className={`text-[10px] flex-shrink-0 ${extraBadge.className}`}>
            {extraBadge.label}
          </span>
        )}
        {/* Due date badge */}
        {dueBadge && (
          <span className={`text-[10px] flex-shrink-0 flex items-center gap-0.5 ${dueBadge.className}`}>
            {!dueBadge.label.includes("Due") && dueBadge.label === "No due date" && (
              <CalendarClock className="w-2.5 h-2.5" />
            )}
            {dueBadge.label}
          </span>
        )}
        {urgencyTier && (
          <UrgencyChip tier={urgencyTier} progressPct={progressPct} remainingMinutes={remainingMinutes} />
        )}
        <ExternalLink className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary flex-shrink-0 transition-colors" />
      </a>
    </div>
  );
}

// ── ScrollList: shows up to 5 items, scrollable if more, with ↓ X more indicator ──

const ITEM_HEIGHT_PX = 44; // approximate height of one CardRow
const VISIBLE_ITEMS = 5;
const MAX_H = ITEM_HEIGHT_PX * VISIBLE_ITEMS; // 220px

function ScrollList({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [moreCount, setMoreCount] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const scrolled = el.scrollTop;
      const visible = el.clientHeight;
      const full = el.scrollHeight;
      const hiddenPx = full - visible - scrolled;
      const hidden = Math.max(0, Math.round(hiddenPx / ITEM_HEIGHT_PX));
      setMoreCount(hidden);
    };
    update();
    el.addEventListener("scroll", update);
    // re-check when children change
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, [children]);

  return (
    <div className="relative">
      <div
        ref={ref}
        className="overflow-y-auto space-y-1.5 pr-0.5 scrollbar-thin"
        style={{ maxHeight: `${MAX_H}px` }}
      >
        {children}
      </div>
      {moreCount > 0 && (
        <div
          className="flex items-center justify-center gap-1 pt-1 text-[10px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none"
          onClick={() => ref.current?.scrollBy({ top: MAX_H, behavior: "smooth" })}
        >
          <ChevronDown className="w-3 h-3" />
          {moreCount} more
        </div>
      )}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function ActionSection({
  icon,
  accentClass,
  bgClass,
  title,
  subtitle,
  isHero,
  badge,
  allClear,
  allClearLabel,
  extraHeaderSlot,
  storageKey,
  children,
}: {
  icon: React.ReactNode;
  accentClass: string;
  bgClass: string;
  title: string;
  subtitle: string;
  isHero: boolean;
  badge?: React.ReactNode;
  allClear: boolean;
  allClearLabel: string;
  totalCount?: number;
  extraHeaderSlot?: React.ReactNode;
  storageKey?: string;
  children?: React.ReactNode;
}) {
  const lsKey = storageKey ? `action-panel-collapsed:${storageKey}` : null;
  const [panelCollapsed, setPanelCollapsed] = useState(() => {
    if (!lsKey) return false;
    try { return localStorage.getItem(lsKey) === "1"; } catch { return false; }
  });

  const toggleCollapsed = () => {
    setPanelCollapsed((v) => {
      const next = !v;
      if (lsKey) { try { localStorage.setItem(lsKey, next ? "1" : "0"); } catch {} }
      return next;
    });
  };

  if (isHero) {
    return (
      <div className={`rounded-xl border-l-4 ${accentClass} ${bgClass} p-4 space-y-3`}>
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5">{icon}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-sm text-foreground">{title}</p>
              {badge}
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
          </div>
          {extraHeaderSlot}
          {allClear && <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />}
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex-shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
            title={panelCollapsed ? "Expand" : "Collapse"}
          >
            {panelCollapsed
              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
        </div>
        {!panelCollapsed && !allClear && <div className="space-y-1.5">{children}</div>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/40 bg-muted/10 p-3.5 space-y-2.5">
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-xs font-semibold text-foreground flex-1">{title}</p>
        {badge}
        {extraHeaderSlot}
        {allClear && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex-shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
          title={panelCollapsed ? "Expand" : "Collapse"}
        >
          {panelCollapsed
            ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
            : <ChevronUp className="w-3 h-3 text-muted-foreground" />}
        </button>
      </div>
      {!panelCollapsed && (
        allClear ? (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-emerald-500/8 border border-emerald-500/20">
            <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{allClearLabel}</span>
          </div>
        ) : (
          <>
            <p className="text-[10px] text-muted-foreground">{subtitle}</p>
            <div className="space-y-1.5">{children}</div>
          </>
        )
      )}
    </div>
  );
}

/**
 * DefaultActionBanner — shows the active default action rule for a given APTLSS card state.
 * Fetches the rule via tRPC (with 5-min stale time) and renders a small blue banner.
 * Rendered beneath each DOING card row so the active worker always knows the recommended next action.
 */
function DefaultActionBanner({ state }: { state: string }) {
  const { data } = trpc.aptlss.getDefaultActionForState.useQuery(
    { state },
    { staleTime: 5 * 60_000, enabled: !!state }
  );
  if (!data?.action) return null;
  return (
    <div className="mt-1 mb-1 ml-6 rounded-lg border border-blue-500/30 bg-blue-500/6 px-2.5 py-1.5 flex items-start gap-1.5">
      <Lightbulb className="w-3 h-3 text-blue-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 mr-1.5">
          {data.isCustom ? "Custom rule" : "Default action"}
          {" · "}
          <span className="font-normal text-blue-500/80 dark:text-blue-400/70">
            {state.replace(/_/g, " ").toLowerCase()}
          </span>
        </span>
        <span className="text-[10px] text-blue-700 dark:text-blue-300">{data.action}</span>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ActionAlerts() {
  const [collapsed, setCollapsed] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick every 30 s so the "X min ago" label stays accurate without hammering the server
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const streakRecordedRef = useRef(false);
  // Poll every 10 minutes as a safety-net fallback for missed webhook events.
  // The SSE channel (EventSource below) handles instant invalidation when Trello webhooks fire,
  // so the vast majority of updates arrive via push -- polling is only a backstop.
  const BASE_POLL_MS = 10 * 60_000;
  const [backoffMs, setBackoffMs] = useState(BASE_POLL_MS);
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track which DOING card has its quick-comment box open (one at a time)
  const [openCommentCardId, setOpenCommentCardId] = useState<string | null>(null);
  const [cardSearch, setCardSearch] = useState("");
  // Snooze state
  const [snoozePickerCardId, setSnoozePickerCardId] = useState<string | null>(null);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [snoozeNote, setSnoozeNote] = useState("");

  const { data, isLoading, error, refetch, isFetching } =
    trpc.trello.actionAlerts.useQuery(undefined, {
      refetchInterval: backoffMs,
      // 2-minute stale time: data is considered fresh for 2 min after the last fetch.
      staleTime: 2 * 60_000,
      retry: false,
    });

  useEffect(() => {
    if (!error) {
      if (data?.available !== false && data && backoffMs !== BASE_POLL_MS) {
        if (backoffTimerRef.current) clearTimeout(backoffTimerRef.current);
        setBackoffMs(BASE_POLL_MS);
      }
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("RATE_LIMIT") || msg.includes("429")) {
      setBackoffMs((prev) => {
        const next = Math.min(prev * 2, 10 * 60_000); // cap at 10 min
        if (backoffTimerRef.current) clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = setTimeout(() => setBackoffMs(BASE_POLL_MS), next * 3);
        return next;
      });
    }
  }, [error, data, backoffMs]);

  useEffect(() => {
    if (data?.available !== false && data && !isFetching) setLastSynced(new Date());
  }, [data, isFetching]);

  const { data: streakData } = trpc.streak.get.useQuery({}, { staleTime: 5 * 60_000 });
  const todayEAT = getTodayEAT();
  // APTLSS priority scores + card states (for urgency chips on card rows)
  const { data: aptlssScores } = trpc.aptlss.getAllPriorityScores.useQuery(undefined, { staleTime: 5 * 60_000 });
  const { data: aptlssStates } = trpc.aptlss.getAllCardStates.useQuery(undefined, { staleTime: 5 * 60_000 });
  const aptlssScoreMap = useMemo(() => new Map((aptlssScores ?? []).map(s => [s.cardId, s])), [aptlssScores]);
  const aptlssStateMap = useMemo(() => new Map((aptlssStates ?? []).map(s => [s.cardId, s])), [aptlssStates]);
  // Autopilot level (for header indicator)
  const { data: policiesData } = trpc.aptlss.getPolicies.useQuery(undefined, { staleTime: 5 * 60_000 });
  const autopilotLevel = (() => {
    const p = (policiesData ?? []).find((p: { ruleKey: string }) => p.ruleKey === 'autopilot_level');
    return p ? parseInt(String(p.value ?? '0'), 10) : 0;
  })();
  // Cards needing repair (NEEDS_RESTRUCTURING state)
  const { data: repairQueueData } = trpc.aptlss.getRepairQueue.useQuery(undefined, { staleTime: 5 * 60_000 });
  const repairQueue = repairQueueData ?? [];
  // Card snooze
  const { data: snoozedIdsData, refetch: refetchSnoozes } = trpc.cardSnooze.getSnoozedIds.useQuery(undefined, { staleTime: 60_000 });
  const snoozedCardIds = useMemo(() => new Set(snoozedIdsData?.cardIds ?? []), [snoozedIdsData]);
  const snoozeCardMutation = trpc.cardSnooze.snooze.useMutation({
    onSuccess: () => {
      refetchSnoozes();
      setSnoozePickerCardId(null);
      setSnoozeDate("");
      setSnoozeNote("");
      toast.success("Card snoozed — it will resurface on the selected date.");
    },
    onError: () => toast.error("Failed to snooze card"),
  });
  const cancelSnoozeMutation = trpc.cardSnooze.cancel.useMutation({
    onSuccess: () => { refetchSnoozes(); toast.success("Snooze cancelled — card is visible again."); },
    onError: () => toast.error("Failed to cancel snooze"),
  });
  const handleSnoozeSubmit = (card: { id: string; name: string; url: string; boardName?: string; listName?: string }) => {
    if (!snoozeDate) { toast.error("Please select a date"); return; }
    snoozeCardMutation.mutate({
      cardId: card.id,
      cardName: card.name,
      cardUrl: card.url,
      snoozedUntil: new Date(snoozeDate + "T00:00:00"),
    });
  };
  const { data: onHoldChecksData, refetch: refetchOnHoldChecks } = trpc.onHoldChecks.getByDate.useQuery(
    { date: todayEAT },
    // 2-min stale time (was 10 s). Mutations already invalidate on change.
    { staleTime: 2 * 60_000 }
  );
  const markOnHoldChecked = trpc.onHoldChecks.markChecked.useMutation({
    onSuccess: () => { refetchOnHoldChecks(); },
  });
  const utils = trpc.useUtils();
  const recordStreakMutation = trpc.streak.record.useMutation({
    onSuccess: () => {
      utils.streak.get.invalidate();
      const prevLongest = streakData?.longestStreak ?? 0;
      const newStreak = (streakData?.currentStreak ?? 0) + 1;
      if (newStreak > prevLongest && newStreak > 1) {
        toast.success(`🔥 New personal best: ${newStreak} days in a row!`, {
          description: "All DOING cards updated before 23:00 — keep it up!",
          duration: 8000,
        });
      } else {
        toast.success(`Streak recorded — ${newStreak} day${newStreak !== 1 ? "s" : ""} in a row! 🔥`, {
          duration: 4000,
        });
      }
    },
  });

  const doingCardsRaw = data?.doingCards ?? [];
  const doingPendingCount = doingCardsRaw.filter((c: any) => !c.updatedToday).length;
  // Sort DOING: pending (not updated) first, then by due date ascending (soonest first), no-due last
  const doingCardsSorted = [...doingCardsRaw].sort((a, b) => {
    if (a.updatedToday !== b.updatedToday) return a.updatedToday ? 1 : -1;
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due).getTime() - new Date(b.due).getTime();
  });

  // Filter DOING cards by search query
  const doingCards = cardSearch.trim()
    ? doingCardsSorted.filter((c: any) =>
        c.name.toLowerCase().includes(cardSearch.toLowerCase()) ||
        (c.boardName ?? "").toLowerCase().includes(cardSearch.toLowerCase()) ||
        (c.listName ?? "").toLowerCase().includes(cardSearch.toLowerCase())
      )
    : doingCardsSorted;

  const onHoldCardsRaw = data?.onHoldCards ?? [];
  const onHoldCount = onHoldCardsRaw.length;
  const checkedOnHoldIds = new Set(
    (onHoldChecksData ?? []).filter((r: any) => r.checked).map((r: any) => r.cardId)
  );
  // Exclude snoozed cards from pending count and display
  const visibleOnHoldCards = onHoldCardsRaw.filter((c: any) => !snoozedCardIds.has(c.id));
  const onHoldPendingCount = visibleOnHoldCards.filter((c: any) => !checkedOnHoldIds.has(c.id)).length;
  // Sort ON-HOLD: unchecked first, then by longest idle (oldest dateLastActivity first)
  const onHoldCards = [...visibleOnHoldCards].sort((a, b) => {
    const aChecked = checkedOnHoldIds.has(a.id);
    const bChecked = checkedOnHoldIds.has(b.id);
    if (aChecked !== bChecked) return aChecked ? 1 : -1;
    const aMs = a.dateLastActivity ? new Date(a.dateLastActivity).getTime() : 0;
    const bMs = b.dateLastActivity ? new Date(b.dateLastActivity).getTime() : 0;
    return aMs - bMs; // oldest activity first
  });

  const dueTodayCardsRaw = data?.dueTodayCards ?? [];
  const noDueDateCardsRaw = data?.noDueDateCards ?? [];
  const dueTodayCount = dueTodayCardsRaw.length;
  const noDueDateCount = noDueDateCardsRaw.length;

  const overdueCardsRaw = data?.overdueCards ?? [];
  const overdueCount = overdueCardsRaw.length;
  // Sort Overdue: most overdue first (earliest due date first)
  const overdueCards = [...overdueCardsRaw].sort((a, b) => {
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due).getTime() - new Date(b.due).getTime();
  });

  const totalPending = doingPendingCount + onHoldPendingCount + overdueCount;
  const integrationUnavailable = !!error || data?.available === false;
  const allClear = !isLoading && !integrationUnavailable && totalPending === 0;

  // Auto-record streak when all DOING cards are updated before 23:00
  useEffect(() => {
    if (!data || streakRecordedRef.current) return;
    if (doingCards.length === 0) return;
    const allUpdated = doingCards.every((c) => c.updatedToday);
    if (!allUpdated) return;
    const minsLeft = minutesUntilDeadline();
    if (minsLeft > 0) {
      streakRecordedRef.current = true;
      recordStreakMutation.mutate({
        streakDate: getTodayEAT(),
        completedBeforeDeadline: true,
        doingCardCount: doingCards.length,
      });
    }
  }, [data, doingCards]);

  // Reset streak flag at midnight
  useEffect(() => {
    const now = new Date();
    const msUntilMidnight =
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    const t = setTimeout(() => { streakRecordedRef.current = false; }, msUntilMidnight);
    return () => clearTimeout(t);
  }, []);

  // Relative "X min ago" label — updates every 30 s via the `now` tick above
  const lastSyncedLabel = (() => {
    if (!lastSynced) return null;
    const diffMs = now - lastSynced.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "Synced just now";
    if (diffMin === 1) return "Synced 1 min ago";
    return `Synced ${diffMin} min ago`;
  })();

  // Determine hero: highest pending count wins; ties broken by new priority order
  // Priority: ON-HOLD > DOING > Overdue
  type HeroPanel = "overdue" | "doing" | "onhold";
  let heroPanel: HeroPanel = "onhold";
  if (onHoldPendingCount >= doingPendingCount && onHoldPendingCount >= overdueCount) heroPanel = "onhold";
  else if (doingPendingCount >= overdueCount) heroPanel = "doing";
  else heroPanel = "overdue";
  // If everything is clear, hero is ON-HOLD (shows all-clear state)
  if (allClear) heroPanel = "onhold";

  return (
    <Card className="border-0 shadow-sm overflow-hidden">
      {/* ── Collapsible Header ── */}
      <div
        className={`flex items-center justify-between px-5 py-3.5 cursor-pointer select-none transition-colors ${
          allClear
            ? "bg-emerald-500/10 hover:bg-emerald-500/15"
            : "bg-amber-500/10 hover:bg-amber-500/15"
        }`}
        onClick={() => setCollapsed((v) => !v)}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {allClear ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          )}
          <span className="font-semibold text-sm text-foreground truncate">
            {isLoading
              ? "Loading daily actions…"
            : integrationUnavailable
              ? "Trello connection needs attention"
              : allClear
              ? "All Clear — No Actions Required Today"
              : `Daily Actions Required (${totalPending} pending)`}
          </span>
          {collapsed && data && overdueCount > 0 && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-600 dark:text-red-400 flex items-center gap-0.5 flex-shrink-0">
              <AlertTriangle className="w-2.5 h-2.5" />
              {overdueCount} overdue
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Autopilot Level indicator */}
          {policiesData && (
            <span className={`hidden sm:inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
              autopilotLevel >= 4 ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : autopilotLevel >= 2 ? 'bg-blue-500/15 border-blue-500/40 text-blue-600 dark:text-blue-400'
              : 'bg-slate-500/15 border-slate-500/40 text-slate-500 dark:text-slate-400'
            }`} title="Autopilot level controls how much the AI does autonomously. Set in Settings → Operational Policies.">
              AP L{autopilotLevel}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <SyncDot active={isFetching} />
            {lastSyncedLabel && (
              <span className="text-[10px] text-muted-foreground hidden sm:inline" title={lastSyncedLabel}>
                {isFetching ? "Syncing…" : lastSyncedLabel}
              </span>
            )}
            {!lastSyncedLabel && isFetching && (
              <span className="text-[10px] text-muted-foreground hidden sm:inline">Syncing…</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => { e.stopPropagation(); refetch(); }}
            title="Refresh from Trello now"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          {collapsed ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* ── Body ── */}
      {!collapsed && (
        <CardContent className="p-5 space-y-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Loading Trello data…
            </div>
          )}
          {integrationUnavailable && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
              Trello data is unavailable. Check that your Trello connection is configured, then refresh this section.
            </div>
          )}

          {data && data.available !== false && (
            <>
              {/* ── 1. ON-HOLD Review (first) ── */}
              <ActionSection
                icon={<PauseCircle className={`w-${heroPanel === "onhold" ? "5" : "4"} h-${heroPanel === "onhold" ? "5" : "4"} text-purple-500`} />}
                accentClass="border-l-purple-500"
                bgClass="bg-purple-500/8"
                title="Review ON-HOLD Cards"
                subtitle={
                  onHoldCount === 0
                    ? "No cards on hold — all clear!"
                    : onHoldPendingCount === 0
                    ? `All ${onHoldCount} ON-HOLD card${onHoldCount !== 1 ? "s" : ""} reviewed today ✓`
                    : `${onHoldPendingCount} of ${onHoldCount} card${onHoldCount !== 1 ? "s" : ""} still need review today`
                }
                isHero={heroPanel === "onhold"}
                allClear={onHoldCount === 0 || onHoldPendingCount === 0}
                allClearLabel={onHoldCount === 0 ? "No cards on hold" : "All reviewed today"}
                totalCount={onHoldCount}
                storageKey="onhold"
              >
                {onHoldCount > 0 && (
                  <>
                    <p className="text-[10px] text-muted-foreground -mt-1">
                      Tick each card after reviewing. Move to DOING in Trello if you can work on it today.
                    </p>
                    {/* Snoozed cards count badge */}
                    {snoozedCardIds.size > 0 && (
                      <div className="flex items-center gap-1.5 px-2 py-1 bg-violet-500/8 border border-violet-500/20 rounded-md -mt-0.5 mb-1">
                        <BellOff className="w-3 h-3 text-violet-500 flex-shrink-0" />
                        <span className="text-[10px] text-violet-700 dark:text-violet-300">
                          {snoozedCardIds.size} card{snoozedCardIds.size !== 1 ? "s" : ""} snoozed (hidden until their resurface date)
                        </span>
                      </div>
                    )}
                    <ScrollList>
                      {onHoldCards.map((card) => {
                        const due = getDueBadge(card.due);
                        const age = getCardAgeBadge(card.dateLastActivity);
                        const isChecked = checkedOnHoldIds.has(card.id);
                        const isSnoozeOpen = snoozePickerCardId === card.id;
                        return (
                          <div key={card.id}>
                            <div className="flex items-center gap-1.5">
                              {/* Snooze button — first */}
                              <button
                                type="button"
                                onClick={() => {
                                  if (isSnoozeOpen) { setSnoozePickerCardId(null); }
                                  else { setSnoozePickerCardId(card.id); setSnoozeDate(""); setSnoozeNote(""); }
                                }}
                                className="flex-shrink-0 p-1.5 rounded hover:bg-violet-500/10 transition-colors"
                                title="Snooze this card"
                              >
                                <BellOff className={`w-3.5 h-3.5 ${isSnoozeOpen ? "text-violet-500" : "text-muted-foreground/50 hover:text-violet-500"}`} />
                              </button>
                              <CardRow
                                href={card.url}
                                name={card.name}
                                boardName={card.boardName}
                                listName={card.listName}
                                icon={<span />}
                                dueBadge={due}
                                extraBadge={age.label ? age : undefined}
                                strikethrough={isChecked}
                                dimmed={isChecked}
                                urgencyTier={(() => {
                                  const score = aptlssScoreMap.get(card.id);
                                  const state = aptlssStateMap.get(card.id);
                                  if (state?.state === 'BLOCKED') return 'BLOCKED';
                                  return score?.tier;
                                })()}
                                progressPct={(() => { const s = aptlssScoreMap.get(card.id); if (!s) return undefined; const total = s.openSteps + s.completedSteps; return total > 0 ? Math.round((s.completedSteps / total) * 100) : undefined; })()}
                                remainingMinutes={aptlssScoreMap.get(card.id)?.estimatedRemainingMinutes ?? undefined}
                                leftSlot={
                                  <button
                                    type="button"
                                    onClick={() =>
                                      markOnHoldChecked.mutate({
                                        cardId: card.id,
                                        cardName: card.name,
                                        cardUrl: card.url,
                                        date: todayEAT,
                                        checked: !isChecked,
                                      })
                                    }
                                    className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                                      isChecked
                                        ? "bg-emerald-500 border-emerald-500"
                                        : "border-purple-400/60 hover:border-purple-500"
                                    }`}
                                    title={isChecked ? "Mark as not reviewed" : "Mark as reviewed"}
                                  >
                                    {isChecked && (
                                      <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 10" fill="none">
                                        <path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                      </svg>
                                    )}
                                  </button>
                                }
                              />
                            </div>
                            {/* Snooze picker */}
                            {isSnoozeOpen && (
                              <div className="ml-6 mt-1 mb-1.5 p-2.5 rounded-lg border border-violet-500/30 bg-violet-500/5 space-y-2">
                                <p className="text-[10px] text-violet-700 dark:text-violet-300 font-medium">Snooze until:</p>
                                <input
                                  type="date"
                                  value={snoozeDate}
                                  min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                                  onChange={e => setSnoozeDate(e.target.value)}
                                  className="w-full text-xs rounded border border-border/60 bg-background px-2 py-1 focus:outline-none focus:border-violet-500/60"
                                />
                                <input
                                  type="text"
                                  value={snoozeNote}
                                  onChange={e => setSnoozeNote(e.target.value)}
                                  placeholder="Optional note (why snoozed?)"
                                  className="w-full text-xs rounded border border-border/60 bg-background px-2 py-1 focus:outline-none focus:border-violet-500/60"
                                />
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => handleSnoozeSubmit(card)}
                                    disabled={!snoozeDate || snoozeCardMutation.isPending}
                                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                  >
                                    <BellOff className="w-3 h-3" />
                                    {snoozeCardMutation.isPending ? "Snoozing…" : "Snooze"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setSnoozePickerCardId(null)}
                                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                                  >
                                    <X className="w-3 h-3" />
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </ScrollList>
                  </>
                )}
              </ActionSection>

              {/* ── 2. DOING Updates (second) ── */}
              {(() => {
                return (
                  <ActionSection
                    icon={<MessageSquarePlus className={`w-${heroPanel === "doing" ? "5" : "4"} h-${heroPanel === "doing" ? "5" : "4"} text-blue-500`} />}
                    accentClass="border-l-blue-500"
                    bgClass="bg-blue-500/8"
                    title="Post Daily Update on DOING Cards"
                    subtitle={
                      doingPendingCount === 0
                        ? "All DOING cards updated today — well done!"
                        : `${doingPendingCount} card${doingPendingCount !== 1 ? "s" : ""} still need a comment today`
                    }
                    isHero={heroPanel === "doing"}
                    allClear={doingPendingCount === 0 && doingCards.length > 0}
                    allClearLabel="All DOING cards updated today"
                    totalCount={doingCards.length}
                    badge={
                      <div className="flex items-center gap-2">
                        {streakData && streakData.currentStreak > 0 && (
                          <StreakBadge streak={streakData.currentStreak} />
                        )}
                        <DeadlineCountdown allDone={doingPendingCount === 0} />
                      </div>
                    }
                    extraHeaderSlot={
                      doingPendingCount > 0 ? (
                        <button
                          type="button"
                          title={`Open all ${doingPendingCount} pending DOING card${doingPendingCount !== 1 ? "s" : ""} in new tabs`}
                          onClick={() => {
                            doingCards
                              .filter((c) => !c.updatedToday)
                              .forEach((c) => window.open(c.url, "_blank", "noopener"));
                          }}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 hover:bg-blue-500/25 transition-colors flex-shrink-0"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Open all
                        </button>
                      ) : null
                    }
                    storageKey="doing"
                  >
                    {/* Search/filter for DOING cards */}
                    {doingCardsSorted.length > 5 && (
                      <div className="px-1 pb-2">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                          <input
                            type="text"
                            placeholder="Filter cards by name, board, or list…"
                            value={cardSearch}
                            onChange={e => setCardSearch(e.target.value)}
                            className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500/50 placeholder:text-muted-foreground"
                          />
                          {cardSearch && (
                            <button
                              onClick={() => setCardSearch("")}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                        {cardSearch && (
                          <p className="text-[10px] text-muted-foreground mt-1 px-0.5">
                            {doingCards.length} of {doingCardsSorted.length} cards
                          </p>
                        )}
                      </div>
                    )}
                    <ScrollList>
                      {doingCards.map((card) => {
                        const due = getDueBadge(card.due);
                        const isCommentOpen = openCommentCardId === card.id;
                        // Format last activity timestamp relative to now
                        const lastActivityLabel = (() => {
                          if (!card.dateLastActivity) return null;
                          const diffMs = Date.now() - new Date(card.dateLastActivity).getTime();
                          const diffMins = Math.floor(diffMs / 60_000);
                          const diffHours = Math.floor(diffMins / 60);
                          const diffDays = Math.floor(diffHours / 24);
                          if (diffMins < 1) return "just now";
                          if (diffMins < 60) return `${diffMins}m ago`;
                          if (diffHours < 24) return `${diffHours}h ago`;
                          if (diffDays === 1) return "yesterday";
                          return `${diffDays}d ago`;
                        })();
                        return (
                          <div key={card.id}>
                            <CardRow
                              href={card.url}
                              name={card.name}
                              boardName={card.boardName}
                              listName={card.listName}
                              icon={
                                card.updatedToday
                                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                  : <Clock className="w-3.5 h-3.5 text-blue-500" />
                              }
                              dueBadge={due}
                              extraBadge={lastActivityLabel ? {
                                label: lastActivityLabel,
                                className: card.updatedToday
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : (card.dateLastActivity && (Date.now() - new Date(card.dateLastActivity).getTime()) > 24*60*60*1000)
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-muted-foreground"
                              } : undefined}
                              strikethrough={card.updatedToday}
                              dimmed={card.updatedToday}
                              urgencyTier={(() => {
                                const score = aptlssScoreMap.get(card.id);
                                const state = aptlssStateMap.get(card.id);
                                if (state?.state === 'BLOCKED') return 'BLOCKED';
                                return score?.tier;
                              })()}
                              progressPct={(() => {
                                const score = aptlssScoreMap.get(card.id);
                                if (!score) return undefined;
                                const total = score.openSteps + score.completedSteps;
                                return total > 0 ? Math.round((score.completedSteps / total) * 100) : undefined;
                              })()}
                              remainingMinutes={(() => {
                                const score = aptlssScoreMap.get(card.id);
                                return score?.estimatedRemainingMinutes ?? undefined;
                              })()}
                              leftSlot={
                                !card.updatedToday ? (
                                  <button
                                    type="button"
                                    title="Quick comment"
                                    onClick={() =>
                                      setOpenCommentCardId(isCommentOpen ? null : card.id)
                                    }
                                    className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center transition-colors ${
                                      isCommentOpen
                                        ? "bg-blue-500/20 text-blue-500"
                                        : "text-muted-foreground hover:text-blue-500 hover:bg-blue-500/10"
                                    }`}
                                  >
                                    <MessageSquarePlus className="w-3.5 h-3.5" />
                                  </button>
                                ) : undefined
                              }
                            />
                            {isCommentOpen && (
                              <QuickComment
                                cardId={card.id}
                                onSuccess={() => setOpenCommentCardId(null)}
                                onClose={() => setOpenCommentCardId(null)}
                              />
                            )}
                            {/* Default Action Rule Banner — shown for all DOING cards with a known APTLSS state */}
                            {(() => {
                              const cardState = aptlssStateMap.get(card.id);
                              if (!cardState?.state) return null;
                              return <DefaultActionBanner state={cardState.state} />;
                            })()}
                            {/* Confidence Score chip — shown when plan has a confidence score */}
                            {(() => {
                              const cardState = aptlssStateMap.get(card.id);
                              const cs = (cardState as { confidenceScore?: number | null } | undefined)?.confidenceScore;
                              if (cs == null) return null;
                              const color = cs >= 85
                                ? 'text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
                                : cs >= 65
                                ? 'text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10'
                                : 'text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10';
                              const label = cs >= 85 ? 'High confidence' : cs >= 65 ? 'Medium confidence' : 'Low confidence — needs review';
                              return (
                                <div className={`mt-1 ml-6 flex items-center gap-1.5 rounded-md border px-2 py-1 w-fit ${color}`}>
                                  <span className="text-[10px] font-semibold">{cs}% confidence</span>
                                  <span className="text-[9px] opacity-70">· {label}</span>
                                </div>
                              );
                            })()}
                            {/* Done Quality Gate Warning — shown when card state is READY_FOR_DONE */}
                            {(() => {
                              const cardState = aptlssStateMap.get(card.id);
                              if (cardState?.state !== 'READY_FOR_DONE') return null;
                              const missing: string[] = [];
                              if (!cardState.hasFinalSummary) missing.push('Post a final summary comment on the card');
                              if (cardState.hasUnansweredQuestion) missing.push('Answer the unanswered question in comments');
                              return (
                                <div className="mt-1 mb-1 ml-6 rounded-lg border border-emerald-500/40 bg-emerald-500/8 p-2.5">
                                  <div className="flex items-center gap-1.5 mb-1.5">
                                    <CheckSquare className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                                    <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">Ready for Done</span>
                                    <span className="text-[9px] text-emerald-600/70 dark:text-emerald-400/70 ml-auto">All checklist items complete</span>
                                  </div>
                                  {missing.length > 0 ? (
                                    <div className="space-y-0.5">
                                      <p className="text-[10px] text-amber-700 dark:text-amber-300 font-medium">Before moving to Done:</p>
                                      {missing.map((item, i) => (
                                        <div key={i} className="flex items-start gap-1.5">
                                          <ArrowRight className="w-2.5 h-2.5 text-amber-500 flex-shrink-0 mt-0.5" />
                                          <span className="text-[10px] text-amber-700 dark:text-amber-300">{item}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-[10px] text-emerald-600 dark:text-emerald-400">All gates passed — move this card to the Done list in Trello.</p>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        );
                      })}
                      {doingCards.length === 0 && (
                        <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg p-2.5">
                          No cards currently in the DOING list.
                        </p>
                      )}
                    </ScrollList>
                  </ActionSection>
                );
              })()}

              {/* ── 3. Cards Due Today (third) ── */}
              {(dueTodayCount > 0 || noDueDateCount > 0) && (
                <ActionSection
                  icon={<CalendarCheck className={`w-4 h-4 text-orange-500`} />}
                  accentClass="border-l-orange-500"
                  bgClass="bg-orange-500/8"
                  title="Morning Briefing"
                  subtitle={
                    dueTodayCount > 0 && noDueDateCount > 0
                      ? `${dueTodayCount} due today · ${noDueDateCount} missing due date`
                      : dueTodayCount > 0
                      ? `${dueTodayCount} card${dueTodayCount !== 1 ? "s" : ""} due today`
                      : `${noDueDateCount} card${noDueDateCount !== 1 ? "s" : ""} missing a due date`
                  }
                  isHero={false}
                  allClear={dueTodayCount === 0 && noDueDateCount === 0}
                  allClearLabel="No cards due today and all cards have due dates"
                  storageKey="briefing"
                >
                  {dueTodayCount > 0 && (
                    <>
                      <p className="text-[10px] font-semibold text-orange-600 dark:text-orange-400 -mt-1">Due Today</p>
                      <ScrollList>
                        {dueTodayCardsRaw.map((card: any) => (
                          <CardRow
                            key={card.id}
                            href={card.url}
                            name={card.name}
                            boardName={card.boardName}
                            listName={card.listName}
                            icon={<CalendarCheck className="w-3.5 h-3.5 text-orange-500" />}
                            dueBadge={{ label: "Due today", className: "text-orange-600 dark:text-orange-400 font-semibold" }}
                          />
                        ))}
                      </ScrollList>
                    </>
                  )}
                  {noDueDateCount > 0 && (
                    <>
                      <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 mt-1">Missing Due Date</p>
                      <ScrollList>
                        {noDueDateCardsRaw.map((card: any) => (
                          <CardRow
                            key={card.id}
                            href={card.url}
                            name={card.name}
                            boardName={card.boardName}
                            listName={card.listName}
                            icon={<CalendarX className="w-3.5 h-3.5 text-amber-500" />}
                            dueBadge={{ label: "No due date", className: "text-amber-600 dark:text-amber-400 font-medium" }}
                          />
                        ))}
                      </ScrollList>
                    </>
                  )}
                </ActionSection>
              )}

              {/* ── 4. Overdue Cards (fourth) ── */}
              <ActionSection
                icon={<AlertTriangle className={`w-${heroPanel === "overdue" ? "5" : "4"} h-${heroPanel === "overdue" ? "5" : "4"} text-red-500`} />}
                accentClass="border-l-red-500"
                bgClass="bg-red-500/8"
                title="Overdue Cards"
                subtitle={
                  overdueCount === 0
                    ? "No overdue cards — all on track!"
                    : `${overdueCount} card${overdueCount !== 1 ? "s" : ""} past their due date`
                }
                isHero={heroPanel === "overdue"}
                allClear={overdueCount === 0}
                allClearLabel="No overdue cards"
                totalCount={overdueCount}
                storageKey="overdue"
                extraHeaderSlot={
                  overdueCount > 0 ? (
                    <button
                      type="button"
                      title={`Open all ${overdueCount} overdue card${overdueCount !== 1 ? "s" : ""} in new tabs`}
                      onClick={() => {
                        overdueCards.forEach((c) => window.open(c.url, "_blank", "noopener"));
                      }}
                      className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 transition-colors flex-shrink-0"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Open all
                    </button>
                  ) : null
                }
              >
                <ScrollList>
                  {overdueCards.map((card) => {
                    const overdueDays = card.due
                      ? Math.floor((Date.now() - new Date(card.due).getTime()) / (1000 * 60 * 60 * 24))
                      : 0;
                    const due = getDueBadge(card.due);
                    return (
                      <CardRow
                        key={card.id}
                        href={card.url}
                        name={card.name}
                        boardName={card.boardName}
                        listName={card.listName}
                        icon={<AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
                        dueBadge={due}
                        extraBadge={overdueDays > 0 ? { label: `${overdueDays}d overdue`, className: "text-red-600 dark:text-red-400 font-semibold" } : undefined}
                        urgencyTier={(() => {
                          const score = aptlssScoreMap.get(card.id);
                          const state = aptlssStateMap.get(card.id);
                          if (state?.state === 'BLOCKED') return 'BLOCKED';
                          return score?.tier;
                        })()}
                        progressPct={(() => { const s = aptlssScoreMap.get(card.id); if (!s) return undefined; const total = s.openSteps + s.completedSteps; return total > 0 ? Math.round((s.completedSteps / total) * 100) : undefined; })()}
                        remainingMinutes={aptlssScoreMap.get(card.id)?.estimatedRemainingMinutes ?? undefined}
                      />
                    );
                  })}
                </ScrollList>
              </ActionSection>

              {/* ── 5. Cards Needing Repair (fifth) ── */}
              {repairQueue.length > 0 && (
                <ActionSection
                  icon={<Wrench className="w-4 h-4 text-amber-500" />}
                  accentClass="border-l-amber-500"
                  bgClass="bg-amber-500/8"
                  title="Cards Needing Repair"
                  subtitle={`${repairQueue.length} card${repairQueue.length !== 1 ? 's' : ''} flagged as vague, oversized, or missing a checklist — re-generate their APTLSS plan to fix`}
                  isHero={false}
                  allClear={false}
                  allClearLabel="No cards need repair"
                  totalCount={repairQueue.length}
                  storageKey="repair"
                >
                  <ScrollList>
                    {repairQueue.map((card) => (
                      <CardRow
                        key={card.cardId}
                        href={`https://trello.com/c/${card.cardId}`}
                        name={card.cardName}
                        boardName={card.boardName ?? undefined}
                        listName={card.listName ?? undefined}
                        icon={<Wrench className="w-3.5 h-3.5 text-amber-500" />}
                        extraBadge={{ label: card.stateReason ?? 'Needs restructuring', className: 'text-amber-600 dark:text-amber-400 font-medium' }}
                      />
                    ))}
                  </ScrollList>
                </ActionSection>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
