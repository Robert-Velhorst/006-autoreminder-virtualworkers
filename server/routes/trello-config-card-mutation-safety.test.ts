import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Trello card mutation provider boundary', () => {
  it('keeps card mutations encoded, bounded, and free of raw provider errors', () => {
    const source = readFileSync(new URL('./trello-config.ts', import.meta.url), 'utf8');
    const statusRoute = source.slice(
      source.indexOf("router.put('/cards/:cardId/status'"),
      source.indexOf("router.put('/cards/:cardId/due'"),
    );
    const updateRoute = source.slice(
      source.indexOf("router.put('/cards/:cardId/update'"),
      source.indexOf("router.put('/cards/:cardId/members'"),
    );
    const membersRoute = source.slice(source.indexOf("router.put('/cards/:cardId/members'"));

    expect(source).toContain("function trelloRequest(url: URL, init?: RequestInit)");
    expect(source).toContain('maxRetries: 0');
    expect(source).toContain('timeoutMs: 15_000');
    expect(statusRoute).toContain('encodeURIComponent(cardId)');
    expect(statusRoute).toContain('await trelloRequest(cardUrl)');
    expect(statusRoute).toContain('await trelloRequest(updateUrl,');
    expect(statusRoute).not.toContain('details: errorText');
    expect(statusRoute).not.toContain("error instanceof Error ? error.message");
    expect(updateRoute).toContain('encodeURIComponent(cardId)');
    expect(updateRoute).toContain('await trelloRequest(updateUrl,');
    expect(updateRoute).not.toContain('error: `Failed to update card: ${errorText}`');
    expect(membersRoute).toContain('encodeURIComponent(cardId)');
    expect(membersRoute).toContain('await trelloRequest(updateUrl,');
    expect(membersRoute).not.toContain('error: `Failed to update card members: ${errorText}`');
  });
});
