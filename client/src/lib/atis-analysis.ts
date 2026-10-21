import { ATIS_ANALYSIS_MAX_CARDS, type AtisAnalysisJob, type AtisAnalysisPreview, type AtisAnalysisSelection } from "@shared/atisAnalysis";

export type AnalysisView = {
  phase: "idle" | "previewing" | "preview" | "confirming" | "observing" | "paused" | "error";
  preview?: AtisAnalysisPreview;
  analysis?: AtisAnalysisJob;
  message?: string;
  retryAt?: number;
  busy?: boolean;
  unknownOutcome?: boolean;
};
type Options = {
  actor: string;
  onState: (view: AnalysisView) => void;
  onCompleted?: (analysis: AtisAnalysisJob, signal: AbortSignal) => void | Promise<void>;
  fetch?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  maxReads?: number;
  intervalMs?: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = (job: AtisAnalysisJob) => !["queued", "running"].includes(job.state);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
export const analysisItemLabel = {
  pending: "Waiting", calling: "Analyzing", generated: "Plan ready", fallback: "Needs review",
  missing: "Card unavailable", failed: "Could not analyze", uncertain: "Outcome unknown",
} as const;
export const analysisJobLabel = {
  queued: "Waiting to start", running: "Analysis in progress", completed: "Batch finished",
  failed: "Batch stopped", interrupted: "Interrupted: review required",
} as const;
export function canAttributeAnalysis(job: AtisAnalysisJob, selection: AtisAnalysisSelection, ownsAdmission: boolean): boolean {
  return selection.mode === "single"
    ? job.total === 1 && job.items.length === 1 && job.items[0].cardId === selection.cardId
    : ownsAdmission;
}

export function parseAnalysis(value: unknown): AtisAnalysisJob {
  const job = value as AtisAnalysisJob;
  if (!job || !uuid.test(job.id) || !["queued", "running", "completed", "failed", "interrupted"].includes(job.state)
    || ![job.matched, job.total, job.remaining, job.processed, job.generated, job.fallback, job.missing, job.failed, job.uncertain, job.pending].every(count)
    || job.total > ATIS_ANALYSIS_MAX_CARDS || !Array.isArray(job.items) || job.items.length !== job.total
    || job.items.some(item => !Number.isSafeInteger(item.cardId) || item.cardId <= 0 || typeof item.cardName !== "string"
      || !["pending", "calling", "generated", "fallback", "missing", "failed", "uncertain"].includes(item.state))) throw new Error("Invalid analysis status");
  const states = (state: string) => job.items.filter(item => item.state === state).length;
  if (new Set(job.items.map(item => item.cardId)).size !== job.total || job.matched !== job.total + job.remaining
    || job.generated !== states("generated") || job.fallback !== states("fallback") || job.missing !== states("missing")
    || job.failed !== states("failed") || job.uncertain !== states("uncertain") || job.pending !== states("pending") + states("calling")
    || job.processed !== job.generated + job.fallback || (job.state === "completed" && (job.pending > 0 || job.uncertain > 0))) throw new Error("Inconsistent analysis status");
  return job;
}
export function parseAnalysisPreview(value: unknown): AtisAnalysisPreview {
  const preview = value as AtisAnalysisPreview;
  if (!preview || !uuid.test(preview.id) || !Number.isFinite(Date.parse(preview.expiresAt))
    || ![preview.matched, preview.total, preview.remaining].every(count) || preview.total > ATIS_ANALYSIS_MAX_CARDS
    || !Array.isArray(preview.cards) || preview.cards.length !== preview.total
      || preview.cards.some(card => !Number.isSafeInteger(card.id) || card.id <= 0 || typeof card.name !== "string")
      || preview.matched !== preview.total + preview.remaining || new Set(preview.cards.map(card => card.id)).size !== preview.total) throw new Error("Invalid analysis preview");
  return preview;
}
class ReadError extends Error {
  constructor(readonly retryAt: number, readonly status: number) { super("Status is unavailable. Server work may still be running. Check status; do not start it again."); }
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class AtisAnalysisClient {
  private view: AnalysisView = { phase: "idle" };
  private controller?: AbortController;
  private busy = false;
  private stopped = false;
  private selection?: AtisAnalysisSelection;
  private requestKey?: string;
  private admission?: { id: string; selection: AtisAnalysisSelection };
  private jobId?: string;
  private completed = new Set<string>();
  private readonly storageKey: string;
  constructor(private options: Options) { this.storageKey = `atis-analysis:v1:${options.actor}`; }
  get current() { return this.view; }
  get hasRequest() { return this.jobId !== undefined; }
  ownsAnalysis(id: string) { return this.admission?.id === id; }
  private emit(view: AnalysisView) {
    this.view = { ...view, busy: this.busy };
    if (!this.stopped) this.options.onState(this.view);
  }
  private remember(id: string) {
    this.jobId = id;
    try { this.options.storage?.setItem(this.storageKey, id); } catch { /* Observation remains available in this tab. */ }
  }
  private forget() { try { this.options.storage?.removeItem(this.storageKey); } catch { /* Storage may be disabled. */ } }
  private async request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await (this.options.fetch ?? globalThis.fetch)(path, {
      credentials: "include", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    signal.throwIfAborted();
    const header = response.headers.get("Retry-After");
    const delay = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : header ? Math.max(0, Date.parse(header) - Date.now()) : 0;
    if (!response.ok) throw new ReadError(Date.now() + (Number.isFinite(delay) ? delay : 0), response.status);
    const data = await response.json();
    signal.throwIfAborted();
    return { data, delay: Number.isFinite(delay) ? delay : 0 };
  }
  private async run(action: (signal: AbortSignal) => Promise<void>) {
    if (this.busy || this.stopped || (this.view.retryAt ?? 0) > Date.now()) return;
    this.busy = true;
    this.controller = new AbortController();
    try { await action(this.controller.signal); }
    catch (error) {
      if (!this.stopped) this.emit({ ...this.view, phase: this.jobId ? "paused" : "error",
        unknownOutcome: this.jobId !== undefined && error instanceof ReadError && error.status === 404,
        message: this.controller.signal.aborted ? "Status checks stopped. Server work has not been cancelled."
          : this.view.analysis?.state === "completed" ? "This batch finished, but its saved card data could not be refreshed. Check status to retry loading it."
          : this.jobId && error instanceof ReadError && error.status === 404 ? "No confirmed analysis is visible yet. The original request could still commit or incur usage. Check status again; no confirmation has been replayed."
          : this.jobId ? "Cannot confirm analysis status. Server work may still be running. Check status before starting again."
            : "Preview could not be loaded. No analysis was requested. Try preview again.",
        retryAt: error instanceof ReadError ? error.retryAt : undefined });
    } finally { this.busy = false; this.emit(this.view); }
  }
  preview(selection: AtisAnalysisSelection) {
    if (this.jobId && (!this.view.analysis || !terminal(this.view.analysis))) return Promise.resolve();
    return this.run(async signal => {
      this.selection = structuredClone({ ...selection, limit: selection.mode === "single" ? 1 : Math.min(selection.limit ?? ATIS_ANALYSIS_MAX_CARDS, ATIS_ANALYSIS_MAX_CARDS) });
      this.emit({ phase: "previewing" });
      const { data } = await this.request("/api/atis/understanding/preview", signal, { selection: this.selection });
      const preview = parseAnalysisPreview(data.preview);
      if (preview.total > this.selection.limit! || (this.selection.mode === "single" && preview.cards.some(card => card.id !== this.selection!.cardId))) throw new Error("Preview selection changed");
      this.requestKey = crypto.randomUUID();
      this.jobId = undefined;
      this.emit({ phase: "preview", preview });
    });
  }
  confirm(acknowledgedRecoveryOperationId?: number) {
    const preview = this.view.preview;
    if (this.view.phase !== "preview" || !preview || preview.total === 0 || Date.parse(preview.expiresAt) <= Date.now() || !this.requestKey) return Promise.resolve();
    if (preview.recoveryOperationId !== acknowledgedRecoveryOperationId) return Promise.resolve();
    return this.run(async signal => {
      const requestKey = this.requestKey!;
      this.admission = { id: preview.id, selection: structuredClone(this.selection!) };
      // Persist before POST: an ambiguous acknowledgement is recovered by GET, never replayed.
      this.remember(preview.id);
      this.emit({ ...this.view, phase: "confirming" });
      const { data, delay } = await this.request("/api/atis/understanding/process", signal, {
        phase: "confirm", previewId: preview.id, requestKey,
        ...(acknowledgedRecoveryOperationId === undefined ? {} : { acknowledgeInterruptedOperationId: acknowledgedRecoveryOperationId }),
      });
      const job = parseAnalysis(data.analysis);
      if (job.id !== preview.id || job.total !== preview.total || job.items.some(item => !preview.cards.some(card => card.id === item.cardId))) throw new Error("Analysis selection changed");
      await this.follow(job, signal, delay);
    });
  }
  private async follow(job: AtisAnalysisJob, signal: AbortSignal, delay = 0) {
    this.remember(job.id);
    const started = Date.now();
    let reads = 0;
    while (true) {
      this.emit({ phase: "observing", analysis: job });
      if (terminal(job)) {
        if (job.state === "failed") this.forget();
        if (job.state === "completed" && !this.completed.has(job.id)) {
          await this.options.onCompleted?.(job, signal);
          signal.throwIfAborted();
          this.completed.add(job.id);
        }
        if (job.state === "completed") this.forget();
        return;
      }
      if (reads >= (this.options.maxReads ?? 120) || Date.now() - started >= 300_000 || delay > 300_000) {
        this.emit({ ...this.view, phase: "paused", retryAt: Date.now() + delay,
          message: "Status checks paused. Server work has not been cancelled. Check status to continue." });
        return;
      }
      await wait(Math.max(delay, this.options.intervalMs ?? 2000), signal);
      const result = await this.request(`/api/atis/understanding/analyses/${job.id}`, signal);
      const next = parseAnalysis(result.data.analysis);
      if (next.id !== job.id) throw new Error("Analysis identity changed");
      job = next; delay = result.delay; reads++;
    }
  }
  resume() {
    return this.run(async signal => {
      let id = this.jobId;
      try { id ??= this.options.storage?.getItem(this.storageKey) ?? undefined; } catch { /* No persisted observation. */ }
      if (!id || !uuid.test(id)) return;
      this.jobId = id;
      this.emit({ ...this.view, phase: "observing", message: "Checking saved analysis status..." });
      const { data, delay } = await this.request(`/api/atis/understanding/analyses/${id}`, signal);
      const job = parseAnalysis(data.analysis);
      if (job.id !== id) throw new Error("Analysis identity changed");
      await this.follow(job, signal, delay);
    });
  }
  nextBatch() {
    const job = this.view.analysis;
    if (!this.admission || this.admission.id !== job?.id || job.state !== "completed" || !job.remaining || !job.nextAfterCardId) return Promise.resolve();
    return this.preview({ ...this.admission.selection, afterCardId: job.nextAfterCardId });
  }
  refreshPreview() { return this.selection ? this.preview(this.selection) : Promise.resolve(); }
  reviewUnknownOutcome(selection: AtisAnalysisSelection, acknowledged: boolean) {
    if (!acknowledged || !this.view.unknownOutcome || this.busy || (this.view.retryAt ?? 0) > Date.now()) return Promise.resolve();
    // Only explicit acknowledgement releases this browser's observation lock; it never replays the original POST.
    this.forget(); this.jobId = undefined; this.requestKey = undefined;
    this.emit({ phase: "idle" });
    return this.preview(selection);
  }
  get canNextBatch() { return this.admission?.id === this.view.analysis?.id && !!this.admission && this.view.analysis?.state === "completed" && this.view.analysis.remaining > 0 && !!this.view.analysis.nextAfterCardId; }
  pause() { this.controller?.abort(); }
  dispose() { this.stopped = true; this.controller?.abort(); }
}

export async function readCardUnderstanding(cardId: number, signal?: AbortSignal) {
  const response = await fetch(`/api/atis/card/${cardId}/understanding`, { credentials: "include", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Analysis finished, but the saved card plan could not be loaded. Refresh the card.");
  return response.json();
}
