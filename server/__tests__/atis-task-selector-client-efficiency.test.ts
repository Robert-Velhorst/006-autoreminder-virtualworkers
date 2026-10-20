import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ATIS task selector client efficiency', () => {
  it('filters the loaded Trello task collection locally instead of refetching every search term', () => {
    const source = readFileSync(
      new URL('../../client/src/components/atis/TaskSelector.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('useMemo');
    expect(source).toContain('task.name.toLowerCase().includes(normalizedQuery)');
    expect(source).toContain('task.boardName.toLowerCase().includes(normalizedQuery)');
    expect(source).not.toContain('trpc.atis.searchTasks.useQuery');
  });
});
