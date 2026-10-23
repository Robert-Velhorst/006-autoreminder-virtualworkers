import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requestManagerCodexReview } from '../server/aptlssManagerCodex';
import { startCodexManagerRunner } from '../server/aptlssManagerCodexRunner';
import { getCodexLlmStatus, invokeCodexLlm } from '../server/_core/codexLlm';
import { startCodexLlmRunner } from '../server/codexLlmRunner';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.APTLSS_CODEX_SHARED_QUEUE, 'true');
globalThis.fetch = async () => { throw new Error('Synthetic transport proof must not use HTTP'); };
const queue = process.env.APTLSS_CODEX_QUEUE_DIR!;
assert(queue);
const stop = new AbortController();
const terminate = () => stop.abort();
process.once('SIGTERM', terminate);
process.once('SIGINT', terminate);

try {
  if (process.argv[2] === 'runner') {
    const managerWork = join(process.cwd(), 'manager-private');
    const llmWork = join(process.cwd(), 'llm-private');
    for (const work of [managerWork, llmWork]) {
      await writeFile(join(work, 'login'), 'console.log("Logged in using ChatGPT");', { flag: 'wx', mode: 0o600 });
      const manager = work === managerWork;
      await writeFile(join(work, 'exec'), `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const envelope = JSON.parse(input);
  const text = ${manager ? `JSON.stringify({ claims: [], actions: [], interventions: [], contextCheck: {
    status: 'adequate', reason: 'none', evidenceIds: [] } })` : `JSON.stringify({
      answer: envelope.conversation.some(message => message.content === 'schema') ? '{"count":2}' : 'Synthetic transport answer',
      review: { status: 'adequate', reason: 'none' } })`};
  console.log(JSON.stringify({ type: 'thread.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }));
});`, { flag: 'wx', mode: 0o600 });
    }
    // NODE_ENV=test permits only this exact Node executable as the synthetic CLI.
    const results = await Promise.allSettled([
      startCodexManagerRunner(queue, managerWork, process.execPath, stop.signal),
      startCodexLlmRunner(join(queue, 'llm-v1'), llmWork, process.execPath, stop.signal),
    ]);
    for (const result of results) if (result.status === 'rejected' && !stop.signal.aborted) throw result.reason;
    assert(stop.signal.aborted, 'Synthetic runners stopped unexpectedly');
  } else {
    assert.equal(process.argv[2], 'client');
    const timeout = AbortSignal.timeout(15_000);
    for (;;) {
      timeout.throwIfAborted();
      if ((await getCodexLlmStatus()).available) {
        try { await readFile(join(queue, 'heartbeat.json')); break; } catch { /* Manager not ready yet. */ }
      }
      await delay(25, undefined, { signal: timeout });
    }
    for (const work of ['manager-private', 'llm-private']) {
      await assert.rejects(readFile(join(work, 'instructions.txt')), { code: 'EACCES' });
    }
    const manager = await requestManagerCodexReview(JSON.stringify({ cards: [] }), timeout);
    assert.equal(manager.status, 200);
    const result = await manager.json();
    assert.deepEqual(JSON.parse(result.output[0].content[0].text), { claims: [], actions: [], interventions: [] });
    const text = await invokeCodexLlm({ messages: [{ role: 'user', content: 'text' }], signal: timeout });
    assert.equal(text.choices[0].message.content, 'Synthetic transport answer');
    const structured = await invokeCodexLlm({ messages: [{ role: 'user', content: 'schema' }], signal: timeout,
      responseFormat: { type: 'json_schema', json_schema: { name: 'count', schema: {
        type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false,
      } } } });
    assert.deepEqual(JSON.parse(structured.choices[0].message.content!), { count: 2 });
    for (const child of ['requests', 'replies', 'llm-v1/requests', 'llm-v1/replies', 'llm-v1/dispatch']) {
      assert.deepEqual(await readdir(join(queue, child)), [], `Transport not cleaned: ${child}`);
    }
    console.log(JSON.stringify({ manager: true, text: true, schema: true, privateDenied: true, transportCleaned: true }));
  }
} finally {
  stop.abort();
  process.removeListener('SIGTERM', terminate);
  process.removeListener('SIGINT', terminate);
}
