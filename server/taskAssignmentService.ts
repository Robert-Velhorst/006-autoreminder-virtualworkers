import { and, eq, inArray, sql } from 'drizzle-orm';
import { assignmentEvents, taskAssignments, users, vaProfiles, type User } from '../drizzle/schema.postgres';
import type { getDb } from './db';
import {
  AssignmentError, MAX_ASSIGNMENT_TASKS, readCanonicalAssignments, validateAssignmentTaskId,
  type AssignmentActor, type TaskAssignment,
} from './taskAssignmentMutation';

export { AssignmentError, assignmentFailure } from './taskAssignmentMutation';
export type { AssignmentActor } from './taskAssignmentMutation';
type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type AssignmentTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Profile = typeof vaProfiles.$inferSelect;
export type AssignmentStatus = TaskAssignment['status'];
export type AssignmentResult = { assignment: TaskAssignment; outcome: 'created' | 'changed' | 'unchanged' };
export type AssignmentContext = { actor: User; profile: Profile; profiles: ReadonlyMap<number, Profile>; founderId: number };

function positiveId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AssignmentError(400, 'A positive assignment identity is required', 'ASSIGNMENT_INPUT');
}

function taskKeys(taskIds: readonly string[]) {
  if (!taskIds.length || taskIds.length > MAX_ASSIGNMENT_TASKS) throw new AssignmentError(400, 'Between 1 and 100 task IDs are required', 'ASSIGNMENT_INPUT');
  taskIds.forEach(validateAssignmentTaskId);
  return [...new Set(taskIds)].sort();
}

function statusValue(status: unknown): asserts status is AssignmentStatus {
  if (!['assigned', 'in_progress', 'completed', 'blocked'].includes(status as string)) {
    throw new AssignmentError(400, 'Invalid assignment status', 'ASSIGNMENT_INPUT');
  }
}

function activeProfile(profiles: Profile[]): Profile {
  const active = profiles.filter(profile => profile.status === 'active');
  if (active.length !== 1) throw new AssignmentError(409, 'Worker must have exactly one active profile; reload before trying again', 'ASSIGNMENT_WORKER_SCOPE');
  return active[0];
}

// Observe only to discover lock IDs; all identities are checked again under locks.
async function lockScope(tx: AssignmentTransaction, expected: AssignmentActor, keys: string[], targetProfileId?: number, additionalProfileIds: readonly number[] = []) {
  positiveId(expected.id);
  if (expected.role !== 'admin' && expected.role !== 'worker') throw new AssignmentError(403, 'Assignment access denied', 'ASSIGNMENT_FORBIDDEN');
  const observedWorker = expected.role === 'worker'
    ? activeProfile(await tx.select().from(vaProfiles).where(eq(vaProfiles.userId, expected.id))) : null;
  const founderId = observedWorker?.founderId ?? expected.id;
  const observed = await readCanonicalAssignments(tx, founderId, keys);
  const baseProfileIds = targetProfileId === undefined
    ? [...new Set([...observed.map(row => row.vaId), ...(observedWorker ? [observedWorker.id] : [])])]
    : [targetProfileId];
  const profileIds = [...new Set([...baseProfileIds, ...additionalProfileIds])];
  if (profileIds.length > MAX_ASSIGNMENT_TASKS + 2) throw new AssignmentError(400, 'Too many worker profiles', 'ASSIGNMENT_INPUT');
  profileIds.forEach(positiveId);
  const discovered = profileIds.length ? await tx.select().from(vaProfiles).where(inArray(vaProfiles.id, profileIds)) : [];
  if (discovered.length !== profileIds.length) throw new AssignmentError(409, 'Assignment worker identity is unavailable', 'ASSIGNMENT_WORKER_SCOPE');
  const accountIds = [...new Set([expected.id, founderId, ...discovered.map(profile => profile.userId)])].sort((a, b) => a - b);
  const accounts = new Map<number, User>();
  for (const id of accountIds) {
    positiveId(id);
    // Non-key account updates must serialize, without blocking unrelated FK key-share checks.
    const [account] = await tx.select().from(users).where(eq(users.id, id)).for('no key update');
    if (account) accounts.set(id, account);
  }
  const actor = accounts.get(expected.id);
  if (!actor || actor.role !== expected.role) throw new AssignmentError(403, 'Account role changed; reload before trying again', 'ASSIGNMENT_ACTOR_CHANGED');
  if (accounts.get(founderId)?.role !== 'admin') throw new AssignmentError(403, 'Assignment founder is unavailable', 'ASSIGNMENT_FORBIDDEN');
  const workerAccountIds = [...new Set(discovered.map(profile => profile.userId))];
  const lockedProfiles = workerAccountIds.length ? await tx.select().from(vaProfiles)
    .where(inArray(vaProfiles.userId, workerAccountIds)).orderBy(vaProfiles.id).for('update') : [];
  const profiles = new Map<number, Profile>();
  for (const original of discovered) {
    const account = accounts.get(original.userId);
    const profile = activeProfile(lockedProfiles.filter(row => row.userId === original.userId));
    if (account?.role !== 'worker' || profile.id !== original.id || profile.founderId !== founderId) {
      throw new AssignmentError(409, 'Worker ownership or eligibility changed; reload before trying again', 'ASSIGNMENT_WORKER_SCOPE');
    }
    profiles.set(profile.id, profile);
  }
  if (observedWorker && profiles.get(observedWorker.id)?.userId !== actor.id) {
    throw new AssignmentError(403, 'Assignment worker scope changed', 'ASSIGNMENT_FORBIDDEN');
  }
  const assignments = await readCanonicalAssignments(tx, founderId, keys, { lock: true });
  if (targetProfileId === undefined && assignments.some(row => !profiles.has(row.vaId))) {
    throw new AssignmentError(409, 'Assignment ownership changed; reload before trying again');
  }
  if (actor.role === 'worker' && assignments.some(row => row.vaId !== observedWorker!.id)) {
    throw new AssignmentError(403, 'Task is not assigned to this worker', 'ASSIGNMENT_FORBIDDEN');
  }
  return { actor, founderId, profiles, assignments };
}

function snapshot(row: TaskAssignment): Record<string, unknown> {
  return { ...row };
}

async function event(tx: AssignmentTransaction, actor: User, before: TaskAssignment | null, after: TaskAssignment) {
  await tx.insert(assignmentEvents).values({ assignmentId: after.id, founderId: after.founderId,
    taskId: after.taskId, actorUserId: actor.id,
    kind: !before ? 'created' : before.vaId !== after.vaId ? 'reassigned' : before.status !== after.status ? 'status_changed' : 'notes_changed',
    previousWorkerProfileId: before?.vaId ?? null, nextWorkerProfileId: after.vaId,
    previousStatus: before?.status ?? null, nextStatus: after.status,
    beforeJson: before ? snapshot(before) : null, afterJson: snapshot(after) });
}

function requireAdmin(actor: AssignmentActor) {
  if (actor.role !== 'admin') throw new AssignmentError(403, 'Administrator access required', 'ASSIGNMENT_FORBIDDEN');
}

type AssignInput = { taskId: string; workerProfileId: number; notes?: string | null };
function validateNotes(notes: unknown) {
  if (notes !== undefined && notes !== null && typeof notes !== 'string') throw new AssignmentError(400, 'Invalid assignment notes', 'ASSIGNMENT_INPUT');
}

async function upsert(tx: AssignmentTransaction, scope: Awaited<ReturnType<typeof lockScope>>, input: AssignInput, requiredId?: number): Promise<AssignmentResult> {
  const before = scope.assignments.find(row => row.taskId === input.taskId) ?? null;
  if (requiredId !== undefined && before?.id !== requiredId) throw new AssignmentError(404, 'Assignment not found', 'ASSIGNMENT_NOT_FOUND');
  if (before && before.vaId === input.workerProfileId && (input.notes === undefined || input.notes === before.notes)) {
    return { assignment: before, outcome: 'unchanged' };
  }
  const now = new Date();
  const changes = { vaId: input.workerProfileId,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(!before || before.vaId !== input.workerProfileId ? { assignedAt: now, assignedBy: scope.actor.id } : {}),
    updatedAt: now };
  // Existing assignment columns are UTC-naive. Encode new timestamps as UTC via
  // Drizzle's Date mapper instead of session-timezone-dependent DEFAULT now().
  const [after] = await tx.insert(taskAssignments).values({ taskId: input.taskId, founderId: scope.founderId,
    vaId: input.workerProfileId, assignedBy: scope.actor.id, assignedAt: now, createdAt: now, updatedAt: now,
    ...(input.notes === undefined ? {} : { notes: input.notes }) })
    .onConflictDoUpdate({ target: [taskAssignments.founderId, taskAssignments.taskId], set: changes,
      setWhere: before ? eq(taskAssignments.id, before.id) : sql`false` }).returning();
  if (!after || (before && after.id !== before.id)) throw new AssignmentError(409, 'Assignment identity changed');
  await event(tx, scope.actor, before, after);
  return { assignment: after, outcome: before ? 'changed' : 'created' };
}

export async function assignTask(db: Database, actor: AssignmentActor, input: AssignInput): Promise<AssignmentResult> {
  requireAdmin(actor);
  const keys = taskKeys([input.taskId]); positiveId(input.workerProfileId); validateNotes(input.notes);
  return db.transaction(async tx => upsert(tx, await lockScope(tx, actor, keys, input.workerProfileId), input));
}

export async function reassignTask(db: Database, actor: AssignmentActor, input: { assignmentId: number; workerProfileId: number }): Promise<AssignmentResult> {
  requireAdmin(actor); positiveId(input.assignmentId); positiveId(input.workerProfileId);
  return db.transaction(async tx => {
    const [observed] = await tx.select().from(taskAssignments)
      .where(and(eq(taskAssignments.id, input.assignmentId), eq(taskAssignments.founderId, actor.id)));
    if (!observed) throw new AssignmentError(404, 'Assignment not found', 'ASSIGNMENT_NOT_FOUND');
    const scope = await lockScope(tx, actor, taskKeys([observed.taskId]), input.workerProfileId);
    return upsert(tx, scope, { taskId: observed.taskId, workerProfileId: input.workerProfileId }, input.assignmentId);
  });
}

export async function withLockedAssignment<T>(db: Database, actor: AssignmentActor, taskId: string,
  fn: (tx: AssignmentTransaction, assignment: TaskAssignment, context: AssignmentContext) => Promise<T>,
  options: { workerProfileIds?: readonly number[] } = {}): Promise<T> {
  const keys = taskKeys([taskId]);
  return db.transaction(async tx => {
    const scope = await lockScope(tx, actor, keys, undefined, options.workerProfileIds);
    const assignment = scope.assignments[0];
    if (!assignment) throw new AssignmentError(404, 'Assigned task not found', 'ASSIGNMENT_NOT_FOUND');
    return fn(tx, assignment, { actor: scope.actor, profile: scope.profiles.get(assignment.vaId)!, profiles: scope.profiles, founderId: scope.founderId });
  });
}

export async function changeAssignmentStatuses(db: Database, actor: AssignmentActor, input: { taskIds: readonly string[]; status: AssignmentStatus }): Promise<AssignmentResult[]> {
  const keys = taskKeys(input.taskIds); statusValue(input.status);
  return db.transaction(async tx => {
    const scope = await lockScope(tx, actor, keys);
    if (scope.assignments.length !== keys.length) throw new AssignmentError(404, 'Assigned task not found', 'ASSIGNMENT_NOT_FOUND');
    const results: AssignmentResult[] = [];
    for (const before of scope.assignments) {
      if (before.status === input.status) { results.push({ assignment: before, outcome: 'unchanged' }); continue; }
      const [after] = await tx.update(taskAssignments).set({ status: input.status, updatedAt: new Date() })
        .where(eq(taskAssignments.id, before.id)).returning();
      if (!after) throw new AssignmentError(409, 'Assignment changed');
      await event(tx, scope.actor, before, after);
      results.push({ assignment: after, outcome: 'changed' });
    }
    return results;
  });
}

export async function changeAssignmentStatus(db: Database, actor: AssignmentActor, input: { taskId: string; status: AssignmentStatus }): Promise<AssignmentResult> {
  return (await changeAssignmentStatuses(db, actor, { taskIds: [input.taskId], status: input.status }))[0];
}
