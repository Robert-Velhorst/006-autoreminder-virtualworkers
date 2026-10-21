import { and, desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { AssignmentError, assignmentFailure, assertCanonicalAssignmentRows, readCanonicalAssignment } from '../taskAssignmentMutation';
import { withLockedAssignment } from '../taskAssignmentService';
import { selectWorkerProfile } from '../workerOperatorContext';
import {
  batchOperations,
  keyboardShortcuts,
  taskAssignments,
  taskScheduleHistory,
  users,
  vaProfiles,
  type User,
} from '../../drizzle/schema.postgres';

// ============================================
// TASK SCHEDULE HISTORY
// ============================================

export interface ScheduleHistoryRecord {
  id: string;
  taskId: string;
  founderId: number;
  assignmentId: number;
  cardTrelloId?: string;
  previousStartTime?: Date;
  previousEndTime?: Date;
  newStartTime: Date;
  newEndTime: Date;
  changedBy: string;
  reason?: string;
  source: 'manual' | 'auto' | 'batch' | 'conflict_resolution';
  hadConflicts: boolean;
  conflictDetails?: string;
  createdAt: Date;
}

export interface ScheduleActor {
  id: number;
  openId: string;
  role: User['role'];
}

export interface ScheduledTaskRecord {
  id: number;
  taskId: string;
  vaId: number;
  founderId: number;
  startTime?: Date;
  endTime?: Date;
  status: string;
}

export interface RescheduleResult {
  historyId: string;
  taskId: string;
  cardTrelloId?: string;
  previousStartTime?: Date;
  previousEndTime?: Date;
  newStartTime: Date;
  newEndTime: Date;
  vaId: number;
}

function mapScheduledTask(row: typeof taskAssignments.$inferSelect): ScheduledTaskRecord {
  return {
    id: Number(row.id),
    taskId: row.taskId,
    vaId: Number(row.vaId),
    founderId: Number(row.founderId),
    startTime: row.startTime ?? undefined,
    endTime: row.endTime ?? undefined,
    status: row.status,
  };
}

function mapScheduleHistory(row: typeof taskScheduleHistory.$inferSelect): ScheduleHistoryRecord {
  if (row.founderId === null || row.assignmentId === null) {
    throw new Error("Schedule history has no verified workspace assignment");
  }
  return {
    id: row.id,
    taskId: row.taskId,
    founderId: row.founderId,
    assignmentId: row.assignmentId,
    cardTrelloId: row.cardTrelloId ?? undefined,
    previousStartTime: row.previousStartTime ?? undefined,
    previousEndTime: row.previousEndTime ?? undefined,
    newStartTime: row.newStartTime as Date,
    newEndTime: row.newEndTime as Date,
    changedBy: row.changedBy,
    reason: row.reason ?? undefined,
    source: row.source as ScheduleHistoryRecord['source'],
    hadConflicts: Number(row.hadConflicts) !== 0,
    conflictDetails: row.conflictDetails ?? undefined,
    createdAt: row.createdAt,
  };
}

async function scheduleScope(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, actor: ScheduleActor) {
  if (actor.role !== 'worker') return { founderId: actor.id, profileId: null };
  const profiles = await db.select().from(vaProfiles).where(eq(vaProfiles.userId, actor.id));
  const profile = selectWorkerProfile(profiles);
  if (!profile) throw new AssignmentError(409, 'Worker must have exactly one active profile; reload before trying again');
  return { founderId: profile.founderId, profileId: profile.id };
}

async function assignmentForActor(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, taskId: string, actor: ScheduleActor) {
  const scope = await scheduleScope(db, actor);
  const assignment = await readCanonicalAssignment(db, scope.founderId, taskId);
  return assignment && (scope.profileId === null || assignment.vaId === scope.profileId) ? assignment : null;
}

export async function insertScheduleHistory(record: Omit<ScheduleHistoryRecord, 'id' | 'createdAt'>): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const id = uuidv4();
  await db.insert(taskScheduleHistory).values({
    id,
    taskId: record.taskId,
    founderId: record.founderId,
    assignmentId: record.assignmentId,
    cardTrelloId: record.cardTrelloId ?? null,
    previousStartTime: record.previousStartTime ?? null,
    previousEndTime: record.previousEndTime ?? null,
    newStartTime: record.newStartTime,
    newEndTime: record.newEndTime,
    changedBy: record.changedBy,
    reason: record.reason ?? null,
    source: record.source,
    hadConflicts: record.hadConflicts ? 1 : 0,
    conflictDetails: record.conflictDetails ?? null,
  });
  return id;
}

export async function getScheduleHistory(taskId: string, assignmentId: number, limit: number = 50): Promise<ScheduleHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];

  const safeLimit = Math.max(1, Number.parseInt(String(limit), 10) || 50);
  const rows = await db.select().from(taskScheduleHistory)
    .where(and(eq(taskScheduleHistory.taskId, taskId), eq(taskScheduleHistory.assignmentId, assignmentId)))
    .orderBy(desc(taskScheduleHistory.createdAt))
    .limit(safeLimit);
  return rows.map(mapScheduleHistory);
}

export async function getScheduledTaskForActor(
  taskId: string,
  actor: ScheduleActor,
): Promise<ScheduledTaskRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const row = await assignmentForActor(db, taskId, actor);
  return row ? mapScheduledTask(row) : null;
}

export async function getScheduleActorByOpenId(openId: string): Promise<ScheduleActor | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select({ id: users.id, openId: users.openId, role: users.role })
    .from(users).where(eq(users.openId, openId)).limit(1);
  return row ? { id: Number(row.id), openId: row.openId, role: row.role } : null;
}

export async function getScheduleHistoryForActor(
  taskId: string,
  actor: ScheduleActor,
  limit: number = 50,
): Promise<ScheduleHistoryRecord[] | null> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const ownedTask = await assignmentForActor(db, taskId, actor);
  if (!ownedTask) return null;
  const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 50, 200));
  const rows = await db.select().from(taskScheduleHistory)
    .where(and(eq(taskScheduleHistory.taskId, taskId), eq(taskScheduleHistory.assignmentId, ownedTask.id),
      eq(taskScheduleHistory.founderId, ownedTask.founderId)))
    .orderBy(desc(taskScheduleHistory.createdAt))
    .limit(safeLimit);
  return rows.map(mapScheduleHistory);
}

export async function rescheduleTaskForActor(
  actor: ScheduleActor,
  taskId: string,
  newStartTime: Date,
  newEndTime: Date,
  options: {
    cardTrelloId?: string;
    reason?: string;
    source?: ScheduleHistoryRecord['source'];
    hadConflicts?: boolean;
    conflictDetails?: string;
  } = {},
): Promise<RescheduleResult | null> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  try {
  return await withLockedAssignment(db, actor, taskId, async (tx, row) => {
    const assignment = mapScheduledTask(row);
    await tx.update(taskAssignments).set({ startTime: newStartTime, endTime: newEndTime, updatedAt: new Date() })
      .where(eq(taskAssignments.id, assignment.id));

    const historyId = uuidv4();
    const cardTrelloId = options.cardTrelloId || assignment.taskId.split(':')[0] || null;
    await tx.insert(taskScheduleHistory).values({
      id: historyId,
      taskId: assignment.taskId,
      founderId: assignment.founderId,
      assignmentId: assignment.id,
      cardTrelloId,
      previousStartTime: assignment.startTime ?? null,
      previousEndTime: assignment.endTime ?? null,
      newStartTime,
      newEndTime,
      changedBy: actor.openId,
      reason: options.reason || 'Manual reschedule',
      source: options.source || 'manual',
      hadConflicts: options.hadConflicts ? 1 : 0,
      conflictDetails: options.conflictDetails ?? null,
    });

    return {
      historyId,
      taskId: assignment.taskId,
      cardTrelloId: cardTrelloId ?? undefined,
      previousStartTime: assignment.startTime,
      previousEndTime: assignment.endTime,
      newStartTime,
      newEndTime,
      vaId: assignment.vaId,
    };
  });
  } catch (error) {
    if (assignmentFailure(error)?.status === 404) return null;
    throw error;
  }
}

export async function undoLastRescheduleForActor(
  actor: ScheduleActor,
  taskId: string,
): Promise<RescheduleResult | null> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  try {
  return await withLockedAssignment(db, actor, taskId, async (tx, row) => {
    const assignment = mapScheduledTask(row);

    const [previous] = await tx.select().from(taskScheduleHistory)
      .where(and(eq(taskScheduleHistory.taskId, assignment.taskId), eq(taskScheduleHistory.assignmentId, assignment.id),
        eq(taskScheduleHistory.founderId, assignment.founderId)))
      .orderBy(desc(taskScheduleHistory.createdAt))
      .limit(1)
      .for('update');
    if (!previous?.previousStartTime || !previous.previousEndTime) return null;

    const restoredStartTime = previous.previousStartTime;
    const restoredEndTime = previous.previousEndTime;
    await tx.update(taskAssignments).set({
      startTime: restoredStartTime,
      endTime: restoredEndTime,
      updatedAt: new Date(),
    }).where(eq(taskAssignments.id, assignment.id));

    const historyId = uuidv4();
    const cardTrelloId = previous.cardTrelloId || assignment.taskId.split(':')[0] || null;
    await tx.insert(taskScheduleHistory).values({
      id: historyId,
      taskId: assignment.taskId,
      founderId: assignment.founderId,
      assignmentId: assignment.id,
      cardTrelloId,
      previousStartTime: assignment.startTime ?? null,
      previousEndTime: assignment.endTime ?? null,
      newStartTime: restoredStartTime,
      newEndTime: restoredEndTime,
      changedBy: actor.openId,
      reason: 'Undo reschedule',
      source: 'manual',
      hadConflicts: 0,
      conflictDetails: null,
    });

    return {
      historyId,
      taskId: assignment.taskId,
      cardTrelloId: cardTrelloId ?? undefined,
      previousStartTime: assignment.startTime,
      previousEndTime: assignment.endTime,
      newStartTime: restoredStartTime,
      newEndTime: restoredEndTime,
      vaId: assignment.vaId,
    };
  });
  } catch (error) {
    if (assignmentFailure(error)?.status === 404) return null;
    throw error;
  }
}

// ============================================
// BATCH OPERATIONS
// ============================================

export interface BatchOperationRecord {
  id: string;
  userId: string;
  operationType: 're_analyze' | 'reschedule' | 'conflict_resolution' | 'optimization';
  taskIds: string[];
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  completedTasks: number;
  failedTasks: number;
  currentTaskIndex: number;
  currentTaskName?: string;
  estimatedTimeSeconds?: number;
  results?: Record<string, any>;
  errorLog?: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  elapsedTimeSeconds?: number;
}

export async function createBatchOperation(record: Omit<BatchOperationRecord, 'id' | 'createdAt' | 'status' | 'progress' | 'completedTasks' | 'failedTasks' | 'currentTaskIndex'>): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const id = uuidv4();
  await db.insert(batchOperations).values({
    id,
    userId: record.userId,
    operationType: record.operationType,
    description: record.description || `Batch ${record.operationType}`,
    totalTasks: record.taskIds.length,
    status: 'pending',
    progress: '0',
    completedTasks: 0,
    failedTasks: 0,
    currentTaskIndex: 0,
    estimatedTimeSeconds: record.taskIds.length * 5,
    parameters: JSON.stringify({ taskIds: record.taskIds }),
  });
  return id;
}

export async function getBatchOperation(jobId: string): Promise<BatchOperationRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(batchOperations).where(eq(batchOperations.id, jobId)).limit(1);
  return row ? mapBatchOperationRow(row) : null;
}

const batchUpdateColumns = {
  status: batchOperations.status,
  progress: batchOperations.progress,
  completedTasks: batchOperations.completedTasks,
  failedTasks: batchOperations.failedTasks,
  currentTaskIndex: batchOperations.currentTaskIndex,
  currentTaskName: batchOperations.currentTaskName,
  estimatedTimeSeconds: batchOperations.estimatedTimeSeconds,
  results: batchOperations.results,
  errorLog: batchOperations.errorLog,
  startedAt: batchOperations.startedAt,
  completedAt: batchOperations.completedAt,
  elapsedTimeSeconds: batchOperations.elapsedTimeSeconds,
} as const;

export async function updateBatchOperation(jobId: string, updates: Partial<BatchOperationRecord>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const setValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!Object.hasOwn(batchUpdateColumns, key)) continue;
    if (key === 'results' || key === 'errorLog') {
      setValues[key] = typeof value === 'string' ? value : value == null ? null : JSON.stringify(value);
    } else if (key === 'progress') {
      setValues[key] = value == null ? null : String(value);
    } else {
      setValues[key] = value;
    }
  }
  if (Object.keys(setValues).length === 0) return;

  await db.update(batchOperations)
    .set(setValues as Partial<typeof batchOperations.$inferInsert>)
    .where(eq(batchOperations.id, jobId));
}

export async function cancelBatchOperation(jobId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.update(batchOperations).set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(batchOperations.id, jobId));
}

export async function getBatchOperationHistory(userId: string, limit: number = 50): Promise<BatchOperationRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 50, 1000));
  const rows = await db.select().from(batchOperations)
    .where(eq(batchOperations.userId, userId))
    .orderBy(desc(batchOperations.createdAt))
    .limit(safeLimit);
  return rows.map(mapBatchOperationRow);
}

function parseJsonObject(value: unknown): Record<string, any> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: unknown): any[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mapBatchOperationRow(row: typeof batchOperations.$inferSelect): BatchOperationRecord {
  const parameters = parseJsonObject(row.parameters);
  const taskIds = Array.isArray(parameters?.taskIds)
    ? parameters.taskIds.filter((value: unknown): value is string => typeof value === 'string')
    : [];

  return {
    id: row.id,
    userId: row.userId,
    operationType: row.operationType as BatchOperationRecord['operationType'],
    taskIds,
    description: row.description ?? undefined,
    status: row.status as BatchOperationRecord['status'],
    progress: Number(row.progress || 0),
    completedTasks: row.completedTasks,
    failedTasks: row.failedTasks,
    currentTaskIndex: row.currentTaskIndex ?? 0,
    currentTaskName: row.currentTaskName ?? undefined,
    estimatedTimeSeconds: row.estimatedTimeSeconds ?? undefined,
    results: parseJsonObject(row.results),
    errorLog: parseJsonArray(row.errorLog),
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    elapsedTimeSeconds: row.elapsedTimeSeconds ?? undefined,
  };
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

export interface KeyboardShortcutRecord {
  id: number;
  userId: string;
  shortcutKey: string;
  action: string;
  description?: string;
  isCustom: boolean;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function mapKeyboardShortcut(row: typeof keyboardShortcuts.$inferSelect): KeyboardShortcutRecord {
  return {
    id: Number(row.id),
    userId: row.userId,
    shortcutKey: row.shortcutKey,
    action: row.action,
    description: row.description ?? undefined,
    isCustom: Number(row.isCustom) !== 0,
    isEnabled: Number(row.isEnabled) !== 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createKeyboardShortcut(record: Omit<KeyboardShortcutRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const now = new Date();
  const [row] = await db.insert(keyboardShortcuts).values({
    userId: record.userId,
    shortcutKey: record.shortcutKey,
    action: record.action,
    description: record.description ?? null,
    isCustom: record.isCustom ? 1 : 0,
    isEnabled: record.isEnabled ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: keyboardShortcuts.id });
  return Number(row?.id ?? 0);
}

export async function getKeyboardShortcuts(userId: string): Promise<KeyboardShortcutRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(keyboardShortcuts)
    .where(eq(keyboardShortcuts.userId, userId))
    .orderBy(keyboardShortcuts.shortcutKey);
  return rows.map(mapKeyboardShortcut);
}

const keyboardShortcutUpdateColumns = {
  shortcutKey: keyboardShortcuts.shortcutKey,
  action: keyboardShortcuts.action,
  description: keyboardShortcuts.description,
  isCustom: keyboardShortcuts.isCustom,
  isEnabled: keyboardShortcuts.isEnabled,
} as const;

export async function updateKeyboardShortcut(id: number, updates: Partial<KeyboardShortcutRecord>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const setValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!Object.hasOwn(keyboardShortcutUpdateColumns, key)) continue;
    setValues[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  if (Object.keys(setValues).length === 0) return;
  setValues.updatedAt = new Date();
  await db.update(keyboardShortcuts)
    .set(setValues as Partial<typeof keyboardShortcuts.$inferInsert>)
    .where(eq(keyboardShortcuts.id, id));
}

export async function deleteKeyboardShortcut(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.delete(keyboardShortcuts).where(eq(keyboardShortcuts.id, id));
}

export async function upsertKeyboardShortcutForUser(
  userId: string,
  action: string,
  shortcutKey: string,
): Promise<void> {
  const shortcuts = await getKeyboardShortcuts(userId);
  const existing = shortcuts.find((shortcut) => shortcut.action === action);
  if (existing) {
    await updateKeyboardShortcut(existing.id, { shortcutKey, isCustom: true, isEnabled: true });
    return;
  }
  await createKeyboardShortcut({
    userId,
    action,
    shortcutKey,
    description: `Custom shortcut for ${action}`,
    isCustom: true,
    isEnabled: true,
  });
}

export async function getDefaultKeyboardShortcuts(): Promise<KeyboardShortcutRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(keyboardShortcuts)
    .where(eq(keyboardShortcuts.isCustom, 0))
    .orderBy(keyboardShortcuts.shortcutKey);
  return rows.map(mapKeyboardShortcut);
}

export async function seedDefaultKeyboardShortcuts(userId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const defaults = [
    { key: 'Ctrl+R', action: 'reschedule', description: 'Reschedule selected task' },
    { key: 'Ctrl+B', action: 'batch_reanalyze', description: 'Start batch re-analysis' },
    { key: 'Ctrl+U', action: 'undo_reschedule', description: 'Undo last reschedule' },
    { key: 'Ctrl+H', action: 'show_history', description: 'Show schedule history' },
    { key: 'Ctrl+K', action: 'show_shortcuts', description: 'Show keyboard shortcuts' },
    { key: 'Ctrl+/', action: 'toggle_help', description: 'Toggle help panel' },
    { key: 'Shift+N', action: 'next_task', description: 'Go to next task' },
    { key: 'Shift+P', action: 'previous_task', description: 'Go to previous task' },
    { key: 'Shift+C', action: 'complete_task', description: 'Mark task as complete' },
    { key: 'Shift+S', action: 'skip_task', description: 'Skip to next task' },
  ];
  const now = new Date();
  await db.insert(keyboardShortcuts).values(defaults.map((shortcut) => ({
    userId,
    shortcutKey: shortcut.key,
    action: shortcut.action,
    description: shortcut.description,
    isCustom: 0,
    isEnabled: 1,
    createdAt: now,
    updatedAt: now,
  })));
}

export async function getUserTasks(actor: ScheduleActor): Promise<ScheduledTaskRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const scope = await scheduleScope(db, actor);
  const rows = await db.select().from(taskAssignments).where(eq(taskAssignments.founderId, scope.founderId));
  assertCanonicalAssignmentRows(rows);
  return rows.filter(row => scope.profileId === null || row.vaId === scope.profileId).map(mapScheduledTask);
}

export async function getTasksByAssignee(
  actor: ScheduleActor,
  assignedTo: string | number,
): Promise<ScheduledTaskRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const vaId = Number.parseInt(String(assignedTo), 10);
  if (Number.isNaN(vaId)) return [];
  return (await getUserTasks(actor)).filter(row => row.vaId === vaId);
}
