import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatbotExtractorService } from './chatbot-extractor';
import { fetchWithRetry } from '../utils/retry';

vi.mock('../db', () => ({ getDb: vi.fn() }));
vi.mock('../utils/retry', () => ({ fetchWithRetry: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

async function extract(html: string, platform: 'chatgpt' | 'gemini' | 'claude' = 'claude') {
  vi.mocked(fetchWithRetry).mockResolvedValue(new Response(html));
  return new ChatbotExtractorService().extractConversation('https://example.invalid/share/fixture', platform);
}

describe('chatbot HTML text extraction', () => {
  it.each(['chatgpt', 'gemini', 'claude'] as const)('excludes malformed script/style content in %s HTML fallback', async platform => {
    const result = await extract('<html><head><title>Review</title></head><body>' +
      '<p title="1 > 0">Alice &amp; Bob</p>' +
      '<ScRiPt data-test="x > y">privateScript()</sCrIpT >' +
      '<StYlE>.privateStyle { display: none }</sTyLe >' +
      '<!-- privateComment --><p><a href="https://tracker.invalid">Read the report</a><br>Then respond.</p>' +
      '</body></html>', platform);

    expect(result.success).toBe(true);
    expect(result.conversation?.platform).toBe(platform);
    expect(result.conversation?.messages).toEqual([{
      role: 'assistant',
      content: 'Alice & Bob Read the report Then respond.',
    }]);
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it.each(['script', 'style'])('does not leak an unterminated %s body into evidence', async tag => {
    const result = await extract(`<p>Visible work</p><${tag}>privateUnterminatedContent`);
    expect(result.conversation?.messages).toEqual([{ role: 'assistant', content: 'Visible work' }]);
  });

  it('decodes entities once and retains literal comparison text', async () => {
    const result = await extract('<p>Keep &amp;lt;script&amp;gt; as text. 2 &lt; 3 &amp; 5 &gt; 4. &#39;Ready&#39;</p>');
    expect(result.conversation?.messages[0].content).toBe("Keep &lt;script&gt; as text. 2 < 3 & 5 > 4. 'Ready'");
  });

  it('retains the 10,000-character evidence limit', async () => {
    const result = await extract(`<p>${'a'.repeat(10_050)}</p>`);
    expect(result.conversation?.messages[0].content).toBe('a'.repeat(10_000));
  });

  it('does not manufacture a message for script/style-only HTML', async () => {
    const result = await extract('<script>privateScript()</script ><style>privateStyle</style >');
    expect(result.conversation?.messages).toEqual([]);
  });

  it('preserves structured ChatGPT message extraction', async () => {
    const data = { props: { pageProps: { serverResponse: { data: {
      title: 'Structured conversation',
      mapping: { first: { message: { create_time: 1, author: { role: 'user' }, content: { parts: ['Review the report.'] } } } },
    } } } } };
    const result = await extract(`<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`, 'chatgpt');
    expect(result.conversation?.title).toBe('Structured conversation');
    expect(result.conversation?.messages).toEqual([{ role: 'user', content: 'Review the report.' }]);
  });
});
