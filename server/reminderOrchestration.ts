import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  commitments,
  notificationHistory,
  reminderAuditEvents,
  reminderPolicies,
  reminderRules,
  reminderSchedules,
  users,
  vaProfiles,
  type ReminderPolicy,
  type User,
} from "../drizzle/schema";
import { getDb } from "./db";
import { createNonOverlappingRunner } from "./services/non-overlapping-runner";
import { sendEmail } from "./services/email";

export const REMINDER_TERMINAL_STATES = ["sent", "skipped", "cancelled"] as const;
const ACTIVE_REMINDER_STATES = ["scheduled", "preparing", "draft_ready", "sending", "failed", "needs_review", "escalated"] as const;
const EXTERNAL_CHANNELS = new Set(["email"]);

type ReminderActor = Pick<User, "id" | "openId" | "role" | "email">;
type ReminderChannel = "in_app" | "email";
type TriggerType = "before_due" | "at_due" | "after_due" | "no_update" | "manual";

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

function affectedRows(result: unknown) {
  if (Array.isArray(result)) return Number((result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0);
  return Number((result as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0);
}

function insertId(result: unknown) {
  if (Array.isArray(result)) return Number((result[0] as { insertId?: unknown } | undefined)?.insertId ?? 0);
  return Number((result as { insertId?: unknown } | undefined)?.insertId ?? 0);
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

async function workspaceForActor(actor: ReminderActor) {
  if (actor.role === "admin") return { workspaceOwnerId: actor.id, assignedUserId: null as number | null };
  if (actor.role !== "worker") throw new Error("Reminder access requires an admin or worker account");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [profile] = await db.select({ founderId: vaProfiles.founderId }).from(vaProfiles)
    .where(eq(vaProfiles.userId, actor.id)).limit(1);
  if (!profile) throw new Error("Worker profile not found");
  return { workspaceOwnerId: profile.founderId, assignedUserId: actor.id };
}

async function assertAssignableUser(workspaceOwnerId: number, assignedUserId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [profile] = await db.select({ id: vaProfiles.id }).from(vaProfiles)
    .where(and(eq(vaProfiles.founderId, workspaceOwnerId), eq(vaProfiles.userId, assignedUserId))).limit(1);
  if (!profile) throw new Error("The selected worker does not belong to this workspace");
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

export async function createReminder(actor: ReminderActor, input: CreateReminderInput) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const scope = await workspaceForActor(actor);
  const assignedUserId = actor.role === "worker" ? actor.id : input.assignedUserId;
  if (!assignedUserId) throw new Error("A worker recipient is required");
  if (actor.role === "admin") await assertAssignableUser(scope.workspaceOwnerId, assignedUserId);
  const scheduledFor = scheduleTimeForRule(input.dueAt, input.triggerType, input.offsetMinutes);

  return db.transaction(async (tx) => {
    const commitmentResult = await tx.insert(commitments).values({
      workspaceOwnerId: scope.workspaceOwnerId,
      assignedUserId,
      createdByUserId: actor.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId?.trim() || null,
      sourceUrl: input.sourceUrl?.trim() || null,
      title: input.title.trim(),
      context: input.context?.trim() || null,
      dueAt: input.dueAt,
    });
    const commitmentId = insertId(commitmentResult);
    if (!commitmentId) throw new Error("Commitment could not be created");

    const ruleResult = await tx.insert(reminderRules).values({
      workspaceOwnerId: scope.workspaceOwnerId,
      createdByUserId: actor.id,
      name: input.ruleName?.trim() || `${input.offsetMinutes} minute ${input.triggerType.replaceAll("_", " ")}`,
      triggerType: input.triggerType,
      offsetMinutes: input.offsetMinutes,
      channel: input.channel,
      requireApproval: EXTERNAL_CHANNELS.has(input.channel) ? true : input.requireApproval,
      maxAttempts: 1,
      cooldownMinutes: 60,
    });
    const ruleId = insertId(ruleResult);
    if (!ruleId) throw new Error("Reminder rule could not be created");

    const idempotencyKey = createHash("sha256")
      .update(`${scope.workspaceOwnerId}:${commitmentId}:${ruleId}:${scheduledFor.toISOString()}`)
      .digest("hex");
    const scheduleResult = await tx.insert(reminderSchedules).values({
      commitmentId,
      ruleId,
      recipientUserId: assignedUserId,
      scheduledFor,
      channel: input.channel,
      idempotencyKey,
    });
    const scheduleId = insertId(scheduleResult);
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
        detailsJson: JSON.stringify({ channel: input.channel, scheduledFor: scheduledFor.toISOString(), approvalRequired: EXTERNAL_CHANNELS.has(input.channel) || input.requireApproval }),
      },
    ]);

    return { commitmentId, ruleId, scheduleId, scheduledFor };
  });
}

async function recipientPolicy(recipientUserId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [policy] = await db.select().from(reminderPolicies).where(eq(reminderPolicies.userId, recipientUserId)).limit(1);
  return policy ?? defaultPolicy(recipientUserId);
}

async function deliveryStats(recipientUserId: number, now: Date) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const [stats] = await db.select({
    sentToday: sql<number>`SUM(CASE WHEN ${reminderSchedules.sentAt} >= ${dayStart} THEN 1 ELSE 0 END)`,
    lastSentAt: sql<Date | null>`MAX(${reminderSchedules.sentAt})`,
  }).from(reminderSchedules).where(and(
    eq(reminderSchedules.recipientUserId, recipientUserId),
    eq(reminderSchedules.state, "sent"),
  ));
  return { sentToday: Number(stats?.sentToday ?? 0), lastSentAt: stats?.lastSentAt ? new Date(stats.lastSentAt) : null };
}

async function deliverClaimedSchedule(scheduleId: number, actorUserId: number | null, now: Date) {
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

  const draft = draftForCommitment(row.commitment.title, row.commitment.context, row.commitment.dueAt);
  const policy = await recipientPolicy(row.schedule.recipientUserId);
  const stats = await deliveryStats(row.schedule.recipientUserId, now);
  const decision = evaluateReminderPolicy({ policy, channel: row.schedule.channel, now, ...stats });

  if (!decision.allowed) {
    if (row.schedule.channel === "email" || row.rule.requireApproval) {
      await db.update(reminderSchedules).set({
        state: "draft_ready",
        draftTitle: draft.title,
        draftContent: draft.content,
        policyReason: decision.reason,
      }).where(eq(reminderSchedules.id, scheduleId));
      await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId, eventType: "reminder_draft_ready", details: { policyAllowed: false, reason: decision.reason } });
      return "draft_ready" as const;
    }
    if (decision.permanent) {
      await db.update(reminderSchedules).set({ state: "skipped", policyReason: decision.reason }).where(eq(reminderSchedules.id, scheduleId));
      await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId, eventType: "reminder_skipped", details: { reason: decision.reason } });
      return "skipped" as const;
    }
    await db.update(reminderSchedules).set({ state: "scheduled", scheduledFor: decision.retryAt ?? new Date(now.getTime() + 60 * 60_000), policyReason: decision.reason }).where(eq(reminderSchedules.id, scheduleId));
    await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId, eventType: "reminder_deferred", details: { reason: decision.reason, retryAt: decision.retryAt?.toISOString() ?? null } });
    return "scheduled" as const;
  }

  if (row.schedule.channel === "email" || row.rule.requireApproval) {
    await db.update(reminderSchedules).set({
      state: "draft_ready",
      draftTitle: draft.title,
      draftContent: draft.content,
      policyReason: EXTERNAL_CHANNELS.has(row.schedule.channel) ? "External email requires explicit approval." : decision.reason,
    }).where(eq(reminderSchedules.id, scheduleId));
    await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId, eventType: "reminder_draft_ready", details: { policyAllowed: true, approvalRequired: true } });
    return "draft_ready" as const;
  }

  await db.insert(notificationHistory).values({
    userId: row.recipient.id,
    userOpenId: row.recipient.openId,
    title: draft.title,
    content: draft.content,
    notificationType: "general",
    taskId: row.commitment.sourceId,
    taskName: row.commitment.title,
    dueDate: row.commitment.dueAt,
    channel: "in_app",
    deliveryStatus: "sent",
    deliveredAt: now,
  });
  await db.update(reminderSchedules).set({ state: "sent", draftTitle: draft.title, draftContent: draft.content, sentAt: now, policyReason: decision.reason }).where(eq(reminderSchedules.id, scheduleId));
  await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId, eventType: "reminder_sent", details: { channel: "in_app" } });
  return "sent" as const;
}

export async function processDueReminders(now = new Date(), limit = 50) {
  const db = await getDb();
  if (!db) return { claimed: 0, sent: 0, drafted: 0, deferred: 0, skipped: 0, failed: 0 };
  const due = await db.select({ id: reminderSchedules.id }).from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .where(and(eq(reminderSchedules.state, "scheduled"), lte(reminderSchedules.scheduledFor, now), eq(commitments.status, "open")))
    .orderBy(reminderSchedules.scheduledFor).limit(Math.min(Math.max(limit, 1), 200));
  const result = { claimed: 0, sent: 0, drafted: 0, deferred: 0, skipped: 0, failed: 0 };

  for (const item of due) {
    const claim = await db.update(reminderSchedules).set({ state: "preparing", lastAttemptAt: now, attemptCount: sql`${reminderSchedules.attemptCount} + 1` })
      .where(and(eq(reminderSchedules.id, item.id), eq(reminderSchedules.state, "scheduled")));
    if (affectedRows(claim) !== 1) continue;
    result.claimed++;
    try {
      const state = await deliverClaimedSchedule(item.id, null, now);
      if (state === "sent") result.sent++;
      else if (state === "draft_ready") result.drafted++;
      else if (state === "scheduled") result.deferred++;
      else if (state === "skipped") result.skipped++;
    } catch (error) {
      result.failed++;
      const message = error instanceof Error ? error.message : String(error);
      await db.update(reminderSchedules).set({ state: "failed", error: message }).where(eq(reminderSchedules.id, item.id));
    }
  }
  return result;
}

export async function recoverInterruptedReminders(now = new Date()) {
  const db = await getDb();
  if (!db) return 0;
  const staleBefore = new Date(now.getTime() - 15 * 60_000);
  const updated = await db.update(reminderSchedules).set({
    state: "needs_review",
    policyReason: "Processing was interrupted. Delivery is intentionally not retried until a human reviews it.",
  }).where(and(
    inArray(reminderSchedules.state, ["preparing", "sending"]),
    lte(reminderSchedules.lastAttemptAt, staleBefore),
  ));
  return affectedRows(updated);
}

export async function getReminderDashboard(actor: ReminderActor) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const scope = await workspaceForActor(actor);
  const ownership = actor.role === "admin"
    ? eq(commitments.workspaceOwnerId, scope.workspaceOwnerId)
    : eq(reminderSchedules.recipientUserId, actor.id);
  const rows = await db.select({ schedule: reminderSchedules, commitment: commitments, rule: reminderRules })
    .from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .innerJoin(reminderRules, eq(reminderRules.id, reminderSchedules.ruleId))
    .where(ownership)
    .orderBy(desc(reminderSchedules.scheduledFor)).limit(200);
  const policy = await recipientPolicy(actor.id);
  const auditRows = await db.select().from(reminderAuditEvents)
    .where(eq(reminderAuditEvents.workspaceOwnerId, scope.workspaceOwnerId))
    .orderBy(desc(reminderAuditEvents.createdAt)).limit(100);
  return { rows, policy, audit: auditRows };
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

export async function approveAndSendReminder(actor: ReminderActor, scheduleId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db.select({ schedule: reminderSchedules, commitment: commitments, recipient: users })
    .from(reminderSchedules)
    .innerJoin(commitments, eq(commitments.id, reminderSchedules.commitmentId))
    .innerJoin(users, eq(users.id, reminderSchedules.recipientUserId))
    .where(eq(reminderSchedules.id, scheduleId)).limit(1);
  if (!row) throw new Error("Reminder occurrence not found");
  if (actor.id !== row.schedule.recipientUserId && actor.id !== row.commitment.workspaceOwnerId) throw new Error("You cannot approve this reminder");
  if (row.schedule.state !== "draft_ready" && row.schedule.state !== "failed") {
    throw new Error(`Reminder cannot be sent from state ${row.schedule.state}`);
  }
  const policy = await recipientPolicy(row.schedule.recipientUserId);
  const stats = await deliveryStats(row.schedule.recipientUserId, new Date());
  const decision = evaluateReminderPolicy({ policy, channel: row.schedule.channel, now: new Date(), ...stats });
  if (!decision.allowed) throw new Error(decision.reason);

  const claim = await db.update(reminderSchedules).set({ state: "sending", approvedAt: new Date(), approvedByUserId: actor.id, lastAttemptAt: new Date(), error: null })
    .where(and(
      eq(reminderSchedules.id, scheduleId),
      inArray(reminderSchedules.state, ["draft_ready", "failed"]),
    ));
  if (affectedRows(claim) !== 1) throw new Error("Reminder is already being processed");
  await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId: actor.id, eventType: "reminder_approved", details: { channel: row.schedule.channel } });

  const title = row.schedule.draftTitle || `Reminder: ${row.commitment.title}`;
  const content = row.schedule.draftContent || draftForCommitment(row.commitment.title, row.commitment.context, row.commitment.dueAt).content;
  let sent = false;
  if (row.schedule.channel === "email") {
    if (!row.recipient.email) {
      await db.update(reminderSchedules).set({ state: "failed", error: "Recipient has no email address" }).where(eq(reminderSchedules.id, scheduleId));
      throw new Error("Recipient has no email address");
    }
    sent = await sendEmail({
      to: row.recipient.email,
      subject: title,
      text: content,
      html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(content)}</pre>`,
    });
  } else {
    await db.insert(notificationHistory).values({
      userId: row.recipient.id,
      userOpenId: row.recipient.openId,
      title,
      content,
      notificationType: "general",
      taskId: row.commitment.sourceId,
      taskName: row.commitment.title,
      dueDate: row.commitment.dueAt,
      channel: "in_app",
      deliveryStatus: "sent",
      deliveredAt: new Date(),
    });
    sent = true;
  }
  if (!sent) {
    const reason = "Provider did not confirm delivery. Verify the destination before authorizing a retry.";
    await db.update(reminderSchedules).set({ state: "needs_review", error: reason, policyReason: reason }).where(eq(reminderSchedules.id, scheduleId));
    await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId: actor.id, eventType: "reminder_delivery_uncertain", details: { reason } });
    throw new Error(reason);
  }
  await db.update(reminderSchedules).set({ state: "sent", sentAt: new Date(), error: null }).where(eq(reminderSchedules.id, scheduleId));
  await audit({ workspaceOwnerId: row.commitment.workspaceOwnerId, commitmentId: row.commitment.id, scheduleId, actorUserId: actor.id, eventType: "reminder_sent", details: { channel: row.schedule.channel } });
  return { success: true };
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
  if (actor.id !== row.schedule.recipientUserId && actor.id !== row.commitment.workspaceOwnerId) {
    throw new Error("You cannot review this reminder");
  }
  const updated = await db.update(reminderSchedules).set({
    state: "draft_ready",
    policyReason: "Delivery uncertainty was reviewed. A new explicit approval is still required.",
    error: null,
  }).where(and(
    eq(reminderSchedules.id, scheduleId),
    eq(reminderSchedules.state, "needs_review"),
  ));
  if (affectedRows(updated) !== 1) throw new Error("Reminder is not awaiting delivery review");
  await audit({
    workspaceOwnerId: row.commitment.workspaceOwnerId,
    commitmentId: row.commitment.id,
    scheduleId,
    actorUserId: actor.id,
    eventType: "reminder_retry_reviewed",
    details: { confirmation: note },
  });
  return { success: true };
}

export async function closeCommitment(actor: ReminderActor, commitmentId: number, status: "completed" | "cancelled") {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const scope = await workspaceForActor(actor);
  const ownership = actor.role === "admin"
    ? and(eq(commitments.id, commitmentId), eq(commitments.workspaceOwnerId, scope.workspaceOwnerId))
    : and(eq(commitments.id, commitmentId), eq(commitments.assignedUserId, actor.id));
  const updated = await db.update(commitments).set({
    status,
    completedAt: status === "completed" ? new Date() : null,
    cancelledAt: status === "cancelled" ? new Date() : null,
  }).where(ownership);
  if (affectedRows(updated) !== 1) throw new Error("Commitment not found or not accessible");
  await db.update(reminderSchedules).set({ state: "cancelled", policyReason: `Commitment ${status}.` })
    .where(and(eq(reminderSchedules.commitmentId, commitmentId), inArray(reminderSchedules.state, [...ACTIVE_REMINDER_STATES])));
  await audit({ workspaceOwnerId: scope.workspaceOwnerId, commitmentId, actorUserId: actor.id, eventType: `commitment_${status}` });
  return { success: true };
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
