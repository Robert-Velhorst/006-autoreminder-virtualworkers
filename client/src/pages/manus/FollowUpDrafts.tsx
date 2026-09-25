/**
 * FollowUpDrafts — Review and track follow-up message drafts.
 *
 * The maintenance job generates follow-up drafts for WAITING_FOR_EXTERNAL_PARTY cards
 * that have been idle for longer than the configured follow_up_hours_routine threshold.
 *
 * Workers copy and send drafts directly in Trello, then record that they sent them here.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Clock,
  Copy,
  CheckCircle2,
  X,
  RefreshCw,
  MessageSquarePlus,
  ExternalLink,
  Inbox,
} from "lucide-react";

function urgencyColor(urgencyType: string) {
  switch (urgencyType) {
    case "urgent":          return "bg-red-500/15 border-red-500/40 text-red-600 dark:text-red-400";
    case "formal_reminder": return "bg-orange-500/15 border-orange-500/40 text-orange-600 dark:text-orange-400";
    case "warning":         return "bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400";
    default:                return "bg-blue-500/15 border-blue-500/40 text-blue-600 dark:text-blue-400";
  }
}

function urgencyLabel(urgencyType: string) {
  switch (urgencyType) {
    case "urgent":          return "Urgent";
    case "formal_reminder": return "Formal Reminder";
    case "warning":         return "Warning";
    default:                return "Routine";
  }
}

export default function FollowUpDrafts() {
  const utils = trpc.useUtils();
  const [showAll, setShowAll] = useState(false);

  const { data: pending, isLoading, refetch, isFetching } = trpc.aptlss.getPendingFollowUps.useQuery(
    undefined,
    { staleTime: 2 * 60_000 }
  );
  const { data: all } = trpc.aptlss.getAllFollowUps.useQuery(
    undefined,
    { enabled: showAll, staleTime: 2 * 60_000 }
  );

  const markSent = trpc.aptlss.markFollowUpSent.useMutation({
    onSuccess: () => {
      toast.success("Marked as sent");
      utils.aptlss.getPendingFollowUps.invalidate();
      utils.aptlss.getAllFollowUps.invalidate();
    },
    onError: (e) => toast.error("Failed to mark as sent", { description: e.message }),
  });

  const dismiss = trpc.aptlss.dismissFollowUp.useMutation({
    onSuccess: () => {
      toast.success("Draft dismissed");
      utils.aptlss.getPendingFollowUps.invalidate();
      utils.aptlss.getAllFollowUps.invalidate();
    },
    onError: (e) => toast.error("Failed to dismiss", { description: e.message }),
  });

  const drafts = showAll ? (all ?? []) : (pending ?? []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <MessageSquarePlus className="w-4 h-4 text-blue-500" />
            Follow-Up Drafts
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Copy a draft, review and send it directly in Trello, then mark it as sent here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll((v) => !v)}
            className="text-xs h-7"
          >
            {showAll ? "Show Pending Only" : "Show All"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Loading follow-up drafts…
        </div>
      )}

      {!isLoading && drafts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Inbox className="w-10 h-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">
            {showAll ? "No follow-up drafts found." : "No pending follow-up drafts."}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            No follow-up drafts are waiting for review.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {drafts.map((draft) => (
          <div
            key={draft.id}
            className={`rounded-lg border p-4 space-y-3 ${
              draft.status === "pending"
                ? "bg-card border-border"
                : "bg-muted/20 border-border/40 opacity-60"
            }`}
          >
            {/* Card name + urgency */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground truncate">{draft.cardName}</span>
                  <span className={`inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${urgencyColor(draft.urgencyType)}`}>
                    {urgencyLabel(draft.urgencyType)}
                  </span>
                  {draft.status !== "pending" && (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                      {draft.status === "sent" ? "Sent" : "Dismissed"}
                    </Badge>
                  )}
                </div>
                {draft.reason && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{draft.reason}</p>
                )}
              </div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground flex-shrink-0">
                <Clock className="w-3 h-3" />
                {draft.hoursSinceLastReply}h idle
              </div>
            </div>

            {/* Draft message */}
            <div className="bg-muted/40 rounded-md p-3 border border-border/50">
              <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">{draft.draftMessage}</p>
            </div>

            {/* Actions */}
            {draft.status === "pending" && (
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => {
                    navigator.clipboard.writeText(draft.draftMessage);
                    toast.success("Copied to clipboard");
                  }}
                >
                  <Copy className="w-3 h-3" />
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => markSent.mutate({ id: draft.id })}
                  disabled={markSent.isPending}
                  title="Use only after you have sent the message directly in Trello"
                >
                  <CheckCircle2 className="w-3 h-3" />
                  Mark manually sent
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-destructive ml-auto"
                  onClick={() => dismiss.mutate({ id: draft.id })}
                  disabled={dismiss.isPending}
                >
                  <X className="w-3 h-3" />
                  Dismiss
                </Button>
                <a
                  href={`https://trello.com/c/${draft.cardId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 text-[10px] text-muted-foreground hover:text-primary flex items-center gap-0.5"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open card
                </a>
              </div>
            )}

            {/* Created at */}
            <p className="text-[9px] text-muted-foreground/50">
              Generated {new Date(draft.createdAt).toLocaleString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
