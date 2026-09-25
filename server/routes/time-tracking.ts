import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db';
import { timeEntries, vaProfiles, taskAssignments, atisCards, aptlssPlans, aptlssWaitingReasons, aptlssAssessments, aptlssManagerRuns, users, type User } from '../../drizzle/schema';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { requireAuthenticated } from '../middleware/auth';
import { isManagerPilotWorker } from '../aptlssManagerPilot';
import { managerIntervenesOnCard, timerExecutionBlockReason } from '../timerAccess';

const router = Router();
router.use('/time-tracking', requireAuthenticated);

export function timeTrackingOwnership(user: User, workerFounderId?: number | null) {
  return {
    vaId: user.id,
    founderId: user.role === 'worker' ? workerFounderId ?? user.id : user.id,
  };
}

function nonNegativeDurationMinutes(entry: { durationMinutes?: number | null }) {
  return Math.max(0, Number(entry.durationMinutes) || 0);
}

async function transitionActiveTimer(userId: number, transition: "stop" | "pause", notes?: string | null) {
  const db = await getDb();
  if (!db) return { status: 503, body: { error: 'Database not available' } };

  return db.transaction(async tx => {
    const [account] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (!account) return { status: 401, body: { error: 'Account no longer exists' } };

    const [entry] = await tx.select().from(timeEntries).where(and(
      eq(timeEntries.vaId, userId), sql`${timeEntries.endTime} IS NULL`
    )).orderBy(desc(timeEntries.startTime)).limit(1).for('update');
    if (!entry) return { status: 400, body: { error: 'No active timer found' } };

    const endTime = new Date();
    const startTime = new Date(entry.startTime);
    const durationMinutes = Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 60000));
    const finalNotes = transition === 'pause'
      ? entry.notes ? `${entry.notes} (paused)` : '(paused)'
      : notes || entry.notes;

    await tx.update(timeEntries).set({ endTime, durationMinutes, notes: finalNotes })
      .where(and(eq(timeEntries.id, entry.id), eq(timeEntries.vaId, userId), sql`${timeEntries.endTime} IS NULL`));
    const [updatedEntry] = await tx.select().from(timeEntries).where(
      and(eq(timeEntries.id, entry.id), eq(timeEntries.vaId, userId))
    ).limit(1);

    return transition === 'pause'
      ? { status: 200, body: { success: true, entry: updatedEntry, paused: true, taskId: entry.taskId } }
      : { status: 200, body: { success: true, entry: updatedEntry } };
  });
}

// Get active timer for a task (if any)
router.get('/time-tracking/active', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Find any active timer (endTime is null)
    const activeTimer = await db.select()
      .from(timeEntries)
      .where(and(
        eq(timeEntries.vaId, user.id),
        sql`${timeEntries.endTime} IS NULL`
      ))
      .orderBy(desc(timeEntries.startTime))
      .limit(1);

    if (activeTimer.length === 0) {
      return res.json({ active: false, entry: null });
    }

    res.json({ active: true, entry: activeTimer[0] });
  } catch (error) {
    console.error('Error fetching active timer:', error);
    res.status(500).json({ error: 'Failed to fetch active timer' });
  }
});

// Start a timer for a task
router.post('/time-tracking/start', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : '';
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
    if (!taskId || taskId.length > 128) {
      return res.status(400).json({ error: 'A valid task ID is required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const outcome = await db.transaction(async tx => {
      const [account] = await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
      if (!account) return { status: 401, body: { error: 'Account no longer exists' } };
      const [profile] = user.role === 'worker'
        ? await tx.select({ id: vaProfiles.id, founderId: vaProfiles.founderId, trelloMemberId: vaProfiles.trelloMemberId })
          .from(vaProfiles).where(eq(vaProfiles.userId, user.id)).limit(1)
        : [];
      if (user.role === 'worker' && isManagerPilotWorker(user.id)) {
        if (!profile) return { status: 403, body: { error: 'Worker profile is required for this task' } };
        const cardId = taskId.split(':')[0];
        const [assignment] = await tx.select({ status: taskAssignments.status }).from(taskAssignments)
          .where(and(eq(taskAssignments.vaId, profile.id), eq(taskAssignments.taskId, taskId))).limit(1);
        const [card] = await tx.select({ listName: atisCards.listName, memberIds: atisCards.memberIds, isArchived: atisCards.isArchived })
          .from(atisCards).where(eq(atisCards.trelloId, cardId)).limit(1);
        let isCardMember = false;
        if (profile.trelloMemberId && card?.memberIds && !card.isArchived) {
          try {
            const members: unknown = JSON.parse(card.memberIds);
            isCardMember = Array.isArray(members) && members.includes(profile.trelloMemberId);
          } catch { /* Malformed membership cannot grant timer access. */ }
        }
        if (!assignment && !isCardMember) return { status: 403, body: { error: 'This task is not assigned to your worker account' } };
        if (assignment?.status === 'completed') return { status: 409, body: { error: 'This task is already complete' } };
        const [plan] = await tx.select({ listName: aptlssPlans.listName }).from(aptlssPlans)
          .where(and(eq(aptlssPlans.vaId, user.id), eq(aptlssPlans.cardId, cardId))).limit(1);
        const [waiting] = await tx.select({ id: aptlssWaitingReasons.id }).from(aptlssWaitingReasons)
          .where(and(eq(aptlssWaitingReasons.vaId, user.id), eq(aptlssWaitingReasons.cardId, cardId), eq(aptlssWaitingReasons.status, 'active'))).limit(1);
        const [assessment] = await tx.select({ actionability: aptlssAssessments.actionability }).from(aptlssAssessments)
          .where(eq(aptlssAssessments.cardId, cardId)).orderBy(desc(aptlssAssessments.assessedAt), desc(aptlssAssessments.id)).limit(1);
        const [run] = await tx.select({ snapshotJson: aptlssManagerRuns.snapshotJson }).from(aptlssManagerRuns)
          .where(eq(aptlssManagerRuns.vaId, user.id)).orderBy(desc(aptlssManagerRuns.id)).limit(1);
        let intervention = false;
        if (run) {
          try { intervention = managerIntervenesOnCard(run.snapshotJson, cardId); }
          catch { return { status: 409, body: { error: 'The latest APTLSS review cannot be verified; reassess before starting work' } }; }
        }
        const reason = timerExecutionBlockReason({ listName: plan?.listName ?? card?.listName ?? '',
          hasActiveWaitingReason: Boolean(waiting) || assignment?.status === 'blocked',
          actionability: assessment?.actionability ?? null, hasManagerIntervention: intervention });
        if (reason) return { status: 409, body: { error: reason } };
      }
      const [active] = await tx.select().from(timeEntries).where(and(
        eq(timeEntries.vaId, user.id), sql`${timeEntries.endTime} IS NULL`
      )).limit(1);
      if (active) return { status: 400, body: { error: 'Timer already active', activeTaskId: active.taskId } };
      const ownership = timeTrackingOwnership(user, profile?.founderId);
      const [result] = await tx.insert(timeEntries).values({ taskId, ...ownership, startTime: new Date(), notes });
      const [entry] = await tx.select().from(timeEntries).where(eq(timeEntries.id, result.insertId)).limit(1);
      return { status: 200, body: { success: true, entry } };
    });
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('Error starting timer:', error);
    res.status(500).json({ error: 'Failed to start timer' });
  }
});

// Stop the active timer
router.post('/time-tracking/stop', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
    const outcome = await transitionActiveTimer(user.id, 'stop', notes);
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('Error stopping timer:', error);
    res.status(500).json({ error: 'Failed to stop timer' });
  }
});

// Pause timer (stop and allow resume)
router.post('/time-tracking/pause', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const outcome = await transitionActiveTimer(user.id, 'pause');
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('Error pausing timer:', error);
    res.status(500).json({ error: 'Failed to pause timer' });
  }
});

// Get time entries for a specific task
router.get('/time-tracking/task/:taskId', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { taskId } = req.params;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const entries = await db.select()
      .from(timeEntries)
      .where(and(
        eq(timeEntries.vaId, user.id),
        eq(timeEntries.taskId, taskId)
      ))
      .orderBy(desc(timeEntries.startTime));

    // Calculate total time spent
    const totalMinutes = entries.reduce(
      (sum: number, entry: any) => sum + nonNegativeDurationMinutes(entry),
      0,
    );

    res.json({ 
      entries, 
      totalMinutes,
      totalHours: Math.round(totalMinutes / 60 * 10) / 10
    });
  } catch (error) {
    console.error('Error fetching task time entries:', error);
    res.status(500).json({ error: 'Failed to fetch time entries' });
  }
});

// Get time entries for a date range (for weekly summary)
router.get('/time-tracking/summary', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { startDate, endDate } = req.query;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    let query = db.select()
      .from(timeEntries)
      .where(eq(timeEntries.vaId, user.id));

    // If date range provided, filter by it
    if (startDate && endDate) {
      const start = new Date(startDate as string);
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999); // Include entire end day
      
      query = db.select()
        .from(timeEntries)
        .where(and(
          eq(timeEntries.vaId, user.id),
          gte(timeEntries.startTime, start),
          lte(timeEntries.startTime, end)
        ));
    }

    const entries = await query.orderBy(desc(timeEntries.startTime));

    // Calculate totals
    const totalMinutes = entries.reduce(
      (sum: number, entry: any) => sum + nonNegativeDurationMinutes(entry),
      0,
    );
    
    // Group by date
    const byDate: Record<string, number> = {};
    entries.forEach((entry: any) => {
      const date = new Date(entry.startTime).toISOString().split('T')[0];
      byDate[date] = (byDate[date] || 0) + nonNegativeDurationMinutes(entry);
    });

    // Group by task
    const byTask: Record<string, number> = {};
    entries.forEach((entry: any) => {
      byTask[entry.taskId] = (byTask[entry.taskId] || 0) + nonNegativeDurationMinutes(entry);
    });

    res.json({
      entries,
      totalMinutes,
      totalHours: Math.round(totalMinutes / 60 * 10) / 10,
      byDate,
      byTask,
      entryCount: entries.length
    });
  } catch (error) {
    console.error('Error fetching time summary:', error);
    res.status(500).json({ error: 'Failed to fetch time summary' });
  }
});

// Get weekly progress (scheduled hours vs target)
router.get('/time-tracking/weekly-progress', async (req: any, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Get current week's start and end dates
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)); // Monday
    startOfWeek.setHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6); // Sunday
    endOfWeek.setHours(23, 59, 59, 999);

    // Get time entries for this week
    const weekEntries = await db.select()
      .from(timeEntries)
      .where(and(
        eq(timeEntries.vaId, user.id),
        gte(timeEntries.startTime, startOfWeek),
        lte(timeEntries.startTime, endOfWeek)
      ));

    const actualMinutes = weekEntries.reduce(
      (sum: number, entry: any) => sum + nonNegativeDurationMinutes(entry),
      0,
    );
    const actualHours = Math.round(actualMinutes / 60 * 10) / 10;

    // Get user's weekly hours target from settings
    const { userWorkingHours } = await import('../../drizzle/schema');
    const settings = await db.select()
      .from(userWorkingHours)
      .where(eq(userWorkingHours.userOpenId, user.openId))
      .limit(1);

    let weeklyHoursMin = 55;
    let weeklyHoursMax = 60;
    let dailyHoursMin = 9.5;
    let dailyHoursMax = 11.5;

    if (settings.length > 0) {
      weeklyHoursMin = settings[0].weeklyHoursMin || 55;
      weeklyHoursMax = settings[0].weeklyHoursMax || 60;
      dailyHoursMin = parseFloat(String(settings[0].dailyHoursMin)) || 9.5;
      dailyHoursMax = parseFloat(String(settings[0].dailyHoursMax)) || 11.5;
    }

    // Calculate daily breakdown
    const dailyBreakdown: Record<string, number> = {};
    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfWeek);
      date.setDate(startOfWeek.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];
      dailyBreakdown[dateStr] = 0;
    }

    weekEntries.forEach((entry: any) => {
      const date = new Date(entry.startTime).toISOString().split('T')[0];
      if (dailyBreakdown[date] !== undefined) {
        dailyBreakdown[date] += nonNegativeDurationMinutes(entry);
      }
    });

    // Convert daily breakdown to hours
    const dailyHours: Record<string, number> = {};
    Object.entries(dailyBreakdown).forEach(([date, minutes]) => {
      dailyHours[date] = Math.round(minutes / 60 * 10) / 10;
    });

    // Calculate progress percentage
    const targetMidpoint = (weeklyHoursMin + weeklyHoursMax) / 2;
    const progressPercent = Math.min(100, Math.round((actualHours / targetMidpoint) * 100));

    res.json({
      weekStart: startOfWeek.toISOString().split('T')[0],
      weekEnd: endOfWeek.toISOString().split('T')[0],
      actualHours,
      actualMinutes,
      weeklyHoursMin,
      weeklyHoursMax,
      dailyHoursMin,
      dailyHoursMax,
      dailyHours,
      progressPercent,
      onTrack: actualHours >= weeklyHoursMin && actualHours <= weeklyHoursMax,
      status: actualHours < weeklyHoursMin ? 'under' : actualHours > weeklyHoursMax ? 'over' : 'on_track'
    });
  } catch (error) {
    console.error('Error fetching weekly progress:', error);
    res.status(500).json({ error: 'Failed to fetch weekly progress' });
  }
});

export default router;
