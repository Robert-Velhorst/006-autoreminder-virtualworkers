import { Router } from 'express';
import { getDb } from '../db';
import { 
  vaProfiles, 
  taskAssignments, 
  taskDependencies, 
  founderPriorityOverrides,
  clients,
  communicationLog,
  timeEntries,
  handoffNotes,
  dailyBriefings,
  users,
  atisCards,
  atisBoards,
  atisCardUnderstanding,
  trelloCachedCards,
} from '../../drizzle/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { PASSWORD_MIN_LENGTH, validatePassword } from '../passwordPolicy';
import { sendMorningBriefing, sendEODReport, sendWorkerInvitationEmail, validateEmailProvider } from '../services/email';
import { websocketService } from '../services/websocket';
import { invalidateCache } from '../services/trello-cache';
import { fetchWithRetry } from '../utils/retry';
import { fetchVerifiedTrelloBoardIds, TrelloBoardInventoryUnavailableError } from '../trelloBoardInventory';
import { requestUser, requireAuthenticated } from '../middleware/auth';
import { didUpdateSingleTaskAssignment } from '../taskAssignmentMutation';
import {
  createWorkerInvitation,
  markWorkerInvitationSent,
  WorkerInvitationError,
} from '../workerInvitations';
import {
  BriefingSettingsValidationError,
  getBriefingSettings,
  saveBriefingSettings,
} from '../briefingSettings';
import { mapWithConcurrency } from '../utils/concurrency';
import { selectWorkerProfile } from '../workerOperatorContext';
import { isManagerPilotWorker } from '../aptlssManagerPilot';
import { getGoogleEvidenceStatus } from '../googleEvidence';
import { managerActionNeedsSourceVerification, managerActionSourceRequirements } from '../timerAccess';
import { readCurrentManagerHistory } from '../aptlssManagerHistoryDb';
import { WORKER_EXECUTION_HOLD_MESSAGE } from '../../shared/aptlssManager';

const router = Router();
router.use(requireAuthenticated);
router.use((req, res, next) => {
  const user = requestUser(req)!;
  const routePath = req.path.toLowerCase();
  const isWorkerRoute = routePath === '/worker' || routePath.startsWith('/worker/');
  if (isWorkerRoute && user.role !== 'worker') {
    return res.status(403).json({ error: 'Worker access required' });
  }
  if (!isWorkerRoute && user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
});

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const workerProfileUpdateFields = new Set([
  'name', 'email', 'timezone', 'skills', 'hourlyRate', 'currency',
  'workStartHour', 'workEndHour', 'workingDays',
  'breakfastTime', 'breakfastDuration', 'lunchTime', 'lunchDuration',
  'dinnerTime', 'dinnerDuration', 'trelloMemberId', 'status',
]);

async function getWorkerProfileForAccount(db: Database, userId: number) {
  const profiles = await db.select().from(vaProfiles).where(eq(vaProfiles.userId, userId)).orderBy(vaProfiles.id);
  return { profiles, profile: selectWorkerProfile(profiles) };
}

function ambiguousWorkerProfileResponse(profiles: unknown[]) {
  return profiles.length > 0
    ? { status: 409, body: { error: 'Your worker profile is ambiguous. Ask an administrator to resolve it before continuing.' } }
    : null;
}

function pilotCompletionResponse(userId: number, res: import('express').Response) {
  if (!isManagerPilotWorker(userId)) return false;
  res.status(409).json({ error: 'This older task action cannot close APTLSS pilot work. The task remains open; ask the founder to review the completion.' });
  return true;
}

async function getFounderWorker(db: Database, founderId: number, rawVaId: unknown) {
  const vaId = Number(rawVaId);
  if (!Number.isSafeInteger(vaId) || vaId <= 0) return null;

  const workers = await db.select({ id: vaProfiles.id })
    .from(vaProfiles)
    .where(and(eq(vaProfiles.id, vaId), eq(vaProfiles.founderId, founderId)))
    .limit(1);
  return workers[0] ?? null;
}

async function fetchTrelloCardSummary(taskId: string) {
  const apiKey = process.env.TRELLO_API_KEY;
  const apiToken = process.env.TRELLO_TOKEN;

  if (!apiKey || !apiToken) {
    return null;
  }

  const cardId = taskId.split(':')[0];
  if (!cardId) return null;
  const encodedCardId = encodeURIComponent(cardId);

  try {
    const response = await fetchWithRetry(
      `https://api.trello.com/1/cards/${encodedCardId}?key=${apiKey}&token=${apiToken}&fields=name,desc,due,labels`,
      undefined,
      { maxRetries: 1, timeoutMs: 15_000 },
    );

    if (!response.ok) {
      return null;
    }

    const card = await response.json();
    const labels = Array.isArray(card.labels)
      ? card.labels.map((label: any) => label?.name || label?.color).filter(Boolean)
      : [];
    const priority = labels.some((label: string) => /critical/i.test(label))
      ? 'CRITICAL'
      : labels.some((label: string) => /urgent/i.test(label))
        ? 'URGENT'
        : labels.some((label: string) => /high/i.test(label))
          ? 'HIGH'
          : 'NORMAL';

    return {
      cardId,
      cardName: card.name || 'Trello Card',
      title: card.name || `Task ${taskId.split(':').pop() || cardId}`,
      dueDate: card.due || null,
      labels,
      priority,
      description: card.desc || '',
    };
  } catch (error) {
    console.warn('[VA Management] Failed to fetch Trello card summary:', error);
    return null;
  }
}

// ============================================
// VA PROFILES
// ============================================

// Get all VAs for the current founder
router.get('/vas', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const vas = await db.select().from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
    
    res.json(vas);
  } catch (error) {
    console.error('Error fetching VAs:', error);
    res.status(500).json({ error: 'Failed to fetch VAs' });
  }
});

// Create a new VA profile
router.post('/vas/invite', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const configuredBaseUrl = process.env.PUBLIC_URL?.trim()
      || process.env.WEBHOOK_BASE_URL?.trim()
      || process.env.APP_URL?.trim()
      || process.env.TRELLO_WEBHOOK_CALLBACK_URL?.trim();
    if (!configuredBaseUrl && process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'A public dashboard URL is required before worker invitations can be sent.' });
    }
    const baseUrl = new URL(configuredBaseUrl || `${req.protocol}://${req.get('host')}`).origin;

    const invitation = await createWorkerInvitation(user.id, {
      name: typeof req.body?.name === 'string' ? req.body.name : '',
      email: typeof req.body?.email === 'string' ? req.body.email : '',
      timezone: typeof req.body?.timezone === 'string' ? req.body.timezone : undefined,
      hourlyRate: Number.isInteger(req.body?.hourlyRate) ? req.body.hourlyRate : null,
      currency: typeof req.body?.currency === 'string' ? req.body.currency : undefined,
      workStartHour: Number.isInteger(req.body?.workStartHour) ? req.body.workStartHour : undefined,
      workEndHour: Number.isInteger(req.body?.workEndHour) ? req.body.workEndHour : undefined,
      workingDays: typeof req.body?.workingDays === 'string' ? req.body.workingDays : undefined,
      breakfastTime: Number.isInteger(req.body?.breakfastTime) ? req.body.breakfastTime : null,
      breakfastDuration: Number.isInteger(req.body?.breakfastDuration) ? req.body.breakfastDuration : undefined,
      lunchTime: Number.isInteger(req.body?.lunchTime) ? req.body.lunchTime : null,
      lunchDuration: Number.isInteger(req.body?.lunchDuration) ? req.body.lunchDuration : undefined,
      dinnerTime: Number.isInteger(req.body?.dinnerTime) ? req.body.dinnerTime : null,
      dinnerDuration: Number.isInteger(req.body?.dinnerDuration) ? req.body.dinnerDuration : undefined,
      trelloMemberId: typeof req.body?.trelloMemberId === 'string' ? req.body.trelloMemberId : null,
    });
    const inviteUrl = `${baseUrl}/accept-invite/${encodeURIComponent(invitation.token)}`;
    const emailSent = await sendWorkerInvitationEmail({
      email: invitation.email,
      workerName: invitation.name,
      inviteUrl,
      expiresAt: invitation.expiresAt,
    });
    if (emailSent) await markWorkerInvitationSent(invitation.invitationId);

    return res.status(201).json({
      success: true,
      workerId: invitation.vaId,
      invitationId: invitation.invitationId,
      emailSent,
      inviteUrl,
      expiresAt: invitation.expiresAt,
    });
  } catch (error) {
    if (error instanceof WorkerInvitationError) {
      const status = error.code === 'conflict' ? 409 : error.code === 'database' ? 503 : 400;
      return res.status(status).json({ error: error.message });
    }
    console.error('Error inviting worker:', error);
    return res.status(500).json({ error: 'Failed to create worker invitation' });
  }
});

router.post('/vas', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { 
      name, email, password, timezone, skills, hourlyRate, currency, 
      workStartHour, workEndHour, workingDays,
      breakfastTime, breakfastDuration,
      lunchTime, lunchDuration,
      dinnerTime, dinnerDuration,
      trelloMemberId
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
      validatePassword(password);
    } catch {
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Check if email already taken
    const existingUser = await db.select().from(users).where(eq(users.openId, email));
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create system user for worker
    const userResult = await db.insert(users).values({
      openId: email,
      name,
      email,
      loginMethod: 'local',
      role: 'worker',
      passwordHash,
      lastSignedIn: new Date(),
    });
    const newUserId = userResult[0].insertId;

    const result = await db.insert(vaProfiles).values({
      founderId: user.id,
      userId: newUserId,
      name,
      email,
      timezone: timezone || 'Asia/Manila',
      skills: skills ? JSON.stringify(skills) : null,
      hourlyRate,
      currency: currency || 'USD',
      workStartHour: workStartHour ?? 9,
      workEndHour: workEndHour ?? 18,
      workingDays: workingDays || '1,2,3,4,5',
      breakfastTime: breakfastTime ?? null,
      breakfastDuration: breakfastDuration ?? 0,
      lunchTime: lunchTime ?? 12,
      lunchDuration: lunchDuration ?? 60,
      dinnerTime: dinnerTime ?? null,
      dinnerDuration: dinnerDuration ?? 0,
      trelloMemberId: trelloMemberId || null,
    });

    res.json({ success: true, id: result[0].insertId });
  } catch (error) {
    console.error('Error creating VA:', error);
    res.status(500).json({ error: 'Failed to create VA' });
  }
});

// Update VA profile
router.put('/vas/:id', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const vaId = parseInt(req.params.id);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { password, ...requestedUpdates } = body;
    if (['id', 'userId', 'founderId'].some((field) => Object.prototype.hasOwnProperty.call(requestedUpdates, field))) {
      return res.status(400).json({ error: 'Worker account and founder ownership cannot be changed' });
    }
    const updates: Record<string, any> = Object.fromEntries(
      Object.entries(requestedUpdates).filter(([field]) => workerProfileUpdateFields.has(field)),
    );

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    // Verify ownership
    const existing = await db.select().from(vaProfiles).where(
      and(eq(vaProfiles.id, vaId), eq(vaProfiles.founderId, user.id))
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'VA not found' });
    }

    const linkedUserId = existing[0].userId;
    const changesCredentials = Boolean(password)
      || (updates.email && updates.email !== existing[0].email);
    if (changesCredentials) {
      const linkedAccount = await db.select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, linkedUserId))
        .limit(1);
      if (linkedAccount[0]?.role !== 'worker') {
        return res.status(409).json({ error: 'The linked account is not a worker account' });
      }
    }

    // Handle password update if provided
    if (password) {
      try {
        validatePassword(password);
      } catch {
        return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await db.update(users)
        .set({ passwordHash })
        .where(and(eq(users.id, linkedUserId), eq(users.role, 'worker')));
    }

    // Handle email update if provided
    if (updates.email && updates.email !== existing[0].email) {
      // Check if email already taken by someone else
      const existingUser = await db.select().from(users).where(
        and(eq(users.openId, updates.email), sql`${users.id} != ${linkedUserId}`)
      );
      if (existingUser.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      // Update system user login credentials
      await db.update(users)
        .set({ openId: updates.email, email: updates.email })
        .where(and(eq(users.id, linkedUserId), eq(users.role, 'worker')));
    }

    await db.update(vaProfiles)
      .set({
        ...updates,
        skills: updates.skills ? JSON.stringify(updates.skills) : existing[0].skills,
      })
      .where(eq(vaProfiles.id, vaId));

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating VA:', error);
    res.status(500).json({ error: 'Failed to update VA' });
  }
});

// Delete VA profile
router.delete('/vas/:id', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const vaId = parseInt(req.params.id);
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    await db.delete(vaProfiles).where(
      and(eq(vaProfiles.id, vaId), eq(vaProfiles.founderId, user.id))
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting VA:', error);
    res.status(500).json({ error: 'Failed to delete VA' });
  }
});

// ============================================
// TIMEZONE DETECTION
// ============================================

// Get detected timezone for a VA
router.get('/vas/:id/timezone', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const vaId = parseInt(req.params.id);
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Get VA profile
    const va = await db.select().from(vaProfiles).where(
      and(eq(vaProfiles.id, vaId), eq(vaProfiles.founderId, user.id))
    ).limit(1);

    if (va.length === 0) {
      return res.status(404).json({ error: 'VA not found' });
    }

    const profile = va[0];
    
    // Import timezone detection
    const { getVATimezone, detectTimezoneFromLocation, detectTimezoneFromEmail } = 
      await import('../services/timezone-detection');
    
    // Get detected timezone
    const detectedTimezone = await getVATimezone(vaId);
    
    // Get detection sources for display
    // Note: vaProfiles doesn't have a location field, so we use name as a fallback
    const nameTimezone = profile.name ? detectTimezoneFromLocation(profile.name) : null;
    const emailTimezone = profile.email ? detectTimezoneFromEmail(profile.email) : null;
    
    res.json({
      vaId,
      vaName: profile.name,
      currentTimezone: profile.timezone,
      detectedTimezone,
      detectionSources: {
        fromName: nameTimezone,
        fromEmail: emailTimezone,
        name: profile.name,
        email: profile.email,
      },
      isManuallySet: profile.timezone && 
        profile.timezone !== 'Asia/Manila' && 
        profile.timezone !== detectedTimezone,
    });
  } catch (error) {
    console.error('Error getting VA timezone:', error);
    res.status(500).json({ error: 'Failed to get timezone' });
  }
});

// Update VA timezone
router.put('/vas/:id/timezone', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const vaId = parseInt(req.params.id);
    const { timezone } = req.body;
    
    if (!timezone) {
      return res.status(400).json({ error: 'Timezone is required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Verify ownership
    const existing = await db.select().from(vaProfiles).where(
      and(eq(vaProfiles.id, vaId), eq(vaProfiles.founderId, user.id))
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'VA not found' });
    }

    await db.update(vaProfiles)
      .set({ timezone })
      .where(eq(vaProfiles.id, vaId));

    res.json({ success: true, timezone });
  } catch (error) {
    console.error('Error updating VA timezone:', error);
    res.status(500).json({ error: 'Failed to update timezone' });
  }
});

// ============================================
// TASK ASSIGNMENTS
// ============================================

// Assign task to VA
router.post('/assignments', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : '';
    const vaId = Number(req.body?.vaId);
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
    if (!taskId || !Number.isSafeInteger(vaId) || vaId <= 0) {
      return res.status(400).json({ error: 'A task ID and valid worker profile are required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const worker = await getFounderWorker(db, user.id, vaId);
    if (!worker) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }

    // Check if already assigned
    const existing = await db.select().from(taskAssignments).where(
      and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.founderId, user.id))
    );

    if (existing.length > 0) {
      // Update existing assignment
      await db.update(taskAssignments)
        .set({ vaId, notes, assignedAt: new Date() })
        .where(eq(taskAssignments.id, existing[0].id));
    } else {
      // Create new assignment
      await db.insert(taskAssignments).values({
        taskId,
        vaId,
        founderId: user.id,
        assignedBy: user.id,
        notes,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error assigning task:', error);
    res.status(500).json({ error: 'Failed to assign task' });
  }
});

// Get assignments for a VA
router.get('/assignments/va/:vaId', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const vaId = parseInt(req.params.vaId);
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const assignments = await db.select().from(taskAssignments).where(
      and(eq(taskAssignments.vaId, vaId), eq(taskAssignments.founderId, user.id))
    );

    res.json(assignments);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Update assignment status
router.put('/assignments/:taskId/status', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { taskId } = req.params;
    const { status } = req.body;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    await db.update(taskAssignments)
      .set({ status })
      .where(and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.founderId, user.id)));

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating assignment status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ============================================
// TASK DEPENDENCIES
// ============================================

// Add dependency
router.post('/dependencies', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { taskId, blockedByTaskId, dependencyType } = req.body;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    await db.insert(taskDependencies).values({
      taskId,
      blockedByTaskId,
      founderId: user.id,
      dependencyType: dependencyType || 'finish_to_start',
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding dependency:', error);
    res.status(500).json({ error: 'Failed to add dependency' });
  }
});

// Get dependencies for a task
router.get('/dependencies/:taskId', async (req: any, res) => {
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

    const blockedBy = await db.select().from(taskDependencies).where(
      and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.founderId, user.id))
    );

    const blocks = await db.select().from(taskDependencies).where(
      and(eq(taskDependencies.blockedByTaskId, taskId), eq(taskDependencies.founderId, user.id))
    );

    res.json({ blockedBy, blocks });
  } catch (error) {
    console.error('Error fetching dependencies:', error);
    res.status(500).json({ error: 'Failed to fetch dependencies' });
  }
});

// ============================================
// FOUNDER PRIORITY OVERRIDES
// ============================================

// Set priority override
router.post('/priority-override', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { taskId, priority, reason, expiresAt } = req.body;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    // Upsert priority override
    const existing = await db.select().from(founderPriorityOverrides).where(
      and(eq(founderPriorityOverrides.taskId, taskId), eq(founderPriorityOverrides.founderId, user.id))
    );

    if (existing.length > 0) {
      await db.update(founderPriorityOverrides)
        .set({ priority, reason, expiresAt: expiresAt ? new Date(expiresAt) : null })
        .where(eq(founderPriorityOverrides.id, existing[0].id));
    } else {
      await db.insert(founderPriorityOverrides).values({
        taskId,
        founderId: user.id,
        priority,
        reason,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });
    }

    // Invalidate cache to force reschedule
    invalidateCache(user.id, user.openId, 'tasks');

    // Notify connected clients about the priority change
    websocketService.emitToUser(user.openId, 'task:priority-changed', {
      taskId,
      priority,
      reason,
      founderId: user.id
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error setting priority override:', error);
    res.status(500).json({ error: 'Failed to set priority' });
  }
});

// Get all priority overrides
router.get('/priority-overrides', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const overrides = await db.select().from(founderPriorityOverrides).where(
      eq(founderPriorityOverrides.founderId, user.id)
    );

    res.json(overrides);
  } catch (error) {
    console.error('Error fetching priority overrides:', error);
    res.status(500).json({ error: 'Failed to fetch overrides' });
  }
});

// ============================================
// CLIENTS
// ============================================

// Get all clients
router.get('/clients', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const clientList = await db.select().from(clients).where(eq(clients.founderId, user.id));
    
    res.json(clientList);
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// Create client
router.post('/clients', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, priority, trelloBoardIds, contactEmail, notes } = req.body;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const result = await db.insert(clients).values({
      founderId: user.id,
      name,
      priority: priority || 'standard',
      trelloBoardIds: trelloBoardIds ? JSON.stringify(trelloBoardIds) : null,
      contactEmail,
      notes,
    });

    res.json({ success: true, id: result[0].insertId });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// ============================================
// COMMUNICATION LOG
// ============================================

// Add message to log
router.post('/communication', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskId = typeof req.body?.taskId === 'string' && req.body.taskId.trim()
      ? req.body.taskId.trim()
      : null;
    const recipientId = req.body?.toUserId == null ? null : Number(req.body.toUserId);
    const messageType = req.body?.messageType;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const context = req.body?.context;
    const allowedMessageTypes = new Set(['question', 'decision', 'update', 'handoff', 'feedback']);

    if (!message || !allowedMessageTypes.has(messageType)) {
      return res.status(400).json({ error: 'A message and valid message type are required' });
    }
    if (recipientId !== null && (!Number.isSafeInteger(recipientId) || recipientId <= 0)) {
      return res.status(400).json({ error: 'Recipient must be a valid user ID' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    if (taskId) {
      const assignments = await db.select({ id: taskAssignments.id }).from(taskAssignments)
        .where(and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.founderId, user.id)))
        .limit(1);
      if (!assignments[0]) {
        return res.status(404).json({ error: 'Task assignment not found' });
      }
    }

    if (recipientId !== null && recipientId !== user.id) {
      const recipients = await db.select({ id: vaProfiles.id }).from(vaProfiles)
        .where(and(eq(vaProfiles.userId, recipientId), eq(vaProfiles.founderId, user.id)))
        .limit(1);
      if (!recipients[0]) {
        return res.status(404).json({ error: 'Recipient is not a worker in this workspace' });
      }
    }

    await db.insert(communicationLog).values({
      taskId,
      fromUserId: user.id,
      toUserId: recipientId,
      messageType,
      message,
      context: context ? JSON.stringify(context) : null,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding communication:', error);
    res.status(500).json({ error: 'Failed to add message' });
  }
});

// Get communication log for a task
router.get('/communication/:taskId', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskId = typeof req.params.taskId === 'string' ? req.params.taskId.trim() : '';
    if (!taskId) {
      return res.status(400).json({ error: 'Task ID is required' });
    }
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const assignments = await db.select({ id: taskAssignments.id }).from(taskAssignments)
      .where(and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.founderId, user.id)))
      .limit(1);
    if (!assignments[0]) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }

    const messages = await db.select().from(communicationLog)
      .where(eq(communicationLog.taskId, taskId))
      .orderBy(desc(communicationLog.createdAt));

    res.json(messages);
  } catch (error) {
    console.error('Error fetching communication:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ============================================
// TIME TRACKING
// ============================================

// Start timer
router.post('/time-entries/start', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : '';
    const vaId = Number(req.body?.vaId);
    if (!taskId || !Number.isInteger(vaId) || vaId <= 0) {
      return res.status(400).json({ error: 'A task ID and valid worker profile are required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const worker = await db.select({ id: vaProfiles.id, userId: vaProfiles.userId })
      .from(vaProfiles)
      .where(and(eq(vaProfiles.id, vaId), eq(vaProfiles.founderId, user.id)))
      .limit(1);
    if (!worker[0]) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }
    if (isManagerPilotWorker(worker[0].userId)) {
      const cardId = taskId.split(':')[0];
      try {
        const { snapshot } = await readCurrentManagerHistory(db, worker[0].userId);
        if (!snapshot) return res.status(409).json({ error: WORKER_EXECUTION_HOLD_MESSAGE });
        const sourceRequirements = managerActionSourceRequirements(JSON.stringify(snapshot), cardId);
        let googleStatus: Awaited<ReturnType<typeof getGoogleEvidenceStatus>> | null = null;
        if (sourceRequirements.sourceKeys.some(key => key === 'gmail' || key === 'google_drive')) {
          try { googleStatus = await getGoogleEvidenceStatus(worker[0].userId); }
          catch { googleStatus = null; }
        }
        let trelloCache: { cachedAt: string; expiresAt: string } | null = null;
        if (sourceRequirements.sourceKeys.includes('trello')) {
          const [cached] = await db.select({ cachedAt: trelloCachedCards.cachedAt, expiresAt: trelloCachedCards.expiresAt })
            .from(trelloCachedCards)
            .where(and(eq(trelloCachedCards.userId, worker[0].userId), eq(trelloCachedCards.cardId, cardId)))
            .orderBy(desc(trelloCachedCards.cachedAt))
            .limit(1);
          if (cached) trelloCache = { cachedAt: cached.cachedAt.toISOString(), expiresAt: cached.expiresAt.toISOString() };
        }
        if (managerActionNeedsSourceVerification(sourceRequirements, {
          trelloCache,
          gmail: googleStatus?.gmail ?? null,
          drive: googleStatus?.drive ?? null,
          googleConnectionReady: googleStatus?.credentialsReady ?? null,
          now: Date.now(),
        })) {
          return res.status(409).json({ error: 'A source required by the next step is out of date or not verified. Check that source before starting work.' });
        }
      } catch {
        return res.status(409).json({ error: WORKER_EXECUTION_HOLD_MESSAGE });
      }
    }
    const result = await db.insert(timeEntries).values({
      taskId,
      vaId,
      founderId: user.id,
      startTime: new Date(),
    });

    res.json({ success: true, id: result[0].insertId });
  } catch (error) {
    console.error('Error starting timer:', error);
    res.status(500).json({ error: 'Failed to start timer' });
  }
});

// Stop timer
router.put('/time-entries/:id/stop', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const entryId = Number(req.params.id);
    const { notes } = req.body;
    if (!Number.isInteger(entryId) || entryId <= 0) {
      return res.status(400).json({ error: 'A valid time entry ID is required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const existing = await db.select().from(timeEntries).where(
      and(eq(timeEntries.id, entryId), eq(timeEntries.founderId, user.id))
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Time entry not found' });
    }

    const endTime = new Date();
    const startTime = new Date(existing[0].startTime);
    const durationMinutes = Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 60000));

    await db.update(timeEntries)
      .set({ endTime, durationMinutes, notes })
      .where(and(eq(timeEntries.id, entryId), eq(timeEntries.founderId, user.id)));

    res.json({ success: true, durationMinutes });
  } catch (error) {
    console.error('Error stopping timer:', error);
    res.status(500).json({ error: 'Failed to stop timer' });
  }
});

// Get time entries for a task
router.get('/time-entries/:taskId', async (req: any, res) => {
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

    const entries = await db.select().from(timeEntries)
      .where(and(eq(timeEntries.taskId, taskId), eq(timeEntries.founderId, user.id)))
      .orderBy(desc(timeEntries.startTime));

    // Calculate total time
    const totalMinutes = entries.reduce((sum: number, e: typeof entries[0]) => sum + (e.durationMinutes || 0), 0);

    res.json({ entries, totalMinutes });
  } catch (error) {
    console.error('Error fetching time entries:', error);
    res.status(500).json({ error: 'Failed to fetch entries' });
  }
});

// ============================================
// HANDOFF NOTES
// ============================================

// Create handoff note
router.post('/handoff', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : '';
    const fromVaId = Number(req.body?.fromVaId);
    const toVaId = req.body?.toVaId == null ? null : Number(req.body.toVaId);
    const whereLeftOff = typeof req.body?.whereLeftOff === 'string' ? req.body.whereLeftOff.trim() : '';
    const nextSteps = typeof req.body?.nextSteps === 'string' ? req.body.nextSteps : null;
    const blockers = typeof req.body?.blockers === 'string' ? req.body.blockers : null;
    if (!taskId || !whereLeftOff || !Number.isSafeInteger(fromVaId) || fromVaId <= 0
      || (toVaId !== null && (!Number.isSafeInteger(toVaId) || toVaId <= 0))) {
      return res.status(400).json({ error: 'A task, handoff note, and valid worker profile are required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const fromWorker = await getFounderWorker(db, user.id, fromVaId);
    const toWorker = toVaId === null ? null : await getFounderWorker(db, user.id, toVaId);
    if (!fromWorker || (toVaId !== null && !toWorker)) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }

    const assignments = await db.select({ vaId: taskAssignments.vaId }).from(taskAssignments)
      .where(and(
        eq(taskAssignments.taskId, taskId),
        eq(taskAssignments.founderId, user.id),
        inArray(taskAssignments.status, ['assigned', 'in_progress', 'blocked']),
      ));
    if (assignments.length === 0) {
      return res.status(404).json({ error: 'Task assignment not found' });
    }
    if (assignments.some(assignment => assignment.vaId !== fromVaId)) {
      return res.status(409).json({ error: 'The handoff sender is no longer assigned to this task' });
    }

    await db.insert(handoffNotes).values({
      taskId,
      fromVaId,
      toVaId,
      founderId: user.id,
      whereLeftOff,
      nextSteps,
      blockers,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error creating handoff:', error);
    res.status(500).json({ error: 'Failed to create handoff' });
  }
});

// Get handoff notes for a task
router.get('/handoff/:taskId', async (req: any, res) => {
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

    const notes = await db.select().from(handoffNotes)
      .where(and(eq(handoffNotes.taskId, taskId), eq(handoffNotes.founderId, user.id)))
      .orderBy(desc(handoffNotes.createdAt));

    res.json(notes);
  } catch (error) {
    console.error('Error fetching handoff notes:', error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// ============================================
// ASSIGNMENTS LIST (for Founder Dashboard)
// ============================================

router.get('/assignments', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const apiKey = process.env.TRELLO_API_KEY?.trim();
    const token = process.env.TRELLO_TOKEN?.trim();
    if (!apiKey || !token) {
      throw new TrelloBoardInventoryUnavailableError();
    }

    const allowedTrelloBoardIds = await fetchVerifiedTrelloBoardIds(apiKey, token);
    if (allowedTrelloBoardIds.length === 0) {
      return res.json([]);
    }
    
    // Get all cards left joined with taskAssignments for this founder, filtered by user's Trello boards
    const cards = await db.select({
      id: atisCards.id,
      trelloId: atisCards.trelloId,
      name: atisCards.name,
      dueDate: atisCards.dueDate,
      labels: atisCards.labels,
      listName: atisCards.listName,
      boardId: atisCards.boardId,
      boardName: atisBoards.name,
      description: atisCards.description,
      
      // AI Understanding info
      goal: atisCardUnderstanding.goal,
      deliverable: atisCardUnderstanding.deliverable,
      taskType: atisCardUnderstanding.taskType,
      complexity: atisCardUnderstanding.complexity,
      aptlssChecklist: atisCardUnderstanding.aptlssChecklist,
      estimatedMinutes: atisCardUnderstanding.estimatedMinutes,
      
      // Assignment info (if exists)
      assignmentId: taskAssignments.id,
      vaId: taskAssignments.vaId,
      status: taskAssignments.status,
      notes: taskAssignments.notes,
      scheduledStart: taskAssignments.startTime,
      scheduledEnd: taskAssignments.endTime,
    })
      .from(atisCards)
      .innerJoin(atisBoards, eq(atisCards.boardId, atisBoards.id))
      .leftJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
      .leftJoin(taskAssignments, and(
        eq(atisCards.trelloId, taskAssignments.taskId),
        eq(taskAssignments.founderId, user.id)
      ))
      .where(and(
        eq(atisCards.isArchived, 0),
        inArray(atisBoards.trelloId, allowedTrelloBoardIds)
      ))
      .orderBy(atisCards.dueDate)
      .limit(50);
    
    // Get VA names
    const vas = await db.select().from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
    const vaMap = new Map(vas.map((v: typeof vas[0]) => [v.id, v.name]));
    
    // Get priority overrides
    const overrides = await db.select().from(founderPriorityOverrides)
      .where(eq(founderPriorityOverrides.founderId, user.id));
    const overrideMap = new Map<string, string>(overrides.map((o: any) => [o.taskId, o.priority]));
    
    // Get clients to map boardId to clientPriority
    const allClients = await db.select().from(clients).where(eq(clients.founderId, user.id));
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
    
    const INACTIVE_LIST_KEYWORDS = ['done', 'completed', 'complete', 'archive', 'archived', 'info'];
    const isInactiveListName = (listName?: string | null) => {
      if (!listName) return false;
      const normalized = listName.toLowerCase().trim();
      return INACTIVE_LIST_KEYWORDS.some((keyword) => normalized === keyword || normalized.includes(keyword));
    };

    const result = cards
      .filter((c: any) => !isInactiveListName(c.listName))
      .map((c: any) => {
        const cardId = c.trelloId;
      
      // Parse labels
      let parsedLabels: string[] = [];
      if (c.labels) {
        try {
          const lObj = JSON.parse(c.labels);
          parsedLabels = Array.isArray(lObj) ? lObj.map((l: any) => l.name || l) : [];
        } catch {
          parsedLabels = [];
        }
      }
      
      // Determine priority
      let priority = 'normal';
      if (overrideMap.has(c.trelloId)) {
        priority = overrideMap.get(c.trelloId) || 'normal';
      } else if (parsedLabels.some((l: string) => /critical/i.test(l))) {
        priority = 'critical';
      } else if (parsedLabels.some((l: string) => /urgent/i.test(l))) {
        priority = 'urgent';
      } else if (parsedLabels.some((l: string) => /high/i.test(l))) {
        priority = 'high';
      }

      // Parse checklist
      let checklist: any[] = [];
      if (c.aptlssChecklist) {
        try {
          const parsed = JSON.parse(c.aptlssChecklist);
          if (Array.isArray(parsed) && parsed.length > 0) {
            checklist = parsed.map((item: any, index: number) => ({
              id: `${c.id}-step-${index}`,
              step: item.name || item.step || item.description || 'Step',
              timeMinutes: item.estimatedMinutes || item.timeMinutes || item.time || 15,
              aptlssType: item.priority || item.aptlssType || item.type || 'T',
            }));
          }
        } catch (e) {
          console.warn('[ATIS] Failed to parse checklist in assignments view:', e);
        }
      }

      return {
        id: c.assignmentId || c.trelloId, // Fallback to trelloId if unassigned so key is unique
        taskId: c.trelloId,
        taskTitle: c.name,
        cardName: c.name,
        cardId: cardId,
        vaId: c.vaId || null,
        vaName: c.vaId ? vaMap.get(c.vaId) : null,
        workerId: c.vaId || null,
        workerName: c.vaId ? vaMap.get(c.vaId) : null,
        priority: priority,
        isPriorityOverride: overrideMap.has(c.trelloId),
        status: c.status || 'unassigned',
        estimatedMinutes: c.estimatedMinutes || 60,
        scheduledStart: c.scheduledStart ? new Date(c.scheduledStart).toISOString() : null,
        scheduledEnd: c.scheduledEnd ? new Date(c.scheduledEnd).toISOString() : null,
        blockedBy: [],
        clientProject: c.boardName,
        clientName: boardToClientMap.get(c.boardId)?.name,
        clientPriority: boardToClientMap.get(c.boardId)?.priority || 'standard',
        dueDate: c.dueDate ? new Date(c.dueDate).toISOString() : null,
        labels: parsedLabels,
        description: c.description || '',
        goal: c.goal || '',
        deliverable: c.deliverable || '',
        complexity: c.complexity || 'medium',
        taskType: c.taskType || 'admin',
        checklist: checklist,
      };
    });

    res.json(result);
  } catch (error) {
    if (error instanceof TrelloBoardInventoryUnavailableError) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        error: 'Trello assignments are unavailable. Retry after checking the Trello connection.',
        code: 'TRELLO_ASSIGNMENTS_UNAVAILABLE',
      });
    }
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Assign task to VA (update existing assignment)
router.post('/assignments/:id/assign', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const assignmentId = Number(req.params.id);
    const vaId = Number(req.body?.vaId);
    if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0 || !Number.isSafeInteger(vaId) || vaId <= 0) {
      return res.status(400).json({ error: 'A valid assignment and worker profile are required' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    const worker = await getFounderWorker(db, user.id, vaId);
    if (!worker) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }
    
    await db.update(taskAssignments)
      .set({ vaId, assignedAt: new Date() })
      .where(and(eq(taskAssignments.id, assignmentId), eq(taskAssignments.founderId, user.id)));

    await invalidateCache(user.id, user.openId, 'tasks');

    res.json({ success: true });
  } catch (error) {
    console.error('Error assigning task:', error);
    res.status(500).json({ error: 'Failed to assign task' });
  }
});

// Set priority override for assignment
router.post('/assignments/:id/priority', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const assignmentId = parseInt(req.params.id);
    const { priority } = req.body;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    // Get the task ID from the assignment
    const assignment = await db.select().from(taskAssignments)
      .where(and(eq(taskAssignments.id, assignmentId), eq(taskAssignments.founderId, user.id)));
    
    if (assignment.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    const taskId = assignment[0].taskId;
    
    // Upsert priority override
    const existing = await db.select().from(founderPriorityOverrides).where(
      and(eq(founderPriorityOverrides.taskId, taskId), eq(founderPriorityOverrides.founderId, user.id))
    );

    if (existing.length > 0) {
      await db.update(founderPriorityOverrides)
        .set({ priority })
        .where(eq(founderPriorityOverrides.id, existing[0].id));
    } else {
      await db.insert(founderPriorityOverrides).values({
        taskId,
        founderId: user.id,
        priority,
      });
    }

    await invalidateCache(user.id, user.openId, 'tasks');

    res.json({ success: true });
  } catch (error) {
    console.error('Error setting priority:', error);
    res.status(500).json({ error: 'Failed to set priority' });
  }
});

// ============================================
// COMMUNICATIONS (for Founder Dashboard)
// ============================================

// Get all communications
router.get('/communications', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const messages = await db.select().from(communicationLog)
      .where(eq(communicationLog.toUserId, user.id))
      .orderBy(desc(communicationLog.createdAt))
      .limit(50);
    
    // Get VA names
    const vas = await db.select().from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
    const vaMap = new Map(vas.map((v: typeof vas[0]) => [v.userId, v.name]));
    
    const result = messages.map((m: typeof messages[0]) => ({
      id: m.id,
      taskId: m.taskId,
      vaId: m.fromUserId,
      vaName: vaMap.get(m.fromUserId) || 'Unknown',
      type: m.messageType || 'note',
      message: m.message,
      timestamp: m.createdAt,
      isRead: m.isRead || false,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching communications:', error);
    res.status(500).json({ error: 'Failed to fetch communications' });
  }
});

// ============================================
// BRIEFING SETTINGS
// ============================================

// Get briefing settings
router.get('/briefing-settings', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.json(await getBriefingSettings(user.id));
  } catch (error) {
    console.error('Error fetching briefing settings:', error);
    return res.status(503).json({ error: 'Briefing settings are temporarily unavailable' });
  }
});

// Save briefing settings
router.post('/briefing-settings', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const settings = await saveBriefingSettings(user.id, req.body);
    return res.json({ success: true, settings });
  } catch (error) {
    if (error instanceof BriefingSettingsValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error saving briefing settings:', error);
    return res.status(503).json({ error: 'Briefing settings could not be saved' });
  }
});

// ============================================
// EMAIL NOTIFICATIONS
// ============================================

const BRIEFING_TRELLO_CONCURRENCY = 5;

// Send test email
router.post('/email/test', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const isValid = await validateEmailProvider();
    if (!isValid) {
      return res.status(400).json({ error: 'Email delivery is disabled or the configured provider is invalid' });
    }

    res.json({ success: true, message: 'Email provider is valid' });
  } catch (error) {
    console.error('Error testing email:', error);
    res.status(500).json({ error: 'Failed to test email' });
  }
});

// Send morning briefing to a worker
router.post('/email/morning-briefing/:workerId', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const workerId = parseInt(req.params.workerId);
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Get worker profile
    const worker = await db.select().from(vaProfiles).where(
      and(eq(vaProfiles.id, workerId), eq(vaProfiles.founderId, user.id))
    ).limit(1);

    if (worker.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    if (!worker[0].email) {
      return res.status(400).json({ error: 'Worker has no email address' });
    }

    // Get worker's tasks for today
    const assignments = await db.select().from(taskAssignments).where(
      and(eq(taskAssignments.vaId, workerId), eq(taskAssignments.founderId, user.id))
    );

    const tasks = await mapWithConcurrency(assignments, BRIEFING_TRELLO_CONCURRENCY, async (a) => {
      const summary = await fetchTrelloCardSummary(a.taskId);
      return {
        title: summary?.title || `Task ${a.taskId.split(':').pop()}`,
        cardName: summary?.cardName || 'Project',
        startTime: '09:00',
        endTime: '10:00',
        durationHours: 1,
        priority: summary?.priority ? summary.priority.toLowerCase() : 'normal',
      };
    });

    const today = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    const success = await sendMorningBriefing(worker[0].email, {
      workerName: worker[0].name,
      date: today,
      tasks,
      totalHours: tasks.reduce((sum: number, t: typeof tasks[0]) => sum + t.durationHours, 0),
      highPriorityCount: tasks.filter((t: typeof tasks[0]) => ['critical', 'urgent', 'high'].includes(t.priority)).length,
    });

    if (success) {
      res.json({ success: true, message: `Morning briefing sent to ${worker[0].email}` });
    } else {
      res.status(500).json({ error: 'Failed to send email' });
    }
  } catch (error) {
    console.error('Error sending morning briefing:', error);
    res.status(500).json({ error: 'Failed to send briefing' });
  }
});

// Send EOD report to founder
router.post('/email/eod-report/:workerId', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const workerId = parseInt(req.params.workerId);
    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    // Get worker profile
    const worker = await db.select().from(vaProfiles).where(
      and(eq(vaProfiles.id, workerId), eq(vaProfiles.founderId, user.id))
    ).limit(1);

    if (worker.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    // Get worker's tasks
    const assignments = await db.select().from(taskAssignments).where(
      and(eq(taskAssignments.vaId, workerId), eq(taskAssignments.founderId, user.id))
    );

    const completedTasks = await mapWithConcurrency(assignments.filter((a: typeof assignments[0]) => a.status === 'completed'), BRIEFING_TRELLO_CONCURRENCY, async (a) => {
      const summary = await fetchTrelloCardSummary(a.taskId);
      return {
        title: summary?.title || `Task ${a.taskId.split(':').pop()}`,
        cardName: summary?.cardName || 'Project',
        durationHours: 1,
        priority: summary?.priority ? summary.priority.toLowerCase() : 'normal',
      };
    });

    const incompleteTasks = await mapWithConcurrency(assignments.filter((a: typeof assignments[0]) => a.status === 'in_progress'), BRIEFING_TRELLO_CONCURRENCY, async (a) => {
      const summary = await fetchTrelloCardSummary(a.taskId);
      return {
        title: summary?.title || `Task ${a.taskId.split(':').pop()}`,
        cardName: summary?.cardName || 'Project',
        durationHours: 1,
        priority: summary?.priority ? summary.priority.toLowerCase() : 'normal',
      };
    });

    const blockedTasks = await mapWithConcurrency(assignments.filter((a: typeof assignments[0]) => a.status === 'blocked'), BRIEFING_TRELLO_CONCURRENCY, async (a) => {
      const summary = await fetchTrelloCardSummary(a.taskId);
      return {
        title: summary?.title || `Task ${a.taskId.split(':').pop()}`,
        cardName: summary?.cardName || 'Project',
        durationHours: 1,
        priority: summary?.priority ? summary.priority.toLowerCase() : 'normal',
      };
    });

    const today = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    const totalTasks = completedTasks.length + incompleteTasks.length + blockedTasks.length;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks.length / totalTasks) * 100) : 0;

    // Send to founder's email (user.email)
    const founderEmail = user.email;
    if (!founderEmail) {
      return res.status(400).json({ error: 'Founder has no email address' });
    }

    const success = await sendEODReport(founderEmail, {
      workerName: worker[0].name,
      date: today,
      completedTasks,
      incompleteTasks,
      blockedTasks,
      totalHoursWorked: completedTasks.reduce((sum: number, t: typeof completedTasks[0]) => sum + t.durationHours, 0),
      completionRate,
    });

    if (success) {
      res.json({ success: true, message: `EOD report sent to ${founderEmail}` });
    } else {
      res.status(500).json({ error: 'Failed to send email' });
    }
  } catch (error) {
    console.error('Error sending EOD report:', error);
    res.status(500).json({ error: 'Failed to send report' });
  }
});

// ============================================
// TIMEZONE OVERLAPS
// ============================================

// Get timezone overlaps
router.get('/timezone-overlaps', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const vas = await db.select().from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
    
    // Calculate overlaps (simplified calculation)
    const overlaps = vas.map((va: typeof vas[0]) => {
      // Founder assumed to be in Europe/Amsterdam (9-18)
      const founderStart = 9;
      const founderEnd = 18;
      
      const tzOffsets: Record<string, number> = {
        'Europe/Amsterdam': 1,
        'Asia/Manila': 8,
        'Asia/Jakarta': 7,
        'Asia/Kolkata': 5.5,
        'America/New_York': -5,
        'America/Los_Angeles': -8,
        'UTC': 0,
      };
      
      const founderOffset = tzOffsets['Europe/Amsterdam'] || 0;
      const vaOffset = tzOffsets[va.timezone] || 0;
      const diff = vaOffset - founderOffset;
      
      const vaStartInFounder = va.workStartHour - diff;
      const vaEndInFounder = va.workEndHour - diff;
      
      const overlapStart = Math.max(founderStart, vaStartInFounder);
      const overlapEnd = Math.min(founderEnd, vaEndInFounder);
      const overlapHours = Math.max(0, overlapEnd - overlapStart);
      
      return {
        vaId: va.id,
        vaName: va.name,
        vaTimezone: va.timezone,
        overlapHours,
        overlapStart: `${Math.floor(overlapStart)}:00`,
        overlapEnd: `${Math.floor(overlapEnd)}:00`,
      };
    });

    res.json(overlaps);
  } catch (error) {
    console.error('Error calculating timezone overlaps:', error);
    res.status(500).json({ error: 'Failed to calculate overlaps' });
  }
});

// ============================================
// WORKLOAD OVERVIEW (Founder Dashboard)
// ============================================

// Get workload overview for all VAs
router.get('/workload-overview', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    // Get all VAs
    const vas = await db.select().from(vaProfiles).where(eq(vaProfiles.founderId, user.id));
    
    // Get all users for linking info
    const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
    const userMap = new Map(allUsers.map((u: typeof allUsers[0]) => [u.id, u.email]));
    
    // Get assignment counts per VA
    const workload = await Promise.all(vas.map(async (va: typeof vas[0]) => {
      const assignments = await db.select().from(taskAssignments).where(
        and(eq(taskAssignments.vaId, va.id), eq(taskAssignments.founderId, user.id))
      );
      
      const statusCounts = {
        assigned: 0,
        in_progress: 0,
        completed: 0,
        blocked: 0,
      };
      
      assignments.forEach((a: typeof assignments[0]) => {
        if (a.status in statusCounts) {
          statusCounts[a.status as keyof typeof statusCounts]++;
        }
      });

      return {
        worker: {
          ...va,
          linkedUserEmail: va.userId ? userMap.get(va.userId) || null : null,
        },
        totalTasks: assignments.length,
        statusCounts,
      } as any;
    }));

    res.json(workload);
  } catch (error) {
    console.error('Error fetching workload overview:', error);
    res.status(500).json({ error: 'Failed to fetch workload' });
  }
});

// ============================================
// WORKER-SPECIFIC ENDPOINTS
// ============================================

// Get worker's own profile
router.get('/worker/profile', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { profiles, profile } = await getWorkerProfileForAccount(db, user.id);
    if (!profile) {
      const ambiguous = ambiguousWorkerProfileResponse(profiles);
      if (ambiguous) return res.status(ambiguous.status).json(ambiguous.body);
      return res.status(404).json({ error: 'Worker profile not found' });
    }

    res.json(profile);
  } catch (error) {
    console.error('Error fetching worker profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Get worker's assigned tasks
router.get('/worker/tasks', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { profiles, profile } = await getWorkerProfileForAccount(db, user.id);
    if (!profile) {
      const ambiguous = ambiguousWorkerProfileResponse(profiles);
      if (ambiguous) return res.status(ambiguous.status).json(ambiguous.body);
      // User is not a worker, return empty tasks
      return res.json({ tasks: [] });
    }
    
    const vaId = profile.id;
    const trelloMemberId = profile.trelloMemberId;

    let tasks: any[] = [];

    // Helper to map list names to workflow status
    const getStatusFromListName = (listName?: string | null) => {
      if (!listName) return 'assigned';
      const name = listName.toLowerCase();
      if (name.includes('doing') || name.includes('progress') || name.includes('active')) return 'in_progress';
      if (name.includes('done') || name.includes('completed') || name.includes('complete') || name.includes('finished')) return 'completed';
      if (name.includes('block') || name.includes('hold') || name.includes('wait')) return 'blocked';
      return 'assigned';
    };

    if (trelloMemberId) {
      // Trello-native Flow: Fetch non-archived cards assigned to this Trello ID
      const cardRows = await db.select({
        card: atisCards,
        board: atisBoards,
        understanding: atisCardUnderstanding,
        assignment: taskAssignments
      })
      .from(atisCards)
      .leftJoin(atisBoards, eq(atisCards.boardId, atisBoards.id))
      .leftJoin(atisCardUnderstanding, eq(atisCards.id, atisCardUnderstanding.cardId))
      .leftJoin(taskAssignments, and(
        eq(atisCards.trelloId, taskAssignments.taskId),
        eq(taskAssignments.vaId, vaId),
        eq(taskAssignments.founderId, profile.founderId)
      ))
      .where(
        and(
          eq(atisCards.isArchived, 0),
          sql`JSON_CONTAINS(${atisCards.memberIds}, JSON_QUOTE(${trelloMemberId}))`
        )
      );

      tasks = cardRows.map((row: any) => {
        const card = row.card;
        const board = row.board;
        const understanding = row.understanding;
        const assignment = row.assignment;
        const cardTrelloId = card.trelloId;

        // Parse labels and priority
        const labels = card.labels ? JSON.parse(card.labels) : [];
        const priorityLevel = labels.some((l: string) => /critical/i.test(l)) ? 'CRITICAL' :
                              labels.some((l: string) => /urgent/i.test(l)) ? 'URGENT' :
                              labels.some((l: string) => /high/i.test(l)) ? 'HIGH' : 'NORMAL';

        // Parse checklist
        let checklist: any[] = [];
        if (understanding && understanding.aptlssChecklist) {
          try {
            const parsed = JSON.parse(understanding.aptlssChecklist);
            checklist = parsed.map((item: any, index: number) => ({
              id: `${card.id}-step-${index}`,
              step: item.step || item.name || 'Step',
              timeMinutes: item.timeMinutes || item.estimatedMinutes || 15,
              aptlssType: item.aptlssType || item.priority || 'T',
              completed: false
            }));
          } catch (e) {}
        }

        const trelloStatus = getStatusFromListName(card.listName);
        const status = trelloStatus !== 'assigned' ? trelloStatus : (assignment?.status || 'assigned');

        return {
          id: cardTrelloId,
          cardId: cardTrelloId,
          cardName: card.name,
          boardName: board?.name || '',
          listName: card.listName || '',
          url: card.url || '',
          durationHours: understanding?.estimatedMinutes ? understanding.estimatedMinutes / 60 : 1,
          startTime: 'TBD',
          endTime: 'TBD',
          isCompleted: status === 'completed',
          priorityLevel,
          date: card.dueDate ? new Date(card.dueDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          status,
          description: card.description || '',
          labels,
          checklist,
          goal: understanding?.goal || '',
          deliverable: understanding?.deliverable || '',
          taskType: understanding?.taskType || '',
          complexity: understanding?.complexity || 'medium',
          confidenceScore: understanding?.confidenceScore || 100,
          atisCardId: card.id,
          hasUnderstanding: !!understanding,
          synced: true,
          handoffNotes: assignment?.handoffNotes || ''
        };
      });
    } else {
      // Fallback: Legacy Table-driven Flow
      const assignments = await db.select().from(taskAssignments).where(and(
        eq(taskAssignments.vaId, vaId),
        eq(taskAssignments.founderId, profile.founderId),
      ));

      tasks = await Promise.all(assignments.map(async (a: typeof assignments[0]) => {
        const cardTrelloId = a.taskId.split(':')[0] || a.taskId.split('_')[0];
        
        // Fetch card and understanding from local DB
        const card = await db.select().from(atisCards).where(eq(atisCards.trelloId, cardTrelloId)).limit(1);
        const understanding = await db.select().from(atisCardUnderstanding).where(eq(atisCardUnderstanding.cardTrelloId, cardTrelloId)).limit(1);
        
        let boardName = '';
        if (card.length > 0 && card[0].boardId) {
          const board = await db.select().from(atisBoards).where(eq(atisBoards.id, card[0].boardId)).limit(1);
          if (board.length > 0) boardName = board[0].name;
        }

        // Parse labels and priority
        const labels = card.length > 0 && card[0].labels ? JSON.parse(card[0].labels) : [];
        const priorityLevel = labels.some((l: string) => /critical/i.test(l)) ? 'CRITICAL' :
                              labels.some((l: string) => /urgent/i.test(l)) ? 'URGENT' :
                              labels.some((l: string) => /high/i.test(l)) ? 'HIGH' : 'NORMAL';

        // Parse checklist
        let checklist: any[] = [];
        if (understanding.length > 0 && understanding[0].aptlssChecklist) {
          try {
            const parsed = JSON.parse(understanding[0].aptlssChecklist);
            checklist = parsed.map((item: any, index: number) => ({
              id: `${card.length > 0 ? card[0].id : cardTrelloId}-step-${index}`,
              step: item.step || item.name || 'Step',
              timeMinutes: item.timeMinutes || item.estimatedMinutes || 15,
              aptlssType: item.aptlssType || item.priority || 'T',
              completed: false
            }));
          } catch (e) {}
        }

        return {
          id: a.taskId,
          cardId: cardTrelloId,
          cardName: card.length > 0 ? card[0].name : 'Trello Card',
          boardName,
          listName: card.length > 0 ? card[0].listName : '',
          url: card.length > 0 ? card[0].url : '',
          durationHours: understanding.length > 0 && understanding[0].estimatedMinutes ? understanding[0].estimatedMinutes / 60 : 1,
          startTime: 'TBD',
          endTime: 'TBD',
          isCompleted: a.status === 'completed',
          priorityLevel,
          date: card.length > 0 && card[0].dueDate ? new Date(card[0].dueDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          status: a.status,
          description: card.length > 0 ? card[0].description : '',
          labels,
          checklist,
          goal: understanding.length > 0 ? understanding[0].goal : '',
          deliverable: understanding.length > 0 ? understanding[0].deliverable : '',
          taskType: understanding.length > 0 ? understanding[0].taskType : '',
          complexity: understanding.length > 0 ? understanding[0].complexity : 'medium',
          confidenceScore: understanding.length > 0 ? understanding[0].confidenceScore : 100,
          atisCardId: card.length > 0 ? card[0].id : undefined,
          hasUnderstanding: understanding.length > 0,
          synced: true,
          handoffNotes: a.handoffNotes || ''
        };
      }));
    }

    res.json({ tasks });
  } catch (error) {
    console.error('Error fetching worker tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Mark task as complete/incomplete
router.post('/worker/tasks/:taskId/complete', async (req: any, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { taskId } = req.params;
    const { completed } = req.body;

    const db = await getDb();
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { profiles, profile } = await getWorkerProfileForAccount(db, user.id);
    if (!profile) {
      const ambiguous = ambiguousWorkerProfileResponse(profiles);
      if (ambiguous) return res.status(ambiguous.status).json(ambiguous.body);
      return res.status(403).json({ error: 'Not a worker' });
    }

    if (pilotCompletionResponse(user.id, res)) return;
    
    const vaId = profile.id;
    
    // Update the assignment status
    const updateResult = await db.update(taskAssignments)
      .set({ status: completed ? 'completed' : 'in_progress' })
      .where(and(
        eq(taskAssignments.taskId, decodeURIComponent(taskId)),
        eq(taskAssignments.vaId, vaId),
        eq(taskAssignments.founderId, profile.founderId),
      ));

    if (!didUpdateSingleTaskAssignment(updateResult)) {
      return res.status(404).json({ error: 'Assigned task not found' });
    }

    await invalidateCache(user.id, user.openId, 'tasks');
    websocketService.emitToUser(user.openId, 'task:completed', {
      taskId: decodeURIComponent(taskId),
      isCompleted: completed,
      timestamp: new Date().toISOString(),
      source: 'worker_task_toggle',
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Submit task for review
router.post('/worker/tasks/:taskId/review', async (req: any, res) => {
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
    
    const { profiles, profile } = await getWorkerProfileForAccount(db, user.id);
    if (!profile) {
      const ambiguous = ambiguousWorkerProfileResponse(profiles);
      if (ambiguous) return res.status(ambiguous.status).json(ambiguous.body);
      return res.status(403).json({ error: 'Not a worker' });
    }

    if (pilotCompletionResponse(user.id, res)) return;
    
    const vaId = profile.id;
    
    // Update the assignment status to completed
    const updateResult = await db.update(taskAssignments)
      .set({ status: 'completed' })
      .where(and(
        eq(taskAssignments.taskId, decodeURIComponent(taskId)),
        eq(taskAssignments.vaId, vaId),
        eq(taskAssignments.founderId, profile.founderId),
      ));

    if (!didUpdateSingleTaskAssignment(updateResult)) {
      return res.status(404).json({ error: 'Assigned task not found' });
    }


    await invalidateCache(user.id, user.openId, 'tasks');
    websocketService.emitToUser(user.openId, 'task:completed', {
      taskId: decodeURIComponent(taskId),
      isCompleted: true,
      status: 'completed',
      timestamp: new Date().toISOString(),
      source: 'worker_task_complete',
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error submitting for review:', error);
    res.status(500).json({ error: 'Failed to submit for review' });
  }
});

export default router;
