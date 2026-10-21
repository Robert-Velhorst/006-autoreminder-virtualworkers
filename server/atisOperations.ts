import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { scheduledJobLeases, scheduledJobRuns } from "../drizzle/schema.postgres";
import { getDb } from "./db";
import { runScheduledJob, ScheduledJobLeaseLostError, type ScheduledJobContext,
  type ScheduledJobOwnershipReader, type ScheduledJobTransaction } from "./scheduledJobRuntime";

export const ATIS_JOB_KEYS = { sync: "atis:v1:sync", understanding: "atis:v1:understanding" } as const;
export type AtisOperationKind = keyof typeof ATIS_JOB_KEYS;
export type AtisOperation = {
  id: number;
  kind: AtisOperationKind;
  state: "running" | "completed" | "failed" | "interrupted";
  result?: Record<string, number | string | boolean>;
  error?: string;
};
type Metadata = { version: 1; kind: AtisOperationKind; ownerUserId: number;
  request: { cardId?: number; limit?: number; analysisRequestId?: string }; result?: AtisOperation["result"] };
type Run = typeof scheduledJobRuns.$inferSelect;

export class AtisOperationRecoveryRequired extends Error {
  constructor(public operation: AtisOperation) { super("Review the interrupted operation before explicitly acknowledging a new run."); }
}
export class AtisOperationRequestConflict extends Error {
  constructor(public operation: AtisOperation) { super("A different ATIS request is already running. This request was not started."); }
}

function normalizeRequest(kind: AtisOperationKind, request: Metadata["request"] = {}): Metadata["request"] {
  if (kind === "sync") return {};
  if (request.analysisRequestId !== undefined) {
    if (!/^[a-f0-9-]{36}$/.test(request.analysisRequestId) || request.cardId !== undefined || request.limit !== undefined) {
      throw new Error("Invalid analysis request identity");
    }
    return { analysisRequestId: request.analysisRequestId };
  }
  if (request.cardId !== undefined) {
    if (!Number.isSafeInteger(request.cardId) || request.cardId <= 0) throw new Error("Invalid card ID");
    return { cardId: request.cardId };
  }
  const limit = request.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid understanding limit");
  return { limit };
}

// Whitelist bounded scalar results; never publish provider errors, prompts or card content.
export function summarizeAtisResult(kind: AtisOperationKind, result: Record<string, unknown> = {}) {
  const summary: NonNullable<AtisOperation["result"]> = {};
  const counts = kind === "sync" ? ["newBoards", "newCards", "totalBoards", "totalCards"] : ["processed", "failed", "cardId"];
  for (const key of counts) {
    const value = result[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) summary[key] = value;
  }
  if (result.success === true) summary.success = true;
  if (typeof summary.cardId === "number" && summary.cardId > 0) {
    summary.understandingUrl = `/api/atis/card/${summary.cardId}/understanding`;
  }
  return summary;
}

export function presentAtisOperation(run: Run, live: boolean): AtisOperation {
  const kind = (Object.keys(ATIS_JOB_KEYS) as AtisOperationKind[]).find(key => ATIS_JOB_KEYS[key] === run.jobKey);
  if (!kind) throw new Error("Not an ATIS operation");
  let metadata: Metadata | undefined;
  try {
    const parsed = JSON.parse(run.detail ?? "null");
    if (parsed?.version === 1 && parsed.kind === kind && Number.isSafeInteger(parsed.ownerUserId) && parsed.ownerUserId > 0) metadata = parsed;
  } catch { /* Unknown history is interrupted, not silently replayed. */ }
  const state = !metadata ? "interrupted" : run.status === "success" ? "completed"
    : run.status === "running" && live ? "running"
    : run.status === "error" && run.errorMessage === "ATIS operation failed" ? "failed" : "interrupted";
  return { id: run.id, kind, state,
    ...(state === "completed" ? { result: summarizeAtisResult(kind, metadata?.result) } : {}),
    ...(state === "failed" ? { error: "ATIS operation failed. Review server logs before retrying." } : {}),
    ...(state === "interrupted" ? { error: "Operation outcome is unverified. Review before starting a replacement." } : {}),
  };
}

async function readOperations(reader?: ScheduledJobOwnershipReader, id?: number, kind?: AtisOperationKind) {
  const db = reader ?? await getDb();
  if (!db) throw new Error("ATIS status unavailable");
  return db.select({ run: scheduledJobRuns, live: sql<boolean>`exists (
    select 1 from ${scheduledJobLeases} where ${scheduledJobLeases.jobKey} = ${scheduledJobRuns.jobKey}
    and ${scheduledJobLeases.leaseExpiresAt} > clock_timestamp()
    and ${scheduledJobLeases.acquiredAt} <= ${scheduledJobRuns.startedAt})` })
    .from(scheduledJobRuns).where(and(
      inArray(scheduledJobRuns.jobKey, Object.values(ATIS_JOB_KEYS)),
      id === undefined ? undefined : eq(scheduledJobRuns.id, id),
      kind === undefined ? undefined : eq(scheduledJobRuns.jobKey, ATIS_JOB_KEYS[kind]),
    )).orderBy(desc(scheduledJobRuns.id)).limit(kind || id !== undefined ? 1 : 100);
}

export async function getAtisOperation(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [row] = await readOperations(undefined, id);
  return row ? presentAtisOperation(row.run, row.live) : null;
}

export async function getAtisAnalysisOperation(ownerUserId: number, analysisRequestId: string) {
  if (!/^[a-f0-9-]{36}$/.test(analysisRequestId)) return null;
  const db = await getDb();
  if (!db) throw new Error("ATIS status unavailable");
  // Generated UUIDs contain no LIKE metacharacters. Parse and verify the bounded
  // operation metadata after this indexed-kind search, never cast legacy text JSON.
  const rows = await db.select({ id: scheduledJobRuns.id, detail: scheduledJobRuns.detail }).from(scheduledJobRuns)
    .where(and(eq(scheduledJobRuns.jobKey, ATIS_JOB_KEYS.understanding),
      sql`${scheduledJobRuns.detail} LIKE ${`%"analysisRequestId":"${analysisRequestId}"%`}`))
    .orderBy(desc(scheduledJobRuns.id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    const metadata = JSON.parse(row.detail ?? 'null');
    if (metadata?.version !== 1 || metadata.ownerUserId !== ownerUserId
      || metadata.request?.analysisRequestId !== analysisRequestId) return null;
  } catch { return null; }
  return getAtisOperation(row.id);
}

async function latest(kind: AtisOperationKind, reader?: ScheduledJobOwnershipReader) {
  const [row] = await readOperations(reader, undefined, kind);
  return row ? presentAtisOperation(row.run, row.live) : null;
}

export async function getActiveAtisOperations() {
  const operations: AtisOperation[] = [];
  for (const kind of Object.keys(ATIS_JOB_KEYS) as AtisOperationKind[]) {
    const operation = await latest(kind);
    if (operation?.state === "running" || operation?.state === "interrupted") operations.push(operation);
  }
  return operations;
}

export async function startAtisOperation(input: {
  kind: AtisOperationKind; ownerUserId: number; request?: Metadata["request"];
  acknowledgeInterruptedOperationId?: number;
  admission?: (context: ScheduledJobContext, transaction: ScheduledJobTransaction) => Promise<void>;
}, work: (context: ScheduledJobContext) => Promise<Record<string, unknown>>): Promise<AtisOperation> {
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0) throw new Error("Invalid ATIS owner");
  const request = normalizeRequest(input.kind, input.request);
  const requireMatchingRequest = async (operation: AtisOperation, reader?: ScheduledJobOwnershipReader) => {
    const [row] = await readOperations(reader, operation.id);
    let identical = false;
    try {
      const metadata = JSON.parse(row?.run.detail ?? "null");
      identical = JSON.stringify(normalizeRequest(input.kind, metadata.request)) === JSON.stringify(request);
    } catch { /* Unknown request metadata cannot accept a caller's work. */ }
    if (!identical) throw new AtisOperationRequestConflict(operation);
  };
  const check = async (previous: AtisOperation | null, reader?: ScheduledJobOwnershipReader) => {
    if (previous?.state === "interrupted" && input.acknowledgeInterruptedOperationId !== previous.id) {
      throw new AtisOperationRecoveryRequired(previous);
    }
    if (previous?.state !== "running") return false;
    await requireMatchingRequest(previous, reader);
    return true;
  };
  const previous = await latest(input.kind);
  if (await check(previous)) return previous!;
  const metadata: Metadata = { version: 1, kind: input.kind, ownerUserId: input.ownerUserId, request };
  let resolve!: (operation: AtisOperation) => void;
  let reject!: (error: unknown) => void;
  const started = new Promise<AtisOperation>((accept, fail) => { resolve = accept; reject = fail; });
  // Observe every detached completion/failure. The database, not this promise, is status authority.
  void runScheduledJob({ jobKey: ATIS_JOB_KEYS[input.kind], trigger: "manual", skipIfSuccessful: false,
    initialDetail: JSON.stringify(metadata),
    shouldRun: async (context, tx) => {
      if (await check(await latest(input.kind, tx), tx)) return false;
      await input.admission?.(context, tx);
      await context.assertOwnership(tx);
      return true;
    },
  }, async context => {
    if (!context.runId) throw new Error("Durable ATIS run missing");
    resolve({ id: context.runId, kind: input.kind, state: "running" });
    await new Promise<void>(accept => setImmediate(accept));
    try {
      await context.assertOwnership();
      const result = summarizeAtisResult(input.kind, await work(context));
      await context.assertOwnership();
      return { recordsProcessed: Number(result.processed ?? result.newCards ?? 0), detail: JSON.stringify({ ...metadata, result }) };
    } catch (error) {
      if (error instanceof ScheduledJobLeaseLostError || context.signal.aborted) throw new ScheduledJobLeaseLostError();
      throw new Error("ATIS operation failed");
    }
  }).then(async outcome => {
    if (outcome.state !== "skipped") return;
    // A lease may be acquired just before its durable run is inserted.
    for (let attempt = 0; attempt < 20; attempt++) {
      const operation = await latest(input.kind);
      if (operation?.state === "running") { await check(operation); resolve(operation); return; }
      if (operation?.state === "interrupted") { reject(new AtisOperationRecoveryRequired(operation)); return; }
      if (operation && operation.id !== previous?.id) { await requireMatchingRequest(operation); resolve(operation); return; }
      await new Promise(accept => setTimeout(accept, 25));
    }
    reject(new Error("ATIS start temporarily unavailable; read active operations before retrying"));
  }).catch(error => { reject(error); console.warn("[ATIS] Operation execution or start unavailable"); });
  return started;
}
