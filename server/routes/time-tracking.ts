import { addDaysToDateKey, dateKeyInTimeZone, dateWindowInTimeZone, weekDateKeys } from '../../shared/workerTime';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db';
import { timeEntries, vaProfiles, taskAssignments, atisCards, aptlssPlans, aptlssWaitingReasons, cardStates, trelloCachedCards, users, type User } from '../../drizzle/schema.postgres';
import { eq, and, desc, gte, lte, sql, inArray } from 'drizzle-orm';
import { requireAuthenticated } from '../middleware/auth';
import { isManagerPilotWorker } from '../aptlssManagerPilot';
import { managerActionNeedsSourceVerification, managerActionSourceRequirements, managerExecutionCoverageComplete, managerIntervenesOnCard, timerExecutionBlockReason } from '../timerAccess';
import { enqueueManagerTask } from '../aptlssManagerQueue';
import { WORKER_EXECUTION_HOLD_MESSAGE } from '../../shared/aptlssManager';
import { readManagerAssignmentState } from '../aptlssManagerAssignments';
import { resolveWorkerOperatorContext, selectWorkerProfile } from '../workerOperatorContext';
import { closeCanonicalTimer, insertCanonicalTimer, withTimerAccountTransaction, lockTimerAccount, requireEntryId, timerFailure, timeCompleteness, assertTimerIdentityReady } from '../canonicalTimer';
import { recordedMinutes } from '../../shared/timerDuration';
import { getGoogleEvidenceStatus } from '../googleEvidence';
import { readCurrentManagerHistory } from '../aptlssManagerHistoryDb';
import { readCanonicalAssignments, assignmentFailure } from '../taskAssignmentMutation';

const router = Router();
router.use('/time-tracking', requireAuthenticated, requireActiveWorkerProfileForTimeTracking);

async function requireActiveWorkerProfileForTimeTracking(req: Request & { user?: User | null }, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (user.role !== 'worker') {
    next();
    return;
  }

  try {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: 'Worker access could not be verified' });
      return;
    }
    const activeProfile = await db.transaction(async tx => {
      const profiles = await tx.select({ id: vaProfiles.id, status: vaProfiles.status })
        .from(vaProfiles)
        .where(eq(vaProfiles.userId, user.id))
        .orderBy(vaProfiles.id);
      const activeProfiles = profiles.filter(profile => profile.status === 'active');
      return {
        profile: selectWorkerProfile(profiles),
        ambiguous: activeProfiles.length > 1,
      };
    });
    if (!activeProfile.profile) {
      res.status(403).json({ error: activeProfile.ambiguous
        ? 'Worker profile is ambiguous. Ask an administrator to resolve it before using timers.'
        : 'An active worker profile is required' });
      return;
    }
    next();
  } catch {
    res.status(503).json({ error: 'Worker access could not be verified' });
  }
}

export function timeTrackingOwnership(user: User, workerFounderId?: number | null, workerVaId = user.id) {
  return {
    trackedUserId: user.id,
    vaId: null,
    founderId: user.role === 'worker' ? workerFounderId ?? user.id : user.id,
  };
}

const nonNegativeDurationMinutes = recordedMinutes;

type WorkerTimeTrackingProfile = { id: number; founderId: number; trelloMemberId: string | null; status: string; timezone: string };

type TimeTrackingScope = {
  vaIds: number[];
  candidateVaIds: number[];
  ambiguousVaIds: number[];
  founderId: number;
  profile: WorkerTimeTrackingProfile | null;
};

const AMBIGUOUS_TIME_ENTRY_OWNER_ERROR = 'Worker time-entry ownership overlaps another account or profile ID. Ask an administrator to resolve the profile before using timers.';

function timeEntryScopeWhere(scope: TimeTrackingScope) {
  return and(
    eq(timeEntries.founderId, scope.founderId),
    inArray(timeEntries.trackedUserId, scope.vaIds),
  );
}

function timeEntryCandidateScopeWhere(scope: TimeTrackingScope) {
  return and(
    eq(timeEntries.founderId, scope.founderId),
    inArray(timeEntries.trackedUserId, scope.candidateVaIds),
  );
}

function timeEntryMatchesScope(entry: { trackedUserId: number | null; founderId: number }, scope: TimeTrackingScope) {
  return entry.founderId === scope.founderId && entry.trackedUserId !== null && scope.vaIds.includes(entry.trackedUserId);
}

function timeEntryHasAmbiguousIdentity(entry: { trackedUserId: number | null; founderId: number }, scope: TimeTrackingScope) {
  return entry.founderId === scope.founderId && entry.trackedUserId === null;
}

async function resolveTimeTrackingScope(tx: any, user: User, lockWorkerProfile = false): Promise<TimeTrackingScope | null> {
  if (user.role !== 'worker') {
    return {
      vaIds: [user.id], candidateVaIds: [user.id], ambiguousVaIds: [],
      founderId: user.id, profile: null,
    };
  }

  let profileQuery = tx.select({
    id: vaProfiles.id,
    founderId: vaProfiles.founderId,
    trelloMemberId: vaProfiles.trelloMemberId, timezone: vaProfiles.timezone,
    status: vaProfiles.status,
  }).from(vaProfiles).where(eq(vaProfiles.userId, user.id)).orderBy(vaProfiles.id);
  if (lockWorkerProfile) profileQuery = profileQuery.for('update');

  const profileRows = await profileQuery as WorkerTimeTrackingProfile[];
  const profile = selectWorkerProfile(profileRows);
  if (!profile) return null;
  return { vaIds: [user.id], candidateVaIds: [user.id], ambiguousVaIds: [],
    founderId: profile.founderId, profile };

}

type TimeTrackingObject = Record<string, unknown> & { readonly length?: never };

async function withTimeTrackingScope<T extends TimeTrackingObject>(
  db: any,
  user: User,
  read: (connection: any, scope: TimeTrackingScope) => Promise<T>,
): Promise<{ status: 200; value: T } | { status: 403 | 409; error: string }> {
  if (user.role !== 'worker') {
    return { status: 200, value: { ...await read(db, {
      vaIds: [user.id], candidateVaIds: [user.id], ambiguousVaIds: [], founderId: user.id, profile: null,
    }), ...await timeCompleteness(db, user.id) } };
  }

  return db.transaction(async (tx: any) => {
    const scope = await resolveTimeTrackingScope(tx, user, true);
    if (!scope) return { status: 403 as const, error: 'An active worker profile is required' };
    if (!scope.vaIds.length) return { status: 409 as const, error: AMBIGUOUS_TIME_ENTRY_OWNER_ERROR };
    return { status: 200 as const, value: { ...await read(tx, scope), ...await timeCompleteness(tx, scope.founderId) } };
  });
}

async function transitionActiveTimer(user: User, transition: "stop" | "pause", rawEntryId: unknown, notes?: string | null) {
  const entryId = requireEntryId(rawEntryId);
  const db = await getDb();
  if (!db) return { status: 503, body: { error: 'Database not available' } };
  const result = await closeCanonicalTimer(db, user, entryId, transition, { notes,
    afterClose: async (tx, entry) => {
      if (user.role === 'worker' && isManagerPilotWorker(user.id)) {
        await enqueueManagerTask(tx, { vaId: user.id, trigger: "timer_changed", eventKey: `timer-closed:${entry.id}` });
      }
    },
  });
  return { status: 200, body: result };
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

    const result = await withTimeTrackingScope(db, user, async (connection, scope) => {
      const activeTimers = await connection.select()
        .from(timeEntries)
        .where(and(eq(timeEntries.trackedUserId, user.id), eq(timeEntries.isVoided, false), sql`${timeEntries.endTime} IS NULL`))
        .orderBy(desc(timeEntries.startTime));
      if (activeTimers.some((entry: typeof timeEntries.$inferSelect) => entry.founderId !== scope.founderId)) {
        return { previousFounderTimer: true as const };
      }
      if (activeTimers.some((entry: typeof timeEntries.$inferSelect) => timeEntryHasAmbiguousIdentity(entry, scope))) {
        return { ownershipAmbiguous: true as const };
      }
      const activeTimer = activeTimers.find((entry: typeof timeEntries.$inferSelect) => timeEntryMatchesScope(entry, scope));
      if (!activeTimer) await assertTimerIdentityReady(connection);
      return activeTimer ? { active: true, entry: activeTimer } : { active: false, entry: null };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    if ('previousFounderTimer' in result.value && result.value.previousFounderTimer) {
      return res.status(409).json({ error: 'An active timer belongs to a previous founder. Ask that founder to close the exact entry before starting another timer.' });
    }
    if ('ownershipAmbiguous' in result.value && result.value.ownershipAmbiguous) {
      return res.status(409).json({ error: AMBIGUOUS_TIME_ENTRY_OWNER_ERROR });
    }
    res.json(result.value);
  } catch (error) {
    const failure = timerFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    console.error('Error fetching active timer');
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

    const outcome = await withTimerAccountTransaction(db, user, async tx => {
      const scope = await resolveTimeTrackingScope(tx, user, true);
      if (!scope) return { status: 403, body: { error: 'An active worker profile is required' } };
      if (!scope.vaIds.length) return { status: 409, body: { error: AMBIGUOUS_TIME_ENTRY_OWNER_ERROR } };
      const profile = scope.profile;
      let assignment: Pick<typeof taskAssignments.$inferSelect, 'status'> | undefined;
      const isPilotWorker = user.role === 'worker' && isManagerPilotWorker(user.id);
      if (user.role === 'worker') {
        if (!profile) return { status: 403, body: { error: 'Worker profile is required for this task' } };
        const cardId = taskId.split(':')[0];
        // Lock the absent child and parent keys together before considering fallback access.
        const candidates = await readCanonicalAssignments(tx, profile.founderId, [taskId, cardId], { lock: true });
        const exact = candidates.find(candidate => candidate.taskId === taskId);
        if (exact && exact.vaId !== profile.id) {
          return { status: 403, body: { error: 'This task is assigned to a different worker. Ask the founder to update the assignment before tracking time.' } };
        }
        assignment = exact;
        if (!assignment && !isPilotWorker) {
          return { status: 403, body: { error: 'This task is not assigned to your worker account' } };
        }
        if (!assignment && isPilotWorker) {
          if (!assignment && cardId !== taskId) {
            const cardOwner = candidates.find(candidate => candidate.taskId === cardId);
            if (cardOwner && cardOwner.vaId !== profile.id) {
              return { status: 403, body: { error: 'This task is assigned to a different worker. Ask the founder to update the assignment before tracking time.' } };
            }
            assignment = cardOwner;
          }
        }
        if (assignment?.status === 'completed') return { status: 409, body: { error: 'This task is already complete' } };
        if (assignment?.status === 'blocked') {
          return { status: 409, body: { error: 'This task is blocked; resolve the blocker before tracking time' } };
        }
      }
      if (isPilotWorker) {
        if (!profile) return { status: 403, body: { error: 'Worker profile is required for this task' } };
        const cardId = taskId.split(':')[0];
        const [plan] = await tx.select({ listName: aptlssPlans.listName }).from(aptlssPlans)
          .where(and(eq(aptlssPlans.vaId, user.id), eq(aptlssPlans.cardId, cardId))).limit(1);
        const [card] = await tx.select({ listName: atisCards.listName, memberIds: atisCards.memberIds, isArchived: atisCards.isArchived })
          .from(atisCards).where(eq(atisCards.trelloId, cardId)).limit(1);
        let isCardMember = false;
        if (profile.trelloMemberId && card?.memberIds && !card.isArchived) {
          try {
            const members: unknown = JSON.parse(card.memberIds);
            isCardMember = Array.isArray(members) && members.includes(profile.trelloMemberId);
          } catch { /* Malformed membership cannot grant timer access. */ }
        }
        if (!assignment && !isCardMember && !plan) return { status: 403, body: { error: 'This task is not assigned to your worker account' } };
        const [waiting] = await tx.select({ id: aptlssWaitingReasons.id }).from(aptlssWaitingReasons)
          .where(and(eq(aptlssWaitingReasons.vaId, user.id), eq(aptlssWaitingReasons.cardId, cardId), eq(aptlssWaitingReasons.status, 'active'))).limit(1);
        const [cardState] = await tx.select({ state: cardStates.state }).from(cardStates)
          .where(and(eq(cardStates.vaId, user.id), eq(cardStates.cardId, cardId))).limit(1);
        let intervention = false;
        let staleRequiredSource = false;
        try {
          const { snapshot } = await readCurrentManagerHistory(tx as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>, user.id);
          if (!snapshot) return { status: 409, body: { error: WORKER_EXECUTION_HOLD_MESSAGE } };
          const snapshotJson = JSON.stringify(snapshot);
          const assignmentState = await readManagerAssignmentState(tx as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>, user.id);
          if (!assignmentState.complete || !managerExecutionCoverageComplete(snapshotJson, assignmentState.fingerprint)) {
            return { status: 409, body: { error: WORKER_EXECUTION_HOLD_MESSAGE } };
          }
          const sourceRequirements = managerActionSourceRequirements(snapshotJson, cardId);
          let googleStatus: Awaited<ReturnType<typeof getGoogleEvidenceStatus>> | null = null;
          if (sourceRequirements.sourceKeys.some(key => key === 'gmail' || key === 'google_drive')) {
            try { googleStatus = await getGoogleEvidenceStatus(user.id); }
            catch { googleStatus = null; }
          }
          let trelloCache: { cachedAt: string; expiresAt: string } | null = null;
          if (sourceRequirements.sourceKeys.includes('trello')) {
            const [cached] = await tx.select({ cachedAt: trelloCachedCards.cachedAt, expiresAt: trelloCachedCards.expiresAt })
              .from(trelloCachedCards)
              .where(and(eq(trelloCachedCards.userId, user.id), eq(trelloCachedCards.cardId, cardId)))
              .orderBy(desc(trelloCachedCards.cachedAt)).limit(1);
            if (cached) trelloCache = { cachedAt: cached.cachedAt.toISOString(), expiresAt: cached.expiresAt.toISOString() };
          }
          staleRequiredSource = managerActionNeedsSourceVerification(sourceRequirements, {
            trelloCache,
            gmail: googleStatus?.gmail ?? null,
            drive: googleStatus?.drive ?? null,
            googleConnectionReady: googleStatus?.credentialsReady ?? null,
            now: Date.now(),
          });
          intervention = managerIntervenesOnCard(snapshotJson, cardId);
        } catch {
          return { status: 409, body: { error: WORKER_EXECUTION_HOLD_MESSAGE } };
        }
        const reason = timerExecutionBlockReason({ listName: plan?.listName ?? card?.listName ?? '',
          hasActiveWaitingReason: Boolean(waiting),
          actionability: cardState?.state ?? null, hasManagerIntervention: intervention, hasStaleRequiredSource: staleRequiredSource });
        if (reason) return { status: 409, body: { error: reason } };
      }
      const activeEntries = await tx.select().from(timeEntries).where(and(
        timeEntryCandidateScopeWhere(scope), sql`${timeEntries.endTime} IS NULL`
      ));
      if (activeEntries.some((entry: typeof timeEntries.$inferSelect) => timeEntryHasAmbiguousIdentity(entry, scope))) {
        return { status: 409, body: { error: AMBIGUOUS_TIME_ENTRY_OWNER_ERROR } };
      }
      const active = activeEntries.find((entry: typeof timeEntries.$inferSelect) => timeEntryMatchesScope(entry, scope));
      if (active) return { status: 409, body: { error: 'Timer already active', activeTaskId: active.taskId } };
      const workerVaId = scope.vaIds.includes(user.id) ? user.id : scope.vaIds[0];
      const ownership = timeTrackingOwnership(user, profile?.founderId, workerVaId);
      const entry = await insertCanonicalTimer(tx, { taskId, ...ownership, trackedProfileId: profile?.id ?? null, startTime: new Date(), notes });
      if (!entry) throw new Error("Time entry insert returned no row");
      if (user.role === 'worker' && isManagerPilotWorker(user.id)) {
        await enqueueManagerTask(tx, {
          vaId: user.id,
          trigger: "timer_changed",
          eventKey: `timer-start:${entry.id}`,
        });
      }
      return { status: 200, body: { success: true, entry } };
    });
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    const failure = assignmentFailure(error) ?? timerFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    console.error('Error starting timer');
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
    const outcome = await transitionActiveTimer(user, 'stop', req.body?.entryId, notes);
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    const failure = timerFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    console.error('Error stopping timer');
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

    const outcome = await transitionActiveTimer(user, 'pause', req.body?.entryId);
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    const failure = timerFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    console.error('Error pausing timer');
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

    const result = await withTimeTrackingScope(db, user, async (connection, scope) => {
      const rows = await connection.select()
        .from(timeEntries)
        .where(and(timeEntryScopeWhere(scope), eq(timeEntries.taskId, taskId)))
        .orderBy(desc(timeEntries.startTime));
      const entries = rows.filter((entry: typeof timeEntries.$inferSelect) => timeEntryMatchesScope(entry, scope));
      const totalMinutes = entries.reduce(
        (sum: number, entry: typeof timeEntries.$inferSelect) => sum + nonNegativeDurationMinutes(entry),
        0,
      );
      return {
        entries,
        totalMinutes,
        totalHours: Math.round(totalMinutes / 60 * 10) / 10,
        ownershipWarning: scope.ambiguousVaIds.length ? AMBIGUOUS_TIME_ENTRY_OWNER_ERROR : null,
      };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json(result.value);
  } catch (error) {
    console.error('Error fetching task time entries:');
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

    const result = await withTimeTrackingScope(db, user, async (connection, scope) => {
      const { timezone: zone } = await resolveWorkerOperatorContext(user, connection);
      const conditions = [timeEntryScopeWhere(scope)];
      if (startDate && endDate) {
        const start = dateWindowInTimeZone(String(startDate), zone).start;
        const end = new Date(dateWindowInTimeZone(String(endDate), zone).endExclusive.getTime() - 1);
        conditions.push(gte(timeEntries.startTime, start), lte(timeEntries.startTime, end));
      }
      const rows = await connection.select().from(timeEntries)
        .where(and(...conditions)).orderBy(desc(timeEntries.startTime));
      const entries = rows.filter((entry: typeof timeEntries.$inferSelect) => timeEntryMatchesScope(entry, scope));
      const totalMinutes = entries.reduce(
        (sum: number, entry: typeof timeEntries.$inferSelect) => sum + nonNegativeDurationMinutes(entry),
        0,
      );
      const byDate: Record<string, number> = {};
      const byTask: Record<string, number> = {};
      entries.forEach((entry: typeof timeEntries.$inferSelect) => {
        const date = dateKeyInTimeZone(new Date(entry.startTime), zone);
        byDate[date] = (byDate[date] || 0) + nonNegativeDurationMinutes(entry);
        byTask[entry.taskId] = (byTask[entry.taskId] || 0) + nonNegativeDurationMinutes(entry);
      });
      return {
        entries,
        totalMinutes,
        totalHours: Math.round(totalMinutes / 60 * 10) / 10,
        byDate,
        byTask,
        entryCount: entries.length,
        ownershipWarning: scope.ambiguousVaIds.length ? AMBIGUOUS_TIME_ENTRY_OWNER_ERROR : null,
      };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json(result.value);
  } catch (error) {
    console.error('Error fetching time summary:');
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

    const result = await withTimeTrackingScope(db, user, async (connection, scope) => {
      const context = await resolveWorkerOperatorContext(user, connection);
      const zone = context.timezone;
      const bounds = weekDateKeys(dateKeyInTimeZone(new Date(), zone));
      const startOfWeek = dateWindowInTimeZone(bounds.startDateKey, zone).start;
      const endOfWeek = new Date(dateWindowInTimeZone(bounds.endDateKey, zone).endExclusive.getTime() - 1);

      const weekRows = await connection.select()
        .from(timeEntries)
        .where(and(
          timeEntryScopeWhere(scope),
          gte(timeEntries.startTime, startOfWeek),
          lte(timeEntries.startTime, endOfWeek),
        ));
      const weekEntries = weekRows.filter((entry: typeof timeEntries.$inferSelect) => timeEntryMatchesScope(entry, scope));

      const actualMinutes = weekEntries.reduce(
        (sum: number, entry: typeof timeEntries.$inferSelect) => sum + nonNegativeDurationMinutes(entry),
        0,
      );
      const actualHours = Math.round(actualMinutes / 60 * 10) / 10;

      const { weeklyHoursMin, weeklyHoursMax, dailyHoursMin, dailyHoursMax } = context;

    // Calculate daily breakdown
      const dailyBreakdown: Record<string, number> = {};
      for (let i = 0; i < 7; i++) {
        dailyBreakdown[addDaysToDateKey(bounds.startDateKey, i)] = 0;
      }

      weekEntries.forEach((entry: typeof timeEntries.$inferSelect) => {
        const date = dateKeyInTimeZone(new Date(entry.startTime), zone);
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

      return {
        weekStart: dateKeyInTimeZone(startOfWeek, zone),
        weekEnd: dateKeyInTimeZone(endOfWeek, zone),
        actualHours,
        actualMinutes,
        weeklyHoursMin,
        weeklyHoursMax,
        dailyHoursMin,
        dailyHoursMax,
        dailyHours,
        progressPercent,
        onTrack: actualHours >= weeklyHoursMin && actualHours <= weeklyHoursMax,
        status: actualHours < weeklyHoursMin ? 'under' : actualHours > weeklyHoursMax ? 'over' : 'on_track',
        ownershipWarning: scope.ambiguousVaIds.length ? AMBIGUOUS_TIME_ENTRY_OWNER_ERROR : null,
      };
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json(result.value);
  } catch (error) {
    console.error('Error fetching weekly progress:');
    res.status(500).json({ error: 'Failed to fetch weekly progress' });
  }
});

export default router;
