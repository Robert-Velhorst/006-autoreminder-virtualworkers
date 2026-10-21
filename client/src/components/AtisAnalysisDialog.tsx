import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import type { AtisAnalysisJob, AtisAnalysisSelection } from "@shared/atisAnalysis";
import { AtisAnalysisClient, analysisItemLabel, analysisJobLabel, canAttributeAnalysis, type AnalysisView } from "@/lib/atis-analysis";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, Loader2, RefreshCw, Pause, Brain } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: AtisAnalysisSelection;
  title?: string;
  onCompleted?: (job: AtisAnalysisJob, signal: AbortSignal) => void | Promise<void>;
  resumeOnMount?: boolean;
};
export function AtisAnalysisDialog(props: Props) {
  const { user, loading, verificationUnavailable } = useAuth();
  if (!user || loading || verificationUnavailable) return props.open ? <Dialog open onOpenChange={props.onOpenChange}>
    <DialogContent><DialogHeader><DialogTitle>Analysis unavailable</DialogTitle><DialogDescription>Verify your account before continuing.</DialogDescription></DialogHeader></DialogContent>
  </Dialog> : null;
  return <AnalysisSession key={`${user.id}:${user.role}:${JSON.stringify(props.selection)}`} {...props} actor={`${user.id}:${user.role}`} />;
}
function AnalysisSession({ actor, ...props }: Props & { actor: string }) {
  const [view, setView] = useState<AnalysisView>({ phase: "idle" });
  const [now, setNow] = useState(Date.now);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [unknownAcknowledged, setUnknownAcknowledged] = useState(false);
  const client = useRef<AtisAnalysisClient | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => { setRecoveryAcknowledged(false); setUnknownAcknowledged(false); }, [view.preview?.id, actor]);
  useEffect(() => {
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch { /* Browser storage may be disabled. */ }
    const instance: AtisAnalysisClient = new AtisAnalysisClient({ actor, storage, onState: setView,
      onCompleted: (job, signal) => {
        const requested = callbacks.current.selection;
        if (canAttributeAnalysis(job, requested, instance.ownsAnalysis(job.id))) return callbacks.current.onCompleted?.(job, signal);
      } });
    client.current = instance;
    return () => { instance.dispose(); client.current = null; };
  }, [actor]);
  useEffect(() => {
    if (!props.resumeOnMount) return;
    try {
      if (window.sessionStorage.getItem(`atis-analysis:v1:${actor}`)) callbacks.current.onOpenChange(true);
    } catch { /* Browser storage may be disabled. */ }
  }, [actor, props.resumeOnMount]);
  useEffect(() => {
    const instance = client.current;
    if (!props.open || !instance) return;
    let closed = false;
    void instance.resume().then(() => {
      if (!closed && !instance.hasRequest) void instance.preview(callbacks.current.selection);
    });
    return () => { closed = true; instance.pause(); };
  }, [actor, props.open]);
  useEffect(() => {
    if (!view.retryAt && view.phase !== "preview") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [view.retryAt, view.phase]);
  const preview = view.preview;
  const job = view.analysis;
  const attributable = !!job && canAttributeAnalysis(job, props.selection, client.current?.ownsAnalysis(job.id) === true);
  const cooling = (view.retryAt ?? 0) > now;
  const expired = !!preview && Date.parse(preview.expiresAt) <= now;
  const active = job?.state === "queued" || job?.state === "running";
  return <Dialog open={props.open} onOpenChange={open => {
    if (!open) client.current?.pause();
    props.onOpenChange(open);
  }}><DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{props.title ?? "Card analysis"}</DialogTitle>
      <DialogDescription>Review the selected cards before confirming analysis.</DialogDescription></DialogHeader>
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]" aria-live="polite">
      {view.phase === "previewing" && <p role="status">Loading preview. No AI has been requested.</p>}
      {preview && view.phase === "preview" && <>
        <p>{preview.total} selected of {preview.matched} matched. {preview.remaining} remain outside this batch.</p>
        <p className="text-sm text-muted-foreground">No AI has been requested. This preview expires at {new Date(preview.expiresAt).toLocaleTimeString()}.</p>
        <ul className="max-h-48 overflow-y-auto text-sm">{preview.cards.map(card => <li key={card.id}>{card.name}</li>)}</ul>
        {preview.recoveryOperationId !== undefined && <>
          <p role="alert">An earlier operation was interrupted. Uncertain earlier calls may already have incurred usage.</p>
          <label className="flex items-start gap-2 text-sm"><Checkbox checked={recoveryAcknowledged} onCheckedChange={value => setRecoveryAcknowledged(value === true)} />I reviewed the interrupted operation and accept starting this batch</label>
        </>}
        {expired ? <Button variant="outline" disabled={view.busy} onClick={() => void client.current?.refreshPreview()}><RefreshCw className="size-4" />Refresh expired preview</Button>
          : <Button className="h-auto min-h-9 max-w-full whitespace-normal text-left" disabled={view.busy || preview.total === 0 || cooling || (preview.recoveryOperationId !== undefined && !recoveryAcknowledged)} onClick={() => void client.current?.confirm(recoveryAcknowledged ? preview.recoveryOperationId : undefined)}><Brain className="size-4" />{preview.recoveryOperationId === undefined ? "Confirm analysis of" : "Acknowledge and start"} {preview.total} {preview.total === 1 ? "card" : "cards"}</Button>}
      </>}
      {view.phase === "confirming" && <p role="status"><Loader2 className="inline size-4 animate-spin" /> Requesting analysis acknowledgement...</p>}
      {job && <>
        {!attributable && <p className="text-sm">Showing an existing analysis. This request did not start it or submit the current selection.</p>}
        <p role="status">{analysisJobLabel[job.state]}. {job.total} selected of {job.matched} matched; {job.remaining} remain outside this batch.</p>
        <Progress value={job.total ? (job.items.filter(item => !["pending", "calling"].includes(item.state)).length / job.total) * 100 : 0} />
        <p className="text-sm">{job.generated} plans ready · {job.fallback} need review · {job.missing} unavailable · {job.failed} could not be analyzed · {job.uncertain} unknown outcomes · {job.pending} waiting or in progress</p>
        <ul className="max-h-48 overflow-y-auto text-sm">{job.items.map(item => <li key={item.cardId} className="flex justify-between gap-3 py-1"><span className="min-w-0 break-words">{item.cardName}</span><span className="shrink-0">{analysisItemLabel[item.state]}</span></li>)}</ul>
        {job.state === "completed" && <p>{job.remaining > 0 ? "This batch finished. Matching cards remain; no next batch has started." : "This batch finished."} {(job.fallback + job.missing + job.failed + job.uncertain) > 0 ? "Some cards need review; not all cards have a generated plan." : ""}</p>}
        {job.state === "interrupted" && <Button variant="outline" disabled={view.busy} onClick={() => void client.current?.preview(props.selection)}><RefreshCw className="size-4" />Review recovery preview</Button>}
        {job.state === "completed" && job.remaining > 0 && (client.current?.canNextBatch
          ? <Button disabled={view.busy} onClick={() => void client.current?.nextBatch()}><Check className="size-4" />Preview next batch</Button>
          : <p className="text-sm">Reopen the original selection to preview remaining cards. No filters were stored in this browser.</p>)}
        {["completed", "failed"].includes(job.state) && <Button variant="outline" disabled={view.busy} onClick={() => void client.current?.preview(props.selection)}><RefreshCw className="size-4" />Preview requested cards</Button>}
      </>}
      {view.message && <p role={view.phase === "error" || view.phase === "paused" ? "alert" : "status"}>{view.message}</p>}
      {cooling && <p role="status">Check again in {Math.ceil(((view.retryAt ?? now) - now) / 1000)} seconds.</p>}
      {view.phase === "paused" && <Button variant="outline" disabled={view.busy || cooling} onClick={() => void client.current?.resume()}><RefreshCw className="size-4" />Check analysis status</Button>}
      {view.unknownOutcome && <>
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={unknownAcknowledged} onCheckedChange={value => setUnknownAcknowledged(value === true)} />I accept that the prior outcome is unknown and another batch could incur additional usage</label>
        <Button variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal text-left" disabled={view.busy || cooling || !unknownAcknowledged} onClick={() => void client.current?.reviewUnknownOutcome(props.selection, unknownAcknowledged)}><RefreshCw className="size-4" />Review a new preview despite unknown outcome</Button>
      </>}
      {(view.phase === "error" || view.phase === "idle") && <Button variant="outline" disabled={view.busy || cooling} onClick={() => void client.current?.preview(props.selection)}><RefreshCw className="size-4" />Load preview</Button>}
      {active && view.phase !== "paused" && <Button variant="outline" disabled={!view.busy} onClick={() => client.current?.pause()}><Pause className="size-4" />Pause status checks</Button>}
      {(active || view.phase === "paused") && <p className="text-sm text-muted-foreground">Closing this window or pausing checks does not cancel server work.</p>}
    </div>
  </DialogContent></Dialog>;
}
