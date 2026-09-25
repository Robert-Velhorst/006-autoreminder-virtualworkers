import { describe, expect, it } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import {
  attributeTimeEntriesToProfiles,
  loadAccountTimeEntries,
  timeEntryAccountScope,
} from './timeEntryOwnership';

async function scopedSql(user: {
  id: number;
  role: 'user' | 'worker' | 'admin';
}) {
  let predicate: any;
  const db = {
    select: () => ({
      from: () => ({
        where: async (condition: unknown) => {
          predicate = condition;
          return [];
        },
      }),
    }),
  } as unknown as Parameters<typeof loadAccountTimeEntries>[0];

  await loadAccountTimeEntries(
    db,
    user as Parameters<typeof loadAccountTimeEntries>[1]
  );
  return predicate ? new MySqlDialect().sqlToQuery(predicate) : null;
}

describe('time entry ownership and attribution', () => {
  it('uses worker account IDs, founder ownership, and unrestricted admin scope', () => {
    expect(timeEntryAccountScope({ id: 42, role: 'worker' })).toEqual({
      kind: 'worker',
      userId: 42,
    });
    expect(timeEntryAccountScope({ id: 7, role: 'user' })).toEqual({
      kind: 'founder',
      founderId: 7,
    });
    expect(timeEntryAccountScope({ id: 1, role: 'admin' })).toEqual({
      kind: 'all',
    });
  });

  it('queries worker time by account ID and founder time by founder ownership', async () => {
    const workerQuery = await scopedSql({ id: 42, role: 'worker' });
    const founderQuery = await scopedSql({ id: 7, role: 'user' });

    expect(workerQuery?.sql).toContain('vaId');
    expect(workerQuery?.params).toContain(42);
    expect(workerQuery?.sql).not.toContain('founderId');
    expect(founderQuery?.sql).toContain('founderId');
    expect(founderQuery?.params).toContain(7);
    expect(founderQuery?.sql).not.toMatch(/vaId/);
  });

  it('attributes both legacy profile IDs and worker account IDs within their founder', () => {
    const profiles = [{ id: 12, userId: 42, founderId: 7 }];
    const entries = [
      { id: 1, vaId: 12, founderId: 7 },
      { id: 2, vaId: 42, founderId: 7 },
    ];

    const result = attributeTimeEntriesToProfiles(profiles, entries);
    expect(result.entriesByProfileId.get(12)).toEqual(entries);
    expect(result.unattributed).toEqual([]);
  });

  it('does not guess when IDs collide, founder ownership differs, or a founder ID overlaps', () => {
    const profiles = [
      { id: 12, userId: 42, founderId: 7 },
      { id: 42, userId: 88, founderId: 7 },
      { id: 7, userId: 99, founderId: 7 },
    ];
    const entries = [
      { id: 1, vaId: 42, founderId: 7 },
      { id: 2, vaId: 12, founderId: 9 },
      { id: 3, vaId: 7, founderId: 7 },
    ];

    const result = attributeTimeEntriesToProfiles(profiles, entries);
    expect(result.entriesByProfileId.size).toBe(0);
    expect(result.unattributed).toEqual(entries);
  });
});
