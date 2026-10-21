import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, open, readFile, readdir, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLLMModelStatus, invokeLLM } from './_core/llm';
import { normalizeCodexLlmInput } from './_core/codexLlm';
import { compileLlmOutput, llmInputHash, llmReplySchema, CODEX_LLM_MODEL, CODEX_LLM_PROTOCOL } from './_core/codexLlmProtocol';
import { startCodexLlmRunner } from './codexLlmRunner';
import { codexLlmFixture } from './test/codexLlmFixture';
import { ScheduledJobLeaseLostError } from './scheduledJobRuntime';

const fixtures: Array<Awaited<ReturnType<typeof codexLlmFixture>>> = [];
async function fixture(plan: Parameters<typeof codexLlmFixture>[0] = {}) { const f = await codexLlmFixture(plan); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const messages = [{ role: 'user' as const,content: 'Fixture task question' }];

describe('canonical Codex subscription inference', () => {
  it('preserves ordered text conversation and returns only real validated CLI output and usage without API requests', async () => {
    const f = await fixture({ turns: [{ answer: 'The actual synthetic answer' }] });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch',fetchMock); vi.stubEnv('OPENAI_API_KEY','must-not-be-used');
    const result = await invokeLLM({ messages: [{ role: 'system',content: 'App instructions' },
      { role: 'user',content: [{ type: 'text',text: 'Part A' },{ type: 'text',text: ' and B' }] },
      { role: 'assistant',content: 'Prior answer' },...messages],maxTokens: 4000 });
    expect(result).toMatchObject({ model: 'gpt-5.6-luna', choices: [{ message: { role: 'assistant',content: 'The actual synthetic answer' } }],
      usage: { prompt_tokens: 100,completion_tokens: 50,total_tokens: 150 } });
    const calls = await f.calls(); expect(calls).toHaveLength(1);
    expect(calls[0].effort).toBe('model_reasoning_effort="low"');
    expect(calls[0].input.conversation.map((message: any) => message.content)).toEqual(['App instructions','Part A and B','Prior answer','Fixture task question']);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const child of ['requests','replies','dispatch']) expect(await readdir(join(f.root,child))).toEqual([]);
  });

  it.each(['responseFormat','response_format','outputSchema','output_schema'])('preserves structured output via %s with local schema validation', async field => {
    const f = await fixture({ turns: [{ answer: '{"count":2}' }] });
    const schema = { name: 'count',schema: { type: 'object',properties: { count: { type: 'integer' } },required: ['count'],additionalProperties: false } };
    const params = field.startsWith('response') ? { [field]: { type: 'json_schema',json_schema: schema } } : { [field]: schema };
    expect((await invokeLLM({ messages,...params })).choices[0].message.content).toBe('{"count":2}');
    expect(await f.calls()).toHaveLength(1);
  });

  it('requires fresh ownership on each low, medium and high attempt and sums their real usage', async () => {
    const f = await fixture({ turns: [
      { answer: 'First',review: 'needs_more_reasoning' },{ answer: 'Second',review: 'needs_more_reasoning',reason: 'chronology' },{ answer: 'Final' },
    ] });
    const guard = vi.fn(async () => {});
    expect((await invokeLLM({ messages,beforeDispatch: guard })).usage).toEqual({ prompt_tokens: 300,completion_tokens: 150,total_tokens: 450 });
    expect((await f.calls()).map(call => call.effort)).toEqual(['low','medium','high'].map(effort => `model_reasoning_effort="${effort}"`));
    expect(guard).toHaveBeenCalledTimes(5); // enqueue, three fresh grants, accepting the result
  });

  it.each([true,false])('keeps earlier ready/grant files immutable with held readers across three real attempts (valid high=%s)', async validHigh => {
    const f = await fixture({ turns: [{ answer: '{"count":"bad"}' },{ answer: '{"count":"still bad"}' },
      { answer: validHigh ? '{"count":3}' : '{"count":"invalid high"}',hold: true }] });
    const held: Array<{ handle: FileHandle; path: string; contents: string }> = [];
    const snapshots = new Map<string,string>();
    let checks = 0, requestId: string | undefined;
    const assertUnchanged = async () => {
      for (const item of held) {
        expect(await readFile(item.path,'utf8')).toBe(item.contents);
        const buffer = Buffer.alloc(Buffer.byteLength(item.contents));
        const { bytesRead } = await item.handle.read(buffer,0,buffer.length,0);
        expect(buffer.subarray(0,bytesRead).toString()).toBe(item.contents);
      }
    };
    const guard = vi.fn(async () => {
      checks++;
      await assertUnchanged();
      if (checks >= 2 && checks <= 4) {
        const attempt = checks-2;
        const files = await readdir(join(f.root,'dispatch'));
        const readyFile = files.find(name => name.endsWith(`.${attempt}.ready`));
        expect(readyFile).toBeDefined();
        const ready = JSON.parse(await readFile(join(f.root,'dispatch',readyFile!),'utf8'));
        requestId ??= ready.id;
        expect(ready).toMatchObject({ id: requestId,attempt,effort: ['low','medium','high'][attempt] });
        for (let prior=0;prior<attempt;prior++) for (const kind of ['ready','grant']) {
          const path = join(f.root,'dispatch',`${requestId}.${prior}.${kind}`);
          if (snapshots.has(path)) continue;
          const handle = await open(path,'r');
          const contents = await readFile(path,'utf8');
          snapshots.set(path,contents); held.push({ handle,path,contents });
        }
      }
    });
    try {
      const pending = invokeLLM({ messages,beforeDispatch: guard,
        outputSchema: { name: 'count',schema: { type: 'object',required: ['count'],properties: { count: { type: 'integer' } } } } });
      const outcome = pending.then(result => ({ result,error: null }),error => ({ result: null,error }));
      // The actual high child starts only after its grant is consumed, with earlier readers still open.
      await vi.waitFor(async () => expect(await f.calls()).toHaveLength(3),{ timeout: 5000 });
      await assertUnchanged();
      for (const item of held.splice(0)) await item.handle.close();
      await f.release('allow-turn');
      const settled = await outcome;
      if (validHigh) {
        expect(settled.error).toBeNull();
        expect(settled.result!.choices[0].message.content).toBe('{"count":3}');
      } else expect(settled.error).toMatchObject({ message: expect.stringContaining('inference rejected') });
      expect((await f.calls()).map(call => call.effort)).toEqual(['low','medium','high'].map(effort => `model_reasoning_effort="${effort}"`));
      expect(checks).toBe(validHigh ? 5 : 4); expect(snapshots.size).toBe(4);
      for (const path of snapshots.keys()) expect(path).not.toMatch(/\.[3-9]\.(ready|grant)$/);
    } finally { for (const item of held) await item.handle.close(); }
    await vi.waitFor(async () => expect(await readdir(join(f.root,'dispatch'))).toEqual([]));
  });

  it('does not grant a higher attempt after ownership changes', async () => {
    const f = await fixture({ turns: [{ answer: 'First',review: 'needs_more_reasoning' }] });
    const lost = new ScheduledJobLeaseLostError(); let checks = 0;
    await expect(invokeLLM({ messages,beforeDispatch: async () => { if (++checks === 3) throw lost; } })).rejects.toBe(lost);
    expect(await f.calls()).toHaveLength(1);
  });

  it('does not infer missing evidence can be fixed by more reasoning', async () => {
    const f = await fixture({ turns: [{ answer: 'The source is missing.',review: 'missing_evidence' }] });
    expect((await invokeLLM({ messages })).choices[0].message.content).toBe('The source is missing.');
    expect(await f.calls()).toHaveLength(1);
  });

  it('does not escalate missing evidence merely because a required structured answer cannot be produced', async () => {
    const f = await fixture({ turns: [{ answer: 'The source is missing.', review: 'missing_evidence' }] });
    await expect(invokeLLM({ messages, responseFormat: { type: 'json_object' } })).rejects.toThrow(/inference rejected/);
    expect(await f.calls()).toHaveLength(1);
  });

  it('rejects schema-invalid JSON without coercion then validates the next attempt', async () => {
    const f = await fixture({ turns: [{ answer: '{"count":"2"}' },{ answer: '{"count":2}' }] });
    const schema = { type: 'object',required: ['count'],properties: { count: { type: 'integer' } } };
    expect((await invokeLLM({ messages,outputSchema: { name: 'count',schema } })).choices[0].message.content).toBe('{"count":2}');
    expect(await f.calls()).toHaveLength(2);
  });

  it('rejects unvalidated high output without a fourth attempt or fabricated completion', async () => {
    const f = await fixture({ turns: Array.from({ length: 3 },() => ({ answer: 'not JSON' })) });
    await expect(invokeLLM({ messages,responseFormat: { type: 'json_object' } })).rejects.toThrow('rejected');
    expect(await f.calls()).toHaveLength(3);
  });

  it.each(['usage limit reached','authentication required','provider offline'])('never retries or falls back after %s', async failure => {
    const f = await fixture({ turns: [{ failure }] });
    vi.stubEnv('OPENAI_API_KEY','must-not-be-used'); const fetchMock = vi.fn(); vi.stubGlobal('fetch',fetchMock);
    await expect(invokeLLM({ messages })).rejects.toThrow(/limited|unauthenticated|unavailable/);
    expect(await f.calls()).toHaveLength(1); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-subscription login before any completion', async () => {
    const f = await fixture({ noSubscription: true });
    await expect(invokeLLM({ messages })).rejects.toThrow('unauthenticated');
    expect(await f.calls()).toEqual([]);
  });

  it('rejects tool activity even when the final text looks correct', async () => {
    const f = await fixture({ turns: [{ tool: true }] });
    await expect(invokeLLM({ messages })).rejects.toThrow('rejected'); expect(await f.calls()).toHaveLength(1);
  });

  it('applies the requested budget to actual reported turn output after generation, not character estimates', async () => {
    const f = await fixture({ turns: [{ answer: 'x',usage: { input_tokens: 2,output_tokens: 4001 } }] });
    await expect(invokeLLM({ messages,maxTokens: 4000 })).rejects.toThrow('output_limit');
    expect(await f.calls()).toHaveLength(1);
    expect((await f.calls())[0].input.requestedMaxTokens).toBe(4000);
  });

  it('uses no daily cap: independent valid requests each start at low', async () => {
    const f = await fixture();
    for (let i=0;i<4;i++) await invokeLLM({ messages });
    expect((await f.calls()).map(call => call.effort)).toEqual(Array(4).fill('model_reasoning_effort="low"'));
  });

  it('does not replay an abandoned claimed request after worker restart', async () => {
    const f = await fixture();
    const input = normalizeCodexLlmInput({ messages }), id = randomUUID();
    await writeFile(join(f.root,'requests',`${id}.running`),JSON.stringify({ version: 1,id,inputHash: llmInputHash(input),input,
      createdAt: new Date().toISOString(),expiresAt: new Date(Date.now()+60000).toISOString() }));
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(f.root,'replies',`${id}.json`),'utf8')).status).toBe('uncertain'));
    expect(await f.calls()).toEqual([]);
  });

  it('refuses an existing runner lock without stealing it', async () => {
    const f = await fixture();
    await expect(startCodexLlmRunner(f.root,f.work,process.execPath,new AbortController().signal)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(f.work,'runner.lock'),'utf8')).toBe(String(process.pid));
  });

  it('reports subscription model configuration separately from worker availability', async () => {
    vi.stubEnv('APTLSS_CODEX_QUEUE_DIR','');
    expect(await getLLMModelStatus()).toMatchObject({ configured: false,available: false,provider: 'codex-subscription',model: 'gpt-5.6-luna' });
    const f = await fixture(); expect(await getLLMModelStatus()).toMatchObject({ configured: true,available: true });
    expect(f.root).toContain('llm-v1');
  });

  it('bounds heartbeat input and rejects stale, mismatched or oversized worker status', async () => {
    const f = await fixture();
    const heartbeat = JSON.parse(await readFile(join(f.root,'heartbeat.json'),'utf8'));
    for (const value of [{ ...heartbeat,at: new Date(Date.now()-60000).toISOString() },{ ...heartbeat,model: 'other' },{ ...heartbeat,padding: 'x'.repeat(2001) }]) {
      await writeFile(join(f.root,'heartbeat.json'),JSON.stringify(value));
      expect(await getLLMModelStatus()).toMatchObject({ configured: true,available: false });
    }
  });

  it('prevents two private execution directories from consuming the same queue', async () => {
    const f = await fixture(); const other = join(f.work,'other');
    await expect(startCodexLlmRunner(f.root,other,process.execPath,new AbortController().signal)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await getLLMModelStatus()).toMatchObject({ available: true });
  });

  it('rejects a dispatch-directory junction before publishing outside the private queue', async () => {
    const f = await fixture(); const outside = join(f.work,'outside');
    await mkdir(outside); await rm(join(f.root,'dispatch'),{ recursive: true });
    await symlink(outside,join(f.root,'dispatch'),process.platform === 'win32' ? 'junction' : 'dir');
    await expect(invokeLLM({ messages })).rejects.toThrow(/symbolic links/);
    expect(await readdir(outside)).toEqual([]); expect(await f.calls()).toEqual([]);
  });
});

describe('subscription inference input safety', () => {
  it.each([{ tools: [{ type: 'function',function: { name: 'run' } }] },{ tool_choice: 'auto' },
    { messages: [{ role: 'tool',content: 'result' }] },{ messages: [{ role: 'user',content: [{ type: 'image_url',image_url: { url: 'https://example.invalid/' } }] }] },
    { messages: [{ role: 'user',content: [{ type: 'file_url',file_url: { url: 'file:///private' } }] }] }])('rejects unsupported input before transport %#', async input => {
    await expect(invokeLLM({ messages,...input } as any)).rejects.toThrow(/support|role/);
  });
  it.each([{ $ref: 'https://example.invalid/schema' },{ $async: true,type: 'object' },{ $id: 'https://example.invalid/',type: 'object' }])('rejects remote or async schemas %# without network', schema => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch',fetchMock);
    expect(() => normalizeCodexLlmInput({ messages,outputSchema: { name: 'unsafe',schema } })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not mutate caller schemas or coerce/default their values', () => {
    const schema = { type: 'object',required: ['n'],properties: { n: { type: 'integer',default: 2 } },additionalProperties: false };
    const original = structuredClone(schema);
    const validate = compileLlmOutput(normalizeCodexLlmInput({ messages,outputSchema: { name: 'test',schema } }));
    expect(validate('{}')).toBe(false); expect(validate('{"n":"2"}')).toBe(false);
    expect(validate('{"n":2,"extra":1}')).toBe(false); expect(schema).toEqual(original);
  });
  it('rejects fabricated or out-of-order attempt history', () => {
    expect(() => llmReplySchema.parse({ version: 1,protocol: CODEX_LLM_PROTOCOL,id: randomUUID(),inputHash: 'a'.repeat(64),model: CODEX_LLM_MODEL,
      status: 'completed',text: 'Fake',attempts: [{ effort: 'high',outcome: 'accepted',durationMs: 0 }] })).toThrow();
  });
});
