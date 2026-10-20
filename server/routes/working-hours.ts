import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db';
import { userWorkingHours, vaProfiles } from '../../drizzle/schema.postgres';
import { eq, and } from 'drizzle-orm';
import { requireAdmin } from '../middleware/auth';
import { validateWorkingHoursSettings } from '../workingHoursValidation';

const router = Router();
router.use(requireAdmin);

// -------------------------------------------------------
// Shared default settings (used when no record exists)
// -------------------------------------------------------
const DEFAULT_SETTINGS = {
  workStartHour: 9,
  workStartMinute: 0,
  workEndHour: 18,
  workEndMinute: 0,
  breakfastTime: '09:00',
  breakfastDuration: 45,
  lunchTime: '15:00',
  lunchDuration: 45,
  dinnerTime: '20:00',
  dinnerDuration: 120,
  enableBreaks: true,
  shortBreakInterval: 120,
  shortBreakDuration: 10,
  longBreakInterval: 240,
  longBreakDuration: 30,
  workingDays: '1,2,3,4,5',
  timezone: 'UTC',
  country: 'US',
  weeklyHoursMin: 55,
  weeklyHoursMax: 60,
  dailyHoursMin: 9.5,
  dailyHoursMax: 11.5,
};

function definedValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function hasMinutePrecision(value: unknown) {
  return typeof value === 'string' && /^\d{2}:(?!00$)\d{2}$/.test(value);
}

// -------------------------------------------------------
// Helper: map a vaProfiles row + global defaults → settings shape
// -------------------------------------------------------
function workerToSettings(worker: any, globalDefaults: any) {
  // lunchTime on vaProfiles is stored as integer hour (e.g. 12)
  // Convert to HH:MM string for the frontend
  const intToTime = (val: number | null | undefined, fallback: string) => {
    if (val == null) return fallback;
    return `${String(val).padStart(2, '0')}:00`;
  };

  return {
    // From worker profile
    workStartHour: worker.workStartHour ?? globalDefaults.workStartHour,
    workStartMinute: 0, // vaProfiles only stores hour
    workEndHour: worker.workEndHour ?? globalDefaults.workEndHour,
    workEndMinute: 0,
    breakfastTime: intToTime(worker.breakfastTime, globalDefaults.breakfastTime),
    breakfastDuration: worker.breakfastDuration ?? globalDefaults.breakfastDuration,
    lunchTime: intToTime(worker.lunchTime, globalDefaults.lunchTime),
    lunchDuration: worker.lunchDuration ?? globalDefaults.lunchDuration,
    dinnerTime: intToTime(worker.dinnerTime, globalDefaults.dinnerTime),
    dinnerDuration: worker.dinnerDuration ?? globalDefaults.dinnerDuration,
    workingDays: worker.workingDays ?? globalDefaults.workingDays,
    timezone: worker.timezone ?? globalDefaults.timezone,
    // Break settings & weekly targets come from global defaults (not stored per-worker)
    enableBreaks: globalDefaults.enableBreaks,
    shortBreakInterval: globalDefaults.shortBreakInterval,
    shortBreakDuration: globalDefaults.shortBreakDuration,
    longBreakInterval: globalDefaults.longBreakInterval,
    longBreakDuration: globalDefaults.longBreakDuration,
    weeklyHoursMin: globalDefaults.weeklyHoursMin,
    weeklyHoursMax: globalDefaults.weeklyHoursMax,
    dailyHoursMin: globalDefaults.dailyHoursMin,
    dailyHoursMax: globalDefaults.dailyHoursMax,
    country: globalDefaults.country,
    // Extra metadata for frontend
    _isWorkerSettings: true,
    _workerId: worker.id,
    _workerName: worker.name,
    _workerTimezone: worker.timezone,
  };
}

// -------------------------------------------------------
// GET /api/working-hours/settings[?workerId=N]
// -------------------------------------------------------
router.get('/settings', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const workerId = req.query.workerId ? parseInt(req.query.workerId as string) : null;

    // Always load global defaults first
    const globalRows = await db
      .select()
      .from(userWorkingHours)
      .where(eq(userWorkingHours.userOpenId, user.openId))
      .limit(1);

    const globalDefaults = globalRows.length > 0
      ? { ...globalRows[0], enableBreaks: Boolean(globalRows[0].enableBreaks) }
      : DEFAULT_SETTINGS;

    // If a specific worker is requested, return their settings
    if (workerId) {
      const [worker] = await db
        .select()
        .from(vaProfiles)
        .where(and(eq(vaProfiles.id, workerId), eq(vaProfiles.founderId, user.id)))
        .limit(1);

      if (!worker) return res.status(404).json({ error: 'Worker not found' });

      return res.json(workerToSettings(worker, globalDefaults));
    }

    // No workerId → return global settings
    return res.json(globalDefaults);
  } catch (error) {
    console.error('Error fetching working hours:', error);
    res.status(500).json({ error: 'Failed to fetch working hours' });
  }
});

// -------------------------------------------------------
// POST /api/working-hours/settings[?workerId=N]
// -------------------------------------------------------
router.post('/settings', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const workerId = req.query.workerId ? parseInt(req.query.workerId as string) : null;

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const {
      workStartHour, workStartMinute, workEndHour, workEndMinute,
      breakfastTime, breakfastDuration,
      lunchTime, lunchDuration,
      dinnerTime, dinnerDuration,
      enableBreaks,
      shortBreakInterval, shortBreakDuration,
      longBreakInterval, longBreakDuration,
      workingDays, timezone, country,
      weeklyHoursMin, weeklyHoursMax,
      dailyHoursMin, dailyHoursMax,
    } = body;
    const updates = definedValues({
      workStartHour, workStartMinute, workEndHour, workEndMinute,
      breakfastTime, breakfastDuration, lunchTime, lunchDuration, dinnerTime, dinnerDuration,
      enableBreaks, shortBreakInterval, shortBreakDuration, longBreakInterval, longBreakDuration,
      workingDays, timezone, country, weeklyHoursMin, weeklyHoursMax, dailyHoursMin, dailyHoursMax,
    });

    // ---- Save per-worker ----
    if (workerId) {
      const globalRows = await db
        .select()
        .from(userWorkingHours)
        .where(eq(userWorkingHours.userOpenId, user.openId))
        .limit(1);
      const globalDefaults = globalRows.length > 0
        ? { ...globalRows[0], enableBreaks: Boolean(globalRows[0].enableBreaks) }
        : DEFAULT_SETTINGS;
      const [worker] = await db
        .select()
        .from(vaProfiles)
        .where(and(eq(vaProfiles.id, workerId), eq(vaProfiles.founderId, user.id)))
        .limit(1);

      if (!worker) return res.status(404).json({ error: 'Worker not found' });

      const candidate = { ...workerToSettings(worker, globalDefaults), ...updates };
      const validation = validateWorkingHoursSettings(candidate);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
      const workerUsesMinutes = [workStartMinute, workEndMinute]
        .some((minute) => minute !== undefined && minute !== 0)
        || [breakfastTime, lunchTime, dinnerTime].some(hasMinutePrecision);
      if (workerUsesMinutes) {
        return res.status(400).json({
          error: 'Worker profile schedules support whole hours only. Use a whole-hour time or update the worker schedule storage first.',
        });
      }

      // Convert HH:MM string back to integer hour for vaProfiles columns
      const timeToInt = (val: string | null | undefined) => {
        if (!val) return null;
        return parseInt(val.split(':')[0], 10);
      };

      await db
        .update(vaProfiles)
        .set({
          workStartHour: workStartHour ?? worker.workStartHour,
          workEndHour: workEndHour ?? worker.workEndHour,
          workingDays: workingDays ?? worker.workingDays,
          breakfastTime: timeToInt(breakfastTime),
          breakfastDuration: breakfastDuration ?? worker.breakfastDuration,
          lunchTime: timeToInt(lunchTime) ?? worker.lunchTime,
          lunchDuration: lunchDuration ?? worker.lunchDuration,
          dinnerTime: timeToInt(dinnerTime),
          dinnerDuration: dinnerDuration ?? worker.dinnerDuration,
          // timezone is managed from the Founder page, not here
        })
        .where(eq(vaProfiles.id, workerId));

      return res.json({ success: true, scope: 'worker', workerId });
    }

    // ---- Save global defaults ----
    const existing = await db
      .select()
      .from(userWorkingHours)
      .where(eq(userWorkingHours.userOpenId, user.openId))
      .limit(1);

    const candidate = { ...(existing[0] ?? DEFAULT_SETTINGS), ...updates };
    const validation = validateWorkingHoursSettings(candidate);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const payload = {
      workStartHour: candidate.workStartHour,
      workStartMinute: candidate.workStartMinute,
      workEndHour: candidate.workEndHour,
      workEndMinute: candidate.workEndMinute,
      breakfastTime: candidate.breakfastTime,
      breakfastDuration: candidate.breakfastDuration,
      lunchTime: candidate.lunchTime,
      lunchDuration: candidate.lunchDuration,
      dinnerTime: candidate.dinnerTime,
      dinnerDuration: candidate.dinnerDuration,
      enableBreaks: candidate.enableBreaks ? 1 : 0,
      shortBreakInterval: candidate.shortBreakInterval,
      shortBreakDuration: candidate.shortBreakDuration,
      longBreakInterval: candidate.longBreakInterval,
      longBreakDuration: candidate.longBreakDuration,
      workingDays: candidate.workingDays,
      timezone: candidate.timezone,
      country: candidate.country,
      weeklyHoursMin: candidate.weeklyHoursMin,
      weeklyHoursMax: candidate.weeklyHoursMax,
      dailyHoursMin: String(candidate.dailyHoursMin),
      dailyHoursMax: String(candidate.dailyHoursMax),
    };

    if (existing.length === 0) {
      await db.insert(userWorkingHours).values({
        userId: user.id,
        userOpenId: user.openId,
        ...payload,
      });
    } else {
      await db
        .update(userWorkingHours)
        .set(payload)
        .where(eq(userWorkingHours.userOpenId, user.openId));
    }

    return res.json({ success: true, scope: 'global' });
  } catch (error) {
    console.error('Error saving working hours:', error);
    res.status(500).json({ error: 'Failed to save working hours' });
  }
});

// -------------------------------------------------------
// Legacy root GET (kept for backward compat)
// -------------------------------------------------------
router.get('/', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getDb();
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const settings = await db
      .select()
      .from(userWorkingHours)
      .where(eq(userWorkingHours.userOpenId, user.openId))
      .limit(1);

    return res.json(settings.length > 0 ? settings[0] : DEFAULT_SETTINGS);
  } catch (error) {
    console.error('Error fetching working hours:', error);
    res.status(500).json({ error: 'Failed to fetch working hours' });
  }
});

export default router;
