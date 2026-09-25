/**
 * PriorityCommandCenter — Full operations control panel for Admin.
 *
 * Upgraded from the old risk list to a full operations control panel:
 *   1. Sticky top summary bar: Critical / Needs Decision / Auto-handled / Waiting External
 *   2. Five priority buckets (collapsible groups)
 *   3. Each card shows: why-shown, next best action, confidence chip, checklist progress
 *   4. ON-HOLD cards show smart sub-classification with action buttons
 *   5. Batch actions: keep on hold, move to doing, draft daily updates, snooze
 *   6. Escalation rules panel
 *   7. Automation history per card (inline expandable)
 */
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Zap,
  Pause,
  ArrowRight,
  Users,
  Wrench,
  History,
  Shield,
  BarChart2,
  BellRing,
  Copy,
  CheckCheck,
  Eye,
  EyeOff,
} from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────────────────────
type EnrichedCard = {
  cardId: string;
  cardName: string;
  cardUrl: string;
  boardName: string;
  listName: string;
  state: string;
  stateReason: string | null;
  tier: string;
  score: number;
  isOverdue: boolean;
  daysSinceProgress: number;
  hasUnansweredQuestion: boolean;
  checklistProgress: { completed: number; total: number; pct: number };
  nextBestAction: string | null;
  confidenceScore: number | null;
  confidenceLabel: "High" | "Medium" | "Low";
  confidenceReason: string | null;
  scoreBreakdown: {
    planClarity: number;
    checklistClarity: number;
    activityScore: number;
    total: number;
    reason: string;
  } | null;
  escalationCategory: string | null;
  AdminDecision: string | null;
  urgencyLabel: string | null;
  openAdminSteps: number;
  whyShown: string;
  onHoldClassification: string | null;
};

// ── Style helpers ─────────────────────────────────────────────────────────────
const TIER_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  CRITICAL: { bg: "bg-red-500/10",    text: "text-red-600 dark:text-red-400",       border: "border-red-500/30" },
  HIGH:     { bg: "bg-orange-500/10", text: "text-orange-600 dark:text-orange-400", border: "border-orange-500/30" },
  MEDIUM:   { bg: "bg-amber-500/10",  text: "text-amber-600 dark:text-amber-400",   border: "border-amber-500/30" },
  LOW:      { bg: "bg-slate-500/10",  text: "text-slate-500 dark:text-slate-400",   border: "border-slate-500/30" },
  BLOCKED:  { bg: "bg-purple-500/10", text: "text-purple-600 dark:text-purple-400", border: "border-purple-500/30" },
};

const CONFIDENCE_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  High:   { bg: "bg-green-500/10",  text: "text-green-600 dark:text-green-400",  border: "border-green-500/30" },
  Medium: { bg: "bg-amber-500/10",  text: "text-amber-600 dark:text-amber-400",  border: "border-amber-500/30" },
  Low:    { bg: "bg-red-500/10",    text: "text-red-600 dark:text-red-400",      border: "border-red-500/30" },
};

const ON_HOLD_LABELS: Record<string, { label: string; color: string; desc: string }> = {
  still_waiting:    { label: "Still Waiting",      color: "text-slate-500",                          desc: "No new activity — keep on hold" },
  ready_to_resume:  { label: "Ready to Resume",    color: "text-green-600 dark:text-green-400",      desc: "New activity detected — can move to DOING" },
  needs_escalation: { label: "Needs Escalation",   color: "text-orange-600 dark:text-orange-400",    desc: "Too long idle or deadline approaching" },
  possibly_obsolete:{ label: "Possibly Obsolete",  color: "text-slate-400",                          desc: "Long idle, no deadline, may no longer be relevant" },
  needs_Admin:     { label: "Needs Admin",        color: "text-red-600 dark:text-red-400",          desc: "System cannot safely decide — Admin's input required" },
};

// ── Sub-components ────────────────────────────────────────────────────────────
function TierChip({ tier }: { tier: string }) {
  const s = TIER_STYLES[tier] ?? TIER_STYLES.MEDIUM;
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${s.bg} ${s.border} ${s.text}`}>
      {tier}
    </span>
  );
}

function ConfidenceChip({
  label,
  score,
  breakdown,
}: {
  label: string;
  score: number | null;
  breakdown?: EnrichedCard["scoreBreakdown"];
}) {
  const s = CONFIDENCE_STYLES[label] ?? CONFIDENCE_STYLES.Medium;
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full border flex-shrink-0 ${s.bg} ${s.border} ${s.text} cursor-pointer hover:opacity-80 transition-opacity`}
        title="Click for confidence breakdown"
      >
        {label} {score != null ? `${score}%` : ""}
      </button>
      {open && breakdown && (
        <div className="absolute left-0 top-5 z-50 w-72 bg-popover border border-border rounded-lg shadow-xl p-3 text-xs text-popover-foreground">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-foreground">Confidence Breakdown</span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">✕</button>
          </div>
          <div className="space-y-1.5 mb-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Plan clarity</span>
              <div className="flex items-center gap-1.5">
                <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(breakdown.planClarity / 40 * 100, 100)}%` }} />
                </div>
                <span className="font-medium text-foreground w-6 text-right">{breakdown.planClarity}</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Checklist progress</span>
              <div className="flex items-center gap-1.5">
                <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${Math.min(breakdown.checklistClarity / 40 * 100, 100)}%` }} />
                </div>
                <span className="font-medium text-foreground w-6 text-right">{breakdown.checklistClarity}</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Recent activity</span>
              <div className="flex items-center gap-1.5">
                <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.min(breakdown.activityScore / 20 * 100, 100)}%` }} />
                </div>
                <span className="font-medium text-foreground w-6 text-right">{breakdown.activityScore}</span>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-border/50 pt-1 mt-1">
              <span className="font-semibold text-foreground">Total</span>
              <span className={`font-bold ${s.text}`}>{breakdown.total}%</span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">{breakdown.reason}</p>
        </div>
      )}
    </div>
  );
}

function ChecklistBar({ completed, total, pct }: { completed: number; total: number; pct: number }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-slate-400"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground flex-shrink-0">
        {completed}/{total} · {pct}%
      </span>
    </div>
  );
}

function WhyShownTooltip({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5"
        title="Why is this shown?"
      >
        <Eye className="w-3 h-3" />
        Why?
      </button>
      {open && (
        <div className="absolute left-0 top-5 z-50 w-64 bg-popover border border-border rounded-lg shadow-lg p-3 text-xs text-popover-foreground">
          {reason}
          <button onClick={() => setOpen(false)} className="absolute top-1 right-1 text-muted-foreground hover:text-foreground">
            <EyeOff className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function CardAuditLog({ cardId }: { cardId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = trpc.aptlss.getCardAuditLog.useQuery(
    { cardId, limit: 10 },
    { enabled: open, staleTime: 60_000 }
  );
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5"
      >
        <History className="w-3 h-3" />
        History
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-2 space-y-1 border-l-2 border-muted pl-3">
          {isLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
          {data?.length === 0 && <p className="text-[10px] text-muted-foreground">No automation history yet.</p>}
          {data?.map(entry => (
            <div key={entry.id} className="text-[10px] text-muted-foreground">
              <span className="text-foreground font-medium">
                {new Date(entry.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
              {" — "}
              <span className="font-medium text-foreground">{entry.action.replace(/_/g, ' ')}</span>
              {" — "}
              {entry.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main card row ─────────────────────────────────────────────────────────────
function CardRow({
  card,
  selected,
  onToggleSelect,
  showOnHoldActions,
  onKeepOnHold,
  onMoveToDoing,
  onDraftUpdate,
}: {
  card: EnrichedCard;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  showOnHoldActions?: boolean;
  onKeepOnHold?: (id: string) => void;
  onMoveToDoing?: (id: string) => void;
  onDraftUpdate?: (id: string, name: string) => void;
}) {
  const s = TIER_STYLES[card.tier] ?? TIER_STYLES.MEDIUM;
  const ohInfo = card.onHoldClassification ? ON_HOLD_LABELS[card.onHoldClassification] : null;

  return (
    <div className={`rounded-lg border p-3 transition-all ${selected ? "ring-2 ring-blue-500/50 " + s.border : s.border} ${s.bg}`}>
      {/* Top row */}
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(card.cardId)}
          className="mt-1 flex-shrink-0 accent-blue-500"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <TierChip tier={card.tier} />
            <ConfidenceChip label={card.confidenceLabel} score={card.confidenceScore} breakdown={card.scoreBreakdown ?? undefined} />
            {card.isOverdue && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/20 border border-red-500/40 text-red-600 dark:text-red-400">
                OVERDUE
              </span>
            )}
            {ohInfo && (
              <span className={`text-[9px] font-medium ${ohInfo.color}`}>
                {ohInfo.label}
              </span>
            )}
          </div>
          <a
            href={card.cardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm font-medium text-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors mt-1 group"
          >
            <span className="truncate">{card.cardName}</span>
            <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </a>
          {/* Meta: list name, idle days, unanswered question */}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {card.listName && (
              <span className="text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                {card.listName}
              </span>
            )}
            {card.daysSinceProgress > 0 && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                card.daysSinceProgress >= 14
                  ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                  : card.daysSinceProgress >= 7
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-muted/60 text-muted-foreground'
              }`}>
                {card.daysSinceProgress}d idle
              </span>
            )}
            {card.hasUnansweredQuestion && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
                ❓ Unanswered Q
              </span>
            )}
          </div>
          {/* Checklist progress */}
          <ChecklistBar {...card.checklistProgress} />
          {/* Next best action */}
          {card.nextBestAction && (
            <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
              <ArrowRight className="w-3 h-3 flex-shrink-0 mt-0.5 text-blue-500" />
              <span>
                <span className="font-medium text-foreground">Recommended:</span> {card.nextBestAction}
              </span>
            </p>
          )}
          {/* Why shown + history */}
          <div className="flex items-center gap-3 mt-1.5">
            <WhyShownTooltip reason={card.whyShown} />
            <CardAuditLog cardId={card.cardId} />
          </div>
        </div>
      </div>

      {/* ON-HOLD action buttons */}
      {showOnHoldActions && ohInfo && (
        <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-border/50">
          <p className="text-[10px] text-muted-foreground w-full mb-1">{ohInfo.desc}</p>
          {card.onHoldClassification === 'ready_to_resume' && (
            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => onMoveToDoing?.(card.cardId)}>
              <ArrowRight className="w-3 h-3 mr-1" /> Move to DOING
            </Button>
          )}
          {(card.onHoldClassification === 'still_waiting' || card.onHoldClassification === 'possibly_obsolete') && (
            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => onKeepOnHold?.(card.cardId)}>
              <Pause className="w-3 h-3 mr-1" /> Keep ON-HOLD
            </Button>
          )}
          {card.onHoldClassification === 'needs_Admin' && (
            <span className="text-[10px] text-red-600 dark:text-red-400 font-medium flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> Needs Admin decision
            </span>
          )}
        </div>
      )}

      {/* DOING card: draft update button */}
      {card.state === 'IN_PROGRESS' && onDraftUpdate && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => onDraftUpdate(card.cardId, card.cardName)}>
            <BarChart2 className="w-3 h-3 mr-1" /> Draft Daily Update
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Collapsible bucket section ────────────────────────────────────────────────
function BucketSection({
  icon,
  title,
  description,
  count,
  cards,
  colorClass,
  defaultOpen = true,
  selectedIds,
  onToggleSelect,
  showOnHoldActions,
  onKeepOnHold,
  onMoveToDoing,
  onDraftUpdate,
  batchActions,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  count: number;
  cards: EnrichedCard[];
  colorClass: string;
  defaultOpen?: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  showOnHoldActions?: boolean;
  onKeepOnHold?: (id: string) => void;
  onMoveToDoing?: (id: string) => void;
  onDraftUpdate?: (id: string, name: string) => void;
  batchActions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-3 p-4 ${colorClass} hover:opacity-90 transition-opacity`}
      >
        <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <div className="flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{title}</span>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white/20">{count}</span>
          </div>
          <p className="text-xs opacity-70 mt-0.5">{description}</p>
        </div>
        {open ? <ChevronUp className="w-4 h-4 opacity-60" /> : <ChevronDown className="w-4 h-4 opacity-60" />}
      </button>
      {open && (
        <div className="p-4 space-y-2 bg-background">
          {batchActions && <div className="mb-3">{batchActions}</div>}
          {cards.map(card => (
            <CardRow
              key={card.cardId}
              card={card}
              selected={selectedIds.has(card.cardId)}
              onToggleSelect={onToggleSelect}
              showOnHoldActions={showOnHoldActions}
              onKeepOnHold={onKeepOnHold}
              onMoveToDoing={onMoveToDoing}
              onDraftUpdate={onDraftUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Daily Update Draft Modal ──────────────────────────────────────────────────
function DailyUpdateDraftModal({
  drafts,
  onClose,
}: {
  drafts: Array<{ cardId: string; cardName: string; cardUrl: string; draft: string; confidenceScore: number }>;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  if (drafts.length === 0) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-foreground">Daily Update Drafts</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
        </div>
        <div className="p-4 space-y-4">
          {drafts.map(d => (
            <div key={d.cardId} className="border border-border rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <a href={d.cardUrl} target="_blank" rel="noopener noreferrer"
                  className="text-sm font-medium text-foreground hover:text-blue-600 flex items-center gap-1">
                  {d.cardName} <ExternalLink className="w-3 h-3" />
                </a>
                <ConfidenceChip
                  label={d.confidenceScore >= 80 ? 'High' : d.confidenceScore >= 60 ? 'Medium' : 'Low'}
                  score={d.confidenceScore}
                />
              </div>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans bg-muted/50 rounded p-2">{d.draft}</pre>
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    navigator.clipboard.writeText(d.draft);
                    setCopied(d.cardId);
                    setTimeout(() => setCopied(null), 2000);
                  }}
                >
                  {copied === d.cardId ? <CheckCheck className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
                  Copy draft
                </Button>
                <span className="self-center text-xs text-muted-foreground">Review and send it directly in Trello.</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function PriorityCommandCenter() {
  const utils = trpc.useUtils();

  const { data, isLoading, isFetching, refetch } = trpc.aptlss.getCommandCenter.useQuery(undefined, {
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const { data: escalations } = trpc.aptlss.getEscalationRules.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [snoozeDays, setSnoozeDays] = useState<number>(7);
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false);
  const [draftModalData, setDraftModalData] = useState<Array<{
    cardId: string; cardName: string; cardUrl: string;
    draft: string; confidenceScore: number;
  }>>([]);
  const [showEscalations, setShowEscalations] = useState(false);

  const batchKeepOnHold = trpc.aptlss.batchKeepOnHold.useMutation({
    onSuccess: (res) => {
      toast.success(`Kept ${res.count} card(s) on hold`, { description: "Audit log updated." });
      utils.aptlss.getCommandCenter.invalidate();
    },
  });
  const batchMoveToDoing = trpc.aptlss.batchMoveToDoing.useMutation({
    onSuccess: (res) => {
      toast.success(`Moved ${res.count} card(s) to DOING`, { description: "Trello card state updated." });
      utils.aptlss.getCommandCenter.invalidate();
    },
  });
  const batchDraftUpdates = trpc.aptlss.batchDraftDailyUpdates.useMutation({
    onSuccess: (res) => setDraftModalData(res.drafts),
  });
  const batchSnooze = trpc.aptlss.batchSnooze.useMutation({
    onSuccess: (res) => {
      toast.success(`Snoozed ${res.count} card(s) for ${snoozeDays} day${snoozeDays !== 1 ? 's' : ''}`);
      setSelectedIds(new Set());
      setShowSnoozeMenu(false);
    },
  });

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedArray = Array.from(selectedIds);
  const summary = data?.summary;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">Loading Priority Command Center…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* ── Sticky Summary Bar ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border">
        <div className="container py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Link href="/Admin">
                <Button variant="ghost" size="sm" className="h-7 text-xs">← Back</Button>
              </Link>
              <h1 className="text-sm font-semibold text-foreground">Priority Command Center</h1>
              {isFetching && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
            </div>
            {/* Summary chips */}
            {summary && (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                  <span className="text-xs font-bold text-red-600 dark:text-red-400">{summary.criticalCount} Critical</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-500/10 border border-orange-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                  <span className="text-xs font-bold text-orange-600 dark:text-orange-400">{summary.needsDecisionCount} Decisions</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/10 border border-green-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  <span className="text-xs font-bold text-green-600 dark:text-green-400">{summary.autoHandledCount} Auto-handled</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                  <span className="text-xs font-bold text-blue-600 dark:text-blue-400">{summary.waitingExternalCount} Waiting</span>
                </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border">
                <span className="text-xs text-muted-foreground">{summary.totalActive} active</span>
              </div>
              <span className="text-[10px] text-muted-foreground hidden sm:inline">
                Updated {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => refetch()}>
                <RefreshCw className="w-3 h-3 mr-1" /> Refresh
              </Button>
              <Link href="/admin">
                <Button variant="outline" size="sm" className="h-7 text-xs">
                  <Shield className="w-3 h-3 mr-1" /> Admin
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="container py-6 space-y-4">
        {/* ── Batch Action Bar ──────────────────────────────────────────────── */}
        {selectedIds.size > 0 && (
          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardContent className="p-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium text-foreground">{selectedIds.size} card(s) selected</span>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => batchKeepOnHold.mutate({ cardIds: selectedArray })}
                    disabled={batchKeepOnHold.isPending}>
                    <Pause className="w-3 h-3 mr-1" /> Keep ON-HOLD
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => batchMoveToDoing.mutate({ cardIds: selectedArray })}
                    disabled={batchMoveToDoing.isPending}>
                    <ArrowRight className="w-3 h-3 mr-1" /> Move to DOING
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => batchDraftUpdates.mutate({ cardIds: selectedArray })}
                    disabled={batchDraftUpdates.isPending}>
                    {batchDraftUpdates.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <BarChart2 className="w-3 h-3 mr-1" />}
                    Draft Updates
                  </Button>
                  <div className="relative">
                    <div className="flex items-stretch rounded-md border border-border overflow-hidden h-7">
                      <button
                        className="flex items-center gap-1 px-2 text-xs bg-background hover:bg-muted transition-colors disabled:opacity-50"
                        onClick={() => batchSnooze.mutate({ cardIds: selectedArray, days: snoozeDays })}
                        disabled={batchSnooze.isPending}
                      >
                        <Clock className="w-3 h-3" /> Snooze {snoozeDays}d
                      </button>
                      <button
                        className="px-1.5 text-xs bg-background hover:bg-muted border-l border-border transition-colors"
                        onClick={() => setShowSnoozeMenu(o => !o)}
                        title="Change snooze duration"
                      >
                        ▾
                      </button>
                    </div>
                    {showSnoozeMenu && (
                      <div className="absolute bottom-8 left-0 z-50 bg-popover border border-border rounded-lg shadow-xl p-1 min-w-[140px]">
                        {[3, 7, 14, 30].map(d => (
                          <button
                            key={d}
                            className={`w-full text-left px-3 py-1.5 text-xs rounded hover:bg-muted transition-colors ${snoozeDays === d ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
                            onClick={() => { setSnoozeDays(d); setShowSnoozeMenu(false); }}
                          >
                            {d} days
                          </button>
                        ))}
                        <div className="border-t border-border/50 mt-1 pt-1 px-2">
                          <label className="text-[10px] text-muted-foreground block mb-0.5">Custom (days)</label>
                          <input
                            type="number" min={1} max={365}
                            defaultValue={snoozeDays}
                            className="w-full text-xs border border-border rounded px-1.5 py-0.5 bg-background text-foreground"
                            onChange={e => { const v = parseInt(e.target.value); if (v > 0 && v <= 365) setSnoozeDays(v); }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground"
                    onClick={() => setSelectedIds(new Set())}>
                    Clear
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Escalation Rules Alert ────────────────────────────────────────── */}
        {escalations && escalations.totalCount > 0 && (
          <Card className="border-orange-500/30 bg-orange-500/5">
            <CardContent className="p-3">
              <button
                onClick={() => setShowEscalations(o => !o)}
                className="w-full flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <BellRing className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                  <span className="text-sm font-semibold text-orange-700 dark:text-orange-300">
                    {escalations.totalCount} Escalation Rule{escalations.totalCount !== 1 ? 's' : ''} Triggered
                  </span>
                </div>
                {showEscalations ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
              </button>
              {showEscalations && (
                <div className="mt-3 space-y-2">
                  {escalations.triggered.map((e, i) => (
                    <div key={i} className="flex items-start gap-2 p-2 bg-background rounded-lg border border-orange-500/20">
                      <AlertTriangle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <a href={e.cardUrl} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-medium text-foreground hover:text-blue-600 truncate">
                            {e.cardName}
                          </a>
                          <TierChip tier={e.tier} />
                        </div>
                        <p className="text-[10px] text-muted-foreground">{e.ruleDescription}</p>
                        <p className="text-[10px] text-orange-600 dark:text-orange-400 font-medium mt-0.5">→ {e.recommendedAction}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Bucket 1: Critical Today ──────────────────────────────────────── */}
        <BucketSection
          icon={<AlertCircle className="w-4 h-4 text-red-400" />}
          title="Critical Today"
          description="Legal, financial, overdue, or deadline-sensitive — requires immediate attention"
          count={data?.criticalToday.length ?? 0}
          cards={data?.criticalToday ?? []}
          colorClass="bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20"
          defaultOpen={true}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onDraftUpdate={(id, name) => batchDraftUpdates.mutate({ cardIds: [id] })}
        />

        {/* ── Bucket 2: Ready to Act ────────────────────────────────────────── */}
        <BucketSection
          icon={<Zap className="w-4 h-4 text-green-400" />}
          title="Ready to Act"
          description="Can move forward without Admin — Worker can handle these now"
          count={data?.readyToAct.length ?? 0}
          cards={data?.readyToAct ?? []}
          colorClass="bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/20"
          defaultOpen={true}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onDraftUpdate={(id, name) => batchDraftUpdates.mutate({ cardIds: [id] })}
          batchActions={
            (data?.readyToAct.length ?? 0) > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  const ids = (data?.readyToAct ?? []).filter(c => (c.confidenceScore ?? 0) >= 80).map(c => c.cardId);
                  if (ids.length === 0) { toast.info("No high-confidence cards found"); return; }
                  batchDraftUpdates.mutate({ cardIds: ids });
                }}
                disabled={batchDraftUpdates.isPending}
              >
                {batchDraftUpdates.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <BarChart2 className="w-3 h-3 mr-1" />}
                Draft All High-Confidence Updates
              </Button>
            ) : undefined
          }
        />

        {/* ── Bucket 3: Waiting External ────────────────────────────────────── */}
        <BucketSection
          icon={<Users className="w-4 h-4 text-blue-400" />}
          title="Waiting External"
          description="Someone else must reply first — prepare a draft for the worker to review and send"
          count={data?.waitingExternal.length ?? 0}
          cards={data?.waitingExternal ?? []}
          colorClass="bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20"
          defaultOpen={false}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
        />

        {/* ── Bucket 4: Needs Admin Decision ──────────────────────────────── */}
        <BucketSection
          icon={<AlertTriangle className="w-4 h-4 text-orange-400" />}
          title="Needs Admin Decision"
          description="Only items where your yes/no is truly required"
          count={data?.needsAdminDecision.length ?? 0}
          cards={data?.needsAdminDecision ?? []}
          colorClass="bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/20"
          defaultOpen={true}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
        />

        {/* ── Bucket 5: Low-Risk Maintenance ───────────────────────────────── */}
        <BucketSection
          icon={<Wrench className="w-4 h-4 text-slate-400" />}
          title="Low-Risk Maintenance"
          description="Can be postponed or auto-cleaned — no urgent action needed"
          count={data?.lowRiskMaintenance.length ?? 0}
          cards={data?.lowRiskMaintenance ?? []}
          colorClass="bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20"
          defaultOpen={false}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          batchActions={
            (data?.lowRiskMaintenance.length ?? 0) > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  const ids = (data?.lowRiskMaintenance ?? []).map(c => c.cardId);
                  batchSnooze.mutate({ cardIds: ids, days: snoozeDays });
                }}
                disabled={batchSnooze.isPending}
              >
                <Clock className="w-3 h-3 mr-1" /> Snooze All for {snoozeDays} Days
              </Button>
            ) : undefined
          }
        />

        {/* ── ON-HOLD Smart Classification ──────────────────────────────────── */}
        <BucketSection
          icon={<Pause className="w-4 h-4 text-indigo-400" />}
          title="ON-HOLD Cards"
          description="Smart classification: Still Waiting / Ready to Resume / Needs Escalation / Possibly Obsolete / Needs Admin"
          count={data?.onHoldCards.length ?? 0}
          cards={data?.onHoldCards ?? []}
          colorClass="bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20"
          defaultOpen={false}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          showOnHoldActions={true}
          onKeepOnHold={(id) => batchKeepOnHold.mutate({ cardIds: [id] })}
          onMoveToDoing={(id) => batchMoveToDoing.mutate({ cardIds: [id] })}
          batchActions={
            (data?.onHoldCards.length ?? 0) > 0 ? (
              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    const ids = (data?.onHoldCards ?? [])
                      .filter(c => c.onHoldClassification === 'still_waiting' || c.onHoldClassification === 'possibly_obsolete')
                      .map(c => c.cardId);
                    if (ids.length === 0) { toast.info("No low-risk ON-HOLD cards found"); return; }
                    batchKeepOnHold.mutate({ cardIds: ids });
                  }}
                  disabled={batchKeepOnHold.isPending}
                >
                  <Pause className="w-3 h-3 mr-1" /> Keep All Low-Risk ON-HOLD
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    const ids = (data?.onHoldCards ?? [])
                      .filter(c => c.onHoldClassification === 'ready_to_resume')
                      .map(c => c.cardId);
                    if (ids.length === 0) { toast.info("No ready-to-resume cards found"); return; }
                    batchMoveToDoing.mutate({ cardIds: ids });
                  }}
                  disabled={batchMoveToDoing.isPending}
                >
                  <ArrowRight className="w-3 h-3 mr-1" /> Move All Ready-to-Resume to DOING
                </Button>
              </div>
            ) : undefined
          }
        />

        {/* ── Empty state ───────────────────────────────────────────────────── */}
        {data && summary && summary.totalActive === 0 && (
          <Card className="border-green-500/30 bg-green-500/5">
            <CardContent className="p-8 text-center">
              <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
              <h3 className="font-semibold text-foreground">All Clear</h3>
              <p className="text-sm text-muted-foreground mt-1">No active cards require attention right now.</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Daily Update Draft Modal ──────────────────────────────────────────── */}
      {draftModalData.length > 0 && (
        <DailyUpdateDraftModal
          drafts={draftModalData}
          onClose={() => setDraftModalData([])}
        />
      )}
    </div>
  );
}
