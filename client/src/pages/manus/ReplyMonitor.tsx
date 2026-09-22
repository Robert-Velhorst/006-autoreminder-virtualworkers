/**
 * ReplyMonitor — Trello reply-thread monitoring dashboard.
 *
 * Shows:
 * 1. Active unanswered threads (pending / overdue) with 12h countdown
 * 2. Active vague-reply flags with 1h correction countdown
 * 3. History of all threads and resolved flags
 */
import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Clock,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  RefreshCw,
  MessageSquare,
  AlertCircle,
  XCircle,
  ChevronDown,
  ChevronUp,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
// ─── Countdown helpers ────────────────────────────────────────────────────────

function useCountdown(targetMs: number): { label: string; isExpired: boolean; urgency: "ok" | "warn" | "critical" } {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    // Update every 5 min — minute-level precision is sufficient for the countdown.
    const id = setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => clearInterval(id);
  }, []);
  const remaining = targetMs - now;
  if (remaining <= 0) return { label: "Overdue", isExpired: true, urgency: "critical" };
  const hours = Math.floor(remaining / 3_600_000);
  const mins = Math.floor((remaining % 3_600_000) / 60_000);
  const label = hours > 0 ? `${hours}h ${mins}m left` : `${mins}m left`;
  const urgency = remaining < 60 * 60 * 1000 ? "critical" : remaining < 3 * 60 * 60 * 1000 ? "warn" : "ok";
  return { label, isExpired: false, urgency };
}

function CountdownBadge({ targetMs }: { targetMs: number }) {
  const { label, urgency } = useCountdown(targetMs);
  const cls =
    urgency === "critical"
      ? "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400"
      : urgency === "warn"
      ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
      : "bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-400";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${cls}`}>
      <Clock className="w-3 h-3" />
      {label}
    </span>
  );
}

// ─── Thread card ──────────────────────────────────────────────────────────────

function ThreadCard({
  thread,
}: {
  thread: {
    id: number;
    source: string;
    cardId: string;
    cardName: string;
    cardUrl: string;
    boardName: string;
    listName: string;
    lastNonWorkerMsgAt: Date;
    lastNonWorkerAuthor: string;
    lastNonWorkerText: string | null;
    lastWorkerReplyAt: Date | null;
    status: string;
    demerited: boolean;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const deadline = new Date(thread.lastNonWorkerMsgAt).getTime() + 12 * 60 * 60 * 1000;
  const isOverdue = thread.status === "overdue";

  return (
    <div
      className={`rounded-lg border p-4 space-y-2 ${
        isOverdue
          ? "border-red-400/40 bg-red-500/5"
          : "border-amber-400/40 bg-amber-500/5"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={thread.cardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-sm text-foreground hover:underline flex items-center gap-1 truncate"
            >
              {thread.cardName}
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
            {thread.demerited && (
              <Badge variant="outline" className="text-xs bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400">
                D1 issued
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {thread.boardName} › {thread.listName}
          </p>
        </div>
        <CountdownBadge targetMs={deadline} />
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="font-medium text-foreground">{thread.lastNonWorkerAuthor}</span>
        <span>replied</span>
        <span>{new Date(thread.lastNonWorkerMsgAt).toLocaleString()}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {expanded && (
        <div className="bg-muted/40 rounded p-2.5 text-xs text-muted-foreground italic leading-relaxed">
          "{(thread.lastNonWorkerText ?? "").slice(0, 400)}{(thread.lastNonWorkerText ?? "").length > 400 ? "…" : ""}"
        </div>
      )}
    </div>
  );
}

// ─── Vague flag card ──────────────────────────────────────────────────────────

function VagueFlagCard({
  flag,
  onResolve,
}: {
  flag: {
    id: number;
    source: string;
    cardId: string;
    cardName: string;
    cardUrl: string;
    actionId: string;
    messageText: string;
    flaggedAt: Date;
    resolvedAt: Date | null;
    demeritIssued: boolean;
    demeritIssuedAt: Date | null;
  };
  onResolve: (id: number) => void;
}) {
  const correctionDeadline = new Date(flag.flaggedAt).getTime() + 60 * 60 * 1000;
  const isActive = !flag.resolvedAt;

  return (
    <div className="rounded-lg border border-orange-400/40 bg-orange-500/5 p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={flag.cardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-sm text-foreground hover:underline flex items-center gap-1 truncate"
            >
              {flag.cardName}
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
            {flag.demeritIssued && (
              <Badge variant="outline" className="text-xs bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400">
                D1 issued
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Flagged at {new Date(flag.flaggedAt).toLocaleString()}
          </p>
        </div>
        {isActive && <CountdownBadge targetMs={correctionDeadline} />}
        {!isActive && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400">
            <CheckCircle className="w-3 h-3" />
            Resolved
          </span>
        )}
      </div>

      <div className="bg-muted/40 rounded p-2.5 text-xs text-muted-foreground italic leading-relaxed">
        <span className="font-semibold text-orange-700 dark:text-orange-400 not-italic">Vague reply: </span>
        "{flag.messageText.slice(0, 300)}{flag.messageText.length > 300 ? "…" : ""}"
      </div>

      {isActive && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-7 border-green-500/40 text-green-700 dark:text-green-400 hover:bg-green-500/10"
            onClick={() => onResolve(flag.id)}
          >
            <CheckCircle className="w-3 h-3 mr-1" />
            Mark as Corrected
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Unsigned flag card ──────────────────────────────────────────────────────

function UnsignedFlagCard({
  flag,
  onResolve,
}: {
  flag: {
    id: number;
    source: string;
    cardId: string;
    cardName: string;
    cardUrl: string;
    actionId: string;
    messageText: string;
    flaggedAt: Date;
    resolvedAt: Date | null;
    demeritIssued: boolean;
  };
  onResolve: (id: number, note: string) => void;
}) {
  const correctionDeadline = new Date(flag.flaggedAt).getTime() + 60 * 60 * 1000;
  const isActive = !flag.resolvedAt;
  const sourceLabel = flag.source === "upwork" ? "Upwork" : "Trello";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resolveNote, setResolveNote] = useState("");

  const handleResolveSubmit = () => {
    const trimmed = resolveNote.trim();
    if (!trimmed) return;
    onResolve(flag.id, trimmed);
    setDialogOpen(false);
    setResolveNote("");
  };

  return (
    <>
      <div className="rounded-lg border border-purple-400/40 bg-purple-500/5 p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-purple-500/10 border-purple-500/30 text-purple-700 dark:text-purple-400">
                {sourceLabel}
              </span>
              <a
                href={flag.cardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-sm text-foreground hover:underline flex items-center gap-1 truncate"
              >
                {flag.cardName}
                <ExternalLink className="w-3 h-3 flex-shrink-0" />
              </a>
              {flag.demeritIssued && (
                <Badge variant="outline" className="text-xs bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400">
                  D1 issued
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Flagged at {new Date(flag.flaggedAt).toLocaleString()}
            </p>
          </div>
          {isActive && <CountdownBadge targetMs={correctionDeadline} />}
          {!isActive && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400">
              <CheckCircle className="w-3 h-3" />
              Resolved
            </span>
          )}
        </div>

        <div className="bg-muted/40 rounded p-2.5 text-xs text-muted-foreground italic leading-relaxed">
          <span className="font-semibold text-purple-700 dark:text-purple-400 not-italic">Unsigned message: </span>
          "{flag.messageText.slice(0, 300)}{flag.messageText.length > 300 ? "\u2026" : ""}"
        </div>

        {isActive && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-7 border-green-500/40 text-green-700 dark:text-green-400 hover:bg-green-500/10"
              onClick={() => setDialogOpen(true)}
            >
              <CheckCircle className="w-3 h-3 mr-1" />
              Mark Resolved
            </Button>
          </div>
        )}
      </div>

      {/* Resolve dialog with required note */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <PenLine className="w-4 h-4 text-purple-500" />
              Resolve Unsigned Message
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-xs text-muted-foreground">
              Confirm that a signed follow-up message was added to{" "}
              <span className="font-semibold text-foreground">{flag.cardName}</span>.
              Provide a brief note explaining the resolution (required).
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="resolve-note" className="text-xs font-medium">
                Resolution note <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="resolve-note"
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
                placeholder="e.g. Added '~ Worker' as a follow-up comment on the card"
                className="text-xs min-h-[70px] resize-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleResolveSubmit();
                }}
              />
              <p className="text-[10px] text-muted-foreground">Ctrl+Enter to confirm</p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setDialogOpen(false); setResolveNote(""); }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleResolveSubmit}
              disabled={!resolveNote.trim()}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
              Confirm Resolution
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReplyMonitor() {
  const utils = trpc.useUtils();

  // Active-state queries: poll every 30 min. The cron runs every 12 h so
  // polling faster than that adds no value — use "Scan Now" for on-demand freshness.
  const { data: pendingThreads = [], isLoading: threadsLoading } = trpc.replyMonitor.getPendingThreads.useQuery(
    undefined,
    { refetchInterval: 30 * 60_000 }
  );
  const { data: activeVagueFlags = [], isLoading: flagsLoading } = trpc.replyMonitor.getActiveVagueFlags.useQuery(
    undefined,
    { refetchInterval: 30 * 60_000 }
  );
  const { data: activeUnsignedFlags = [], isLoading: unsignedLoading } = trpc.replyMonitor.getActiveUnsignedFlags.useQuery(
    undefined,
    { refetchInterval: 30 * 60_000 }
  );
  // History queries: no polling needed — they only change after a scan or resolve action.
  const { data: allThreads = [] } = trpc.replyMonitor.getAllThreads.useQuery({ limit: 50 });
  const { data: allVagueFlags = [] } = trpc.replyMonitor.getAllVagueFlags.useQuery({ limit: 50 });
  const { data: allUnsignedFlags = [] } = trpc.replyMonitor.getAllUnsignedFlags.useQuery({ limit: 50 });

  const resolveFlag = trpc.replyMonitor.resolveVagueFlag.useMutation({
    onSuccess: () => {
      utils.replyMonitor.getActiveVagueFlags.invalidate();
      utils.replyMonitor.getAllVagueFlags.invalidate();
      toast.success("Flag marked as corrected.");
    },
    onError: () => toast.error("Failed to resolve flag."),
  });

  const resolveUnsigned = trpc.replyMonitor.resolveUnsignedFlag.useMutation({
    onSuccess: () => {
      utils.replyMonitor.getActiveUnsignedFlags.invalidate();
      utils.replyMonitor.getAllUnsignedFlags.invalidate();
      toast.success("Signature confirmed.");
    },
    onError: () => toast.error("Failed to resolve unsigned flag."),
  });

  const triggerScan = trpc.replyMonitor.triggerScan.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.replyMonitor.getPendingThreads.invalidate(),
        utils.replyMonitor.getAllThreads.invalidate(),
      ]);
      toast.success(
        `Checked ${result.scannedCards} cards: ${result.pending} pending, ${result.overdue} overdue, ${result.replied} answered.`,
      );
    },
    onError: (error) => toast.error(error.message || "Reply evidence scan failed."),
  });

  const overdueCount = pendingThreads.filter(t => t.status === "overdue").length;
  const pendingCount = pendingThreads.filter(t => t.status === "pending").length;
  const activeFlagCount = activeVagueFlags.length;
  const activeUnsignedCount = activeUnsignedFlags.length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-blue-500" />
            Reply Monitor
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Trello reply evidence · 12-hour response rule · read-only provider scan
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => triggerScan.mutate()}
          disabled={triggerScan.isPending}
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${triggerScan.isPending ? "animate-spin" : ""}`} />
          Scan Now
        </Button>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        {overdueCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400">
            <XCircle className="w-3.5 h-3.5" />
            {overdueCount} overdue repl{overdueCount > 1 ? "ies" : "y"}
          </span>
        )}
        {pendingCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            {pendingCount} pending repl{pendingCount > 1 ? "ies" : "y"}
          </span>
        )}
        {activeFlagCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border bg-orange-500/10 border-orange-500/30 text-orange-700 dark:text-orange-400">
            <AlertCircle className="w-3.5 h-3.5" />
            {activeFlagCount} vague flag{activeFlagCount > 1 ? "s" : ""} active
          </span>
        )}
        {activeUnsignedCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border bg-purple-500/10 border-purple-500/30 text-purple-700 dark:text-purple-400">
            <PenLine className="w-3.5 h-3.5" />
            {activeUnsignedCount} unsigned message{activeUnsignedCount > 1 ? "s" : ""}
          </span>
        )}
        {overdueCount === 0 && pendingCount === 0 && activeFlagCount === 0 && activeUnsignedCount === 0 && !threadsLoading && !flagsLoading && !unsignedLoading && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400">
            <CheckCircle className="w-3.5 h-3.5" />
            All threads replied · No vague flags · All messages signed
          </span>
        )}
      </div>

      <Tabs defaultValue="active">
        <TabsList className="h-9">
          <TabsTrigger value="active" className="text-xs">
            Active
            {(overdueCount + pendingCount + activeFlagCount + activeUnsignedCount) > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {overdueCount + pendingCount + activeFlagCount + activeUnsignedCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="vague" className="text-xs">
            Vague Flags
            {activeFlagCount > 0 && (
              <span className="ml-1.5 bg-orange-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {activeFlagCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="unsigned" className="text-xs">
            Unsigned
            {activeUnsignedCount > 0 && (
              <span className="ml-1.5 bg-purple-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {activeUnsignedCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="text-xs">History</TabsTrigger>
        </TabsList>

        {/* ── Active threads + flags ── */}
        <TabsContent value="active" className="space-y-3 mt-3">
          {threadsLoading ? (
            <div className="text-xs text-muted-foreground py-4 text-center">Loading threads…</div>
          ) : pendingThreads.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground">All clear</p>
                <p className="text-xs text-muted-foreground mt-1">No unanswered Trello threads right now.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {/* Overdue first */}
              {pendingThreads
                .filter(t => t.status === "overdue")
                .map(t => (
                  <ThreadCard key={t.id} thread={{ ...t, lastNonWorkerMsgAt: t.lastNonWorkerMsgAt ? new Date(t.lastNonWorkerMsgAt) : new Date(), lastWorkerReplyAt: t.lastWorkerReplyAt ? new Date(t.lastWorkerReplyAt) : null }} />
                ))})
              {/* Then pending */}
              {pendingThreads
                .filter(t => t.status === "pending")
                .map(t => (
                  <ThreadCard key={t.id} thread={{ ...t, lastNonWorkerMsgAt: t.lastNonWorkerMsgAt ? new Date(t.lastNonWorkerMsgAt) : new Date(), lastWorkerReplyAt: t.lastWorkerReplyAt ? new Date(t.lastWorkerReplyAt) : null }} />
                ))}
            </div>
          )}

          {/* Active vague flags inline */}
          {activeVagueFlags.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold text-orange-700 dark:text-orange-400 uppercase tracking-wide">
                Vague Replies — Correct within 1h or D1 demerit is auto-issued
              </p>
              {activeVagueFlags.map(f => (
                <VagueFlagCard
                  key={f.id}
                  flag={{ ...f, flaggedAt: new Date(f.flaggedAt), resolvedAt: f.resolvedAt ? new Date(f.resolvedAt) : null, demeritIssuedAt: null }}
                  onResolve={id => resolveFlag.mutate({ id })}
                />
              ))}
            </div>
          )}

          {/* Active unsigned flags inline */}
          {activeUnsignedFlags.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-semibold text-purple-700 dark:text-purple-400 uppercase tracking-wide">
                Unsigned Messages — Add ~ Angel or ~ Worker within 1h or D1 demerit is auto-issued
              </p>
              {activeUnsignedFlags.map(f => (
                <UnsignedFlagCard
                  key={f.id}
                  flag={{ ...f, flaggedAt: new Date(f.flaggedAt), resolvedAt: f.resolvedAt ? new Date(f.resolvedAt) : null }}
                  onResolve={(id, note) => resolveUnsigned.mutate({ id, note })}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Vague flags tab ── */}
        <TabsContent value="vague" className="space-y-3 mt-3">
          {flagsLoading ? (
            <div className="text-xs text-muted-foreground py-4 text-center">Loading flags…</div>
          ) : activeVagueFlags.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground">No active vague flags</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Replies like "I'll get back to you tonight" are automatically detected and flagged here.
                </p>
              </CardContent>
            </Card>
          ) : (
            activeVagueFlags.map(f => (
              <VagueFlagCard
                key={f.id}
                flag={{ ...f, flaggedAt: new Date(f.flaggedAt), resolvedAt: f.resolvedAt ? new Date(f.resolvedAt) : null, demeritIssuedAt: null }}
                onResolve={id => resolveFlag.mutate({ id })}
              />
            ))
          )}

          {/* What counts as vague */}
          <Card className="border-dashed">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-foreground mb-2">What triggers a vague-reply flag?</p>
              <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                <li>"I'll get back to you tonight / today / soon"</li>
                <li>"I'll check on this later"</li>
                <li>"Will do" without any substance</li>
                <li>"Let me get back to you" without a timeframe or action</li>
                <li>Any reply that defers without addressing the situation</li>
              </ul>
              <p className="text-xs text-muted-foreground mt-2">
                Worker has <strong>1 hour</strong> to replace a flagged reply with a proper response before a D1 demerit is auto-issued.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Unsigned messages tab ── */}
        <TabsContent value="unsigned" className="space-y-3 mt-3">
          {unsignedLoading ? (
            <div className="text-xs text-muted-foreground py-4 text-center">Loading unsigned flags…</div>
          ) : activeUnsignedFlags.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-foreground">All messages are signed</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Every message ends with ~ Angel or ~ Worker.
                </p>
              </CardContent>
            </Card>
          ) : (
            activeUnsignedFlags.map(f => (
              <UnsignedFlagCard
                key={f.id}
                flag={{ ...f, flaggedAt: new Date(f.flaggedAt), resolvedAt: f.resolvedAt ? new Date(f.resolvedAt) : null }}
                onResolve={(id, note) => resolveUnsigned.mutate({ id, note })}
              />
            ))
          )}

          <Card className="border-dashed">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-foreground mb-2">Signature rule</p>
              <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                <li>Every message sent from the owner account must end with <strong>~ Angel</strong> or <strong>~ Worker</strong></li>
                <li><strong>~ Worker</strong> = Worker wrote it (regardless of whose voice it’s in)</li>
                <li><strong>~ Angel</strong> = Angel personally wrote it</li>
                <li>Applies to both Trello card comments and Upwork messages</li>
              </ul>
              <p className="text-xs text-muted-foreground mt-2">
                Worker has <strong>1 hour</strong> to add a follow-up signed message before a D1 demerit is auto-issued.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── History tab ── */}
        <TabsContent value="history" className="space-y-3 mt-3">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">All Threads (last 50)</p>
            {allThreads.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No thread history yet.</p>
            ) : (
              <div className="space-y-1">
                {allThreads.map(t => {
                  const statusColor =
                    t.status === "overdue"
                      ? "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400"
                      : t.status === "replied"
                      ? "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400"
                      : "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400";
                  return (
                    <div key={t.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${statusColor}`}>
                        {t.status.toUpperCase()}
                      </span>
                      <a
                        href={t.cardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-foreground hover:underline flex-1 truncate"
                      >
                        {t.cardName}
                      </a>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {t.lastNonWorkerMsgAt ? new Date(t.lastNonWorkerMsgAt).toLocaleDateString() : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-1 mt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Vague Flag History (last 50)</p>
            {allVagueFlags.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No vague flag history yet.</p>
            ) : (
              <div className="space-y-1">
                {allVagueFlags.map(f => (
                  <div key={f.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                    {f.demeritIssued ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400">
                        D1 ISSUED
                      </span>
                    ) : f.resolvedAt ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400">
                        RESOLVED
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-orange-500/10 border-orange-500/30 text-orange-700 dark:text-orange-400">
                        ACTIVE
                      </span>
                    )}
                    <a
                      href={f.cardUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-foreground hover:underline flex-1 truncate"
                    >
                      {f.cardName}
                    </a>
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">
                      {new Date(f.flaggedAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
