import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { scheduledJobLeases, scheduledJobRuns } from "../drizzle/schema";
import { getDb } from "./db";

export type ScheduledJobTrigger = "cron" | "external" | "manual";

export type ScheduledJobWorkResult = {
  recordsProcessed?: number;
  detail?: string | null;
};

export type ScheduledJobResult =
  | { state: "success"; runId: number; recordsProcessed: number }
  | { state: "skipped"; reason: "already_succeeded" | "lease_held" };

function insertId(result: unknown) {
  if (Array.isArray(result)) return Number((result[0] as { insertId?: unknown } | undefined)?.insertId ?? 0);
  return Number((result as { insertId?: unknown } | undefined)?.insertId ?? 0);
}

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
  },
  work: () => Promise<ScheduledJobWorkResult | void>,
): Promise<ScheduledJobResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable for scheduled job execution");

  const jobKey = cleanJobKey(input.jobKey);
  const trigger = input.trigger ?? "cron";
  const leaseMs = Math.min(60 * 60_000, Math.max(30_000, input.leaseMs ?? 10 * 60_000));
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
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  await db.execute(sql`
    INSERT INTO ${scheduledJobLeases} (${scheduledJobLeases.jobKey}, ${scheduledJobLeases.ownerToken}, ${scheduledJobLeases.acquiredAt}, ${scheduledJobLeases.heartbeatAt}, ${scheduledJobLeases.leaseExpiresAt})
    VALUES (${jobKey}, ${ownerToken}, ${now}, ${now}, ${leaseExpiresAt})
    ON DUPLICATE KEY UPDATE
      ${scheduledJobLeases.ownerToken} = IF(${scheduledJobLeases.leaseExpiresAt} <= ${now}, VALUES(${scheduledJobLeases.ownerToken}), ${scheduledJobLeases.ownerToken}),
      ${scheduledJobLeases.acquiredAt} = IF(${scheduledJobLeases.leaseExpiresAt} <= ${now}, VALUES(${scheduledJobLeases.acquiredAt}), ${scheduledJobLeases.acquiredAt}),
      ${scheduledJobLeases.heartbeatAt} = IF(${scheduledJobLeases.leaseExpiresAt} <= ${now}, VALUES(${scheduledJobLeases.heartbeatAt}), ${scheduledJobLeases.heartbeatAt}),
      ${scheduledJobLeases.leaseExpiresAt} = IF(${scheduledJobLeases.leaseExpiresAt} <= ${now}, VALUES(${scheduledJobLeases.leaseExpiresAt}), ${scheduledJobLeases.leaseExpiresAt})
  `);

  const [lease] = await db.select({ ownerToken: scheduledJobLeases.ownerToken })
    .from(scheduledJobLeases)
    .where(eq(scheduledJobLeases.jobKey, jobKey))
    .limit(1);
  if (lease?.ownerToken !== ownerToken) return { state: "skipped", reason: "lease_held" };

  const runResult = await db.insert(scheduledJobRuns).values({
    jobKey,
    trigger,
    status: "running",
    startedAt: now,
  });
  const runId = insertId(runResult);
  if (!runId) {
    await db.delete(scheduledJobLeases).where(and(
      eq(scheduledJobLeases.jobKey, jobKey),
      eq(scheduledJobLeases.ownerToken, ownerToken),
    ));
    throw new Error("Scheduled job run could not be recorded");
  }

  let heartbeatRunning = false;
  const heartbeatEveryMs = Math.min(60_000, Math.max(10_000, Math.floor(leaseMs / 3)));
  const heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    const heartbeatAt = new Date();
    void db.update(scheduledJobLeases).set({
      heartbeatAt,
      leaseExpiresAt: new Date(heartbeatAt.getTime() + leaseMs),
    }).where(and(
      eq(scheduledJobLeases.jobKey, jobKey),
      eq(scheduledJobLeases.ownerToken, ownerToken),
    )).catch((error) => {
      console.error(`[ScheduledJob] Lease heartbeat failed for ${jobKey}`, error);
    }).finally(() => {
      heartbeatRunning = false;
    });
  }, heartbeatEveryMs);
  heartbeatTimer.unref?.();

  try {
    const result = await work();
    const finishedAt = new Date();
    const recordsProcessed = Math.max(0, Math.round(result?.recordsProcessed ?? 0));
    await db.update(scheduledJobRuns).set({
      status: "success",
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - now.getTime()),
      recordsProcessed,
      detail: result?.detail?.slice(0, 8_000) ?? null,
      errorMessage: null,
    }).where(eq(scheduledJobRuns.id, runId));
    return { state: "success", runId, recordsProcessed };
  } catch (error) {
    const finishedAt = new Date();
    const message = error instanceof Error ? error.message : "Unknown scheduled job failure";
    await db.update(scheduledJobRuns).set({
      status: "error",
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - now.getTime()),
      errorMessage: message.slice(0, 8_000),
    }).where(eq(scheduledJobRuns.id, runId));
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    await db.delete(scheduledJobLeases).where(and(
      eq(scheduledJobLeases.jobKey, jobKey),
      eq(scheduledJobLeases.ownerToken, ownerToken),
    ));
  }
}
