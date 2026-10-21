import { encodeTrelloPathSegment } from '../utils/trello-path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db';
import { generationJobs, generationItems, scheduledJobs, userWorkingHours, holidays, vaProfiles, taskAssignments, taskDependencies, clients, users } from '../../drizzle/schema.postgres';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { fetchWithRetry } from '../utils/retry';
import { getCachedTasks, setCachedTasks, invalidateCache } from '../services/trello-cache';
import { requestQueue } from '../services/request-queue';
import { parseAPTLSSItem, parseAPTLSSChecklist } from '../utils/aptlss-parser';
import { requestUser, requireAuthenticated } from '../middleware/auth';
import {
  fetchAptlssSourceCard,
  generateAptlssForCard,
} from '../services/aptlss-generation';
import { executeAptlssGenerationBatch } from '../services/aptlss-scheduled-generation';
import { AssignmentError, MAX_ASSIGNMENT_TASKS, assignmentFailure, readCanonicalAssignments } from '../taskAssignmentMutation';

export async function readSchedulingAssignmentSnapshot(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, founderId: number, taskIds: string[]) {
  if (!Number.isSafeInteger(founderId) || founderId <= 0) throw new AssignmentError(400, 'Invalid scheduling founder');
  const keys = [...new Set(taskIds)].sort();
  return db.transaction(async tx => {
    const read = async (lock: boolean) => {
      const rows: typeof taskAssignments.$inferSelect[] = [];
      for (let offset = 0; offset < keys.length; offset += MAX_ASSIGNMENT_TASKS) {
        rows.push(...await readCanonicalAssignments(tx, founderId, keys.slice(offset, offset + MAX_ASSIGNMENT_TASKS), { lock }));
      }
      return rows;
    };
    // Discover account IDs without trusting this initial view. Recheck the whole
    // identity under locks, before selecting by worker or operational status.
    const observed = await read(false);
    const profileIds = [...new Set(observed.map(row => row.vaId))];
    const discovered = profileIds.length ? await tx.select().from(vaProfiles).where(inArray(vaProfiles.id, profileIds)) : [];
    if (discovered.length !== profileIds.length) throw new AssignmentError(409, 'Assignment worker identity requires review');
    const accountIds = [...new Set([founderId, ...discovered.map(profile => profile.userId)])].sort((a, b) => a - b);
    const accounts = new Map<number, typeof users.$inferSelect>();
    for (const id of accountIds) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new AssignmentError(409, 'Assignment worker identity requires review');
      const [account] = await tx.select().from(users).where(eq(users.id, id)).for('no key update');
      if (account) accounts.set(id, account);
    }
    if (accounts.get(founderId)?.role !== 'admin') throw new AssignmentError(403, 'Scheduling account permissions changed; reload before trying again');
    const workerAccountIds = [...new Set(discovered.map(profile => profile.userId))];
    const profiles = workerAccountIds.length ? await tx.select().from(vaProfiles)
      .where(inArray(vaProfiles.userId, workerAccountIds)).orderBy(vaProfiles.id).for('update') : [];
    const verified = new Map<number, typeof vaProfiles.$inferSelect>();
    for (const original of discovered) {
      const active = profiles.filter(profile => profile.userId === original.userId && profile.status === 'active');
      if (accounts.get(original.userId)?.role !== 'worker' || active.length !== 1
        || active[0].id !== original.id || active[0].founderId !== founderId) {
        throw new AssignmentError(409, 'Assignment worker eligibility or ownership changed; reload before scheduling');
      }
      verified.set(original.id, active[0]);
    }
    const assignments = await read(true);
    if (assignments.some(row => !verified.has(row.vaId))) {
      throw new AssignmentError(409, 'Assignment ownership changed; reload before scheduling');
    }
    const currentProfileIds = new Set(assignments.map(row => row.vaId));
    return { assignments, workers: [...verified.values()].filter(profile => currentProfileIds.has(profile.id)) };
  });
}

export async function readSchedulingAssignments(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, founderId: number, taskIds: string[]) {
  return (await readSchedulingAssignmentSnapshot(db, founderId, taskIds)).assignments;
}

const router = Router();
const LEGACY_APTLSS_PREFIXES = ['/trello', '/aptlss'];

// This router is mounted at /api because it exposes both legacy Trello and
// APTLSS endpoints. Scope its guard to those prefixes so unrelated routes,
// especially the public tRPC auth.me query, can continue through Express.
router.use(LEGACY_APTLSS_PREFIXES, requireAuthenticated);
router.use(LEGACY_APTLSS_PREFIXES, (req, res, next) => {
  if (requestUser(req)?.role !== 'admin') {
    return res.status(403).json({ error: 'Legacy APTLSS administration requires an admin account' });
  }
  next();
});

const INACTIVE_LIST_KEYWORDS = ['done', 'completed', 'complete', 'archive', 'archived', 'info'];

// In-memory cache for board cards with TTL
interface CacheEntry {
  data: any[];
  timestamp: number;
}

const boardCardsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedBoardCards(boardId: string): any[] | null {
  const entry = boardCardsCache.get(boardId);
  if (!entry) return null;
  
  const now = Date.now();
  if (now - entry.timestamp > CACHE_TTL_MS) {
    boardCardsCache.delete(boardId);
    return null;
  }
  
  return entry.data;
}

function setCachedBoardCards(boardId: string, data: any[]): void {
  boardCardsCache.set(boardId, {
    data,
    timestamp: Date.now()
  });
}

function invalidateBoardCache(boardId: string): void {
  boardCardsCache.delete(boardId);
}

function clearExpiredCache(): void {
  const now = Date.now();
  const entriesToDelete: string[] = [];
  
  boardCardsCache.forEach((entry, boardId) => {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      entriesToDelete.push(boardId);
    }
  });
  
  entriesToDelete.forEach(boardId => boardCardsCache.delete(boardId));
}

// Clear expired cache every 5 minutes without keeping the process alive.
const cacheCleanupTimer = setInterval(clearExpiredCache, 5 * 60 * 1000);
cacheCleanupTimer.unref?.();

function isInactiveListName(listName?: string | null) {
  if (!listName) return false;
  const normalized = listName.toLowerCase().trim();
  return INACTIVE_LIST_KEYWORDS.some((keyword) => normalized === keyword || normalized.includes(keyword));
}

async function fetchUserWorkspaceBoards(apiKey: string, token: string) {
  const workspacesResponse = await fetchWithRetry(
    `https://api.trello.com/1/members/me/organizations?key=${apiKey}&token=${token}`,
    undefined,
    {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
    }
  );

  if (!workspacesResponse.ok) {
    const errorText = await workspacesResponse.text();
    throw new Error(`Failed to fetch workspaces from Trello: ${errorText}`);
  }

  const workspaces = await workspacesResponse.json();
  if (!Array.isArray(workspaces)) {
    throw new Error('Invalid Trello workspaces response');
  }

  const boards: any[] = [];

  for (const workspace of workspaces) {
    const boardsResponse = await fetchWithRetry(
      `https://api.trello.com/1/organizations/${workspace.id}/boards?filter=open&key=${apiKey}&token=${token}`,
      undefined,
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
      }
    );

    if (!boardsResponse.ok) {
      const errorText = await boardsResponse.text();
      console.warn(`[Trello] Failed to fetch boards for workspace ${workspace.displayName || workspace.name}:`, errorText);
      continue;
    }

    const workspaceBoards = await boardsResponse.json();
    if (!Array.isArray(workspaceBoards)) {
      continue;
    }

    for (const board of workspaceBoards) {
      // Skip template boards — they contain no real work cards
      if (board.prefs?.isTemplate === true) {
        continue;
      }
      boards.push({
        ...board,
        workspaceId: workspace.id,
        workspaceName: workspace.displayName || workspace.name || 'Unknown Workspace',
      });
    }
  }

  return boards;
}

async function fetchCardForAptlss(cardId: string) {
  if (!encodeTrelloPathSegment(cardId)) throw new Error("Invalid Trello card ID");
  return fetchAptlssSourceCard(cardId);
}

async function generateAptlssChecklist(card: any, settings: any) {
  return generateAptlssForCard(card, {
    ...(settings && typeof settings === 'object' ? settings : {}),
    applyToTrello: true,
  });
}

// Enhanced task scheduling algorithm with break times and task type optimization
export interface SchedulingOptions {
  workStartHour: number;
  workEndHour: number;
  workingDays: number[];
  holidays: string[];
  lunchBreakStart?: number;  // e.g., 12
  lunchBreakDuration?: number; // minutes (e.g., 60)
  breakfastBreakStart?: number; // e.g., 9 (optional)
  breakfastBreakDuration?: number; // minutes (e.g., 30)
  dinnerBreakStart?: number; // e.g., 18 (optional)
  dinnerBreakDuration?: number; // minutes (e.g., 30)
  shortBreakInterval?: number; // minutes between short breaks
  shortBreakDuration?: number; // minutes for short breaks
  // Weekly hours target (for scheduling optimization)
  weeklyHoursMin?: number; // e.g., 55
  weeklyHoursMax?: number; // e.g., 60
  // Daily hours flexibility (allows scheduling to vary day-to-day)
  dailyHoursMin?: number; // e.g., 9.5 hours
  dailyHoursMax?: number; // e.g., 11.5 hours
}

// FIXED VERSION - Prevents overbooking by enforcing daily capacity limits
// See SCHEDULING_ANALYSIS.md for detailed explanation of all 7 fixes
// Worker settings type for per-worker scheduling
export interface WorkerSettings {
  workStartHour: number;
  workEndHour: number;
  workingDays: number[];
  schedulingOptions: Partial<SchedulingOptions>;
}

export function scheduleTasksByTime(
  tasks: any[], 
  workStartHour: number = 9, 
  workEndHour: number = 18, 
  workingDays: number[] = [1, 2, 3, 4, 5], 
  userHolidays: string[] = [],
  options?: Partial<SchedulingOptions>,
  workerSettingsMap?: Map<number, WorkerSettings>
) {
  const breakFitsWorkWindow = (
    breakStart: number | undefined,
    breakDuration: number,
    startHour: number,
    endHour: number,
  ) => {
    if (!Number.isInteger(breakStart) || breakStart! < 0 || breakStart! > 23 || !Number.isFinite(breakDuration) || breakDuration <= 0) {
      return false;
    }
    const workStartMinutes = startHour * 60;
    const workEndMinutes = endHour * 60;
    const breakStartMinutes = breakStart! * 60;
    return breakStartMinutes >= workStartMinutes && breakStartMinutes + breakDuration <= workEndMinutes;
  };
  const breakMinutesWithinWorkWindow = (
    breaks: Array<readonly [number | undefined, number | undefined]>,
    startHour: number,
    endHour: number,
  ) => breaks.reduce((total, [breakStart, breakDuration]) => {
    const duration = breakDuration ?? 0;
    return breakFitsWorkWindow(breakStart, duration, startHour, endHour)
      ? total + duration
      : total;
  }, 0);

  // Working hours configurable per user
  const WORK_START_HOUR = workStartHour;
  const WORK_END_HOUR = workEndHour;
  const WORKING_DAYS = new Set(workingDays);
  
  // Break settings (defaults)
  const LUNCH_START = options?.lunchBreakStart ?? 12;
  const LUNCH_DURATION = options?.lunchBreakDuration ?? 60; // minutes
  const BREAKFAST_START = options?.breakfastBreakStart;
  const BREAKFAST_DURATION = options?.breakfastBreakDuration ?? 0;
  const DINNER_START = options?.dinnerBreakStart;
  const DINNER_DURATION = options?.dinnerBreakDuration ?? 0;
  
  const SHORT_BREAK_INTERVAL = options?.shortBreakInterval ?? 90;
  const SHORT_BREAK_DURATION = options?.shortBreakDuration ?? 10;
  
  // NEW: Flexible daily hours (configurable per user)
  // Default worker schedule: 55-60h/week, 9.5-11.5h/day
  const DAILY_HOURS_MIN = options?.dailyHoursMin ?? 9.5; // Default 9.5 hours minimum
  const DAILY_HOURS_MAX = options?.dailyHoursMax ?? 11.5; // Default 11.5 hours maximum
  const WEEKLY_HOURS_MIN = options?.weeklyHoursMin ?? 55; // Default 55 hours/week
  const WEEKLY_HOURS_MAX = options?.weeklyHoursMax ?? 60; // Default 60 hours/week

  // FIX #1: Calculate available capacity UPFRONT (accounting for all breaks)
  // Now uses flexible daily hours instead of fixed work start/end
  const TOTAL_BREAK_MINUTES = breakMinutesWithinWorkWindow([
    [LUNCH_START, LUNCH_DURATION],
    [BREAKFAST_START, BREAKFAST_DURATION],
    [DINNER_START, DINNER_DURATION],
  ], WORK_START_HOUR, WORK_END_HOUR);
  const TOTAL_WORK_MINUTES = (WORK_END_HOUR - WORK_START_HOUR) * 60;
  
  // Use DAILY_HOURS_MAX for maximum capacity per day (in minutes)
  // This replaces the old fixed calculation
  const MAX_DAILY_WORK_MINUTES = Math.round(DAILY_HOURS_MAX * 60);
  const MIN_DAILY_WORK_MINUTES = Math.round(DAILY_HOURS_MIN * 60);
  
  // Available work minutes is the minimum of: (work window - breaks) OR max daily hours
  const AVAILABLE_WORK_MINUTES = Math.min(TOTAL_WORK_MINUTES - TOTAL_BREAK_MINUTES, MAX_DAILY_WORK_MINUTES);
  
  console.log(`[Scheduling] Daily capacity: ${AVAILABLE_WORK_MINUTES} minutes (flexible: ${DAILY_HOURS_MIN}h-${DAILY_HOURS_MAX}h, weekly target: ${WEEKLY_HOURS_MIN}-${WEEKLY_HOURS_MAX}h)`);
  console.log(`[Scheduling] Work window: ${TOTAL_WORK_MINUTES}min - ${TOTAL_BREAK_MINUTES}min breaks = ${TOTAL_WORK_MINUTES - TOTAL_BREAK_MINUTES}min available`);

  // Group tasks by date AND worker (if assigned)
  // This allows worker-specific scheduling within the same day
  const tasksByDateAndWorker = new Map<string, any[]>();
  
  for (const task of tasks) {
    // Create a composite key: date|workerId (or date|default for unassigned)
    const workerId = (task as any).workerId;
    const key = workerId ? `${task.date}|worker_${workerId}` : `${task.date}|default`;
    
    if (!tasksByDateAndWorker.has(key)) {
      tasksByDateAndWorker.set(key, []);
    }
    tasksByDateAndWorker.get(key)!.push(task);
  }
  
  // Legacy grouping for backward compatibility (used in overflow logic)
  const tasksByDate = new Map<string, any[]>();
  for (const task of tasks) {
    if (!tasksByDate.has(task.date)) {
      tasksByDate.set(task.date, []);
    }
    tasksByDate.get(task.date)!.push(task);
  }

  // FIX #2: Separate scheduled and overflow tasks (not mixed in single array)
  const scheduledTasks: any[] = [];
  const overflowTasks: any[] = [];
  
  // Process tasks grouped by date AND worker for worker-specific scheduling
  for (const [compositeKey, dayTasks] of Array.from(tasksByDateAndWorker.entries())) {
    // Parse composite key: date|worker_X or date|default
    const [date, workerPart] = compositeKey.split('|');
    const workerId = workerPart.startsWith('worker_') ? parseInt(workerPart.replace('worker_', '')) : null;
    
    // Get worker-specific settings if available
    const workerSettings = workerId && workerSettingsMap ? workerSettingsMap.get(workerId) : null;
    
    // Use worker settings or fall back to defaults
    const effectiveWorkStart = workerSettings?.workStartHour ?? WORK_START_HOUR;
    const effectiveWorkEnd = workerSettings?.workEndHour ?? WORK_END_HOUR;
    const effectiveWorkingDays = workerSettings ? new Set(workerSettings.workingDays) : WORKING_DAYS;
    const effectiveOptions = workerSettings?.schedulingOptions ?? options;
    
    // Calculate effective break times for this worker
    const effectiveLunchStart = effectiveOptions?.lunchBreakStart ?? LUNCH_START;
    const effectiveLunchDuration = effectiveOptions?.lunchBreakDuration ?? LUNCH_DURATION;
    const effectiveBreakfastStart = effectiveOptions?.breakfastBreakStart ?? BREAKFAST_START;
    const effectiveBreakfastDuration = effectiveOptions?.breakfastBreakDuration ?? BREAKFAST_DURATION;
    const effectiveDinnerStart = effectiveOptions?.dinnerBreakStart ?? DINNER_START;
    const effectiveDinnerDuration = effectiveOptions?.dinnerBreakDuration ?? DINNER_DURATION;
    
    // Calculate effective daily capacity for this worker
    const effectiveTotalWorkMinutes = (effectiveWorkEnd - effectiveWorkStart) * 60;
    const effectiveTotalBreakMinutes = breakMinutesWithinWorkWindow([
      [effectiveLunchStart, effectiveLunchDuration],
      [effectiveBreakfastStart, effectiveBreakfastDuration],
      [effectiveDinnerStart, effectiveDinnerDuration],
    ], effectiveWorkStart, effectiveWorkEnd);
    const effectiveMaxDailyWorkMinutes = Math.round((effectiveOptions?.dailyHoursMax ?? DAILY_HOURS_MAX) * 60);
    const effectiveAvailableMinutes = Math.min(
      effectiveTotalWorkMinutes - effectiveTotalBreakMinutes,
      effectiveMaxDailyWorkMinutes,
    );
    
    if (workerSettings) {
      console.log(`[Scheduling] Worker ${workerId}: ${effectiveWorkStart}:00-${effectiveWorkEnd}:00, capacity: ${effectiveAvailableMinutes}min`);
    }
    
    const taskDate = new Date(date);
    const dayOfWeek = taskDate.getDay();
    const isHoliday = userHolidays.includes(date);
    
    // Skip non-working days (using worker-specific working days)
    if (!effectiveWorkingDays.has(dayOfWeek) || isHoliday) {
      const reason = isHoliday ? 'Holiday' : 'Non-working day';
      for (const task of dayTasks) {
        scheduledTasks.push({
          ...task,
          startTime: 'TBD',
          endTime: 'TBD',
          note: reason,
          workerId: workerId
        });
      }
      continue;
    }

    // Sort tasks by priority and type
    const sortedTasks = dayTasks.sort((a: any, b: any) => {
      // 1. First sort by Client Priority
      const clientPriorityOrder: Record<string, number> = { vip: 0, priority: 1, standard: 2 };
      const clientDiff = (clientPriorityOrder[a.clientPriority] ?? 2) - (clientPriorityOrder[b.clientPriority] ?? 2);
      if (clientDiff !== 0) return clientDiff;

      // 2. Then sort by Task Priority Level
      const priorityOrder: Record<string, number> = { CRITICAL: 0, URGENT: 1, HIGH: 2, NORMAL: 3 };
      const priorityDiff = (priorityOrder[a.priorityLevel] ?? 3) - (priorityOrder[b.priorityLevel] ?? 3);
      if (priorityDiff !== 0) return priorityDiff;
      
      const taskTypeOrder: Record<string, number> = {
        communication: 1,
        admin: 2,
        meeting: 3,
        creation: 4,
        research: 5,
        review: 6,
        other: 4
      };
      const typeA = taskTypeOrder[a.taskType] ?? 4;
      const typeB = taskTypeOrder[b.taskType] ?? 4;
      if (typeA !== typeB) return typeA - typeB;
      
      if (a.cardName !== b.cardName) return a.cardName.localeCompare(b.cardName);
      return a.stepIndex - b.stepIndex;
    });

    // FIX #3: Track cumulative scheduled time per day (using worker-specific capacity)
    let dailyScheduledMinutes = 0;
    let currentHour = effectiveWorkStart;
    let currentMinute = 0;
    let minutesSinceBreak = 0;
    
    // NEW: Cognitive Load Heuristic - track distinct tasks per day
    const scheduledCardNames = new Set<string>();
    const MAX_DISTINCT_TASKS_NORMAL = 4;
    const MAX_DISTINCT_TASKS_CRITICAL = 5;
    
    // Check if ANY task in this day is CRITICAL or URGENT (applies to all tasks)
    const hasCriticalOrUrgent = sortedTasks.some(t => t.priorityLevel === 'CRITICAL' || t.priorityLevel === 'URGENT');

    const toMinutes = (h: number, m: number) => h * 60 + m;
    
    // Use worker-specific meal break times
    const hasLunchBreak = breakFitsWorkWindow(effectiveLunchStart, effectiveLunchDuration, effectiveWorkStart, effectiveWorkEnd);
    const hasBreakfastBreak = breakFitsWorkWindow(effectiveBreakfastStart, effectiveBreakfastDuration, effectiveWorkStart, effectiveWorkEnd);
    const hasDinnerBreak = breakFitsWorkWindow(effectiveDinnerStart, effectiveDinnerDuration, effectiveWorkStart, effectiveWorkEnd);

    const isDuringLunch = (h: number, m: number) => {
      if (!hasLunchBreak) return false;
      const mins = toMinutes(h, m);
      const lunchEndMins = toMinutes(effectiveLunchStart, 0) + effectiveLunchDuration;
      return mins >= toMinutes(effectiveLunchStart, 0) && mins < lunchEndMins;
    };
    
    const isDuringBreakfast = (h: number, m: number) => {
      if (!hasBreakfastBreak || effectiveBreakfastStart === undefined) return false;
      const mins = toMinutes(h, m);
      const breakfastEndMins = toMinutes(effectiveBreakfastStart, 0) + effectiveBreakfastDuration;
      return mins >= toMinutes(effectiveBreakfastStart, 0) && mins < breakfastEndMins;
    };
    
    const isDuringDinner = (h: number, m: number) => {
      if (!hasDinnerBreak || effectiveDinnerStart === undefined) return false;
      const mins = toMinutes(h, m);
      const dinnerEndMins = toMinutes(effectiveDinnerStart, 0) + effectiveDinnerDuration;
      return mins >= toMinutes(effectiveDinnerStart, 0) && mins < dinnerEndMins;
    };
    
    const skipMealBreak = () => {
      if (isDuringBreakfast(currentHour, currentMinute) && effectiveBreakfastStart !== undefined) {
        const breakfastEndMins = toMinutes(effectiveBreakfastStart, 0) + effectiveBreakfastDuration;
        currentHour = Math.floor(breakfastEndMins / 60);
        currentMinute = breakfastEndMins % 60;
        minutesSinceBreak = 0;
      }
      if (isDuringLunch(currentHour, currentMinute)) {
        const lunchEndMins = toMinutes(effectiveLunchStart, 0) + effectiveLunchDuration;
        currentHour = Math.floor(lunchEndMins / 60);
        currentMinute = lunchEndMins % 60;
        minutesSinceBreak = 0;
      }
      if (isDuringDinner(currentHour, currentMinute) && effectiveDinnerStart !== undefined) {
        const dinnerEndMins = toMinutes(effectiveDinnerStart, 0) + effectiveDinnerDuration;
        currentHour = Math.floor(dinnerEndMins / 60);
        currentMinute = dinnerEndMins % 60;
        minutesSinceBreak = 0;
      }
    };

    for (const task of sortedTasks) {
      // Skip completed tasks
      if (task.isCompleted) {
        scheduledTasks.push({
          ...task,
          startTime: '--:--',
          endTime: '--:--',
          schedulingNote: 'Completed'
        });
        continue;
      }
      
      // Enforce dependencies: Check if blocked by incomplete tasks
      if (task.blockedBy && task.blockedBy.length > 0) {
        const incompleteBlockers = task.blockedBy.filter((blockerId: string) => {
          // Look up the blocker in our tasks list (either in scheduled or uncompleted)
          const blockerTask = tasks.find(t => t.id === blockerId);
          // If blocker exists and is NOT completed, this task is blocked
          return blockerTask && !blockerTask.isCompleted;
        });

        if (incompleteBlockers.length > 0) {
          overflowTasks.push({
            ...task,
            rejectionReason: `Blocked by incomplete task(s): ${incompleteBlockers.join(', ')}`
          });
          continue;
        }
      }

      skipMealBreak();
      
      // NEW: Cognitive Load Heuristic - check if adding this task would exceed distinct task limit
      const isNewCard = !scheduledCardNames.has(task.cardName);
      const maxDistinctTasks = hasCriticalOrUrgent 
        ? MAX_DISTINCT_TASKS_CRITICAL 
        : MAX_DISTINCT_TASKS_NORMAL;
      
      if (isNewCard && scheduledCardNames.size >= maxDistinctTasks) {
        // Would exceed cognitive load limit - reject this task
        overflowTasks.push({
          ...task,
          rejectionReason: `Cognitive load limit reached (${maxDistinctTasks} distinct tasks per day). Current: ${scheduledCardNames.size} tasks.`
        });
        continue;
      }
      
      // FIX #4: Check if short break fits in remaining capacity BEFORE adding it
      let breakMinutesNeeded = 0;
      if (minutesSinceBreak >= SHORT_BREAK_INTERVAL) {
        breakMinutesNeeded = SHORT_BREAK_DURATION;
        // Check if break + task would exceed capacity
        const taskMinutes = Math.ceil(task.durationHours * 60);
        if (dailyScheduledMinutes + breakMinutesNeeded + taskMinutes > effectiveAvailableMinutes) {
          // Task doesn't fit - REJECT it
          overflowTasks.push({
            ...task,
            rejectionReason: 'Insufficient capacity for break + task'
          });
          continue;
        }
        // Add break to scheduled time
        dailyScheduledMinutes += breakMinutesNeeded;
        currentMinute += breakMinutesNeeded;
        if (currentMinute >= 60) {
          currentHour += Math.floor(currentMinute / 60);
          currentMinute = currentMinute % 60;
        }
        minutesSinceBreak = 0;
        skipMealBreak();
      }

      // FIX #5: Calculate task duration and check against remaining capacity
      const taskMinutes = Math.ceil(task.durationHours * 60);
      
      // CRITICAL CHECK: Does task fit in remaining daily capacity? (using worker-specific capacity)
      if (dailyScheduledMinutes + taskMinutes > effectiveAvailableMinutes) {
        // Task doesn't fit - REJECT and move to overflow
        overflowTasks.push({
          ...task,
          rejectionReason: `Task duration (${taskMinutes}min) exceeds remaining capacity (${effectiveAvailableMinutes - dailyScheduledMinutes}min)`,
          workerId: workerId
        });
        continue;
      }

      // Calculate end time
      let endHour = currentHour;
      let endMinute = currentMinute + taskMinutes;

      if (endMinute >= 60) {
        endHour += Math.floor(endMinute / 60);
        endMinute = endMinute % 60;
      }
      
      // Check if task spans meal breaks and push to after if needed
      const startMins = toMinutes(currentHour, currentMinute);
      const endMins = toMinutes(endHour, endMinute);
      
      const checkAndPushPastMealBreak = (breakStart: number | undefined, breakDuration: number) => {
        if (!breakFitsWorkWindow(breakStart, breakDuration, effectiveWorkStart, effectiveWorkEnd) || breakStart === undefined) return false;
        const breakStartMins = toMinutes(breakStart, 0);
        const breakEndMins = breakStartMins + breakDuration;
        if (startMins < breakStartMins && endMins > breakStartMins) {
          // Task spans this break, push to after
          currentHour = Math.floor(breakEndMins / 60);
          currentMinute = breakEndMins % 60;
          endHour = currentHour;
          endMinute = currentMinute + taskMinutes;
          if (endMinute >= 60) {
            endHour += Math.floor(endMinute / 60);
            endMinute = endMinute % 60;
          }
          return true;
        }
        return false;
      };
      
      checkAndPushPastMealBreak(effectiveBreakfastStart, effectiveBreakfastDuration);
      checkAndPushPastMealBreak(effectiveLunchStart, effectiveLunchDuration);
      checkAndPushPastMealBreak(effectiveDinnerStart, effectiveDinnerDuration);

      // FIX #6: Final validation - does task fit in work hours?
      if (endHour > effectiveWorkEnd || (endHour === effectiveWorkEnd && endMinute > 0)) {
        // Task pushed past end time - REJECT
        overflowTasks.push({
          ...task,
          rejectionReason: `Task end time (${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}) exceeds work end time (${effectiveWorkEnd}:00)`
        });
        continue;
      }

      // Schedule the task
      const startTime = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
      const endTime = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`;

      // NEW: Track this card as scheduled for cognitive load tracking
      if (isNewCard) {
        scheduledCardNames.add(task.cardName);
      }

      scheduledTasks.push({
        ...task,
        startTime,
        endTime,
        schedulingNote: task.durationConfidence === 'low' ? 'Duration estimated' : undefined,
        workerId: workerId
      });

      // Update tracking
      dailyScheduledMinutes += taskMinutes;
      minutesSinceBreak += taskMinutes;
      currentHour = endHour;
      currentMinute = endMinute;
    }

    const workerInfo = workerId ? ` (Worker ${workerId})` : '';
    console.log(`[Scheduling] ${date}${workerInfo}: Scheduled ${sortedTasks.filter(t => !t.isCompleted).length - overflowTasks.filter(t => t.date === date).length} tasks (${dailyScheduledMinutes}/${effectiveAvailableMinutes} minutes)`);
  }

  // FIX #7: Return structured object with separate scheduled/overflow tasks
  // NEW: Include cognitive load metrics
  const cognitiveLoadOverflow = overflowTasks.filter(t => t.rejectionReason?.includes('Cognitive')).length;
  const capacityOverflow = overflowTasks.filter(t => !t.rejectionReason?.includes('Cognitive')).length;
  
  // Calculate total scheduled hours for weekly tracking
  const totalScheduledMinutes = scheduledTasks
    .filter(t => t.startTime !== 'TBD' && t.startTime !== '--:--')
    .reduce((sum, t) => sum + Math.ceil(t.durationHours * 60), 0);
  const totalScheduledHours = Math.round(totalScheduledMinutes / 60 * 10) / 10;
  
  return {
    scheduled: scheduledTasks,
    overflow: overflowTasks,
    metrics: {
      totalScheduled: scheduledTasks.filter(t => t.startTime !== 'TBD' && t.startTime !== '--:--').length,
      totalOverflow: overflowTasks.length,
      cognitiveLoadOverflow: cognitiveLoadOverflow,
      capacityOverflow: capacityOverflow,
      dailyCapacityMinutes: AVAILABLE_WORK_MINUTES,
      totalScheduledMinutes: totalScheduledMinutes,
      totalScheduledHours: totalScheduledHours,
      // Flexible hours configuration
      dailyHoursMin: DAILY_HOURS_MIN,
      dailyHoursMax: DAILY_HOURS_MAX,
      weeklyHoursMin: WEEKLY_HOURS_MIN,
      weeklyHoursMax: WEEKLY_HOURS_MAX,
      schedulingStrategy: `Flexible Hours (${DAILY_HOURS_MIN}-${DAILY_HOURS_MAX}h/day, ${WEEKLY_HOURS_MIN}-${WEEKLY_HOURS_MAX}h/week) + Cognitive Load (max 4-5 tasks/day)`
    }
  }
}

// Get all workspaces (organizations)
router.get('/trello/workspaces', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (!apiKey || !token) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }
    const boards = await fetchUserWorkspaceBoards(apiKey, token);

    const workspaceMap = new Map<string, {
      id: string;
      name: string;
      boards: { id: string; name: string; cardCount?: number }[];
    }>();
    
    // Group boards by workspace WITHOUT fetching card counts (too slow)
    // Card counts can be fetched on-demand when needed
    for (const board of boards) {
      try {
        const workspaceId = board.workspaceId;
        if (!workspaceMap.has(workspaceId)) {
          workspaceMap.set(workspaceId, {
            id: workspaceId,
            name: board.workspaceName,
            boards: [],
          });
        }

        const workspace = workspaceMap.get(workspaceId)!;
        workspace.boards.push({
          id: board.id,
          name: board.name,
          cardCount: 0, // Skip card count fetching - too slow
        });
      } catch (error) {
        console.warn(`Error processing board ${board.name}:`, error);
      }
    }

    const validWorkspaces = Array.from(workspaceMap.values()).map((workspace) => ({
      ...workspace,
      boardCount: workspace.boards.length,
      cardCount: workspace.boards.reduce((sum, board) => sum + (board.cardCount || 0), 0),
    }));

    console.log(`Loaded ${validWorkspaces.length} workspaces with ${boards.length} boards (card counts skipped for performance)`);
    res.json(validWorkspaces);
  } catch (error) {
    console.error('Error fetching workspaces:', error);
    res.status(500).json({ error: 'Failed to fetch workspaces' });
  }
});

// Get all boards
router.get('/trello/boards', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (!apiKey || !token) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    const boards = await fetchUserWorkspaceBoards(apiKey, token);
    const boardsWithCounts: any[] = [];

    for (const board of boards) {
      try {
        const cardsResponse = await fetchWithRetry(
          `https://api.trello.com/1/boards/${board.id}/cards?key=${apiKey}&token=${token}`,
          undefined,
          {
            maxRetries: 2,
            initialDelayMs: 1000,
            maxDelayMs: 10000
          }
        );
        const cards = cardsResponse.ok ? await cardsResponse.json() : [];
        boardsWithCounts.push({
          id: board.id,
          name: board.name,
          cardCount: Array.isArray(cards) ? cards.length : 0,
          workspaceId: board.workspaceId,
          workspaceName: board.workspaceName,
        });
      } catch (error) {
        console.warn(`Error fetching cards for board ${board.name}:`, error);
        boardsWithCounts.push({
          id: board.id,
          name: board.name,
          cardCount: 0,
          workspaceId: board.workspaceId,
          workspaceName: board.workspaceName,
        });
      }
    }

    res.json(boardsWithCounts);
  } catch (error) {
    console.error('Error fetching boards:', error);
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
});

// Get cards for a specific board
router.get('/trello/boards/:boardId/cards', async (req: Request, res: Response) => {
  try {
    const { boardId } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (!apiKey || !token) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    // Check cache first (unless force refresh is requested)
    if (!forceRefresh) {
      const cachedCards = getCachedBoardCards(boardId);
      if (cachedCards) {
        console.log(`Returning cached cards for board ${boardId} (${cachedCards.length} cards)`);
        return res.set('X-Cache', 'HIT').json(cachedCards);
      }
    }

    // Skip expensive workspace validation - let Trello API validate the board directly
    // This avoids N+1 requests and rate limiting issues
    const response = await fetchWithRetry(
      `https://api.trello.com/1/boards/${boardId}/cards?key=${apiKey}&token=${token}&checklists=all&list=true&board=true`,
      undefined,
      {
        maxRetries: 3,
        initialDelayMs: 2000,
        maxDelayMs: 30000,
        onRetry: (attempt, error, delayMs) => {
          console.log(`Retrying cards fetch for board ${boardId} (attempt ${attempt}) after ${delayMs}ms`);
        }
      }
    );
    
    if (!response.ok) {
      const statusCode = response.status;
      const errorText = await response.text().catch(() => response.statusText);
      console.error(`Trello API error for board ${boardId}: ${statusCode} - ${errorText}`);
      
      // Return appropriate error codes
      if (statusCode === 401 || statusCode === 403) {
        return res.status(401).json({ error: 'Unauthorized - Invalid Trello credentials' });
      }
      if (statusCode === 404) {
        return res.status(404).json({ error: 'Board not found' });
      }
      if (statusCode === 429) {
        return res.status(429).json({ error: 'Rate limited by Trello - please try again later' });
      }
      throw new Error(`Trello API error: ${statusCode} - ${errorText}`);
    }

    const cards = await response.json();
    
    // Transform to our format
    const formattedCards = cards
      .filter((card: any) => !card.closed && !isInactiveListName(card.list?.name))
      .map((card: any) => ({
      id: card.id,
      name: card.name,
      desc: card.desc,
      idBoard: card.idBoard,
      idList: card.idList,
      boardName: card.board?.name,
      listName: card.list?.name,
      checklists: card.checklists || []
    }));

    // Cache the results
    setCachedBoardCards(boardId, formattedCards);
    console.log(`Cached cards for board ${boardId} (${formattedCards.length} cards, TTL: 10 minutes)`);

    res.set('X-Cache', 'MISS').json(formattedCards);
  } catch (error) {
    console.error('Error fetching cards:', error);
    res.status(500).json({ error: 'Failed to fetch cards from Trello' });
  }
});

// Clear cache for a specific board
router.post('/trello/boards/:boardId/cache/clear', async (req: Request, res: Response) => {
  try {
    const { boardId } = req.params;
    invalidateBoardCache(boardId);
    console.log(`Cleared cache for board ${boardId}`);
    res.json({ message: 'Cache cleared successfully' });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Generate APTLSS for a card
router.post('/aptlss/generate', async (req: Request, res: Response) => {
  try {
    const { cardId, cardData, settings } = req.body;

    if (!cardId && !cardData) {
      return res.status(400).json({ error: 'Card ID or card data is required' });
    }

    const card = cardId ? await fetchCardForAptlss(cardId) : cardData;

    // Content sufficiency check — per docs: do NOT generate for cards with just a title
    const hasDescription = card.desc && card.desc.trim().length > 0;
    const hasChecklists = Array.isArray(card.checklists) && card.checklists.length > 0;
    const hasAttachments = Array.isArray(card.attachments) && card.attachments.length > 0;
    if (!hasDescription && !hasChecklists && !hasAttachments) {
      return res.status(422).json({
        error: 'insufficient_content',
        message: 'This card only has a title. Please add a description, attachments, or comments before generating an APTLSS checklist.',
        cardId: card.id,
        cardName: card.name,
      });
    }

    console.log('Generating APTLSS for card %s with settings:', card.id, settings);

    const result = await generateAptlssForCard(card, {
      ...(settings && typeof settings === 'object' ? settings : {}),
      applyToTrello: Boolean(cardId),
    });
    res.json(result);
  } catch (error: any) {
    console.error('Error generating APTLSS:', error);
    res.status(500).json({ error: 'Failed to generate APTLSS. Retry shortly or check the service configuration.' });
  }
});

// Get generation history
router.get('/aptlss/history', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const jobs = await db.select().from(generationJobs).orderBy(desc(generationJobs.createdAt));
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get job details with items
router.get('/aptlss/history/:jobId', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { jobId } = req.params;
    
    const job = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
    
    if (!job || job.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const items = await db.select().from(generationItems).where(eq(generationItems.jobId, jobId));
    
    res.json({
      ...job[0],
      items
    });
  } catch (error) {
    console.error('Error fetching job details:', error);
    res.status(500).json({ error: 'Failed to fetch job details' });
  }
});

// Retry failed items
router.post('/aptlss/history/:jobId/retry', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { jobId } = req.params;
    const user = (req as any).user;

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Get failed items
    const failedItems = await db.select()
      .from(generationItems)
      .where(eq(generationItems.jobId, jobId));
    
    const failed = failedItems.filter((item: any) => item.status === 'failed');
    
    if (failed.length === 0) {
      return res.json({ message: 'No failed items to retry' });
    }
    
    // Create new job for retries
    const newJobId = `retry_${jobId}_${Date.now()}`;
    
    await db.insert(generationJobs).values({
      id: newJobId,
      totalCards: failed.length,
      completedCards: 0,
      failedCards: 0,
      status: 'running',
      settings: '{}',
      createdBy: user.openId,
    });

    const retryResults: any[] = [];
    let completedCards = 0;
    let failedCards = 0;

    for (const [index, item] of failed.entries()) {
      const itemId = `item_${newJobId}_${index}`;
      try {
        const card = await fetchCardForAptlss(item.cardId);
        const result = await generateAptlssChecklist(card, {});

        await db.insert(generationItems).values({
          id: itemId,
          jobId: newJobId,
          cardId: card.id,
          cardName: card.name,
          boardName: card.board?.name ?? null,
          status: 'completed',
          attempts: 1,
          maxAttempts: 3,
          result: JSON.stringify(result),
        });

        completedCards++;
        retryResults.push({
          cardId: card.id,
          success: true,
          checklistId: result.checklistId || null,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedCards++;
        retryResults.push({
          cardId: item.cardId,
          success: false,
          error: errorMessage,
        });

        await db.insert(generationItems).values({
          id: itemId,
          jobId: newJobId,
          cardId: item.cardId,
          cardName: item.cardName,
          boardName: item.boardName || null,
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
          error: errorMessage,
          result: null,
        });
      }

      await db.update(generationJobs).set({
        completedCards,
        failedCards,
      }).where(eq(generationJobs.id, newJobId));
    }

    await db.update(generationJobs).set({
      status: failedCards > 0 ? 'completed_with_errors' : 'completed',
      completedCards,
      failedCards,
      completedAt: new Date(),
    }).where(eq(generationJobs.id, newJobId));
    
    res.json({
      success: true,
      jobId: newJobId,
      itemsToRetry: failed.length,
      completed: completedCards,
      failed: failedCards,
      results: retryResults,
    });
  } catch (error) {
    console.error('Error retrying failed items:', error);
    res.status(500).json({ error: 'Failed to retry items' });
  }
});

// Batch generate APTLSS
router.post('/aptlss/generate-batch', async (req: Request, res: Response) => {
  try {
    const { cardIds, settings } = req.body;
    const user = (req as any).user;

    if (!cardIds || !Array.isArray(cardIds) || cardIds.length === 0) {
      return res.status(400).json({ error: 'Card IDs array is required' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const jobId = `aptlss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await executeAptlssGenerationBatch({
      jobId,
      cardIds,
      settings: settings && typeof settings === 'object' ? settings : {},
      createdBy: user.openId,
    });
    res.json(result);
  } catch (error) {
    console.error('Error in batch generation:', error);
    res.status(500).json({ error: 'Failed to batch generate APTLSS' });
  }
});

// Get generation status
router.get('/aptlss/status/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const job = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
    if (job.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const currentJob = job[0];
    const progress = {
      total: currentJob.totalCards,
      completed: currentJob.completedCards,
      failed: currentJob.failedCards,
    };

    res.json({
      jobId,
      status: currentJob.status,
      progress,
      completedAt: currentJob.completedAt,
    });
  } catch (error) {
    console.error('Error fetching status:', error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// Get tasks from Trello cards with APTLSS checklists
router.get('/trello/tasks', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const forceRefresh = req.query.refresh === 'true';
    const requestedTtl = Number(req.query.ttl);
    const cacheTTL = Number.isInteger(requestedTtl) && requestedTtl >= 30 && requestedTtl <= 3600
      ? requestedTtl
      : 300;

    const cachedData = await getCachedTasks(user.id, user.openId, {
      ttlSeconds: cacheTTL,
      forceRefresh,
    });
    if (cachedData && !forceRefresh) {
      const db = await getDb();
      if (!db) throw new AssignmentError(503, 'Worker assignments could not be verified; retry before scheduling');
      const cachedTasks = [...(Array.isArray(cachedData.tasks) ? cachedData.tasks : []),
        ...(Array.isArray(cachedData.overflow) ? cachedData.overflow : [])];
      if (Array.isArray(cachedData.tasks) && cachedTasks.every(task => typeof task?.id === 'string')) {
        const snapshot = await readSchedulingAssignmentSnapshot(db, user.id, cachedTasks.map(task => task.id));
        const owners = new Map(snapshot.assignments.map(row => [row.taskId, row.vaId]));
        if (cachedTasks.every(task => task.workerId === owners.get(task.id))) {
          console.log('Cache hit for tasks');
          return res.json(cachedData);
        }
      }
      await invalidateCache(user.id, user.openId, 'tasks');
    }

    console.log('Cache miss for tasks - fetching from Trello API');

    const apiKey = process.env.TRELLO_API_KEY;
    const apiToken = process.env.TRELLO_TOKEN;

    if (!apiKey || !apiToken) {
      return res.status(500).json({ error: 'Trello credentials not configured' });
    }

    // Use request queue to deduplicate simultaneous requests
    const queueKey = `trello-tasks-${user.openId}`;
    const responseData = await requestQueue.execute(queueKey, async () => {
      const db = await getDb();
      if (!db) throw new AssignmentError(503, 'Worker assignments could not be verified; retry before scheduling');
      const allClients = db ? await db.select().from(clients).where(eq(clients.founderId, user.id)) : [];
      const boardToClientMap = new Map<string, typeof allClients[0]>();
      for (const client of allClients) {
        if (client.trelloBoardIds) {
          try {
            const bIds = JSON.parse(client.trelloBoardIds);
            for (const bId of bIds) {
              boardToClientMap.set(bId, client);
            }
          } catch(e) {}
        }
      }

      const boards = await fetchUserWorkspaceBoards(apiKey, apiToken);

      const tasks: any[] = [];
    
    // Client extraction function - parses patterns like "Client | Project", "Client - Project", "Client / Project"
    const extractClient = (boardName: string, cardName: string): string | undefined => {
      // Try board name first (most reliable)
      // Pattern: "Client | Project" or "Client | Category | Project"
      const boardParts = boardName.split(/\s*[|\-\/]\s*/);
      if (boardParts.length >= 2) {
        // First part is usually the client/organization
        const potentialClient = boardParts[0].trim();
        // Skip if it looks like a category (e.g., "NO", "Personal", numbers)
        if (potentialClient.length > 2 && !/^\d/.test(potentialClient) && 
            !['personal', 'internal', 'admin', 'general'].includes(potentialClient.toLowerCase())) {
          return potentialClient;
        }
        // Try second part if first is a code
        if (boardParts.length >= 3 && boardParts[1].trim().length > 2) {
          return boardParts[1].trim();
        }
      }
      
      // Try card name as fallback
      const cardParts = cardName.split(/\s*[|\-\/]\s*/);
      if (cardParts.length >= 2) {
        const potentialClient = cardParts[0].trim();
        if (potentialClient.length > 2 && !/^\d/.test(potentialClient)) {
          return potentialClient;
        }
      }
      
      // Extract from common patterns like "[Client] Task" or "Client: Task"
      const bracketMatch = cardName.match(/^\[([^\]]+)\]/);
      if (bracketMatch) return bracketMatch[1].trim();
      
      const colonMatch = cardName.match(/^([^:]+):/);
      if (colonMatch && colonMatch[1].length > 2 && colonMatch[1].length < 30) {
        return colonMatch[1].trim();
      }
      
      return undefined;
    };

      // For each board in the user's workspaces, get active cards with checklists
      for (const board of boards) {
        const cardsResponse = await fetchWithRetry(
          `https://api.trello.com/1/boards/${board.id}/cards?checklists=all&list=true&key=${apiKey}&token=${apiToken}`,
          undefined,
          {
            maxRetries: 3,
            initialDelayMs: 1000,
            onRetry: (attempt, error, delayMs) => {
              console.log(`Retrying cards fetch for board ${board.id} (attempt ${attempt}) after ${delayMs}ms due to:`, error.message);
            }
          }
        );
      
        if (!cardsResponse.ok) {
          console.error(`Trello API error fetching cards for board ${board.id}:`, cardsResponse.statusText);
          continue; // Skip this board and continue with others
        }
      
        const cards = await cardsResponse.json();
      
        // Validate cards is an array
        if (!Array.isArray(cards)) {
          console.error(`Trello API returned non-array for cards in board ${board.id}:`, cards);
          continue; // Skip this board
        }

        // Process each active card
        for (const card of cards.filter((c: any) => !c.closed && !isInactiveListName(c.list?.name))) {
          // Find APTLSS checklist
          const aptlssChecklist = card.checklists?.find((cl: any) =>
            cl.name.toLowerCase().includes('aptlss') ||
            cl.name.toLowerCase().includes('action plan')
          );

          if (aptlssChecklist && aptlssChecklist.checkItems) {
            // Get card due date if available
            const cardDueDate = card.due ? new Date(card.due).toISOString().split('T')[0] : undefined;
            const cardLabels = card.labels?.map((l: any) => l.name.toLowerCase()) || [];
          
            // Use enhanced APTLSS parser for better accuracy
            const parsedItems = parseAPTLSSChecklist(
              aptlssChecklist.checkItems,
              cardDueDate,
              cardLabels
            );
          
            parsedItems
              .filter((parsed) => parsed.originalItem?.state !== 'complete')
              .forEach((parsed, index) => {
                const item = parsed.originalItem;
            
                // Determine priority level from card labels
                const priorityLevel = cardLabels.some((l: string) => l.includes('critical')) ? 'CRITICAL' :
                                     cardLabels.some((l: string) => l.includes('urgent')) ? 'URGENT' :
                                     cardLabels.some((l: string) => l.includes('high')) ? 'HIGH' : 'NORMAL';
            
                tasks.push({
                  id: `${card.id}_${item.id}`,
                  cardId: card.id,
                  cardName: card.name,
                  boardName: board.name,
                  client: boardToClientMap.get(board.id)?.name || extractClient(board.name, card.name),
                  clientPriority: boardToClientMap.get(board.id)?.priority || 'standard',
                  checklistId: aptlssChecklist.id,
                  checkItemId: item.id,
                  stepIndex: index,
                  description: parsed.cleanDescription || parsed.description,
                  fullDescription: parsed.description,
                  durationHours: parsed.durationHours,
                  durationConfidence: parsed.durationConfidence,
                  startTime: '09:00',
                  endTime: '10:00',
                  date: parsed.dueDate || new Date().toISOString().split('T')[0],
                  dateSource: parsed.dateSource,
                  isCompleted: false,
                  isArchived: false,
                  isBlocker: parsed.isBlocker,
                  isPriority: cardLabels.some((l: string) => l.includes('priority')),
                  priorityLevel,
                  taskType: parsed.taskType,
                  complexity: parsed.complexity,
                  dependencies: parsed.dependencies,
                  hasExternalDependency: parsed.hasExternalDependency,
                  keywords: parsed.keywords,
                  hasDutch: parsed.description.toLowerCase().includes('dutch') || parsed.description.toLowerCase().includes('nederlands'),
                  attachments: []
                });
              });
          }
        }
      }

      // Get user's working hours settings and holidays
      let workStartHour = 9;
      let workEndHour = 18;
      let workingDays = [1, 2, 3, 4, 5]; // Default: Mon-Fri
      let userHolidays: string[] = [];
      const schedulingOptions: Partial<SchedulingOptions> = {};
    
    if (req.user) {
      try {
        const db = await getDb();
        if (db) {
          const settings = await db.select().from(userWorkingHours)
            .where(eq(userWorkingHours.userOpenId, req.user.openId))
            .limit(1);
          
          if (settings.length > 0) {
            workStartHour = settings[0].workStartHour;
            workEndHour = settings[0].workEndHour;
            // Parse working days from comma-separated string
            workingDays = settings[0].workingDays
              .split(',')
              .filter((d: string) => d)
              .map((d: string) => parseInt(d, 10));
            
            // Get meal break settings (times are stored as HH:MM strings)
            const parseTimeToHour = (timeStr: string | null): number | undefined => {
              if (!timeStr) return undefined;
              const parts = timeStr.split(':');
              return parseInt(parts[0], 10);
            };
            
            if (settings[0].lunchTime) {
              schedulingOptions.lunchBreakStart = parseTimeToHour(settings[0].lunchTime);
              schedulingOptions.lunchBreakDuration = settings[0].lunchDuration || 60;
            }
            if (settings[0].breakfastTime) {
              schedulingOptions.breakfastBreakStart = parseTimeToHour(settings[0].breakfastTime);
              schedulingOptions.breakfastBreakDuration = settings[0].breakfastDuration || 30;
            }
            if (settings[0].dinnerTime) {
              schedulingOptions.dinnerBreakStart = parseTimeToHour(settings[0].dinnerTime);
              schedulingOptions.dinnerBreakDuration = settings[0].dinnerDuration || 30;
            }
            
            // Add weekly and daily hours flexibility
            if (settings[0].weeklyHoursMin !== undefined) {
              schedulingOptions.weeklyHoursMin = settings[0].weeklyHoursMin;
            }
            if (settings[0].weeklyHoursMax !== undefined) {
              schedulingOptions.weeklyHoursMax = settings[0].weeklyHoursMax;
            }
            if (settings[0].dailyHoursMin !== undefined) {
              // Convert from string (decimal) to number
              schedulingOptions.dailyHoursMin = parseFloat(String(settings[0].dailyHoursMin)) || 8;
            }
            if (settings[0].dailyHoursMax !== undefined) {
              // Convert from string (decimal) to number
              schedulingOptions.dailyHoursMax = parseFloat(String(settings[0].dailyHoursMax)) || 9;
            }
          }

          // Fetch active holidays
          const holidayRecords = await db.select()
            .from(holidays)
            .where(and(
              eq(holidays.userOpenId, req.user.openId),
              eq(holidays.isActive, 1)
            ));
          
          userHolidays = holidayRecords.map((h: any) => h.date);
        }
      } catch (error) {
        console.warn('Could not fetch user working hours, using defaults:', error);
      }
    }
    
    // Worker-specific scheduling: Check if tasks are assigned to workers and use their settings
    // This allows different workers to have different schedules
    let workerSettingsMap: Map<number, {
      workStartHour: number;
      workEndHour: number;
      workingDays: number[];
      schedulingOptions: Partial<SchedulingOptions>;
    }> = new Map();
    
    if (req.user) {
      try {
        const db = await getDb();
        if (db) {
          // Get all task IDs to check for assignments
          const taskIds = tasks.map(t => t.id);
          
          // Fetch task assignments for these tasks
          const { assignments, workers } = await readSchedulingAssignmentSnapshot(db, user.id, taskIds);
          
          if (assignments.length > 0) {
            // Get unique worker IDs
            const workerIds = Array.from(new Set(assignments.map((a: any) => Number(a.vaId)))) as number[];
            
            // Fetch dependencies for these tasks
            const dependencies = await db.select()
              .from(taskDependencies)
              .where(and(inArray(taskDependencies.taskId, taskIds), eq(taskDependencies.founderId, user.id)));
            
            const blockedByLookup = new Map<string, string[]>();
            for (const dep of dependencies) {
              if (!blockedByLookup.has(dep.taskId)) {
                blockedByLookup.set(dep.taskId, []);
              }
              blockedByLookup.get(dep.taskId)!.push(dep.blockedByTaskId);
            }
            
            // Build worker settings map
            for (const worker of workers) {
              const workerWorkingDays = worker.workingDays
                .split(',')
                .filter((d: string) => d)
                .map((d: string) => parseInt(d, 10));
              
              const workerOptions: Partial<SchedulingOptions> = {};
              
              if (worker.lunchTime !== null) {
                workerOptions.lunchBreakStart = worker.lunchTime;
                workerOptions.lunchBreakDuration = worker.lunchDuration || 60;
              }
              if (worker.breakfastTime !== null) {
                workerOptions.breakfastBreakStart = worker.breakfastTime;
                workerOptions.breakfastBreakDuration = worker.breakfastDuration || 30;
              }
              if (worker.dinnerTime !== null) {
                workerOptions.dinnerBreakStart = worker.dinnerTime;
                workerOptions.dinnerBreakDuration = worker.dinnerDuration || 30;
              }
              
              workerSettingsMap.set(worker.id, {
                workStartHour: worker.workStartHour,
                workEndHour: worker.workEndHour,
                workingDays: workerWorkingDays,
                schedulingOptions: workerOptions
              });
            }
            
            // Create assignment lookup
            const assignmentLookup = new Map(assignments.map((a: any) => [a.taskId, a.vaId]));
            
            // Add worker ID and dependencies to each task for scheduling
            for (const task of tasks) {
              const workerId = assignmentLookup.get(task.id);
              if (workerId) {
                (task as any).workerId = workerId;
              }
              
              const blockedBy = blockedByLookup.get(task.id);
              if (blockedBy) {
                (task as any).blockedBy = blockedBy;
              }
            }
            
            console.log(`[Scheduling] Found ${assignments.length} task assignments across ${workerIds.length} workers`);
          }
        } else {
          throw new AssignmentError(503, 'Worker assignments could not be verified; retry before scheduling');
        }
      } catch (error) {
        if (assignmentFailure(error)) throw error;
        throw new AssignmentError(503, 'Worker assignments could not be verified; retry before scheduling');
      }
    }
    
    // Schedule tasks with proper time slots (including meal break options)
    // If tasks have worker assignments, they will be scheduled according to worker settings
    const schedulingResult = scheduleTasksByTime(tasks, workStartHour, workEndHour, workingDays, userHolidays, schedulingOptions, workerSettingsMap);
    
    // Get user's timezone for client-side conversion
    let userTimezone = 'UTC';
    if (req.user) {
      try {
        const db = await getDb();
        if (db) {
          const settings = await db.select().from(userWorkingHours)
            .where(eq(userWorkingHours.userOpenId, req.user.openId))
            .limit(1);
          
          if (settings.length > 0 && settings[0].timezone) {
            userTimezone = settings[0].timezone;
          }
        }
      } catch (error) {
        console.warn('Could not fetch user timezone:', error);
      }
    }
    
      const responseData = {
        tasks: schedulingResult.scheduled,
        overflow: schedulingResult.overflow,
        metrics: schedulingResult.metrics,
        timezone: userTimezone
      };

      await setCachedTasks(user.id, user.openId, responseData, cacheTTL);

      return responseData;
    }); // End of requestQueue.execute

    res.json(responseData);
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    console.error('Error fetching Trello tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks from Trello' });
  }
});

// Schedule generation endpoint
router.post('/aptlss/schedule', async (req: any, res: Response) => {
  try {
    const { cardIds, scheduledTime, settings } = req.body;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const normalizedCardIds = Array.isArray(cardIds)
      ? Array.from(new Set(cardIds.map((value: unknown) => typeof value === 'string' ? value.trim() : '').filter(Boolean))).slice(0, 250)
      : [];
    if (normalizedCardIds.length === 0) {
      return res.status(400).json({ error: 'At least one valid Trello card ID is required' });
    }
    const runAt = new Date(scheduledTime);
    if (!scheduledTime || Number.isNaN(runAt.getTime())) {
      return res.status(400).json({ error: 'A valid scheduledTime is required' });
    }
    if (runAt.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: 'scheduledTime cannot be in the past' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const jobId = `sched_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    await db.insert(scheduledJobs).values({
      id: jobId,
      cardIds: JSON.stringify(normalizedCardIds),
      scheduledTime: runAt,
      status: 'pending',
      settings: JSON.stringify(settings && typeof settings === 'object' ? settings : {}),
      createdBy: user.openId
    });

    res.json({ success: true, jobId });
  } catch (error) {
    console.error('Error scheduling generation:', error);
    res.status(500).json({ error: 'Failed to schedule generation' });
  }
});

// Get scheduled jobs endpoint
router.get('/aptlss/scheduled', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const jobs = await db.select().from(scheduledJobs)
      .where(eq(scheduledJobs.createdBy, user.openId))
      .orderBy(desc(scheduledJobs.createdAt));

    res.json(jobs);
  } catch (error) {
    console.error('Error fetching scheduled jobs:', error);
    res.status(500).json({ error: 'Failed to fetch scheduled jobs' });
  }
});

// Ca// Cancel scheduled job endpoint
router.delete('/aptlss/scheduled/:id', async (req: any, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const [existing] = await db.select({ status: scheduledJobs.status }).from(scheduledJobs)
      .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.createdBy, user.openId)))
      .limit(1);
    if (!existing) return res.status(404).json({ error: 'Scheduled job not found' });
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: `Only pending jobs can be cancelled (current status: ${existing.status})` });
    }
    await db.update(scheduledJobs)
      .set({ status: 'cancelled' })
      .where(and(
        eq(scheduledJobs.id, id),
        eq(scheduledJobs.createdBy, user.openId),
        eq(scheduledJobs.status, 'pending')
      ));
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling scheduled job:', error);
    res.status(500).json({ error: 'Failed to cancel scheduled job' });
  }
});

export default router;
