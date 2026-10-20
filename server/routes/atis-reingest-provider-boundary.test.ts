import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ATIS re-ingest provider boundary', () => {
  it('uses the bounded Trello client and encodes the requested card id', () => {
    const source = readFileSync(new URL('./atis.ts', import.meta.url), 'utf8');
    const route = source.slice(
      source.indexOf("router.post('/cards/:trelloId/reingest'"),
      source.indexOf("router.get('/cards/by-trello/:trelloId'"),
    );

    expect(route).toContain('fetchWithRetry(');
    expect(route).toContain('encodeURIComponent(trelloId)');
    expect(route).toContain('maxRetries: 0, timeoutMs: 15_000');
    expect(route).not.toMatch(/await fetch\(/);
  });
});
