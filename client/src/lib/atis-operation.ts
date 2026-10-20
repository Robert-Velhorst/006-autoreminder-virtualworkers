export type AtisOperation = {
  id: number;
  kind: "sync" | "understanding";
  state: "running" | "completed" | "failed" | "interrupted";
  result?: Record<string, unknown>;
  error?: string;
};

export type AtisOperationView = {
  status: "idle" | "checking" | "starting" | "running" | "unconfirmed" | "completed" | "failed" | "interrupted";
  operation?: AtisOperation;
  message: string;
  busy?: boolean;
};

export const ATIS_POLL_INTERVAL_MS = 2_000;
export const ATIS_MAX_STATUS_READS = 120;
export const ATIS_POLL_WINDOW_MS = 5 * 60_000;
export const INITIAL_ATIS_OPERATION_VIEW: AtisOperationView = { status: "checking", message: "Checking for active sync or analysis..." };

export function canStartAtisOperation(view: AtisOperationView) {
  return !view.busy && ["idle", "completed", "failed", "interrupted"].includes(view.status);
}

function parseOperation(value: unknown): AtisOperation {
  if (!value || typeof value !== "object") throw new Error("Invalid operation response");
  const op = value as AtisOperation;
  if (!Number.isSafeInteger(op.id) || op.id <= 0 || !["sync", "understanding"].includes(op.kind)
    || !["running", "completed", "failed", "interrupted"].includes(op.state)
    || (op.result !== undefined && (!op.result || typeof op.result !== "object" || Array.isArray(op.result)))
    || (op.error !== undefined && typeof op.error !== "string")) throw new Error("Invalid operation response");
  return op;
}

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

type Options = {
  onState: (view: AtisOperationView) => void;
  onCompleted: (operation: AtisOperation) => Promise<void> | void;
  fetch?: typeof fetch;
  maxStatusReads?: number;
};

class AtisStartConflict extends Error {
  constructor(readonly operation: AtisOperation) { super("A different request is running"); }
}

export class AtisOperationClient {
  private view: AtisOperationView = INITIAL_ATIS_OPERATION_VIEW;
  private busy = false;
  private controller?: AbortController;
  private continueAfterSync = false;
  private completed = new Set<number>();
  private conflictingOperations = new Set<number>();

  constructor(private options: Options) {}

  get current() { return this.view; }

  stop() { this.controller?.abort(); }

  private emit(view: AtisOperationView) {
    this.view = { ...view, busy: this.busy };
    this.options.onState(this.view);
  }

  private async request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<{ operation?: unknown; operations?: unknown }> {
    signal.throwIfAborted();
    // Use the ordinary dashboard fetch wrapper, including its per-request deadline.
    const response = await (this.options.fetch ?? globalThis.fetch)(path, { ...init, credentials: "include", signal });
    if (response.status === 409 && init.method === "POST") {
      const body = await response.json() as { operation?: unknown; requestedNotStarted?: unknown };
      signal.throwIfAborted();
      const operation = parseOperation(body?.operation);
      if (operation.state === "interrupted") return body;
      if (operation.state === "running" && body.requestedNotStarted === true) throw new AtisStartConflict(operation);
      throw new Error("Invalid recovery response");
    }
    if (!response.ok) {
      await response.arrayBuffer();
      throw new Error("Operation status unavailable");
    }
    const body: unknown = await response.json();
    signal.throwIfAborted();
    return body as { operation?: unknown; operations?: unknown };
  }

  private async run(action: (signal: AbortSignal) => Promise<void>, callerSignal?: AbortSignal) {
    if (this.busy || callerSignal?.aborted) return;
    this.busy = true;
    this.controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.controller.signal]) : this.controller.signal;
    try {
      await action(signal);
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof AtisStartConflict) {
          this.continueAfterSync = false;
          this.conflictingOperations.add(error.operation.id);
          this.emit({ status: "unconfirmed", operation: error.operation,
            message: "A different operation is already running. Your request was not started. Check status to observe the existing work." });
        } else this.emit({ status: "unconfirmed", operation: this.view.operation,
          message: "Cannot confirm the server operation status. Work may still be running. Check status before starting again." });
      }
    } finally {
      this.busy = false;
      if (!signal.aborted) this.emit(this.view);
    }
  }

  private async start(kind: AtisOperation["kind"], signal: AbortSignal, acknowledgeInterruptedOperationId?: number) {
    this.emit({ status: "starting", message: kind === "sync" ? "Starting Trello sync..." : "Starting card analysis..." });
    const payload = { ...(kind === "understanding" ? { limit: 50 } : {}),
      ...(acknowledgeInterruptedOperationId === undefined ? {} : { acknowledgeInterruptedOperationId }) };
    const body = await this.request(kind === "sync" ? "/api/atis/sync" : "/api/atis/understanding/process", signal, {
      method: "POST",
      ...(Object.keys(payload).length ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
    });
    return parseOperation(body?.operation);
  }

  private async follow(operation: AtisOperation, signal: AbortSignal): Promise<boolean> {
    let current = operation;
    let reads = 0;
    const startedAt = Date.now();
    while (current.state === "running") {
      this.emit({ status: "running", operation: current,
        message: this.conflictingOperations.has(current.id)
          ? "A different operation is running on the server. Your request was not started."
          : `${current.kind === "sync" ? "Trello sync" : "Card analysis"} is running on the server.` });
      if (reads >= (this.options.maxStatusReads ?? ATIS_MAX_STATUS_READS) || Date.now() - startedAt >= ATIS_POLL_WINDOW_MS) {
        this.emit({ status: "unconfirmed", operation: current,
          message: "Status checks paused while the operation was still running. Server work has not been cancelled. Check status to continue." });
        return false;
      }
      await pause(ATIS_POLL_INTERVAL_MS, signal);
      const body = await this.request(`/api/atis/operations/${current.id}`, signal);
      const next = parseOperation(body?.operation);
      if (next.id !== current.id || next.kind !== current.kind) throw new Error("Operation identity changed");
      current = next;
      reads++;
    }
    const label = current.kind === "sync" ? "Trello sync" : "Card analysis";
    const conflictNote = this.conflictingOperations.has(current.id) ? " Your different request was not started." : "";
    this.emit({ status: current.state, operation: current,
      message: (current.state === "completed" ? `${label} completed.`
        : current.state === "failed" ? `${label} failed on the server.` : `${label} was interrupted on the server. Completion is unverified; review before starting again.`) + conflictNote });
    if (current.state !== "completed") { this.continueAfterSync = false; return false; }
    if (!this.completed.has(current.id) && !this.conflictingOperations.has(current.id)) {
      this.completed.add(current.id);
      await this.options.onCompleted(current);
      signal.throwIfAborted();
    }
    return true;
  }

  private async followAndContinue(operation: AtisOperation, signal: AbortSignal) {
    if (!await this.follow(operation, signal)) return;
    if (operation.kind === "sync" && this.continueAfterSync) {
      this.continueAfterSync = false;
      await this.follow(await this.start("understanding", signal), signal);
    }
  }

  startSync(callerSignal?: AbortSignal) {
    if (!canStartAtisOperation(this.view)) return Promise.resolve();
    return this.run(async signal => {
      this.continueAfterSync = true;
      await this.followAndContinue(await this.start("sync", signal), signal);
    }, callerSignal);
  }

  startUnderstanding(callerSignal?: AbortSignal) {
    if (!canStartAtisOperation(this.view)) return Promise.resolve();
    return this.run(async signal => {
      this.continueAfterSync = false;
      await this.follow(await this.start("understanding", signal), signal);
    }, callerSignal);
  }

  acknowledgeAndRestart(callerSignal?: AbortSignal) {
    const operation = this.view.operation;
    if (this.view.status !== "interrupted" || !operation || !canStartAtisOperation(this.view)) return Promise.resolve();
    return this.run(async signal => {
      this.continueAfterSync = operation.kind === "sync";
      await this.followAndContinue(await this.start(operation.kind, signal, operation.id), signal);
    }, callerSignal);
  }

  resume(callerSignal?: AbortSignal) {
    return this.run(async signal => {
      const known = this.view.operation;
      this.emit({ status: "checking", operation: known, message: "Checking server operation status..." });
      if (known?.state === "running") {
        const body = await this.request(`/api/atis/operations/${known.id}`, signal);
        const operation = parseOperation(body?.operation);
        if (operation.id !== known.id || operation.kind !== known.kind) throw new Error("Operation identity changed");
        await this.followAndContinue(operation, signal);
        return;
      }
      const body = await this.request("/api/atis/operations/active", signal);
      if (!Array.isArray(body?.operations)) throw new Error("Invalid active operations response");
      const operations = body.operations.map(parseOperation);
      if (new Set(operations.map(operation => operation.id)).size !== operations.length) throw new Error("Invalid active operations response");
      if (!operations.length) {
        this.continueAfterSync = false;
        this.emit({ status: "idle", message: "No active sync or analysis found. Previous unconfirmed results are not known." });
        return;
      }
      // Reload recovery only observes existing work; it never posts new analysis.
      let terminalFailure: AtisOperationView | undefined;
      for (const operation of operations) {
        if (!await this.follow(operation, signal)) {
          if (this.view.status === "unconfirmed") return;
          terminalFailure = this.view;
        }
      }
      if (terminalFailure) this.emit(terminalFailure);
    }, callerSignal);
  }
}
