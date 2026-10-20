import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('APTLSS checklist Trello boundary', () => {
  it('bounds mutations and fails closed when Trello rejects a checklist change', () => {
    const source = readFileSync(new URL('./aptlssEngine.ts', import.meta.url), 'utf8');

    expect(source).toContain('const TRELLO_REQUEST_TIMEOUT_MS = 15_000');
    expect(source).toContain('signal: AbortSignal.timeout(TRELLO_REQUEST_TIMEOUT_MS)');
    expect(source).toContain('Trello createChecklist item failed');
    expect(source).toContain('Trello deleteCheckItem failed');
    expect(source).toContain('Trello renameCheckItem failed');
    expect(source).toContain('Trello fetchChecklistItems failed');
  });
});
