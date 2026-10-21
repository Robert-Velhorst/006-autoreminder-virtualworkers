/**
 * Conflict Resolution Service
 * Automatically resolves scheduling conflicts
 */

import { getDb } from "../db";
import {
  taskAssignments,
  taskScheduleHistory,
  users,
} from "../../drizzle/schema.postgres";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { log } from "../utils/logger";
import { invalidateCache } from "./trello-cache";
import {
  AssignmentError,
  MAX_ASSIGNMENT_TASKS,
  assertCanonicalAssignmentRows,
  readCanonicalAssignments,
  type TaskAssignment,
} from "../taskAssignmentMutation";

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
    throw new Error("Database not available");
  }

  const [actor] = await db.select().from(users).where(eq(users.id, userId));
  if (actor?.role !== "admin" || actor.openId !== userOpenId) {
    throw new AssignmentError(
      403,
      "Administrator access required",
      "ASSIGNMENT_FORBIDDEN"
    );
  }
  const assignments = await db
    .select()
    .from(taskAssignments)
    .where(eq(taskAssignments.founderId, userId));

  return conflictsForAssignments(assignments);
}

function conflictsForAssignments(
  assignments: TaskAssignment[]
): ScheduleConflict[] {
  assertCanonicalAssignmentRows(assignments);

  const conflicts: ScheduleConflict[] = [];

  // Check for overlapping time slots
  for (let i = 0; i < assignments.length; i++) {
    const task1 = assignments[i];
    if (!task1.startTime || !task1.endTime) continue;

    for (let j = i + 1; j < assignments.length; j++) {
      const task2 = assignments[j];
      if (task1.vaId !== task2.vaId) continue;
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
  strategy: "move_later" | "compress" | "next_day" = "move_later"
): Promise<ConflictResolutionResult> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  if (!["move_later", "next_day", "compress"].includes(strategy)) {
    throw new AssignmentError(
      400,
      "Invalid conflict resolution strategy",
      "ASSIGNMENT_INPUT"
    );
  }
  const result = await db.transaction(async tx => {
    // The shared assignment service locks accounts before assignment identities.
    // Holding the founder account also serializes discovery with its mutations.
    const [actor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update");
    if (actor?.role !== "admin" || actor.openId !== userOpenId) {
      throw new AssignmentError(
        403,
        "Administrator access required",
        "ASSIGNMENT_FORBIDDEN"
      );
    }
    const observed = await tx
      .select()
      .from(taskAssignments)
      .where(eq(taskAssignments.founderId, userId));
    assertCanonicalAssignmentRows(observed);
    const keys = [...new Set(observed.map(row => row.taskId))].sort();
    const assignments: TaskAssignment[] = [];
    // The founder account remains held across every globally ordered batch.
    for (let offset = 0; offset < keys.length; offset += MAX_ASSIGNMENT_TASKS) {
      assignments.push(...await readCanonicalAssignments(tx, userId,
        keys.slice(offset, offset + MAX_ASSIGNMENT_TASKS), { lock: true }));
    }
    if (assignments.length !== observed.length)
      throw new AssignmentError(
        409,
        "Assignments changed; reload before trying again"
      );
    const conflicts = conflictsForAssignments(assignments);
    const resolutions: ConflictResolutionResult["resolutions"] = [];
    let resolved = 0;
    let failed = 0;

    log.info("Starting conflict resolution", {
      userId: userOpenId,
      conflictCount: conflicts.length,
      strategy,
    });

    for (const conflict of conflicts) {
      const assignment = assignments.find(
        row => row.taskId === conflict.taskId
      )!;
      const conflicting = assignments.find(
        row => row.taskId === conflict.conflictingTaskId
      )!;
      // Earlier moves in this transaction may already have removed this overlap.
      if (
        new Date(assignment.startTime!).getTime() >=
          new Date(conflicting.endTime!).getTime() ||
        new Date(assignment.endTime!).getTime() <=
          new Date(conflicting.startTime!).getTime()
      )
        continue;
      const oldStartTime = new Date(assignment.startTime!);
      const oldEndTime = new Date(assignment.endTime!);

      let newStartTime: Date;
      let newEndTime: Date;

      switch (strategy) {
        case "move_later":
          // Move task to end of conflicting task
          newStartTime = new Date(conflicting.endTime!);
          const duration = oldEndTime.getTime() - oldStartTime.getTime();
          newEndTime = new Date(newStartTime.getTime() + duration);
          break;

        case "next_day":
          // Move task to next day at same time
          newStartTime = new Date(oldStartTime);
          newStartTime.setDate(newStartTime.getDate() + 1);
          newEndTime = new Date(oldEndTime);
          newEndTime.setDate(newEndTime.getDate() + 1);
          break;

        case "compress":
          // No compression algorithm exists; do not claim a successful repair.
          failed++;
          continue;

        default:
          newStartTime = oldStartTime;
          newEndTime = oldEndTime;
      }

      // Moving past the original partner can collide with a previously disjoint
      // task. Find a genuinely free slot against the entire locked schedule.
      const duration = oldEndTime.getTime() - oldStartTime.getTime();
      const scheduledOthers = assignments.filter(row => row.id !== assignment.id && row.vaId === assignment.vaId && row.startTime && row.endTime)
        .sort((a, b) => a.startTime!.getTime() - b.startTime!.getTime());
      for (const other of scheduledOthers) {
        if (newStartTime.getTime() >= other.endTime!.getTime()
          || newEndTime.getTime() <= other.startTime!.getTime()) continue;
        if (strategy === 'next_day') {
          newStartTime = new Date(newStartTime);
          do {
            const days = Math.max(1, Math.ceil((other.endTime!.getTime() - newStartTime.getTime()) / 86_400_000));
            newStartTime.setDate(newStartTime.getDate() + days);
          } while (newStartTime.getTime() < other.endTime!.getTime());
        } else {
          newStartTime = new Date(other.endTime!);
        }
        newEndTime = new Date(newStartTime.getTime() + duration);
      }

      // Update task assignment
      const [updated] = await tx
        .update(taskAssignments)
        .set({
          startTime: newStartTime,
          endTime: newEndTime,
          updatedAt: new Date(),
        })
        .where(eq(taskAssignments.id, assignment.id))
        .returning();
      if (!updated)
        throw new AssignmentError(
          409,
          "Assignment changed; reload before trying again"
        );

      // Record in schedule history
      await tx.insert(taskScheduleHistory).values({
        id: nanoid(),
        founderId: userId,
        assignmentId: assignment.id,
        taskId: conflict.taskId,
        cardTrelloId: assignment.taskId.split(":")[0],
        previousStartTime: oldStartTime,
        previousEndTime: oldEndTime,
        newStartTime,
        newEndTime,
        changedBy: userOpenId,
        reason: "Automatic conflict resolution",
        source: "conflict_resolution",
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
      Object.assign(assignment, updated);
    }

    return { resolved, failed, conflicts, resolutions };
  });

  // Invalidate cache to reflect changes
  if (result.resolved) await invalidateCache(userId, userOpenId, "tasks");

  log.info("Conflict resolution completed", {
    userId: userOpenId,
    resolved: result.resolved,
    failed: result.failed,
    totalConflicts: result.conflicts.length,
  });

  return result;
}

/**
 * Get conflict detection settings for a user
 */
export async function getConflictSettings(userId: number, userOpenId: string) {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const { conflictDetectionSettings } =
    await import("../../drizzle/schema.postgres");

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
