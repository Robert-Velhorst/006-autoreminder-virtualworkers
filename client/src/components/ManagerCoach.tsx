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
import { ManagerTimestamp } from "./AptlssManagerReview";
import { ManagerVerificationDetails } from "./ManagerVerificationDetails";
import { workerFacingManagerQuestion } from "@shared/aptlssManager";
import { selectManagerPrimary } from "@shared/workerTodayGuidance";
import { toast } from "sonner";
import type { ManagerEvidence } from "@shared/aptlssManager";

function safeHttpUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function evidenceSourceName(source: string) {
  if (source === "gmail") return "Gmail";
  if (source === "google_drive") return "Google Drive";
  if (source === "trello") return "Trello";
  return source.replaceAll("_", " ");
}

function ManagerTaskEvidence({ evidence }: { evidence: ManagerEvidence[] }) {
  const groups = new Map<string, { source: string; excerpts: string[]; urls: string[]; observedAt: string; sourceDate?: string | null; preview: boolean }>();
  for (const item of evidence) {
    const key = `${item.source}:${item.metadata?.sourceRecordId ?? item.id}`;
    const group = groups.get(key) ?? {
      source: item.source,
      excerpts: [],
      urls: [],
      observedAt: item.observedAt,
      sourceDate: item.metadata?.sourceDate,
      preview: item.metadata?.contentScope === "message_preview" || item.metadata?.contentScope === "portal_notice",
    };
    if (item.text.trim() && !group.excerpts.includes(item.text.trim())) group.excerpts.push(item.text.trim());
    const href = safeHttpUrl(item.url);
    if (href && !group.urls.includes(href)) group.urls.push(href);
    if (!group.sourceDate && item.metadata?.sourceDate) group.sourceDate = item.metadata.sourceDate;
    group.preview ||= item.metadata?.contentScope === "message_preview" || item.metadata?.contentScope === "portal_notice";
    groups.set(key, group);
  }
  const records = [...groups.values()];
  if (!records.length) return null;
  const visible = records.slice(0, 3);
  const additional = records.slice(3);
  const renderRecord = (record: (typeof visible)[number], index: number) => (
    <li key={`${record.source}:${record.urls[0] ?? index}`} className="min-w-0 space-y-2 border-l-2 pl-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{evidenceSourceName(record.source)}</span>
        <span>{record.preview ? "Preview only" : "Source excerpt"}</span>
        {record.sourceDate ? <span>Source date: <ManagerTimestamp value={record.sourceDate} /></span> : <span>Added: <ManagerTimestamp value={record.observedAt} /></span>}
      </div>
      {record.excerpts[0] && <p className="line-clamp-3 break-words text-sm">{record.excerpts[0]}</p>}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {record.urls[0] ? <a href={record.urls[0]} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-800 underline underline-offset-2 dark:text-blue-300">Open full source</a> : <span className="text-xs text-muted-foreground">Original source link unavailable</span>}
        {record.excerpts.length > 1 && <details className="min-w-0 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">Other excerpts ({record.excerpts.length - 1})</summary>
          <ul className="mt-2 list-inside list-disc space-y-2 break-words">
            {record.excerpts.slice(1).map((excerpt, excerptIndex) => <li key={excerptIndex}>{excerpt}</li>)}
          </ul>
        </details>}
      </div>
    </li>
  );
  return (
    <section aria-label="Evidence for this task" className="min-w-0 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Evidence for this task</h3>
        <p className="text-xs text-muted-foreground">These are excerpts. Open the original record for the full context.</p>
      </div>
      <ul className="min-w-0 space-y-3">{visible.map(renderRecord)}</ul>
      {additional.length > 0 && <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer">More linked sources ({additional.length})</summary>
        <ul className="mt-3 min-w-0 space-y-3">{additional.map(renderRecord)}</ul>
      </details>}
    </section>
  );
}

export default function ManagerCoach() {
  const utils = trpc.useUtils();
  const [detail, setDetail] = useState("");
  const [outcome, setOutcome] = useState("Update");
  const [deadline, setDeadline] = useState("");
  const [sourceEvidenceId, setSourceEvidenceId] = useState("");
  const [sourceDescription, setSourceDescription] = useState("");
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
    onError: () => toast.error("Work guidance could not be refreshed. Try again shortly or contact your supervisor."),
  });
  const update = trpc.operator.submitManagerUpdate.useMutation({
    onSuccess: result => { setDetail(""); setDeadline(""); setOutcome("Update"); setSourceEvidenceId(""); setSourceDescription(""); setDraftContext(null); setSaved(true); assessed(result?.applied); },
    onError: () => toast.error("Your update could not be saved. Try again shortly or contact your supervisor."),
  });
  const snapshot = query.data?.snapshot;
  const policy = query.data?.policy;
  const primary = selectManagerPrimary(snapshot);
  const firstIntervention = primary?.intervention;
  const firstNext = primary?.action ?? snapshot?.actions.find(item => !item.blocked);
  const availableCards = snapshot?.cards.length ? snapshot.cards : (queue.data?.cards ?? []).map(card => ({ id: card.cardId, name: card.cardName }));
  const cardId = selectedCardId ? (availableCards.some(card => card.id === selectedCardId) ? selectedCardId : "") : (availableCards.find(card => card.id === (firstIntervention?.cardId ?? firstNext?.cardId))?.id ?? availableCards[0]?.id ?? "");
  const cardInterventions = snapshot?.interventions.filter(item => item.cardId === cardId);
  const cardSourceEvidence = snapshot?.evidence.filter(item => item.cardId === cardId && item.kind === "source") ?? [];
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
  const unspecifiedQuestion = !!intervention && !intervention.issueKind && (/which unknown applies now/i.test(intervention.question) || interventionQuestion.startsWith("Open the linked source and confirm the current fact needed for this task:"));
  const sourceCheck = intervention?.issueKind === "source_check" || unspecifiedQuestion;
  const emailSourceCheck = sourceCheck && (snapshot?.evidence.some(item => item.cardId === intervention?.cardId && item.source === "gmail") || intervention?.verification?.passages.some(item => item.source === "gmail"));
  const urgent = intervention?.severity === "urgent" && !unspecifiedQuestion;
  const linkedSource = snapshot?.evidence.find(item => intervention?.evidenceIds.includes(item.id) && item.url && /^https?:\/\//i.test(item.url));
  const attentionCard = availableCards.find(card => card.id === (intervention?.cardId ?? next?.cardId));
  const blockedAction = intervention ? snapshot?.actions.find(item => item.cardId === intervention.cardId && item.blocked) : undefined;
  const verificationAction = intervention ? snapshot?.actions.find(item => item.cardId === intervention.cardId && item.kind === "verify") : undefined;
  const lastSuccessfulAt = query.data?.lastSuccessfulAt;
  const lastSuccessfulTime = lastSuccessfulAt ? new Date(lastSuccessfulAt).getTime() : NaN;
  const ageMinutes = Number.isFinite(lastSuccessfulTime) ? Math.max(0, Math.floor((now - lastSuccessfulTime) / 60_000)) : null;
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
        <Button variant="ghost" size="sm" className="shrink-0 rounded-md disabled:text-muted-foreground disabled:opacity-100" aria-label="Reassess now" onClick={() => { if (canAssess) run.mutate({ trigger: "manual" }); }} disabled={!canAssess}>
          {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Reassess now
        </Button>
      </div>
      <div className={open ? "grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" : "min-w-0"}>
      <div className="min-w-0 space-y-3">
      {(query.error || query.data?.error) && <Alert variant="destructive"><AlertTriangle className="size-4" /><AlertTitle>Work guidance could not be refreshed</AlertTitle><AlertDescription>Try again shortly. You can continue with unrelated work. Contact your supervisor if the problem continues.</AlertDescription></Alert>}
      {query.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading manager status...</p> : !snapshot ? <p className="text-sm text-muted-foreground">No assessment has been recorded yet.</p> : (
        <div aria-label="Current manager instruction" role={urgent ? "alert" : "status"} className={"min-w-0 space-y-4 border-l-2 px-3 py-4 sm:px-4 " + (intervention ? urgent ? "border-red-500 bg-red-500/5" : "border-amber-500 bg-amber-500/5" : "border-border bg-muted/30")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {intervention ? <AlertTriangle aria-hidden="true" className={"size-4 shrink-0 " + (intervention.severity === "urgent" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400")} /> : <Check aria-hidden="true" className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />}
              <span className="text-xs font-semibold uppercase tracking-normal">{intervention ? "Needs your input" : "Ready for next step"}</span>
              {attentionCard && <span className="min-w-0 break-words text-xs text-muted-foreground">{attentionCard.name}</span>}
            </div>
              {intervention && <Badge variant="outline">{intervention.issueKind === "conflicting_claims" ? "Conflicting facts" : intervention.issueKind === "reported_difference" ? "Reported difference" : urgent ? "Urgent" : "Source check"}</Badge>}
          </div>
          {intervention ? (
            <div data-testid="manager-guidance-fields" className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <div data-testid="manager-guidance-problem" className="min-w-0 space-y-1">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Problem</p>
                <h3 className="break-words text-base font-semibold">{sourceCheck ? emailSourceCheck ? "Read the full correspondence" : "Check the original source" : intervention.title}</h3>
                <p className="mt-1 break-words text-sm text-muted-foreground">{sourceCheck ? emailSourceCheck ? "The inbox preview does not establish the request or its deadline." : "The available record does not yet establish the next action." : intervention.issueKind === "reported_difference" ? "A reported update has not been reconciled with the original record. This is a check, not a finding that you made a mistake." : intervention.explanation}</p>
              </div>
              <div data-testid="manager-guidance-question" className="min-w-0 border-l-2 border-primary pl-3">
                <p className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-normal text-primary"><span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />Question for you now</p>
                <p className="break-words text-sm font-medium">{unspecifiedQuestion ? "What does the message ask you to do, is there a deadline, and what follow-up is needed?" : interventionQuestion}</p>
              </div>
              <div data-testid="manager-guidance-action" className="flex min-w-0 items-start gap-2">
                <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Do this now</p>
                  <p className="break-words text-sm font-medium">{sourceCheck ? emailSourceCheck ? "Open the message and any correspondence it points to. Record the requested action and deadline." : "Open the source and record the next action and deadline, if stated." : intervention.safeAction}</p>
                  {linkedSource && <a href={linkedSource.url!} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm font-medium text-primary underline">{emailSourceCheck ? "Open Gmail message" : "Open original source"}</a>}
                  {verificationAction && <p className="mt-2 text-xs text-muted-foreground">Allow about {verificationAction.minutes.low}-{verificationAction.minutes.high} min to check the source.</p>}
                </div>
              </div>
              <p className="min-w-0 border-t pt-3 text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">{sourceCheck ? "Follow-up on this item remains on hold until the source has been checked. You can continue with unrelated work." : blockedAction?.reason ?? "Confirm this prerequisite before starting the dependent step."}</p>
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
      {ageMinutes !== null && ageMinutes > Math.max(2, (policy?.intervalMinutes ?? 5) * 2) && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">The information may be out of date. Check for recent changes before continuing.</p>}
      </div>
      {open && <div id="manager-context" className="grid min-w-0 items-start gap-5 border-t pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0 2xl:grid-cols-2">
        {intervention && <section className="min-w-0 space-y-3" aria-label="Evidence to check">
          <div className="flex min-w-0 items-start gap-2">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0"><h3 className="text-sm font-semibold">Evidence to check</h3></div>
          </div>
          <ManagerVerificationDetails intervention={intervention} />
        </section>}
        {!intervention && <ManagerTaskEvidence evidence={cardSourceEvidence} />}
        {next && !intervention && <div className="min-w-0 space-y-1"><p className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Task details</p><p className="break-words text-sm font-medium">{next.title}</p><p className="break-words text-sm text-muted-foreground">{next.reason}</p><p className="text-xs text-muted-foreground">About {next.minutes.likely} min · {next.where}</p></div>}
        <form className="min-w-0 space-y-3 border-t pt-4 2xl:border-l 2xl:border-t-0 2xl:pl-5 2xl:pt-0" onSubmit={event => { event.preventDefault(); if (canAssess && !contextChanged && cardId && detail.trim().length >= 3) update.mutate({ cardId, detail: detail.trim(), outcome: outcome as "Update" | "Action needed" | "No action needed" | "Cannot access source" | "Need Robert's decision", deadlineDate: deadline || undefined, sourceEvidenceId: sourceEvidenceId || undefined, sourceDescription: sourceDescription.trim() || undefined, interventionId: intervention?.cardId === cardId ? intervention.id : undefined }); }}>
          <div className="space-y-1"><h3 className="text-sm font-semibold">Record your update</h3><p className="text-xs text-muted-foreground">{intervention ? "Record what you found, or explain what prevents you from continuing." : "Record the latest result or a correction."}</p></div>
          <div className="max-w-md space-y-1"><Label htmlFor="manager-context-card">Related task</Label><select id="manager-context-card" value={cardId} disabled={busy || !availableCards.length} onChange={event => { setSelectedCardId(event.target.value); setDetail(""); setDeadline(""); setOutcome("Update"); setSourceEvidenceId(""); setSourceDescription(""); setDraftContext(null); setSaved(false); }} className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground">{!availableCards.length && <option value="">No linked card available</option>}{availableCards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}</select></div>
          {contextChanged && <div role="alert" className="space-y-2 border-l-2 border-amber-500 pl-3 text-sm"><p>The instruction changed while you were writing. Your answer is still here. Review the current question and evidence, then update your answer before sending.</p><Button type="button" variant="outline" className="h-auto whitespace-normal" disabled={!canAssess || !cardId} onClick={() => setDraftContext(contextKey)}>I have reviewed the updated instruction</Button></div>}
          <div><Label htmlFor="manager-result">Result</Label><select id="manager-result" value={outcome} disabled={busy} onChange={event => { pinDraftContext(); setOutcome(event.target.value); }} className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"><option>Update</option><option>Action needed</option><option>No action needed</option><option>Cannot access source</option><option>Need Robert's decision</option></select></div>
          <div><Label htmlFor="manager-deadline">Deadline stated in the source (optional)</Label><input id="manager-deadline" type="date" value={deadline} disabled={busy} onChange={event => { pinDraftContext(); setDeadline(event.target.value); }} className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" /></div>
          <div><Label htmlFor="manager-source">Source you checked (optional)</Label><select id="manager-source" value={sourceEvidenceId} disabled={busy} onChange={event => { pinDraftContext(); setSourceEvidenceId(event.target.value); }} className="mt-2 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"><option value="">Other source or not yet checked</option>{cardSourceEvidence.map(item => <option key={item.id} value={item.id}>{item.source} · {item.text.slice(0, 80)}</option>)}</select></div>
          <div><Label htmlFor="manager-source-description">Document or location checked (optional)</Label><input id="manager-source-description" value={sourceDescription} maxLength={512} disabled={busy} onChange={event => { pinDraftContext(); setSourceDescription(event.target.value); }} placeholder="For example, the message in the external portal" className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" /><p className="mt-1 text-xs text-muted-foreground">An inbox notification does not prove what the linked correspondence says. Name that correspondence separately if you opened it.</p></div>
          <div><Label htmlFor="manager-update">{intervention ? "What did you confirm?" : "What changed in reality?"}</Label><Textarea id="manager-update" className="mt-2 min-h-24" placeholder={outcome === "Cannot access source" ? "What prevents access? Which source did you try?" : "Describe the request or result and identify the source you checked."} value={detail} disabled={busy} maxLength={7500} onChange={event => { pinDraftContext(); setDetail(event.target.value); }} /></div>
          {saved && <p role="status" className="text-sm">Your update was saved for review. It does not automatically close the task or resolve the issue. Check the refreshed instruction before continuing.</p>}
          <Button type="submit" size="sm" disabled={!cardId || detail.trim().length < 3 || !canAssess || contextChanged}>{update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}Send answer to APTLSS</Button>
          {!availableCards.length && <p className="text-xs text-muted-foreground">A linked card is required before an answer can be submitted.</p>}
        </form>
      </div>}
      </div>
    </section>
  );
}
