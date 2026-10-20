import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry, retryAsync } from './utils/retry';

describe('Retry Mechanism', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('fetchWithRetry', () => {
    it('should return response immediately on success', async () => {
      const mockResponse = new Response('success', { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const result = await fetchWithRetry('https://api.trello.com/test');

      expect(result).toBe(mockResponse);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('adds a bounded timeout unless the caller supplies a cancellation signal', async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response('success', { status: 200 }));

      await fetchWithRetry('https://api.trello.com/default-timeout');
      const defaultInit = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect(defaultInit.signal).toBeInstanceOf(AbortSignal);

      const controller = new AbortController();
      await fetchWithRetry('https://api.trello.com/custom-signal', { signal: controller.signal });
      const suppliedInit = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1] as RequestInit;
      expect(suppliedInit.signal).toBe(controller.signal);
    });

    it('should retry on 429 rate limit error', async () => {
      const failResponse = new Response('rate limited', { status: 429 });
      const successResponse = new Response('success', { status: 200 });

      global.fetch = vi.fn()
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(successResponse);

      const onRetry = vi.fn();

      const promise = fetchWithRetry('https://api.trello.com/test', undefined, {
        maxRetries: 3,
        initialDelayMs: 1000,
        onRetry
      });

      // Fast-forward through the retry delay
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(successResponse);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        1,
        expect.any(Error),
        expect.any(Number)
      );
    });

    it('should retry on 500 server error', async () => {
      const failResponse = new Response('server error', { status: 500 });
      const successResponse = new Response('success', { status: 200 });

      global.fetch = vi.fn()
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(successResponse);

      const promise = fetchWithRetry('https://api.trello.com/test', undefined, {
        maxRetries: 3,
        initialDelayMs: 1000
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(successResponse);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 404 not found error', async () => {
      const notFoundResponse = new Response('not found', { status: 404 });

      global.fetch = vi.fn().mockResolvedValue(notFoundResponse);

      const result = await fetchWithRetry('https://api.trello.com/test', undefined, {
        maxRetries: 3
      });

      expect(result).toBe(notFoundResponse);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should use exponential backoff with jitter', async () => {
      const failResponse = new Response('rate limited', { status: 429 });

      global.fetch = vi.fn().mockResolvedValue(failResponse);
      const onRetry = vi.fn();

      const promise = fetchWithRetry('https://api.trello.com/test', undefined, {
        maxRetries: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        onRetry
      });

      await vi.runAllTimersAsync();
      await promise;

      // Should have retried 3 times
      expect(onRetry).toHaveBeenCalledTimes(3);

      // Check that delays are increasing (with some tolerance for jitter)
      const delays = onRetry.mock.calls.map(call => call[2]);
      expect(delays[0]).toBeGreaterThanOrEqual(750); // ~1000ms ± 25%
      expect(delays[0]).toBeLessThanOrEqual(1250);
      expect(delays[1]).toBeGreaterThanOrEqual(1500); // ~2000ms ± 25%
      expect(delays[1]).toBeLessThanOrEqual(2500);
      expect(delays[2]).toBeGreaterThanOrEqual(3000); // ~4000ms ± 25%
      expect(delays[2]).toBeLessThanOrEqual(5000);
    });

    it('should respect max delay cap', async () => {
      const failResponse = new Response('rate limited', { status: 429 });

      global.fetch = vi.fn().mockResolvedValue(failResponse);
      const onRetry = vi.fn();

      const promise = fetchWithRetry('https://api.trello.com/test', undefined, {
        maxRetries: 5,
        initialDelayMs: 1000,
        maxDelayMs: 3000,
        backoffMultiplier: 2,
        onRetry
      });

      await vi.runAllTimersAsync();
      await promise;

      // All delays should be capped at maxDelayMs
      const delays = onRetry.mock.calls.map(call => call[2]);
      delays.forEach(delay => {
        expect(delay).toBeLessThanOrEqual(3750); // 3000ms + 25% jitter
      });
    });

    it('should stop retrying after max retries', async () => {
      const failResponse = new Response('rate limited', { status: 429 });

      global.fetch = vi.fn().mockResolvedValue(failResponse);

      const promise = fetchWithRetry('https://api.trello.com/test', undefined, {
        maxRetries: 2,
        initialDelayMs: 100
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      // Should return the failed response after max retries
      expect(result.status).toBe(429);
      expect(global.fetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('rejects non-allowlisted destinations before making a request', async () => {
      global.fetch = vi.fn();

      await expect(fetchWithRetry('https://127.0.0.1/admin')).rejects.toThrow('Outbound URL host is not allowed');
      await expect(fetchWithRetry('https://api.trello.com.evil.example/test')).rejects.toThrow('Outbound URL host is not allowed');
      await expect(fetchWithRetry('https://api.trello.com:8443/test')).rejects.toThrow('Outbound URL host is not allowed');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('validates every redirect destination before following it', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      );

      await expect(fetchWithRetry('https://api.trello.com/test')).rejects.toThrow('Outbound URL host is not allowed');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('follows redirects between approved chatbot hosts without automatic redirect handling', async () => {
      const redirectResponse = new Response(null, {
        status: 302,
        headers: { location: 'https://gemini.google.com/share/example?token=must-not-leak' },
      });
      const finalResponse = new Response('conversation', { status: 200 });
      const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);
      global.fetch = fetchMock;

      const result = await fetchWithRetry('https://g.co/gemini/share/example', {
        headers: { Authorization: 'Bearer secret' },
      });

      expect(result).toBe(finalResponse);
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        expect.any(URL),
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(fetchMock.mock.calls[1][0].toString()).toBe('https://gemini.google.com/share/example');
      expect(fetchMock.mock.calls[1][1]?.redirect).toBe('manual');
      expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
    });

    it('blocks unapproved cross-origin redirects between otherwise allowed hosts', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://chatgpt.com/share/example' } }),
      );

      await expect(fetchWithRetry('https://claude.ai/share/example')).rejects.toThrow(
        'Outbound redirect destination is not allowed',
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not forward mutation bodies or custom headers across approved origins', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 307, headers: { location: 'https://gemini.google.com/share/example' } }),
      );

      await expect(fetchWithRetry('https://g.co/gemini/share/example', {
        method: 'POST',
        headers: { 'X-Internal-Secret': 'secret' },
        body: 'private payload',
      })).rejects.toThrow('Outbound request cannot redirect across origins');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('strips echoed credentials from an approved cross-origin redirect', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 302,
          headers: { location: 'https://gemini.google.com/share/example?ToKeN=secret&x=public' },
        }))
        .mockResolvedValueOnce(new Response('conversation', { status: 200 }));
      global.fetch = fetchMock;

      await fetchWithRetry('https://g.co/gemini/share/example?key=secret', {
        headers: { 'X-Internal-Secret': 'secret', Accept: 'text/html' },
      });

      expect(fetchMock.mock.calls[1][0].toString()).toBe('https://gemini.google.com/share/example?x=public');
      expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-internal-secret')).toBeNull();
      expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('accept')).toBe('text/html');
    });

    it('rejects credentials reflected into an approved redirect path', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://gemini.google.com/share/secret-value' },
        }),
      );

      await expect(fetchWithRetry('https://g.co/gemini/share/example?key=secret-value')).rejects.toThrow(
        'Outbound redirect reflected a credential',
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryAsync', () => {
    it('should retry async function on failure', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      });

      const promise = retryAsync(fn, {
        maxRetries: 3,
        initialDelayMs: 100
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw error after max retries', async () => {
      const fn = vi.fn(async () => {
        throw new Error('Persistent failure');
      });

      const promise = retryAsync(fn, {
        maxRetries: 2,
        initialDelayMs: 100
      });

      const expectation = expect(promise).rejects.toThrow('Persistent failure');

      await vi.runAllTimersAsync();

      await expectation;
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });
});
