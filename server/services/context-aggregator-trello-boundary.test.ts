import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('context aggregator Trello boundary', () => {
  it('uses the shared bounded request helper and validates configured credentials', () => {
    const source = readFileSync(new URL('./context-aggregator.ts', import.meta.url), 'utf8');

    expect(source).toContain("import { fetchWithRetry } from '../utils/retry'");
    expect(source).toContain("throw new Error('Trello credentials are not configured')");
    expect(source).toContain('fetchWithRetry(url, undefined, { maxRetries: 0 })');
    expect(source).not.toContain('await fetch(url)');
  });
});
