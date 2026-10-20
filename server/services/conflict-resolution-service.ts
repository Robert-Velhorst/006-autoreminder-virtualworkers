/**
 * Conflict Resolution Service
 * Automatically resolves scheduling conflicts
 */

import { getDb } from '../db';
import { taskAssignments, taskScheduleHistory } from '../../drizzle/schema.postgres';
import { eq, and, gte, lte, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { log } from '../utils/logger';
import { invalidateCache } from './trello-cache';

export interface ScheduleConflict {
  taskId: string;
  conflictingTaskId: string;
  overlapMinutes: number;
  taskStartTime: Date;
  taskEndTime: Date;
  conflictingStartTime: Date;
  conflictingEndTime: Date;
}

export interface ConflictResolutionResult {
  resolved: number;
  failed: number;
  conflicts: ScheduleConflict[];
  resolutions: Array<{
    taskId: string;
    oldStartTime: Date;
    oldEndTime: Date;
    newStartTime: Date;
    newEndTime: Date;
    strategy: string;
  }>;
}

/**
 * Detect scheduling conflicts for a user
 */
export async function detectConflicts(
  userId: number,
  userOpenId: string
): Promise<ScheduleConflict[]> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  // Get all task assignments with schedules
  const assignments = await db
    .select()
    .from(taskAssignments)
    .where(eq(taskAssignments.founderId, userId));

  const conflicts: ScheduleConflict[] = [];

  // Check for overlapping time slots
  for (let i = 0; i < assignments.length; i++) {
    const task1 = assignments[i];
    if (!task1.startTime || !task1.endTime) continue;

    for (let j = i + 1; j < assignments.length; j++) {
      const task2 = assignments[j];
      if (!task2.startTime || !task2.endTime) continue;

      // Check if tasks overlap
      const task1Start = new Date(task1.startTime).getTime();
      const task1End = new Date(task1.endTime).getTime();
      const task2Start = new Date(task2.startTime).getTime();
      const task2End = new Date(task2.endTime).getTime();

      const hasOverlap =
        (task1Start < task2End && task1End > task2Start) ||
        (task2Start < task1End && task2End > task1Start);

      if (hasOverlap) {
        const overlapStart = Math.max(task1Start, task2Start);
        const overlapEnd = Math.min(task1End, task2End);
        const overlapMinutes = Math.round((overlapEnd - overlapStart) / 60000);

        conflicts.push({
          taskId: task1.taskId,
          conflictingTaskId: task2.taskId,
          overlapMinutes,
          taskStartTime: new Date(task1.startTime),
          taskEndTime: new Date(task1.endTime),
          conflictingStartTime: new Date(task2.startTime),
          conflictingEndTime: new Date(task2.endTime),
        });
      }
    }
  }

  return conflicts;
}

/**
 * Resolve conflicts by moving tasks to next available slot
 */
export async function resolveConflicts(
  userId: number,
  userOpenId: string,
  strategy: 'move_later' | 'compress' | 'next_day' = 'move_later'
): Promise<ConflictResolutionResult> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const conflicts = await detectConflicts(userId, userOpenId);
  const resolutions: ConflictResolutionResult['resolutions'] = [];
  let resolved = 0;
  let failed = 0;

  log.info('Starting conflict resolution', {
    userId: userOpenId,
    conflictCount: conflicts.length,
    strategy,
  });

  for (const conflict of conflicts) {
    try {
      // Get the task assignment
      const assignments = await db
        .select()
        .from(taskAssignments)
        .where(
          and(
            eq(taskAssignments.founderId, userId),
            eq(taskAssignments.taskId, conflict.taskId)
          )
        )
        .limit(1);

      if (assignments.length === 0) {
        failed++;
        continue;
      }

      const assignment = assignments[0];
      const oldStartTime = new Date(assignment.startTime!);
      const oldEndTime = new Date(assignment.endTime!);

      let newStartTime: Date;
      let newEndTime: Date;

      switch (strategy) {
        case 'move_later':
          // Move task to end of conflicting task
          newStartTime = new Date(conflict.conflictingEndTime);
          const duration = oldEndTime.getTime() - oldStartTime.getTime();
          newEndTime = new Date(newStartTime.getTime() + duration);
          break;

        case 'next_day':
          // Move task to next day at same time
          newStartTime = new Date(oldStartTime);
          newStartTime.setDate(newStartTime.getDate() + 1);
          newEndTime = new Date(oldEndTime);
          newEndTime.setDate(newEndTime.getDate() + 1);
          break;

        case 'compress':
          // Try to compress task duration (not implemented yet)
          newStartTime = oldStartTime;
          newEndTime = oldEndTime;
          break;

        default:
          newStartTime = oldStartTime;
          newEndTime = oldEndTime;
      }

      // Update task assignment
      await db
        .update(taskAssignments)
        .set({
          startTime: newStartTime,
          endTime: newEndTime,
          updatedAt: new Date(),
        })
        .where(eq(taskAssignments.id, assignment.id));

      // Record in schedule history
      await db.insert(taskScheduleHistory).values({
        id: nanoid(),
        taskId: conflict.taskId,
        cardTrelloId: assignment.taskId.split(':')[0],
        previousStartTime: oldStartTime,
        previousEndTime: oldEndTime,
        newStartTime,
        newEndTime,
        changedBy: userOpenId,
        reason: 'Automatic conflict resolution',
        source: 'conflict_resolution',
        hadConflicts: 1,
        conflictDetails: JSON.stringify([conflict]),
        createdAt: new Date(),
      });

      resolutions.push({
        taskId: conflict.taskId,
        oldStartTime,
        oldEndTime,
        newStartTime,
        newEndTime,
        strategy,
      });

      resolved++;

      log.debug('Conflict resolved', {
        taskId: conflict.taskId,
        strategy,
        oldTime: `${oldStartTime.toISOString()} - ${oldEndTime.toISOString()}`,
        newTime: `${newStartTime.toISOString()} - ${newEndTime.toISOString()}`,
      });
    } catch (error) {
      log.error('Failed to resolve conflict', error as Error, {
        taskId: conflict.taskId,
      });
      failed++;
    }
  }

  // Invalidate cache to reflect changes
  await invalidateCache(userId, userOpenId, 'tasks');

  log.info('Conflict resolution completed', {
    userId: userOpenId,
    resolved,
    failed,
    totalConflicts: conflicts.length,
  });

  return {
    resolved,
    failed,
    conflicts,
    resolutions,
  };
}

/**
 * Get conflict detection settings for a user
 */
export async function getConflictSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const { conflictDetectionSettings } = await import('../../drizzle/schema.postgres');

  const settings = await db
    .select()
    .from(conflictDetectionSettings)
    .where(eq(conflictDetectionSettings.userId, userId))
    .limit(1);

  if (settings.length === 0) {
    // Return default settings
    return {
      enabled: true,
      warningThresholdMinutes: 15,
      autoResolve: false,
      notifyOnConflict: true,
      conflictTypes: {
        timeOverlap: true,
        resourceConflict: true,
        dependencyConflict: true,
      },
    };
  }

  const setting = settings[0];
  return {
    enabled: setting.enabled === 1,
    warningThresholdMinutes: setting.warningThresholdMinutes,
    autoResolve: setting.autoResolve === 1,
    notifyOnConflict: setting.notifyOnConflict === 1,
    conflictTypes: JSON.parse(setting.conflictTypes),
  };
}
