import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, BrainCircuit, Check, ChevronDown, ChevronRight, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { isManagerPilotDenied, managerStatusPollingInterval, managerStatusQueryOptions } from "@/lib/managerPilotAvailability";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ManagerSnapshotDetails, ManagerTimestamp } from "./AptlssManagerReview";
import { ManagerVerificationDetails } from "./ManagerVerificationDetails";
import { managerReviewNotice } from "@shared/aptlssManagerReviewNotice";
import { workerFacingManagerQuestion } from "@shared/aptlssManager";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";

export default function ManagerCoach({ onPrimaryChange }: { onPrimaryChange?: (active: boolean) => void }) {
  const { user } = useAuth();
  const showDiagnostics = user?.role === "admin";
  const utils = trpc.useUtils();
  const [detail, setDetail] = useState("");
  const [outcome, setOutcome] = useState("Update");
  const [deadline, setDeadline] = useState("");
  const [saved, setSaved] = useState(false);
  const [draftContext, setDraftContext] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState("");
  const [now, setNow] = useState(Date.now);
  const query = trpc.operator.getManagerStatus.useQuery(undefined, { ...managerStatusQueryOptions, refetchInterval: managerStatusPollingInterval });
  const pilotDenied = isManagerPilotDenied(query.error);
  useEffect(() => {
    if (pilotDenied) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [pilotDenied]);
  const refresh = useCallback(() => {
    if (pilotDenied) return;
    void utils.operator.getManagerStatus.invalidate();
    void utils.operator.getDailyPlan.invalidate();
    void utils.operator.getWorkQueueContext.invalidate();
  }, [utils, pilotDenied]);
  const { status: connection } = useWebSocket({ onManagerUpdated: refresh });
  useEffect(() => {
    if (connection.connected) refresh();
  }, [connection.connected, refresh]);
  const queue = trpc.operator.getWorkQueueContext.useQuery(undefined, { enabled: !pilotDenied, retry: false, staleTime: 60_000 });
  const assessed = (applied?: boolean) => {
    refresh();
    if (applied) toast.error("Unexpected plan change: stop the shadow trial and review the assessment.");
    else toast.success("Proposal assessed; active plan unchanged");
  };
  const run = trpc.operator.runManager.useMutation({
    onSuccess: result => assessed(result?.applied),
    onError: error => toast.error(error.message),
  });
  const update = trpc.operator.submitManagerUpdate.useMutation({
    onSuccess: result => { setDetail(""); setDeadline(""); setOutcome("Update"); setDraftContext(null); setSaved(true); assessed(result?.applied); },
    onError: error => toast.error(error.message),
  });
  const snapshot = query.data?.snapshot;
  const policy = query.data?.policy;
  const firstIntervention = snapshot?.interventions.find(item => item.severity === "urgent") ?? snapshot?.interventions[0];
  const firstNext = snapshot?.actions.find(item => !item.blocked);
  useEffect(() => { onPrimaryChange?.(!!firstIntervention || !!firstNext); }, [firstIntervention, firstNext, onPrimaryChange]);
  const availableCards = snapshot?.cards.length ? snapshot.cards : (queue.data?.cards ?? []).map(card => ({ id: card.cardId, name: card.cardName }));
  const cardId = selectedCardId ? (availableCards.some(card => card.id === selectedCardId) ? selectedCardId : "") : (availableCards.find(card => card.id === (firstIntervention?.cardId ?? firstNext?.cardId))?.id ?? availableCards[0]?.id ?? "");
  const cardInterventions = snapshot?.interventions.filter(item => item.cardId === cardId);
  const intervention = selectedCardId ? cardInterventions?.find(item => item.severity === "urgent") ?? cardInterventions?.[0] : firstIntervention;
  const next = selectedCardId ? snapshot?.actions.find(item => item.cardId === cardId && !item.blocked) : firstNext;
  // Ignore assessment timestamps, but require review when the instruction changes.
  const contextKey = JSON.stringify([cardId, intervention ?? null, intervention ? null : next ?? null]);
  const contextChanged = draftContext !== null && draftContext !== contextKey;
  const pinDraftContext = () => {
    setSelectedCardId(cardId);
    setDraftContext(current => current ?? contextKey);
    setSaved(false);
  };
  const interventionQuestion = intervention ? workerFacingManagerQuestion(intervention.question) : "";
  const unspecifiedQuestion = !!intervention && (/which unknown applies now/i.test(intervention.question) || interventionQuestion.startsWith("Open the linked source and confirm the current fact needed for this task:"));
  const urgent = intervention?.severity === "urgent" && !unspecifiedQuestion;
  const linkedSource = snapshot?.evidence.find(item => intervention?.evidenceIds.includes(item.id) && item.url && /^https?:\/\//i.test(item.url));
  const attentionCard = availableCards.find(card => card.id === (intervention?.cardId ?? next?.cardId));
  const blockedAction = intervention ? snapshot?.actions.find(item => item.cardId === intervention.cardId && item.blocked) : undefined;
  const processing = query.data?.queue;
  const reviewNotice = managerReviewNotice(snapshot?.semanticReview);
  const lastSuccessfulAt = query.data?.lastSuccessfulAt;
  const lastSuccessfulTime = lastSuccessfulAt ? new Date(lastSuccessfulAt).getTime() : NaN;
  const ageMinutes = Number.isFinite(lastSuccessfulTime) ? Math.max(0, Math.floor((now - lastSuccessfulTime) / 60_000)) : null;
  const age = ageMinutes === null ? "not recorded" : ageMinutes < 1 ? "less than a minute ago" : ageMinutes < 60 ? ageMinutes + " min ago" : Math.floor(ageMinutes / 60) + "h " + (ageMinutes % 60) + "m ago";
  const busy = run.isPending || update.isPending;
  // Backend enforcement remains authoritative; never offer execution for an unknown or active policy.
  const canAssess = policy?.mode === "shadow" && policy.enabled && !query.error && !query.isFetching && !busy;
  if (pilotDenied) return <p role="status" className="border-y py-4 text-sm text-muted-foreground">APTLSS manager is unavailable for this worker.</p>;
  return (
    <section aria-label="APTLSS work manager" className="min-w-0 space-y-3 border-b pb-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><BrainCircuit className="size-4 shrink-0 text-primary" /><h2 className="text-sm font-semibold">Work guidance</h2></div>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0 rounded-md" aria-label="Reassess now" onClick={() => { if (canAssess) run.mutate({ trigger: "manual" }); }} disabled={!canAssess}>
          {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Reassess now
        </Button>
      </div>
      <div className={open ? "grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" : "min-w-0"}>
      <div className="min-w-0 space-y-3">
      {(query.error || query.data?.error) && <Alert variant="destructive"><AlertTriangle className="size-4" /><AlertTitle>Manager data unavailable</AlertTitle><AlertDescription>{query.error?.message ?? query.data?.error}</AlertDescription></Alert>}
      {query.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading manager status...</p> : !snapshot ? <p className="text-sm text-muted-foreground">No assessment has been recorded yet.</p> : (
        <div aria-label="Current manager instruction" role={urgent ? "alert" : "status"} className={"min-w-0 space-y-4 border-l-2 px-3 py-4 sm:px-4 " + (intervention ? urgent ? "border-red-500 bg-red-500/5" : "border-amber-500 bg-amber-500/5" : "border-border bg-muted/30")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {intervention ? <AlertTriangle aria-hidden="true" className={"size-4 shrink-0 " + (intervention.severity === "urgent" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400")} /> : <Check aria-hidden="true" className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />}
              <span className="text-xs font-semibold uppercase tracking-normal">{intervention ? "Needs your input" : "Ready for next step"}</span>
              {attentionCard && <span className="min-w-0 break-words text-xs text-muted-foreground">{attentionCard.name}</span>}
            </div>
            {intervention && <Badge variant="outline">{urgent ? "Urgent" : "Check message"}</Badge>}
          </div>
          {intervention ? (
            <div className="min-w-0 space-y-4">
              <div className="min-w-0">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Problem</p>
                <h3 className="break-words text-base font-semibold">{unspecifiedQuestion ? "Check the original message" : intervention.title}</h3>
                <p className="mt-1 break-words text-sm text-muted-foreground">{unspecifiedQuestion ? "Read the full correspondence to find the request and any deadline." : intervention.explanation}</p>
              </div>
              <div className="min-w-0 border-l-2 border-primary pl-3">
                <p className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-normal text-primary"><span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />Question for you now</p>
                <p className="break-words text-sm font-medium">{unspecifiedQuestion ? "What does the message ask you to do, is there a deadline, and what follow-up is needed?" : interventionQuestion}</p>
              </div>
              <div className="flex min-w-0 items-start gap-2">
                <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Do this now</p>
                  <p className="break-words text-sm font-medium">{unspecifiedQuestion ? "Read the full message. If it points to a separate portal, read the correspondence there too. Then record what you found below." : intervention.safeAction}</p>
                  {linkedSource && <a href={linkedSource.url!} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm font-medium text-primary underline">Open original message</a>}
                </div>
              </div>
              <p className="min-w-0 border-t pt-3 text-xs text-muted-foreground">{unspecifiedQuestion ? "Follow-up on this item remains on hold until the source has been checked. You can continue with unrelated work." : blockedAction?.reason ?? "Confirm this prerequisite before starting the dependent step."}</p>
            </div>
          ) : next ? (
            <div className="min-w-0 space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Next step</p>
              <h3 className="break-words text-base font-semibold">{next.title}</h3>
              <p className="break-words text-sm text-muted-foreground">{next.reason}</p>
              <p className="text-xs text-muted-foreground">Estimated {next.minutes.low}-{next.minutes.high} min · {next.where}</p>
            </div>
          ) : (
            <div>
              <h3 className="text-base font-semibold">No action is waiting for you</h3>
              <p className="mt-1 text-sm text-muted-foreground">The manager has no unblocked next step in the current assessment.</p>
            </div>
          )}
          <Button variant="outline" size="sm" className="rounded-md" aria-expanded={open} aria-controls="manager-context" onClick={() => setOpen(value => !value)}>
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}{open ? "Hide answer and evidence" : intervention ? "Show evidence and answer" : "Show task details"}
          </Button>
        </div>
      )}
      {snapshot?.applied && <Alert variant="destructive"><AlertTitle>Unexpected: applied to active plan</AlertTitle><AlertDescription>Stop the shadow trial and review the assessment.</AlertDescription></Alert>}
      {reviewNotice && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">This advice has not been fully checked. Verify the source before acting.</p>}
      {ageMinutes !== null && ageMinutes > Math.max(2, (policy?.intervalMinutes ?? 5) * 2) && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">The information may be out of date. Check for recent changes before continuing.</p>}
      {showDiagnostics && <details className="group text-xs text-muted-foreground">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm py-1 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />System status</summary>
        <div className="mt-2 space-y-3 border-t pt-3">
      {reviewNotice && <Alert><AlertTriangle className="size-4" /><AlertTitle>{reviewNotice.title}</AlertTitle><AlertDescription>{reviewNotice.message} Automatic retry: <ManagerTimestamp value={snapshot!.semanticReview!.retryAfter} /> The deterministic checks remain active and the manager is still in shadow mode.</AlertDescription></Alert>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" role="status">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={"size-1.5 shrink-0 rounded-full " + (connection.connected ? "bg-emerald-500" : "bg-amber-500")} />{connection.connected ? "Realtime connected" : "Fallback polling every 60 seconds"}</span>
        <span>Manager data: {age}</span>
        {ageMinutes !== null && ageMinutes > Math.max(2, (policy?.intervalMinutes ?? 5) * 2) && <span className="text-amber-700 dark:text-amber-300">Data may be stale</span>}
        {processing && processing.state !== "idle" && <span>{!policy?.enabled ? "Automatic processing paused" : processing.state === "leased" ? "Assessment processing" : processing.state === "failed" ? "Assessment needs attention" : "Assessment queued"}</span>}
      </div>
          <p>{policy?.mode === "shadow" ? "Proposals only; the active plan is unchanged." : "A confirmed shadow policy is required. Manager actions are paused."}</p>
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {snapshot && <span>{snapshot.assessments.length} assessed</span>}
            <span>Last check: <ManagerTimestamp value={query.data?.checkedAt} /></span>
            {snapshot && <><span>Assessment: <ManagerTimestamp value={snapshot.assessedAt} /></span><span>Next check: {policy?.enabled ? (snapshot.nextCheckAt ? <ManagerTimestamp value={snapshot.nextCheckAt} /> : "not scheduled") : "paused"}</span><span>{snapshot.applied ? "Unexpected: applied to active plan" : "Proposal not applied"}</span></>}
          </div>
          {processing && processing.state !== "idle" && <p>Received: <ManagerTimestamp value={processing.requestedAt} />{processing.attempts > 0 && <>; Attempts: {processing.attempts}</>}{processing.lastError && <>; {processing.lastError}; Next eligible retry: <ManagerTimestamp value={processing.availableAt} /></>}</p>}
          {snapshot?.semanticReview?.provider === "codex-subscription" && <div className="space-y-1"><p>AI: Codex subscription · Luna · low first, high maximum</p>{!!snapshot.semanticReview.attempts?.length && <p>Last review: {snapshot.semanticReview.attempts.map(attempt => attempt.effort + " (" + attempt.outcome.replaceAll("_", " ") + (attempt.reason ? ": " + attempt.reason.replaceAll("_", " ") : "") + ")").join(" → ")}</p>}</div>}
        </div>
      </details>}
      </div>
      {open && <div id="manager-context" className="grid min-w-0 items-start gap-5 border-t pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0 2xl:grid-cols-2">
        {intervention && <section className="min-w-0 space-y-3" aria-label="Evidence to check">
          <div className="flex min-w-0 items-start gap-2">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0"><h3 className="text-sm font-semibold">Evidence to check</h3></div>
          </div>
          <ManagerVerificationDetails intervention={intervention} />
        </section>}
        {next && !intervention && <div className="min-w-0 space-y-1"><p className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Task details</p><p className="break-words text-sm font-medium">{next.title}</p><p className="break-words text-sm text-muted-foreground">{next.reason}</p><p className="text-xs text-muted-foreground">About {next.minutes.likely} min · {next.where}</p></div>}
        <form className="min-w-0 space-y-3 border-t pt-4 2xl:border-l 2xl:border-t-0 2xl:pl-5 2xl:pt-0" onSubmit={event => { event.preventDefault(); if (canAssess && !contextChanged && cardId && detail.trim().length >= 3) update.mutate({ cardId, detail: outcome === "Update" && !deadline ? detail.trim() : ["Result: " + outcome, deadline ? "Reported deadline: " + deadline : "Deadline: not recorded", detail.trim()].join("\n"), interventionId: intervention?.cardId === cardId ? intervention.id : undefined }); }}>
          <div className="space-y-1"><h3 className="text-sm font-semibold">Record your update</h3><p className="text-xs text-muted-foreground">{intervention ? "Record what you found, or explain what prevents you from continuing." : "Record the latest result or a correction."}</p></div>
          <div className="max-w-md space-y-1"><Label htmlFor="manager-context-card">Related task</Label><select id="manager-context-card" value={cardId} disabled={busy || !availableCards.length} onChange={event => { setSelectedCardId(event.target.value); setDetail(""); setDeadline(""); setOutcome("Update"); setDraftContext(null); setSaved(false); }} className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground">{!availableCards.length && <option value="">No linked card available</option>}{availableCards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}</select></div>
          {contextChanged && <div role="alert" className="space-y-2 border-l-2 border-amber-500 pl-3 text-sm"><p>The instruction changed while you were writing. Your answer is still here. Review the current question and evidence, then update your answer before sending.</p><Button type="button" variant="outline" className="h-auto whitespace-normal" disabled={!canAssess || !cardId} onClick={() => setDraftContext(contextKey)}>I have reviewed the updated instruction</Button></div>}
          <div><Label htmlFor="manager-result">Result</Label><select id="manager-result" value={outcome} disabled={busy} onChange={event => { pinDraftContext(); setOutcome(event.target.value); }} className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"><option>Update</option><option>Action needed</option><option>No action needed</option><option>Cannot access source</option><option>Need Robert's decision</option></select></div>
          <div><Label htmlFor="manager-deadline">Deadline stated in the source (optional)</Label><input id="manager-deadline" type="date" value={deadline} disabled={busy} onChange={event => { pinDraftContext(); setDeadline(event.target.value); }} className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" /></div>
          <div><Label htmlFor="manager-update">{intervention ? "What did you confirm?" : "What changed in reality?"}</Label><Textarea id="manager-update" className="mt-2 min-h-24" placeholder={outcome === "Cannot access source" ? "What prevents access? Which source did you try?" : "Describe the request or result and identify the source you checked."} value={detail} disabled={busy} maxLength={7500} onChange={event => { pinDraftContext(); setDetail(event.target.value); }} /></div>
          {saved && <p role="status" className="text-sm">Your update was saved for review. It does not automatically close the task or resolve the issue. Check the refreshed instruction before continuing.</p>}
          <Button type="submit" size="sm" disabled={!cardId || detail.trim().length < 3 || !canAssess || contextChanged}>{update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}Send answer to APTLSS</Button>
          {!availableCards.length && <p className="text-xs text-muted-foreground">A linked card is required before an answer can be submitted.</p>}
        </form>
      </div>}
        {showDiagnostics && open && snapshot && cardId && <details className="min-w-0 border-t pt-3 xl:col-span-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="size-3.5" />Full technical assessment</summary>
          <div className="mt-3 min-w-0"><ManagerSnapshotDetails snapshot={snapshot} cardId={cardId} presentedInterventionId={intervention?.id} /></div>
        </details>}
      </div>
    </section>
  );
}
