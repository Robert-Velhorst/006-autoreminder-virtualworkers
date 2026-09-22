import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const CODEX_MANAGER_MODEL = "gpt-5.6-luna";
export const CODEX_MANAGER_EFFORTS = ["low", "medium", "high"] as const;
export type CodexManagerEffort = typeof CODEX_MANAGER_EFFORTS[number];
export const CODEX_MANAGER_ROUTE = "luna-adaptive-v1";
export const codexAttemptSchema = z.object({
  effort: z.enum(CODEX_MANAGER_EFFORTS),
  outcome: z.enum(["accepted", "context_review", "invalid_output", "missing_evidence", "rejected", "unavailable", "unauthenticated", "limited"]),
  reason: z.enum(["cross_source_context", "chronology", "ambiguity", "validation"]).optional(),
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
}).strict();
export type CodexManagerAttempt = z.infer<typeof codexAttemptSchema>;
export const codexRequestSchema = z.object({
  version: z.literal(2), id: z.string().uuid(), createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(), input: z.string().max(90_000),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const codexReplySchema = z.object({
  version: z.literal(2), id: z.string().uuid(), inputHash: z.string(),
  model: z.literal(CODEX_MANAGER_MODEL), effort: z.enum(CODEX_MANAGER_EFFORTS),
  route: z.literal(CODEX_MANAGER_ROUTE), attempts: z.array(codexAttemptSchema).min(1).max(3),
  status: z.enum(["completed", "unavailable", "unauthenticated", "limited", "rejected"]),
  text: z.string().max(150_000).optional(),
  usage: z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative(), cached_input_tokens: z.number().nonnegative().optional() }).passthrough().optional(),
}).strict().superRefine((reply, ctx) => {
  const last = reply.attempts.at(-1);
  const mayEscalate = (attempt: CodexManagerAttempt) =>
    (attempt.outcome === "context_review" && ["cross_source_context", "chronology", "ambiguity"].includes(attempt.reason ?? "")) ||
    (attempt.outcome === "invalid_output" && attempt.reason === "validation");
  const validSequence = reply.attempts.every((attempt, index) =>
    attempt.effort === CODEX_MANAGER_EFFORTS[index] && (index === reply.attempts.length - 1 || mayEscalate(attempt)));
  const exhausted = last?.effort === "high" && mayEscalate(last);
  const validTerminal = last && (reply.status === "completed"
    ? ["accepted", "missing_evidence"].includes(last.outcome) && !!reply.text?.trim()
    : !reply.text && (last.outcome === reply.status || (reply.status === "rejected" && exhausted)));
  if (!validSequence || reply.effort !== last?.effort || !validTerminal) {
    ctx.addIssue({ code: "custom", message: "Inconsistent Codex assessment status or escalation history" });
  }
});
export const codexInputHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function managerSemanticProvider() {
  const provider = process.env.APTLSS_MANAGER_PROVIDER?.trim() || "openai-api";
  if (provider !== "openai-api" && provider !== "codex-subscription") throw new Error("Unknown APTLSS manager provider");
  return provider;
}

export async function requestManagerCodexReview(input: string, signal: AbortSignal, onAttempts?: (attempts: CodexManagerAttempt[]) => void): Promise<Response> {
  signal.throwIfAborted();
  const directory = process.env.APTLSS_CODEX_QUEUE_DIR;
  if (!directory) throw new Error("Codex subscription bridge is not configured");
  const root = resolve(directory);
  const heartbeat = JSON.parse(await readFile(join(root, "heartbeat.json"), "utf8"));
  if (heartbeat.model !== CODEX_MANAGER_MODEL || heartbeat.route !== CODEX_MANAGER_ROUTE ||
      JSON.stringify(heartbeat.efforts) !== JSON.stringify(CODEX_MANAGER_EFFORTS) ||
      !Number.isFinite(Date.parse(heartbeat.at)) || Math.abs(Date.now() - Date.parse(heartbeat.at)) > 15_000) {
    throw new Error("Codex subscription bridge is offline");
  }
  const id = randomUUID(), inputHash = codexInputHash(input);
  const createdAt = Date.now();
  const request = codexRequestSchema.parse({ version: 2, id, inputHash, input,
    createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + 420_000).toISOString() });
  const requests = join(root, "requests"), replies = join(root, "replies");
  await mkdir(requests, { recursive: true });
  await mkdir(replies, { recursive: true });
  const pending = join(requests, `${id}.pending`), path = join(requests, `${id}.json`), replyPath = join(replies, `${id}.json`);
  try {
    signal.throwIfAborted();
    await writeFile(pending, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    await rename(pending, path);
    while (!signal.aborted && Date.now() < Date.parse(request.expiresAt)) {
      try {
        if ((await stat(replyPath)).size > 200_000) throw new Error("Oversized Codex reply");
        const reply = codexReplySchema.parse(JSON.parse(await readFile(replyPath, "utf8")));
        if (reply.id !== id || reply.inputHash !== inputHash) throw new Error("Codex reply scope mismatch");
        signal.throwIfAborted();
        onAttempts?.(reply.attempts);
        if (reply.status !== "completed") {
          return Response.json({ error: { code: `codex_${reply.status}` } },
            { status: reply.status === "limited" ? 429 : reply.status === "unauthenticated" ? 401 : 503 });
        }
        if (!reply.text) throw new Error("Empty Codex reply");
        return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: reply.text }] }] });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(250, undefined, { signal });
    }
    throw new Error("Codex review timed out");
  } finally {
    // Only this request's temporary transport files; never application history.
    await Promise.all([pending, path, replyPath].map(file => unlink(file).catch(() => {})));
  }
}
