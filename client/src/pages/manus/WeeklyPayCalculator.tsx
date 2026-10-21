import { useState, useMemo, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { weeklyPayRevision } from "@shared/financialRevision";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Calculator, Flame, Star, Save, History, TriangleAlert, ChevronDown, ChevronUp, ClipboardCheck,
  TrendingUp, TrendingDown, Minus, RefreshCw
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";

// Get Monday of the current week
function getWeekStart(offset = 0): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1) + offset * 7;
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Merit definitions ─────────────────────────────────────────────────────────
const MERITS = [
  {
    key: "meritM1",
    code: "M1",
    label: "Realized Financial Opportunity",
    amount: 5.0,
    color: "emerald",
    desc: "Unprompted and outside of a task, you identify an opportunity that leads to a direct, measurable financial payment. Bonus paid after payment is received and documented.",
  },
  {
    key: "meritM2",
    code: "M2",
    label: "Proactive Process Improvement",
    amount: 7.5,
    color: "teal",
    desc: "On your own initiative and not as part of a task, you create or measurably improve a process. Bonus paid after measurable improvement is demonstrated with before-and-after metrics.",
  },
  {
    key: "meritM3",
    code: "M3B",
    label: "Unsolicited Specific Positive Feedback",
    amount: 1.0,
    color: "sky",
    desc: "A third party sends feedback praising a specific action or quality (e.g., \"Her briefs are always crystal clear\"). General positive feedback does not qualify.",
  },
  {
    key: "meritStreak",
    code: "🔥",
    label: "Consistency Streak Bonus",
    amount: 10.0,
    color: "amber",
    desc: "Awarded if you achieve zero demerits for 4 consecutive weeks. The streak resets to zero after the bonus is paid or after any week with one or more demerits.",
  },
] as const;

// ── Demerit definitions ───────────────────────────────────────────────────────
const DEMERITS = [
  {
    key: "demeritD1",
    code: "1A",
    label: "Trello Reporting Failure",
    amount: 5.0,
    freq: "Per Instance",
    trigger: "A substance-free update is posted, or a task-switch occurs without a mid-task update.",
  },
  {
    key: "demeritD2",
    code: "1B",
    label: "Task & Due Date Management",
    amount: 10.0,
    freq: "Per Card/Day",
    trigger: "A card is past its due date, or has no due date. Demerit applies each day the card is in this state.",
  },
  {
    key: "demeritD3",
    code: "1C",
    label: "Task Logging Failure",
    amount: 5.0,
    freq: "Per Item",
    trigger: "An action item from a meeting/chat is not logged in Trello within 12 hours.",
  },
  {
    key: "demeritD4",
    code: "1D",
    label: "Failure to Scope Task Time",
    amount: 5.0,
    freq: "Per Task",
    trigger: "Begins work on a non-trivial task without an agreed-upon time budget.",
  },
  {
    key: "demeritD5",
    code: "2A",
    label: "Quality Control Failure",
    amount: 10.0,
    freq: "Per Instance",
    trigger: "A comprehension failure causes rework, or unreviewed freelancer output is passed on.",
  },
  {
    key: "demeritD6",
    code: "2B",
    label: "Appointment Mismanagement",
    amount: 5.0,
    freq: "Per Instance",
    trigger: "Manual scheduling is used, arrival is >5 mins late, or an event lacks the \"5 Ws\".",
  },
  {
    key: "demeritD7",
    code: "2C",
    label: "Digital Workspace Mismanagement",
    amount: 5.0,
    freq: "Per Session",
    trigger: "Unarchived files are found, or Chrome Tab Groups are not in use at the end of a work session.",
  },
  {
    key: "demeritD8",
    code: "3A",
    label: "Poor Stakeholder Management",
    amount: 10.0,
    freq: "Per Instance",
    trigger: "A commitment to a third party is broken, or a follow-up on a dependency is missed.",
  },
  {
    key: "demeritD9",
    code: "3B",
    label: "Failure to Manage Risk",
    amount: 15.0,
    freq: "Per Instance",
    trigger: "A known blocker is not flagged proactively, or a case of gross negligence occurs.",
  },
  {
    key: "demeritD10",
    code: "3C",
    label: "TOS Compliance Check Failure",
    amount: 15.0,
    freq: "Per Instance",
    trigger: "Before posting or acting on a third-party platform, the VA must run the platform's TOS through an AI tool to verify compliance. Infraction triggers if this check is not performed.",
  },
  {
    key: "demeritD11",
    code: "3D",
    label: "Data Loss Through Poor Management",
    amount: 15.0,
    freq: "Per Instance",
    trigger: "Information, files, or work output is lost, corrupted, or rendered inaccessible due to a failure to follow proper data management practices.",
  },
] as const;

type MeritKey = typeof MERITS[number]["key"];
type DemeritKey = typeof DEMERITS[number]["key"];
type Counts = Record<MeritKey | DemeritKey, number>;

const defaultCounts = (): Counts => ({
  meritM1: 0, meritM2: 0, meritM3: 0, meritStreak: 0,
  demeritD1: 0, demeritD2: 0, demeritD3: 0, demeritD4: 0,
  demeritD5: 0, demeritD6: 0, demeritD7: 0, demeritD8: 0,
  demeritD9: 0, demeritD10: 0, demeritD11: 0,
});

const meritColorMap: Record<string, { bg: string; text: string; btn: string }> = {
  emerald: {
    bg: "bg-emerald-50/60 dark:bg-emerald-950/15 border-emerald-200/50 dark:border-emerald-800/25",
    text: "text-emerald-600 dark:text-emerald-400",
    btn: "bg-emerald-500 hover:bg-emerald-600",
  },
  teal: {
    bg: "bg-teal-50/60 dark:bg-teal-950/15 border-teal-200/50 dark:border-teal-800/25",
    text: "text-teal-600 dark:text-teal-400",
    btn: "bg-teal-500 hover:bg-teal-600",
  },
  sky: {
    bg: "bg-sky-50/60 dark:bg-sky-950/15 border-sky-200/50 dark:border-sky-800/25",
    text: "text-sky-600 dark:text-sky-400",
    btn: "bg-sky-500 hover:bg-sky-600",
  },
  amber: {
    bg: "bg-amber-50/60 dark:bg-amber-950/15 border-amber-200/50 dark:border-amber-800/25",
    text: "text-amber-600 dark:text-amber-400",
    btn: "bg-amber-500 hover:bg-amber-600",
  },
};

// ── Counter widget ────────────────────────────────────────────────────────────
function Counter({
  value,
  onDecrement,
  onIncrement,
  btnClass,
  isFounder,
  disabled,
}: {
  value: number;
  onDecrement: () => void;
  onIncrement: () => void;
  btnClass: string;
  isFounder?: boolean;
  disabled?: boolean;
}) {
  if (!isFounder) {
    return <span className="w-8 text-right font-bold text-sm text-foreground pr-1">{value}</span>;
  }
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      <button
        onClick={onDecrement}
        disabled={disabled}
        className="w-6 h-6 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center text-xs font-bold text-muted-foreground transition-colors"
      >−</button>
      <span className="w-5 text-center font-bold text-sm text-foreground">{value}</span>
      <button
        onClick={onIncrement}
        disabled={disabled}
        className={`w-6 h-6 rounded-full ${btnClass} flex items-center justify-center text-xs font-bold text-white transition-colors`}
      >+</button>
    </div>
  );
}

// ── CollapsibleItem: per-item expand/collapse wrapper ───────────────────────
function CollapsibleItem({
  header,
  children,
  defaultOpen = false,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div onClick={() => setOpen(v => !v)}>
        {header}
      </div>
      {open && children}
    </div>
  );
}

// ── PayHistoryRow: single pay history row with compliance badge ──────────────
function PayHistoryRow({
  id,
  weekStart,
  prevWeekStart,
  weekStartLabel,
  weekEndLabel,
  pay,
  payClr,
  demerits,
  merits,
}: {
  id: string;
  weekStart: string;
  prevWeekStart: string | null;
  weekStartLabel: string;
  weekEndLabel: string;
  pay: number;
  payClr: string;
  demerits: number;
  merits: number;
}) {
  const { data } = trpc.compliance.getWeekAvg.useQuery({ weekStart });
  const { data: prevData } = trpc.compliance.getWeekAvg.useQuery(
    { weekStart: prevWeekStart! },
    { enabled: prevWeekStart !== null }
  );
  const avg = data?.avg ?? null;
  const prevAvg = prevData?.avg ?? null;

  const complianceColor = avg === null
    ? ""
    : avg >= 90
    ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
    : avg >= 70
    ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
    : "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300";

  // Trend arrow: compare this week's avg to previous week's avg
  const trendDiff = avg !== null && prevAvg !== null ? avg - prevAvg : null;
  const TrendIcon = trendDiff === null ? null
    : trendDiff > 2 ? TrendingUp
    : trendDiff < -2 ? TrendingDown
    : Minus;
  const trendColor = trendDiff === null ? ""
    : trendDiff > 2 ? "text-emerald-500"
    : trendDiff < -2 ? "text-red-500"
    : "text-muted-foreground";
  const trendTitle = trendDiff === null ? ""
    : trendDiff > 0 ? `+${trendDiff}pp vs prev week`
    : trendDiff < 0 ? `${trendDiff}pp vs prev week`
    : "Same as prev week";

  return (
    <div
      id={id}
      className="flex items-center justify-between p-3 bg-muted/40 rounded-lg transition-all"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-foreground">
            {weekStartLabel} – {weekEndLabel}
          </p>
          {avg !== null && (
            <Badge className={`text-[10px] py-0 px-1.5 border-0 font-bold ${complianceColor}`}>
              <ClipboardCheck className="w-2.5 h-2.5 mr-0.5" />
              {avg}% compliance
              {TrendIcon && (
                <span className={`ml-1 inline-flex items-center ${trendColor}`} title={trendTitle}>
                  <TrendIcon className="w-2.5 h-2.5" />
                  {trendDiff !== null && Math.abs(trendDiff) > 2 && (
                    <span className="ml-0.5 text-[9px]">{Math.abs(trendDiff)}pp</span>
                  )}
                </span>
              )}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {demerits > 0 ? `−$${demerits.toFixed(2)} demerits` : "Zero demerits ✓"}
          {merits > 0 ? ` · +$${merits.toFixed(2)} merits` : ""}
        </p>
      </div>
      <p className={`text-base font-bold font-mono ml-3 ${payClr}`}>${pay.toFixed(2)}</p>
    </div>
  );
}

interface WeeklyPayCalculatorProps {
  vaId?: number;
}

export default function WeeklyPayCalculator({ vaId }: WeeklyPayCalculatorProps = {}) {
  const { user } = useAuth();
  return <ScopedWeeklyPayCalculator key={`${user?.id}:${vaId ?? "self"}`} vaId={vaId} />;
}

function ScopedWeeklyPayCalculator({ vaId }: WeeklyPayCalculatorProps) {
  const { user } = useAuth();
  const isFounder = user?.role === "admin" && Number.isSafeInteger(vaId) && Number(vaId) > 0;
  const [weekStart] = useState(() => getWeekStart());
  const weekEnd = getWeekEnd(weekStart);
  const [counts, setCounts] = useState<Counts>(defaultCounts());
  const [notes, setNotes] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [savedThisSession, setSavedThisSession] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState<string | null | undefined>(undefined);
  const [saveConflict, setSaveConflict] = useState(false);
  const [mdCollapsed, setMdCollapsed] = useState(false); // merits+demerits section
  const [d1GuardPending, setD1GuardPending] = useState<number | null>(null); // pending delta when guard fires

  const utils = trpc.useUtils();

  // Auto-expand Pay History when a compliance "→ Pay log" scroll-link is clicked
  const handleHashNavigation = useCallback(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#pay-log-week-")) {
      setShowHistory(true);
      // Give React a tick to render the rows, then scroll
      setTimeout(() => {
        const el = document.getElementById(hash.slice(1));
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-amber-500", "ring-offset-2");
          setTimeout(() => el.classList.remove("ring-2", "ring-amber-500", "ring-offset-2"), 3000);
        }
      }, 120);
    }
  }, []);

  useEffect(() => {
    // Handle initial load with hash
    handleHashNavigation();
    // Listen for hash changes (from compliance table links)
    window.addEventListener("hashchange", handleHashNavigation);
    return () => window.removeEventListener("hashchange", handleHashNavigation);
  }, [handleHashNavigation]);

  const weekQuery = trpc.payLog.getByWeek.useQuery({ weekStart, vaId });
  const { data: existing, isLoading: loadingWeek, isError: weekError } = weekQuery;
  const [loaded, setLoaded] = useState(false);
  if (existing !== undefined && !loaded && !savedThisSession) {
    setLoaded(true);
    setLoadedRevision(weeklyPayRevision(existing));
    if (existing) {
    setCounts({
      meritM1: Number(existing.meritM1) || 0,
      meritM2: Number(existing.meritM2) || 0,
      meritM3: Number(existing.meritM3) || 0,
      meritStreak: Number(existing.meritStreak) || 0,
      demeritD1: Number(existing.demeritD1) || 0,
      demeritD2: Number(existing.demeritD2) || 0,
      demeritD3: Number(existing.demeritD3) || 0,
      demeritD4: Number(existing.demeritD4) || 0,
      demeritD5: Number(existing.demeritD5) || 0,
      demeritD6: Number(existing.demeritD6) || 0,
      demeritD7: Number(existing.demeritD7) || 0,
      demeritD8: Number(existing.demeritD8) || 0,
      demeritD9: Number(existing.demeritD9) || 0,
      demeritD10: Number(existing.demeritD10) || 0,
      demeritD11: Number(existing.demeritD11) || 0,
    });
    setNotes(existing.notes ?? "");
    } else {
      setCounts(defaultCounts());
      setNotes("");
    }
  }

  const { data: history } = trpc.payLog.getAll.useQuery({ limit: 8, vaId });

  const upsert = trpc.payLog.upsert.useMutation({
    onSuccess: saved => {
      setLoadedRevision(weeklyPayRevision(saved));
      utils.payLog.getByWeek.invalidate({ weekStart, vaId });
      utils.payLog.getAll.invalidate({ vaId });
      setSavedThisSession(true);
      toast.success("Week saved", { description: "Pay log updated successfully." });
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT") setSaveConflict(true);
      toast.error("Save failed", { description: err.message });
    },
  });

  const totalMerits = useMemo(() =>
    MERITS.reduce((sum, m) => sum + counts[m.key] * m.amount, 0), [counts]);

  const totalDemerits = useMemo(() =>
    DEMERITS.reduce((sum, d) => sum + counts[d.key] * d.amount, 0), [counts]);

  const rawProjectedPay = 90 - totalDemerits + totalMerits;
  const projectedPay = rawProjectedPay; // show real value including negative

  // The D1 value loaded from DB (auto-set by EOD cron) — guard against lowering below this
  const savedD1 = existing ? (Number(existing.demeritD1) || 0) : 0;
  const canEdit = isFounder && !loadingWeek && !weekError && loadedRevision !== undefined && !upsert.isPending && !saveConflict;

  const adjust = (key: MeritKey | DemeritKey, delta: number) => {
    if (!canEdit) return;
    // Guard: if decrementing D1 below the DB-saved (auto-set) value, show confirmation
    if (key === "demeritD1" && delta < 0) {
      const newVal = Math.max(0, counts.demeritD1 + delta);
      if (newVal < savedD1) {
        setD1GuardPending(delta);
        return;
      }
    }
    setCounts(prev => ({ ...prev, [key]: Math.max(0, prev[key] + delta) }));
  };

  const confirmD1Decrease = () => {
    if (!canEdit || vaId === undefined) return;
    if (d1GuardPending !== null) {
      const prevD1 = counts.demeritD1;
      const newD1 = Math.max(0, prevD1 + d1GuardPending);
      // Build audit note with local timestamp
      const now = new Date();
      const stamp = now.toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const auditLine = `[${stamp}] D1 manually reduced ${prevD1}→${newD1} (override of auto-set value ${savedD1})`;
      const updatedNotes = notes ? `${notes}\n${auditLine}` : auditLine;
      setCounts(prev => ({ ...prev, demeritD1: newD1 }));
      setNotes(updatedNotes);
      // Auto-save so the audit trail is persisted immediately
      upsert.mutate(
        { vaId, weekStart, weekEnd, expectedRevision: loadedRevision!, ...counts, demeritD1: newD1, notes: updatedNotes },
        { onSuccess: () => toast.info("D1 override recorded", { description: auditLine }) }
      );
    }
    setD1GuardPending(null);
  };

  const handleSave = () => {
    if (!canEdit || vaId === undefined) return;
    upsert.mutate({ vaId, weekStart, weekEnd, expectedRevision: loadedRevision!, ...counts, notes });
  };

  return (
    <div className="space-y-4">
      {/* ── Projected Pay Header ── */}
      <Card className="border-0 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-violet-500 via-purple-500 to-indigo-600 p-5 text-white">
          <div className="flex items-center gap-2.5 mb-3">
            <Calculator className="w-5 h-5" />
            <h2 className="text-base font-bold">Weekly Pay Calculator</h2>
            <Badge className="bg-white/20 text-white border-0 text-[10px] ml-auto">
              {formatDate(weekStart)} – {formatDate(weekEnd)}
            </Badge>
          </div>
          <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
            <p className="text-[10px] opacity-70 uppercase tracking-wide text-center mb-1">Projected Pay This Week</p>
            <p className={`text-3xl font-bold text-center font-mono ${projectedPay < 0 ? "text-red-300" : ""}`}>
              {projectedPay < 0 ? `-$${Math.abs(projectedPay).toFixed(2)}` : `$${projectedPay.toFixed(2)}`}
            </p>
            <div className="flex justify-center gap-4 mt-2 text-xs">
              <span className="opacity-80">$90 base</span>
              <span className="text-red-200">− ${totalDemerits.toFixed(2)} demerits</span>
              <span className="text-green-200">+ ${totalMerits.toFixed(2)} merits</span>
            </div>
            {projectedPay < 0 && (
              <div className="mt-3 bg-red-500/30 border border-red-300/40 rounded-lg px-3 py-2 text-center">
                <p className="text-xs font-semibold text-red-100">⚠ Demerits exceed base pay — projected pay is negative</p>
              </div>
            )}
            {projectedPay >= 0 && projectedPay < 70 && (
              <div className="mt-3 bg-amber-500/30 border border-amber-300/40 rounded-lg px-3 py-2 text-center">
                <p className="text-xs font-semibold text-amber-100">⚠ Projected pay is below $70 — high demerit week</p>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ── Merits & Demerits — collapsible two-column ── */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0">
          {/* Collapsible header */}
          <button
            onClick={() => setMdCollapsed(v => !v)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors rounded-xl"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-1 h-5 rounded-full bg-gradient-to-b from-emerald-500 to-teal-600" />
                <div className="w-1 h-5 rounded-full bg-gradient-to-b from-red-500 to-rose-600" />
              </div>
              <span className="text-sm font-bold text-foreground">Merits &amp; Demerits</span>
            </div>
            <div className="flex items-center gap-2">
              {totalMerits > 0 && (
                <Badge className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-0 text-[10px] font-bold">
                  +${totalMerits.toFixed(2)}
                </Badge>
              )}
              {totalDemerits > 0 && (
                <Badge className="bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-0 text-[10px] font-bold">
                  −${totalDemerits.toFixed(2)}
                </Badge>
              )}
              {mdCollapsed
                ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
            </div>
          </button>

          {!mdCollapsed && (
            <div className="px-5 pb-5">
              {/* Two-column grid: Merits left | Demerits right */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

                {/* ── LEFT: Merits ── */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-5 rounded-full bg-gradient-to-b from-emerald-500 to-teal-600" />
                    <h3 className="text-sm font-bold text-foreground">Merits</h3>
                    <Star className="w-3.5 h-3.5 text-emerald-500" />
                  </div>
                  <div className="space-y-1.5">
                    {MERITS.map((merit) => {
                      const clr = meritColorMap[merit.color];
                      const isActive = counts[merit.key] > 0;
                      return (
                        <CollapsibleItem
                          key={merit.key}
                          defaultOpen={isActive}
                          header={
                            <div className={`flex items-center gap-2.5 p-2.5 border rounded-lg cursor-pointer select-none transition-colors ${clr.bg} hover:brightness-95`}>
                              {/* Code badge */}
                              <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 font-bold text-[10px] text-white bg-gradient-to-br ${
                                merit.color === "emerald" ? "from-emerald-500 to-emerald-600" :
                                merit.color === "teal" ? "from-teal-500 to-teal-600" :
                                merit.color === "sky" ? "from-sky-500 to-sky-600" :
                                "from-amber-500 to-amber-600"
                              }`}>
                                {merit.code}
                              </div>
                              <span className="flex-1 text-xs font-semibold text-foreground truncate">{merit.label}</span>
                              <span className={`text-[10px] font-bold ${clr.text} mr-1`}>+${merit.amount.toFixed(2)}</span>
                              <Counter
                                value={counts[merit.key]}
                                onDecrement={() => adjust(merit.key, -1)}
                                onIncrement={() => adjust(merit.key, 1)}
                                btnClass={clr.btn}
                                isFounder={isFounder}
                                disabled={!canEdit}
                              />
                            </div>
                          }
                        >
                          <div className={`px-3 pb-2.5 pt-1 border-x border-b rounded-b-lg -mt-1 ${clr.bg}`}>
                            <p className={`text-[10px] leading-relaxed ${clr.text}`}>{merit.desc}</p>
                          </div>
                        </CollapsibleItem>
                      );
                    })}
                  </div>
                </div>

                {/* ── RIGHT: Demerits ── */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-1 h-5 rounded-full bg-gradient-to-b from-red-500 to-rose-600" />
                    <h3 className="text-sm font-bold text-foreground">Demerits</h3>
                    <TriangleAlert className="w-3.5 h-3.5 text-red-500" />
                  </div>
                  <div className="space-y-1.5">
                    {DEMERITS.map((demerit) => {
                      const isActive = counts[demerit.key] > 0;
                      return (
                        <CollapsibleItem
                          key={demerit.key}
                          defaultOpen={isActive}
                          header={
                            <div className="flex items-center gap-2.5 p-2.5 bg-red-50/50 dark:bg-red-950/10 border border-red-200/40 dark:border-red-800/20 rounded-lg cursor-pointer select-none hover:brightness-95 transition-colors">
                              {/* Code badge */}
                              <div className="w-7 h-7 rounded-md bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                                <span className="text-red-700 dark:text-red-300 text-[10px] font-bold">{demerit.code}</span>
                              </div>
                              <span className="flex-1 text-xs font-semibold text-foreground truncate">{demerit.label}</span>
                              <span className="text-[10px] font-bold text-red-600 dark:text-red-400 mr-1">−${demerit.amount.toFixed(2)}</span>
                              <Counter
                                value={counts[demerit.key]}
                                onDecrement={() => adjust(demerit.key, -1)}
                                onIncrement={() => adjust(demerit.key, 1)}
                                btnClass="bg-red-500 hover:bg-red-600"
                                isFounder={isFounder}
                                disabled={!canEdit}
                              />
                            </div>
                          }
                        >
                          <div className="px-3 pb-2.5 pt-1 bg-red-50/50 dark:bg-red-950/10 border-x border-b border-red-200/40 dark:border-red-800/20 rounded-b-lg -mt-1">
                            <span className="text-[9px] text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5 mr-1.5">{demerit.freq}</span>
                            <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{demerit.trigger}</p>
                          </div>
                        </CollapsibleItem>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Summary note */}
              <div className="mt-4 bg-muted/40 rounded-lg p-3 border border-border/50 text-xs text-muted-foreground">
                There is no upper or lower cap on the final pay. You receive a copy of the completed weekly log — showing every merit and demerit, its date, and its value — alongside your payment.
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Notes + Save ── */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-1 h-6 rounded-full bg-gradient-to-b from-slate-400 to-slate-600"></div>
            <h2 className="text-base font-bold text-foreground">Notes</h2>
          </div>
          {!isFounder ? (
            notes ? (
              <div className="p-3 bg-muted/40 rounded-lg text-sm text-foreground whitespace-pre-wrap">
                {notes}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No notes for this week.</p>
            )
          ) : (
            <>
              {saveConflict && (
                <div role="alert" className="flex items-center justify-between gap-3 text-sm text-amber-700 dark:text-amber-400">
                  <span>This week changed. Reload the saved record before saving.</span>
                  <Button variant="outline" size="sm" onClick={async () => {
                    const result = await weekQuery.refetch();
                    if (!result.isError) {
                      setLoaded(false);
                      setSavedThisSession(false);
                      setSaveConflict(false);
                    }
                  }}><RefreshCw className="mr-2 h-4 w-4" />Reload saved week</Button>
                </div>
              )}
              <Textarea
                placeholder="Optional notes for this week (e.g., context for demerits, special circumstances)..."
                value={notes}
                disabled={!canEdit}
                onChange={e => setNotes(e.target.value)}
                className="text-sm resize-none"
                rows={3}
              />
              <Button
                onClick={handleSave}
                disabled={!canEdit}
                className="w-full bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white font-semibold"
              >
                <Save className="w-4 h-4 mr-2" />
                {upsert.isPending ? "Saving..." : "Save Week Log"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Pay History Chart ── */}
      {history && history.length >= 2 && (
        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-1 h-6 rounded-full bg-gradient-to-b from-violet-500 to-indigo-600"></div>
              <h2 className="text-base font-bold text-foreground">Pay Trend</h2>
              <span className="text-xs text-muted-foreground">(last {history.length} weeks)</span>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart
                data={[...history].reverse().map(log => ({
                  week: (() => {
                    const d = new Date(log.weekStart + "T12:00:00");
                    return `Wk ${d.toLocaleString("default", { month: "short" })} ${d.getDate()}`;
                  })(),
                  pay: Number(log.projectedPay),
                }))}
                margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="week"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[(dataMin: number) => Math.min(0, dataMin - 10), 120]}
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  formatter={(value: number) => [`$${value.toFixed(2)}`, "Projected Pay"]}
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <ReferenceLine y={90} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" label={{ value: "Base $90", position: "insideTopRight", fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                <Bar dataKey="pay" radius={[4, 4, 0, 0]} maxBarSize={40}>
                  {[...history].reverse().map((log, i) => {
                    const pay = Number(log.projectedPay);
                    const color = pay >= 90
                      ? "hsl(142, 71%, 45%)"
                      : pay >= 70
                      ? "hsl(38, 92%, 50%)"
                      : "hsl(0, 84%, 60%)";
                    return <Cell key={i} fill={color} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-4 mt-2 justify-center">
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />Full pay ($90+)
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" />Partial ($70–89)
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" />Low (below $70)
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Pay History ── */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-5">
          <button
            onClick={() => setShowHistory(v => !v)}
            className="w-full flex items-center justify-between"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-1 h-6 rounded-full bg-gradient-to-b from-slate-400 to-slate-600"></div>
              <h2 className="text-base font-bold text-foreground">Pay History</h2>
            </div>
            <History className="w-4 h-4 text-muted-foreground" />
          </button>
          {showHistory && (
            <div className="mt-4 space-y-2">
              {!history || history.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No history yet. Save a week log above.</p>
              ) : (
                history.map((log, idx) => {
                  const pay = Number(log.projectedPay);
                  const demerits = Number(log.totalDemerits);
                  const merits = Number(log.totalMerits);
                  const payClr = pay >= 90
                    ? "text-emerald-600 dark:text-emerald-400"
                    : pay >= 70
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-red-600 dark:text-red-400";
                  // Anchor ID for compliance table "→ Pay log" scroll-links
                  const wStart = typeof log.weekStart === "string"
                    ? log.weekStart
                    : new Date(log.weekStart).toISOString().slice(0, 10);
                  // Previous week (history is sorted newest-first, so idx+1 is the prior week)
                  const prevLog = history[idx + 1];
                  const prevWStart = prevLog
                    ? (typeof prevLog.weekStart === "string" ? prevLog.weekStart : new Date(prevLog.weekStart).toISOString().slice(0, 10))
                    : null;
                  return (
                    <PayHistoryRow
                      key={log.id}
                      id={`pay-log-week-${wStart}`}
                      weekStart={wStart}
                      prevWeekStart={prevWStart}
                      weekStartLabel={formatDate(log.weekStart)}
                      weekEndLabel={formatDate(log.weekEnd)}
                      pay={pay}
                      payClr={payClr}
                      demerits={demerits}
                      merits={merits}
                    />
                  );
                })
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* D1 edit guard dialog */}
      <AlertDialog open={d1GuardPending !== null} onOpenChange={open => { if (!open) setD1GuardPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lower D1 below auto-set value?</AlertDialogTitle>
            <AlertDialogDescription>
              The EOD cron automatically set D1 to <strong>{savedD1}</strong> for this week based on missed Trello updates.
              Lowering it below that value will override the auto-recorded demerit.
              Are you sure you want to reduce D1?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setD1GuardPending(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmD1Decrease}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Yes, reduce D1
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
