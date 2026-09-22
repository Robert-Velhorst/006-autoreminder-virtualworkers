import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appSettings, users } from "../drizzle/schema";
import type { getDb } from "./db";
import { assertManagerExecutionAllowed } from "./aptlssManagerReviewService";
import { codexAttemptSchema, managerSemanticProvider, type CodexManagerAttempt } from "./aptlssManagerCodex";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const runtimeSchema = z.object({
  attemptId: z.string(), sourceHash: z.string(), success: z.boolean(),
  attemptedAt: z.string().datetime(), retryAfter: z.string().datetime(),
  failures: z.number().int().min(0).max(10),
  failureKind: z.literal("quota").optional(),
  provider: z.enum(["openai-api", "codex-subscription"]).optional(),
  attempts: z.array(codexAttemptSchema).max(3).optional(),
}).strict();
export type ManagerSemanticRuntime = z.infer<typeof runtimeSchema>;
export const MANAGER_SEMANTIC_MIN_INTERVAL_MS = 60_000;
export function managerSemanticBackoff(failures: number, failureKind?: "quota") {
  if (failureKind === "quota") return 6 * 60 * 60_000;
  return Math.min(15 * 60_000, MANAGER_SEMANTIC_MIN_INTERVAL_MS * 2 ** Math.max(0, Math.min(10, failures) - 1));
}
export function managerSemanticRetryReady(runtime: Pick<ManagerSemanticRuntime, "retryAfter" | "attemptedAt" | "failureKind">, manual: boolean, now: number) {
  return Date.parse(runtime.retryAfter) <= now || (manual && runtime.failureKind === "quota" &&
    now - Date.parse(runtime.attemptedAt) >= MANAGER_SEMANTIC_MIN_INTERVAL_MS);
}
const key = (vaId: number) => `aptlss_manager_semantic:${vaId}${managerSemanticProvider() === "codex-subscription" ? ":codex" : ""}`;
async function readRuntime(db: Db, vaId: number): Promise<ManagerSemanticRuntime | null> {
  const [row] = await db.select().from(appSettings)
    .where(and(eq(appSettings.vaId, vaId), eq(appSettings.key, key(vaId)))).limit(1);
  // Invalid retained budget state must not silently reset a provider quota.
  return row ? runtimeSchema.parse(JSON.parse(row.value)) : null;
}
async function writeRuntime(db: Db, vaId: number, runtime: ManagerSemanticRuntime) {
  const values = { vaId, key: key(vaId), value: JSON.stringify(runtime) };
  await db.insert(appSettings).values(values).onDuplicateKeyUpdate({ set: { value: values.value } });
}

/** Reserve durably before the provider call; worker locking also fences other processes. */
export async function reserveManagerSemanticReview(db: Db, vaId: number, sourceHash: string, force: boolean) {
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, vaId)).for("update");
    await assertManagerExecutionAllowed(tx as unknown as Db, vaId);
    const previous = await readRuntime(tx as unknown as Db, vaId);
    const now = new Date();
    if (previous && (!managerSemanticRetryReady(previous, force, now.getTime())
      || (previous.success && previous.sourceHash === sourceHash && !force))) {
      return { reserved: false, runtime: previous };
    }
    const failures = Math.min(10, (previous?.success ? 0 : previous?.failures ?? 0) + 1);
    const runtime: ManagerSemanticRuntime = {
      attemptId: randomUUID(), sourceHash, success: false, failures, provider: managerSemanticProvider(),
      attemptedAt: now.toISOString(), retryAfter: new Date(now.getTime() + managerSemanticBackoff(failures)).toISOString(),
    };
    await writeRuntime(tx as unknown as Db, vaId, runtime);
    return { reserved: true, runtime };
  });
}

/** Called inside the proposal transaction after its worker lock and context revalidation. */
export async function finishManagerSemanticReview(db: Db, vaId: number, runtime: ManagerSemanticRuntime, success: boolean, failureKind?: "quota", attempts?: CodexManagerAttempt[]) {
  await assertManagerExecutionAllowed(db, vaId);
  const current = await readRuntime(db, vaId);
  if (current?.attemptId !== runtime.attemptId) throw new Error("Semantic review reservation is no longer current.");
  const finished = { ...runtime, success, attempts, failureKind: success ? undefined : failureKind, failures: success ? 0 : runtime.failures,
    retryAfter: new Date(Date.now() + (success ? MANAGER_SEMANTIC_MIN_INTERVAL_MS : managerSemanticBackoff(runtime.failures, failureKind))).toISOString() };
  await writeRuntime(db, vaId, finished);
  return finished;
}
