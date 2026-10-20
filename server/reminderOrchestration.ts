import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  commitments,
  emailTasks,
  notificationHistory,
  reminderAuditEvents,
  reminderPolicies,
  reminderRules,
  reminderSchedules,
  users,
  vaProfiles,
  type ReminderPolicy,
  type User,
} from "../drizzle/schema.postgres";
import { getDb } from "./db";
import { createNonOverlappingRunner } from "./services/non-overlapping-runner";
import { sendEmailWithOutcome } from "./services/email";
import { gmailContentScope } from "../shared/gmailContentScope";
import { selectWorkerProfile } from "./workerOperatorContext";

export const REMINDER_TERMINAL_STATES = ["sent", "skipped", "cancelled"] as const;
const ACTIVE_REMINDER_STATES = ["scheduled", "preparing", "draft_ready", "sending", "failed", "needs_review", "escalated"] as const;
const CANCELLABLE_REMINDER_STATES = ["scheduled", "preparing", "draft_ready", "failed", "needs_review", "escalated"] as const;
const EXTERNAL_CHANNELS = new Set(["email"]);

type ReminderActor = Pick<User, "id" | "openId" | "role" | "email">;
type ReminderChannel = "in_app" | "email";
type TriggerType = "before_due" | "at_due" | "after_due" | "no_update" | "manual";
type ReminderDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ReminderReader = Pick<ReminderDb, "select">;

export function selectReminderWorkspaceProfile<T extends { status: string; founderId: number }>(profiles: readonly T[]) {
  return selectWorkerProfile(profiles);
}

export function reminderProfileBelongsToWorkspace(
  profile: { founderId: number } | null | undefined,
  workspaceOwnerId: number,
) {
  return profile?.founderId === workspaceOwnerId;
}

export function reminderActorCanAccessCommitment(
  actor: Pick<ReminderActor, "id" | "role">,
  input: { workspaceOwnerId: number; assignedUserId: number | null; currentWorkspaceOwnerId: number | null },
) {
  if (actor.role === "admin") return actor.id === input.workspaceOwnerId;
  return actor.role === "worker"
    && input.currentWorkspaceOwnerId === input.workspaceOwnerId
    && input.assignedUserId === actor.id;
}

export function reminderActorCanAccessOccurrence(
  actor: Pick<ReminderActor, "id" | "role">,
  input: { workspaceOwnerId: number; assignedUserId: number | null; recipientUserId: number; currentWorkspaceOwnerId: number | null },
) {
  return reminderActorCanAccessCommitment(actor, input)
    && (actor.role === "admin" || input.recipientUserId === actor.id);
}

export type ReminderPolicyDecision = {
  allowed: boolean;
  permanent: boolean;
  reason: string;
  retryAt: Date | null;
};

export type CreateReminderInput = {
  title: string;
  context?: string | null;
  dueAt: Date;
  sourceType: "manual" | "trello" | "gmail" | "google_drive" | "system";
  sourceId?: string | null;
  sourceUrl?: string | null;
  assignedUserId?: number | null;
  ruleName?: string;
  triggerType: TriggerType;
  offsetMinutes: number;
  channel: ReminderChannel;
  requireApproval: boolean;
};

function affectedRows(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}


function isDuplicateEntryError(error: unknown) {
  const seen = new Set<unknown>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    if ((error as { code?: unknown }).code === "23505") return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

async function findReminderCreationByKey(database: ReminderReader, idempotencyKey: string) {
  const [existing] = await database.select({
    commitmentId: reminderSchedules.commitmentId,
    ruleId: reminderSchedules.ruleId,
    scheduleId: reminderSchedules.id,
  }).from(reminderSchedules).where(eq(reminderSchedules.idempotencyKey, idempotencyKey)).limit(1);
  return existing ?? null;
}

function parseClock(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) ? hours * 60 + minutes : 0;
}

function localTimeParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: value("weekday"),
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

function formatLocalDate(date: Date, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function firstInstantOnOrAfterLocalDate(targetUtcDay: number, formatter: Intl.DateTimeFormat) {
  const targetDate = new Date(targetUtcDay).toISOString().slice(0, 10);
  let lower = targetUtcDay - 36 * 60 * 60_000;
  let upper = targetUtcDay + 36 * 60 * 60_000;

  // Binary search the local calendar boundary so DST gaps and repeated hours do not
  // depend on guessing the zone's UTC offset at midnight.
  while (upper - lower > 1) {
    const midpoint = lower + Math.floor((upper - lower) / 2);
    if (formatLocalDate(new Date(midpoint), formatter) >= targetDate) upper = midpoint;
    else lower = midpoint;
  }
  return new Date(upper);
}

export function zonedCalendarDayBounds(now: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const currentDate = formatLocalDate(now, formatter);
  const [year, month, day] = currentDate.split("-").map(Number);
  const utcDay = Date.UTC(year, month - 1, day);
  return {
    start: firstInstantOnOrAfterLocalDate(utcDay, formatter),
    end: firstInstantOnOrAfterLocalDate(utcDay + 24 * 60 * 60_000, formatter),
  };
}

export function scheduleTimeForRule(dueAt: Date, triggerType: TriggerType, offsetMinutes: number) {
  const offsetMs = Math.max(0, offsetMinutes) * 60_000;
  if (triggerType === "before_due") return new Date(dueAt.getTime() - offsetMs);
  if (triggerType === "after_due" || triggerType === "no_update") return new Date(dueAt.getTime() + offsetMs);
  return new Date(dueAt);
}

export function evaluateReminderPolicy(input: {
  policy: Pick<ReminderPolicy, "enabled" | "inAppEnabled" | "emailEnabled" | "maxPerDay" | "minIntervalMinutes" | "quietHoursStart" | "quietHoursEnd" | "timezone" | "allowWeekends">;
  channel: ReminderChannel;
  now: Date;
  sentToday: number;
  lastSentAt: Date | null;
}): ReminderPolicyDecision {
  const { policy, channel, now, sentToday, lastSentAt } = input;
  if (!policy.enabled) return { allowed: false, permanent: true, reason: "Reminders are disabled by the recipient.", retryAt: null };
  if (channel === "email" && !policy.emailEnabled) return { allowed: false, permanent: true, reason: "Email reminders are disabled by the recipient.", retryAt: null };
  if (channel === "in_app" && !policy.inAppEnabled) return { allowed: false, permanent: true, reason: "In-app reminders are disabled by the recipient.", retryAt: null };

  const local = localTimeParts(now, policy.timezone);
  if (!policy.allowWeekends && (local.weekday === "Sat" || local.weekday === "Sun")) {
    return { allowed: false, permanent: false, reason: "Deferred outside the recipient's working week.", retryAt: new Date(now.getTime() + 6 * 60 * 60_000) };
  }

  const quietStart = parseClock(policy.quietHoursStart);
  const quietEnd = parseClock(policy.quietHoursEnd);
  const quiet = quietStart === quietEnd
    ? false
    : quietStart < quietEnd
      ? local.minutes >= quietStart && local.minutes < quietEnd
      : local.minutes >= quietStart || local.minutes < quietEnd;
  if (quiet) {
    return { allowed: false, permanent: false, reason: "Deferred during the recipient's quiet hours.", retryAt: new Date(now.getTime() + 60 * 60_000) };
  }

  if (sentToday >= policy.maxPerDay) {
    return { allowed: false, permanent: false, reason: `Daily reminder limit reached (${policy.maxPerDay}).`, retryAt: new Date(now.getTime() + 6 * 60 * 60_000) };
  }

  if (lastSentAt) {
    const nextAllowed = new Date(lastSentAt.getTime() + policy.minIntervalMinutes * 60_000);
    if (nextAllowed > now) {
      return { allowed: false, permanent: false, reason: `Reminder cooldown is active for ${policy.minIntervalMinutes} minutes.`, retryAt: nextAllowed };
    }
  }

  return { allowed: true, permanent: false, reason: "Recipient policy allows this reminder.", retryAt: null };
}

function defaultPolicy(userId: number): ReminderPolicy {
  const now = new Date();
  return {
    id: 0,
    userId,
    enabled: true,
    inAppEnabled: true,
    emailEnabled: false,
    maxPerDay: 3,
    minIntervalMinutes: 60,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    timezone: "UTC",
    allowWeekends: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function workspaceForActor(actor: ReminderActor, database?: ReminderReader, lockProfile = false) {
  if (actor.role === "admin") return { workspaceOwnerId: actor.id, assignedUserId: null as number | null };
  if (actor.role !== "worker") throw new Error("Reminder access requires an admin or worker account");
  const db = database ?? await getDb();
  if (!db) throw new Error("Database unavailable");
  const query = db.select({ founderId: vaProfiles.founderId, status: vaProfiles.status }).from(vaProfiles)
    .where(eq(vaProfiles.userId, actor.id)).orderBy(vaProfiles.id);
  const profiles = await (lockProfile ? query.for("update") : query);
  const profile = selectReminderWorkspaceProfile(profiles);
  if (!profile) throw new Error("Worker profile is missing or ambiguous");
  return { workspaceOwnerId: profile.founderId, assignedUserId: actor.id };
}

async function assertReminderActorAccess(
  actor: ReminderActor,
  commitment: { workspaceOwnerId: number; assignedUserId: number | null },
  recipientUserId: number,
  database?: ReminderReader,
  lockProfile = false,
) {
  const scope = await workspaceForActor(actor, database, lockProfile);
  if (!reminderActorCanAccessOccurrence(actor, {
    workspaceOwnerId: commitment.workspaceOwnerId,
    assignedUserId: commitment.assignedUserId,
    recipientUserId,
    currentWorkspaceOwnerId: scope.workspaceOwnerId,
  })) {
    throw new Error("You cannot access this reminder in the current workspace");
  }
  return scope;
}

export function buildReminderAuditScopeFilter(actor: ReminderActor, workspaceOwnerId: number) {
  const workspaceScope = eq(reminderAuditEvents.workspaceOwnerId, workspaceOwnerId);
  if (actor.role === "admin") return workspaceScope;

  return and(
    workspaceScope,
    or(
      eq(reminderAuditEvents.actorUserId, actor.id),
      eq(commitments.assignedUserId, actor.id),
      eq(reminderSchedules.recipientUserId, actor.id),
    ),
  );
}

export function buildReminderScheduleScopeFilter(actor: ReminderActor, workspaceOwnerId: number) {
  if (actor.role === "admin") return eq(commitments.workspaceOwnerId, workspaceOwnerId);
  return and(
    eq(commitments.workspaceOwnerId, workspaceOwnerId),
    eq(commitments.assignedUserId, actor.id),
    eq(reminderSchedules.recipientUserId, actor.id),
  );
}

async function assertAssignableUser(workspaceOwnerId: number, assignedUserId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [account] = await db.select({ role: users.role }).from(users)
    .where(eq(users.id, assignedUserId)).limit(1);
  const profiles = await db.select({ founderId: vaProfiles.founderId, status: vaProfiles.status }).from(vaProfiles)
    .where(eq(vaProfiles.userId, assignedUserId)).orderBy(vaProfiles.id);
  const profile = selectReminderWorkspaceProfile(profiles);
  if (account?.role !== "worker" || !reminderProfileBelongsToWorkspace(profile, workspaceOwnerId)) {
    throw new Error("The selected worker does not have one unambiguous profile in this workspace");
  }
}

async function activeWorkerProfileBelongsToWorkspace(
  database: ReminderReader,
  userId: number,
  workspaceOwnerId: number,
  lockProfile = false,
) {
  const query = database.select({ founderId: vaProfiles.founderId, status: vaProfiles.status })
    .from(vaProfiles).where(eq(vaProfiles.userId, userId)).orderBy(vaProfiles.id);
  const profiles = lockProfile ? await query.for("update") : await query;
  return reminderProfileBelongsToWorkspace(selectReminderWorkspaceProfile(profiles), workspaceOwnerId);
}

function draftForCommitment(title: string, context: string | null, dueAt: Date) {
  const due = dueAt.toISOString();
  return {
    title: `Reminder: ${title}`.slice(0, 500),
    content: [
      `Commitment: ${title}`,
      `Due: ${due}`,
      context ? `Context: ${context}` : null,
      "Review the commitment and record the next concrete action or close it if complete.",
    ].filter(Boolean).join("\n"),
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

async function audit(input: {
  workspaceOwnerId: number;
  commitmentId?: number | null;
  scheduleId?: number | null;
  actorUserId?: number | null;
  eventType: string;
  details?: Record<string, unknown>;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.insert(reminderAuditEvents).values({
    workspaceOwnerId: input.workspaceOwnerId,
    commitmentId: input.commitmentId ?? null,
    scheduleId: input.scheduleId ?? null,
    actorUserId: input.actorUserId ?? null,
    eventType: input.eventType,
    detailsJson: input.details ? JSON.stringify(input.details) : null,
  });
}

async function deliverInAppAtBoundary(input: {
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  scheduleId: number;
  commitmentId: number;
  workspaceOwnerId: number;
  recipient: { id: number; openId: string };
  title: string;
  content: string;
  taskId: string | null;
  taskName: string;
  dueDate: Date;
  now: Date;
  actorUserId: number | null;
  policyReason: string;
}) {
  return input.db.transaction(async (tx) => {
    // Match closeCommitment's lock order so a close and a delivery have one clear winner.
    const [currentCommitment] = await tx.select({
      workspaceOwnerId: commitments.workspaceOwnerId,
      assignedUserId: commitments.assignedUserId,
      status: commitments.status,
    }).from(commitments).where(eq(commitments.id, input.commitmentId)).for("update");
    const [currentSchedule] = await tx.select({
      state: reminderSchedules.state,
      recipientUserId: reminderSchedules.recipientUserId,
    }).from(reminderSchedules).where(eq(reminderSchedules.id, input.scheduleId)).for("update");

    if (!currentCommitment || !currentSchedule) throw new Error("Reminder delivery state could not be revalidated");
    if (currentCommitment.status !== "open" || currentSchedule.state !== "preparing") {
      if (currentCommitment.status !== "open" && currentSchedule.state === "preparing") {
        await tx.update(reminderSchedules).set({
          state: "cancelled",
          policyReason: "Commitment was closed before reminder delivery.",
        }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "preparing")));
      }
      return "cancelled" as const;
    }
    if (currentCommitment.workspaceOwnerId !== input.workspaceOwnerId) {
      const reason = "The commitment workspace changed before delivery; review the reminder assignment.";
      const changed = await tx.update(reminderSchedules).set({
        state: "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        error: reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "preparing")));
      if (affectedRows(changed) !== 1) throw new Error("Reminder claim changed before workspace review");
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_workspace_changed_before_delivery",
        detailsJson: JSON.stringify({ previousWorkspaceOwnerId: input.workspaceOwnerId }),
      });
      return "needs_review" as const;
    }
    if (currentSchedule.recipientUserId !== currentCommitment.assignedUserId
      || currentSchedule.recipientUserId !== input.recipient.id) {
      const reason = currentCommitment.assignedUserId
        ? "Worker assignment changed before delivery; the reminder was returned to the current worker."
        : "The commitment no longer has an assigned worker; review the reminder assignment.";
      await tx.update(reminderSchedules).set({
        ...(currentCommitment.assignedUserId ? { recipientUserId: currentCommitment.assignedUserId } : {}),
        state: currentCommitment.assignedUserId ? "scheduled" : "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        lastAttemptAt: null,
        error: currentCommitment.assignedUserId ? null : reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "preparing")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_reassigned_before_delivery",
        detailsJson: JSON.stringify({
          previousRecipientId: currentSchedule.recipientUserId,
          assignedUserId: currentCommitment.assignedUserId,
        }),
      });
      return "cancelled" as const;
    }

    // Serialize automatic in-app sends with approved sends for this recipient.
    const [lockedRecipient] = await tx.select({ id: users.id, openId: users.openId, role: users.role }).from(users)
      .where(eq(users.id, currentSchedule.recipientUserId)).for("update");
    if (!lockedRecipient) throw new Error("Reminder recipient no longer exists");
    if (lockedRecipient.role !== "worker"
      || !await activeWorkerProfileBelongsToWorkspace(tx, lockedRecipient.id, currentCommitment.workspaceOwnerId, true)) {
      const reason = "The assigned account no longer has an active worker profile in this workspace; review the reminder.";
      const changed = await tx.update(reminderSchedules).set({
        state: "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        error: reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "preparing")));
      if (affectedRows(changed) !== 1) throw new Error("Reminder claim changed before worker access review");
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_worker_access_changed_before_delivery",
        detailsJson: JSON.stringify({ recipientUserId: lockedRecipient.id }),
      });
      return "needs_review" as const;
    }
    const policy = await recipientPolicy(currentSchedule.recipientUserId, tx);
    const stats = await deliveryStats(tx, currentSchedule.recipientUserId, input.now, policy.timezone);
    const decision = evaluateReminderPolicy({ policy, channel: "in_app", now: input.now, ...stats });
    if (!decision.allowed) {
      const nextState = decision.permanent ? "skipped" : "scheduled";
      const retryAt = decision.retryAt ?? new Date(input.now.getTime() + 60 * 60_000);
      const deferred = await tx.update(reminderSchedules).set({
        state: nextState,
        ...(decision.permanent ? {} : { scheduledFor: retryAt }),
        policyReason: decision.reason,
      }).where(and(
        eq(reminderSchedules.id, input.scheduleId),
        eq(reminderSchedules.state, "preparing"),
      ));
      if (affectedRows(deferred) !== 1) throw new Error("Reminder claim changed before quota could be applied");
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: decision.permanent ? "reminder_skipped" : "reminder_deferred",
        detailsJson: JSON.stringify({ reason: decision.reason, retryAt: decision.permanent ? null : retryAt.toISOString() }),
      });
      return nextState;
    }

    await tx.insert(notificationHistory).values({
      userId: input.recipient.id,
      userOpenId: lockedRecipient.openId,
      title: input.title,
      content: input.content,
      notificationType: "general",
      taskId: input.taskId,
      taskName: input.taskName,
      dueDate: input.dueDate,
      channel: "in_app",
      deliveryStatus: "sent",
      deliveredAt: input.now,
    });
    const sent = await tx.update(reminderSchedules).set({
      state: "sent",
      draftTitle: input.title,
      draftContent: input.content,
      sentAt: input.now,
      policyReason: input.policyReason,
    }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "preparing")));
    if (affectedRows(sent) !== 1) throw new Error("Reminder claim changed before delivery could be recorded");

    await tx.insert(reminderAuditEvents).values({
      workspaceOwnerId: input.workspaceOwnerId,
      commitmentId: input.commitmentId,
      scheduleId: input.scheduleId,
      actorUserId: input.actorUserId,
      eventType: "reminder_sent",
      detailsJson: JSON.stringify({ channel: "in_app" }),
    });
    return "sent" as const;
  });
}

export async function createReminder(actor: ReminderActor, input: CreateReminderInput) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const scope = await workspaceForActor(actor);
  const assignedUserId = actor.role === "worker" ? actor.id : input.assignedUserId;
  if (!assignedUserId) throw new Error("A worker recipient is required");
  if (actor.role === "admin") await assertAssignableUser(scope.workspaceOwnerId, assignedUserId);
  const scheduledFor = scheduleTimeForRule(input.dueAt, input.triggerType, input.offsetMinutes);
  const title = input.title.trim();
  const context = input.context?.trim() || null;
  const sourceId = input.sourceId?.trim() || null;
  const sourceUrl = input.sourceUrl?.trim() || null;
  const ruleName = input.ruleName?.trim() || `${input.offsetMinutes} minute ${input.triggerType.replaceAll("_", " ")}`;
  const approvalRequired = EXTERNAL_CHANNELS.has(input.channel) || input.requireApproval;
  const idempotencyKey = createHash("sha256").update(JSON.stringify([
    "reminder-create-v1",
    scope.workspaceOwnerId,
    actor.id,
    assignedUserId,
    input.sourceType,
    sourceId,
    sourceUrl,
    title,
    context,
    input.dueAt.toISOString(),
    ruleName,
    input.triggerType,
    input.offsetMinutes,
    input.channel,
    approvalRequired,
    scheduledFor.toISOString(),
  ])).digest("hex");

  const existingCreation = async (database: ReminderReader) => {
    const existing = await findReminderCreationByKey(database, idempotencyKey);
    return existing ? { ...existing, scheduledFor } : null;
  };

  try {
    return await db.transaction(async (tx) => {
      const existing = await existingCreation(tx);
      if (existing) return existing;

      const commitmentResult = await tx.insert(commitments).values({
        workspaceOwnerId: scope.workspaceOwnerId,
        assignedUserId,
        createdByUserId: actor.id,
        sourceType: input.sourceType,
        sourceId,
        sourceUrl,
        title,
        context,
        dueAt: input.dueAt,
      }).returning({ id: commitments.id });
      const commitmentId = commitmentResult[0]?.id ?? 0;
      if (!commitmentId) throw new Error("Commitment could not be created");

      const ruleResult = await tx.insert(reminderRules).values({
        workspaceOwnerId: scope.workspaceOwnerId,
        createdByUserId: actor.id,
        name: ruleName,
        triggerType: input.triggerType,
        offsetMinutes: input.offsetMinutes,
        channel: input.channel,
        requireApproval: approvalRequired,
        maxAttempts: 1,
        cooldownMinutes: 60,
      }).returning({ id: reminderRules.id });
      const ruleId = ruleResult[0]?.id ?? 0;
      if (!ruleId) throw new Error("Reminder rule could not be created");

      const scheduleResult = await tx.insert(reminderSchedules).values({
        commitmentId,
        ruleId,
        recipientUserId: assignedUserId,
        scheduledFor,
        channel: input.channel,
        idempotencyKey,
      }).returning({ id: reminderSchedules.id });
      const scheduleId = scheduleResult[0]?.id ?? 0;
      if (!scheduleId) throw new Error("Reminder occurrence could not be scheduled");

      await tx.insert(reminderAuditEvents).values([
        {
          workspaceOwnerId: scope.workspaceOwnerId,
          commitmentId,
          actorUserId: actor.id,
          eventType: "commitment_created",
          detailsJson: JSON.stringify({ sourceType: input.sourceType, dueAt: input.dueAt.toISOString() }),
        },
        {
          workspaceOwnerId: scope.workspaceOwnerId,
          commitmentId,
          scheduleId,
          actorUserId: actor.id,
          eventType: "reminder_scheduled",
          detailsJson: JSON.stringify({ channel: input.channel, scheduledFor: scheduledFor.toISOString(), approvalRequired }),
        },
      ]);

      return { commitmentId, ruleId, scheduleId, scheduledFor };
    });
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
    const existing = await existingCreation(db);
    if (existing) return existing;
    throw error;
  }
}

async function recipientPolicy(recipientUserId: number, database?: ReminderReader) {
  const db = database ?? await getDb();
  if (!db) throw new Error("Database unavailable");
  const [policy] = await db.select().from(reminderPolicies).where(eq(reminderPolicies.userId, recipientUserId)).limit(1);
  return policy ?? defaultPolicy(recipientUserId);
}

async function deliveryStats(
  database: ReminderReader,
  recipientUserId: number,
  now: Date,
  timezone: string,
  excludeScheduleId?: number,
) {
  const { start, end } = zonedCalendarDayBounds(now, timezone);
  const recipientScope = eq(reminderSchedules.recipientUserId, recipientUserId);
  const [stats] = await database.select({
    sentToday: sql<number>`SUM(CASE
      WHEN (${reminderSchedules.state} = 'sent' AND ${reminderSchedules.sentAt} >= ${start} AND ${reminderSchedules.sentAt} < ${end})
        OR (${inArray(reminderSchedules.state, ["sending", "needs_review"])} AND ${reminderSchedules.approvedAt} >= ${start} AND ${reminderSchedules.approvedAt} < ${end})
      THEN 1 ELSE 0 END)`,
    lastSentAt: sql<Date | null>`MAX(CASE
      WHEN ${reminderSchedules.state} = 'sent' THEN ${reminderSchedules.sentAt}
      WHEN ${inArray(reminderSchedules.state, ["sending", "needs_review"])} THEN ${reminderSchedules.approvedAt}
      ELSE NULL END)`,
  }).from(reminderSchedules).where(excludeScheduleId === undefined
    ? recipientScope
    : and(recipientScope, ne(reminderSchedules.id, excludeScheduleId)));
  return { sentToday: Number(stats?.sentToday ?? 0), lastSentAt: stats?.lastSentAt ? new Date(stats.lastSentAt) : null };
}

async function unverifiedGmailReminderReason(
  db: ReminderReader,
  commitment: typeof commitments.$inferSelect,
): Promise<string | null> {
  if (commitment.sourceType !== "gmail") return null;
  if (!commitment.assignedUserId || !commitment.sourceId) {
    return "Gmail deadline cannot be traced to a worker and source thread; verify it before sending a reminder.";
  }
  const messages = await db.select({ subject: emailTasks.subject, snippet: emailTasks.snippet })
    .from(emailTasks)
    .where(and(eq(emailTasks.vaId, commitment.assignedUserId), eq(emailTasks.gmailThreadId, commitment.sourceId)))
    .limit(101);
  if (!messages.length || messages.length > 100) {
    return "Gmail deadline source cannot be verified from retained messages; review it before sending a reminder.";
  }
  if (messages.some(message => gmailContentScope(message.subject, message.snippet ?? "") === "portal_notice")) {
    return "This Gmail item only announces portal correspondence; verify the underlying document and its deadline before sending a reminder.";
  }
  return null;
}

async function transitionPreparingReminder(input: {
  db: ReminderDb;
  scheduleId: number;
  commitmentId: number;
  workspaceOwnerId: number;
  actorUserId: number | null;
  values: Partial<typeof reminderSchedules.$inferInsert> & { state: typeof reminderSchedules.$inferSelect.state };
  eventType: string;
  details?: Record<string, unknown>;
}) {
  return input.db.transaction(async (tx) => {
    const updated = await tx.update(reminderSchedules).set(input.values)
      .where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "preparing")));
    if (affectedRows(updated) !== 1) return false;
    await tx.insert(reminderAuditEvents).values({
      workspaceOwnerId: input.workspaceOwnerId,
      commitmentId: input.commitmentId,
      scheduleId: input.scheduleId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      detailsJson: input.details ? JSON.stringify(input.details) : null,
    });
    return true;
  });
}

async function deliverClaimedSchedule(
  scheduleId: number,
  actorUserId: number | null,
  now: Date,
  scopedWorkspaceOwnerId?: number,
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db.select({
    schedule: reminderSchedules,
    commitment: commitments,
    rule: reminderRules,
    recipient: users,
  }).from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .innerJoin(reminderRules, eq(reminderRules.id, reminderSchedules.ruleId))
    .innerJoin(users, eq(users.id, reminderSchedules.recipientUserId))
    .where(eq(reminderSchedules.id, scheduleId)).limit(1);
  if (!row) throw new Error("Reminder occurrence not found");
  if (row.commitment.status !== "open" || row.schedule.state !== "preparing") return "cancelled" as const;

  if (scopedWorkspaceOwnerId !== undefined && row.commitment.workspaceOwnerId !== scopedWorkspaceOwnerId) {
    const reason = "The commitment workspace changed before reminder processing; review the reminder assignment.";
    const changed = await transitionPreparingReminder({
      db,
      scheduleId,
      commitmentId: row.commitment.id,
      workspaceOwnerId: row.commitment.workspaceOwnerId,
      actorUserId,
      values: { state: "needs_review", error: reason, policyReason: reason },
      eventType: "reminder_workspace_changed_before_processing",
      details: { requestedWorkspaceOwnerId: scopedWorkspaceOwnerId },
    });
    return changed ? "needs_review" as const : "cancelled" as const;
  }

  if (row.recipient.role !== "worker"
    || !await activeWorkerProfileBelongsToWorkspace(db, row.recipient.id, row.commitment.workspaceOwnerId)) {
    const reason = "The assigned account no longer has an active worker profile in this workspace; review the reminder.";
    const changed = await transitionPreparingReminder({
      db,
      scheduleId,
      commitmentId: row.commitment.id,
      workspaceOwnerId: row.commitment.workspaceOwnerId,
      actorUserId,
      values: { state: "needs_review", error: reason, policyReason: reason },
      eventType: "reminder_worker_access_changed_before_processing",
      details: { recipientUserId: row.recipient.id },
    });
    return changed ? "needs_review" as const : "cancelled" as const;
  }

  const sourceHold = await unverifiedGmailReminderReason(db, row.commitment);
  if (sourceHold) {
    const changed = await transitionPreparingReminder({
      db,
      scheduleId,
      commitmentId: row.commitment.id,
      workspaceOwnerId: row.commitment.workspaceOwnerId,
      actorUserId,
      values: { state: "needs_review", error: sourceHold, policyReason: sourceHold },
      eventType: "reminder_source_needs_review",
      details: { reason: sourceHold },
    });
    return changed ? "needs_review" as const : "cancelled" as const;
  }

  const draft = draftForCommitment(row.commitment.title, row.commitment.context, row.commitment.dueAt);
  const policy = await recipientPolicy(row.schedule.recipientUserId);
  const stats = await deliveryStats(db, row.schedule.recipientUserId, now, policy.timezone);
  const decision = evaluateReminderPolicy({ policy, channel: row.schedule.channel, now, ...stats });

  if (!decision.allowed) {
    if (row.schedule.channel === "email" || row.rule.requireApproval) {
      const changed = await transitionPreparingReminder({
        db,
        scheduleId,
        commitmentId: row.commitment.id,
        workspaceOwnerId: row.commitment.workspaceOwnerId,
        actorUserId,
        values: { state: "draft_ready", draftTitle: draft.title, draftContent: draft.content, policyReason: decision.reason },
        eventType: "reminder_draft_ready",
        details: { policyAllowed: false, reason: decision.reason },
      });
      return changed ? "draft_ready" as const : "cancelled" as const;
    }
    if (decision.permanent) {
      const changed = await transitionPreparingReminder({
        db,
        scheduleId,
        commitmentId: row.commitment.id,
        workspaceOwnerId: row.commitment.workspaceOwnerId,
        actorUserId,
        values: { state: "skipped", policyReason: decision.reason },
        eventType: "reminder_skipped",
        details: { reason: decision.reason },
      });
      return changed ? "skipped" as const : "cancelled" as const;
    }
    const retryAt = decision.retryAt ?? new Date(now.getTime() + 60 * 60_000);
    const changed = await transitionPreparingReminder({
      db,
      scheduleId,
      commitmentId: row.commitment.id,
      workspaceOwnerId: row.commitment.workspaceOwnerId,
      actorUserId,
      values: { state: "scheduled", scheduledFor: retryAt, policyReason: decision.reason },
      eventType: "reminder_deferred",
      details: { reason: decision.reason, retryAt: retryAt.toISOString() },
    });
    return changed ? "scheduled" as const : "cancelled" as const;
  }

  if (row.schedule.channel === "email" || row.rule.requireApproval) {
    const changed = await transitionPreparingReminder({
      db,
      scheduleId,
      commitmentId: row.commitment.id,
      workspaceOwnerId: row.commitment.workspaceOwnerId,
      actorUserId,
      values: {
        state: "draft_ready",
        draftTitle: draft.title,
        draftContent: draft.content,
        policyReason: EXTERNAL_CHANNELS.has(row.schedule.channel) ? "External email requires explicit approval." : decision.reason,
      },
      eventType: "reminder_draft_ready",
      details: { policyAllowed: true, approvalRequired: true },
    });
    return changed ? "draft_ready" as const : "cancelled" as const;
  }

  return deliverInAppAtBoundary({
    db,
    scheduleId,
    commitmentId: row.commitment.id,
    workspaceOwnerId: row.commitment.workspaceOwnerId,
    recipient: row.recipient,
    title: draft.title,
    content: draft.content,
    taskId: row.commitment.sourceId,
    taskName: row.commitment.title,
    dueDate: row.commitment.dueAt,
    now,
    actorUserId,
    policyReason: decision.reason,
  });
}

export async function processDueReminders(now = new Date(), limit = 50, workspaceOwnerId?: number) {
  const db = await getDb();
  if (!db) return { claimed: 0, sent: 0, drafted: 0, deferred: 0, skipped: 0, needsReview: 0, failed: 0 };
  const due = await db.select({ id: reminderSchedules.id }).from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .where(and(
      eq(reminderSchedules.state, "scheduled"),
      lte(reminderSchedules.scheduledFor, now),
      eq(commitments.status, "open"),
      workspaceOwnerId === undefined ? undefined : eq(commitments.workspaceOwnerId, workspaceOwnerId),
    ))
    .orderBy(reminderSchedules.scheduledFor).limit(Math.min(Math.max(limit, 1), 200));
  const result = { claimed: 0, sent: 0, drafted: 0, deferred: 0, skipped: 0, needsReview: 0, failed: 0 };

  for (const item of due) {
    const claim = await db.update(reminderSchedules).set({ state: "preparing", lastAttemptAt: now, attemptCount: sql`${reminderSchedules.attemptCount} + 1` })
      .where(and(eq(reminderSchedules.id, item.id), eq(reminderSchedules.state, "scheduled")));
    if (affectedRows(claim) !== 1) continue;
    result.claimed++;
    try {
      const state = await deliverClaimedSchedule(item.id, null, now, workspaceOwnerId);
      if (state === "sent") result.sent++;
      else if (state === "draft_ready") result.drafted++;
      else if (state === "scheduled") result.deferred++;
      else if (state === "skipped") result.skipped++;
      else if (state === "needs_review") result.needsReview++;
    } catch (error) {
      result.failed++;
      const message = error instanceof Error ? error.message : String(error);
      await db.update(reminderSchedules).set({ state: "failed", error: message })
        .where(and(eq(reminderSchedules.id, item.id), eq(reminderSchedules.state, "preparing")));
    }
  }
  return result;
}

export async function recoverInterruptedReminders(now = new Date()) {
  const db = await getDb();
  if (!db) return 0;
  const staleBefore = new Date(now.getTime() - 15 * 60_000);
  const staleScope = and(
    inArray(reminderSchedules.state, ["preparing", "sending"]),
    lte(reminderSchedules.lastAttemptAt, staleBefore),
  );
  const closedCommitmentIds = db.select({ id: commitments.id }).from(commitments)
    .where(inArray(commitments.status, ["completed", "cancelled"]));
  const openCommitmentIds = db.select({ id: commitments.id }).from(commitments)
    .where(eq(commitments.status, "open"));

  const cancelled = await db.update(reminderSchedules).set({
    state: "cancelled",
    error: null,
    policyReason: "Commitment was closed before reminder processing recovered.",
  }).where(and(staleScope, inArray(reminderSchedules.commitmentId, closedCommitmentIds)));
  const needsReview = await db.update(reminderSchedules).set({
    state: "needs_review",
    policyReason: "Processing was interrupted. Delivery is intentionally not retried until a human reviews it.",
  }).where(and(staleScope, inArray(reminderSchedules.commitmentId, openCommitmentIds)));
  return affectedRows(cancelled) + affectedRows(needsReview);
}

export async function getReminderDashboard(actor: ReminderActor) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const scope = await workspaceForActor(actor);
  const ownership = buildReminderScheduleScopeFilter(actor, scope.workspaceOwnerId);
  const rows = await db.select({ schedule: reminderSchedules, commitment: commitments, rule: reminderRules })
    .from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .innerJoin(reminderRules, eq(reminderRules.id, reminderSchedules.ruleId))
    .where(ownership)
    .orderBy(
      sql`CASE WHEN ${inArray(reminderSchedules.state, [...ACTIVE_REMINDER_STATES])} THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${inArray(reminderSchedules.state, [...ACTIVE_REMINDER_STATES])} THEN ${reminderSchedules.scheduledFor} END ASC`,
      desc(reminderSchedules.scheduledFor),
      desc(reminderSchedules.id),
    ).limit(200);
  const policy = await recipientPolicy(actor.id);
  const auditRows = await db.select({ audit: reminderAuditEvents }).from(reminderAuditEvents)
    .leftJoin(commitments, eq(commitments.id, reminderAuditEvents.commitmentId))
    .leftJoin(reminderSchedules, eq(reminderSchedules.id, reminderAuditEvents.scheduleId))
    .where(buildReminderAuditScopeFilter(actor, scope.workspaceOwnerId))
    .orderBy(desc(reminderAuditEvents.createdAt)).limit(100);
  return { rows, policy, audit: auditRows.flatMap(({ audit }) => audit ? [audit] : []) };
}

export async function updateReminderPolicy(actor: ReminderActor, values: Omit<Partial<ReminderPolicy>, "id" | "userId" | "createdAt" | "updatedAt">) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const targetUserId = actor.id;
  const [existing] = await db.select({ id: reminderPolicies.id }).from(reminderPolicies).where(eq(reminderPolicies.userId, targetUserId)).limit(1);
  const sanitized = {
    enabled: values.enabled,
    inAppEnabled: values.inAppEnabled,
    emailEnabled: values.emailEnabled,
    maxPerDay: values.maxPerDay,
    minIntervalMinutes: values.minIntervalMinutes,
    quietHoursStart: values.quietHoursStart,
    quietHoursEnd: values.quietHoursEnd,
    timezone: values.timezone,
    allowWeekends: values.allowWeekends,
  };
  const data = Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined));
  if (existing) {
    await db.update(reminderPolicies).set(data).where(eq(reminderPolicies.id, existing.id));
  } else {
    const defaults = defaultPolicy(targetUserId);
    const insertValues: typeof reminderPolicies.$inferInsert = {
      userId: targetUserId,
      enabled: values.enabled ?? defaults.enabled,
      inAppEnabled: values.inAppEnabled ?? defaults.inAppEnabled,
      emailEnabled: values.emailEnabled ?? defaults.emailEnabled,
      maxPerDay: values.maxPerDay ?? defaults.maxPerDay,
      minIntervalMinutes: values.minIntervalMinutes ?? defaults.minIntervalMinutes,
      quietHoursStart: values.quietHoursStart ?? defaults.quietHoursStart,
      quietHoursEnd: values.quietHoursEnd ?? defaults.quietHoursEnd,
      timezone: values.timezone ?? defaults.timezone,
      allowWeekends: values.allowWeekends ?? defaults.allowWeekends,
    };
    await db.insert(reminderPolicies).values(insertValues);
  }
  const scope = await workspaceForActor(actor);
  await audit({ workspaceOwnerId: scope.workspaceOwnerId, actorUserId: actor.id, eventType: "reminder_policy_updated", details: data });
  return recipientPolicy(targetUserId);
}

async function deliverApprovedInAppReminder(input: {
  db: ReminderDb;
  scheduleId: number;
  workspaceOwnerId: number;
  commitmentId: number;
  recipient: { id: number; openId: string };
  title: string;
  content: string;
  taskId: string | null;
  taskName: string;
  dueDate: Date;
  actorUserId: number;
}) {
  return input.db.transaction(async (tx) => {
    const [currentCommitment] = await tx.select({
      workspaceOwnerId: commitments.workspaceOwnerId,
      assignedUserId: commitments.assignedUserId,
      status: commitments.status,
    }).from(commitments).where(eq(commitments.id, input.commitmentId)).for("update");
    const [currentSchedule] = await tx.select({
      recipientUserId: reminderSchedules.recipientUserId,
      state: reminderSchedules.state,
    }).from(reminderSchedules).where(eq(reminderSchedules.id, input.scheduleId)).for("update");
    if (!currentCommitment || !currentSchedule) throw new Error("Reminder assignment could not be revalidated");
    if (currentSchedule.state !== "sending") throw new Error("Reminder delivery state changed; review it before retrying");
    if (currentCommitment.status !== "open") {
      await tx.update(reminderSchedules).set({
        state: "cancelled",
        error: null,
        policyReason: "Commitment was closed before reminder delivery.",
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      return false;
    }
    if (currentCommitment.workspaceOwnerId !== input.workspaceOwnerId) {
      const reason = "The commitment workspace changed before delivery; review the reminder assignment.";
      await tx.update(reminderSchedules).set({
        state: "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        error: reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_workspace_changed_before_delivery",
        detailsJson: JSON.stringify({ previousWorkspaceOwnerId: input.workspaceOwnerId }),
      });
      return false;
    }
    if (currentCommitment.assignedUserId !== currentSchedule.recipientUserId
      || currentSchedule.recipientUserId !== input.recipient.id) {
      const reason = currentCommitment.assignedUserId
        ? "Worker assignment changed before delivery; the reminder was returned to the current worker."
        : "The commitment no longer has an assigned worker; review the reminder assignment.";
      await tx.update(reminderSchedules).set({
        ...(currentCommitment.assignedUserId ? { recipientUserId: currentCommitment.assignedUserId } : {}),
        state: currentCommitment.assignedUserId ? "scheduled" : "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        lastAttemptAt: null,
        error: currentCommitment.assignedUserId ? null : reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_reassigned_before_delivery",
        detailsJson: JSON.stringify({
          previousRecipientId: currentSchedule.recipientUserId,
          assignedUserId: currentCommitment.assignedUserId,
        }),
      });
      return false;
    }

    const [lockedRecipient] = await tx.select({ id: users.id, openId: users.openId, role: users.role }).from(users)
      .where(eq(users.id, currentSchedule.recipientUserId)).for("update");
    if (!lockedRecipient) throw new Error("Reminder recipient no longer exists");
    if (lockedRecipient.role !== "worker"
      || !await activeWorkerProfileBelongsToWorkspace(tx, lockedRecipient.id, currentCommitment.workspaceOwnerId, true)) {
      const reason = "The assigned account no longer has an active worker profile in this workspace; review the reminder.";
      await tx.update(reminderSchedules).set({
        state: "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        error: reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_worker_access_changed_before_delivery",
        detailsJson: JSON.stringify({ recipientUserId: lockedRecipient.id }),
      });
      return false;
    }

    await tx.insert(notificationHistory).values({
      userId: input.recipient.id,
      userOpenId: lockedRecipient.openId,
      title: input.title,
      content: input.content,
      notificationType: "general",
      taskId: input.taskId,
      taskName: input.taskName,
      dueDate: input.dueDate,
      channel: "in_app",
      deliveryStatus: "sent",
      deliveredAt: new Date(),
    });
    const delivered = await tx.update(reminderSchedules).set({ state: "sent", sentAt: new Date(), error: null })
      .where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
    if (affectedRows(delivered) !== 1) throw new Error("Reminder delivery state changed; review it before retrying");
    await tx.insert(reminderAuditEvents).values({
      workspaceOwnerId: input.workspaceOwnerId,
      commitmentId: input.commitmentId,
      scheduleId: input.scheduleId,
      actorUserId: input.actorUserId,
      eventType: "reminder_sent",
      detailsJson: JSON.stringify({ channel: "in_app" }),
    });
    return true;
  });
}

async function deliverApprovedEmailReminder(input: {
  db: ReminderDb;
  scheduleId: number;
  workspaceOwnerId: number;
  commitmentId: number;
  actorUserId: number;
  title: string;
  content: string;
}): Promise<"sent" | "reassigned" | "worker_access_changed" | "closed" | "missing_email" | "not_sent" | "uncertain" | { blockedByPolicy: string }> {
  return input.db.transaction(async (tx) => {
    // Hold the commitment lock through delivery so reassignment cannot race the recipient check.
    const [currentCommitment] = await tx.select({
      workspaceOwnerId: commitments.workspaceOwnerId,
      assignedUserId: commitments.assignedUserId,
      status: commitments.status,
    }).from(commitments).where(eq(commitments.id, input.commitmentId)).for("update");
    const [currentSchedule] = await tx.select({
      recipientUserId: reminderSchedules.recipientUserId,
      state: reminderSchedules.state,
    }).from(reminderSchedules).where(eq(reminderSchedules.id, input.scheduleId)).for("update");
    if (!currentCommitment || !currentSchedule || currentSchedule.state !== "sending") {
      throw new Error("Reminder delivery state changed; verify the destination before retrying");
    }
    if (currentCommitment.status !== "open") {
      await tx.update(reminderSchedules).set({
        state: "cancelled",
        error: null,
        policyReason: "Commitment was closed before email delivery.",
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      return "closed";
    }
    if (currentCommitment.workspaceOwnerId !== input.workspaceOwnerId) {
      const reason = "The commitment workspace changed before email delivery; review the reminder assignment.";
      await tx.update(reminderSchedules).set({
        state: "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        error: reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_workspace_changed_before_delivery",
        detailsJson: JSON.stringify({ previousWorkspaceOwnerId: input.workspaceOwnerId }),
      });
      return "worker_access_changed";
    }
    if (currentCommitment.assignedUserId !== currentSchedule.recipientUserId) {
      const reason = currentCommitment.assignedUserId
        ? "Worker assignment changed before delivery; the reminder was returned to the current worker."
        : "The commitment no longer has an assigned worker; review the reminder assignment.";
      await tx.update(reminderSchedules).set({
        ...(currentCommitment.assignedUserId ? { recipientUserId: currentCommitment.assignedUserId } : {}),
        state: currentCommitment.assignedUserId ? "scheduled" : "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        lastAttemptAt: null,
        error: currentCommitment.assignedUserId ? null : reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_reassigned_before_delivery",
        detailsJson: JSON.stringify({
          previousRecipientId: currentSchedule.recipientUserId,
          assignedUserId: currentCommitment.assignedUserId,
        }),
      });
      return "reassigned";
    }

    const [recipient] = await tx.select({ email: users.email, role: users.role }).from(users)
      .where(eq(users.id, currentSchedule.recipientUserId)).for("update");
    if (!recipient || recipient.role !== "worker"
      || !await activeWorkerProfileBelongsToWorkspace(tx, currentSchedule.recipientUserId, currentCommitment.workspaceOwnerId, true)) {
      const reason = "The assigned account no longer has an active worker profile in this workspace; email was not sent and needs review.";
      await tx.update(reminderSchedules).set({
        state: "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        error: reason,
        policyReason: reason,
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_worker_access_changed_before_delivery",
        detailsJson: JSON.stringify({ recipientUserId: currentSchedule.recipientUserId }),
      });
      return "worker_access_changed";
    }
    if (!recipient?.email) {
      await tx.update(reminderSchedules).set({ state: "failed", error: "Recipient has no email address" })
        .where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_delivery_failed",
        detailsJson: JSON.stringify({ reason: "Recipient has no email address" }),
      });
      return "missing_email";
    }

    // Recheck policy under a row lock so a recipient opt-out committed after approval
    // but before delivery cannot be bypassed by the earlier approval snapshot.
    const [currentPolicy] = await tx.select().from(reminderPolicies)
      .where(eq(reminderPolicies.userId, currentSchedule.recipientUserId))
      .limit(1)
      .for("update");
    const policy = currentPolicy ?? defaultPolicy(currentSchedule.recipientUserId);
    const policyNow = new Date();
    const stats = await deliveryStats(tx, currentSchedule.recipientUserId, policyNow, policy.timezone, input.scheduleId);
    const policyDecision = evaluateReminderPolicy({
      policy,
      channel: "email",
      now: policyNow,
      ...stats,
    });
    if (!policyDecision.allowed) {
      const reason = policyDecision.reason;
      const nextState = policyDecision.permanent ? "skipped" : "scheduled";
      const updated = await tx.update(reminderSchedules).set({
        state: nextState,
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        lastAttemptAt: null,
        error: null,
        policyReason: reason,
        ...(policyDecision.permanent ? {} : { scheduledFor: policyDecision.retryAt ?? new Date(policyNow.getTime() + 60 * 60_000) }),
      }).where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      if (affectedRows(updated) !== 1) throw new Error("Reminder delivery state changed; review it before retrying");
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: policyDecision.permanent ? "reminder_skipped" : "reminder_policy_deferred",
        detailsJson: JSON.stringify({ channel: "email", reason }),
      });
      return { blockedByPolicy: reason };
    }

    let outcome: Awaited<ReturnType<typeof sendEmailWithOutcome>>;
    try {
      outcome = await sendEmailWithOutcome({
        to: recipient.email,
        subject: input.title,
        text: input.content,
        html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(input.content)}</pre>`,
      });
    } catch {
      // The sender checks provider readiness before attempting delivery. A rejected
      // readiness lookup therefore confirms no message was handed to a provider.
      outcome = { status: "not_sent", reason: "Email provider readiness could not be checked; no email was sent." };
    }

    if (outcome.status === "not_sent") {
      const reason = outcome.reason;
      await tx.update(reminderSchedules).set({ state: "failed", error: reason, policyReason: reason })
        .where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_delivery_not_sent",
        detailsJson: JSON.stringify({ reason }),
      });
      return "not_sent";
    }

    if (outcome.status === "uncertain") {
      const reason = outcome.reason;
      await tx.update(reminderSchedules).set({ state: "needs_review", error: reason, policyReason: reason })
        .where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: input.commitmentId,
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        eventType: "reminder_delivery_uncertain",
        detailsJson: JSON.stringify({ reason }),
      });
      return "uncertain";
    }

    await tx.update(reminderSchedules).set({ state: "sent", sentAt: new Date(), error: null })
      .where(and(eq(reminderSchedules.id, input.scheduleId), eq(reminderSchedules.state, "sending")));
    await tx.insert(reminderAuditEvents).values({
      workspaceOwnerId: input.workspaceOwnerId,
      commitmentId: input.commitmentId,
      scheduleId: input.scheduleId,
      actorUserId: input.actorUserId,
      eventType: "reminder_sent",
      detailsJson: JSON.stringify({ channel: "email" }),
    });
    return "sent";
  });
}

export async function approveAndSendReminder(actor: ReminderActor, scheduleId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db.select({ schedule: reminderSchedules, commitment: commitments, recipient: users })
    .from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .innerJoin(users, eq(users.id, reminderSchedules.recipientUserId))
    .where(eq(reminderSchedules.id, scheduleId)).limit(1);
  if (!row) throw new Error("Reminder occurrence not found");
  await assertReminderActorAccess(actor, row.commitment, row.schedule.recipientUserId);
  const now = new Date();

  const approvalResult = await db.transaction(async (tx) => {
    // Approval and closure lock in the same order so exactly one transition wins.
    const [currentCommitment] = await tx.select({
      workspaceOwnerId: commitments.workspaceOwnerId,
      assignedUserId: commitments.assignedUserId,
      status: commitments.status,
      sourceType: commitments.sourceType,
      sourceId: commitments.sourceId,
      title: commitments.title,
      context: commitments.context,
      dueAt: commitments.dueAt,
    }).from(commitments).where(eq(commitments.id, row.commitment.id)).for("update");
    if (!currentCommitment) throw new Error("Commitment not found");

    const scope = await workspaceForActor(actor, tx, true);
    const [currentSchedule] = await tx.select({
      commitmentId: reminderSchedules.commitmentId,
      recipientUserId: reminderSchedules.recipientUserId,
      state: reminderSchedules.state,
      channel: reminderSchedules.channel,
      draftTitle: reminderSchedules.draftTitle,
      draftContent: reminderSchedules.draftContent,
    }).from(reminderSchedules).where(eq(reminderSchedules.id, scheduleId)).for("update");
    if (!currentSchedule || currentSchedule.commitmentId !== row.commitment.id) {
      throw new Error("Reminder occurrence changed before approval");
    }
    if (currentSchedule.recipientUserId !== currentCommitment.assignedUserId) {
      const reason = currentCommitment.assignedUserId
        ? "Worker assignment changed before approval; the reminder was returned for the current worker."
        : "The commitment no longer has an assigned worker; review the reminder assignment.";
      await tx.update(reminderSchedules).set({
        ...(currentCommitment.assignedUserId ? { recipientUserId: currentCommitment.assignedUserId } : {}),
        state: currentCommitment.assignedUserId ? "scheduled" : "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        lastAttemptAt: null,
        error: currentCommitment.assignedUserId ? null : reason,
        policyReason: reason,
      }).where(eq(reminderSchedules.id, scheduleId));
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: row.commitment.id,
        scheduleId,
        actorUserId: actor.id,
        eventType: "reminder_reassigned_before_approval",
        detailsJson: JSON.stringify({
          previousRecipientId: currentSchedule.recipientUserId,
          assignedUserId: currentCommitment.assignedUserId,
        }),
      });
      return { kind: "reassigned" as const };
    }
    if (!reminderActorCanAccessOccurrence(actor, {
      workspaceOwnerId: currentCommitment.workspaceOwnerId,
      assignedUserId: currentCommitment.assignedUserId,
      recipientUserId: currentSchedule.recipientUserId,
      currentWorkspaceOwnerId: scope.workspaceOwnerId,
    })) throw new Error("You cannot access this reminder in the current workspace");
    if (currentCommitment.status !== "open") throw new Error("Commitment is closed; reminder cannot be sent");
    if (currentSchedule.state === "needs_review") {
      throw new Error("Reminder needs_review; verify delivery status before requesting a fresh approval");
    }
    if (currentSchedule.state !== "draft_ready" && currentSchedule.state !== "failed") {
      throw new Error("Reminder is already being processed");
    }

    const currentCommitmentSnapshot = { ...row.commitment, ...currentCommitment };
    const sourceHold = await unverifiedGmailReminderReason(tx, currentCommitmentSnapshot);
    if (sourceHold) {
      const held = await tx.update(reminderSchedules).set({
        state: "needs_review",
        error: sourceHold,
        policyReason: sourceHold,
        approvedAt: null,
        approvedByUserId: null,
      }).where(and(
        eq(reminderSchedules.id, scheduleId),
        eq(reminderSchedules.commitmentId, row.commitment.id),
        inArray(reminderSchedules.state, ["draft_ready", "failed"]),
      ));
      if (affectedRows(held) !== 1) throw new Error("Reminder state changed before its source could be held for review");
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: row.commitment.id,
        scheduleId,
        actorUserId: actor.id,
        eventType: "reminder_source_needs_review",
        detailsJson: JSON.stringify({ reason: sourceHold }),
      });
      return { kind: "source_hold" as const, reason: sourceHold };
    }

    const currentDraft = draftForCommitment(
      currentCommitment.title,
      currentCommitment.context,
      currentCommitment.dueAt,
    );
    if (currentSchedule.draftTitle !== currentDraft.title || currentSchedule.draftContent !== currentDraft.content) {
      const refreshed = await tx.update(reminderSchedules).set({
        state: "draft_ready",
        draftTitle: currentDraft.title,
        draftContent: currentDraft.content,
        approvedAt: null,
        approvedByUserId: null,
        error: null,
        policyReason: "Commitment details changed after this message was prepared. Review the updated message and approve it again.",
      }).where(and(
        eq(reminderSchedules.id, scheduleId),
        eq(reminderSchedules.commitmentId, row.commitment.id),
        inArray(reminderSchedules.state, ["draft_ready", "failed"]),
      ));
      if (affectedRows(refreshed) !== 1) throw new Error("Reminder changed before its updated draft could be saved");
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: row.commitment.id,
        scheduleId,
        actorUserId: actor.id,
        eventType: "reminder_draft_refreshed",
        detailsJson: JSON.stringify({ reason: "commitment_details_changed" }),
      });
      return { kind: "draft_refreshed" as const };
    }

    // Serialize approvals by recipient, then recheck quota before claiming this schedule.
    const [lockedRecipient] = await tx.select({ id: users.id, role: users.role }).from(users)
      .where(eq(users.id, currentSchedule.recipientUserId)).for("update");
    if (!lockedRecipient) throw new Error("Reminder recipient no longer exists");
    if (lockedRecipient.role !== "worker"
      || !await activeWorkerProfileBelongsToWorkspace(tx, lockedRecipient.id, currentCommitment.workspaceOwnerId, true)) {
      const reason = "The assigned account no longer has an active worker profile in this workspace; review the reminder.";
      const held = await tx.update(reminderSchedules).set({
        state: "needs_review",
        draftTitle: null,
        draftContent: null,
        approvedAt: null,
        approvedByUserId: null,
        error: reason,
        policyReason: reason,
      }).where(and(
        eq(reminderSchedules.id, scheduleId),
        eq(reminderSchedules.commitmentId, row.commitment.id),
        inArray(reminderSchedules.state, ["draft_ready", "failed"]),
      ));
      if (affectedRows(held) !== 1) throw new Error("Reminder state changed before worker access could be rechecked");
      await tx.insert(reminderAuditEvents).values({
        workspaceOwnerId: currentCommitment.workspaceOwnerId,
        commitmentId: row.commitment.id,
        scheduleId,
        actorUserId: actor.id,
        eventType: "reminder_worker_access_changed_before_approval",
        detailsJson: JSON.stringify({ recipientUserId: lockedRecipient.id }),
      });
      return { kind: "worker_access_changed" as const };
    }
    const policy = await recipientPolicy(currentSchedule.recipientUserId, tx);
    const stats = await deliveryStats(tx, currentSchedule.recipientUserId, now, policy.timezone);
    const decision = evaluateReminderPolicy({ policy, channel: currentSchedule.channel, now, ...stats });
    if (!decision.allowed) throw new Error(decision.reason);

    const claim = await tx.update(reminderSchedules).set({
      state: "sending",
      approvedAt: now,
      approvedByUserId: actor.id,
      lastAttemptAt: now,
      error: null,
    }).where(and(
      eq(reminderSchedules.id, scheduleId),
      eq(reminderSchedules.commitmentId, row.commitment.id),
      inArray(reminderSchedules.state, ["draft_ready", "failed"]),
    ));
    if (affectedRows(claim) !== 1) throw new Error("Reminder is already being processed");
    const approval = {
      approvedAt: now,
      title: currentSchedule.draftTitle ?? currentDraft.title,
      content: currentSchedule.draftContent ?? currentDraft.content,
      channel: currentSchedule.channel,
    };
    await tx.insert(reminderAuditEvents).values({
      workspaceOwnerId: currentCommitment.workspaceOwnerId,
      commitmentId: row.commitment.id,
      scheduleId,
      actorUserId: actor.id,
      eventType: "reminder_approved",
      detailsJson: JSON.stringify({ channel: currentSchedule.channel }),
    });
    return { kind: "approved" as const, approval };
  });

  if (approvalResult.kind === "reassigned") {
    throw new Error("The reminder assignment changed. It has been returned to the current worker for review.");
  }
  if (approvalResult.kind === "worker_access_changed") {
    throw new Error("The assigned worker's access changed. The reminder was held for review and no message was sent.");
  }
  if (approvalResult.kind === "source_hold") throw new Error(approvalResult.reason);
  if (approvalResult.kind === "draft_refreshed") {
    throw new Error("The commitment changed. The reminder message was updated; review it and approve again.");
  }
  const { approval } = approvalResult;

  if (approval.channel === "email") {
    const delivery = await deliverApprovedEmailReminder({
      db,
      scheduleId,
      workspaceOwnerId: row.commitment.workspaceOwnerId,
      commitmentId: row.commitment.id,
      actorUserId: actor.id,
      title: approval.title,
      content: approval.content,
    });
    if (typeof delivery === "object") throw new Error(delivery.blockedByPolicy);
    if (delivery === "reassigned") {
      throw new Error("The reminder assignment changed. It has been returned to the current worker for review.");
    }
    if (delivery === "worker_access_changed") {
      throw new Error("The assigned worker's access changed. The reminder was held for review and no message was sent.");
    }
    if (delivery === "closed") throw new Error("Commitment is closed; reminder was not sent");
    if (delivery === "missing_email") throw new Error("Recipient has no email address");
    if (delivery === "not_sent") {
      throw new Error("Email reminder was not sent. Check the email setup before approving it again.");
    }
    if (delivery === "uncertain") {
      throw new Error("Provider did not confirm delivery. Verify the destination before authorizing a retry.");
    }
    return { success: true };
  } else {
    const delivered = await deliverApprovedInAppReminder({
      db,
      scheduleId,
      workspaceOwnerId: row.commitment.workspaceOwnerId,
      commitmentId: row.commitment.id,
      recipient: row.recipient,
      title: approval.title,
      content: approval.content,
      taskId: row.commitment.sourceId,
      taskName: row.commitment.title,
      dueDate: row.commitment.dueAt,
      actorUserId: actor.id,
    });
    if (!delivered) {
      throw new Error("The reminder assignment changed. It has been returned to the current worker for review.");
    }
    return { success: true };
  }
}

export async function confirmReminderRetry(actor: ReminderActor, scheduleId: number, confirmation: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const note = confirmation.trim();
  if (note.length < 10) throw new Error("Describe how delivery was checked before retrying");
  const [row] = await db.select({ schedule: reminderSchedules, commitment: commitments })
    .from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .where(eq(reminderSchedules.id, scheduleId)).limit(1);
  if (!row) throw new Error("Reminder occurrence not found");
  await assertReminderActorAccess(actor, row.commitment, row.schedule.recipientUserId);
  await db.transaction(async (tx) => {
    const [currentCommitment] = await tx.select({
      workspaceOwnerId: commitments.workspaceOwnerId,
      assignedUserId: commitments.assignedUserId,
      status: commitments.status,
    }).from(commitments).where(eq(commitments.id, row.commitment.id)).for("update");
    if (!currentCommitment) throw new Error("Commitment not found");
    const scope = await workspaceForActor(actor, tx, true);
    const [currentSchedule] = await tx.select({
      commitmentId: reminderSchedules.commitmentId,
      recipientUserId: reminderSchedules.recipientUserId,
      state: reminderSchedules.state,
    }).from(reminderSchedules).where(eq(reminderSchedules.id, scheduleId)).for("update");
    if (!currentSchedule || currentSchedule.commitmentId !== row.commitment.id) {
      throw new Error("Reminder occurrence changed before review");
    }
    if (!reminderActorCanAccessOccurrence(actor, {
      workspaceOwnerId: currentCommitment.workspaceOwnerId,
      assignedUserId: currentCommitment.assignedUserId,
      recipientUserId: currentSchedule.recipientUserId,
      currentWorkspaceOwnerId: scope.workspaceOwnerId,
    })) throw new Error("You cannot access this reminder in the current workspace");
    if (currentCommitment.status !== "open") throw new Error("Commitment is closed; delivery cannot be retried");
    if (currentSchedule.state !== "needs_review") throw new Error("Reminder is not awaiting delivery review");
    const updated = await tx.update(reminderSchedules).set({
      state: "draft_ready",
      policyReason: "Delivery uncertainty was reviewed. A new explicit approval is still required.",
      error: null,
    }).where(and(
      eq(reminderSchedules.id, scheduleId),
      eq(reminderSchedules.commitmentId, row.commitment.id),
      eq(reminderSchedules.state, "needs_review"),
    ));
    if (affectedRows(updated) !== 1) throw new Error("Reminder is not awaiting delivery review");
    await tx.insert(reminderAuditEvents).values({
      workspaceOwnerId: currentCommitment.workspaceOwnerId,
      commitmentId: row.commitment.id,
      scheduleId,
      actorUserId: actor.id,
      eventType: "reminder_retry_reviewed",
      detailsJson: JSON.stringify({ confirmation: note }),
    });
  });
  return { success: true };
}

export async function closeCommitment(actor: ReminderActor, commitmentId: number, status: "completed" | "cancelled") {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db.transaction(async (tx) => {
    const [currentCommitment] = await tx.select({
      workspaceOwnerId: commitments.workspaceOwnerId,
      assignedUserId: commitments.assignedUserId,
      status: commitments.status,
    }).from(commitments).where(eq(commitments.id, commitmentId)).for("update");
    if (!currentCommitment) throw new Error("Commitment not found or not accessible");
    const scope = await workspaceForActor(actor, tx, true);
    if (!reminderActorCanAccessCommitment(actor, {
      workspaceOwnerId: currentCommitment.workspaceOwnerId,
      assignedUserId: currentCommitment.assignedUserId,
      currentWorkspaceOwnerId: scope.workspaceOwnerId,
    })) throw new Error("Commitment not found or not accessible");

    if (currentCommitment.status !== "open") {
      if (currentCommitment.status === status) return { success: true };
      throw new Error(`Commitment is already ${currentCommitment.status} and cannot be changed to ${status}`);
    }

    const now = new Date();
    const updated = await tx.update(commitments).set({
      status,
      completedAt: status === "completed" ? now : null,
      cancelledAt: status === "cancelled" ? now : null,
    }).where(eq(commitments.id, commitmentId));
    if (affectedRows(updated) !== 1) throw new Error("Commitment not found or not accessible");

    // A sending state is an approval claim that won before this closure. Let it
    // finish; all work not yet approved is cancelled atomically with the close.
    await tx.update(reminderSchedules).set({ state: "cancelled", policyReason: `Commitment ${status}.` })
      .where(and(eq(reminderSchedules.commitmentId, commitmentId), inArray(reminderSchedules.state, [...CANCELLABLE_REMINDER_STATES])));
    await tx.insert(reminderAuditEvents).values({
      workspaceOwnerId: currentCommitment.workspaceOwnerId,
      commitmentId,
      actorUserId: actor.id,
      eventType: `commitment_${status}`,
      detailsJson: null,
    });
    return { success: true };
  });
}

let reminderTimer: NodeJS.Timeout | null = null;

export function startReminderWorker(intervalMs = Number(process.env.REMINDER_WORKER_INTERVAL_MS ?? 60_000)) {
  if (reminderTimer || process.env.REMINDER_WORKER_ENABLED === "false") return;
  const run = createNonOverlappingRunner(async () => {
    try {
      await recoverInterruptedReminders();
      await processDueReminders();
    } catch (error) {
      console.error("[ReminderWorker] Tick failed:", error);
    }
  });
  void run();
  reminderTimer = setInterval(() => void run(), Math.max(15_000, intervalMs));
  reminderTimer.unref?.();
}

export function stopReminderWorker() {
  if (!reminderTimer) return;
  clearInterval(reminderTimer);
  reminderTimer = null;
}
