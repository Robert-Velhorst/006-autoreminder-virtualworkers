import { describe, expect, it, vi } from "vitest";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { commitments, notificationHistory, reminderAuditEvents, reminderPolicies, reminderRules, reminderSchedules, users, vaProfiles } from "../drizzle/schema";

const controls = vi.hoisted(() => ({ getDb: vi.fn(), sendEmailWithOutcome: vi.fn() }));
vi.mock("./db", () => ({ getDb: controls.getDb }));
vi.mock("./services/email", () => ({ sendEmailWithOutcome: controls.sendEmailWithOutcome }));

import { approveAndSendReminder, closeCommitment, processDueReminders, recoverInterruptedReminders, zonedCalendarDayBounds } from "./reminderOrchestration";

function makeApprovalDb(
  pauseStats = false,
  currentWorkerWorkspaceOwnerId = 201,
  assignment = { assignedUserId: 101, recipientUserId: 101 },
  timezone = "UTC",
  optOutAfterApproval = false,
) {
  let scheduleState = "draft_ready";
  let scheduleRecipientUserId = assignment.recipientUserId;
  let commitmentStatus = "open";
  let releaseStats!: () => void;
  let notifyStatsReached!: () => void;
  const statsReached = new Promise<void>((resolve) => { notifyStatsReached = resolve; });
  const statsBarrier = new Promise<void>((resolve) => { releaseStats = resolve; });
  let statsExpression: unknown;
  const auditEvents: string[] = [];
  const schedule = {
    id: 71,
    commitmentId: 81,
    recipientUserId: scheduleRecipientUserId,
    channel: "email",
    state: scheduleState,
    draftTitle: "Reminder: Review the appointment",
    draftContent: "Commitment: Review the appointment\nDue: 2026-09-26T12:00:00.000Z\nReview the commitment and record the next concrete action or close it if complete.",
    approvedAt: null as Date | null,
    approvedByUserId: null as number | null,
    error: null as string | null,
  };
  const commitment = {
    id: 81,
    workspaceOwnerId: 201,
    assignedUserId: assignment.assignedUserId,
    sourceType: "manual",
    sourceId: null,
    title: "Review the appointment",
    context: null,
    dueAt: new Date("2026-09-26T12:00:00.000Z"),
    status: commitmentStatus,
  };
  const recipient = { id: 101, openId: "worker-open-id", email: "worker@example.test", role: "worker" };
  const policy = {
    id: 1,
    userId: recipient.id,
    enabled: true,
    inAppEnabled: true,
    emailEnabled: true,
    maxPerDay: 3,
    minIntervalMinutes: 0,
    quietHoursStart: "00:00",
    quietHoursEnd: "00:00",
    timezone,
    allowWeekends: true,
  };

  const makeSelect = (selection: Record<string, unknown> | undefined, inTransaction: boolean) => {
    let source: unknown;
    let cached: Promise<unknown[]> | undefined;
    const resolveRows = async () => {
      if (selection?.schedule) return [{
        schedule: { ...schedule, state: scheduleState, recipientUserId: scheduleRecipientUserId },
        commitment: { ...commitment, status: commitmentStatus },
        recipient,
      }];
      if (selection?.sentToday) {
        statsExpression = selection.sentToday;
        if (pauseStats) {
          notifyStatsReached();
          await statsBarrier;
        }
        return [{ sentToday: 0, lastSentAt: null }];
      }
      if (inTransaction && source === commitments) return [{
        workspaceOwnerId: commitment.workspaceOwnerId,
        assignedUserId: commitment.assignedUserId,
        status: commitmentStatus,
        sourceType: commitment.sourceType,
        sourceId: commitment.sourceId,
        title: commitment.title,
        context: commitment.context,
        dueAt: commitment.dueAt,
      }];
      if (inTransaction && source === reminderSchedules) return [{
        commitmentId: schedule.commitmentId,
        recipientUserId: scheduleRecipientUserId,
        state: scheduleState,
        channel: schedule.channel,
        draftTitle: schedule.draftTitle,
        draftContent: schedule.draftContent,
      }];
      if (source === reminderPolicies) return [policy];
      if (source === users) return [{
        id: recipient.id,
        openId: recipient.openId,
        email: recipient.email,
        role: "worker",
      }];
      if (source === vaProfiles) return [{ founderId: currentWorkerWorkspaceOwnerId, status: "active" }];
      return [];
    };
    const execute = () => cached ??= resolveRows();
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy"]) {
      builder[method] = (table?: unknown) => {
        if (method === "from") source = table;
        return builder;
      };
    }
    builder.limit = () => builder;
    builder.for = () => execute();
    builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject);
    return builder;
  };

  const makeExecutor = (inTransaction: boolean) => ({
    select: (selection?: Record<string, unknown>) => makeSelect(selection, inTransaction),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table === reminderSchedules && typeof values.recipientUserId === "number") {
            scheduleRecipientUserId = values.recipientUserId;
          }
          if (table === commitments && values.status) {
            commitmentStatus = String(values.status);
            return [{ affectedRows: 1 }];
          }
          if (table !== reminderSchedules || typeof values.state !== "string") return [{ affectedRows: 1 }];
          const nextState = values.state;
          const allowed = nextState === "sending"
            ? ["draft_ready", "failed"]
            : nextState === "sent" || nextState === "failed" || nextState === "needs_review" || nextState === "skipped"
              ? ["sending", "preparing"]
            : nextState === "draft_ready"
              ? ["needs_review", "draft_ready", "failed"]
              : nextState === "scheduled"
                ? ["draft_ready", "failed", "sending", "preparing"]
              : nextState === "preparing"
                  ? ["scheduled"]
                  : nextState === "cancelled"
                    ? ["scheduled", "preparing", "draft_ready", "failed", "needs_review", "escalated"]
                    : [];
          if (!allowed.includes(scheduleState)) return [{ affectedRows: 0 }];
          scheduleState = nextState;
          Object.assign(schedule, values);
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    insert: (table: unknown) => ({ values: async (values: { eventType?: string } | { eventType?: string }[]) => {
      if (table === reminderAuditEvents) {
        auditEvents.push(...(Array.isArray(values) ? values : [values]).flatMap((value) => value.eventType ? [value.eventType] : []));
      }
      return [{ affectedRows: 1, insertId: 1 }];
    } }),
  });
  const executor = makeExecutor(false);
  const db = {
    ...executor,
    transaction: async <T>(callback: (tx: ReturnType<typeof makeExecutor>) => Promise<T>) => {
      const result = await callback(makeExecutor(true));
      if (optOutAfterApproval && scheduleState === "sending") policy.emailEnabled = false;
      return result;
    },
  };

  return {
    db,
    statsReached,
    releaseStats,
    statsExpression: () => statsExpression,
    auditEvents: () => [...auditEvents],
    replaceCommitment: (values: Partial<typeof commitment>) => Object.assign(commitment, values),
    draft: () => ({ title: schedule.draftTitle, content: schedule.draftContent }),
    state: () => ({ scheduleState, scheduleRecipientUserId, commitmentStatus }),
  };
}

function makeConcurrentApprovalDb() {
  const schedules = new Map([
    [71, {
      id: 71,
      commitmentId: 81,
      recipientUserId: 101,
      channel: "email",
      state: "draft_ready",
      draftTitle: "Reminder: Review appointment A",
      draftContent: "Commitment: Review appointment A\nDue: 2026-09-26T12:00:00.000Z\nReview the commitment and record the next concrete action or close it if complete.",
      approvedAt: null as Date | null,
      sentAt: null as Date | null,
    }],
    [72, {
      id: 72,
      commitmentId: 82,
      recipientUserId: 101,
      channel: "email",
      state: "draft_ready",
      draftTitle: "Reminder: Review appointment B",
      draftContent: "Commitment: Review appointment B\nDue: 2026-09-26T13:00:00.000Z\nReview the commitment and record the next concrete action or close it if complete.",
      approvedAt: null as Date | null,
      sentAt: null as Date | null,
    }],
  ]);
  const commitmentsById = new Map([
    [81, { id: 81, workspaceOwnerId: 201, assignedUserId: 101, sourceType: "manual", sourceId: null, title: "Review appointment A", context: null, dueAt: new Date("2026-09-26T12:00:00.000Z"), status: "open" }],
    [82, { id: 82, workspaceOwnerId: 201, assignedUserId: 101, sourceType: "manual", sourceId: null, title: "Review appointment B", context: null, dueAt: new Date("2026-09-26T13:00:00.000Z"), status: "open" }],
  ]);
  const recipient = { id: 101, openId: "worker-open-id", email: "worker@example.test", role: "worker" };
  const policy = {
    id: 1,
    userId: recipient.id,
    enabled: true,
    inAppEnabled: true,
    emailEnabled: true,
    maxPerDay: 1,
    minIntervalMinutes: 0,
    quietHoursStart: "00:00",
    quietHoursEnd: "00:00",
    timezone: "UTC",
    allowWeekends: true,
  };
  let unlockedStatsReads = 0;
  let recipientLockAcquisitions = 0;
  let quotaReadsWithoutRecipientLock = 0;
  let quotaReadsInsideRecipientLock = 0;
  let releaseUnlockedStats!: () => void;
  const unlockedStatsBarrier = new Promise<void>((resolve) => { releaseUnlockedStats = resolve; });
  let recipientLockTail = Promise.resolve();

  const acquireRecipientLock = async () => {
    let release!: () => void;
    const previous = recipientLockTail;
    recipientLockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const queryParams = (query: unknown) => query
    ? new MySqlDialect().sqlToQuery(query as SQL).params
    : [];

  const makeExecutor = (inTransaction: boolean) => {
    let releaseRecipientLock: (() => void) | null = null;
    return {
      select: (selection?: Record<string, unknown>) => {
        let source: unknown;
        let whereValues: unknown[] = [];
        let cached: Promise<unknown[]> | undefined;
        const execute = async () => {
          const resolveRows = async () => {
            if (selection?.schedule) {
              const scheduleId = Number(whereValues[0]);
              const schedule = schedules.get(scheduleId);
              if (!schedule) return [];
              const commitment = commitmentsById.get(schedule.commitmentId);
              return commitment ? [{ schedule: { ...schedule }, commitment: { ...commitment }, recipient }] : [];
            }
            if (selection?.sentToday) {
              if (!inTransaction) {
                unlockedStatsReads++;
                if (unlockedStatsReads === 2) releaseUnlockedStats();
                await unlockedStatsBarrier;
              } else if (releaseRecipientLock) {
                quotaReadsInsideRecipientLock++;
              } else {
                quotaReadsWithoutRecipientLock++;
              }
              const { start, end } = zonedCalendarDayBounds(new Date(), "UTC");
              const excludedScheduleId = whereValues.length > 1 ? Number(whereValues[1]) : null;
              const rows = [...schedules.values()].filter((item) => item.recipientUserId === Number(whereValues[0])
                && item.id !== excludedScheduleId);
              const completedToday = rows.filter((item) => item.state === "sent"
                && item.sentAt && item.sentAt >= start && item.sentAt < end);
              const reservedToday = rows.filter((item) => ["sending", "needs_review"].includes(item.state)
                && item.approvedAt && item.approvedAt >= start && item.approvedAt < end);
              const lastSentAt = [...completedToday.map((item) => item.sentAt!), ...reservedToday.map((item) => item.approvedAt!)]
                .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
              return [{ sentToday: completedToday.length + reservedToday.length, lastSentAt }];
            }
            if (source === commitments) {
              const commitment = commitmentsById.get(Number(whereValues[0]));
              return commitment ? [{
                workspaceOwnerId: commitment.workspaceOwnerId,
                assignedUserId: commitment.assignedUserId,
                status: commitment.status,
                sourceType: commitment.sourceType,
                sourceId: commitment.sourceId,
                title: commitment.title,
                context: commitment.context,
                dueAt: commitment.dueAt,
              }] : [];
            }
            if (source === reminderSchedules) {
              const schedule = schedules.get(Number(whereValues[0]));
              return schedule ? [{
                commitmentId: schedule.commitmentId,
                recipientUserId: schedule.recipientUserId,
                state: schedule.state,
                channel: schedule.channel,
                draftTitle: schedule.draftTitle,
                draftContent: schedule.draftContent,
              }] : [];
            }
            if (source === reminderPolicies) return [policy];
            if (source === users) return [recipient];
            if (source === vaProfiles) return [{ founderId: 201, status: "active" }];
            return [];
          };
          return cached ??= resolveRows();
        };
        const builder: Record<string, unknown> = {};
        for (const method of ["from", "innerJoin", "where", "orderBy"]) {
          builder[method] = (value?: unknown) => {
            if (method === "from") source = value;
            if (method === "where") whereValues = queryParams(value);
            return builder;
          };
        }
        builder.limit = () => builder;
        builder.for = async () => {
          if (inTransaction && source === users && !releaseRecipientLock) {
            releaseRecipientLock = await acquireRecipientLock();
            recipientLockAcquisitions++;
          }
          return execute();
        };
        builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject);
        return builder;
      },
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async (condition: unknown) => {
            const whereValues = queryParams(condition);
            if (table === reminderSchedules && typeof values.state === "string") {
              const schedule = schedules.get(Number(whereValues[0]));
              if (!schedule) return [{ affectedRows: 0 }];
              const allowed = values.state === "sending"
                ? ["draft_ready", "failed"]
                : values.state === "sent" || values.state === "failed" || values.state === "needs_review"
                  ? ["sending"]
                  : [];
              if (!allowed.includes(schedule.state)) return [{ affectedRows: 0 }];
              Object.assign(schedule, values);
            }
            return [{ affectedRows: 1 }];
          },
        }),
      }),
      insert: (_table: unknown) => ({ values: async () => [{ affectedRows: 1, insertId: 1 }] }),
      release: () => releaseRecipientLock?.(),
    };
  };

  const executor = makeExecutor(false);
  const db = {
    ...executor,
    transaction: async <T>(callback: (tx: ReturnType<typeof makeExecutor>) => Promise<T>) => {
      const tx = makeExecutor(true);
      try {
        return await callback(tx);
      } finally {
        tx.release();
      }
    },
  };
  return {
    db,
    states: () => [...schedules.values()].map(({ id, state }) => ({ id, state })),
    lockStats: () => ({ recipientLockAcquisitions, quotaReadsWithoutRecipientLock, quotaReadsInsideRecipientLock }),
  };
}

function makeConcurrentAutomaticDeliveryDb(withInFlightReservation = false) {
  const now = new Date("2026-09-26T10:05:00.000Z");
  const initialSchedules = [
    [71, { id: 71, commitmentId: 81, ruleId: 91, recipientUserId: 101, channel: "in_app", state: "scheduled", scheduledFor: new Date(now.getTime() - 60_000), approvedAt: null as Date | null, sentAt: null as Date | null }],
    [72, { id: 72, commitmentId: 82, ruleId: 92, recipientUserId: 101, channel: "in_app", state: "scheduled", scheduledFor: new Date(now.getTime() - 60_000), approvedAt: null as Date | null, sentAt: null as Date | null }],
  ] as const;
  const schedules = new Map(withInFlightReservation
    ? [...initialSchedules, [73, { id: 73, commitmentId: 83, ruleId: 93, recipientUserId: 101, channel: "email", state: "sending", scheduledFor: new Date(now.getTime() - 120_000), approvedAt: now, sentAt: null } as const] as const]
    : initialSchedules);
  const commitmentsById = new Map([
    [81, { id: 81, workspaceOwnerId: 201, assignedUserId: 101, sourceType: "manual", sourceId: null, title: "Automatic reminder A", context: null, dueAt: new Date("2026-09-26T12:00:00.000Z"), status: "open" }],
    [82, { id: 82, workspaceOwnerId: 201, assignedUserId: 101, sourceType: "manual", sourceId: null, title: "Automatic reminder B", context: null, dueAt: new Date("2026-09-26T13:00:00.000Z"), status: "open" }],
  ]);
  const rules = new Map([
    [91, { id: 91, requireApproval: false }],
    [92, { id: 92, requireApproval: false }],
  ]);
  const recipient = { id: 101, openId: "worker-open-id", email: "worker@example.test", role: "worker" };
  const policy = {
    id: 1,
    userId: recipient.id,
    enabled: true,
    inAppEnabled: true,
    emailEnabled: true,
    maxPerDay: withInFlightReservation ? 2 : 1,
    minIntervalMinutes: 0,
    quietHoursStart: "00:00",
    quietHoursEnd: "00:00",
    timezone: "UTC",
    allowWeekends: true,
  };
  let unlockedStatsReads = 0;
  let releaseUnlockedStats!: () => void;
  const unlockedStatsBarrier = new Promise<void>((resolve) => { releaseUnlockedStats = resolve; });
  let recipientLockTail = Promise.resolve();
  let recipientLockAcquisitions = 0;
  let transactionalQuotaReads = 0;
  let notificationCount = 0;
  const auditEvents: string[] = [];

  const acquireRecipientLock = async () => {
    let release!: () => void;
    const previous = recipientLockTail;
    recipientLockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const queryParams = (query: unknown) => query
    ? new MySqlDialect().sqlToQuery(query as SQL).params
    : [];

  const makeExecutor = (inTransaction: boolean) => {
    let releaseRecipientLock: (() => void) | null = null;
    return {
      select: (selection?: Record<string, unknown>) => {
        let source: unknown;
        let joined = false;
        let whereValues: unknown[] = [];
        let cached: Promise<unknown[]> | undefined;
        const execute = async () => {
          const resolveRows = async () => {
            if (selection?.sentToday) {
              if (inTransaction) {
                transactionalQuotaReads++;
              } else {
                unlockedStatsReads++;
                if (unlockedStatsReads === 2) releaseUnlockedStats();
                await unlockedStatsBarrier;
              }
              const completed = [...schedules.values()].filter((item) => item.state === "sent");
              const reserved = [...schedules.values()].filter((item) => ["sending", "needs_review"].includes(item.state)
                && item.approvedAt && item.approvedAt >= new Date("2026-09-26T00:00:00.000Z")
                && item.approvedAt < new Date("2026-09-27T00:00:00.000Z"));
              const lastSentAt = [...completed.map((item) => item.sentAt!), ...reserved.map((item) => item.approvedAt!)]
                .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
              return [{ sentToday: completed.length + reserved.length, lastSentAt }];
            }
            if (selection?.schedule && joined) {
              const schedule = schedules.get(Number(whereValues[0]));
              if (!schedule) return [];
              const commitment = commitmentsById.get(schedule.commitmentId);
              const rule = rules.get(schedule.ruleId);
              return commitment && rule
                ? [{ schedule: { ...schedule }, commitment: { ...commitment }, rule, recipient }]
                : [];
            }
            if (selection?.id && source === reminderSchedules && joined) {
              return [...schedules.values()]
                .filter((item) => item.state === "scheduled" && item.scheduledFor <= now
                  && commitmentsById.get(item.commitmentId)?.status === "open")
                .map((item) => ({ id: item.id }));
            }
            if (source === commitments) {
              const commitment = commitmentsById.get(Number(whereValues[0]));
              return commitment ? [{
                workspaceOwnerId: commitment.workspaceOwnerId,
                assignedUserId: commitment.assignedUserId,
                status: commitment.status,
              }] : [];
            }
            if (source === reminderSchedules) {
              const schedule = schedules.get(Number(whereValues[0]));
              return schedule ? [{
                commitmentId: schedule.commitmentId,
                recipientUserId: schedule.recipientUserId,
                state: schedule.state,
              }] : [];
            }
            if (source === reminderRules) return [rules.get(Number(whereValues[0]))].filter(Boolean);
            if (source === reminderPolicies) return [policy];
            if (source === users) return [recipient];
            if (source === vaProfiles) return [{ founderId: 201, status: "active" }];
            return [];
          };
          return cached ??= resolveRows();
        };
        const builder: Record<string, unknown> = {};
        for (const method of ["from", "innerJoin", "where", "orderBy"]) {
          builder[method] = (value?: unknown) => {
            if (method === "from") source = value;
            if (method === "innerJoin") joined = true;
            if (method === "where") whereValues = queryParams(value);
            return builder;
          };
        }
        builder.limit = () => execute();
        builder.for = async () => {
          if (inTransaction && source === users && selection?.id && !releaseRecipientLock) {
            releaseRecipientLock = await acquireRecipientLock();
            recipientLockAcquisitions++;
          }
          return execute();
        };
        builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject);
        return builder;
      },
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async (condition: unknown) => {
            const id = Number(queryParams(condition)[0]);
            if (table !== reminderSchedules || typeof values.state !== "string") return [{ affectedRows: 1 }];
            const schedule = schedules.get(id);
            if (!schedule) return [{ affectedRows: 0 }];
            const allowed = values.state === "preparing"
              ? ["scheduled"]
              : ["sent", "scheduled", "skipped"].includes(values.state)
                ? ["preparing"]
                : [];
            if (!allowed.includes(schedule.state)) return [{ affectedRows: 0 }];
            Object.assign(schedule, values);
            return [{ affectedRows: 1 }];
          },
        }),
      }),
      insert: (table: unknown) => ({ values: async (values: { eventType?: string } | { eventType?: string }[]) => {
        if (table === notificationHistory) notificationCount += Array.isArray(values) ? values.length : 1;
        if (table === reminderAuditEvents) {
          auditEvents.push(...(Array.isArray(values) ? values : [values]).flatMap((value) => value.eventType ? [value.eventType] : []));
        }
        return [{ affectedRows: 1, insertId: 1 }];
      } }),
      release: () => releaseRecipientLock?.(),
    };
  };

  const executor = makeExecutor(false);
  const db = {
    ...executor,
    transaction: async <T>(callback: (tx: ReturnType<typeof makeExecutor>) => Promise<T>) => {
      const tx = makeExecutor(true);
      try {
        return await callback(tx);
      } finally {
        tx.release();
      }
    },
  };
  return {
    db,
    now,
    schedules: () => [...schedules.values()].map(({ id, state }) => ({ id, state })),
    metrics: () => ({ unlockedStatsReads, transactionalQuotaReads, recipientLockAcquisitions, notificationCount, auditEvents }),
  };
}

describe("scheduled reminder delivery boundary", () => {
  it("only recovers stale in-flight reminders for open commitments", async () => {
    const updates: Array<{ values: Record<string, unknown>; sql: string; params: unknown[] }> = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async (condition: SQL) => {
            const query = new MySqlDialect().sqlToQuery(condition);
            updates.push({ values, sql: query.sql, params: query.params });
            return [{ affectedRows: 1 }];
          },
        }),
      }),
      select: (selection: Record<string, unknown>) => {
        let source: SQLWrapper;
        let filter: SQL;
        const builder: Record<string, unknown> = {};
        builder.from = (table: SQLWrapper) => { source = table; return builder; };
        builder.where = (condition: SQL) => { filter = condition; return builder; };
        builder.getSQL = () => sql`select ${selection.id as SQLWrapper} from ${source} where ${filter}`;
        return builder;
      },
    };
    controls.getDb.mockResolvedValue(db);

    const recovered = await recoverInterruptedReminders(new Date("2026-09-26T12:00:00.000Z"));

    expect(recovered).toBe(2);
    expect(updates).toHaveLength(2);
    expect(updates[0].values).toMatchObject({ state: "cancelled" });
    expect(updates[0].sql).toContain("commitmentId");
    expect(updates[0].params).toEqual(expect.arrayContaining(["completed", "cancelled", "preparing", "sending"]));
    expect(updates[1].values).toMatchObject({ state: "needs_review" });
    expect(updates[1].sql).toContain("commitmentId");
    expect(updates[1].params).toEqual(expect.arrayContaining(["open", "preparing", "sending"]));
  });

  it("does not deliver after the commitment is closed following the claim", async () => {
    let scheduleState = "scheduled";
    let commitmentStatus = "open";
    const insertedTables: unknown[] = [];
    let releaseStats!: () => void;
    let notifyStatsReached!: () => void;
  const statsReached = new Promise<void>((resolve) => { notifyStatsReached = resolve; });
  const statsBarrier = new Promise<void>((resolve) => { releaseStats = resolve; });

    const schedule = {
      id: 71,
      commitmentId: 81,
      ruleId: 91,
      recipientUserId: 101,
      channel: "in_app",
      state: "scheduled",
      scheduledFor: new Date("2026-09-26T10:00:00.000Z"),
      attemptCount: 0,
      draftTitle: null,
      draftContent: null,
    };
    const commitment = {
      id: 81,
      workspaceOwnerId: 201,
      assignedUserId: 101,
      sourceType: "manual",
      sourceId: null,
      title: "Review the appointment",
      context: null,
      dueAt: new Date("2026-09-26T12:00:00.000Z"),
      status: "open",
    };
    const rule = { id: 91, requireApproval: false };
    const recipient = { id: 101, openId: "worker-open-id", email: "worker@example.test", role: "worker" };
    const policy = {
      id: 1,
      userId: recipient.id,
      enabled: true,
      inAppEnabled: true,
      emailEnabled: false,
      maxPerDay: 3,
      minIntervalMinutes: 60,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      timezone: "UTC",
      allowWeekends: true,
    };

    const makeSelect = (selection: Record<string, unknown> | undefined, inTransaction: boolean) => {
      let source: unknown;
      let isJoined = false;
      let cached: Promise<unknown[]> | undefined;
      const resolveRows = async () => {
      if (selection?.sentToday) {
          notifyStatsReached();
          await statsBarrier;
          return [{ sentToday: 0, lastSentAt: null }];
        }
        if (selection?.schedule) {
          return [{
            schedule: { ...schedule, state: scheduleState },
            commitment: { ...commitment, status: commitmentStatus },
            rule,
            recipient,
          }];
        }
        if (inTransaction && source === commitments) return [{
          status: commitmentStatus,
          workspaceOwnerId: commitment.workspaceOwnerId,
          assignedUserId: commitment.assignedUserId,
        }];
        if (inTransaction && source === reminderSchedules) return [{
          state: scheduleState,
          commitmentId: schedule.commitmentId,
          recipientUserId: schedule.recipientUserId,
        }];
        if (source === reminderPolicies) return [policy];
        if (source === users) return [recipient];
        if (source === vaProfiles) return [{ founderId: 201, status: "active" }];
        if (source === reminderSchedules && isJoined) return [{ id: schedule.id }];
        return [];
      };
      const execute = () => cached ??= resolveRows();
      const builder: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "orderBy"]) {
        builder[method] = (table?: unknown) => {
          if (method === "from") source = table;
          if (method === "innerJoin") isJoined = true;
          return builder;
        };
      }
      builder.limit = () => execute();
      builder.for = () => execute();
      builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject);
      return builder;
    };

    const makeExecutor = (inTransaction: boolean) => ({
      select: (selection?: Record<string, unknown>) => makeSelect(selection, inTransaction),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            let affected = 1;
            if (table === reminderSchedules && values.state === "preparing") {
              if (scheduleState === "scheduled") scheduleState = "preparing";
              else affected = 0;
            }
            if (table === reminderSchedules && values.state === "sending") {
              if (scheduleState === "draft_ready" || scheduleState === "failed") scheduleState = "sending";
              else affected = 0;
            }
            if (table === reminderSchedules && values.state === "cancelled") {
              if (scheduleState !== "sending") scheduleState = "cancelled";
              else affected = 0;
            }
            if (table === reminderSchedules && values.state === "sent") {
              if (scheduleState === "preparing" || scheduleState === "sending") scheduleState = "sent";
              else affected = 0;
            }
            if (table === reminderSchedules && values.state === "draft_ready") {
              if (scheduleState === "needs_review") scheduleState = "draft_ready";
              else affected = 0;
            }
            if (table === reminderSchedules && values.state === "needs_review") {
              if (scheduleState === "draft_ready" || scheduleState === "failed" || scheduleState === "sending") scheduleState = "needs_review";
              else affected = 0;
            }
            if (table === reminderSchedules && values.state === "failed") {
              if (scheduleState === "sending") scheduleState = "failed";
              else affected = 0;
            }
            if (table === commitments && values.status) commitmentStatus = String(values.status);
            return [{ affectedRows: affected }];
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: async () => {
          insertedTables.push(table);
          return [{ affectedRows: 1, insertId: 1 }];
        },
      }),
    });

    const executor = makeExecutor(false);
    const db = {
      ...executor,
      transaction: async <T>(callback: (tx: ReturnType<typeof makeExecutor>) => Promise<T>) => callback(makeExecutor(true)),
    };
    controls.getDb.mockResolvedValue(db);

    const processing = processDueReminders(new Date("2026-09-26T10:05:00.000Z"));
    await statsReached;
    expect(scheduleState).toBe("preparing");

    await closeCommitment({ id: 201, openId: "admin-open-id", role: "admin", email: null }, commitment.id, "completed");
    expect(commitmentStatus).toBe("completed");
    expect(scheduleState).toBe("cancelled");

    releaseStats();
    const result = await processing;

    expect(result.sent).toBe(0);
    expect(scheduleState).toBe("cancelled");
    expect(insertedTables).not.toContain(notificationHistory);
    expect(insertedTables).toContain(reminderAuditEvents);
  });

  it("does not send a draft if commitment closure wins before approval is claimed", async () => {
    const fixture = makeApprovalDb();
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await closeCommitment(owner, 81, "completed");
    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow("Commitment is closed");
    expect(fixture.state()).toEqual({
      scheduleState: "cancelled",
      scheduleRecipientUserId: 101,
      commitmentStatus: "completed",
    });
    expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
  });

  it("refreshes a stale prepared message and requires a new approval", async () => {
    const fixture = makeApprovalDb();
    fixture.replaceCommitment({ title: "Updated source-backed commitment", context: "The requested action changed." });
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow(/updated.*review.*approve again/i);

    expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    expect(fixture.state().scheduleState).toBe("draft_ready");
    expect(fixture.draft()).toMatchObject({ title: "Reminder: Updated source-backed commitment" });
    expect(fixture.draft().content).toContain("The requested action changed.");
    expect(fixture.auditEvents()).toContain("reminder_draft_refreshed");
  });

  it("sends once when two requests approve the same schedule concurrently", async () => {
    const fixture = makeApprovalDb();
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    const results = await Promise.allSettled([
      approveAndSendReminder(owner, 71),
      approveAndSendReminder(owner, 71),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(controls.sendEmailWithOutcome).toHaveBeenCalledOnce();
    expect(fixture.state().scheduleState).toBe("sent");
  });

  it("serializes quota claims for two schedules assigned to the same recipient", async () => {
    const fixture = makeConcurrentApprovalDb();
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    const results = await Promise.allSettled([
      approveAndSendReminder(owner, 71),
      approveAndSendReminder(owner, 72),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/daily reminder limit reached/i);
    expect(controls.sendEmailWithOutcome).toHaveBeenCalledOnce();
    expect(fixture.states().filter((schedule) => schedule.state === "sent")).toHaveLength(1);
    expect(fixture.lockStats()).toEqual({
      recipientLockAcquisitions: 3,
      quotaReadsWithoutRecipientLock: 0,
      quotaReadsInsideRecipientLock: 3,
    });
  });

  it("rechecks the quota under the recipient lock before automatic in-app delivery", async () => {
    const fixture = makeConcurrentAutomaticDeliveryDb();
    controls.getDb.mockResolvedValue(fixture.db);

    await Promise.all([
      processDueReminders(fixture.now, 2),
      processDueReminders(fixture.now, 2),
    ]);

    expect(fixture.schedules().filter((schedule) => schedule.state === "sent")).toHaveLength(1);
    expect(fixture.schedules().filter((schedule) => schedule.state === "scheduled")).toHaveLength(1);
    expect(fixture.metrics()).toMatchObject({
      unlockedStatsReads: 2,
      transactionalQuotaReads: 2,
      recipientLockAcquisitions: 2,
      notificationCount: 1,
    });
  });

  it("counts an in-flight approved reminder while reserving automatic in-app quota", async () => {
    const fixture = makeConcurrentAutomaticDeliveryDb(true);
    controls.getDb.mockResolvedValue(fixture.db);

    await Promise.all([
      processDueReminders(fixture.now, 2),
      processDueReminders(fixture.now, 2),
    ]);

    expect(fixture.schedules().filter((schedule) => schedule.state === "sent")).toHaveLength(1);
    expect(fixture.schedules().filter((schedule) => schedule.state === "scheduled")).toHaveLength(1);
    expect(fixture.schedules().filter((schedule) => schedule.state === "sending")).toHaveLength(1);
    expect(fixture.metrics()).toMatchObject({
      transactionalQuotaReads: 2,
      recipientLockAcquisitions: 2,
      notificationCount: 1,
    });
  });

  it("returns a stale schedule to the current assignee without sending", async () => {
    const fixture = makeApprovalDb(false, 201, { assignedUserId: 202, recipientUserId: 101 });
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow(/assignment changed/i);

    expect(fixture.state()).toMatchObject({ scheduleState: "scheduled", scheduleRecipientUserId: 202 });
    expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
  });

  it("does not let a worker approve a reminder from a previous workspace", async () => {
    const fixture = makeApprovalDb(false, 999);
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const worker = { id: 101, openId: "worker-open-id", role: "worker" as const, email: "worker@example.test" };

    await expect(approveAndSendReminder(worker, 71)).rejects.toThrow("current workspace");

    expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    expect(fixture.state().scheduleState).toBe("draft_ready");
  });

  it("does not let a reassigned worker close a commitment in the former workspace", async () => {
    const fixture = makeApprovalDb(false, 999);
    controls.getDb.mockResolvedValue(fixture.db);
    const worker = { id: 101, openId: "worker-open-id", role: "worker" as const, email: "worker@example.test" };

    await expect(closeCommitment(worker, 81, "completed")).rejects.toThrow("not found or not accessible");

    expect(fixture.state()).toEqual({
      scheduleState: "draft_ready",
      scheduleRecipientUserId: 101,
      commitmentStatus: "open",
    });
  });

  it("records a known non-send as failed, not as uncertain delivery", async () => {
    const fixture = makeApprovalDb();
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({
      status: "not_sent",
      reason: "Email notifications are disabled; no email was sent.",
    });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow(/was not sent/i);

    expect(fixture.state().scheduleState).toBe("failed");
    expect(fixture.auditEvents()).toContain("reminder_delivery_not_sent");
    expect(fixture.auditEvents()).not.toContain("reminder_delivery_uncertain");
  });

  it("immediately records a rejected provider-readiness lookup as not sent", async () => {
    const fixture = makeApprovalDb();
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockRejectedValue(new Error("mock readiness lookup failure"));
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow(/was not sent/i);

    expect(fixture.state().scheduleState).toBe("failed");
    expect(fixture.auditEvents()).toContain("reminder_delivery_not_sent");
    expect(fixture.auditEvents()).not.toContain("reminder_delivery_uncertain");
  });

  it("keeps provider delivery uncertainty in review and does not retry it automatically", async () => {
    const fixture = makeApprovalDb();
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({
      status: "uncertain",
      reason: "The provider did not confirm delivery. Verify the destination before authorizing a retry.",
    });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow(/did not confirm delivery/i);
    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow(/needs_review/i);

    expect(fixture.state().scheduleState).toBe("needs_review");
    expect(controls.sendEmailWithOutcome).toHaveBeenCalledOnce();
  });

  it("honors an email opt-out that lands after approval but before provider delivery", async () => {
    const fixture = makeApprovalDb(false, 201, { assignedUserId: 101, recipientUserId: 101 }, "UTC", true);
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await expect(approveAndSendReminder(owner, 71)).rejects.toThrow(/email reminders are disabled/i);

    expect(controls.sendEmailWithOutcome).not.toHaveBeenCalled();
    expect(fixture.state().scheduleState).toBe("skipped");
    expect(fixture.auditEvents()).toContain("reminder_skipped");
  });

  it("counts sent reminders within the recipient's local calendar day", async () => {
    const fixture = makeApprovalDb(false, 201, { assignedUserId: 101, recipientUserId: 101 }, "Europe/Amsterdam");
    controls.getDb.mockResolvedValue(fixture.db);
    controls.sendEmailWithOutcome.mockReset();
    controls.sendEmailWithOutcome.mockResolvedValue({ status: "sent" });
    const owner = { id: 201, openId: "owner-open-id", role: "admin" as const, email: null };

    await approveAndSendReminder(owner, 71);

    const query = new MySqlDialect().sqlToQuery(fixture.statsExpression() as SQL);
    const expectedBounds = zonedCalendarDayBounds(new Date(), "Europe/Amsterdam");
    expect(query.params).toContainEqual(expectedBounds.start);
    expect(query.params).toContainEqual(expectedBounds.end);
    expect(query.sql).toContain("sentAt");
  });

  it("uses 23-hour and 25-hour local days across Amsterdam DST changes", () => {
    const spring = zonedCalendarDayBounds(new Date("2026-03-29T12:00:00.000Z"), "Europe/Amsterdam");
    expect(spring.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");

    const autumn = zonedCalendarDayBounds(new Date("2026-10-25T12:00:00.000Z"), "Europe/Amsterdam");
    expect(autumn.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(autumn.end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});
