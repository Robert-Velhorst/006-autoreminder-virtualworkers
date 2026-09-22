import { useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ManagerTimestamp } from "./AptlssManagerReview";
import { toast } from "sonner";

type Evidence = { id: number; source: string; kind: string; title: string; content: string | null; summary: string | null; observedAt: Date; modifiedAt: Date | null };

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
  const sources = evidence.filter(item => !/worker_assertion|system_inference|verified_conflict_resolution/.test(item.kind));
  const source = sources.find(item => String(item.id) === sourceId);
  const sourceText = source?.content ?? source?.summary ?? "";
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
    onError: error => toast.error(error.message),
  });
  return <form className="min-w-0 space-y-3 border-l-2 border-amber-500 pl-3" aria-label={followup.title} onSubmit={event => {
    event.preventDefault();
    if (resolution.trim().length < 3 || resolve.isPending || (conflict && !proofReady)) return;
    resolve.mutate({ followupId: followup.id, resolution: resolution.trim(), ...(conflict && source ? { sourceEvidenceId: source.id, sourceQuote: quoted } : {}) });
  }}>
    <div><p className="text-sm font-medium">{followup.title}</p><p className="mt-1 text-sm text-muted-foreground">{followup.question}</p></div>
    <div className="space-y-1"><Label htmlFor={`${prefix}-resolution`}>Verification explanation</Label><Textarea id={`${prefix}-resolution`} value={resolution} onChange={event => setResolution(event.target.value)} maxLength={4000} disabled={resolve.isPending} /></div>
    {conflict && <>
      <div className="space-y-1"><Label htmlFor={`${prefix}-source`}>Proof source</Label><select id={`${prefix}-source`} value={sourceId} onChange={event => { setSourceId(event.target.value); setQuote(""); }} disabled={resolve.isPending || evidenceUnavailable} className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"><option value="">Select retained source evidence</option>{sources.map(item => <option key={item.id} value={item.id}>{item.source}: {item.title} [#{item.id}]</option>)}</select></div>
      <Button type="button" size="sm" variant="outline" disabled={evidenceUnavailable || resolve.isPending} onClick={refreshEvidence}><RefreshCw className="size-4" />Refresh proof sources</Button>
      {!sources.length && <p className="text-xs text-muted-foreground">No retained source proof is linked to this card. The conflict remains open.</p>}
      {source && <div className="space-y-1 text-xs"><p className="font-medium">Retained source text</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{sourceText || "No source text recorded."}</p><p className="text-muted-foreground">Observed: <ManagerTimestamp value={source.observedAt} />; source date: <ManagerTimestamp value={source.modifiedAt} /></p></div>}
      <div className="space-y-1"><Label htmlFor={`${prefix}-quote`}>Exact source quote</Label><Textarea id={`${prefix}-quote`} value={quote} onChange={event => setQuote(event.target.value)} maxLength={4000} disabled={!source || resolve.isPending} aria-describedby={`${prefix}-proof-status`} /><p id={`${prefix}-proof-status`} className="text-xs text-muted-foreground">{quoted && !sourceText.includes(quoted) ? "The quote does not match the retained source text." : "Source authority, revision and disputed facts must pass backend verification."}</p></div>
    </>}
    {resolve.error && <p role="alert" className="text-sm text-destructive">{resolve.error.message}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={resolve.isPending || resolution.trim().length < 3 || (conflict && !proofReady)}>{resolve.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{conflict ? "Verify source and resolve" : "Resolve follow-up"}</Button>{conflict && <Button type="button" variant="outline" size="sm" disabled={resolve.isPending || resolution.trim().length < 3} onClick={() => resolve.mutate({ followupId: followup.id, resolution: resolution.trim() })}>Save note (keep open)</Button>}</div>
  </form>;
}

export default function ManagerVerificationFollowups({ cardId }: { cardId: string }) {
  const evidence = trpc.operator.getCardEvidence.useQuery({ cardId, limit: 100 }, { retry: false, staleTime: 60_000 });
  const verification = trpc.operator.getVerificationFollowups.useQuery({ cardId }, { retry: false, staleTime: 30_000 });
  return <section className="min-w-0 space-y-3">
    <h3 className="text-sm font-semibold">Verification follow-ups</h3>
    {verification.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading verification follow-ups...</p>}
    {(verification.error || evidence.error) && <p role="alert" className="text-sm text-destructive">{verification.error?.message ?? evidence.error?.message}</p>}
    {verification.data?.map(followup => <VerificationFollowup key={`${cardId}-${followup.id}`} followup={followup} evidence={evidence.data ?? []} evidenceUnavailable={!!evidence.error || evidence.isFetching || !!verification.error} refreshEvidence={() => void evidence.refetch()} />)}
    {!verification.isLoading && !verification.error && verification.data?.length === 0 && <p className="text-sm text-muted-foreground">No conflicting evidence needs a worker response.</p>}
  </section>;
}
