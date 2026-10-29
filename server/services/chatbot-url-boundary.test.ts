import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatbotExtractorService } from './chatbot-extractor';

vi.mock('../db', () => ({ getDb: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe('chatbot URL outbound boundaries', () => {
  it.each([
    'https://chatgpt.com.evil.example/share/abc',
    'https://chatgpt.com@evil.example/share/abc',
    'https://gemini.google.com.evil.example/share/abc',
    'https://claude.ai.evil.example/share/abc',
  ])('does not detect an attacker-controlled host: %s', text => {
    expect(new ChatbotExtractorService().detectUrls(text)).toEqual([]);
  });

  it('extracts an approved HTTPS share link from surrounding text', () => {
    expect(new ChatbotExtractorService().detectUrls('Read https://chatgpt.com/share/abc-123 now'))
      .toEqual([{ url: 'https://chatgpt.com/share/abc-123', platform: 'chatgpt' }]);
  });

  it('does not make an outbound request for a detected HTTP share link', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const extractor = new ChatbotExtractorService();
    const [detected] = extractor.detectUrls('http://chatgpt.com/share/abc');
    expect(detected).toBeDefined();
    const result = await extractor.extractConversation(detected.url, detected.platform);
    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never follows a redirect to an internal address', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'http://127.0.0.1/admin' },
    }));
    vi.stubGlobal('fetch', fetch);
    const result = await new ChatbotExtractorService()
      .extractConversation('https://chatgpt.com/share/abc', 'chatgpt');
    expect(result.success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].toString()).toBe('https://chatgpt.com/share/abc');
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
  });

  it.each([
    ['https://claude.ai/share/abc', 'chatgpt'],
    ['https://chatgpt.com/share/abc', 'gemini'],
    ['https://gemini.google.com/share/abc', 'claude'],
    ['https://api.trello.com/1/members/me', 'chatgpt'],
  ] as const)('rejects a valid URL %s for mismatched platform %s', async (url, platform) => {
    const fetch = vi.fn().mockResolvedValue(new Response('<p>synthetic conversation</p>', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = await new ChatbotExtractorService()
      .extractConversation(url, platform);
    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the approved ChatGPT cross-origin redirect', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://chatgpt.com/share/abc' } }))
      .mockResolvedValueOnce(new Response('<p>synthetic conversation</p>', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = await new ChatbotExtractorService()
      .extractConversation('https://chat.openai.com/share/abc', 'chatgpt');
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0].toString()).toBe('https://chatgpt.com/share/abc');
  });

});
