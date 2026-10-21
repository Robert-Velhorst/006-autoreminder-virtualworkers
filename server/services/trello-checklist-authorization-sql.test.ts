import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { getAptlssChecklistWriteAuthorization } from './trello-checklist-sync';

afterEach(() => vi.unstubAllEnvs());
describe('checklist assignment prefix PostgreSQL parameter typing', () => {
  it.each(['abc12345','card%_literal'])('binds the full literal prefix without polymorphic CONCAT for %s', async cardId => {
    vi.stubEnv('APTLSS_MANAGER_PILOT_WORKER_IDS','999999');
    vi.stubEnv('APTLSS_MANAGER_SHADOW_ONLY','true');
    let predicate!: SQL;
    const reader = { select: vi.fn(() => ({ from: () => ({ where: (condition: SQL) => {
      predicate = condition;
      return { limit: async () => [{ taskId: `${cardId}:list1234:item1234`,vaId: 7 }] };
    } }) })) };
    expect(await getAptlssChecklistWriteAuthorization(cardId,reader as any)).toEqual({ allowed: true,applyToTrello: true });
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).not.toContain('CONCAT');
    expect(query.sql).toMatch(/LEFT\("task_assignments"\."taskId", \$\d+\) = \$\d+/);
    expect(query.params).toContain(`${cardId}:`);
    expect(query.params).toContain(cardId.length+1);
    expect(query.params.slice(0,3)).toEqual(['assigned','in_progress','blocked']);
    expect(query.sql).not.toContain(cardId);
  });
});
