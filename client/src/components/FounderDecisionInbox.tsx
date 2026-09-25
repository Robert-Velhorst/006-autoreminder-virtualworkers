import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clock3, ExternalLink, Loader2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const escalationLabel = {
  decision_overdue: "Decision overdue",
  decision_due_soon: "Decision due soon",
  task_overdue: "Task overdue",
  task_due_soon: "Task due soon",
  high_priority_no_deadline: "High priority · no deadline",
  none: "Pending",
} as const;

function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function FounderDecisionInbox() {
  const utils = trpc.useUtils();
  const inbox = trpc.operator.getFounderDecisionInbox.useQuery(undefined, { retry: false, staleTime: 30_000, refetchInterval: 30_000 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [outcome, setOutcome] = useState("");
  const [disposition, setDisposition] = useState<"approved" | "rejected" | null>(null);
  const [dueLocal, setDueLocal] = useState("");
  const [deadlineSource, setDeadlineSource] = useState("");
  const [clearReason, setClearReason] = useState("");
  const items = inbox.data?.items ?? [];
  const selected = items.find(item => item.stepId === selectedId) ?? items[0] ?? null;
  useEffect(() => {
    setDueLocal(localDateTime(selected?.decisionDueAt ?? null));
    setDeadlineSource(selected?.deadlineSource?.replace(/^Deferred:\s*/i, "") ?? "");
    setClearReason("");
  }, [selected?.stepId, selected?.decisionDueAt, selected?.deadlineSource]);
  const deadline = trpc.operator.setFounderDecisionDeadline.useMutation({
    onSuccess: () => {
      void utils.operator.getFounderDecisionInbox.invalidate();
      toast.success("Decision deadline saved.");
    },
    onError: error => toast.error(error.message),
  });
  const defer = trpc.operator.deferFounderDecision.useMutation({
    onSuccess: () => {
      void utils.operator.getFounderDecisionInbox.invalidate();
      toast.success("Decision deferred; it remains open until the new review date.");
    },
    onError: error => toast.error(error.message),
  });
  const record = trpc.operator.recordFounderDecisionOutcome.useMutation({
    onSuccess: result => {
      setSelectedId(null);
      setOutcome("");
      setDisposition(null);
      void utils.operator.getFounderDecisionInbox.invalidate();
      toast.success(result.reassessmentQueued ? "Decision recorded; worker reassessment queued." : "Decision recorded. Reassess the worker card before resuming it.");
    },
    onError: error => toast.error(error.message),
  });

  return (
    <section className="space-y-4" aria-label="Founder decision inbox">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div>
          <h2 className="text-lg font-semibold">Decisions needing you</h2>
          <p className="text-sm text-muted-foreground">{items.length} open across workers</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>
          {inbox.isFetching && <Loader2 className="size-4 animate-spin" />}
          Reload
        </Button>
      </div>

      {inbox.error && <p role="alert" className="border-l-2 border-red-500 p-3 text-sm">Decisions could not be loaded. Reload before relying on this list.</p>}
      {inbox.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading decisions...</p>}
      {!inbox.isLoading && !inbox.error && !items.length && <p className="py-8 text-sm text-muted-foreground">No founder decisions are waiting.</p>}
      {!!items.length && <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.75fr)]">
        <div className="divide-y border-y">
          {items.map(item => (
            <button key={item.stepId} type="button" aria-pressed={selected?.stepId === item.stepId}
              onClick={() => { setSelectedId(item.stepId); setOutcome(""); setDisposition(null); }}
              className={`w-full px-3 py-4 text-left hover:bg-accent/40 ${selected?.stepId === item.stepId ? "border-l-2 border-blue-500 bg-accent/30" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 text-sm font-semibold">{item.cardName}</span>
                <Badge variant="outline" className={item.escalation === "none" ? "" : "border-amber-500/40 text-amber-700 dark:text-amber-300"}>
                  {escalationLabel[item.escalation]}
                </Badge>
              </div>
              <p className="mt-1 text-sm">{item.stepTitle}</p>
              <p className="mt-2 text-xs text-muted-foreground">Worker: {item.workerName || `#${item.vaId}`} · {item.tier} priority</p>
              {item.isDeferred && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Deferred · review {item.decisionDueAt ? new Date(item.decisionDueAt).toLocaleString() : "date not set"}</p>}
            </button>
          ))}
        </div>

        {selected && <div className="space-y-4 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Founder-owned decision</p>
            <h3 className="mt-1 text-base font-semibold">{selected.cardName}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{selected.workerName || `Worker #${selected.vaId}`} · {selected.boardName || "Board not recorded"}</p>
          </div>
          <div className="space-y-2 border-y py-3 text-sm">
            <p className="font-medium">{selected.stepTitle}</p>
            {selected.riskIfSkipped && <p className="flex items-start gap-2 text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{selected.riskIfSkipped}</p>}
            {selected.decisionDueAt && <p className="flex items-start gap-2 font-medium"><Clock3 className="mt-0.5 size-4 shrink-0" />Decision due: {new Date(selected.decisionDueAt).toLocaleString()}</p>}
            {selected.isDeferred && <p className="border-l-2 border-amber-500 pl-3 text-amber-800 dark:text-amber-200">Decision deferred{selected.decisionDueAt ? ` until ${new Date(selected.decisionDueAt).toLocaleString()}` : ""}{selected.deferralReason ? `: ${selected.deferralReason}` : ""}</p>}
            <p className="flex items-start gap-2 text-muted-foreground"><Clock3 className="mt-0.5 size-4 shrink-0" />{selected.taskDueAt ? `Last recorded task deadline: ${new Date(selected.taskDueAt).toLocaleString()}. Verify in the source.` : "No task deadline recorded. Set the urgency from the original source."}</p>
            {selected.completionCriteria && <p><span className="font-medium">Decision complete when:</span> {selected.completionCriteria}</p>}
          </div>
          {/^https:\/\//i.test(selected.cardUrl) && <a href={selected.cardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-primary underline">Open source card <ExternalLink className="size-4" /></a>}
          <div className="space-y-2 border-y py-3">
            <Label htmlFor="founder-decision-due">Decision deadline</Label>
            <Input id="founder-decision-due" type="datetime-local" value={dueLocal} onChange={event => setDueLocal(event.target.value)} />
            <Label htmlFor="founder-decision-source">Source or reason</Label>
            <Input id="founder-decision-source" value={deadlineSource} onChange={event => setDeadlineSource(event.target.value)} placeholder="Source record or reason for this deadline" maxLength={1024} />
            <p className="text-xs text-muted-foreground">This deadline is for your decision. Changing it does not change the task deadline or worker plan.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={deadline.isPending || !dueLocal || deadlineSource.trim().length < 3}
                onClick={() => deadline.mutate({ vaId: selected.vaId, stepId: selected.stepId, dueAt: new Date(dueLocal).toISOString(), source: deadlineSource.trim() })}>
                Save deadline
              </Button>
              <Button variant="outline" size="sm" disabled={defer.isPending || !dueLocal || new Date(dueLocal).getTime() <= Date.now() || deadlineSource.trim().length < 3}
                onClick={() => defer.mutate({ vaId: selected.vaId, stepId: selected.stepId, dueAt: new Date(dueLocal).toISOString(), reason: deadlineSource.trim() })}>
                {defer.isPending ? <Loader2 className="size-4 animate-spin" /> : <Clock3 className="size-4" />}
                Defer decision to this date
              </Button>
            </div>
            {selected.decisionDueAt && <div className="space-y-2 pt-2">
              <Label htmlFor="founder-decision-clear-reason">Reason for withdrawing this deadline</Label>
              <Input id="founder-decision-clear-reason" value={clearReason} onChange={event => setClearReason(event.target.value)} placeholder="What changed in the source or agreement?" maxLength={1024} />
              <Button variant="ghost" size="sm" disabled={deadline.isPending || clearReason.trim().length < 3 || clearReason.trim() === selected.deadlineSource}
                onClick={() => deadline.mutate({ vaId: selected.vaId, stepId: selected.stepId, dueAt: null, source: clearReason.trim() })}>
                Clear deadline
              </Button>
            </div>}
          </div>
          <div className="space-y-2">
            <Label>Final decision</Label>
            <div role="group" aria-label="Final decision" className="flex gap-2">
              <Button type="button" variant={disposition === "approved" ? "default" : "outline"} aria-pressed={disposition === "approved"} onClick={() => setDisposition("approved")}><Check className="size-4" />Approve</Button>
              <Button type="button" variant={disposition === "rejected" ? "destructive" : "outline"} aria-pressed={disposition === "rejected"} onClick={() => setDisposition("rejected")}><X className="size-4" />Reject</Button>
            </div>
            <Label htmlFor="founder-decision-outcome">Reason and source checked</Label>
            <Textarea id="founder-decision-outcome" value={outcome} onChange={event => setOutcome(event.target.value)} className="min-h-28" placeholder="Record the reason, any conditions, and the source you checked." />
            <p className="text-xs text-muted-foreground">To wait for more information, defer the decision above. A deferred decision stays open. No message is sent and no plan is applied automatically.</p>
          </div>
          <Button disabled={record.isPending || !disposition || outcome.trim().length < 3} onClick={() => disposition && record.mutate({ vaId: selected.vaId, stepId: selected.stepId, disposition, outcome: outcome.trim() })}>
            {record.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {disposition === "approved" ? "Record approval" : disposition === "rejected" ? "Record rejection" : "Choose approve or reject"}
          </Button>
        </div>}
      </div>}
    </section>
  );
}
