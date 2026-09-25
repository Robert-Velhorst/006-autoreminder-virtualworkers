import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Trello checklist completion safety', () => {
  it('authorizes the submitted card and validates a boolean state before mutation', () => {
    const source = readFileSync(new URL('./trello-config.ts', import.meta.url), 'utf8');
    const route = source.slice(
      source.indexOf("router.put('/tasks/:taskId/complete'"),
      source.indexOf("router.put('/cards/:cardId/status'"),
    );

    expect(route).toContain("if (typeof isCompleted !== 'boolean')");
    expect(route).toContain('if (!await requireAssignedCard(req, res, cardId, { checklistId, checkItemId })) return;');
    expect(route).toContain('encodeURIComponent(checklistId)');
    expect(route).toContain('encodeURIComponent(checkItemId)');
    expect(route).toContain('{ maxRetries: 0, timeoutMs: 15_000 }');
    expect(route).not.toContain('details: errorText');
    expect(route).not.toContain('Failed to update task completion: ${error instanceof Error ? error.message');
  });
});
