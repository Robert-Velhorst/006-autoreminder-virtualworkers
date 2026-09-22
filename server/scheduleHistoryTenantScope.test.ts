import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('schedule history tenant scope', () => {
  const scheduling = readFileSync(resolve(process.cwd(), 'server/db/scheduling.ts'), 'utf8');
  const migration = readFileSync(resolve(process.cwd(), 'drizzle/0044_schedule_history_tenant_scope.sql'), 'utf8');

  it('persists the assignment and founder on newly-created history rows', () => {
    expect(scheduling).toContain('founderId, assignmentId');
    expect(scheduling).toContain('assignment.founderId');
    expect(scheduling).toContain('assignment.id');
  });

  it('reads and undoes history using the owned assignment instead of a task ID alone', () => {
    expect(scheduling).toContain('WHERE taskId = ? AND assignmentId = ?');
  });

  it('backfills only task IDs with one founder and leaves ambiguous legacy rows unscoped', () => {
    expect(migration).toContain('HAVING COUNT(DISTINCT founderId) = 1');
    expect(migration).toContain('ADD COLUMN `founderId`');
    expect(migration).toContain('ADD COLUMN `assignmentId`');
  });
});
