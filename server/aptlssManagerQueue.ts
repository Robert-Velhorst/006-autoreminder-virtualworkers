import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  aptlssManagerQueue,
  aptlssManagerQueueEvents,
  aptlssManagerQueueSlots,
} from "../drizzle/schema.postgres";
import { users, aptlssManagerState, vaProfiles } from "../drizzle/schema.postgres";
import type { getDb } from "./db";
import { isManagerPilotWorker, managerPilotEnabled, managerPilotWorkerIds } from "./aptlssManagerPilot";

export type ManagerQueueTrigger =
  | "source_ingested"
  | "worker_update"
  | "decision_outcome"
  | "conflict"
  | "conflict_resolved"
  | "timer_changed"
  | "decision_deadline_changed"
  | "periodic"
  | "manual";
export type ManagerQueueLease = {
  vaId: number;
  token: string;
  slotId: number;
  generation: number;
  trigger: string;
  expiresAt: Date;
};
export type QueueState = Omit<
  typeof aptlssManagerQueue.$inferSelect,
  "vaId" | "updatedAt"
>;
export const MANAGER_QUEUE_MAX_ATTEMPTS = 5;
export const MANAGER_QUEUE_MAX_CONCURRENCY = 4;
export type ManagerQueueDatabase = NonNullable<
  Awaited<ReturnType<typeof getDb>>
>;
export type ManagerQueueTransaction = Parameters<
  Parameters<ManagerQueueDatabase["transaction"]>[0]
>[0];
export type ManagerQueueConnection =
  | ManagerQueueDatabase
  | ManagerQueueTransaction;
export class ManagerQueueLeaseLostError extends Error {
  constructor() {
    super(
      "Manager queue lease is no longer current; assessment was not applied."
    );
  }
}

/** Retry only whole rolled-back database transactions, never provider/model work. */
export async function retryQueueTransaction<T>(
  operation: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      let cause: unknown = error,
        retryable = false;
      for (
        let depth = 0;
        cause && typeof cause === "object" && depth < 5;
        depth++
      ) {
        const item = cause as {
          errno?: number;
          code?: string;
          cause?: unknown;
        };
        retryable ||=
          item.code === "40P01" || item.code === "40001" || item.code === "55P03";
        cause = item.cause;
      }
      if (!retryable || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
const queueTransaction = <T>(
  db: ManagerQueueDatabase,
  work: (tx: ManagerQueueTransaction) => Promise<T>
) =>
  retryQueueTransaction(() =>
    db.transaction(work, { isolationLevel: "read committed" })
  );

export function managerQueueEventHash(
  vaId: number,
  trigger: ManagerQueueTrigger,
  eventKey: string
) {
  if (
    !Number.isSafeInteger(vaId) ||
    vaId <= 0 ||
    !eventKey.trim() ||
    eventKey.length > 2048
  )
    throw new Error("A scoped worker and bounded event identity are required.");
  return createHash("sha256")
    .update(JSON.stringify([vaId, trigger, eventKey]))
    .digest("hex");
}
export function queueRetryDelay(attempt: number) {
  return Math.min(300_000, 1000 * 2 ** Math.max(0, Math.min(20, attempt - 1)));
}

export function queueEnqueued(
  row: QueueState,
  event: { trigger: ManagerQueueTrigger; urgent?: boolean },
  now: Date
): QueueState {
  const queued =
    row.state === "pending" ||
    (row.state === "leased" && row.generation > row.claimedGeneration);
  const priority = event.urgent ? 100 : 0;
  return {
    ...row,
    generation: row.generation + 1,
    state: row.state === "leased" ? "leased" : "pending",
    priority: queued ? Math.max(row.priority, priority) : priority,
    trigger: queued && row.priority > priority ? row.trigger : event.trigger,
    requestedAt: queued ? row.requestedAt : now,
    availableAt:
      row.state === "pending"
        ? new Date(Math.min(row.availableAt.getTime(), now.getTime()))
        : now,
    attempts: row.state === "leased" ? row.attempts : 0,
    lastError: null,
  };
}
export function queueClaimed(
  row: QueueState,
  token: string,
  now: Date,
  leaseMs: number
): QueueState {
  return {
    ...row,
    state: "leased",
    claimedGeneration: row.generation,
    attempts: row.generation !== row.claimedGeneration ? 1 : row.attempts + 1,
    leaseToken: token,
    leaseUntil: new Date(now.getTime() + leaseMs),
    lastError: null,
  };
}
export function queueFinished(row: QueueState, now: Date): QueueState {
  return {
    ...row,
    state: row.generation > row.claimedGeneration ? "pending" : "idle",
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
    completedAt: now,
    availableAt: now,
    lastError: null,
  };
}
export function queueFailed(row: QueueState, now: Date): QueueState {
  const newer = row.generation > row.claimedGeneration;
  const exhausted = !newer && row.attempts >= MANAGER_QUEUE_MAX_ATTEMPTS;
  return {
    ...row,
    state: exhausted ? "failed" : "pending",
    leaseToken: null,
    leaseUntil: null,
    attempts: newer ? 0 : row.attempts,
    availableAt: new Date(
      now.getTime() +
        (newer ? 0 : exhausted ? 300_000 : queueRetryDelay(row.attempts))
    ),
    lastError: exhausted
      ? "Manager assessment retries exhausted; a new event or periodic recovery is required."
      : "Manager assessment failed; a retry is scheduled.",
  };
}

async function databaseNow(db: ManagerQueueConnection) {
  const result = await db.execute<{ nowMs: string | number }>(
    sql`SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS "nowMs"`
  );
  return new Date(Number(result.rows[0].nowMs));
}
const eligible = () =>
  and(
    inArray(users.id, managerPilotWorkerIds()),
    eq(users.role, "worker"),
    or(isNull(aptlssManagerState.vaId), eq(aptlssManagerState.enabled, true)),
    or(isNull(vaProfiles.id), eq(vaProfiles.status, "active"))
  );
async function eligibleWorker(db: ManagerQueueConnection, vaId: number) {
  const [worker] = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(aptlssManagerState, eq(aptlssManagerState.vaId, users.id))
    .leftJoin(vaProfiles, eq(vaProfiles.userId, users.id))
    .where(and(eq(users.id, vaId), eligible()))
    .limit(1);
  return !!worker;
}
function checkedOptions(concurrency = 2, leaseMs = 60000) {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MANAGER_QUEUE_MAX_CONCURRENCY
  )
    throw new Error("Queue concurrency must be between one and four.");
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000)
    throw new Error("Queue lease must be between one and 300 seconds.");
  return { concurrency, leaseMs };
}

/** Caller owns the transaction, so a committed source event can never lose its queue receipt. */
export async function enqueueManagerTask(
  tx: ManagerQueueTransaction,
  event: {
    vaId: number;
    eventKey: string;
    trigger: ManagerQueueTrigger;
    urgent?: boolean;
  }
): Promise<{ accepted: boolean }> {
  if (!isManagerPilotWorker(event.vaId)) return { accepted: false };
  const eventHash = managerQueueEventHash(
    event.vaId,
    event.trigger,
    event.eventKey
  );
  const [worker] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, event.vaId), eq(users.role, "worker")))
    .limit(1);
  if (!worker)
    throw new Error("Manager queue events require an existing worker scope.");
  await tx
    .insert(aptlssManagerQueue)
    .values({ vaId: event.vaId })
    .onConflictDoUpdate({ target: aptlssManagerQueue.vaId, set: { vaId: event.vaId } });
  const [row] = await tx
    .select()
    .from(aptlssManagerQueue)
    .where(eq(aptlssManagerQueue.vaId, event.vaId))
    .for("update");
  const [seen] = await tx
    .select({ eventHash: aptlssManagerQueueEvents.eventHash })
    .from(aptlssManagerQueueEvents)
    .where(eq(aptlssManagerQueueEvents.eventHash, eventHash))
    .limit(1)
    .for("update");
  if (seen) return { accepted: false };
  const now = await databaseNow(tx);
  await tx
    .insert(aptlssManagerQueueEvents)
    .values({ eventHash, vaId: event.vaId, createdAt: now });
  await tx
    .update(aptlssManagerQueue)
    .set({ ...queueEnqueued(row, event, now), updatedAt: now })
    .where(eq(aptlssManagerQueue.vaId, event.vaId));
  return { accepted: true };
}

export async function claimManagerTask(
  db: ManagerQueueDatabase,
  options: { concurrency?: number; leaseMs?: number } = {}
): Promise<ManagerQueueLease | null> {
  if (!managerPilotEnabled()) return null;
  const { concurrency, leaseMs } = checkedOptions(
    options.concurrency,
    options.leaseMs
  );
  return queueTransaction(db, async tx => {
    const now = await databaseNow(tx);
    const [slot] = await tx
      .select()
      .from(aptlssManagerQueueSlots)
      .where(
        and(
          lte(aptlssManagerQueueSlots.id, concurrency),
          or(
            isNull(aptlssManagerQueueSlots.leaseUntil),
            lte(aptlssManagerQueueSlots.leaseUntil, now)
          )
        )
      )
      .orderBy(aptlssManagerQueueSlots.id)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!slot) return null;
    // Inspect policy with nonlocking reads. The service rechecks it under the
    // worker lock before applying a result; the queue never changes permissions.
    const candidates = await tx
      .select({ job: aptlssManagerQueue })
      .from(aptlssManagerQueue)
      .innerJoin(users, eq(users.id, aptlssManagerQueue.vaId))
      .leftJoin(aptlssManagerState, eq(aptlssManagerState.vaId, users.id))
      .leftJoin(vaProfiles, eq(vaProfiles.userId, users.id))
      .where(
        and(
          eligible(),
          or(
            and(
              eq(aptlssManagerQueue.state, "pending"),
              lte(aptlssManagerQueue.availableAt, now)
            ),
            and(
              eq(aptlssManagerQueue.state, "leased"),
              lte(aptlssManagerQueue.leaseUntil, now)
            )
          )
        )
      )
      .orderBy(
        desc(aptlssManagerQueue.priority),
        asc(aptlssManagerQueue.requestedAt),
        asc(aptlssManagerQueue.vaId)
      )
      .limit(32);
    for (const { job: candidate } of candidates) {
      const [row] = await tx
        .select()
        .from(aptlssManagerQueue)
        .where(
          and(
            eq(aptlssManagerQueue.vaId, candidate.vaId),
            or(
              and(
                eq(aptlssManagerQueue.state, "pending"),
                lte(aptlssManagerQueue.availableAt, now)
              ),
              and(
                eq(aptlssManagerQueue.state, "leased"),
                lte(aptlssManagerQueue.leaseUntil, now)
              )
            )
          )
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) continue;
      if (
        row.state === "leased" &&
        row.generation === row.claimedGeneration &&
        row.attempts >= MANAGER_QUEUE_MAX_ATTEMPTS
      ) {
        await tx
          .update(aptlssManagerQueue)
          .set({ ...queueFailed(row, now), updatedAt: now })
          .where(eq(aptlssManagerQueue.vaId, row.vaId));
        continue;
      }
      const token = randomUUID(),
        next = queueClaimed(row, token, now, leaseMs);
      await tx
        .update(aptlssManagerQueueSlots)
        .set({ vaId: row.vaId, token, leaseUntil: next.leaseUntil })
        .where(eq(aptlssManagerQueueSlots.id, slot.id));
      await tx
        .update(aptlssManagerQueue)
        .set({ ...next, updatedAt: now })
        .where(eq(aptlssManagerQueue.vaId, row.vaId));
      return {
        vaId: row.vaId,
        token,
        slotId: slot.id,
        generation: row.generation,
        trigger: row.trigger,
        expiresAt: next.leaseUntil!,
      };
    }
    return null;
  });
}

async function lockedLease(
  tx: ManagerQueueConnection,
  lease: ManagerQueueLease
) {
  // All lease writers use slot -> job ordering; enqueue never locks a slot.
  const [slot] = await tx
    .select()
    .from(aptlssManagerQueueSlots)
    .where(eq(aptlssManagerQueueSlots.id, lease.slotId))
    .for("update");
  const [job] = await tx
    .select()
    .from(aptlssManagerQueue)
    .where(eq(aptlssManagerQueue.vaId, lease.vaId))
    .for("update");
  const now = await databaseNow(tx);
  if (
    !slot ||
    !job ||
    slot.token !== lease.token ||
    slot.vaId !== lease.vaId ||
    job.leaseToken !== lease.token ||
    job.state !== "leased" ||
    job.claimedGeneration !== lease.generation ||
    !slot.leaseUntil ||
    !job.leaseUntil ||
    slot.leaseUntil <= now ||
    job.leaseUntil <= now
  )
    return null;
  return { job, now };
}
export async function assertManagerQueueLease(
  tx: ManagerQueueTransaction,
  lease: ManagerQueueLease
): Promise<void> {
  if (
    !(await lockedLease(tx, lease)) ||
    !(await eligibleWorker(tx, lease.vaId))
  )
    throw new ManagerQueueLeaseLostError();
}
export async function renewManagerQueueLease(
  db: ManagerQueueDatabase,
  lease: ManagerQueueLease,
  leaseMs = 60000
): Promise<boolean> {
  checkedOptions(1, leaseMs);
  return queueTransaction(db, async tx => {
    const held = await lockedLease(tx, lease);
    if (!held) return false;
    const leaseUntil = new Date(held.now.getTime() + leaseMs);
    await tx
      .update(aptlssManagerQueueSlots)
      .set({ leaseUntil })
      .where(eq(aptlssManagerQueueSlots.id, lease.slotId));
    await tx
      .update(aptlssManagerQueue)
      .set({ leaseUntil, updatedAt: held.now })
      .where(eq(aptlssManagerQueue.vaId, lease.vaId));
    return true;
  });
}
async function settle(
  db: ManagerQueueDatabase,
  lease: ManagerQueueLease,
  failed: boolean
) {
  return queueTransaction(db, async tx => {
    const held = await lockedLease(tx, lease);
    if (!held) return false;
    await tx
      .update(aptlssManagerQueue)
      .set({
        ...(failed
          ? queueFailed(held.job, held.now)
          : queueFinished(held.job, held.now)),
        updatedAt: held.now,
      })
      .where(eq(aptlssManagerQueue.vaId, lease.vaId));
    await tx
      .update(aptlssManagerQueueSlots)
      .set({ vaId: null, token: null, leaseUntil: null })
      .where(eq(aptlssManagerQueueSlots.id, lease.slotId));
    return true;
  });
}
export const finishManagerTask = (
  db: ManagerQueueDatabase,
  lease: ManagerQueueLease
) => settle(db, lease, false);
export const failManagerTask = (
  db: ManagerQueueDatabase,
  lease: ManagerQueueLease
) => settle(db, lease, true);

export async function enqueueManagerFallback(
  db: ManagerQueueDatabase
): Promise<number> {
  if (!managerPilotEnabled()) return 0;
  let cursor = 0,
    count = 0;
  for (;;) {
    const page = await db
      .select({
        id: users.id,
        interval: aptlssManagerState.intervalMinutes,
        checkedAt: aptlssManagerState.checkedAt,
      })
      .from(users)
      .leftJoin(aptlssManagerState, eq(aptlssManagerState.vaId, users.id))
      .leftJoin(vaProfiles, eq(vaProfiles.userId, users.id))
      .where(and(gt(users.id, cursor), eligible()))
      .orderBy(users.id)
      .limit(100);
    if (!page.length) break;
    for (const worker of page) {
      cursor = worker.id;
      const accepted = await queueTransaction(db, async tx => {
        const now = await databaseNow(tx),
          intervalMs = Math.max(1, Math.min(60, worker.interval ?? 5)) * 60000;
        if (
          worker.checkedAt &&
          now.getTime() - worker.checkedAt.getTime() < intervalMs
        )
          return false;
        const [job] = await tx
          .select()
          .from(aptlssManagerQueue)
          .where(eq(aptlssManagerQueue.vaId, worker.id))
          .for("update");
        if (
          job &&
          (job.state === "pending" ||
            job.state === "leased" ||
            job.availableAt > now ||
            (job.completedAt &&
              now.getTime() - job.completedAt.getTime() < intervalMs))
        )
          return false;
        return (
          await enqueueManagerTask(tx, {
            vaId: worker.id,
            eventKey: `interval:${Math.floor(now.getTime() / intervalMs)}`,
            trigger: "periodic",
          })
        ).accepted;
      });
      if (accepted) count++;
    }
  }
  return count;
}

export function createManagerQueueRunner(options: {
  db: ManagerQueueDatabase;
  execute: (
    vaId: number,
    trigger: string,
    lease: ManagerQueueLease
  ) => Promise<unknown>;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  fallbackMs?: number;
  onError?: (error: Error) => void;
}) {
  const { concurrency, leaseMs } = checkedOptions(
    options.concurrency,
    options.leaseMs
  );
  const pollMs = options.pollMs ?? 1000,
    fallbackMs = options.fallbackMs ?? 60000;
  if (
    !Number.isInteger(pollMs) ||
    pollMs < 100 ||
    pollMs > 60000 ||
    !Number.isInteger(fallbackMs) ||
    fallbackMs < 1000
  )
    throw new Error("Queue polling intervals are outside safe bounds.");
  let stopped = false,
    interval: ReturnType<typeof setInterval> | undefined,
    fallbackTimer: ReturnType<typeof setInterval> | undefined;
  const lanes = new Set<Promise<void>>();
  let fallback: Promise<number> | null = null;
  let lastPollAt: number | null = null, lastFallbackAt: number | null = null;
  let pollFailed = false, fallbackFailed = false;
  const report = () =>
    options.onError?.(
      new Error(
        "Manager queue processing failed; durable work remains queued for retry."
      )
    );
  const perform = async (lease: ManagerQueueLease) => {
    let renewing: Promise<boolean> | null = null,
      lost = false;
    const heartbeat = setInterval(
      () => {
        if (renewing || lost) return;
        renewing = renewManagerQueueLease(options.db, lease, leaseMs)
          .catch(() => false)
          .then(ok => {
            lost ||= !ok;
            return ok;
          })
          .finally(() => {
            renewing = null;
          });
      },
      Math.max(100, Math.floor(leaseMs / 3))
    );
    heartbeat.unref();
    let failed = false;
    try {
      await options.execute(lease.vaId, lease.trigger, lease);
    } catch {
      failed = true;
    } finally {
      clearInterval(heartbeat);
      if (renewing) await renewing;
    }
    if (lost) return;
    if (failed) await failManagerTask(options.db, lease);
    else await finishManagerTask(options.db, lease);
  };
  const drain = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const worker = async () => {
      while (!stopped) {
        const lease = await claimManagerTask(options.db, {
          concurrency,
          leaseMs,
        });
        lastPollAt = Date.now();
        pollFailed = false;
        if (!lease) break;
        await perform(lease);
      }
    };
    // A later poll refills free lanes even while another worker is still running.
    while (lanes.size < concurrency) {
      const lane = worker()
        .catch(() => { pollFailed = true; report(); })
        .finally(() => {
          lanes.delete(lane);
        });
      lanes.add(lane);
    }
    return Promise.all([...lanes]).then(() => undefined);
  };
  const pollFallback = (): Promise<number> => {
    if (fallback) return fallback;
    if (stopped) return Promise.resolve(0);
    fallback = enqueueManagerFallback(options.db)
      .then(count => { lastFallbackAt = Date.now(); fallbackFailed = false; return count; })
      .catch(error => { fallbackFailed = true; throw error; })
      .finally(() => { fallback = null; });
    return fallback;
  };
  return {
    drain,
    pollFallback,
    // Process-local loop evidence, not a promise that every worker assessment succeeded.
    getStatus(now = Date.now()) {
      const recent = (at: number | null, maxAge: number) => at !== null && now >= at && now - at <= maxAge;
      return {
        started: !!interval && !stopped,
        healthy: !!interval && !stopped && !pollFailed && !fallbackFailed
          && recent(lastPollAt, Math.max(10_000, pollMs * 3))
          && recent(lastFallbackAt, fallbackMs * 2),
        failed: pollFailed || fallbackFailed,
        observed: lastPollAt !== null && lastFallbackAt !== null,
        busy: lanes.size > 0 || fallback !== null,
      };
    },
    start() {
      if (interval) return;
      stopped = false;
      lastPollAt = lastFallbackAt = null;
      pollFailed = fallbackFailed = false;
      interval = setInterval(() => {
        void drain();
      }, pollMs);
      interval.unref();
      fallbackTimer = setInterval(() => {
        void pollFallback()
          .then(() => drain())
          .catch(report);
      }, fallbackMs);
      fallbackTimer.unref();
      void pollFallback()
        .then(() => drain())
        .catch(report);
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      clearInterval(fallbackTimer);
      interval = undefined;
      fallbackTimer = undefined;
      await Promise.allSettled([...lanes, ...(fallback ? [fallback] : [])]);
    },
  };
}
