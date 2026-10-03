import { useState } from "react";
import { Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ManagerTimestamp } from "./AptlssManagerReview";
import { toast } from "sonner";

type Evidence = { id: string; evidenceId: number | null; source: string; role: "source" | "source_preview" | "linked_source" | "worker_update" | "reviewed_resolution"; title: string; content: string | null; sourceUrl: string | null; observedAt: Date | string; modifiedAt: Date | string | null; contentNote: string | null; statusLabel: string | null };

function sourceLabel(source: string) {
  if (source === "google_drive") return "Google Drive";
  if (source === "gmail") return "Gmail";
  if (source === "trello") return "Trello";
  if (source === "communication") return "Message";
  if (source === "worker_update") return "Worker update";
  if (source === "decision_outcome") return "Decision";
  return "Record";
}

function roleLabel(role: Evidence["role"]) {
  if (role === "worker_update") return "Your update";
  if (role === "reviewed_resolution") return "Reviewed outcome";
  if (role === "source_preview") return "Email preview";
  if (role === "linked_source") return "Linked source";
  return "Original source";
}

function CaseFile({ evidence, loading, error, timeZone }: { evidence: Evidence[]; loading: boolean; error: boolean; timeZone: string }) {
  const [showAll, setShowAll] = useState(false);
  const visibleEvidence = showAll ? evidence : evidence.slice(0, 5);
  return <section className="min-w-0 space-y-2" aria-labelledby="worker-case-file-title">
    <div>
      <h3 id="worker-case-file-title" className="text-sm font-semibold">Case file</h3>
      <p className="mt-1 text-xs text-muted-foreground">Source records and your updates linked to this task.</p>
    </div>
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading case records...</p>}
    {error && <p role="alert" className="text-sm text-destructive">Case records could not be loaded. Reload the task details to try again.</p>}
    {!loading && !error && evidence.length === 0 && <p className="border-y py-3 text-sm text-muted-foreground">No source records or updates have been linked to this task yet.</p>}
    {!!visibleEvidence.length && <div className="divide-y border-y">
      {visibleEvidence.map(item => {
        const observedAt = new Date(item.observedAt);
        const hasObservedAt = Number.isFinite(observedAt.getTime());
        return <article key={item.id} className="min-w-0 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{roleLabel(item.role)}</span>
          <span aria-hidden="true">·</span>
          <span>{sourceLabel(item.source)}</span>
          {item.statusLabel && <><span aria-hidden="true">·</span><span className="font-medium text-foreground">{item.statusLabel}</span></>}
          <span aria-hidden="true">·</span>
          {hasObservedAt ? <time dateTime={observedAt.toISOString()}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(observedAt)}</time> : <span>Date not recorded</span>}
        </div>
        <p className="mt-1 break-words text-sm font-medium">{item.title}</p>
        {item.content ? <details className="mt-1 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Read saved text</summary>
          <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3">{item.content}</p>
        </details> : <p className="mt-1 text-xs text-muted-foreground">No additional text is saved here.</p>}
        {item.contentNote && <p className="mt-2 text-xs text-muted-foreground">{item.contentNote}</p>}
        {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">Open original <ExternalLink className="size-3.5" /></a>}
      </article>;
      })}
    </div>}
    {evidence.length > 5 && <Button type="button" variant="outline" size="sm" onClick={() => setShowAll(value => !value)}>{showAll ? "Show fewer records" : `Show all ${evidence.length} records`}</Button>}
  </section>;
}

function VerificationFollowup({ followup, evidence, evidenceUnavailable, refreshEvidence }: {
  followup: { id: number; conflictId: number | null; title: string; question: string };
  evidence: Evidence[];
  evidenceUnavailable: boolean;
  refreshEvidence: () => void;
}) {
  const utils = trpc.useUtils();
  const [resolution, setResolution] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [quote, setQuote] = useState("");
  const sources = evidence.filter(item => item.role === "source" && item.evidenceId !== null);
  const source = sources.find(item => String(item.evidenceId) === sourceId);
  const sourceText = source?.content ?? "";
  const conflict = followup.conflictId !== null;
  const quoted = quote.trim();
  const proofReady = !!source && quoted.length >= 3 && sourceText.includes(quoted) && !evidenceUnavailable;
  const prefix = `followup-${followup.id}`;
  const resolve = trpc.operator.resolveVerificationFollowup.useMutation({
    onSuccess: result => {
      toast.success(result.requiresEvidence ? "Note saved; conflict remains open" : "Verification follow-up resolved");
      setResolution("");
      void utils.operator.getVerificationFollowups.invalidate();
      void utils.operator.getCardEvidence.invalidate();
      void utils.operator.getManagerStatus.invalidate();
      void utils.operator.getWorkQueueContext.invalidate();
    },
    onError: () => toast.error("We couldn't save the verification update. Your note is still here; try again or contact your supervisor."),
  });
  return <form className="min-w-0 space-y-3 border-l-2 border-amber-500 pl-3" aria-label={followup.title} onSubmit={event => {
    event.preventDefault();
    if (resolution.trim().length < 3 || resolve.isPending || (conflict && !proofReady)) return;
    resolve.mutate({ followupId: followup.id, resolution: resolution.trim(), ...(conflict && source && source.evidenceId !== null ? { sourceEvidenceId: source.evidenceId, sourceQuote: quoted } : {}) });
  }}>
    <div><p className="text-sm font-medium">{followup.title}</p><p className="mt-1 text-sm text-muted-foreground">{followup.question}</p></div>
    <div className="space-y-1"><Label htmlFor={`${prefix}-resolution`}>What did you find?</Label><Textarea id={`${prefix}-resolution`} value={resolution} onChange={event => setResolution(event.target.value)} maxLength={4000} disabled={resolve.isPending} /></div>
    {conflict && <>
      <div className="space-y-1"><Label htmlFor={`${prefix}-source`}>Which original source confirms it?</Label><select id={`${prefix}-source`} value={sourceId} onChange={event => { setSourceId(event.target.value); setQuote(""); }} disabled={resolve.isPending || evidenceUnavailable} className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"><option value="">Choose a source record</option>{sources.map(item => <option key={item.id} value={item.evidenceId!}>{sourceLabel(item.source)}: {item.title}</option>)}</select></div>
      <Button type="button" size="sm" variant="outline" disabled={evidenceUnavailable || resolve.isPending} onClick={refreshEvidence}><RefreshCw className="size-4" />Reload sources</Button>
      {!sources.length && <p className="text-xs text-muted-foreground">No original source is linked to this task. The issue will stay open until the source is checked.</p>}
      {source && <div className="space-y-1 text-xs"><p className="font-medium">Saved text from this source</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{sourceText || "No source text was saved."}</p><p className="text-muted-foreground">Received or saved: <ManagerTimestamp value={source.observedAt} />{source.modifiedAt ? <> · Changed: <ManagerTimestamp value={source.modifiedAt} /></> : null}</p>{source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-700 underline dark:text-blue-300">Open original <ExternalLink className="size-3" /></a>}</div>}
      <div className="space-y-1"><Label htmlFor={`${prefix}-quote`}>Exact sentence from the source</Label><Textarea id={`${prefix}-quote`} value={quote} onChange={event => setQuote(event.target.value)} maxLength={4000} disabled={!source || resolve.isPending} aria-describedby={`${prefix}-proof-status`} /><p id={`${prefix}-proof-status`} className="text-xs text-muted-foreground">{quoted && !sourceText.includes(quoted) ? "This wording does not match the saved source text." : "We check the selected source and wording before closing this issue."}</p></div>
    </>}
    {resolve.error && <p role="alert" className="text-sm text-destructive">We couldn't save this update. Your note is still here. Try again, or contact your supervisor if the problem continues.</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={resolve.isPending || resolution.trim().length < 3 || (conflict && !proofReady)}>{resolve.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{conflict ? "Save verification and close" : "Save and close follow-up"}</Button>{conflict && <Button type="button" variant="outline" size="sm" disabled={resolve.isPending || resolution.trim().length < 3} onClick={() => resolve.mutate({ followupId: followup.id, resolution: resolution.trim() })}>Save note; keep open</Button>}</div>
  </form>;
}

export default function ManagerVerificationFollowups({ cardId }: { cardId: string }) {
  const evidence = trpc.operator.getCardEvidence.useQuery({ cardId, limit: 100 }, { retry: false, staleTime: 60_000 });
  const verification = trpc.operator.getVerificationFollowups.useQuery({ cardId }, { retry: false, staleTime: 30_000 });
  const records = evidence.data ?? [];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return <section className="min-w-0 space-y-3">
    <CaseFile evidence={records} loading={evidence.isLoading} error={!!evidence.error} timeZone={timeZone} />
    <h3 className="border-t pt-4 text-sm font-semibold">Needs your response</h3>
    {verification.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading verification follow-ups...</p>}
    {verification.error && <p role="alert" className="text-sm text-destructive">This follow-up could not be loaded. Reload the task details to try again.</p>}
    {verification.data?.map(followup => <VerificationFollowup key={`${cardId}-${followup.id}`} followup={followup} evidence={records} evidenceUnavailable={!!evidence.error || evidence.isFetching || !!verification.error} refreshEvidence={() => void evidence.refetch()} />)}
    {!verification.isLoading && !verification.error && verification.data?.length === 0 && <p className="text-sm text-muted-foreground">No conflicting evidence needs a worker response.</p>}
  </section>;
}
