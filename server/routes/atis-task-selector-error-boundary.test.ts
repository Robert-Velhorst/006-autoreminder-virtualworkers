import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ATIS task selector error boundary', () => {
  it('keeps provider failure details out of task-selection responses', () => {
    const source = readFileSync(new URL('./atis-task-selector.ts', import.meta.url), 'utf8');

    expect(source).toContain("error: 'Could not load Trello tasks. Retry shortly.'");
    expect(source).toContain("error: 'Could not search Trello tasks. Retry shortly.'");
    expect(source).not.toContain("error: error instanceof Error ? error.message : 'Failed to fetch tasks'");
    expect(source).not.toContain("error: error instanceof Error ? error.message : 'Failed to search tasks'");
  });

  it('limits the administrator ATIS selector to administrator accounts', () => {
    const source = readFileSync(new URL('./atis-task-selector.ts', import.meta.url), 'utf8');

    expect(source).toContain("import { adminProcedure } from '../_core/trpc'");
    expect(source).toContain('getTasks: adminProcedure.query');
    expect(source).toContain('getTasksByBoard: adminProcedure');
    expect(source).toContain('searchTasks: adminProcedure');
  });
});
