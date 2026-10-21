import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, Loader2, RefreshCw } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type AttentionJob = {
  id: number; userOpenId: string; deliveryPhase: string | null; status: string;
  notificationCount: number; attemptCount: number; attemptedAt: string | null;
  nextAttemptAt: string | null; completedAt: string | null; reconciledAt: string | null; reason?: string;
};
type ReviewJob = Pick<AttentionJob, "id" | "deliveryPhase" | "attemptCount" | "attemptedAt"> & {
  recipientEmail: string | null; subject: string | null; text: string; textTruncated: boolean; integrityVerified?: boolean; notificationIds: number[]; payloadHash: string | null;
};
const root = "/api/notifications/digest-jobs";
const legacyReview = (reason?: string) => reason === "legacy_membership_unverified" || reason === "legacy_membership_unknown";
const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded";
const reviewable = (job: { deliveryPhase: string | null; reason?: string }) =>
  !legacyReview(job.reason) && job.reason !== "dispatch_in_progress" && (
    job.deliveryPhase === "uncertain" || job.deliveryPhase === "not_sent"
    || (job.deliveryPhase === "dispatching" && job.reason === "delivery_requires_reconciliation"));

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
  const response = await fetch(url, { ...options, signal, credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error.slice(0, 500) : `Digest request unavailable (${response.status}).`);
  if (!body) throw new Error("Digest response unavailable. Check status before taking another action.");
  return body as T;
}

export function DigestRecovery() {
  const { user, loading, verificationUnavailable } = useAuth();
  // Unmount all recovery state when the session is no longer verified as admin.
  if (loading || verificationUnavailable || user?.role !== "admin") return null;
  return <AdminDigestRecovery key={user.openId} actor={user.openId} />;
}

function AdminDigestRecovery({ actor }: { actor: string }) {
  const [selected, setSelected] = useState<AttentionJob | null>(null);
  const [notice, setNotice] = useState("");
  const attention = useQuery({
    queryKey: ["digest-recovery-attention", actor],
    queryFn: async ({ signal }) => {
      const data = await request<{ jobs: AttentionJob[] }>(`${root}/attention`, { signal });
      if (!Array.isArray(data.jobs)) throw new Error("Digest attention list unavailable.");
      return data.jobs.slice(0, 100);
    },
    retry: false, gcTime: 0, refetchInterval: 15_000, refetchIntervalInBackground: false, refetchOnWindowFocus: false,
  });
  return <section aria-labelledby="digest-recovery-heading" className="min-w-0 space-y-3 border-t pt-4">
    <div className="flex items-center justify-between gap-3">
      <h3 id="digest-recovery-heading" className="text-base font-semibold">Digest recovery</h3>
      <Button variant="outline" size="icon" aria-label="Refresh digest attention" title="Refresh digest attention" disabled={attention.isFetching} onClick={() => void attention.refetch()}>
        {attention.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
      </Button>
    </div>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {attention.isPending && <p role="status" className="text-sm text-muted-foreground">Loading digest attention</p>}
    {attention.isError ? <p role="alert" className="break-words text-sm text-destructive">Cannot confirm digest attention. {attention.error.message} Use refresh to check again.</p>
      : attention.data?.length === 0 ? <p className="text-sm text-muted-foreground">No digest jobs need attention.</p>
      : <ul className="divide-y">{attention.data?.map(job => <li key={job.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 flex-1 basis-56 space-y-1 break-words text-sm">
          <p className="font-medium">Digest #{job.id} <span className="font-normal text-muted-foreground">{job.deliveryPhase ?? "Unknown phase"} / {job.status}</span></p>
          <p className="text-xs text-muted-foreground break-all">{job.userOpenId}</p>
          <p className="text-xs text-muted-foreground">{job.notificationCount} notifications · {job.attemptCount} attempts · Last attempt: {time(job.attemptedAt)}</p>
          {(job.reason || job.deliveryPhase === null) && <p className="text-xs text-muted-foreground">{legacyReview(job.reason) || job.deliveryPhase === null ? "Requires private migration review. Historical notification membership is unverified." : job.reason!.replaceAll("_", " ")}</p>}
          {job.nextAttemptAt && <p className="text-xs text-muted-foreground">Next attempt: {time(job.nextAttemptAt)}</p>}
          {job.reconciledAt && <p className="text-xs text-muted-foreground">Reconciled: {time(job.reconciledAt)}</p>}
        </div>
        {reviewable(job) && <Button variant="outline" size="sm" onClick={() => { setNotice(""); setSelected(job); }}><ClipboardCheck className="mr-2 size-4" />Review digest #{job.id}</Button>}
      </li>)}</ul>}
    {selected && <DigestReview key={selected.id} actor={actor} selected={selected} close={() => setSelected(null)} recorded={(outcome) => {
      setNotice(outcome === "retry" ? "Reconciliation recorded. A future attempt is authorized; no email delivery is confirmed." : "Reconciliation recorded from operator evidence, not a provider-verified receipt.");
      setSelected(null);
      void attention.refetch();
    }} />}
  </section>;
}

function DigestReview({ actor, selected, close, recorded }: { actor: string; selected: AttentionJob; close: () => void; recorded: (outcome: "sent" | "retry") => void }) {
  const [outcome, setOutcome] = useState<"sent" | "retry" | "">("");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [ack, setAck] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const detail = useQuery({
    queryKey: ["digest-recovery-review", actor, selected.id],
    queryFn: async ({ signal }) => {
      const data = await request<{ job: ReviewJob }>(`${root}/${selected.id}`, { signal });
      if (data.job?.id !== selected.id || typeof data.job.text !== "string" || !Array.isArray(data.job.notificationIds)) throw new Error("Frozen digest review unavailable.");
      return data.job;
    },
    retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const job = detail.data;
  const eligible = job && job.integrityVerified !== false && reviewable({ ...job, reason: selected.reason });
  const valid = eligible && outcome && note.trim().length >= 10 && note.trim().length <= 2000
    && evidence.trim().length >= 3 && evidence.trim().length <= 1000 && (outcome !== "retry" || ack)
    && (outcome !== "sent" || job.deliveryPhase !== "not_sent");
  async function reconcile() {
    if (!valid || !outcome || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = await request<{ reconciled?: boolean; reconciliationOutcome?: string }>(`${root}/${selected.id}/reconcile`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, note: note.trim(), evidenceReference: evidence.trim(), ...(outcome === "retry" ? { acknowledgeDuplicateRisk: ack } : {}) }),
      });
      // Only the post-commit machine acknowledgement confirms recorded reconciliation.
      if (result.reconciled !== true || result.reconciliationOutcome !== outcome) {
        throw new Error("Reconciliation was not confirmed. Refresh and review the current digest status.");
      }
      recorded(outcome);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconciliation unconfirmed. Check status before submitting again.");
    } finally { inFlight.current = false; setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) close(); }}>
    <DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-2xl" showCloseButton={!pending}>
      <DialogHeader className="min-w-0 pr-5">
        <DialogTitle>Review digest #{selected.id}</DialogTitle>
        <DialogDescription>Record delivery evidence or authorize a future attempt. This action does not send email or verify a provider receipt.</DialogDescription>
      </DialogHeader>
      {detail.isPending && <p role="status">Loading frozen digest</p>}
      {detail.isError && <div className="space-y-2"><p role="alert" className="break-words text-sm text-destructive">{detail.error.message}</p><Button variant="outline" disabled={detail.isFetching} onClick={() => void detail.refetch()}><RefreshCw className="mr-2 size-4" />Reload review</Button></div>}
      {job && <>
        <dl className="min-w-0 space-y-2 break-words text-sm">
          <div><dt className="text-muted-foreground">Frozen recipient</dt><dd className="break-all">{job.recipientEmail ?? "Not recorded"}</dd></div>
          <div><dt className="text-muted-foreground">Frozen subject</dt><dd>{job.subject ?? "Not recorded"}</dd></div>
          <div><dt className="text-muted-foreground">Attempt</dt><dd>{job.deliveryPhase ?? "Unknown phase"} · {job.attemptCount} attempts · {time(job.attemptedAt)}</dd></div>
        </dl>
        <div className="min-w-0"><p className="mb-2 text-sm text-muted-foreground">Frozen message · {job.notificationIds.length} notifications</p>{job.textTruncated && <p role="alert" className="mb-2 text-sm text-amber-600 dark:text-amber-400">Preview is incomplete. Review the complete message in private records before recording reconciliation.</p>}<pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-3 text-sm [overflow-wrap:anywhere]">{job.text}</pre></div>
        {!eligible && <p role="alert" className="text-sm text-destructive">This digest is no longer available for reconciliation. Close and refresh attention.</p>}
        <div className="min-w-0 space-y-2">
          <label htmlFor="digest-outcome" className="text-sm font-medium">Outcome</label>
          <Select value={outcome} disabled={pending || !eligible} onValueChange={(value: "sent" | "retry") => { setOutcome(value); setAck(false); }}>
            <SelectTrigger id="digest-outcome" className="w-full"><SelectValue placeholder="Choose an outcome" /></SelectTrigger>
            <SelectContent><SelectItem value="sent" disabled={job.deliveryPhase === "not_sent"}>Sent confirmed</SelectItem><SelectItem value="retry">Authorize another attempt</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="space-y-2"><label htmlFor="digest-note" className="text-sm font-medium">Review note (10-2000 characters)</label><Textarea id="digest-note" value={note} maxLength={2000} disabled={pending} onChange={event => setNote(event.target.value)} /></div>
        <div className="space-y-2"><label htmlFor="digest-evidence" className="text-sm font-medium">Evidence reference (3-1000 characters)</label><Input id="digest-evidence" value={evidence} maxLength={1000} disabled={pending} onChange={event => setEvidence(event.target.value)} /></div>
        {outcome === "retry" && <label className="flex items-start gap-3 text-sm" htmlFor="digest-risk"><Checkbox id="digest-risk" className="mt-0.5 shrink-0" checked={ack} disabled={pending} onCheckedChange={value => setAck(value === true)} /><span>I acknowledge that another attempt could deliver a duplicate email.</span></label>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <Button className="h-auto min-h-9 whitespace-normal" disabled={pending || !valid} onClick={() => void reconcile()}>{pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ClipboardCheck className="mr-2 size-4 shrink-0" />}Record reconciliation</Button>
      </>}
    </DialogContent>
  </Dialog>;
}
