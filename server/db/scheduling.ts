/**
 * Raw SQL Helper Module for Advanced Scheduling Tables
 * 
 * This module isolates raw SQL queries for the new scheduling tables:
 * - task_schedule_history
 * - batch_operations
 * - keyboard_shortcuts
 * 
 * Uses raw MySQL2 connection pool to bypass Drizzle ORM type issues.
 * TODO: Refactor to Drizzle ORM after schema migration
 */

import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

let pool: mysql.Pool | null = null;

async function getPool(): Promise<mysql.Pool | null> {
  if (pool) return pool;
  
  if (!process.env.DATABASE_URL) {
    console.warn('[SchedulingDB] DATABASE_URL not set');
    return null;
  }

  try {
    pool = mysql.createPool(process.env.DATABASE_URL);
    console.log('[SchedulingDB] Connection pool created');
    return pool;
  } catch (error) {
    console.error('[SchedulingDB] Failed to create pool:', error);
    return null;
  }
}

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
  role: string;
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

function actorScope(actor: ScheduleActor, alias = 'ta') {
  if (actor.role === 'worker') {
    return {
      join: `JOIN va_profiles actor_va ON ${alias}.vaId = actor_va.id`,
      clause: 'actor_va.userId = ?',
      value: actor.id,
    };
  }

  return {
    join: '',
    clause: `${alias}.founderId = ?`,
    value: actor.id,
  };
}

function mapScheduledTask(row: any): ScheduledTaskRecord {
  return {
    ...row,
    id: Number(row.id),
    vaId: Number(row.vaId),
    founderId: Number(row.founderId),
  };
}

export async function insertScheduleHistory(record: Omit<ScheduleHistoryRecord, 'id' | 'createdAt'>): Promise<string> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const id = uuidv4();
  const query = `
    INSERT INTO task_schedule_history (
      id, taskId, founderId, assignmentId, cardTrelloId, previousStartTime, previousEndTime,
      newStartTime, newEndTime, changedBy, reason, source,
      hadConflicts, conflictDetails, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
  `;

  const values = [
    id,
    record.taskId,
    record.founderId,
    record.assignmentId,
    record.cardTrelloId || null,
    record.previousStartTime || null,
    record.previousEndTime || null,
    record.newStartTime,
    record.newEndTime,
    record.changedBy,
    record.reason || null,
    record.source,
    record.hadConflicts ? 1 : 0,
    record.conflictDetails || null
  ];

  const connection = await pool.getConnection();
  try {
    await connection.execute(query, values);
    return id;
  } finally {
    connection.release();
  }
}

export async function getScheduleHistory(taskId: string, assignmentId: number, limit: number = 50): Promise<ScheduleHistoryRecord[]> {
  const pool = await getPool();
  if (!pool) return [];

  const query = `
    SELECT * FROM task_schedule_history 
    WHERE taskId = ? AND assignmentId = ?
    ORDER BY createdAt DESC 
    LIMIT ?
  `;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(query, [taskId, assignmentId, limit]);
    return (rows as any[]).map(row => ({
      ...row,
      hadConflicts: Boolean(row.hadConflicts)
    }));
  } finally {
    connection.release();
  }
}

export async function getScheduledTaskForActor(
  taskId: string,
  actor: ScheduleActor,
): Promise<ScheduledTaskRecord | null> {
  const pool = await getPool();
  if (!pool) return null;

  const scope = actorScope(actor);
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT ta.id, ta.taskId, ta.vaId, ta.founderId, ta.startTime, ta.endTime, ta.status
       FROM task_assignments ta
       ${scope.join}
       WHERE ta.taskId = ? AND ${scope.clause}
       LIMIT 1`,
      [taskId, scope.value],
    );
    const row = (rows as any[])[0];
    return row ? mapScheduledTask(row) : null;
  } finally {
    connection.release();
  }
}

export async function getScheduleActorByOpenId(openId: string): Promise<ScheduleActor | null> {
  const pool = await getPool();
  if (!pool) return null;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT id, openId, role FROM users WHERE openId = ? LIMIT 1`,
      [openId],
    );
    const row = (rows as any[])[0];
    if (!row) return null;
    return { id: Number(row.id), openId: String(row.openId), role: String(row.role) };
  } finally {
    connection.release();
  }
}

export async function getScheduleHistoryForActor(
  taskId: string,
  actor: ScheduleActor,
  limit: number = 50,
): Promise<ScheduleHistoryRecord[] | null> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 50, 200));
  const scope = actorScope(actor);
  const connection = await pool.getConnection();
  try {
    const [ownedRows] = await connection.execute(
      `SELECT ta.id, ta.founderId, ta.vaId, ta.taskId, ta.startTime, ta.endTime, ta.status
       FROM task_assignments ta
       ${scope.join}
       WHERE ta.taskId = ? AND ${scope.clause}
       LIMIT 1`,
      [taskId, scope.value],
    );
    const assignmentRow = (ownedRows as any[])[0];
    if (!assignmentRow) return null;
    const assignment = mapScheduledTask(assignmentRow);

    const [rows] = await connection.query(
      `SELECT * FROM task_schedule_history
       WHERE taskId = ? AND assignmentId = ?
       ORDER BY createdAt DESC
       LIMIT ${safeLimit}`,
      [taskId, assignment.id],
    );
    return (rows as any[]).map((row) => ({
      ...row,
      hadConflicts: Boolean(row.hadConflicts),
    }));
  } finally {
    connection.release();
  }
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
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const scope = actorScope(actor);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT ta.id, ta.taskId, ta.vaId, ta.founderId, ta.startTime, ta.endTime, ta.status
       FROM task_assignments ta
       ${scope.join}
       WHERE ta.taskId = ? AND ${scope.clause}
       LIMIT 1
       FOR UPDATE`,
      [taskId, scope.value],
    );
    const row = (rows as any[])[0];
    if (!row) {
      await connection.rollback();
      return null;
    }

    const assignment = mapScheduledTask(row);
    await connection.execute(
      `UPDATE task_assignments
       SET startTime = ?, endTime = ?, updatedAt = NOW()
       WHERE id = ?`,
      [newStartTime, newEndTime, assignment.id],
    );

    const historyId = uuidv4();
    await connection.execute(
      `INSERT INTO task_schedule_history (
        id, taskId, founderId, assignmentId, cardTrelloId, previousStartTime, previousEndTime,
        newStartTime, newEndTime, changedBy, reason, source,
        hadConflicts, conflictDetails, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        historyId,
        assignment.taskId,
        assignment.founderId,
        assignment.id,
        options.cardTrelloId || assignment.taskId.split(':')[0] || null,
        assignment.startTime || null,
        assignment.endTime || null,
        newStartTime,
        newEndTime,
        actor.openId,
        options.reason || 'Manual reschedule',
        options.source || 'manual',
        options.hadConflicts ? 1 : 0,
        options.conflictDetails || null,
      ],
    );
    await connection.commit();

    return {
      historyId,
      taskId: assignment.taskId,
      cardTrelloId: options.cardTrelloId || assignment.taskId.split(':')[0],
      previousStartTime: assignment.startTime,
      previousEndTime: assignment.endTime,
      newStartTime,
      newEndTime,
      vaId: assignment.vaId,
    };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function undoLastRescheduleForActor(
  actor: ScheduleActor,
  taskId: string,
): Promise<RescheduleResult | null> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const scope = actorScope(actor);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [assignmentRows] = await connection.execute(
      `SELECT ta.id, ta.taskId, ta.vaId, ta.founderId, ta.startTime, ta.endTime, ta.status
       FROM task_assignments ta
       ${scope.join}
       WHERE ta.taskId = ? AND ${scope.clause}
       LIMIT 1
       FOR UPDATE`,
      [taskId, scope.value],
    );
    const assignmentRow = (assignmentRows as any[])[0];
    if (!assignmentRow) {
      await connection.rollback();
      return null;
    }
    const assignment = mapScheduledTask(assignmentRow);

    const [historyRows] = await connection.execute(
      `SELECT * FROM task_schedule_history
       WHERE taskId = ? AND assignmentId = ?
       ORDER BY createdAt DESC
       LIMIT 1
       FOR UPDATE`,
      [assignment.taskId, assignment.id],
    );
    const previous = (historyRows as any[])[0];
    if (!previous?.previousStartTime || !previous?.previousEndTime) {
      await connection.rollback();
      return null;
    }

    const restoredStartTime = new Date(previous.previousStartTime);
    const restoredEndTime = new Date(previous.previousEndTime);
    await connection.execute(
      `UPDATE task_assignments
       SET startTime = ?, endTime = ?, updatedAt = NOW()
       WHERE id = ?`,
      [restoredStartTime, restoredEndTime, assignment.id],
    );

    const historyId = uuidv4();
    await connection.execute(
      `INSERT INTO task_schedule_history (
        id, taskId, founderId, assignmentId, cardTrelloId, previousStartTime, previousEndTime,
        newStartTime, newEndTime, changedBy, reason, source,
        hadConflicts, conflictDetails, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Undo reschedule', 'manual', 0, NULL, NOW())`,
      [
        historyId,
        assignment.taskId,
        assignment.founderId,
        assignment.id,
        previous.cardTrelloId || assignment.taskId.split(':')[0] || null,
        assignment.startTime || null,
        assignment.endTime || null,
        restoredStartTime,
        restoredEndTime,
        actor.openId,
      ],
    );
    await connection.commit();

    return {
      historyId,
      taskId: assignment.taskId,
      cardTrelloId: previous.cardTrelloId || assignment.taskId.split(':')[0],
      previousStartTime: assignment.startTime,
      previousEndTime: assignment.endTime,
      newStartTime: restoredStartTime,
      newEndTime: restoredEndTime,
      vaId: assignment.vaId,
    };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
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
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const id = uuidv4();
  const query = `
    INSERT INTO batch_operations (
      id, userId, operationType, description, totalTasks, status, progress,
      completedTasks, failedTasks, currentTaskIndex, estimatedTimeSeconds,
      parameters, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, 0, 0, ?, ?, NOW(), NOW())
  `;

  const values = [
    id,
    record.userId,
    record.operationType,
    record.description || `Batch ${record.operationType}`,
    record.taskIds.length,
    record.taskIds.length * 5,
    JSON.stringify({ taskIds: record.taskIds })
  ];

  const connection = await pool.getConnection();
  try {
    await connection.execute(query, values);
    return id;
  } finally {
    connection.release();
  }
}

export async function getBatchOperation(jobId: string): Promise<BatchOperationRecord | null> {
  const pool = await getPool();
  if (!pool) return null;

  const query = `SELECT * FROM batch_operations WHERE id = ?`;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(query, [jobId]);
    const row = (rows as any[])[0];
    if (!row) return null;

    return mapBatchOperationRow(row);
  } finally {
    connection.release();
  }
}

export async function updateBatchOperation(jobId: string, updates: Partial<BatchOperationRecord>): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const allowedFields = ['status', 'progress', 'completedTasks', 'failedTasks', 'currentTaskIndex', 'currentTaskName', 'estimatedTimeSeconds', 'results', 'errorLog', 'startedAt', 'completedAt', 'elapsedTimeSeconds'];
  const setClauses: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      if (key === 'results' || key === 'errorLog') {
        values.push(typeof value === 'string' ? value : JSON.stringify(value));
      } else {
        values.push(value);
      }
    }
  }

  if (setClauses.length === 0) return;

  values.push(jobId);
  const query = `UPDATE batch_operations SET ${setClauses.join(', ')} WHERE id = ?`;

  const connection = await pool.getConnection();
  try {
    await connection.execute(query, values);
  } finally {
    connection.release();
  }
}

export async function cancelBatchOperation(jobId: string): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const query = `UPDATE batch_operations SET status = 'cancelled', completedAt = NOW() WHERE id = ?`;

  const connection = await pool.getConnection();
  try {
    await connection.execute(query, [jobId]);
  } finally {
    connection.release();
  }
}

export async function getBatchOperationHistory(userId: string, limit: number = 50): Promise<BatchOperationRecord[]> {
  const pool = await getPool();
  if (!pool) return [];

  const safeLimit = Math.max(1, Math.min(parseInt(String(limit)), 1000));

  const query = `
    SELECT * FROM batch_operations 
    WHERE userId = ? 
    ORDER BY createdAt DESC 
    LIMIT ${safeLimit}
  `;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(query, [userId]);
    return (rows as any[]).map(mapBatchOperationRow);
  } finally {
    connection.release();
  }
}

function parseJsonObject(value: unknown): Record<string, any> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    return value as Record<string, any>;
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
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

function mapBatchOperationRow(row: any): BatchOperationRecord {
  const parameters = parseJsonObject(row.parameters);
  const taskIds = Array.isArray(parameters?.taskIds)
    ? parameters.taskIds.filter((value: unknown): value is string => typeof value === 'string')
    : [];

  return {
    ...row,
    progress: Number(row.progress || 0),
    taskIds,
    results: parseJsonObject(row.results),
    errorLog: parseJsonArray(row.errorLog),
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

export async function createKeyboardShortcut(record: Omit<KeyboardShortcutRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const query = `
    INSERT INTO keyboard_shortcuts (
      userId, shortcutKey, action, description, isCustom, isEnabled, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
  `;

  const values = [
    record.userId,
    record.shortcutKey,
    record.action,
    record.description || null,
    record.isCustom ? 1 : 0,
    record.isEnabled ? 1 : 0
  ];

  const connection = await pool.getConnection();
  try {
    const [result] = await connection.execute(query, values);
    return (result as any).insertId || 0;
  } finally {
    connection.release();
  }
}

export async function getKeyboardShortcuts(userId: string): Promise<KeyboardShortcutRecord[]> {
  const pool = await getPool();
  if (!pool) return [];

  const query = `
    SELECT * FROM keyboard_shortcuts 
    WHERE userId = ? 
    ORDER BY shortcutKey
  `;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(query, [userId]);
    return (rows as any[]).map(row => ({
      ...row,
      isCustom: Boolean(row.isCustom),
      isEnabled: Boolean(row.isEnabled)
    }));
  } finally {
    connection.release();
  }
}

export async function updateKeyboardShortcut(id: number, updates: Partial<KeyboardShortcutRecord>): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const allowedFields = ['shortcutKey', 'action', 'description', 'isCustom', 'isEnabled'];
  const setClauses: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      if (typeof value === 'boolean') {
        values.push(value ? 1 : 0);
      } else {
        values.push(value);
      }
    }
  }

  if (setClauses.length === 0) return;

  setClauses.push('updatedAt = NOW()');
  values.push(id);

  const query = `UPDATE keyboard_shortcuts SET ${setClauses.join(', ')} WHERE id = ?`;

  const connection = await pool.getConnection();
  try {
    await connection.execute(query, values);
  } finally {
    connection.release();
  }
}

export async function deleteKeyboardShortcut(id: number): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

  const query = `DELETE FROM keyboard_shortcuts WHERE id = ?`;

  const connection = await pool.getConnection();
  try {
    await connection.execute(query, [id]);
  } finally {
    connection.release();
  }
}

export async function upsertKeyboardShortcutForUser(
  userId: string,
  action: string,
  shortcutKey: string
): Promise<void> {
  const shortcuts = await getKeyboardShortcuts(userId);
  const existing = shortcuts.find(shortcut => shortcut.action === action);

  if (existing) {
    await updateKeyboardShortcut(existing.id, {
      shortcutKey,
      isCustom: true,
      isEnabled: true,
    });
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
  const pool = await getPool();
  if (!pool) return [];

  const query = `
    SELECT * FROM keyboard_shortcuts 
    WHERE isCustom = 0 
    ORDER BY shortcutKey
  `;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(query, []);
    return (rows as any[]).map(row => ({
      ...row,
      isCustom: Boolean(row.isCustom),
      isEnabled: Boolean(row.isEnabled)
    }));
  } finally {
    connection.release();
  }
}

export async function seedDefaultKeyboardShortcuts(userId: string): Promise<void> {
  const pool = await getPool();
  if (!pool) throw new Error('Database not available');

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
    { key: 'Shift+S', action: 'skip_task', description: 'Skip to next task' }
  ];

  const query = `
    INSERT INTO keyboard_shortcuts (
      userId, shortcutKey, action, description, isCustom, isEnabled, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, 0, 1, NOW(), NOW())
  `;

  const connection = await pool.getConnection();
  try {
    for (const shortcut of defaults) {
      await connection.execute(query, [userId, shortcut.key, shortcut.action, shortcut.description]);
    }
  } finally {
    connection.release();
  }
}

export async function getUserTasks(actor: ScheduleActor): Promise<ScheduledTaskRecord[]> {
  const pool = await getPool();
  if (!pool) return [];

  const scope = actorScope(actor);
  const query = `
    SELECT ta.id, ta.taskId, ta.vaId, ta.founderId, ta.startTime, ta.endTime, ta.status
    FROM task_assignments ta
    ${scope.join}
    WHERE ${scope.clause}
  `;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(query, [scope.value]);
    return (rows as any[]).map(mapScheduledTask);
  } finally {
    connection.release();
  }
}

export async function getTasksByAssignee(
  actor: ScheduleActor,
  assignedTo: string | number,
): Promise<ScheduledTaskRecord[]> {
  const pool = await getPool();
  if (!pool) return [];

  const vaId = parseInt(String(assignedTo), 10);
  if (isNaN(vaId)) return [];

  const scope = actorScope(actor);
  const query = `
    SELECT ta.id, ta.taskId, ta.vaId, ta.founderId, ta.startTime, ta.endTime, ta.status
    FROM task_assignments ta
    ${scope.join}
    WHERE ta.vaId = ? AND ${scope.clause}
  `;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(query, [vaId, scope.value]);
    return (rows as any[]).map(mapScheduledTask);
  } finally {
    connection.release();
  }
}
