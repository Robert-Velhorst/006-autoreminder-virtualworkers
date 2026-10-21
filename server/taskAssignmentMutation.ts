import { and, eq, inArray, sql } from 'drizzle-orm';
import { taskAssignments, type User } from '../drizzle/schema.postgres';
import type { getDb } from './db';

export type AssignmentActor = Pick<User, 'id' | 'role'>;
export type TaskAssignment = typeof taskAssignments.$inferSelect;
type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AssignmentReader = Pick<Database, 'select'> & Partial<Pick<Database, 'execute'>>;
export const MAX_ASSIGNMENT_TASKS = 100;

export class AssignmentError extends Error {
  constructor(public status: number, message: string, public code = 'ASSIGNMENT_CONFLICT') {
    super(message);
    this.name = 'AssignmentError';
  }
}

export function assignmentFailure(error: unknown): { status: number; error: string; code: string } | null {
  if (error instanceof AssignmentError) return { status: error.status, error: error.message, code: error.code };
  const pg = error as { code?: string; cause?: { code?: string } } | null;
  if (pg?.code === '23505' || pg?.cause?.code === '23505') {
    return { status: 409, error: 'Assignment identity conflict; reload before trying again', code: 'ASSIGNMENT_CONFLICT' };
  }
  return null;
}

export function assertCanonicalAssignmentRows<T extends { founderId: number; taskId: string }>(rows: readonly T[]): void {
  const founders = new Map<number, Set<string>>();
  for (const row of rows) {
    const keys = founders.get(row.founderId) ?? new Set<string>();
    if (keys.has(row.taskId)) throw new AssignmentError(409, 'Duplicate task assignments require explicit review', 'ASSIGNMENT_DUPLICATE');
    keys.add(row.taskId);
    founders.set(row.founderId, keys);
  }
}

export function validateAssignmentTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 128 || taskId.trim() !== taskId) {
    throw new AssignmentError(400, 'A full task ID of 1 to 128 characters is required', 'ASSIGNMENT_INPUT');
  }
}

export async function readCanonicalAssignments(db: AssignmentReader, founderId: number, taskIds: readonly string[], options: { lock?: boolean } = {}): Promise<TaskAssignment[]> {
  if (!Number.isSafeInteger(founderId) || founderId <= 0 || taskIds.length > MAX_ASSIGNMENT_TASKS) {
    throw new AssignmentError(400, 'Invalid assignment scope or task count', 'ASSIGNMENT_INPUT');
  }
  taskIds.forEach(validateAssignmentTaskId);
  const keys = [...new Set(taskIds)].sort();
  if (!keys.length) return [];
  if (options.lock) {
    if (!db.execute) throw new AssignmentError(503, 'Assignment transaction locking unavailable', 'ASSIGNMENT_UNAVAILABLE');
    // Callers must pass a transaction: the identity lock also fences an absent row.
    for (const taskId of keys) {
      const identity = JSON.stringify(['task_assignment', founderId, taskId]);
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
    }
  }
  const query = db.select().from(taskAssignments)
    .where(and(eq(taskAssignments.founderId, founderId), inArray(taskAssignments.taskId, keys)))
    .orderBy(taskAssignments.taskId, taskAssignments.id).limit(keys.length + 1);
  const rows = options.lock ? await query.for('update') : await query;
  assertCanonicalAssignmentRows(rows);
  return rows;
}

export async function readCanonicalAssignment(db: AssignmentReader, founderId: number, fullTaskId: string, options: { lock?: boolean } = {}): Promise<TaskAssignment | null> {
  return (await readCanonicalAssignments(db, founderId, [fullTaskId], options))[0] ?? null;
}

/** Legacy result check; callers still need a pre-write canonical guard and transaction. */
export function didUpdateSingleTaskAssignment(result: unknown): boolean {
  return typeof result === "object" && result !== null
    && (result as { rowCount?: unknown }).rowCount === 1;
}
