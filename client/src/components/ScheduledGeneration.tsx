import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type ScheduledCard = { id: string; name: string };
export type GenerationSettings = {
  skipExisting?: boolean; validateBeforeGenerate?: boolean; applyToTrello?: boolean;
  replaceExisting?: boolean; minimumConfidence?: number; clarifiedGoal?: unknown; maxRetries?: number;
};
const settingsKeys = ["skipExisting", "validateBeforeGenerate", "applyToTrello", "replaceExisting", "minimumConfidence", "clarifiedGoal", "maxRetries"] as const;
export function generationSettingsOnly(input: GenerationSettings): GenerationSettings {
  return Object.fromEntries(settingsKeys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
}
export type ScheduledGenerationJob = { id: string; scheduledTime: string; status: string; cardIds: string | string[] };
type ApprovalPreview = { jobId: string; expectedSnapshotHash: string; cardIds: string[]; settings: GenerationSettings; scheduledTime: string;
  progress?: { completed: number; needsReview: number; outcomeUnknown: number; failed: number } };
const actionable = (status: string) => status === "pending" || status === "awaiting_approval";
const statusLabel = (status: unknown) => ({ awaiting_approval: "Awaiting approval", pending: "Scheduled", running: "Running", completed: "Completed", completed_with_errors: "Completed with errors", interrupted: "Interrupted", failed: "Failed", cancelled: "Cancelled", needs_review: "Needs review" } as Record<string, string>)[String(status)] ?? "Status unavailable";
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeLabel = (value: string) => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: zone() }).format(new Date(value)) : "Time unavailable";
function cardIds(value: string | string[]): string[] | null {
  try { const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.every(id => typeof id === "string") ? parsed : null;
  } catch { return null; }
}
function localTime(value = new Date(Date.now() + 60 * 60 * 1000)) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
function futureIso(value: string) {
  const date = new Date(value);
  // Reject normalized, nonexistent local times as well as past timestamps.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && Number.isFinite(date.getTime())
    && localTime(date) === value && date.getTime() > Date.now() ? date.toISOString() : null;
}
class ScheduleHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function request(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
  const response = await fetch(path, { method, credentials: "include", signal: signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ScheduleHttpError(response.status, typeof data?.error === "string" ? data.error : `Request returned HTTP ${response.status}`);
  if (!data || typeof data !== "object") throw new Error("Unconfirmed response");
  return data;
}
const unknownOutcome = "Outcome unknown. Server work may have been saved. Reload scheduled jobs before taking another action.";
const pendingDraftKey = "aptlss-schedule:pending-request:v1";
type ScheduleRequest = { requestKey: string; cardIds: string[]; scheduledTime: string; settings: GenerationSettings };
function failure(error: unknown) { return error instanceof ScheduleHttpError ? error.message : unknownOutcome; }

function businessGoalPreview(value: unknown): { content: ReactNode; complete: boolean } {
  let complete = true, nodes = 0, characters = 12000;
  const ancestors = new WeakSet<object>();
  const omitted = () => { complete = false; return <span>Content not fully shown.</span>; };
  const visit = (item: unknown, depth: number): ReactNode => {
    if (++nodes > 120 || depth > 4) return omitted();
    if (item === null) return <span>Not provided (null)</span>;
    if (typeof item === "string") {
      const limit = Math.min(8000, characters); characters -= Math.min(item.length, limit);
      return <span className="whitespace-pre-wrap">{item.slice(0, limit)}{item.length > limit && omitted()}</span>;
    }
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return String(item);
    if (!item || typeof item !== "object" || ancestors.has(item)
      || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) return omitted();
    ancestors.add(item);
    let content: ReactNode;
    if (Array.isArray(item)) {
      const children: ReactNode[] = [];
      for (let i = 0; i < Math.min(item.length, 40); i++) {
        if (nodes >= 120) { children.push(<li key="omitted">{omitted()}</li>); break; }
        children.push(<li key={i}>{visit(item[i], depth + 1)}</li>);
      }
      if (item.length > 40) children.push(<li key="extra">{omitted()}</li>);
      content = children.length ? <ul className="list-disc pl-5 space-y-1">{children}</ul> : <span>Empty list</span>;
    } else {
      const entries = Object.entries(item), children: ReactNode[] = [];
      for (const [key, child] of entries.slice(0, 40)) {
        if (nodes >= 120 || key.length > 100 || key.length > characters) { children.push(<div key="omitted">{omitted()}</div>); break; }
        characters -= key.length;
        if (/^(thoughts|reasoning|chainofthought|aithoughts|modelthoughts|providerdebug|providertrace)$/.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
          complete = false; children.push(<div key={key}>Technical content excluded.</div>); continue;
        }
        children.push(<div key={key}><dt className="text-muted-foreground">{key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}</dt><dd className="pl-2">{visit(child, depth + 1)}</dd></div>);
      }
      if (entries.length > 40) children.push(<div key="extra">{omitted()}</div>);
      content = children.length ? <dl className="space-y-2">{children}</dl> : <span>Empty object</span>;
    }
    ancestors.delete(item);
    return content;
  };
  if (value !== null && typeof value !== "string" && typeof value !== "object") return { content: omitted(), complete: false };
  const content = visit(value, 0);
  return { content, complete };
}
const goalReviewable = (settings: GenerationSettings) => settings.clarifiedGoal == null || businessGoalPreview(settings.clarifiedGoal).complete;
function BusinessInputs({ cards, settings }: { cards: ScheduledCard[]; settings: GenerationSettings }) {
  const goal = settings.clarifiedGoal == null ? null : businessGoalPreview(settings.clarifiedGoal);
  return <div className="space-y-3 text-sm min-w-0 break-words">
    <div><p className="font-medium">{cards.length} {cards.length === 1 ? "card" : "cards"}</p><ul className="max-h-36 overflow-y-auto list-disc pl-5">{cards.map(card => <li key={card.id}>{card.name}</li>)}</ul></div>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2">
      {[["Skip existing checklists", settings.skipExisting !== false ? "Yes" : "No"],
        ["Validate before generation", settings.validateBeforeGenerate !== false ? "Yes" : "No"],
        ["Apply to Trello", settings.applyToTrello !== false ? "Yes, when authorized" : "No"],
        ["Replace existing checklists", settings.replaceExisting === true ? "Yes" : "No"],
        ["Validation threshold (uncalibrated)", `${settings.minimumConfidence ?? 70}/100`],
        ["Maximum attempts", String(settings.maxRetries ?? 1)]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}
    </dl>
    {goal && !goal.complete && <p role="alert" className="text-destructive">Approval blocked: goal details cannot be fully reviewed here. Unsupported, excluded, or oversized content must be corrected before scheduling.</p>}
    {goal && <details open><summary className="font-medium cursor-pointer">Business goal and success criteria</summary>{goal.content}</details>}
  </div>;
}
function TimeAndReview({ time, setTime, reviewed, setReviewed, disabled }: {
  time: string; setTime: (value: string) => void; reviewed: boolean; setReviewed: (value: boolean) => void; disabled: boolean;
}) {
  const instant = futureIso(time);
  const offset = instant ? new Intl.DateTimeFormat("en", { timeZone: zone(), timeZoneName: "longOffset" }).formatToParts(new Date(instant)).find(part => part.type === "timeZoneName")?.value : null;
  return <div className="space-y-3">
    <div className="space-y-1"><Label htmlFor="scheduled-generation-time">Future run time ({zone()})</Label>
      <Input id="scheduled-generation-time" type="datetime-local" value={time} disabled={disabled} onChange={event => { setTime(event.target.value); setReviewed(false); }} />
      {time && !futureIso(time) && <p role="alert" className="text-sm text-destructive">Choose a valid time in the future.</p>}
      {instant && <p className="text-sm text-muted-foreground break-words">Resolved run time: <time dateTime={instant}>{instant}</time> ({offset}).</p>}
    </div>
    <label className="flex items-start gap-2 text-sm"><Checkbox checked={reviewed} disabled={disabled} onCheckedChange={value => setReviewed(value === true)} />
      <span>I reviewed these cards, generation settings, and future run time.</span></label>
  </div>;
}

export function CreateScheduledGenerationDialog({ open, onOpenChange, cards, settings, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; cards: ScheduledCard[]; settings: GenerationSettings; onSaved: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ cards: ScheduledCard[]; settings: GenerationSettings } | null>(null);
  const [time, setTime] = useState(""); const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false); const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null); const [unknown, setUnknown] = useState(false);
  const draftKey = useRef<string | null>(null);
  const [lastRequest, setLastRequest] = useState<ScheduleRequest | null>(null);
  const [lostDraft, setLostDraft] = useState(() => {
    try { return typeof sessionStorage !== "undefined" && sessionStorage.getItem(pendingDraftKey) !== null; } catch { return true; }
  });
  const [observed, setObserved] = useState(false); const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [observedJobs, setObservedJobs] = useState<ScheduledGenerationJob[]>([]);
  const resetDraft = () => {
    setSnapshot(structuredClone({ cards, settings: generationSettingsOnly(settings) })); setTime(localTime());
    draftKey.current = crypto.randomUUID(); setLastRequest(null); setReviewed(false); setError(null); setUnknown(false);
    setObserved(false); setRecoveryAcknowledged(false); setLostDraft(false);
  };
  useEffect(() => {
    if (open && !lostDraft && !unknown && (!snapshot || JSON.stringify(snapshot) !== JSON.stringify({ cards, settings: generationSettingsOnly(settings) }))) resetDraft();
  }, [open]);
  const send = async (payload: ScheduleRequest) => {
    if (inFlight.current || !goalReviewable(payload.settings)) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      // Persist only a random request ID, never cards, settings, or interview content.
      sessionStorage.setItem(pendingDraftKey, payload.requestKey);
      setLastRequest(payload);
      const result = await request("/api/aptlss/schedule", "POST", payload);
      if (result.success !== true || typeof result.jobId !== "string") throw new Error("Unconfirmed schedule");
      if (sessionStorage.getItem(pendingDraftKey) === payload.requestKey) sessionStorage.removeItem(pendingDraftKey);
      if (result.replayed === true) toast.info(`Existing schedule recovered: ${statusLabel(result.status)}.`);
      else if (result.status !== undefined && result.status !== "pending") toast.info(`Schedule request confirmed: ${statusLabel(result.status)}.`);
      else toast.success(`Schedule request confirmed for ${payload.cardIds.length} cards.`);
      setSnapshot(null); setLastRequest(null); setUnknown(false); onSaved(); onOpenChange(false);
    } catch (err) {
      setError(failure(err)); setUnknown(!(err instanceof ScheduleHttpError) || err.status >= 500 || err.status === 409);
      setReviewed(false); setObserved(false); setRecoveryAcknowledged(false);
    }
    finally { inFlight.current = false; setBusy(false); }
  };
  const submit = async () => {
    const scheduledTime = futureIso(time);
    if (inFlight.current || unknown || lostDraft || !reviewed || !scheduledTime || !snapshot?.cards.length || snapshot.cards.length > 250 || !goalReviewable(snapshot.settings)) return;
    const candidate = { cardIds: snapshot.cards.map(card => card.id), scheduledTime, settings: snapshot.settings };
    const same = lastRequest && JSON.stringify(candidate) === JSON.stringify({ cardIds: lastRequest.cardIds, scheduledTime: lastRequest.scheduledTime, settings: lastRequest.settings });
    if (lastRequest && !same) draftKey.current = crypto.randomUUID();
    const requestKey = draftKey.current ?? (draftKey.current = crypto.randomUUID());
    await send({ requestKey, ...candidate });
  };
  const observe = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setObserved(false);
    try {
      const rows = await request("/api/aptlss/scheduled");
      if (!Array.isArray(rows)) throw new Error("Invalid scheduled list");
      setObservedJobs(rows); setObserved(true); onSaved();
    } catch { setError("Could not verify scheduled jobs. No new schedule has been submitted. Try reloading the list again."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!inFlight.current) onOpenChange(next); }}><DialogContent className="sm:max-w-xl max-h-[90dvh] flex flex-col overflow-hidden" showCloseButton={!busy}>
    <DialogHeader className="shrink-0"><DialogTitle>Schedule selected cards</DialogTitle><DialogDescription>Review the batch before approving its future generation. Nothing runs now.</DialogDescription></DialogHeader>
    <div className="min-h-0 overflow-y-auto space-y-4 -mx-1 px-1" data-schedule-body>
    {snapshot && <BusinessInputs cards={snapshot.cards} settings={snapshot.settings} />}
    {snapshot && snapshot.cards.length > 250 && <p role="alert">Select at most 250 cards per scheduled batch.</p>}
    {!lostDraft && <TimeAndReview time={time} setTime={setTime} reviewed={reviewed} setReviewed={setReviewed} disabled={busy || unknown} />}
    {(unknown || lostDraft) && <div className="space-y-3 text-sm">
      <p role="alert">{unknownOutcome}{lostDraft ? " The original draft is no longer in memory; it will not be replayed." : " An explicit retry will reuse the exact request and its original ID."}</p>
      <Button variant="outline" disabled={busy} onClick={observe}><RefreshCw className="h-4 w-4 mr-2" />Check scheduled jobs</Button>
      {observed && <><p role="status">Scheduled jobs checked: {observedJobs.length} jobs.</p>
        <ul className="max-h-32 overflow-y-auto">{observedJobs.slice(0, 50).map(job => <li key={job.id}>{timeLabel(job.scheduledTime)} / {cardIds(job.cardIds)?.length ?? "Unknown"} cards / {job.status.replaceAll("_", " ")}</li>)}</ul>
        {lastRequest && !lostDraft && <Button disabled={busy} onClick={() => void send(lastRequest)}>Retry exact schedule request</Button>}
        <label className="flex gap-2 items-start"><Checkbox checked={recoveryAcknowledged} disabled={busy} onCheckedChange={value => setRecoveryAcknowledged(value === true)} /><span>I checked scheduled jobs and accept that the prior request may already exist before starting a different draft.</span></label>
        <Button variant="outline" disabled={busy || !recoveryAcknowledged} onClick={() => { sessionStorage.removeItem(pendingDraftKey); resetDraft(); }}>Start a different draft</Button>
      </>}
    </div>}
    {error && !(unknown && error === unknownOutcome) && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <DialogFooter className="shrink-0"><Button variant="outline" disabled={busy} onClick={() => { if (unknown) onSaved(); onOpenChange(false); }}>{unknown ? "Close and reload scheduled jobs" : "Cancel"}</Button>
      <Button disabled={busy || unknown || lostDraft || !reviewed || !futureIso(time) || !snapshot?.cards.length || snapshot.cards.length > 250 || !goalReviewable(snapshot.settings)} onClick={submit}>{busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CalendarClock className="h-4 w-4 mr-2" />}Approve schedule</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function ScheduledGenerationView({ jobs, loading, error, onRefresh }: {
  jobs: ScheduledGenerationJob[]; loading: boolean; error: string | null; onRefresh: () => void;
}) {
  const [reviewId, setReviewId] = useState<string | null>(null); const [cancelId, setCancelId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ApprovalPreview | null>(null); const [reading, setReading] = useState(false);
  const [time, setTime] = useState(""); const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false); const inFlight = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null); const [unknown, setUnknown] = useState(false);
  const readSequence = useRef(0);
  const loadPreview = async (id: string, signal?: AbortSignal) => {
    const seq = ++readSequence.current; setReading(true); setPreview(null); setReviewed(false); setTime("");
    try {
      const response = await request(`/api/aptlss/scheduled/${encodeURIComponent(id)}/approval`, "GET", undefined, signal);
      const data = response.approval;
      if (seq !== readSequence.current || signal?.aborted) return;
      if (!data || data.jobId !== id || !actionable(data.status) || typeof data.expectedSnapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedSnapshotHash)
        || !Array.isArray(data.cardIds) || !data.cardIds.length || data.cardIds.length > 250 || data.cardIds.some((value: unknown) => typeof value !== "string")
        || !data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) throw new Error("Invalid approval preview");
      setPreview({ jobId: id, expectedSnapshotHash: data.expectedSnapshotHash, cardIds: data.cardIds,
        scheduledTime: data.scheduledTime, settings: generationSettingsOnly(data.settings), progress: data.progress });
    } catch (err) { if (seq === readSequence.current && !signal?.aborted) setActionError(err instanceof ScheduleHttpError ? err.message : "Could not load approval details. Reload them before approving."); }
    finally { if (seq === readSequence.current) setReading(false); }
  };
  useEffect(() => {
    if (!reviewId) return;
    const controller = new AbortController(); setActionError(null); setUnknown(false); void loadPreview(reviewId, controller.signal);
    return () => { controller.abort(); readSequence.current++; };
  }, [reviewId]);
  const approve = async () => {
    const scheduledTime = futureIso(time);
    if (!preview || inFlight.current || !reviewed || !scheduledTime || unknown || !goalReviewable(preview.settings)) return;
    inFlight.current = true; setBusy(true); setActionError(null);
    try {
      const data = await request(`/api/aptlss/scheduled/${encodeURIComponent(preview.jobId)}/approval`, "POST", { expectedSnapshotHash: preview.expectedSnapshotHash, scheduledTime });
      if (data.success !== true || data.jobId !== preview.jobId) throw new Error("Unconfirmed approval");
      toast.success("Scheduled generation approved for the new run time."); setReviewId(null); onRefresh();
    } catch (err) {
      setReviewed(false);
      if (err instanceof ScheduleHttpError && err.status === 409 && reviewId) {
        setActionError("This job changed. Review the refreshed details and choose a future time again.");
        await loadPreview(reviewId); onRefresh();
      } else { setActionError(failure(err)); setUnknown(!(err instanceof ScheduleHttpError)); }
    } finally { inFlight.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (!cancelId || inFlight.current || unknown) return;
    inFlight.current = true; setBusy(true); setActionError(null);
    try {
      const data = await request(`/api/aptlss/scheduled/${encodeURIComponent(cancelId)}`, "DELETE");
      if (data.success !== true) throw new Error("Unconfirmed cancellation");
      toast.success("Scheduled generation cancelled."); setCancelId(null); onRefresh();
    } catch (err) { setActionError(failure(err)); setUnknown(!(err instanceof ScheduleHttpError)); if (err instanceof ScheduleHttpError && err.status === 409) onRefresh(); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <section className="space-y-3 min-w-0" aria-label="Scheduled generation">
    <div className="flex flex-wrap justify-between gap-2 items-center"><h2 className="text-base font-semibold">Scheduled generation</h2><Button size="sm" variant="outline" disabled={loading || busy} onClick={onRefresh}><RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />Reload scheduled jobs</Button></div>
    <p className="text-sm text-muted-foreground">Run times in {zone()}. Awaiting-approval jobs remain on hold until reviewed.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p role="status">Loading scheduled jobs...</p> : !error && <Table><TableHeader><TableRow><TableHead>Run time</TableHead><TableHead>Cards</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>
      {jobs.map(job => <TableRow key={job.id}><TableCell>{timeLabel(job.scheduledTime)}</TableCell><TableCell>{cardIds(job.cardIds)?.length ?? "Unavailable"}</TableCell><TableCell>{statusLabel(job.status)}</TableCell><TableCell className="text-right">
        {actionable(job.status) && <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setReviewId(job.id)}><CalendarClock className="h-4 w-4 mr-2" />Review / reapprove</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { setCancelId(job.id); setActionError(null); setUnknown(false); }}><X className="h-4 w-4 mr-2" />Cancel schedule</Button></div>}
      </TableCell></TableRow>)}
      {!jobs.length && <TableRow><TableCell colSpan={4}>No scheduled generation jobs.</TableCell></TableRow>}
    </TableBody></Table>}
    <Dialog open={reviewId !== null} onOpenChange={open => { if (!open && !inFlight.current) setReviewId(null); }}><DialogContent className="sm:max-w-xl max-h-[90dvh] flex flex-col overflow-hidden" showCloseButton={!busy}>
      <DialogHeader className="shrink-0"><DialogTitle>Review scheduled generation</DialogTitle><DialogDescription>Approval uses these frozen inputs and a new future run time. No generation starts during review.</DialogDescription></DialogHeader>
      <div className="min-h-0 overflow-y-auto space-y-4 -mx-1 px-1" data-schedule-body>
      {reading && <p role="status">Loading approval details...</p>}
      {preview && <><BusinessInputs cards={preview.cardIds.map(id => ({ id, name: id }))} settings={preview.settings} />
        {preview.progress && <p className="text-sm">Prior results: {preview.progress.completed} completed, {preview.progress.needsReview} need review, {preview.progress.failed} failed, {preview.progress.outcomeUnknown} unknown outcomes.</p>}
        {!!preview.progress?.outcomeUnknown && <p className="text-sm text-amber-700">Some prior outcomes are unknown. Review the existing results before approving more work.</p>}
        <TimeAndReview time={time} setTime={setTime} reviewed={reviewed} setReviewed={setReviewed} disabled={busy || unknown} /></>}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      </div>
      <DialogFooter className="shrink-0"><Button variant="outline" disabled={busy} onClick={() => { setReviewId(null); if (unknown) onRefresh(); }}>Close</Button>
        {!preview && !reading && <Button variant="outline" onClick={() => { if (reviewId) { setActionError(null); void loadPreview(reviewId); } }}>Reload approval details</Button>}
        <Button disabled={!preview || reading || busy || unknown || !reviewed || !futureIso(time) || !goalReviewable(preview.settings)} onClick={approve}>{busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Approve new run time</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={cancelId !== null} onOpenChange={open => { if (!open && !inFlight.current) setCancelId(null); }}><DialogContent showCloseButton={!busy}>
      <DialogHeader><DialogTitle>Cancel scheduled generation?</DialogTitle><DialogDescription>The pending batch will not run. Existing generation history is retained.</DialogDescription></DialogHeader>
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setCancelId(null); if (unknown) onRefresh(); }}>Close</Button><Button variant="destructive" disabled={busy || unknown} onClick={cancel}>{busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Confirm cancellation</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
