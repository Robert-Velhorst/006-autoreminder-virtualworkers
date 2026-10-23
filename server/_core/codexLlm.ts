import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteQueueFile, confinedLocalPath } from '../../shared/local-filesystem-policy.mjs';
import type { InvokeParams, InvokeResult } from './llm';
import { CODEX_LLM_EFFORTS, CODEX_LLM_GRANT_MS, CODEX_LLM_MODEL, CODEX_LLM_PROTOCOL, CODEX_LLM_TTL_MS,
  compileLlmOutput, llmGrantSchema, llmInputHash, llmInputSchema, llmReadySchema, llmReplySchema, llmRequestSchema,
  type CodexLlmInput } from './codexLlmProtocol';

const localPath = (...parts: string[]) => confinedLocalPath(join(...parts));
export function codexLlmQueueRoot() {
  const base = process.env.APTLSS_CODEX_QUEUE_DIR;
  if (!base) throw new Error('Codex subscription bridge is not configured');
  return localPath(base, 'llm-v1');
}
export async function getCodexLlmStatus() {
  let configured = false;
  try {
    const root = codexLlmQueueRoot();
    configured = true;
    if ((await stat(localPath(root,'heartbeat.json'))).size > 2000) throw new Error('Oversized heartbeat');
    const heartbeat = JSON.parse(await readFile(localPath(root,'heartbeat.json'),'utf8'));
    const at = Date.parse(heartbeat.at);
    if (heartbeat.version !== 1 || heartbeat.protocol !== CODEX_LLM_PROTOCOL || heartbeat.model !== CODEX_LLM_MODEL
      || JSON.stringify(heartbeat.efforts) !== JSON.stringify(CODEX_LLM_EFFORTS)
      || !Number.isFinite(at) || Date.now()-at > 15000 || at-Date.now() > 5000) throw new Error('Offline');
    return { configured, available: true, provider: 'codex-subscription' as const, model: CODEX_LLM_MODEL,
      route: CODEX_LLM_PROTOCOL, managedBy: 'local-bridge' as const };
  } catch {
    return { configured, available: false, provider: 'codex-subscription' as const, model: CODEX_LLM_MODEL,
      route: CODEX_LLM_PROTOCOL, managedBy: 'local-bridge' as const };
  }
}

export function normalizeCodexLlmInput(params: InvokeParams): CodexLlmInput {
  if ((params.tools?.length ?? 0) > 0 || [params.toolChoice,params.tool_choice].some(value => value !== undefined && value !== 'none')) {
    throw new Error('Subscription inference does not support tool calls');
  }
  const messages = params.messages.map(message => {
    if (!['system','user','assistant'].includes(message.role) || message.tool_call_id !== undefined) throw new Error('Unsupported conversation role');
    const parts = Array.isArray(message.content) ? message.content : [message.content];
    const content = parts.map(part => {
      if (typeof part === 'string') return part;
      if (part.type !== 'text') throw new Error('Subscription inference does not support image or file inputs');
      return part.text;
    }).join('');
    return { role: message.role, content, ...(message.name === undefined ? {} : { name: message.name }) };
  });
  const format = params.responseFormat ?? params.response_format;
  const schema = params.outputSchema ?? params.output_schema;
  const selected = format ?? (schema ? { type: 'json_schema' as const, json_schema: schema } : { type: 'text' as const });
  const input = llmInputSchema.parse({ messages,maxTokens: params.maxTokens ?? params.max_tokens ?? 4096,
    format: selected.type === 'json_schema' ? { type: selected.type,schema: selected.json_schema.schema } : { type: selected.type } });
  if (Buffer.byteLength(JSON.stringify(input)) > 180_000) throw new Error('Subscription inference input is too large');
  compileLlmOutput(input);
  return input;
}

export async function invokeCodexLlm(params: InvokeParams): Promise<InvokeResult> {
  params.signal?.throwIfAborted();
  const input = normalizeCodexLlmInput(params), validate = compileLlmOutput(input);
  const root = codexLlmQueueRoot();
  const timeout = AbortSignal.timeout(CODEX_LLM_TTL_MS);
  const signal = params.signal ? AbortSignal.any([params.signal,timeout]) : timeout;
  const id = randomUUID(), inputHash = llmInputHash(input), createdAt = Date.now();
  const request = llmRequestSchema.parse({ version: 1,id,inputHash,input,createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt+CODEX_LLM_TTL_MS).toISOString() });
  const paths = { request: localPath(root,'requests',`${id}.json`), claimed: localPath(root,'requests',`${id}.running`),
    reply: localPath(root,'replies',`${id}.json`) };
  const dispatchPaths = CODEX_LLM_EFFORTS.map((_,attempt) => ({
    ready: localPath(root,'dispatch',`${id}.${attempt}.ready`),
    grant: localPath(root,'dispatch',`${id}.${attempt}.grant`),
  }));
  let nextAttempt = 0;
  try {
    if (!(await getCodexLlmStatus()).available) throw new Error('Codex subscription bridge is offline');
    for (const child of ['requests','replies','dispatch']) await mkdir(localPath(root,child),{ recursive: true });
    signal.throwIfAborted();
    await params.beforeDispatch?.();
    signal.throwIfAborted();
    await atomicWriteQueueFile(paths.request,JSON.stringify(request));
    while (true) {
      signal.throwIfAborted();
      try {
        if ((await stat(confinedLocalPath(paths.reply))).size > 200_000) throw new Error('Oversized subscription reply');
        const reply = llmReplySchema.parse(JSON.parse(await readFile(confinedLocalPath(paths.reply),'utf8')));
        if (reply.id !== id || reply.inputHash !== inputHash) throw new Error('Subscription reply identity mismatch');
        signal.throwIfAborted();
        if (reply.status !== 'completed') throw new Error(`Codex subscription inference ${reply.status}; no API fallback`);
        if (reply.attempts.length !== nextAttempt || !reply.text || !validate(reply.text)
          || reply.attempts.some(attempt => !attempt.usage || attempt.usage.output_tokens > input.maxTokens)) {
          throw new Error('Invalid subscription completion');
        }
        await params.beforeDispatch?.();
        signal.throwIfAborted();
        const prompt_tokens = reply.attempts.reduce((sum,item) => sum+item.usage!.input_tokens,0);
        const completion_tokens = reply.attempts.reduce((sum,item) => sum+item.usage!.output_tokens,0);
        if (!Number.isSafeInteger(prompt_tokens+completion_tokens)) throw new Error('Invalid subscription usage');
        return { id,created: Math.floor(createdAt/1000),model: CODEX_LLM_MODEL,
          choices: [{ index: 0,message: { role: 'assistant',content: reply.text },finish_reason: 'stop' }],
          usage: { prompt_tokens,completion_tokens,total_tokens: prompt_tokens+completion_tokens } };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (nextAttempt < CODEX_LLM_EFFORTS.length) {
        const dispatch = dispatchPaths[nextAttempt];
        try {
          if ((await stat(confinedLocalPath(dispatch.ready))).size > 2000) throw new Error('Invalid dispatch request');
          const ready = llmReadySchema.parse(JSON.parse(await readFile(confinedLocalPath(dispatch.ready),'utf8')));
          if (ready.id !== id || ready.inputHash !== inputHash || ready.attempt !== nextAttempt
            || ready.effort !== CODEX_LLM_EFFORTS[nextAttempt]) throw new Error('Dispatch identity mismatch');
          signal.throwIfAborted();
          await params.beforeDispatch?.();
          signal.throwIfAborted();
          const grant = llmGrantSchema.parse({ ...ready,expiresAt: new Date(Math.min(Date.now()+CODEX_LLM_GRANT_MS,Date.parse(request.expiresAt))).toISOString() });
          await atomicWriteQueueFile(dispatch.grant,JSON.stringify(grant));
          nextAttempt++;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await delay(50,undefined,{ signal });
    }
  } finally {
    await Promise.all([...Object.values(paths),...dispatchPaths.flatMap(pair => Object.values(pair))]
      .map(async path => { try { await unlink(confinedLocalPath(path)); } catch { /* Only this transport's files. */ } }));
  }
}
