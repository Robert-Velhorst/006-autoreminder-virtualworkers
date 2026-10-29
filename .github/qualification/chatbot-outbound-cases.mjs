import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY, 'Robert-Velhorst/006-autoreminder-virtualworkers');
assert.equal(process.version, 'v26.13.0');
const { fetchWithRetry } = await import('../../server/utils/retry.ts');
const output = path.join(process.env.RUNNER_TEMP, 'va-chatbot-outbound-boundary');
const source = fs.readFileSync('server/services/chatbot-extractor.ts', 'utf8');
const start = source.indexOf('export class ChatbotExtractorService {');
const end = source.indexOf('  /**\n   * Extract conversation from ChatGPT share link', start);
assert(start >= 0 && end > start);
const detectorSource = source.slice(start, end) + '}\n';
const detectorPath = path.join(output, 'exact-detector-prefix.mts');
fs.writeFileSync(detectorPath, detectorSource);
const { ChatbotExtractorService } = await import(pathToFileURL(detectorPath).href);
const detector = new ChatbotExtractorService();
const actualFetch = globalThis.fetch;
const cases = [];
const observations = [];
const noWait = { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 };

async function run(name, body) {
  try { await body(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error.message }); }
  finally { globalThis.fetch = actualFetch; }
}

function dispatch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    assert.equal(init.redirect, 'manual');
    const response = responses[calls.length - 1];
    assert(response, 'Unexpected additional dispatch');
    return response;
  };
  return calls;
}

const ok = () => new Response('ok', { status: 200 });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
const forms = [
  ['chatgpt', 'https://chat.openai.com/share/abc-123'],
  ['chatgpt', 'https://chatgpt.com/share/abc-123'],
  ['gemini', 'https://g.co/gemini/share/abc-123'],
  ['gemini', 'https://gemini.google.com/share/abc-123'],
  ['claude', 'https://claude.ai/share/abc-123'],
];
for (const [platform, url] of forms) {
  await run('mine-prose-' + platform + '-' + new URL(url).hostname, async () => {
    const matches = detector.detectUrls('Before ' + url + ' after');
    assert.equal(matches.length, 1); assert.equal(matches[0].url, url); assert.equal(matches[0].platform, platform);
    const calls = dispatch([ok()]);
    assert.equal((await fetchWithRetry(matches[0].url, undefined, noWait)).status, 200);
    assert.equal(calls.length, 1); assert.equal(calls[0].url.href, url);
  });
}
await run('mine-multiple-providers-without-surrounding-input', async () => {
  const matches = detector.detectUrls(forms.map(([, url]) => url).join(' between '));
  assert.equal(matches.length, forms.length);
  assert.equal(new Set(matches.map(row => row.url)).size, forms.length);
});
for (const suffix of ['/?tracking=kept', '_part?tracking=kept#discarded', '?q=hello%20world', '?token=fixture-only']) {
  await run('direct-compatible-form-' + suffix, async () => {
    const url = 'https://CHATGPT.COM:443/share/abc' + suffix;
    const calls = dispatch([ok()]);
    await fetchWithRetry(url, undefined, noWait);
    const wanted = new URL(url); wanted.hash = '';
    assert.equal(calls[0].url.href, wanted.href); assert.equal(calls.length, 1);
  });
}
const bad = [
  'https://attacker.invalid/https://chatgpt.com/share/abc',
  'https://attacker.invalid/#https://chatgpt.com/share/abc',
  'https://chatgpt.com@attacker.invalid/share/abc',
  'https://user:password@chatgpt.com/share/abc',
  'https://chatgpt.com.attacker.invalid/share/abc',
  'https://sub.chatgpt.com/share/abc',
  'https://127.0.0.1/share/abc', 'http://127.0.0.1/share/abc',
  'https://169.254.169.254/latest/meta-data', 'https://[::1]/share/abc',
  'https://192.168.1.1/share/abc', 'file:///etc/passwd', 'data:text/plain,share',
  'http://chatgpt.com/share/abc', 'https://chatgpt.com:444/share/abc',
  'https://chatgpt.com/other/abc', 'https://chatgpt.com/share/a/b',
  'https://chatgpt.com/share/a%2Fb', 'https://chatgpt.com/share/a%0Ab',
  'https://g.co/share/abc', 'https://gemini.google.com/gemini/share/abc',
];
for (const [i, url] of bad.entries()) {
  await run('reject-before-dispatch-' + i, async () => {
    const calls = dispatch([]);
    await assert.rejects(fetchWithRetry(url, undefined, noWait));
    assert.equal(calls.length, 0);
  });
}
for (const wrapper of ['https://attacker.invalid/path/{}', 'https://attacker.invalid/#{}']) {
  await run('mined-nested-text-dispatches-only-inner-provider-' + wrapper.includes('#'), async () => {
    const matches = detector.detectUrls(wrapper.replace('{}', forms[1][1]));
    assert.equal(matches.length, 1); assert.equal(matches[0].url, forms[1][1]);
    const calls = dispatch([ok()]);
    await fetchWithRetry(matches[0].url, undefined, noWait);
    assert.equal(calls[0].url.origin, 'https://chatgpt.com'); assert.equal(calls.length, 1);
  });
}
for (const status of [301, 302, 303, 307, 308]) {
  for (const destination of ['https://attacker.invalid/share/abc', 'http://127.0.0.1/admin',
    '//169.254.169.254/latest/meta-data', 'https://claude.ai/share/abc', '/other/path']) {
    await run('reject-redirect-' + status + '-' + destination, async () => {
      const calls = dispatch([redirect(destination, status)]);
      await assert.rejects(fetchWithRetry(forms[1][1], undefined, noWait));
      assert.equal(calls.length, 1); assert.equal(calls[0].url.origin, 'https://chatgpt.com');
    });
  }
}
for (const destination of ['/share/next', '//chatgpt.com/share/next', 'https://chatgpt.com/share/next']) {
  await run('same-provider-redirect-' + destination, async () => {
    const calls = dispatch([redirect(destination), ok()]);
    await fetchWithRetry(forms[1][1], undefined, noWait);
    assert.equal(calls.length, 2); assert.equal(calls[1].url.href, 'https://chatgpt.com/share/next');
  });
}
for (const [from, to] of [[forms[0][1], forms[1][1]], [forms[2][1], forms[3][1]]]) {
  await run('approved-provider-transition-' + new URL(from).hostname, async () => {
    const calls = dispatch([redirect(to), ok()]);
    await fetchWithRetry(from, undefined, noWait);
    assert.equal(calls.length, 2); assert.equal(calls[1].url.href, to);
  });
}
await run('cross-origin-read-keeps-safe-headers-and-strips-credentials', async () => {
  const calls = dispatch([redirect('https://gemini.google.com/share/next?token=fixture-only&copy=fixture-only&safe=yes'), ok()]);
  await fetchWithRetry(forms[2][1] + '?token=fixture-only', {
    headers: { authorization: 'fixture-only', cookie: 'fixture-only', 'x-private': 'fixture-only', accept: 'text/html' }
  }, noWait);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.search, '?safe=yes');
  const headers = new Headers(calls[1].init.headers);
  assert.equal(headers.get('accept'), 'text/html');
  for (const name of ['authorization', 'cookie', 'x-private']) assert.equal(headers.has(name), false);
});
for (const init of [{ method: 'POST', body: 'fixture-only' }, { method: 'GET', body: 'fixture-only' }, { method: 'DELETE' }]) {
  await run('cross-origin-mutation-rejected-' + init.method + '-' + Boolean(init.body), async () => {
    const calls = dispatch([redirect(forms[3][1])]);
    await assert.rejects(fetchWithRetry(forms[2][1], init, noWait));
    assert.equal(calls.length, 1);
  });
}
await run('cross-origin-path-credential-reflection-rejected', async () => {
  const calls = dispatch([redirect('https://gemini.google.com/share/fixture-only')]);
  await assert.rejects(fetchWithRetry(forms[2][1] + '?token=fixture-only', undefined, noWait));
  assert.equal(calls.length, 1);
});
await run('five-redirects-then-success', async () => {
  const calls = dispatch([...Array.from({ length: 5 }, (_, i) => redirect('/share/hop-' + i)), ok()]);
  assert.equal((await fetchWithRetry(forms[1][1], undefined, noWait)).status, 200);
  assert.equal(calls.length, 6);
});
await run('redirect-limit-fails-closed-without-retry', async () => {
  const calls = dispatch(Array.from({ length: 6 }, (_, i) => redirect('/share/hop-' + i)));
  await assert.rejects(fetchWithRetry(forms[1][1], undefined, noWait), /redirect limit/);
  assert.equal(calls.length, 6);
});
await run('malformed-redirect-only-retries-safe-source', async () => {
  const calls = dispatch(Array.from({ length: 3 }, () => redirect('http://[')));
  await assert.rejects(fetchWithRetry(forms[1][1], undefined, noWait));
  assert.equal(calls.length, 3); assert(calls.every(row => row.url.href === forms[1][1]));
});
await run('retry-then-unsafe-redirect-stops-before-destination', async () => {
  const calls = dispatch([new Response('retryable', { status: 500 }), redirect('https://attacker.invalid/share/abc')]);
  await assert.rejects(fetchWithRetry(forms[1][1], undefined, noWait));
  assert.equal(calls.length, 2); assert(calls.every(row => row.url.href === forms[1][1]));
  observations.push({ case: 'retry-then-unsafe-redirect', approved_source_dispatches: 2, unsafe_destination_dispatches: 0 });
});
await run('caller-abort-signal-preserved', async () => {
  const controller = new AbortController();
  const calls = dispatch([ok()]);
  await fetchWithRetry(forms[1][1], { signal: controller.signal }, noWait);
  assert.equal(calls[0].init.signal, controller.signal);
});

globalThis.fetch = actualFetch;
const result = { actual_Node: process.version, cases, passed: cases.filter(row => row.passed).length,
  failed: cases.filter(row => !row.passed).length, skipped: 0, observations,
  production_source_modified: false, full_original_Vitest_or_application_suite_executed: false,
  scope: 'Exact complete retry.ts and exact detector class prefix imported with native TypeScript file support; temporary .mts excerpt preserves all original detector method bytes; fetch dispatcher intercepted, no provider/network/database/operator data access.',
  all_original_case_helpers_assertions_commands_unchanged: true, vulnerability_or_CodeQL_closure_claim: false };
fs.writeFileSync(path.join(output, 'case-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, failed: result.failed, skipped: result.skipped }));
assert.equal(result.failed, 0);
