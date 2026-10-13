import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ATIS error boundary', () => {
  it('keeps detailed exceptions in server logs instead of browser responses', () => {
    const source = readFileSync(new URL('./atis.ts', import.meta.url), 'utf8');

    expect(source).toContain('function sendAtisFailure');
    expect(source).toContain('Check the server logs or retry.');
    expect(source).not.toContain('res.status(500).json({ error: error.message });');
    expect(source).not.toContain('results.push({ cardId: card.id, success: false, error: error.message });');
    expect(source).not.toContain('Trello credentials (TRELLO_API_KEY / TRELLO_TOKEN) are not configured on the server.');
  });
});
