import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { scheduledJobLeases, scheduledJobRuns } from "../drizzle/schema.postgres";
import { getDb } from "./db";

export type ScheduledJobTrigger = "cron" | "external" | "manual";

export type ScheduledJobWorkResult = {
  recordsProcessed?: number;
  detail?: string | null;
};

export type ScheduledJobResult =
  | { state: "success"; runId: number; recordsProcessed: number }
  | { state: "skipped"; reason: "already_succeeded" | "lease_held" | "not_due" };

export class ScheduledJobLeaseLostError extends Error {
  constructor() { super("Scheduled job lease is no longer owned or has expired"); this.name = "ScheduledJobLeaseLostError"; }
}

export type ScheduledJobDatabase = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type ScheduledJobTransaction = Parameters<Parameters<ScheduledJobDatabase["transaction"]>[0]>[0];
export type ScheduledJobOwnershipReader = Pick<ScheduledJobDatabase, "select">;

export type ScheduledJobContext = {
  /** Available only after the durable run insert has committed. */
  runId?: number;
  signal: AbortSignal;
  assertOwnership: (transaction?: ScheduledJobOwnershipReader) => Promise<void>;
};


function cleanJobKey(jobKey: string) {
  const normalized = jobKey.trim();
  if (!normalized || normalized.length > 96) throw new Error("Scheduled job key must contain 1 to 96 characters");
  return normalized;
}

export async function runScheduledJob(
  input: {
    jobKey: string;
    trigger?: ScheduledJobTrigger;
    leaseMs?: number;
    skipIfSuccessful?: boolean;
    initialDetail?: string;
    shouldRun?: (context: ScheduledJobContext, transaction: ScheduledJobTransaction) => Promise<boolean>;
  },
  work: (context: ScheduledJobContext) => Promise<ScheduledJobWorkResult | void>,
): Promise<ScheduledJobResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable for scheduled job execution");

  const jobKey = cleanJobKey(input.jobKey);
  const trigger = input.trigger ?? "cron";
  if (input.leaseMs !== undefined && !Number.isFinite(input.leaseMs)) throw new Error("Scheduled job lease duration must be finite");
  const leaseMs = Math.round(Math.min(60 * 60_000, Math.max(30_000, input.leaseMs ?? 10 * 60_000)));
  const skipIfSuccessful = input.skipIfSuccessful ?? true;

  if (skipIfSuccessful) {
    const [completed] = await db.select({ id: scheduledJobRuns.id })
      .from(scheduledJobRuns)
      .where(and(eq(scheduledJobRuns.jobKey, jobKey), eq(scheduledJobRuns.status, "success")))
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(1);
    if (completed) return { state: "skipped", reason: "already_succeeded" };
  }

  const now = new Date();
  const ownerToken = randomBytes(24).toString("hex");
  // Every server uses the database clock for ownership, not its own wall clock.
  const databaseNow = sql<Date>`clock_timestamp()`;
  const leaseExpiry = sql<Date>`clock_timestamp() + (${leaseMs}::double precision * interval '1 millisecond')`;
  await db.insert(scheduledJobLeases).values({
    jobKey, ownerToken, acquiredAt: databaseNow, heartbeatAt: databaseNow, leaseExpiresAt: leaseExpiry,
  }).onConflictDoUpdate({
    target: scheduledJobLeases.jobKey,
    set: { ownerToken, acquiredAt: databaseNow, heartbeatAt: databaseNow, leaseExpiresAt: leaseExpiry },
    setWhere: sql`${scheduledJobLeases.leaseExpiresAt} <= clock_timestamp()`,
  });

  let runId = 0;
  const controller = new AbortController();
  const ownershipCondition = and(eq(scheduledJobLeases.jobKey, jobKey),
    eq(scheduledJobLeases.ownerToken, ownerToken), sql`${scheduledJobLeases.leaseExpiresAt} > clock_timestamp()`);
  const assertOwnership = async (transaction?: ScheduledJobOwnershipReader) => {
    if (controller.signal.aborted) throw new ScheduledJobLeaseLostError();
    const query = (transaction ?? db).select({ jobKey: scheduledJobLeases.jobKey }).from(scheduledJobLeases)
      .where(ownershipCondition).limit(1);
    // A current locking read uses the transaction's own connection and retains
    // ownership through its commit, rather than exhausting a second pool slot.
    const [owned] = await (transaction ? query.for("share") : query);
    if (!owned || controller.signal.aborted) { controller.abort(); throw new ScheduledJobLeaseLostError(); }
  };
  let heartbeatPending: Promise<void> | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const heartbeatEveryMs = Math.min(60_000, Math.max(10_000, Math.floor(leaseMs / 3)));
  try {
    const [lease] = await db.select({ ownerToken: scheduledJobLeases.ownerToken })
      .from(scheduledJobLeases).where(eq(scheduledJobLeases.jobKey, jobKey)).limit(1);
    if (lease?.ownerToken !== ownerToken) return { state: "skipped", reason: "lease_held" };
    // A contender may have checked success before the previous owner finished.
    // Once this lease is held, repeat that check before recording or doing work.
    if (skipIfSuccessful) {
      const [completed] = await db.select({ id: scheduledJobRuns.id }).from(scheduledJobRuns)
        .where(and(eq(scheduledJobRuns.jobKey, jobKey), eq(scheduledJobRuns.status, "success"))).limit(1);
      if (completed) return { state: "skipped", reason: "already_succeeded" };
    }
    const runResult = await db.transaction(async tx => {
      const [owned] = await tx.select({ jobKey: scheduledJobLeases.jobKey }).from(scheduledJobLeases)
        .where(ownershipCondition).limit(1).for("update");
      if (!owned) throw new ScheduledJobLeaseLostError();
      if (input.shouldRun) {
        const context = { signal: controller.signal,
          assertOwnership: (reader: ScheduledJobOwnershipReader = tx) => assertOwnership(reader) };
        if (!await input.shouldRun(context, tx)) return null;
        await assertOwnership(tx);
      }
      await tx.update(scheduledJobRuns).set({ status: "abandoned", finishedAt: databaseNow,
        errorMessage: "Previous owner interrupted; task outcome is not verified.",
      }).where(and(eq(scheduledJobRuns.jobKey, jobKey), eq(scheduledJobRuns.status, "running")));
      return tx.insert(scheduledJobRuns).values({ jobKey, trigger, status: "running", startedAt: databaseNow,
        ...(input.initialDetail === undefined ? {} : { detail: input.initialDetail.slice(0, 8_000) }),
      }).returning({ id: scheduledJobRuns.id });
    });
    if (!runResult) return { state: "skipped", reason: "not_due" };
    runId = runResult[0]?.id ?? 0;
    if (!runId) throw new Error("Scheduled job run could not be recorded");
    await assertOwnership();
    heartbeatTimer = setInterval(() => {
      if (heartbeatPending || controller.signal.aborted) return;
      heartbeatPending = db.update(scheduledJobLeases).set({ heartbeatAt: databaseNow, leaseExpiresAt: leaseExpiry })
        .where(ownershipCondition).then(result => {
          if (result.rowCount !== 1) controller.abort();
        }).catch(() => {
          controller.abort();
          console.warn("[ScheduledJob] Lease renewal unavailable; ownership must be re-established");
        }).finally(() => { heartbeatPending = undefined; });
    }, heartbeatEveryMs);
    heartbeatTimer.unref?.();
    const result = await work({ signal: controller.signal, assertOwnership, runId });
    const finishedAt = new Date();
    const recordsProcessed = Math.max(0, Math.round(result?.recordsProcessed ?? 0));
    // Lock ownership through the success write: an expired owner cannot claim
    // completion, and a replacement owner cannot be released by this run.
    await db.transaction(async tx => {
      const [owned] = await tx.select({ jobKey: scheduledJobLeases.jobKey }).from(scheduledJobLeases)
        .where(ownershipCondition).limit(1).for("update");
      if (!owned || controller.signal.aborted) throw new ScheduledJobLeaseLostError();
      await tx.update(scheduledJobRuns).set({ status: "success", finishedAt: databaseNow,
        durationMs: Math.max(0, finishedAt.getTime() - now.getTime()), recordsProcessed,
        detail: result?.detail?.slice(0, 8_000) ?? null, errorMessage: null,
      }).where(and(eq(scheduledJobRuns.id, runId), eq(scheduledJobRuns.status, "running")));
    });
    return { state: "success", runId, recordsProcessed };
  } catch (error) {
    const finishedAt = new Date();
    const message = error instanceof Error ? error.message : "Unknown scheduled job failure";
    if (runId) await db.update(scheduledJobRuns).set({
      status: "error",
      finishedAt: databaseNow,
      durationMs: Math.max(0, finishedAt.getTime() - now.getTime()),
      errorMessage: message.slice(0, 8_000),
    }).where(and(eq(scheduledJobRuns.id, runId), eq(scheduledJobRuns.status, "running")))
      .catch(() => { console.warn("[ScheduledJob] Could not record task failure; retained run needs reconciliation"); });
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (heartbeatPending) await heartbeatPending;
    await db.delete(scheduledJobLeases).where(and(
      eq(scheduledJobLeases.jobKey, jobKey),
      eq(scheduledJobLeases.ownerToken, ownerToken),
    )).catch(() => { console.warn("[ScheduledJob] Could not release owned lease; expiry will permit recovery"); });
  }
}
