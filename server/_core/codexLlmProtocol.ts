import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { z } from 'zod';

export const CODEX_LLM_MODEL = 'gpt-5.6-luna';
export const CODEX_LLM_PROTOCOL = 'generic-luna-v1';
export const CODEX_LLM_EFFORTS = ['low', 'medium', 'high'] as const;
export const CODEX_LLM_TTL_MS = 420_000;
export const CODEX_LLM_GRANT_MS = 2000;
const count = z.number().int().nonnegative().safe();
const token = z.string().regex(/^[a-f0-9]{64}$/);
export const llmInputSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string(), name: z.string().optional() }).strict()).min(1).max(1000),
  maxTokens: z.number().int().positive().safe(),
  format: z.discriminatedUnion('type', [z.object({ type: z.literal('text') }).strict(),
    z.object({ type: z.literal('json_object') }).strict(),
    z.object({ type: z.literal('json_schema'), schema: z.record(z.string(), z.unknown()) }).strict()]),
}).strict();
export type CodexLlmInput = z.infer<typeof llmInputSchema>;
export const llmRequestSchema = z.object({ version: z.literal(1), id: z.string().uuid(), inputHash: token,
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), input: llmInputSchema }).strict();
export type CodexLlmRequest = z.infer<typeof llmRequestSchema>;
export const llmUsageSchema = z.object({ input_tokens: count, output_tokens: count }).strict();
export const llmAttemptSchema = z.object({ effort: z.enum(CODEX_LLM_EFFORTS),
  outcome: z.enum(['accepted', 'needs_reasoning', 'invalid_output', 'output_limit', 'unavailable', 'limited', 'unauthenticated', 'rejected']),
  durationMs: count, usage: llmUsageSchema.optional() }).strict();
export type CodexLlmAttempt = z.infer<typeof llmAttemptSchema>;
export const llmReplySchema = z.object({ version: z.literal(1), protocol: z.literal(CODEX_LLM_PROTOCOL),
  id: z.string().uuid(), inputHash: token, model: z.literal(CODEX_LLM_MODEL),
  status: z.enum(['completed', 'unavailable', 'limited', 'unauthenticated', 'rejected', 'uncertain', 'output_limit']),
  attempts: z.array(llmAttemptSchema).max(3), text: z.string().max(150_000).optional(),
}).strict().superRefine((reply, ctx) => {
  const last = reply.attempts.at(-1);
  if (!reply.attempts.every((attempt, index) => attempt.effort === CODEX_LLM_EFFORTS[index]
    && (index === reply.attempts.length - 1 || ['needs_reasoning', 'invalid_output'].includes(attempt.outcome)))
    || (reply.status === 'completed' && (!last || last.outcome !== 'accepted' || !reply.text?.trim()))
    || (reply.status !== 'completed' && reply.text !== undefined)) ctx.addIssue({ code: 'custom', message: 'Invalid attempt history' });
});
export const llmReadySchema = z.object({ version: z.literal(1), id: z.string().uuid(), inputHash: token,
  attempt: z.number().int().min(0).max(2), effort: z.enum(CODEX_LLM_EFFORTS), nonce: token }).strict();
export const llmGrantSchema = llmReadySchema.extend({ expiresAt: z.string().datetime() }).strict();
export const llmOutputSchema = z.object({ answer: z.string().min(1).max(150_000),
  review: z.object({ status: z.enum(['adequate', 'needs_more_reasoning', 'missing_evidence']),
    reason: z.enum(['none', 'ambiguity', 'chronology', 'cross_source_context', 'missing_evidence']) }).strict(),
}).strict().superRefine(({ review },ctx) => {
  if ((review.status === 'adequate' && review.reason !== 'none')
    || (review.status === 'missing_evidence' && review.reason !== 'missing_evidence')
    || (review.status === 'needs_more_reasoning' && !['ambiguity','chronology','cross_source_context'].includes(review.reason))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid review reason' });
  }
});
// CLI schema excludes refinements; the runner and application validate them locally.
export const CODEX_LLM_OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['answer','review'], properties: {
  answer: { type: 'string' }, review: { type: 'object', additionalProperties: false, required: ['status','reason'], properties: {
    status: { type: 'string', enum: ['adequate','needs_more_reasoning','missing_evidence'] },
    reason: { type: 'string', enum: ['none','ambiguity','chronology','cross_source_context','missing_evidence'] },
  } },
} };
export function llmInputHash(input: CodexLlmInput) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }

export function compileLlmOutput(input: CodexLlmInput): (text: string) => boolean {
  let validate: ReturnType<Ajv['compile']> | undefined;
  if (input.format.type === 'json_schema') {
    const schema = structuredClone(input.format.schema);
    if (Buffer.byteLength(JSON.stringify(schema)) > 64_000) throw new Error('Unsupported output schema');
    let nodes = 0;
    const inspect = (value: unknown, depth = 0) => {
      if (++nodes > 10000 || depth > 64) throw new Error('Unsupported output schema');
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const child of value) inspect(child,depth+1); return; }
      for (const [key, child] of Object.entries(value)) {
        if (key === '$async' || key === '$id' || key === '__proto__' || key === 'constructor' || key === 'prototype'
          || (['$ref','$dynamicRef','$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#')))) {
          throw new Error('Unsupported output schema');
        }
        inspect(child,depth+1);
      }
    };
    inspect(schema);
    // Synchronous local compilation only: no loadSchema, remote refs, coercion or defaults.
    validate = new Ajv({ strict: true, strictTypes: false, allErrors: false,
      coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(schema);
  }
  return text => {
    if (!text.trim() || Buffer.byteLength(text) > 150_000) return false;
    if (input.format.type === 'text') return true;
    try {
      const value: unknown = JSON.parse(text);
      return input.format.type === 'json_object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : validate!(value) === true;
    } catch { return false; }
  };
}
