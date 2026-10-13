import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Trello webhook administration error boundary', () => {
  it('does not expose internal errors or provider errors to administrative clients', () => {
    const source = readFileSync(new URL('./trello-webhook.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('res.status(500).json({ error: error.message });');
    expect(source).not.toContain("error: error instanceof Error ? error.message : 'OpenAI connection test failed'");
    expect(source).toContain("error: 'Could not test the OpenAI connection'");
  });
});
