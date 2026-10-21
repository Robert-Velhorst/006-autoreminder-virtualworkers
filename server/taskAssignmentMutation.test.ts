import { describe, expect, it } from "vitest";
import { PgDialect } from 'drizzle-orm/pg-core';
import { taskAssignments } from '../drizzle/schema.postgres';
import { timerTestDatabase } from './test/timerDatabase';
import {
  AssignmentError, assignmentFailure, assertCanonicalAssignmentRows, didUpdateSingleTaskAssignment,
  readCanonicalAssignment, readCanonicalAssignments,
} from "./taskAssignmentMutation";

describe("didUpdateSingleTaskAssignment", () => {
  it("accepts the PostgreSQL update result for exactly one owned assignment", () => {
    expect(didUpdateSingleTaskAssignment({ rowCount: 1 })).toBe(true);
  });

  it("rejects missing or multi-row updates", () => {
    for (const result of [undefined, null, {}, { rowCount: null }, { rowCount: 0 }, { rowCount: 2 }, { rowCount: "1" }, [{ affectedRows: 1 }]]) {
      expect(didUpdateSingleTaskAssignment(result)).toBe(false);
    }
  });
});

describe('canonical assignment identity', () => {
  const first = { id: 1, founderId: 10, taskId: 'card:list:item', vaId: 20, status: 'completed' };
  function fixture(values = [first]) { return timerTestDatabase(new Map([[taskAssignments, values]])); }

  it('rejects full-identity duplicates regardless of worker or status before filtering', async () => {
    const { db } = fixture([first, { ...first, id: 2, vaId: 30, status: 'assigned' }]);
    await expect(readCanonicalAssignment(db, 10, first.taskId)).rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_DUPLICATE' });
  });

  it('distinguishes founders and full child identities instead of collapsing card prefixes', () => {
    expect(() => assertCanonicalAssignmentRows([first, { ...first, founderId: 11 }, { ...first, taskId: 'card:list:other' }])).not.toThrow();
    expect(() => assertCanonicalAssignmentRows([first, { ...first, status: 'assigned' }])).toThrow(AssignmentError);
  });

  it('returns only exact scoped identities and null for absent identities', async () => {
    const { db } = fixture([first, { ...first, id: 2, founderId: 11 }, { ...first, id: 3, taskId: 'card' }]);
    expect((await readCanonicalAssignment(db, 10, first.taskId))?.id).toBe(1);
    expect(await readCanonicalAssignment(db, 10, 'missing')).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('locks all deduplicated absent identities in lexical order before row locking', async () => {
    const order: string[] = [];
    const store = timerTestDatabase(new Map(), { beforeLock: async () => { order.push('rows'); } });
    store.db.execute.mockImplementation(async (query: any) => {
      const compiled = new PgDialect().sqlToQuery(query);
      expect(compiled.sql).toContain('pg_advisory_xact_lock(hashtextextended(');
      order.push(compiled.params[0] as string);
    });
    expect(await readCanonicalAssignments(store.db, 10, ['z', 'a', 'z'], { lock: true })).toEqual([]);
    expect(order).toEqual([JSON.stringify(['task_assignment', 10, 'a']), JSON.stringify(['task_assignment', 10, 'z']), 'rows']);
  });

  it('bounds the query to unique task count plus one to detect overflow/duplicates', async () => {
    const { db } = fixture([first, { ...first, id: 2 }, { ...first, id: 3 }]);
    await expect(readCanonicalAssignments(db, 10, [first.taskId])).rejects.toMatchObject({ status: 409 });
    await expect(readCanonicalAssignments(db, 10, Array(101).fill('a'))).rejects.toMatchObject({ status: 400 });
  });

  it('fails closed when locking capability is unavailable', async () => {
    const { db } = fixture();
    await expect(readCanonicalAssignment({ select: db.select }, 10, 'a', { lock: true })).rejects.toMatchObject({ status: 503 });
  });

  it('sanitizes database conflicts and does not disclose unknown SQL errors', () => {
    expect(assignmentFailure({ cause: { code: '23505', detail: 'private SQL values' } })).toEqual({ status: 409,
      error: 'Assignment identity conflict; reload before trying again', code: 'ASSIGNMENT_CONFLICT' });
    expect(assignmentFailure(new Error('private SQL'))).toBeNull();
    expect(assignmentFailure(new AssignmentError(403, 'Denied', 'SCOPE'))).toEqual({ status: 403, error: 'Denied', code: 'SCOPE' });
  });
});
