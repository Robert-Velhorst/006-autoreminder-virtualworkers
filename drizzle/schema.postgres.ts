import { sql } from "drizzle-orm";
import {
  integer,
  bigint,
  text,
  timestamp,
  varchar,
  numeric,
  jsonb,
  unique,
  boolean,
  date,
  uniqueIndex,
  index,
  foreignKey,
  pgEnum,
  pgTable,
  customType,
  check,
} from "drizzle-orm/pg-core";

const sessionEpochType = customType<{ data: string; driverData: string }>({
  dataType: () => "bigint",
  fromDriver: value => String(value),
  toDriver: value => {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) {
      throw new Error("Invalid session epoch");
    }
    return value;
  },
});

export const pgEnumType01 = pgEnum("enum_role_1pxhzfx", [
  "user",
  "admin",
  "worker",
]);
export const pgEnumType02 = pgEnum("enum_status_wan32x", [
  "active",
  "inactive",
  "on_leave",
]);
export const pgEnumType03 = pgEnum("enum_status_1lxmq9j", [
  "assigned",
  "in_progress",
  "completed",
  "blocked",
]);
export const pgEnumType04 = pgEnum("enum_dependencytype_skc5j1", [
  "finish_to_start",
  "start_to_start",
  "finish_to_finish",
]);
export const pgEnumType05 = pgEnum("enum_priority_ft1gbc", [
  "normal",
  "high",
  "urgent",
  "drop_everything",
]);
export const pgEnumType06 = pgEnum("enum_priority_1c7376r", [
  "standard",
  "priority",
  "vip",
]);
export const pgEnumType07 = pgEnum("enum_messagetype_a9il17", [
  "question",
  "decision",
  "update",
  "handoff",
  "feedback",
]);
export const pgEnumType08 = pgEnum("enum_briefingtype_1wphl0a", [
  "morning",
  "end_of_day",
  "weekly",
]);
export const pgEnumType09 = pgEnum("enum_status_1xo8rhz", [
  "pending_review",
  "approved",
  "needs_revision",
  "rejected",
]);
export const pgEnumType10 = pgEnum("enum_source_1xgs10d", ["trello", "upwork"]);
export const pgEnumType11 = pgEnum("enum_status_mga0dt", ["pending","replied","overdue","inactive"]);
export const pgEnumType12 = pgEnum("enum_resolvedby_2vjpz9", [
  "manual",
  "auto_demerit",
]);
export const pgEnumType13 = pgEnum("enum_category_1fxje1r", [
  "financial",
  "non_financial",
]);
export const pgEnumType14 = pgEnum("enum_status_pz903i", [
  "pending",
  "processed",
  "archived",
]);
export const pgEnumType15 = pgEnum("enum_extractionstatus_13v80fg", [
  "pending",
  "processing",
  "success",
  "failed",
  "unreadable",
]);
export const pgEnumType16 = pgEnum("enum_complexity_1emaez6", [
  "simple",
  "medium",
  "complex",
]);
export const pgEnumType17 = pgEnum("enum_status_ylcf2g", [
  "pending",
  "processing",
  "complete",
  "needs_review",
  "insufficient_info",
]);
export const pgEnumType18 = pgEnum("enum_jobtype_1p9mw8f", [
  "full_sync",
  "incremental",
  "workspace",
  "board",
  "card",
]);
export const pgEnumType19 = pgEnum("enum_status_1vi2wdv", [
  "pending",
  "running",
  "completed",
  "failed",
]);
export const pgEnumType20 = pgEnum("enum_notificationmode_1rzjyge", [
  "disabled",
  "daily_digest",
  "priority_only",
]);
export const pgEnumType21 = pgEnum("enum_notificationtype_1qmsts8", [
  "task_assigned",
  "task_due_soon",
  "task_overdue",
  "task_completed",
  "daily_digest",
  "general",
]);
export const pgEnumType22 = pgEnum("enum_channel_fc1yc1", [
  "in_app",
  "email",
  "both",
]);
export const pgEnumType23 = pgEnum("enum_deliverystatus_n7og9t", [
  "pending",
  "sent",
  "failed",
  "queued_for_digest",
]);
export const pgEnumType24 = pgEnum("enum_status_rxw27b", [
  "pending",
  "processing",
  "completed",
  "failed",
]);
export const pgEnumType25 = pgEnum("enum_modeltype_qwfz3m", [
  "board",
  "workspace",
]);
export const pgEnumType26 = pgEnum("enum_responsestatus_1lkx6am", [
  "success",
  "failed",
  "pending",
]);
export const pgEnumType27 = pgEnum("enum_status_1j54ed2", [
  "active",
  "completed",
  "abandoned",
]);
export const pgEnumType28 = pgEnum("enum_source_vprdy3", [
  "manual",
  "auto",
  "batch",
  "conflict_resolution",
]);
export const pgEnumType29 = pgEnum("enum_operationtype_1lr73l9", [
  "re_analyze",
  "reschedule",
  "conflict_resolution",
  "optimization",
]);
export const pgEnumType30 = pgEnum("enum_status_1e6d5fs", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const pgEnumType31 = pgEnum("enum_status_1klf81u", [
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);
export const pgEnumType32 = pgEnum("enum_dependencytype_qhpsqg", [
  "sequential",
  "parallel",
  "blocking",
]);
export const pgEnumType33 = pgEnum("enum_category_xotgg8", [
  "technical",
  "resource",
  "schedule",
  "external",
]);
export const pgEnumType34 = pgEnum("enum_status_1cnaoyu", [
  "identified",
  "mitigated",
  "resolved",
]);
export const pgEnumType35 = pgEnum("enum_resourcetype_1bg4zoy", [
  "skill",
  "tool",
  "training",
]);
export const pgEnumType36 = pgEnum("enum_proficiencylevel_1i56otg", [
  "beginner",
  "intermediate",
  "expert",
]);
export const pgEnumType37 = pgEnum("enum_status_645ovh", [
  "pending",
  "completed",
]);
export const pgEnumType38 = pgEnum("enum_dependencytype_1ilpice", [
  "approval",
  "third_party",
  "regulatory",
]);
export const pgEnumType39 = pgEnum("enum_status_1sgdzt3", [
  "pending",
  "in_progress",
  "completed",
  "failed",
]);
export const pgEnumType40 = pgEnum("enum_generatedby_6s09xv", ["manual", "ai"]);
export const pgEnumType41 = pgEnum("enum_validationstatus_1quvsg1", [
  "initial",
  "validated",
  "needs_review",
  "quality_check_failed",
]);
export const pgEnumType42 = pgEnum("enum_status_1pmifyk", [
  "completed",
  "in-progress",
  "ready",
  "blocked",
]);
export const pgEnumType43 = pgEnum("enum_previousstatus_1pmifyk", [
  "completed",
  "in-progress",
  "ready",
  "blocked",
]);
export const pgEnumType44 = pgEnum("enum_newstatus_1pmifyk", [
  "completed",
  "in-progress",
  "ready",
  "blocked",
]);
export const pgEnumType45 = pgEnum("enum_strictnesslevel_13d2lgi", [
  "lenient",
  "moderate",
  "strict",
]);
export const pgEnumType46 = pgEnum("enum_ruletype_z6tdsy", [
  "vagueness",
  "measurability",
  "timeline",
  "resources",
  "dependencies",
  "clarity",
  "specificity",
  "actionability",
]);
export const pgEnumType47 = pgEnum("enum_severity_bigbib", [
  "info",
  "warning",
  "error",
]);
export const pgEnumType48 = pgEnum("enum_verdict_1ifswsr", [
  "accurate",
  "partial",
  "inaccurate",
]);
export const pgEnumType49 = pgEnum("enum_source_1ur3rkb", [
  "gmail",
  "google_drive",
  "trello",
  "communication",
]);
export const pgEnumType50 = pgEnum("enum_reviewstatus_dfhow7", [
  "unreviewed",
  "linked",
  "not_work_related",
]);
export const pgEnumType51 = pgEnum("enum_linkmethod_99towq", [
  "automatic",
  "manual",
]);
export const pgEnumType52 = pgEnum("enum_truthclass_1k1o5b2", [
  "source_record",
  "worker_assertion",
  "system_inference",
]);
export const pgEnumType53 = pgEnum("enum_subjecttype_68ocx8", [
  "card",
  "worker",
  "decision",
  "plan_block",
]);
export const pgEnumType54 = pgEnum("enum_linkmethod_1x6q4zj", [
  "automatic",
  "manual",
  "confirmed",
]);
export const pgEnumType55 = pgEnum("enum_status_6k7llh", [
  "needs_verification",
  "consistent",
  "resolved",
  "dismissed",
]);
export const pgEnumType56 = pgEnum("enum_status_2xlhsx", [
  "open",
  "resolved",
  "superseded",
]);
export const pgEnumType57 = pgEnum("enum_direction_1abj3f9", [
  "inbound",
  "outbound",
  "system",
  "unknown",
]);
export const pgEnumType58 = pgEnum("enum_kind_jsifmk", [
  "message_response",
  "email_processing",
]);
export const pgEnumType59 = pgEnum("enum_outcome_t8n47e", [
  "verified",
  "missed",
  "needs_clarification",
  "excluded",
]);
export const pgEnumType60 = pgEnum("enum_resolution_ldseu8", [
  "completed",
  "not_completed",
  "not_required",
]);
export const pgEnumType61 = pgEnum("enum_status_1qvzp7l", [
  "open",
  "needs_review",
  "locked",
]);
export const pgEnumType62 = pgEnum("enum_severity_11yyky0", [
  "low",
  "medium",
  "high",
]);
export const pgEnumType63 = pgEnum("enum_status_1ngf43y", [
  "open",
  "resolved",
  "dismissed",
  "superseded",
]);
export const pgEnumType64 = pgEnum("enum_trigger_1qyerme", [
  "cron",
  "external",
  "manual",
]);
export const pgEnumType65 = pgEnum("enum_status_17mmv7l", [
  "running",
  "success",
  "error",
  "abandoned",
]);

const longtext = text;
const enumTypeHash = (values: readonly string[]) => {
  let hash = 2166136261;
  for (const character of values.join("\0")) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0).toString(36);
};
const enumText = <
  TName extends string,
  const T extends readonly [string, ...string[]],
>(
  name: TName,
  values: T
) =>
  pgEnum(
    `enum_${name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}_${enumTypeHash(values)}`,
    values
  )(name);

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = pgTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  /** Unique identifier — for local auth this is the username/email, kept as openId for compatibility. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: enumText("role", ["user", "admin", "worker"]).default("user").notNull(),
  /** bcrypt hash of the user's password (local auth only) */
  passwordHash: varchar("passwordHash", { length: 255 }),
  sessionEpoch: sessionEpochType("sessionEpoch").notNull().default(sql`1`),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
}, table => [check("users_session_epoch_nonnegative", sql`${table.sessionEpoch} >= 0`)]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const workerLifecycleAudit = pgTable("worker_lifecycle_audit", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  actorUserId: integer("actorUserId").notNull(),
  userId: integer("userId").notNull(),
  workerProfileId: integer("workerProfileId").notNull(),
  founderId: integer("founderId").notNull(),
  action: varchar("action", { length: 32 }).notNull(),
  previousStatus: varchar("previousStatus", { length: 20 }),
  nextStatus: varchar("nextStatus", { length: 20 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("worker_lifecycle_user_created_idx").on(table.userId, table.createdAt),
  index("worker_lifecycle_actor_created_idx").on(table.actorUserId, table.createdAt),
]);

// Generation history tables
export const generationJobs = pgTable("generation_jobs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  totalCards: integer("totalCards").notNull(),
  completedCards: integer("completedCards").notNull().default(0),
  failedCards: integer("failedCards").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull(),
  settings: text("settings"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  createdBy: varchar("createdBy", { length: 64 }).notNull(),
});

export const generationItems = pgTable("generation_items", {
  id: varchar("id", { length: 64 }).primaryKey(),
  jobId: varchar("jobId", { length: 64 }).notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: text("cardName").notNull(),
  boardName: varchar("boardName", { length: 255 }),
  status: varchar("status", { length: 20 }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull().default(3),
  error: text("error"),
  result: text("result"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export type GenerationJob = typeof generationJobs.$inferSelect;
export type InsertGenerationJob = typeof generationJobs.$inferInsert;
export type GenerationItem = typeof generationItems.$inferSelect;
export type InsertGenerationItem = typeof generationItems.$inferInsert;

// Scheduled jobs table
export const scheduledJobs = pgTable("scheduled_jobs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  cardIds: text("cardIds").notNull(), // JSON string array
  scheduledTime: timestamp("scheduledTime").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, running, completed, failed, cancelled
  settings: text("settings").notNull(), // JSON string
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  error: text("error"),
  createdBy: varchar("createdBy", { length: 64 }).notNull(),
});

export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type InsertScheduledJob = typeof scheduledJobs.$inferInsert;

// User working hours settings table
export const userWorkingHours = pgTable("user_working_hours", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  userId: integer("userId").notNull(), // References users.id
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(), // References users.openId for easier lookup
  workStartHour: integer("workStartHour").notNull().default(9), // 0-23
  workStartMinute: integer("workStartMinute").notNull().default(0), // 0-59
  workEndHour: integer("workEndHour").notNull().default(18), // 0-23
  workEndMinute: integer("workEndMinute").notNull().default(0), // 0-59
  breakfastTime: varchar("breakfastTime", { length: 5 }).default("09:00"), // HH:MM format
  breakfastDuration: integer("breakfastDuration").notNull().default(45), // minutes
  lunchTime: varchar("lunchTime", { length: 5 }).default("15:00"), // HH:MM format
  lunchDuration: integer("lunchDuration").notNull().default(45), // minutes
  dinnerTime: varchar("dinnerTime", { length: 5 }).default("20:00"), // HH:MM format
  dinnerDuration: integer("dinnerDuration").notNull().default(120), // minutes
  enableBreaks: integer("enableBreaks").notNull().default(1), // Keep the legacy 0/1 representation used by application code.
  shortBreakInterval: integer("shortBreakInterval").notNull().default(120), // minutes of work before short break
  shortBreakDuration: integer("shortBreakDuration").notNull().default(10), // minutes
  longBreakInterval: integer("longBreakInterval").notNull().default(240), // minutes of work before long break
  longBreakDuration: integer("longBreakDuration").notNull().default(30), // minutes
  // Working days configuration
  workingDays: varchar("workingDays", { length: 50 })
    .notNull()
    .default("1,2,3,4,5"), // Comma-separated: 0=Sun, 1=Mon, ..., 6=Sat
  // Timezone support
  timezone: varchar("timezone", { length: 50 }).notNull().default("UTC"), // IANA timezone (e.g., 'America/New_York', 'Europe/Amsterdam')
  // Weekly hours target (for scheduling optimization)
  weeklyHoursMin: integer("weeklyHoursMin").notNull().default(40), // Minimum target hours per week
  weeklyHoursMax: integer("weeklyHoursMax").notNull().default(45), // Maximum target hours per week
  // Daily hours flexibility (allows scheduling to vary day-to-day)
  dailyHoursMin: numeric("dailyHoursMin", { precision: 4, scale: 2 })
    .notNull()
    .default("8.00"), // Minimum hours per day (e.g., 9.5)
  dailyHoursMax: numeric("dailyHoursMax", { precision: 4, scale: 2 })
    .notNull()
    .default("9.00"), // Maximum hours per day (e.g., 11.5)
  // Holiday integration
  country: varchar("country", { length: 2 }).notNull().default("US"), // ISO 3166-1 alpha-2 country code for holidays
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export type UserWorkingHours = typeof userWorkingHours.$inferSelect;
export type InsertUserWorkingHours = typeof userWorkingHours.$inferInsert;

// Holidays table for country-specific holidays
export const holidays = pgTable("holidays", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 255 }).notNull(),
  date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD format
  name: varchar("name", { length: 255 }).notNull(),
  country: varchar("country", { length: 2 }).notNull(), // ISO 3166-1 alpha-2 country code
  isActive: integer("isActive").notNull().default(1), // 0=disabled, 1=enabled
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Holiday = typeof holidays.$inferSelect;
export type InsertHoliday = typeof holidays.$inferInsert;

// Trello data cache tables
export const trelloCacheMetadata = pgTable("trello_cache_metadata", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),
  cacheKey: varchar("cacheKey", { length: 255 }).notNull(), // e.g., 'boards', 'tasks', 'cards:{boardId}'
  lastFetched: timestamp("lastFetched").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  ttlSeconds: integer("ttlSeconds").notNull().default(300), // 5 minutes default
  hitCount: integer("hitCount").notNull().default(0),
  missCount: integer("missCount").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export const trelloCachedTasks = pgTable('trello_cached_tasks', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  userId: integer('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  taskData: text('taskData').notNull(), // JSON serialized schedule response
  cachedAt: timestamp('cachedAt').defaultNow().notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
});

export const trelloCachedBoards = pgTable("trello_cached_boards", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),
  boardId: varchar("boardId", { length: 64 }).notNull(),
  boardData: text("boardData").notNull(), // JSON serialized board data
  cachedAt: timestamp("cachedAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
});

export const trelloCachedCards = pgTable('trello_cached_cards', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  userId: integer('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  boardId: varchar('boardId', { length: 64 }).notNull(),
  cardId: varchar('cardId', { length: 64 }).notNull(),
  cardData: text('cardData').notNull(), // JSON serialized card data
  cachedAt: timestamp('cachedAt').defaultNow().notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
}, (table) => [index('trello_cached_cards_user_card_cached_idx').on(table.userId, table.cardId, table.cachedAt)]);

export type TrelloCacheMetadata = typeof trelloCacheMetadata.$inferSelect;
export type InsertTrelloCacheMetadata = typeof trelloCacheMetadata.$inferInsert;
export type TrelloCachedTask = typeof trelloCachedTasks.$inferSelect;
export type InsertTrelloCachedTask = typeof trelloCachedTasks.$inferInsert;
export type TrelloCachedBoard = typeof trelloCachedBoards.$inferSelect;
export type InsertTrelloCachedBoard = typeof trelloCachedBoards.$inferInsert;
export type TrelloCachedCard = typeof trelloCachedCards.$inferSelect;
export type InsertTrelloCachedCard = typeof trelloCachedCards.$inferInsert;

// ============================================
// VA MANAGEMENT TABLES
// ============================================

// Virtual Worker profiles (formerly Virtual Assistant)
export const vaProfiles = pgTable("va_profiles", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("userId").notNull(), // References users.id (the VA's user account)
  founderId: integer("founderId").notNull(), // References users.id (the founder who manages this VA)
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }),
  timezone: varchar("timezone", { length: 50 })
    .notNull()
    .default("Asia/Manila"), // Default to Philippines
  skills: text("skills"), // JSON array of skills
  hourlyRate: integer("hourlyRate"), // In cents
  currency: varchar("currency", { length: 3 }).default("USD"),
  workStartHour: integer("workStartHour").notNull().default(9),
  workEndHour: integer("workEndHour").notNull().default(18),
  workingDays: varchar("workingDays", { length: 50 })
    .notNull()
    .default("1,2,3,4,5"),
  // Meal times (stored as hour in 24h format, e.g., 12 = 12:00 PM)
  breakfastTime: integer("breakfastTime"), // Optional breakfast break
  breakfastDuration: integer("breakfastDuration").default(0), // In minutes
  lunchTime: integer("lunchTime").default(12), // Default 12:00 PM
  lunchDuration: integer("lunchDuration").default(60), // Default 1 hour
  dinnerTime: integer("dinnerTime"), // Optional dinner break
  dinnerDuration: integer("dinnerDuration").default(0), // In minutes
  status: enumText("status", ["active", "inactive", "on_leave"])
    .default("active")
    .notNull(),
  trelloMemberId: varchar("trelloMemberId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Task assignments linking tasks to VAs
export const taskAssignments = pgTable("task_assignments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  taskId: varchar("taskId", { length: 128 }).notNull(), // Composite: cardId:checklistId:checkItemId
  vaId: integer("vaId").notNull(), // References vaProfiles.id
  founderId: integer("founderId").notNull(), // References users.id
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  startTime: timestamp("startTime"),
  endTime: timestamp("endTime"),
  assignedBy: integer("assignedBy").notNull(), // References users.id (who assigned)
  status: enumText("status", [
    "assigned",
    "in_progress",
    "completed",
    "blocked",
  ])
    .default("assigned")
    .notNull(),
  notes: text("notes"),
  handoffNotes: text("handoffNotes"),
  lastWorkedAt: timestamp("lastWorkedAt"),
  decisionLog: text("decisionLog"), // JSON array of decisions
  externalLinks: text("externalLinks"), // JSON array of external links
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
}, table => [
  unique("task_assignments_founder_task_unique").on(table.founderId, table.taskId),
]);

export const assignmentEvents = pgTable("assignment_events", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  assignmentId: integer("assignmentId").notNull().references(() => taskAssignments.id, { onDelete: "restrict" }),
  founderId: integer("founderId").notNull(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  actorUserId: integer("actorUserId").notNull().references(() => users.id, { onDelete: "restrict" }),
  kind: varchar("kind", { length: 32 }).notNull(),
  previousWorkerProfileId: integer("previousWorkerProfileId"),
  nextWorkerProfileId: integer("nextWorkerProfileId").notNull(),
  previousStatus: varchar("previousStatus", { length: 20 }),
  nextStatus: varchar("nextStatus", { length: 20 }).notNull(),
  beforeJson: jsonb("beforeJson").$type<Record<string, unknown> | null>(),
  afterJson: jsonb("afterJson").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  index("assignment_events_assignment_created_idx").on(table.assignmentId, table.createdAt),
  index("assignment_events_founder_task_idx").on(table.founderId, table.taskId),
  check("assignment_events_kind_check", sql`${table.kind} IN ('created', 'reassigned', 'status_changed', 'notes_changed')`),
]);

// Shift schedules for handoffs
export const shiftSchedules = pgTable("shift_schedules", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  vaId: integer("vaId").notNull(),
  founderId: integer("founderId").notNull(),
  dayOfWeek: integer("dayOfWeek").notNull(), // 0 = Sunday, 1 = Monday, etc.
  shiftStart: varchar("shiftStart", { length: 5 }).notNull(), // "09:00"
  shiftEnd: varchar("shiftEnd", { length: 5 }).notNull(), // "17:00"
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Task dependencies
export const taskDependencies = pgTable("task_dependencies", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  taskId: varchar("taskId", { length: 128 }).notNull(), // The task that is blocked
  blockedByTaskId: varchar("blockedByTaskId", { length: 128 }).notNull(), // The task that blocks it
  founderId: integer("founderId").notNull(),
  dependencyType: enumText("dependencyType", [
    "finish_to_start",
    "start_to_start",
    "finish_to_finish",
  ])
    .default("finish_to_start")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Founder priority overrides
export const founderPriorityOverrides = pgTable("founder_priority_overrides", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  founderId: integer("founderId").notNull(),
  priority: enumText("priority", [
    "normal",
    "high",
    "urgent",
    "drop_everything",
  ])
    .default("normal")
    .notNull(),
  reason: text("reason"),
  expiresAt: timestamp("expiresAt"), // Optional expiry for temporary priorities
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Client/Project context
export const clients = pgTable("clients", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  founderId: integer("founderId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  priority: enumText("priority", ["standard", "priority", "vip"])
    .default("standard")
    .notNull(),
  trelloBoardIds: text("trelloBoardIds"), // JSON array of associated board IDs
  contactEmail: varchar("contactEmail", { length: 320 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Communication/Decision log
export const communicationLog = pgTable("communication_log", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  taskId: varchar("taskId", { length: 128 }),
  fromUserId: integer("fromUserId").notNull(), // VA or Founder
  toUserId: integer("toUserId"), // Can be null for general notes
  messageType: enumText("messageType", [
    "question",
    "decision",
    "update",
    "handoff",
    "feedback",
  ]).notNull(),
  message: text("message").notNull(),
  context: text("context"), // JSON with task context
  isRead: integer("isRead").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Daily briefings
export const dailyBriefings = pgTable("daily_briefings", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  vaId: integer("vaId").notNull(),
  founderId: integer("founderId").notNull(),
  briefingDate: varchar("briefingDate", { length: 10 }).notNull(), // YYYY-MM-DD
  briefingType: enumText("briefingType", [
    "morning",
    "end_of_day",
    "weekly",
  ]).notNull(),
  content: text("content").notNull(), // JSON with briefing data
  sentAt: timestamp("sentAt"),
  sentTo: varchar("sentTo", { length: 320 }), // Email address
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Quality checkpoints / Review queue
export const reviewQueue = pgTable("review_queue", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  vaId: integer("vaId").notNull(),
  founderId: integer("founderId").notNull(),
  status: enumText("status", [
    "pending_review",
    "approved",
    "needs_revision",
    "rejected",
  ])
    .default("pending_review")
    .notNull(),
  submittedAt: timestamp("submittedAt").defaultNow().notNull(),
  reviewedAt: timestamp("reviewedAt"),
  feedback: text("feedback"),
  revisionCount: integer("revisionCount").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Time tracking entries
export const timeEntries = pgTable('time_entries', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  trackedUserId: integer('trackedUserId').references(() => users.id, { onDelete: 'restrict' }),
  trackedProfileId: integer('trackedProfileId').references(() => vaProfiles.id, { onDelete: 'restrict' }),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  vaId: integer('vaId'), // Immutable legacy provenance; new timers leave this null.
  founderId: integer('founderId').notNull(),
  cardId: varchar('cardId', { length: 64 }),
  cardName: varchar('cardName', { length: 512 }),
  cardUrl: varchar('cardUrl', { length: 1024 }),
  boardName: varchar('boardName', { length: 256 }).default('Unknown Board'),
  listName: varchar('listName', { length: 256 }).default('Unknown'),
  startTime: timestamp('startTime').notNull(),
  endTime: timestamp('endTime'),
  durationMinutes: integer('durationMinutes'),
  durationSeconds: integer('durationSeconds'),
  notes: text('notes'),
  source: varchar('source', { length: 32 }).notNull().default('legacy'),
  category: varchar('category', { length: 32 }).notNull().default('client_work'),
  planDateKey: varchar('planDateKey', { length: 16 }),
  planBlockId: varchar('planBlockId', { length: 128 }),
  aptlssStepId: integer('aptlssStepId'),
  isVoided: boolean('isVoided').notNull().default(false),
  voidedAt: timestamp('voidedAt'),
  voidReason: text('voidReason'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex('time_entries_one_active_account_idx').on(table.trackedUserId)
    .where(sql`${table.endTime} IS NULL AND ${table.isVoided} = false`),
  index('time_entries_account_period_idx').on(table.trackedUserId, table.startTime),
  index('time_entries_period_idx').on(table.startTime, table.endTime),
  index('va_time_entries_period_idx').on(table.vaId, table.startTime, table.endTime),
  index('time_entries_plan_block_idx').on(table.planDateKey, table.planBlockId),
  index('time_entries_step_idx').on(table.aptlssStepId),
]);

// Payment cycles — each 2-week pay period per founder
export const paymentCycles = pgTable("payment_cycles", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  founderId: integer("founderId").notNull(),
  cycleStart: date("cycleStart", { mode: "date" }).notNull(),
  cycleEnd: date("cycleEnd", { mode: "date" }).notNull(),
  baseAmount: numeric("baseAmount", { precision: 8, scale: 2 })
    .notNull()
    .default("90.00"),
  isPaid: boolean("isPaid").notNull().default(false),
  paidAt: timestamp("paidAt"),
  paidBy: varchar("paidBy", { length: 64 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Weekly merit/demerit log per worker
export const weeklyPayLog = pgTable("weekly_pay_log", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  founderId: integer("founderId").notNull(),
  weekStart: date("weekStart", { mode: "date" }).notNull(),
  weekEnd: date("weekEnd", { mode: "date" }).notNull(),
  paymentCycleId: integer("paymentCycleId"),
  baseAmount: numeric("baseAmount", { precision: 8, scale: 2 })
    .notNull()
    .default("90.00"),
  meritM1: numeric("meritM1", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  meritM2: numeric("meritM2", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  meritM3: numeric("meritM3", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  meritStreak: numeric("meritStreak", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD1: numeric("demeritD1", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD2: numeric("demeritD2", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD3: numeric("demeritD3", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD4: numeric("demeritD4", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD5: numeric("demeritD5", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD6: numeric("demeritD6", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD7: numeric("demeritD7", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD8: numeric("demeritD8", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD9: numeric("demeritD9", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD10: numeric("demeritD10", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  demeritD11: numeric("demeritD11", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  totalMerits: numeric("totalMerits", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  totalDemerits: numeric("totalDemerits", { precision: 8, scale: 2 })
    .notNull()
    .default("0.00"),
  projectedPay: numeric("projectedPay", { precision: 8, scale: 2 })
    .notNull()
    .default("90.00"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Daily triage state per worker
export const dailyTriageState = pgTable(
  "daily_triage_state",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    triageDate: date("triageDate", { mode: "date" }).notNull(),
    step1Done: boolean("step1Done").notNull().default(false),
    step2Done: boolean("step2Done").notNull().default(false),
    step3Done: boolean("step3Done").notNull().default(false),
    step4Done: boolean("step4Done").notNull().default(false),
    step5Done: boolean("step5Done").notNull().default(false),
    focusTasks: text("focusTasks"),
    eveningStep1Done: boolean("eveningStep1Done").notNull().default(false),
    eveningStep2Done: boolean("eveningStep2Done").notNull().default(false),
    eveningStep3Done: boolean("eveningStep3Done").notNull().default(false),
    eveningStep4Done: boolean("eveningStep4Done").notNull().default(false),
    eodReport: text("eodReport"),
    currentView: varchar("currentView", { length: 32 })
      .notNull()
      .default("overview"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [uniqueIndex("va_triage_date_idx").on(table.vaId, table.triageDate)]
);

// Sunday checklist state per worker
export const sundayChecklist = pgTable(
  "sunday_checklist",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    sundayDate: date("sundayDate", { mode: "date" }).notNull(),
    trelloArchived: boolean("trelloArchived").notNull().default(false),
    trelloLabels: boolean("trelloLabels").notNull().default(false),
    trelloDeadlines: boolean("trelloDeadlines").notNull().default(false),
    trelloTimers: boolean("trelloTimers").notNull().default(false),
    emailInbox: boolean("emailInbox").notNull().default(false),
    whatsappCleared: boolean("whatsappCleared").notNull().default(false),
    upworkArchived: boolean("upworkArchived").notNull().default(false),
    downloadsCleared: boolean("downloadsCleared").notNull().default(false),
    desktopCleared: boolean("desktopCleared").notNull().default(false),
    browserTabsClosed: boolean("browserTabsClosed").notNull().default(false),
    weekReviewed: boolean("weekReviewed").notNull().default(false),
    nextWeekPlanned: boolean("nextWeekPlanned").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [uniqueIndex("va_sunday_date_idx").on(table.vaId, table.sundayDate)]
);

// Tracks daily due date assignment per worker
export const dailyDueDateAssignments = pgTable(
  "daily_due_date_assignments",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull(),
    cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
    date: date("date", { mode: "date" }).notNull(),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("va_due_date_assign_idx").on(
      table.vaId,
      table.cardId,
      table.date
    ),
  ]
);

// Tracks daily Trello card update per worker
export const dailyCardUpdates = pgTable(
  "daily_card_updates",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull(),
    cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
    date: date("date", { mode: "date" }).notNull(),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("va_card_update_idx").on(table.vaId, table.cardId, table.date),
  ]
);

// Tracks ON-HOLD checks per worker
export const onHoldDailyChecks = pgTable(
  "on_hold_daily_checks",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull(),
    cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
    date: date("date", { mode: "date" }).notNull(),
    checked: boolean("checked").notNull().default(false),
    checkedAt: timestamp("checkedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("va_on_hold_check_idx").on(
      table.vaId,
      table.cardId,
      table.date
    ),
  ]
);

// Tracks update streaks per worker
export const dailyUpdateStreak = pgTable(
  "daily_update_streak",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    streakDate: date("streakDate", { mode: "date" }).notNull(),
    completedBeforeDeadline: boolean("completedBeforeDeadline")
      .notNull()
      .default(false),
    completedAt: timestamp("completedAt"),
    doingCardCount: integer("doingCardCount").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("va_streak_date_idx").on(table.vaId, table.streakDate)]
);

// App settings per worker (or global if vaId is null)
export const appSettings = pgTable("app_settings", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId"),
  key: varchar("key", { length: 128 }).notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Daily compliance snapshot per worker
export const dailyComplianceSnapshots = pgTable(
  "daily_compliance_snapshots",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    founderId: integer("founderId").notNull(),
    snapshotDate: date("snapshotDate", { mode: "date" }).notNull(),
    onHoldTotal: integer("onHoldTotal").notNull().default(0),
    onHoldReviewed: integer("onHoldReviewed").notNull().default(0),
    onHoldMissedCards: text("onHoldMissedCards"),
    doingTotal: integer("doingTotal").notNull().default(0),
    doingUpdated: integer("doingUpdated").notNull().default(0),
    doingMissedCards: text("doingMissedCards"),
    messageTotal: integer("messageTotal").notNull().default(0),
    messageReplied: integer("messageReplied").notNull().default(0),
    messageMissed: integer("messageMissed").notNull().default(0),
    messageNeedsClarification: integer("messageNeedsClarification")
      .notNull()
      .default(0),
    emailTotal: integer("emailTotal").notNull().default(0),
    emailCompleted: integer("emailCompleted").notNull().default(0),
    emailMissed: integer("emailMissed").notNull().default(0),
    emailNeedsClarification: integer("emailNeedsClarification")
      .notNull()
      .default(0),
    clarificationOpen: integer("clarificationOpen").notNull().default(0),
    trackedSeconds: integer("trackedSeconds").notNull().default(0),
    scheduledTargetSeconds: integer("scheduledTargetSeconds")
      .notNull()
      .default(0),
    overtimeSeconds: integer("overtimeSeconds").notNull().default(0),
    timeEntryCount: integer("timeEntryCount").notNull().default(0),
    d1Instances: integer("d1Instances").notNull().default(0),
    estimatedPenalty: numeric("estimatedPenalty", { precision: 8, scale: 2 })
      .notNull()
      .default("0.00"),
    source: varchar("source", { length: 16 }).notNull().default("auto"),
    weeklyPayLogId: integer("weeklyPayLogId"),
    required: boolean("required").notNull().default(true),
    verificationStatus: varchar("verificationStatus", { length: 24 })
      .notNull()
      .default("unverified"),
    verificationMethod: varchar("verificationMethod", { length: 255 }),
    verificationCutoffAt: timestamp("verificationCutoffAt"),
    verifiedAt: timestamp("verifiedAt"),
    evidenceCount: integer("evidenceCount").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex("va_compliance_snapshot_idx").on(
      table.vaId,
      table.snapshotDate
    ),
  ]
);

// Tracks Trello comment threads per worker
export const replyThreads = pgTable("reply_threads", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  source: enumText("source", ["trello", "upwork"]).notNull().default("trello"),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  boardName: varchar("boardName", { length: 256 }).notNull().default(""),
  listName: varchar("listName", { length: 256 }).notNull().default(""),
  lastNonWorkerMsgAt: timestamp("lastNonWorkerMsgAt").notNull(),
  lastNonWorkerAuthor: varchar("lastNonWorkerAuthor", { length: 256 }).notNull().default(""),
  lastNonWorkerText: text("lastNonWorkerText"),
  lastWorkerReplyAt: timestamp("lastWorkerReplyAt"),
  status: pgEnumType11("status").notNull().default("pending"),
  demerited: boolean("demerited").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex('va_reply_thread_idx').on(table.vaId, table.cardId, table.source)
]);

// Tracks vague replies per worker
export const vagueReplyFlags = pgTable("vague_reply_flags", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  source: enumText("source", ["trello", "upwork"]).notNull().default("trello"),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  actionId: varchar("actionId", { length: 64 }).notNull().unique(),
  messageText: text("messageText").notNull(),
  flaggedAt: timestamp("flaggedAt").notNull(),
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: enumText("resolvedBy", ["manual", "auto_demerit"]),
  demeritIssued: boolean("demeritIssued").notNull().default(false),
  demeritIssuedAt: timestamp("demeritIssuedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Tracks unsigned messages per worker
export const unsignedMessageFlags = pgTable("unsigned_message_flags", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  source: enumText("source", ["trello", "upwork"]).notNull().default("trello"),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  actionId: varchar("actionId", { length: 64 }).notNull().unique(),
  messageText: text("messageText").notNull(),
  flaggedAt: timestamp("flaggedAt").notNull(),
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: enumText("resolvedBy", ["manual", "auto_demerit"]),
  resolutionNote: text("resolutionNote"),
  demeritIssued: boolean("demeritIssued").notNull().default(false),
  demeritIssuedAt: timestamp("demeritIssuedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Gmail email tasks per worker
export const emailTasks = pgTable("email_tasks", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  gmailMessageId: varchar("gmailMessageId", { length: 128 }).notNull().unique(),
  gmailThreadId: varchar("gmailThreadId", { length: 128 }).notNull(),
  subject: varchar("subject", { length: 1024 }).notNull().default("(no subject)"),
  fromAddress: varchar("fromAddress", { length: 320 }).notNull().default(""),
  fromName: varchar("fromName", { length: 256 }).notNull().default(""),
  snippet: text("snippet"),
  receivedAt: timestamp("receivedAt").notNull(),
  category: enumText("category", ["financial", "non_financial"]).notNull().default("non_financial"),
  status: enumText("status", ["pending", "processed", "archived"]).notNull().default("pending"),
  deadlineAt: timestamp("deadlineAt"),
  trelloCardId: varchar("trelloCardId", { length: 64 }),
  trelloCardName: varchar("trelloCardName", { length: 512 }),
  trelloCardUrl: varchar("trelloCardUrl", { length: 1024 }),
  suggestedNextAction: text("suggestedNextAction"),
  llmSummary: text("llmSummary"),
  processedAt: timestamp("processedAt"),
  archivedAt: timestamp("archivedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  index("email_tasks_va_status_received_idx").on(table.vaId, table.status, table.receivedAt),
  index("email_tasks_va_trello_card_idx").on(table.vaId, table.trelloCardId),
]);

// Card snoozes per worker
export const cardSnoozes = pgTable("card_snoozes", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  snoozedAt: timestamp("snoozedAt").defaultNow().notNull(),
  snoozedUntil: date("snoozedUntil", { mode: "date" }).notNull(),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Handoff notes
export const handoffNotes = pgTable("handoff_notes", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  fromVaId: integer("fromVaId").notNull(),
  toVaId: integer("toVaId"),
  founderId: integer("founderId").notNull(),
  whereLeftOff: text("whereLeftOff").notNull(),
  nextSteps: text("nextSteps"),
  blockers: text("blockers"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Export types
export type VAProfile = typeof vaProfiles.$inferSelect;
export type InsertVAProfile = typeof vaProfiles.$inferInsert;
export type TaskAssignment = typeof taskAssignments.$inferSelect;
export type InsertTaskAssignment = typeof taskAssignments.$inferInsert;
export type TaskDependency = typeof taskDependencies.$inferSelect;
export type InsertTaskDependency = typeof taskDependencies.$inferInsert;
export type FounderPriorityOverride =
  typeof founderPriorityOverrides.$inferSelect;
export type InsertFounderPriorityOverride =
  typeof founderPriorityOverrides.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type InsertClient = typeof clients.$inferInsert;
export type CommunicationLogEntry = typeof communicationLog.$inferSelect;
export type InsertCommunicationLogEntry = typeof communicationLog.$inferInsert;
export type DailyBriefing = typeof dailyBriefings.$inferSelect;
export type InsertDailyBriefing = typeof dailyBriefings.$inferInsert;
export type ReviewQueueItem = typeof reviewQueue.$inferSelect;
export type InsertReviewQueueItem = typeof reviewQueue.$inferInsert;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type InsertTimeEntry = typeof timeEntries.$inferInsert;
export type HandoffNote = typeof handoffNotes.$inferSelect;
export type InsertHandoffNote = typeof handoffNotes.$inferInsert;
export type PaymentCycle = typeof paymentCycles.$inferSelect;
export type WeeklyPayLog = typeof weeklyPayLog.$inferSelect;
export type DailyTriageState = typeof dailyTriageState.$inferSelect;
export type SundayChecklist = typeof sundayChecklist.$inferSelect;
export type DailyDueDateAssignment =
  typeof dailyDueDateAssignments.$inferSelect;
export type DailyCardUpdate = typeof dailyCardUpdates.$inferSelect;
export type OnHoldDailyCheck = typeof onHoldDailyChecks.$inferSelect;
export type DailyUpdateStreak = typeof dailyUpdateStreak.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type DailyComplianceSnapshot =
  typeof dailyComplianceSnapshots.$inferSelect;
export type ReplyThread = typeof replyThreads.$inferSelect;
export type InsertReplyThread = typeof replyThreads.$inferInsert;
export type VagueReplyFlag = typeof vagueReplyFlags.$inferSelect;
export type InsertVagueReplyFlag = typeof vagueReplyFlags.$inferInsert;
export type EmailTask = typeof emailTasks.$inferSelect;
export type InsertEmailTask = typeof emailTasks.$inferInsert;
export type CardSnooze = typeof cardSnoozes.$inferSelect;

// ============================================
// ATIS (Adaptive Task Intelligence System) TABLES
// Knowledge-first design for accurate task breakdowns
// ============================================

// Trello workspaces (organizations)
export const atisWorkspaces = pgTable("atis_workspaces", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  trelloId: varchar("trelloId", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  displayName: varchar("displayName", { length: 255 }),
  url: varchar("url", { length: 512 }),
  boardCount: integer("boardCount").default(0),
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Trello boards
export const atisBoards = pgTable("atis_boards", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  trelloId: varchar("trelloId", { length: 64 }).notNull().unique(),
  workspaceId: integer("workspaceId"), // References atisWorkspaces.id (nullable for personal boards)
  workspaceTrelloId: varchar("workspaceTrelloId", { length: 64 }),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 512 }),
  isOpen: integer("isOpen").default(1), // 1=open, 0=closed
  cardCount: integer("cardCount").default(0),
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Trello cards with full data
export const atisCards = pgTable("atis_cards", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  trelloId: varchar("trelloId", { length: 64 }).notNull().unique(),
  boardId: integer("boardId").notNull(), // References atisBoards.id
  boardTrelloId: varchar("boardTrelloId", { length: 64 }).notNull(),
  listName: varchar("listName", { length: 255 }),
  listId: varchar("listId", { length: 64 }),
  name: varchar("name", { length: 512 }).notNull(),
  description: text("description"),
  url: varchar("url", { length: 512 }),
  dueDate: timestamp("dueDate"),
  dueComplete: integer("dueComplete").default(0),
  isArchived: integer("isArchived").default(0),
  isClosed: integer("isClosed").default(0),
  labels: text("labels"), // JSON array of labels
  memberIds: text("memberIds"), // JSON array of assigned member IDs
  checklistCount: integer("checklistCount").default(0),
  attachmentCount: integer("attachmentCount").default(0),
  commentCount: integer("commentCount").default(0),
  rawData: text("rawData"), // Full JSON from Trello API
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Attachments with extracted content
export const atisAttachments = pgTable("atis_attachments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  trelloId: varchar("trelloId", { length: 64 }).notNull(),
  cardId: integer("cardId").notNull(), // References atisCards.id
  cardTrelloId: varchar("cardTrelloId", { length: 64 }).notNull(),
  filename: varchar("filename", { length: 512 }),
  mimeType: varchar("mimeType", { length: 128 }),
  fileType: varchar("fileType", { length: 32 }), // pdf, docx, xlsx, image, link, email, other
  url: varchar("url", { length: 1024 }),
  bytes: integer("bytes"),
  // Extraction status and content
  extractionStatus: enumText("extractionStatus", [
    "pending",
    "processing",
    "success",
    "failed",
    "unreadable",
  ])
    .default("pending")
    .notNull(),
  extractedContent: text("extractedContent"), // Extracted text/description
  extractionError: text("extractionError"),
  extractedAt: timestamp("extractedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Comments from Trello cards
export const atisComments = pgTable("atis_comments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  trelloId: varchar("trelloId", { length: 64 }).notNull(),
  cardId: integer("cardId").notNull(), // References atisCards.id
  cardTrelloId: varchar("cardTrelloId", { length: 64 }).notNull(),
  authorId: varchar("authorId", { length: 64 }),
  authorName: varchar("authorName", { length: 255 }),
  text: text("text").notNull(),
  commentDate: timestamp("commentDate"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// AI-generated understanding of each card
export const atisCardUnderstanding = pgTable("atis_card_understanding", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  cardId: integer("cardId").notNull().unique(), // References atisCards.id
  cardTrelloId: varchar("cardTrelloId", { length: 64 }).notNull().unique(),
  // Core understanding
  goal: text("goal"), // What is this card trying to achieve?
  deliverable: text("deliverable"), // What tangible output marks completion?
  taskType: varchar("taskType", { length: 64 }), // communication, research, creation, meeting, review, admin, etc.
  // Extracted entities
  entities: text("entities"), // JSON: {people: [], organizations: [], cases: [], systems: [], documents: []}
  // Timing
  deadlines: text("deadlines"), // JSON: [{date, source, description}]
  estimatedMinutes: integer("estimatedMinutes"),
  // Dependencies and relationships
  dependencies: text("dependencies"), // JSON: What must happen before this?
  produces: text("produces"), // JSON: What does completing this enable?
  // Classification
  domain: varchar("domain", { length: 128 }), // Area of work
  complexity: enumText("complexity", ["simple", "medium", "complex"]).default(
    "medium"
  ),
  // Quality assessment
  clarityScore: integer("clarityScore"), // 1-10, how clear is what needs to be done?
  missingInfo: text("missingInfo"), // What's unclear or would help to know?
  confidenceScore: integer("confidenceScore"), // 1-100, AI confidence in understanding
  // APTLSS Checklist - AI-generated steps to complete the task
  aptlssChecklist: text("aptlssChecklist"), // JSON array of checklist items
  // Status
  status: enumText("status", [
    "pending",
    "processing",
    "complete",
    "needs_review",
    "insufficient_info",
  ])
    .default("pending")
    .notNull(),
  generatedAt: timestamp("generatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Ingestion job tracking
export const atisIngestionJobs = pgTable("atis_ingestion_jobs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  jobType: enumText("jobType", [
    "full_sync",
    "incremental",
    "workspace",
    "board",
    "card",
  ]).notNull(),
  status: enumText("status", ["pending", "running", "completed", "failed"])
    .default("pending")
    .notNull(),
  targetId: varchar("targetId", { length: 64 }), // Trello ID of target (workspace, board, or card)
  totalItems: integer("totalItems").default(0),
  processedItems: integer("processedItems").default(0),
  failedItems: integer("failedItems").default(0),
  errorLog: text("errorLog"), // JSON array of errors
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Export ATIS types
export type ATISWorkspace = typeof atisWorkspaces.$inferSelect;
export type InsertATISWorkspace = typeof atisWorkspaces.$inferInsert;
export type ATISBoard = typeof atisBoards.$inferSelect;
export type InsertATISBoard = typeof atisBoards.$inferInsert;
export type ATISCard = typeof atisCards.$inferSelect;
export type InsertATISCard = typeof atisCards.$inferInsert;
export type ATISAttachment = typeof atisAttachments.$inferSelect;
export type InsertATISAttachment = typeof atisAttachments.$inferInsert;
export type ATISComment = typeof atisComments.$inferSelect;
export type InsertATISComment = typeof atisComments.$inferInsert;
export type ATISCardUnderstanding = typeof atisCardUnderstanding.$inferSelect;
export type InsertATISCardUnderstanding =
  typeof atisCardUnderstanding.$inferInsert;
export type ATISIngestionJob = typeof atisIngestionJobs.$inferSelect;
export type InsertATISIngestionJob = typeof atisIngestionJobs.$inferInsert;

// User notification preferences
export const userNotificationPreferences = pgTable(
  "user_notification_preferences",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("userId").notNull(),
    userOpenId: varchar("userOpenId", { length: 64 }).notNull().unique(),

    // Notification mode: 'disabled' | 'daily_digest' | 'priority_only'
    notificationMode: enumText("notificationMode", [
      "disabled",
      "daily_digest",
      "priority_only",
    ])
      .default("priority_only")
      .notNull(),

    // Daily digest settings
    digestTime: varchar("digestTime", { length: 5 }).default("08:00").notNull(), // HH:MM format
    digestTimezone: varchar("digestTimezone", { length: 50 })
      .default("Europe/Amsterdam")
      .notNull(),

    // Priority only settings - what counts as "urgent"
    urgentThresholdHours: integer("urgentThresholdHours").default(24).notNull(), // Tasks due within X hours are urgent

    // Email notification settings
    emailEnabled: integer("emailEnabled").default(1).notNull(), // 0=false, 1=true
    emailAddress: varchar("emailAddress", { length: 320 }),

    // In-app notification settings
    inAppEnabled: integer("inAppEnabled").default(1).notNull(),

    // Last digest sent timestamp
    lastDigestSent: timestamp("lastDigestSent"),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  }
);

export type UserNotificationPreferences =
  typeof userNotificationPreferences.$inferSelect;
export type InsertUserNotificationPreferences =
  typeof userNotificationPreferences.$inferInsert;

// Notification history for tracking sent notifications
export const notificationHistory = pgTable("notification_history", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

  // Notification details
  title: varchar("title", { length: 500 }).notNull(),
  content: text("content").notNull(),
  notificationType: enumText("notificationType", [
    "task_assigned",
    "task_due_soon",
    "task_overdue",
    "task_completed",
    "daily_digest",
    "general",
  ]).notNull(),

  // Related task info (optional)
  taskId: varchar("taskId", { length: 128 }),
  taskName: varchar("taskName", { length: 500 }),
  dueDate: timestamp("dueDate"),

  // Delivery status
  channel: enumText("channel", ["in_app", "email", "both"]).notNull(),
  deliveryStatus: enumText("deliveryStatus", [
    "pending",
    "sent",
    "failed",
    "queued_for_digest",
  ])
    .default("pending")
    .notNull(),
  deliveredAt: timestamp("deliveredAt"),

  // Read status for in-app notifications
  isRead: integer("isRead").default(0).notNull(), // 0=unread, 1=read
  readAt: timestamp("readAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type NotificationHistory = typeof notificationHistory.$inferSelect;
export type InsertNotificationHistory = typeof notificationHistory.$inferInsert;

// Digest job tracking
export const digestJobs = pgTable("digest_jobs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),
  scheduledFor: timestamp("scheduledFor").notNull(),
  status: enumText("status", ["pending", "processing", "completed", "failed"])
    .default("pending")
    .notNull(),
  notificationCount: integer("notificationCount").default(0).notNull(),
  error: text("error"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  windowKey: varchar("windowKey", { length: 96 }),
  deliveryPhase: varchar("deliveryPhase", { length: 24 }),
  recipientEmail: text("recipientEmail"),
  subject: text("subject"),
  html: text("html"),
  payloadHash: varchar("payloadHash", { length: 64 }),
  attemptId: varchar("attemptId", { length: 64 }),
  attemptCount: integer("attemptCount").default(0).notNull(),
  attemptedAt: timestamp("attemptedAt"),
  nextAttemptAt: timestamp("nextAttemptAt"),
  providerReceipt: text("providerReceipt"),
  reconciledAt: timestamp("reconciledAt"),
  reconciledBy: integer("reconciledBy"),
  reconciliationNote: text("reconciliationNote"),
}, table => [uniqueIndex("digest_jobs_window_key_unique").on(table.windowKey)]);

export const digestJobItems = pgTable("digest_job_items", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  jobId: integer("jobId").notNull().references(() => digestJobs.id, { onDelete: "restrict" }),
  notificationId: integer("notificationId").notNull().references(() => notificationHistory.id, { onDelete: "restrict" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("digest_job_items_notification_unique").on(table.notificationId),
  index("digest_job_items_job_idx").on(table.jobId),
]);

export type DigestJob = typeof digestJobs.$inferSelect;
export type InsertDigestJob = typeof digestJobs.$inferInsert;

// ============================================
// TRELLO CHATBOT TABLES
// ============================================

// Registered webhooks for chatbot
export const chatbotWebhooks = pgTable("chatbot_webhooks", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  trelloWebhookId: varchar("trelloWebhookId", { length: 64 })
    .notNull()
    .unique(),
  modelId: varchar("modelId", { length: 64 }).notNull(), // Board or workspace ID
  modelType: enumText("modelType", ["board", "workspace"])
    .default("board")
    .notNull(),
  description: varchar("description", { length: 255 }),
  callbackUrl: varchar("callbackUrl", { length: 512 }).notNull(),
  isActive: integer("isActive").default(1).notNull(), // 0=inactive, 1=active
  lastEventAt: timestamp("lastEventAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Chatbot conversation history
export const chatbotConversations = pgTable("chatbot_conversations", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  cardTrelloId: varchar("cardTrelloId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 500 }),
  boardTrelloId: varchar("boardTrelloId", { length: 64 }),

  // Command details
  command: varchar("command", { length: 50 }).notNull(), // status, checkin, remind, etc.
  commandArgs: text("commandArgs"), // JSON array of arguments

  // Author info
  authorTrelloId: varchar("authorTrelloId", { length: 64 }),
  authorName: varchar("authorName", { length: 255 }),

  // Comment IDs
  incomingCommentId: varchar("incomingCommentId", { length: 64 }),
  responseCommentId: varchar("responseCommentId", { length: 64 }),

  // Response details
  responseText: text("responseText"),
  responseStatus: enumText("responseStatus", ["success", "failed", "pending"])
    .default("pending")
    .notNull(),
  responseError: text("responseError"),

  // Timing
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  respondedAt: timestamp("respondedAt"),
  responseTimeMs: integer("responseTimeMs"), // How long it took to respond

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Worker check-in responses (when workers reply to bot check-ins)
export const chatbotCheckinResponses = pgTable("chatbot_checkin_responses", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  conversationId: integer("conversationId").notNull(), // References chatbotConversations.id
  cardTrelloId: varchar("cardTrelloId", { length: 64 }).notNull(),

  // Worker info
  workerTrelloId: varchar("workerTrelloId", { length: 64 }),
  workerName: varchar("workerName", { length: 255 }),
  workerId: integer("workerId"), // References vaProfiles.id if matched

  // Response content
  responseCommentId: varchar("responseCommentId", { length: 64 }),
  responseText: text("responseText"),

  // Parsed response data
  reportedProgress: text("reportedProgress"), // What they said they accomplished
  reportedBlockers: text("reportedBlockers"), // Any blockers mentioned
  estimatedCompletion: varchar("estimatedCompletion", { length: 100 }), // ETA if provided

  // Timing
  checkinSentAt: timestamp("checkinSentAt").notNull(),
  responseReceivedAt: timestamp("responseReceivedAt").notNull(),
  responseTimeMinutes: integer("responseTimeMinutes"), // How long worker took to respond

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Chatbot analytics aggregates (daily rollups)
export const chatbotAnalytics = pgTable("chatbot_analytics", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  date: timestamp("date").notNull(),

  // Command counts
  totalCommands: integer("totalCommands").default(0).notNull(),
  statusCommands: integer("statusCommands").default(0).notNull(),
  checkinCommands: integer("checkinCommands").default(0).notNull(),
  remindCommands: integer("remindCommands").default(0).notNull(),
  timeCommands: integer("timeCommands").default(0).notNull(),
  progressCommands: integer("progressCommands").default(0).notNull(),
  helpCommands: integer("helpCommands").default(0).notNull(),
  unknownCommands: integer("unknownCommands").default(0).notNull(),

  // Response metrics
  successfulResponses: integer("successfulResponses").default(0).notNull(),
  failedResponses: integer("failedResponses").default(0).notNull(),
  avgResponseTimeMs: integer("avgResponseTimeMs"),

  // Check-in metrics
  checkinsSent: integer("checkinsSent").default(0).notNull(),
  checkinsResponded: integer("checkinsResponded").default(0).notNull(),
  avgCheckinResponseMinutes: integer("avgCheckinResponseMinutes"),

  // Worker engagement
  uniqueWorkers: integer("uniqueWorkers").default(0).notNull(),
  uniqueCards: integer("uniqueCards").default(0).notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export type ChatbotWebhook = typeof chatbotWebhooks.$inferSelect;
export type InsertChatbotWebhook = typeof chatbotWebhooks.$inferInsert;
export type ChatbotConversation = typeof chatbotConversations.$inferSelect;
export type InsertChatbotConversation =
  typeof chatbotConversations.$inferInsert;
export type ChatbotCheckinResponse =
  typeof chatbotCheckinResponses.$inferSelect;
export type InsertChatbotCheckinResponse =
  typeof chatbotCheckinResponses.$inferInsert;
export type ChatbotAnalytics = typeof chatbotAnalytics.$inferSelect;
export type InsertChatbotAnalytics = typeof chatbotAnalytics.$inferInsert;

// Interview System Tables (ATIS Phases 1-10)
export const interviewSessions = pgTable("interview_sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

  // Interview state
  status: enumText("status", ["active", "completed", "abandoned"])
    .notNull()
    .default("active"),
  currentPhase: integer("currentPhase").notNull().default(1), // ATIS phases 1-10
  currentQuestion: integer("currentQuestion").notNull().default(0),

  // Pre-analysis results
  preAnalysisSummary: text("preAnalysisSummary"),

  // Interview progress
  questionsAsked: integer("questionsAsked").notNull().default(0),
  responsesProvided: integer("responsesProvided").notNull().default(0),
  overallConfidence: integer("overallConfidence").notNull().default(0), // 0-100

  // Session data (JSON)
  sessionData: text("sessionData"), // JSON serialized interview state

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
  completedAt: timestamp("completedAt"),
});

export const interviewHistory = pgTable("interview_history", {
  id: varchar("id", { length: 64 }).primaryKey(),
  sessionId: varchar("sessionId", { length: 64 }).notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

  // Question and response
  phase: integer("phase").notNull(), // Which ATIS phase
  questionNumber: integer("questionNumber").notNull(),
  question: text("question").notNull(),
  response: text("response").notNull(),

  // Validation results
  isValid: integer("isValid").notNull(), // 0=false, 1=true
  validationScore: integer("validationScore").notNull().default(0), // 0-100
  validationNotes: text("validationNotes"),

  // Confidence tracking
  confidenceScore: integer("confidenceScore").notNull().default(0), // 0-100
  requiresEscalation: integer("requiresEscalation").notNull().default(0), // 0=false, 1=true

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const interviewResults = pgTable("interview_results", {
  id: varchar("id", { length: 64 }).primaryKey(),
  sessionId: varchar("sessionId", { length: 64 }).notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

  // Final results from all phases
  finalGoal: text("finalGoal"),
  finalDeliverable: text("finalDeliverable"),
  finalAPTLSSChecklist: text("finalAPTLSSChecklist"), // JSON

  // Confidence and quality metrics
  finalConfidence: integer("finalConfidence").notNull().default(0), // 0-100
  clarityScore: integer("clarityScore").notNull().default(0), // 0-100
  completenessScore: integer("completenessScore").notNull().default(0), // 0-100

  // Execution plan
  executionPlan: text("executionPlan"), // JSON
  estimatedDuration: integer("estimatedDuration"), // minutes

  // Quality metrics
  totalQuestionsAsked: integer("totalQuestionsAsked").notNull().default(0),
  totalResponsesProvided: integer("totalResponsesProvided")
    .notNull()
    .default(0),
  escalationsRequired: integer("escalationsRequired").notNull().default(0),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type InterviewSession = typeof interviewSessions.$inferSelect;
export type InsertInterviewSession = typeof interviewSessions.$inferInsert;
export type InterviewHistory = typeof interviewHistory.$inferSelect;
export type InsertInterviewHistory = typeof interviewHistory.$inferInsert;
export type InterviewResult = typeof interviewResults.$inferSelect;
export type InsertInterviewResult = typeof interviewResults.$inferInsert;

// ============================================
// ADVANCED SCHEDULING TABLES
// ============================================

// Task schedule history - track all rescheduling events
export const taskScheduleHistory = pgTable('task_schedule_history', {
  id: varchar('id', { length: 64 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  founderId: integer('founderId'),
  assignmentId: integer('assignmentId'),
  cardTrelloId: varchar('cardTrelloId', { length: 64 }),

  // Previous schedule
  previousStartTime: timestamp('previousStartTime'),
  previousEndTime: timestamp('previousEndTime'),

  // New schedule
  newStartTime: timestamp('newStartTime'),
  newEndTime: timestamp('newEndTime'),

  // Change details
  changedBy: varchar('changedBy', { length: 64 }).notNull(), // User openId
  reason: varchar('reason', { length: 255 }), // Why was it rescheduled?
  source: enumText('source', ['manual', 'auto', 'batch', 'conflict_resolution']).default('manual').notNull(),

  // Conflict info
  hadConflicts: integer('hadConflicts').default(0).notNull(), // 0=false, 1=true
  conflictDetails: text('conflictDetails'), // JSON array of conflicts

  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, table => [index("task_schedule_history_assignment_created_idx").on(table.assignmentId, table.createdAt)]);

// Batch operations tracking
export const batchOperations = pgTable("batch_operations", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("userId", { length: 64 }).notNull(), // User openId

  // Operation details
  operationType: enumText("operationType", [
    "re_analyze",
    "reschedule",
    "conflict_resolution",
    "optimization",
  ]).notNull(),
  description: varchar("description", { length: 255 }),

  // Task scope
  totalTasks: integer("totalTasks").notNull(),
  completedTasks: integer("completedTasks").notNull().default(0),
  failedTasks: integer("failedTasks").notNull().default(0),

  // Progress tracking
  status: enumText("status", [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ])
    .default("pending")
    .notNull(),
  progress: numeric("progress", { precision: 5, scale: 2 })
    .default("0.00")
    .notNull(), // 0-100%
  currentTaskIndex: integer("currentTaskIndex").default(0),
  currentTaskName: varchar("currentTaskName", { length: 255 }),

  // Timing
  estimatedTimeSeconds: integer("estimatedTimeSeconds"),
  elapsedTimeSeconds: integer("elapsedTimeSeconds").default(0),

  // Results
  results: text("results"), // JSON with operation results
  errorLog: text("errorLog"), // JSON array of errors

  // Metadata
  parameters: text("parameters"), // JSON with operation parameters

  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Keyboard shortcuts configuration
export const keyboardShortcuts = pgTable("keyboard_shortcuts", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: varchar("userId", { length: 64 }).notNull(), // User openId

  // Shortcut details
  shortcutKey: varchar("shortcutKey", { length: 50 }).notNull(), // e.g., 'Ctrl+D', 'Ctrl+R'
  action: varchar("action", { length: 100 }).notNull(), // e.g., 'open_calendar', 'batch_reanalyze'
  description: varchar("description", { length: 255 }),

  // Customization
  isCustom: integer("isCustom").default(0).notNull(), // 0=default, 1=custom
  isEnabled: integer("isEnabled").default(1).notNull(), // 0=disabled, 1=enabled

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export type TaskScheduleHistory = typeof taskScheduleHistory.$inferSelect;
export type InsertTaskScheduleHistory = typeof taskScheduleHistory.$inferInsert;
export type BatchOperation = typeof batchOperations.$inferSelect;
export type InsertBatchOperation = typeof batchOperations.$inferInsert;
export type KeyboardShortcut = typeof keyboardShortcuts.$inferSelect;
export type InsertKeyboardShortcut = typeof keyboardShortcuts.$inferInsert;

// ============================================
// ATIS PHASES 3-10 TABLES
// ============================================

// Phase 3: Task Decomposition - Subtasks
export const taskSubtasks = pgTable("task_subtasks", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(), // References tasks/cards
  userId: varchar("userId", { length: 64 }).notNull(), // User openId

  // Subtask details
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  estimatedHours: numeric("estimatedHours", { precision: 10, scale: 2 }),
  sequence: integer("sequence").notNull().default(0), // Order in decomposition

  // Status tracking
  status: enumText("status", ["pending", "in_progress", "completed", "blocked"])
    .default("pending")
    .notNull(),

  // Metadata
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Phase 3: Subtask Dependencies
export const subtaskDependencies = pgTable("subtask_dependencies", {
  id: varchar("id", { length: 36 }).primaryKey(),
  subtaskId: varchar("subtaskId", { length: 36 }).notNull(), // References taskSubtasks.id
  dependsOnSubtaskId: varchar("dependsOnSubtaskId", { length: 36 }).notNull(), // References taskSubtasks.id

  // Dependency type
  dependencyType: enumText("dependencyType", [
    "sequential",
    "parallel",
    "blocking",
  ])
    .default("sequential")
    .notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Phase 3: Critical Path Analysis
export const criticalPathAnalysis = pgTable("critical_path_analysis", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // Critical path data
  criticalPath: text("criticalPath").notNull(), // JSON array of subtask IDs
  totalDurationHours: numeric("totalDurationHours", {
    precision: 10,
    scale: 2,
  }).notNull(),
  parallelizationOpportunities: integer("parallelizationOpportunities").default(
    0
  ),

  // Analysis metadata
  analysisData: text("analysisData"), // JSON with detailed analysis

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Phase 4: Risk Assessment
export const taskRisks = pgTable("task_risks", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // Risk details
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  category: enumText("category", [
    "technical",
    "resource",
    "schedule",
    "external",
  ]).notNull(),

  // Risk scoring
  probability: integer("probability").notNull(), // 1-10
  impact: integer("impact").notNull(), // 1-10
  priority: integer("priority").notNull(), // probability * impact

  // Status
  status: enumText("status", ["identified", "mitigated", "resolved"])
    .default("identified")
    .notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Phase 4: Risk Mitigations
export const riskMitigations = pgTable("risk_mitigations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  riskId: varchar("riskId", { length: 36 }).notNull(), // References taskRisks.id

  // Mitigation strategy
  strategy: varchar("strategy", { length: 255 }).notNull(),
  effort: varchar("effort", { length: 50 }), // e.g., 'low', 'medium', 'high'
  owner: varchar("owner", { length: 255 }),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Phase 5: Resource Requirements
export const taskResourceRequirements = pgTable("task_resource_requirements", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // Resource type
  resourceType: enumText("resourceType", [
    "skill",
    "tool",
    "training",
  ]).notNull(),
  resourceName: varchar("resourceName", { length: 255 }).notNull(),

  // Proficiency level (for skills)
  proficiencyLevel: enumText("proficiencyLevel", [
    "beginner",
    "intermediate",
    "expert",
  ]),

  // Cost estimation
  estimatedCost: numeric("estimatedCost", { precision: 10, scale: 2 }),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Phase 6: Timeline Optimization
export const taskTimeline = pgTable("task_timeline", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // Timeline data
  startDate: varchar("startDate", { length: 10 }), // YYYY-MM-DD
  endDate: varchar("endDate", { length: 10 }), // YYYY-MM-DD
  bufferDays: integer("bufferDays").default(0),
  totalDays: integer("totalDays"),

  // Optimization metadata
  optimizationData: text("optimizationData"), // JSON with optimization details

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Phase 6: Task Milestones
export const taskMilestones = pgTable("task_milestones", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),

  // Milestone details
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  dueDate: varchar("dueDate", { length: 10 }).notNull(), // YYYY-MM-DD

  // Status
  status: enumText("status", ["pending", "completed"])
    .default("pending")
    .notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Phase 7: QA Strategy
export const taskQAStrategy = pgTable("task_qa_strategy", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // QA strategy
  strategy: text("strategy").notNull(),
  testingPhases: text("testingPhases"), // JSON array of testing phases
  qualityMetrics: text("qualityMetrics"), // JSON with quality metrics
  acceptanceCriteria: text("acceptanceCriteria"), // JSON with acceptance criteria

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Phase 8: Documentation Requirements
export const taskDocumentationRequirements = pgTable(
  "task_documentation_requirements",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    taskId: varchar("taskId", { length: 128 }).notNull(),
    userId: varchar("userId", { length: 64 }).notNull(),

    // Documentation details
    docType: varchar("docType", { length: 100 }).notNull(), // e.g., 'user_guide', 'api_docs', 'technical_spec'
    audience: varchar("audience", { length: 255 }), // e.g., 'end_users', 'developers', 'stakeholders'
    estimatedEffort: numeric("estimatedEffort", { precision: 10, scale: 2 }), // Hours

    // Content outline
    contentOutline: text("contentOutline"), // JSON with outline structure

    createdAt: timestamp("createdAt").defaultNow().notNull(),
  }
);

// Phase 9: External Dependencies
export const taskExternalDependencies = pgTable("task_external_dependencies", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // Dependency details
  dependencyType: enumText("dependencyType", [
    "approval",
    "third_party",
    "regulatory",
  ]).notNull(),
  description: text("description").notNull(),
  owner: varchar("owner", { length: 255 }),
  dueDate: varchar("dueDate", { length: 10 }), // YYYY-MM-DD

  // Status
  status: enumText("status", ["pending", "completed"])
    .default("pending")
    .notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Phase 10: Execution Plan
export const taskExecutionPlan = pgTable("task_execution_plan", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // Execution plan data
  roadmap: text("roadmap"), // JSON with step-by-step roadmap
  successMetrics: text("successMetrics"), // JSON with success metrics
  communicationPlan: text("communicationPlan"), // Communication strategy
  escalationPath: text("escalationPath"), // JSON with escalation procedures
  preExecutionChecklist: text("preExecutionChecklist"), // JSON with checklist items

  // Final APTLSS checklist
  aptlssChecklist: text("aptlssChecklist"), // JSON with final APTLSS checklist
  confidenceScore: numeric("confidenceScore", { precision: 5, scale: 2 }), // 0-100%

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// ATIS Analysis Session - tracks the overall analysis process
export const atisAnalysisSessions = pgTable("atis_analysis_sessions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  taskId: varchar("taskId", { length: 128 }).notNull(),
  userId: varchar("userId", { length: 64 }).notNull(),

  // Session tracking
  status: enumText("status", ["pending", "in_progress", "completed", "failed"])
    .default("pending")
    .notNull(),
  currentPhase: integer("currentPhase").default(3), // Current phase (3-10)

  // Progress tracking
  phasesCompleted: integer("phasesCompleted").default(0),

  // Session data
  sessionData: text("sessionData"), // JSON with all phase results

  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Type exports
export type TaskSubtask = typeof taskSubtasks.$inferSelect;
export type InsertTaskSubtask = typeof taskSubtasks.$inferInsert;
export type SubtaskDependency = typeof subtaskDependencies.$inferSelect;
export type InsertSubtaskDependency = typeof subtaskDependencies.$inferInsert;
export type CriticalPathAnalysis = typeof criticalPathAnalysis.$inferSelect;
export type InsertCriticalPathAnalysis =
  typeof criticalPathAnalysis.$inferInsert;
export type TaskRisk = typeof taskRisks.$inferSelect;
export type InsertTaskRisk = typeof taskRisks.$inferInsert;
export type RiskMitigation = typeof riskMitigations.$inferSelect;
export type InsertRiskMitigation = typeof riskMitigations.$inferInsert;
export type TaskResourceRequirement =
  typeof taskResourceRequirements.$inferSelect;
export type InsertTaskResourceRequirement =
  typeof taskResourceRequirements.$inferInsert;
export type TaskTimeline = typeof taskTimeline.$inferSelect;
export type InsertTaskTimeline = typeof taskTimeline.$inferInsert;
export type TaskMilestone = typeof taskMilestones.$inferSelect;
export type InsertTaskMilestone = typeof taskMilestones.$inferInsert;
export type TaskQAStrategy = typeof taskQAStrategy.$inferSelect;
export type InsertTaskQAStrategy = typeof taskQAStrategy.$inferInsert;
export type TaskDocumentationRequirement =
  typeof taskDocumentationRequirements.$inferSelect;
export type InsertTaskDocumentationRequirement =
  typeof taskDocumentationRequirements.$inferInsert;
export type TaskExternalDependency =
  typeof taskExternalDependencies.$inferSelect;
export type InsertTaskExternalDependency =
  typeof taskExternalDependencies.$inferInsert;
export type TaskExecutionPlan = typeof taskExecutionPlan.$inferSelect;
export type InsertTaskExecutionPlan = typeof taskExecutionPlan.$inferInsert;
export type AtisAnalysisSession = typeof atisAnalysisSessions.$inferSelect;
export type InsertAtisAnalysisSession =
  typeof atisAnalysisSessions.$inferInsert;

// ============================================
// SCHEDULING SETTINGS TABLES
// ============================================

// Conflict detection settings per user
export const conflictDetectionSettings = pgTable(
  "conflict_detection_settings",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    userId: integer("userId").notNull(),
    userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

    // Conflict detection configuration
    enabled: integer("enabled").notNull().default(1), // 0=false, 1=true
    warningThresholdMinutes: integer("warningThresholdMinutes")
      .notNull()
      .default(15),
    autoResolve: integer("autoResolve").notNull().default(0), // 0=false, 1=true
    notifyOnConflict: integer("notifyOnConflict").notNull().default(1), // 0=false, 1=true

    // Conflict types to detect (JSON)
    conflictTypes: text("conflictTypes")
      .notNull()
      .default(
        '{"timeOverlap":true,"resourceConflict":true,"dependencyConflict":true}'
      ),

    // Version tracking for sync
    version: integer("version").notNull().default(1),
    lastModified: timestamp("lastModified")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  }
);

// Batch operation defaults per user
export const batchOperationSettings = pgTable("batch_operation_settings", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

  // Default operation settings
  defaultOperationType: varchar("defaultOperationType", { length: 50 })
    .notNull()
    .default("re_analyze"),
  defaultPriority: varchar("defaultPriority", { length: 20 })
    .notNull()
    .default("normal"),
  autoStartOnQueue: integer("autoStartOnQueue").notNull().default(0), // 0=false, 1=true
  maxConcurrentOperations: integer("maxConcurrentOperations")
    .notNull()
    .default(3),

  // Retry configuration
  retryFailedTasks: integer("retryFailedTasks").notNull().default(1), // 0=false, 1=true
  maxRetries: integer("maxRetries").notNull().default(2),

  // Notification settings
  notifyOnCompletion: integer("notifyOnCompletion").notNull().default(1), // 0=false, 1=true
  notifyOnFailure: integer("notifyOnFailure").notNull().default(1), // 0=false, 1=true

  // Version tracking for sync
  version: integer("version").notNull().default(1),
  lastModified: timestamp("lastModified")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// Keyboard shortcuts per user
export const keyboardShortcutsSettings = pgTable(
  "keyboard_shortcuts_settings",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    userId: integer("userId").notNull(),
    userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

    // Shortcuts data (JSON array)
    shortcuts: text("shortcuts").notNull().default("[]"),

    // Version tracking for sync
    version: integer("version").notNull().default(1),
    lastModified: timestamp("lastModified")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  }
);

// Performance metrics per user
export const performanceMetricsSettings = pgTable(
  "performance_metrics_settings",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    userId: integer("userId").notNull(),
    userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

    // Metrics data
    totalOperations: integer("totalOperations").notNull().default(0),
    successfulOperations: integer("successfulOperations").notNull().default(0),
    failedOperations: integer("failedOperations").notNull().default(0),
    averageExecutionTime: numeric("averageExecutionTime", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0.00"),
    averageTasksPerOperation: numeric("averageTasksPerOperation", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0.00"),
    conflictsDetected: integer("conflictsDetected").notNull().default(0),
    conflictsResolved: integer("conflictsResolved").notNull().default(0),

    // Trend data (JSON)
    trends: text("trends")
      .notNull()
      .default(
        '{"successRate":0,"executionTimeTrend":"stable","operationsTrend":"stable"}'
      ),

    // Version tracking for sync
    version: integer("version").notNull().default(1),
    lastModified: timestamp("lastModified")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),

    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  }
);

// Settings sync log for tracking changes
export const settingsSyncLog = pgTable("settings_sync_log", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  userId: integer("userId").notNull(),
  userOpenId: varchar("userOpenId", { length: 64 }).notNull(),

  // Sync details
  settingsType: varchar("settingsType", { length: 50 }).notNull(), // conflict_detection, batch_operation, keyboard_shortcuts, performance_metrics
  action: varchar("action", { length: 20 }).notNull(), // create, update, delete
  previousVersion: integer("previousVersion"),
  newVersion: integer("newVersion"),

  // Device/client info
  deviceId: varchar("deviceId", { length: 128 }),
  clientVersion: varchar("clientVersion", { length: 20 }),

  // Conflict resolution
  hadConflict: integer("hadConflict").notNull().default(0), // 0=false, 1=true
  conflictResolution: varchar("conflictResolution", { length: 50 }), // merge, overwrite, keep_local

  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ConflictDetectionSettings =
  typeof conflictDetectionSettings.$inferSelect;
export type InsertConflictDetectionSettings =
  typeof conflictDetectionSettings.$inferInsert;
export type BatchOperationSettings = typeof batchOperationSettings.$inferSelect;
export type InsertBatchOperationSettings =
  typeof batchOperationSettings.$inferInsert;
export type KeyboardShortcutsSettings =
  typeof keyboardShortcutsSettings.$inferSelect;
export type InsertKeyboardShortcutsSettings =
  typeof keyboardShortcutsSettings.$inferInsert;
export type PerformanceMetricsSettings =
  typeof performanceMetricsSettings.$inferSelect;
export type InsertPerformanceMetricsSettings =
  typeof performanceMetricsSettings.$inferInsert;
export type SettingsSyncLog = typeof settingsSyncLog.$inferSelect;
export type InsertSettingsSyncLog = typeof settingsSyncLog.$inferInsert;

// ExecutionPlans table - stores execution plan metadata
export const executionPlans = pgTable("execution_plans", {
  id: varchar("id", { length: 255 }).primaryKey(),
  cardId: varchar("cardId", { length: 255 }).notNull(),
  userId: integer("userId").notNull(),
  objective: text("objective").notNull(),
  inputs: text("inputs").notNull(), // JSON stringified
  outputs: text("outputs").notNull(), // JSON stringified
  stepsJson: text("stepsJson").notNull(), // JSON stringified
  iterationFlowsJson: text("iterationFlowsJson").notNull(), // JSON stringified
  totalEstimateMin: integer("totalEstimateMin").notNull(),
  totalEstimateMax: integer("totalEstimateMax").notNull(),
  generatedBy: enumText("generatedBy", ["manual", "ai"])
    .notNull()
    .default("manual"),
  qualityScore: integer("qualityScore").default(85), // 0-100 score from quality check
  validationStatus: enumText("validationStatus", [
    "initial",
    "validated",
    "needs_review",
    "quality_check_failed",
  ]).default("initial"),
  qualityFeedback: text("qualityFeedback"), // Feedback from quality check
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// ExecutionPlanSteps table - stores individual step statuses
export const executionPlanSteps = pgTable("execution_plan_steps", {
  id: varchar("id", { length: 255 }).primaryKey(),
  executionPlanId: varchar("executionPlanId", { length: 255 }).notNull(),
  stepId: varchar("stepId", { length: 255 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description").notNull(),
  dependencies: text("dependencies").notNull(), // JSON stringified array
  parallelizable: integer("parallelizable").notNull().default(0),
  timeEstimateMin: integer("timeEstimateMin").notNull(),
  timeEstimateMax: integer("timeEstimateMax").notNull(),
  risks: text("risks").notNull(), // JSON stringified array
  status: enumText("status", ["completed", "in-progress", "ready", "blocked"])
    .notNull()
    .default("ready"),
  completedBy: varchar("completedBy", { length: 255 }),
  completedAt: timestamp("completedAt"),
  startedAt: timestamp("startedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

// ExecutionPlanStatusHistory table - audit trail for status changes
export const executionPlanStatusHistory = pgTable(
  "execution_plan_status_history",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    stepId: varchar("stepId", { length: 255 }).notNull(),
    executionPlanId: varchar("executionPlanId", { length: 255 }).notNull(),
    previousStatus: enumText("previousStatus", [
      "completed",
      "in-progress",
      "ready",
      "blocked",
    ]).notNull(),
    newStatus: enumText("newStatus", [
      "completed",
      "in-progress",
      "ready",
      "blocked",
    ]).notNull(),
    changedBy: integer("changedBy").notNull(),
    reason: text("reason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  }
);

export type ExecutionPlan = typeof executionPlans.$inferSelect;
export type InsertExecutionPlan = typeof executionPlans.$inferInsert;
export type ExecutionPlanStep = typeof executionPlanSteps.$inferSelect;
export type InsertExecutionPlanStep = typeof executionPlanSteps.$inferInsert;
export type ExecutionPlanStatusHistoryRecord =
  typeof executionPlanStatusHistory.$inferSelect;
export type InsertExecutionPlanStatusHistory =
  typeof executionPlanStatusHistory.$inferInsert;

// ─── ARES Configuration Tables ────────────────────────────────────────────────
// ARES = Automated Requirement Evaluation System
// Manages validation rules, thresholds, and strictness levels for goal validation

export const aresConfigurations = pgTable("ares_configurations", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: integer("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  strictnessLevel: enumText("strictnessLevel", [
    "lenient",
    "moderate",
    "strict",
  ])
    .default("moderate")
    .notNull(),
  confidenceThreshold: integer("confidenceThreshold").default(40).notNull(), // Minimum confidence % required
  enableVaguenessCheck: boolean("enableVaguenessCheck").default(true).notNull(),
  enableMeasurabilityCheck: boolean("enableMeasurabilityCheck")
    .default(true)
    .notNull(),
  enableTimelineCheck: boolean("enableTimelineCheck").default(true).notNull(),
  enableResourceCheck: boolean("enableResourceCheck").default(false).notNull(),
  enableDependencyCheck: boolean("enableDependencyCheck")
    .default(false)
    .notNull(),
  isDefault: boolean("isDefault").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export const aresValidationRules = pgTable("ares_validation_rules", {
  id: varchar("id", { length: 64 }).primaryKey(),
  configId: varchar("configId", { length: 64 }).notNull(),
  ruleType: enumText("ruleType", [
    "vagueness",
    "measurability",
    "timeline",
    "resources",
    "dependencies",
    "clarity",
    "specificity",
    "actionability",
  ]).notNull(),
  ruleName: varchar("ruleName", { length: 255 }).notNull(),
  description: text("description"),
  severity: enumText("severity", ["info", "warning", "error"])
    .default("warning")
    .notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  threshold: integer("threshold").default(50), // Percentage or score threshold
  customLogic: text("customLogic"), // JSON string for custom validation logic
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export const aresValidationHistory = pgTable("ares_validation_history", {
  id: varchar("id", { length: 64 }).primaryKey(),
  configId: varchar("configId", { length: 64 }).notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: text("cardName").notNull(),
  goalDefinition: text("goalDefinition"),
  confidenceScore: integer("confidenceScore").notNull(),
  passed: boolean("passed").notNull(),
  failedRules: text("failedRules"), // JSON array of failed rule IDs
  warnings: text("warnings"), // JSON array of warnings
  validationDetails: text("validationDetails"), // JSON object with detailed results
  validatedAt: timestamp("validatedAt").defaultNow().notNull(),
  validatedBy: integer("validatedBy").notNull(),
});

export type AresConfiguration = typeof aresConfigurations.$inferSelect;
export type InsertAresConfiguration = typeof aresConfigurations.$inferInsert;
export type AresValidationRule = typeof aresValidationRules.$inferSelect;
export type InsertAresValidationRule = typeof aresValidationRules.$inferInsert;
export type AresValidationHistoryRecord =
  typeof aresValidationHistory.$inferSelect;
export type InsertAresValidationHistory =
  typeof aresValidationHistory.$inferInsert;

// ─── APTLSS PLANS & STEPS (Merged from Manus Dashboard) ───

export const aptlssPlans = pgTable(
  "aptlss_plans",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull(),
    cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
    boardName: varchar("boardName", { length: 256 }).notNull().default(""),
    listName: varchar("listName", { length: 256 }).notNull().default(""),
    planJson: text("planJson").notNull(),
    contextSnapshot: text("contextSnapshot"),
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [uniqueIndex("va_aptlss_plan_card_idx").on(table.vaId, table.cardId)]
);

export const aptlssSteps = pgTable("aptlss_steps", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  trelloChecklistId: varchar("trelloChecklistId", { length: 64 }),
  trelloCheckItemId: varchar("trelloCheckItemId", { length: 64 }),
  stepNumber: integer("stepNumber").notNull(),
  title: varchar("title", { length: 1024 }).notNull(),
  estimatedMinutes: integer("estimatedMinutes").notNull().default(15),
  status: varchar("status", { length: 32 }).notNull().default("open"),
  category: varchar("category", { length: 64 }).notNull().default("internal_work"),
  requiresRobert: boolean("requiresRobert").notNull().default(false),
  blockedBy: varchar("blockedBy", { length: 64 }),
  dependsOnCards: text("dependsOnCards"),
  completionCriteria: text("completionCriteria"),
  riskIfSkipped: text("riskIfSkipped"),
  recommendedDecision: text("recommendedDecision"),
  isManual: boolean("isManual").notNull().default(false),
  completedAt: timestamp("completedAt"),
  lastSyncedAt: timestamp("lastSyncedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  index("va_aptlss_step_card_idx").on(table.vaId, table.cardId),
]);

export const cardStates = pgTable(
  "card_states",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull().default(""),
    boardName: varchar("boardName", { length: 256 }).notNull().default(""),
    listName: varchar("listName", { length: 256 }).notNull().default(""),
    state: varchar("state", { length: 64 }).notNull().default("NEW_UNTRIAGED"),
    stateReason: text("stateReason"),
    daysSinceProgress: integer("daysSinceProgress").notNull().default(0),
    hasUnansweredQuestion: boolean("hasUnansweredQuestion")
      .notNull()
      .default(false),
    isOverdue: boolean("isOverdue").notNull().default(false),
    checklistComplete: boolean("checklistComplete").notNull().default(false),
    hasFinalSummary: boolean("hasFinalSummary").notNull().default(false),
    calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [uniqueIndex("va_card_state_card_idx").on(table.vaId, table.cardId)]
);

export const priorityScores = pgTable(
  "priority_scores",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull().default(""),
    score: integer("score").notNull().default(0),
    breakdown: text("breakdown"),
    tier: varchar("tier", { length: 16 }).notNull().default("MEDIUM"),
    estimatedRemainingMinutes: integer("estimatedRemainingMinutes")
      .notNull()
      .default(0),
    openSteps: integer("openSteps").notNull().default(0),
    completedSteps: integer("completedSteps").notNull().default(0),
    calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex("va_priority_score_card_idx").on(table.vaId, table.cardId),
  ]
);

export const aptlssOperationalPolicies = pgTable(
  "aptlss_operational_policies",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    ruleKey: varchar("ruleKey", { length: 128 }).notNull(),
    label: varchar("label", { length: 256 }).notNull().default(""),
    description: text("description"),
    value: text("value").notNull().default("{}"),
    category: varchar("category", { length: 64 }).notNull().default("general"),
    enabled: integer("enabled").notNull().default(1),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("va_operational_policy_idx").on(table.vaId, table.ruleKey),
  ]
);

export const workerPerformanceSignals = pgTable("worker_performance_signals", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  workerId: varchar("workerId", { length: 128 }).notNull(),
  workerName: varchar("workerName", { length: 256 }).notNull().default(""),
  weekKey: varchar("weekKey", { length: 16 }).notNull(),
  avgResponseTimeMinutes: integer("avgResponseTimeMinutes")
    .notNull()
    .default(0),
  checklistItemsCompleted: integer("checklistItemsCompleted")
    .notNull()
    .default(0),
  stalledCardsCount: integer("stalledCardsCount").notNull().default(0),
  missedDeadlines: integer("missedDeadlines").notNull().default(0),
  robertEscalationsCount: integer("robertEscalationsCount")
    .notNull()
    .default(0),
  reworkCount: integer("reworkCount").notNull().default(0),
  unclearHandovers: integer("unclearHandovers").notNull().default(0),
  notes: text("notes"),
  calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export const weeklyAnalysisSnapshots = pgTable(
  "weekly_analysis_snapshots",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    weekKey: varchar("weekKey", { length: 16 }).notNull(),
    noProgressCards: text("noProgressCards"),
    recurringBlockers: text("recurringBlockers"),
    estimateDrift: text("estimateDrift"),
    underperformingWorkers: text("underperformingWorkers"),
    listHoppers: text("listHoppers"),
    unclearScopeProjects: text("unclearScopeProjects"),
    processImprovements: text("processImprovements"),
    summary: text("summary"),
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("va_weekly_analysis_idx").on(table.vaId, table.weekKey)]
);

export const autoFollowUpDrafts = pgTable("auto_follow_up_drafts", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  draftMessage: text("draftMessage").notNull(),
  reason: varchar("reason", { length: 512 }).notNull().default(""),
  hoursSinceLastReply: integer("hoursSinceLastReply").notNull().default(0),
  urgencyType: varchar("urgencyType", { length: 32 })
    .notNull()
    .default("routine"),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdateFn(() => new Date())
    .notNull(),
});

export const dailyPlans = pgTable(
  "daily_plans",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    dateKey: varchar("dateKey", { length: 16 }).notNull(),
    scheduleJson: text("scheduleJson").notNull(),
    dailySummary: text("dailySummary"),
    topPriority: varchar("topPriority", { length: 512 }),
    totalScheduledMinutes: integer("totalScheduledMinutes")
      .notNull()
      .default(0),
    robertItemsCount: integer("robertItemsCount").notNull().default(0),
    autoGenerated: boolean("autoGenerated").notNull().default(true),
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("va_daily_plan_idx").on(table.vaId, table.dateKey)]
);

export const aptlssAuditLog = pgTable("aptlss_audit_log", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  action: varchar("action", { length: 64 }).notNull(),
  description: text("description").notNull(),
  payload: text("payload"),
  confidenceScore: integer("confidenceScore"),
  requiresApproval: boolean("requiresApproval").notNull().default(false),
  approved: boolean("approved"),
  source: varchar("source", { length: 32 })
    .notNull()
    .default("maintenance_job"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const adminSyncLog = pgTable("admin_sync_log", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  syncType: varchar("syncType", { length: 32 }).notNull(),
  success: boolean("success").notNull(),
  cardsProcessed: integer("cardsProcessed").notNull().default(0),
  actionsTaken: integer("actionsTaken").notNull().default(0),
  cardsSkippedLowConfidence: integer("cardsSkippedLowConfidence")
    .notNull()
    .default(0),
  errorMessage: text("errorMessage"),
  durationMs: integer("durationMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Additive operator intelligence and evidence tables. These extend the
// developer platform without replacing its identity, scheduling, or APTLSS data.
export const aptlssAssessments = pgTable(
  "aptlss_assessments",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull().default(""),
    engineVersion: varchar("engineVersion", { length: 32 }).notNull(),
    contextHash: varchar("contextHash", { length: 64 }).notNull(),
    trigger: varchar("trigger", { length: 32 }).notNull().default("manual"),
    primaryState: varchar("primaryState", { length: 64 }).notNull(),
    stateReason: text("stateReason").notNull(),
    secondarySignals: text("secondarySignals").notNull(),
    actionability: varchar("actionability", { length: 32 }).notNull(),
    priorityScore: integer("priorityScore").notNull(),
    priorityTier: varchar("priorityTier", { length: 16 }).notNull(),
    priorityBreakdown: text("priorityBreakdown").notNull(),
    confidenceScore: integer("confidenceScore").notNull(),
    confidenceBand: varchar("confidenceBand", { length: 16 }).notNull(),
    confidenceReason: text("confidenceReason").notNull(),
    evidenceCoverage: text("evidenceCoverage").notNull(),
    evidenceJson: text("evidenceJson").notNull(),
    intelligenceJson: text("intelligenceJson"),
    uncertaintiesJson: text("uncertaintiesJson").notNull(),
    recommendationsJson: text("recommendationsJson").notNull(),
    lastMeaningfulProgressAt: timestamp("lastMeaningfulProgressAt"),
    daysSinceMeaningfulProgress: integer("daysSinceMeaningfulProgress")
      .notNull()
      .default(0),
    nextAssessmentAt: timestamp("nextAssessmentAt").notNull(),
    changeJson: text("changeJson").notNull(),
    evaluationCount: integer("evaluationCount").notNull().default(1),
    assessedAt: timestamp("assessedAt").notNull(),
    lastEvaluatedAt: timestamp("lastEvaluatedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [
    index("aptlss_assessments_card_assessed_idx").on(
      table.cardId,
      table.assessedAt
    ),
    index("aptlss_assessments_next_idx").on(table.nextAssessmentAt),
  ]
);

export const aptlssAssessmentFeedback = pgTable(
  "aptlss_assessment_feedback",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    assessmentId: integer("assessmentId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull().default(""),
    engineVersion: varchar("engineVersion", { length: 32 }).notNull(),
    predictedState: varchar("predictedState", { length: 64 }).notNull(),
    predictedConfidence: integer("predictedConfidence").notNull(),
    verdict: enumText("verdict", [
      "accurate",
      "partial",
      "inaccurate",
    ]).notNull(),
    correctedState: varchar("correctedState", { length: 64 }),
    note: text("note"),
    createdBy: varchar("createdBy", { length: 128 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("aptlss_assessment_feedback_assessment_idx").on(
      table.assessmentId
    ),
    index("aptlss_assessment_feedback_card_created_idx").on(
      table.cardId,
      table.createdAt
    ),
  ]
);

export const aptlssWaitingReasons = pgTable(
  "aptlss_waiting_reasons",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    cardName: varchar("cardName", { length: 512 }).notNull().default(""),
    cardUrl: varchar("cardUrl", { length: 1024 }).notNull().default(""),
    boardName: varchar("boardName", { length: 256 }).notNull().default(""),
    listName: varchar("listName", { length: 256 }).notNull().default(""),
    rawReason: text("rawReason").notNull(),
    category: varchar("category", { length: 64 }).notNull(),
    waitingOn: varchar("waitingOn", { length: 32 }).notNull(),
    waitingOnName: varchar("waitingOnName", { length: 256 }),
    requestedItem: text("requestedItem"),
    nextAction: text("nextAction").notNull(),
    nextStepType: varchar("nextStepType", { length: 64 }).notNull(),
    followUpAt: timestamp("followUpAt"),
    followUpSource: varchar("followUpSource", { length: 32 }).notNull(),
    urgency: varchar("urgency", { length: 16 }).notNull(),
    requiresRobert: boolean("requiresRobert").notNull().default(false),
    confidenceScore: integer("confidenceScore").notNull(),
    confidenceReason: text("confidenceReason").notNull(),
    interpretationJson: text("interpretationJson").notNull(),
    interpreterVersion: varchar("interpreterVersion", { length: 32 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    recordedBy: varchar("recordedBy", { length: 128 }).notNull(),
    resolvedAt: timestamp("resolvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("aptlss_waiting_reasons_va_status_idx").on(
      table.vaId,
      table.status,
      table.createdAt
    ),
    index("aptlss_waiting_reasons_card_status_idx").on(
      table.cardId,
      table.status,
      table.createdAt
    ),
    index("aptlss_waiting_reasons_follow_up_idx").on(
      table.status,
      table.followUpAt
    ),
  ]
);

export const decisionOutcomes = pgTable("decision_outcomes", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  stepId: integer("stepId").notNull().unique(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull().default(""),
  boardName: varchar("boardName", { length: 256 }).notNull().default(""),
  listName: varchar("listName", { length: 256 }).notNull().default(""),
  decisionPrompt: text("decisionPrompt").notNull(),
  recommendedDecision: text("recommendedDecision"),
  disposition: enumText("disposition", ["recorded", "approved", "rejected"]).notNull().default("recorded"),
  outcome: text("outcome").notNull(),
  resolvedBy: varchar("resolvedBy", { length: 64 }).notNull(),
  resolvedAt: timestamp("resolvedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("decision_outcomes_va_resolved_idx").on(table.vaId, table.resolvedAt),
]);

export const workspaceEvidenceItems = pgTable("workspace_evidence_items", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId"),
  source: enumText("source", ["gmail", "google_drive", "trello", "communication"]).notNull(),
  sourceId: varchar("sourceId", { length: 256 }).notNull(),
  sourceContainerId: varchar("sourceContainerId", { length: 256 }),
  kind: varchar("kind", { length: 128 }).notNull().default("record"),
  title: varchar("title", { length: 1024 }).notNull(),
  summary: text("summary"),
  content: text("content"),
  sourceUrl: varchar("sourceUrl", { length: 2048 }),
  mimeType: varchar("mimeType", { length: 256 }),
  modifiedAt: timestamp("modifiedAt"),
  observedAt: timestamp("observedAt").notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  metadataJson: text("metadataJson"),
  reviewStatus: enumText("reviewStatus", ["unreviewed", "linked", "not_work_related"]).notNull().default("unreviewed"),
  reviewedAt: timestamp("reviewedAt"),
  reviewedBy: varchar("reviewedBy", { length: 128 }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("workspace_evidence_va_source_id_unique").on(table.vaId, table.source, table.sourceId),
  index("workspace_evidence_va_source_modified_idx").on(table.vaId, table.source, table.modifiedAt),
  index("workspace_evidence_va_active_observed_idx").on(table.vaId, table.active, table.observedAt),
  index("workspace_evidence_va_review_idx").on(table.vaId, table.reviewStatus, table.modifiedAt),
]);

export const workspaceEvidenceLinks = pgTable(
  "workspace_evidence_links",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    evidenceId: integer("evidenceId").notNull(),
    cardId: varchar("cardId", { length: 64 }).notNull(),
    relevanceScore: integer("relevanceScore").notNull(),
    matchReason: varchar("matchReason", { length: 512 }).notNull(),
    linkMethod: enumText("linkMethod", ["automatic", "manual"])
      .notNull()
      .default("automatic"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [
    foreignKey({
      columns: [table.evidenceId],
      foreignColumns: [workspaceEvidenceItems.id],
      name: "workspace_evidence_item_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    uniqueIndex("workspace_evidence_link_unique").on(
      table.evidenceId,
      table.cardId
    ),
    index("workspace_evidence_card_relevance_idx").on(
      table.cardId,
      table.relevanceScore
    ),
  ]
);

// The graph is additive: workspaceEvidenceItems remains the canonical retained source record.
export const aptlssEvidenceRevisions = pgTable("aptlss_evidence_revisions", {
id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
evidenceId: integer("evidenceId").notNull(),
contentHash: varchar("contentHash", { length: 64 }).notNull(),
truthClass: enumText("truthClass", ["source_record", "worker_assertion", "system_inference"]).notNull(),
summary: text("summary"),
content: text("content"),
metadataJson: text("metadataJson"),
observedAt: timestamp("observedAt").notNull(),
recordedBy: varchar("recordedBy", { length: 128 }),
createdAt: timestamp("createdAt").defaultNow().notNull()
}, (table) => [
  foreignKey({
    columns: [table.evidenceId],
    foreignColumns: [workspaceEvidenceItems.id],
    name: "aptlss_evidence_revision_item_fk",
  }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("aptlss_evidence_revision_hash_unique").on(table.evidenceId, table.contentHash),
  index("aptlss_evidence_revision_observed_idx").on(table.evidenceId, table.observedAt),
]);

export const aptlssEvidenceSubjectLinks = pgTable("aptlss_evidence_subject_links", {
id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
evidenceId: integer("evidenceId").notNull(),
vaId: integer("vaId").notNull(),
subjectType: enumText("subjectType", ["card", "worker", "decision", "plan_block"]).notNull(),
subjectId: varchar("subjectId", { length: 256 }).notNull(),
relevanceScore: integer("relevanceScore").notNull(),
linkMethod: enumText("linkMethod", ["automatic", "manual", "confirmed"]).notNull().default("automatic"),
matchReason: varchar("matchReason", { length: 512 }).notNull(),
createdAt: timestamp("createdAt").defaultNow().notNull(),
updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull()
}, (table) => [
  foreignKey({
    columns: [table.evidenceId],
    foreignColumns: [workspaceEvidenceItems.id],
    name: "aptlss_evidence_subject_item_fk",
  }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("aptlss_evidence_subject_unique").on(table.evidenceId, table.vaId, table.subjectType, table.subjectId),
  index("aptlss_evidence_subject_lookup_idx").on(table.vaId, table.subjectType, table.subjectId, table.relevanceScore),
]);

export const aptlssEvidenceConflicts = pgTable("aptlss_evidence_conflicts", {
id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
vaId: integer("vaId").notNull(),
sourceEvidenceId: integer("sourceEvidenceId").notNull(),
assertedEvidenceId: integer("assertedEvidenceId").notNull(),
status: enumText("status", ["needs_verification", "consistent", "resolved", "dismissed"]).notNull().default("needs_verification"),
resolution: text("resolution"),
resolvedBy: varchar("resolvedBy", { length: 128 }),
resolvedAt: timestamp("resolvedAt"),
createdAt: timestamp("createdAt").defaultNow().notNull(),
updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull()
}, (table) => [
  foreignKey({
    columns: [table.sourceEvidenceId],
    foreignColumns: [workspaceEvidenceItems.id],
    name: "aptlss_evidence_conflict_source_fk",
  }).onDelete("cascade").onUpdate("cascade"),
  foreignKey({
    columns: [table.assertedEvidenceId],
    foreignColumns: [workspaceEvidenceItems.id],
    name: "aptlss_evidence_conflict_asserted_fk",
  }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("aptlss_evidence_conflict_pair_unique").on(table.sourceEvidenceId, table.assertedEvidenceId),
  index("aptlss_evidence_conflict_va_status_idx").on(table.vaId, table.status, table.createdAt),
]);

export const aptlssVerificationFollowups = pgTable("aptlss_verification_followups", {
id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
vaId: integer("vaId").notNull(),
cardId: varchar("cardId", { length: 64 }),
conflictId: integer("conflictId"),
title: varchar("title", { length: 512 }).notNull(),
question: text("question").notNull(),
status: enumText("status", ["open", "resolved", "superseded"]).notNull().default("open"),
dueAt: timestamp("dueAt"),
resolution: text("resolution"),
resolvedBy: varchar("resolvedBy", { length: 128 }),
resolvedAt: timestamp("resolvedAt"),
createdAt: timestamp("createdAt").defaultNow().notNull(),
updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull()
}, (table) => [
  foreignKey({
    columns: [table.conflictId],
    foreignColumns: [aptlssEvidenceConflicts.id],
    name: "aptlss_verification_followup_conflict_fk",
  }).onDelete("set null").onUpdate("cascade"),
  index("aptlss_verification_followup_va_status_idx").on(table.vaId, table.status, table.dueAt),
  index("aptlss_verification_followup_card_idx").on(table.cardId, table.status),
]);

export const communicationEvidence = pgTable("communication_evidence", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId"),
  channel: varchar("channel", { length: 64 }).notNull(),
  externalId: varchar("externalId", { length: 256 }).notNull(),
  threadId: varchar("threadId", { length: 256 }),
  direction: enumText("direction", ["inbound", "outbound", "system", "unknown"]).notNull().default("unknown"),
  sender: varchar("sender", { length: 512 }),
  recipientsJson: text("recipientsJson"),
  subject: varchar("subject", { length: 1024 }),
  summary: text("summary"),
  occurredAt: timestamp("occurredAt").notNull(),
  responseRequired: boolean("responseRequired").notNull().default(false),
  respondedAt: timestamp("respondedAt"),
  linkedCardId: varchar("linkedCardId", { length: 64 }),
  evidenceItemId: integer("evidenceItemId"),
  metadataJson: text("metadataJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("communication_evidence_va_channel_external_unique").on(table.vaId, table.channel, table.externalId),
  index("communication_evidence_va_card_occurred_idx").on(table.vaId, table.linkedCardId, table.occurredAt),
  index("communication_evidence_va_response_idx").on(table.vaId, table.responseRequired, table.respondedAt),
]);

export const complianceCardEvidence = pgTable("compliance_card_evidence", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId"),
  snapshotDate: date("snapshotDate").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  boardName: varchar("boardName", { length: 256 }).notNull().default(""),
  listName: varchar("listName", { length: 256 }).notNull().default(""),
  category: varchar("category", { length: 16 }).notNull(),
  assignedToJoyce: boolean("assignedToJoyce").notNull().default(true),
  assignedToWorker: boolean("assignedToWorker").notNull().default(true),
  compliant: boolean("compliant").notNull().default(false),
  evidenceType: varchar("evidenceType", { length: 32 }).notNull().default("none"),
  evidenceActionId: varchar("evidenceActionId", { length: 64 }),
  evidenceAt: timestamp("evidenceAt"),
  evidenceJson: text("evidenceJson").notNull(),
  verifiedAt: timestamp("verifiedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("compliance_evidence_va_date_card_unique").on(table.vaId, table.snapshotDate, table.cardId),
  index("compliance_evidence_va_card_date_idx").on(table.vaId, table.cardId, table.snapshotDate),
  index("compliance_evidence_va_date_compliant_idx").on(table.vaId, table.snapshotDate, table.compliant),
]);

export const complianceCommunicationEvidence = pgTable("compliance_communication_evidence", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId"),
  snapshotDate: date("snapshotDate").notNull(),
  evidenceKey: varchar("evidenceKey", { length: 256 }).notNull(),
  kind: enumText("kind", ["message_response", "email_processing"]).notNull(),
  channel: varchar("channel", { length: 64 }).notNull(),
  externalId: varchar("externalId", { length: 256 }).notNull(),
  title: varchar("title", { length: 1024 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 1024 }),
  occurredAt: timestamp("occurredAt").notNull(),
  dueAt: timestamp("dueAt"),
  outcome: enumText("outcome", ["verified", "missed", "needs_clarification", "excluded"]).notNull(),
  evidenceType: varchar("evidenceType", { length: 64 }).notNull(),
  evidenceAt: timestamp("evidenceAt"),
  evidenceJson: text("evidenceJson").notNull(),
  verifiedAt: timestamp("verifiedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("compliance_comm_va_date_key_unique").on(table.vaId, table.snapshotDate, table.evidenceKey),
  index("compliance_comm_va_date_kind_outcome_idx").on(table.vaId, table.snapshotDate, table.kind, table.outcome),
  index("compliance_comm_va_external_idx").on(table.vaId, table.channel, table.externalId),
]);

export const complianceClarificationRequests = pgTable("compliance_clarification_requests", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId"),
  snapshotDate: date("snapshotDate").notNull(),
  evidenceKey: varchar("evidenceKey", { length: 256 }).notNull(),
  kind: enumText("kind", ["message_response", "email_processing"]).notNull(),
  channel: varchar("channel", { length: 64 }).notNull(),
  externalId: varchar("externalId", { length: 256 }).notNull(),
  title: varchar("title", { length: 1024 }).notNull(),
  question: text("question").notNull(),
  status: enumText("status", ["open", "resolved", "superseded"]).notNull().default("open"),
  resolution: enumText("resolution", ["completed", "not_completed", "not_required"]),
  response: text("response"),
  requestedAt: timestamp("requestedAt").defaultNow().notNull(),
  respondedAt: timestamp("respondedAt"),
  resolvedAt: timestamp("resolvedAt"),
  sourceJson: text("sourceJson").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("compliance_clarification_va_date_key_unique").on(table.vaId, table.snapshotDate, table.evidenceKey),
  index("compliance_clarification_va_status_requested_idx").on(table.vaId, table.status, table.requestedAt),
]);

export const timeEntryEvents = pgTable(
  "time_entry_events",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    timeEntryId: integer("timeEntryId").notNull(),
    eventType: varchar("eventType", { length: 32 }).notNull(),
    reason: text("reason"),
    beforeJson: text("beforeJson"),
    afterJson: text("afterJson"),
    metadataJson: text("metadataJson"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("time_entry_events_entry_created_idx").on(
      table.timeEntryId,
      table.createdAt
    ),
    index("time_entry_events_type_created_idx").on(
      table.eventType,
      table.createdAt
    ),
  ]
);

export const timeDayReviews = pgTable(
  "time_day_reviews",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    dateKey: varchar("dateKey", { length: 16 }).notNull().unique(),
    status: enumText("status", ["open", "needs_review", "locked"])
      .notNull()
      .default("open"),
    overtimeReason: text("overtimeReason"),
    summaryJson: text("summaryJson"),
    lockedAt: timestamp("lockedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [
    index("time_day_reviews_status_date_idx").on(table.status, table.dateKey),
  ]
);

export const timeReconciliationItems = pgTable(
  "time_reconciliation_items",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    dateKey: varchar("dateKey", { length: 16 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 256 }).notNull().unique(),
    type: varchar("type", { length: 48 }).notNull(),
    severity: enumText("severity", ["low", "medium", "high"])
      .notNull()
      .default("medium"),
    status: enumText("status", ["open", "resolved", "dismissed", "superseded"])
      .notNull()
      .default("open"),
    cardId: varchar("cardId", { length: 64 }),
    cardName: varchar("cardName", { length: 512 }),
    cardUrl: varchar("cardUrl", { length: 1024 }),
    boardName: varchar("boardName", { length: 256 }),
    listName: varchar("listName", { length: 256 }),
    timeEntryId: integer("timeEntryId"),
    planBlockId: varchar("planBlockId", { length: 128 }),
    title: varchar("title", { length: 512 }).notNull(),
    detail: text("detail").notNull(),
    sourceJson: text("sourceJson").notNull(),
    resolution: text("resolution"),
    resolvedAt: timestamp("resolvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [
    index("time_reconciliation_date_status_idx").on(
      table.dateKey,
      table.status
    ),
    index("time_reconciliation_entry_idx").on(table.timeEntryId),
  ]
);

export const scheduledJobRuns = pgTable(
  "scheduled_job_runs",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    jobKey: varchar("jobKey", { length: 96 }).notNull(),
    trigger: enumText("trigger", ["cron", "external", "manual"])
      .notNull()
      .default("cron"),
    status: enumText("status", ["running", "success", "error", "abandoned"])
      .notNull()
      .default("running"),
    startedAt: timestamp("startedAt").notNull(),
    finishedAt: timestamp("finishedAt"),
    durationMs: integer("durationMs"),
    recordsProcessed: integer("recordsProcessed").notNull().default(0),
    detail: text("detail"),
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("scheduled_job_runs_job_started_idx").on(
      table.jobKey,
      table.startedAt
    ),
    index("scheduled_job_runs_status_started_idx").on(
      table.status,
      table.startedAt
    ),
  ]
);

export const scheduledJobLeases = pgTable(
  "scheduled_job_leases",
  {
    jobKey: varchar("jobKey", { length: 96 }).primaryKey(),
    ownerToken: varchar("ownerToken", { length: 64 }).notNull(),
    acquiredAt: timestamp("acquiredAt").notNull(),
    heartbeatAt: timestamp("heartbeatAt").notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
  },
  table => [index("scheduled_job_leases_expiry_idx").on(table.leaseExpiresAt)]
);

export const browserTabStates = pgTable("browser_tab_states", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  collectorId: varchar("collectorId", { length: 128 }).notNull().unique(),
  captureSequence: bigint("captureSequence", { mode: "number" }).notNull().default(0),
  sourceCapturedAt: timestamp("sourceCapturedAt"),
  collectorLabel: varchar("collectorLabel", { length: 128 }).notNull().default("Worker browser"),
  totalTabs: integer("totalTabs").notNull().default(0),
  pinnedTabs: integer("pinnedTabs").notNull().default(0),
  windowCount: integer("windowCount").notNull().default(0),
  tabsJson: text("tabsJson").notNull(),
  capturedAt: timestamp("capturedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  index("browser_tab_states_va_captured_idx").on(table.vaId, table.capturedAt),
  index("browser_tab_states_captured_idx").on(table.capturedAt),
]);

export const browserTabDailyEvidence = pgTable(
  "browser_tab_daily_evidence",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    vaId: integer("vaId").notNull(),
    snapshotDate: date("snapshotDate", { mode: "date" }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    totalTabs: integer("totalTabs").notNull().default(0),
    actionableTabs: integer("actionableTabs").notNull().default(0),
    allowedTabs: integer("allowedTabs").notNull().default(0),
    compliant: boolean("compliant").notNull().default(false),
    source: varchar("source", { length: 32 }).notNull().default("auto"),
    evidenceJson: text("evidenceJson").notNull(),
    capturedAt: timestamp("capturedAt"),
    verifiedAt: timestamp("verifiedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
  },
  table => [
    uniqueIndex("browser_tab_daily_va_date_idx").on(
      table.vaId,
      table.snapshotDate
    ),
    index("browser_tab_daily_status_date_idx").on(
      table.status,
      table.snapshotDate
    ),
  ]
);

export const atisChecklistCompletion = pgTable('atis_checklist_completion', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  cardId: integer('card_id').notNull(),
  stepIndex: integer('step_index').notNull(),
  userId: integer('user_id').notNull(),
  completedAt: timestamp('completed_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('card_step_user_unique').on(table.cardId, table.stepIndex, table.userId),
  index('atis_checklist_user_completed_idx').on(table.userId, table.completedAt),
]);

export const atisChecklistSync = pgTable(
  "atis_checklist_sync",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    trelloCardId: varchar("trello_card_id", { length: 255 }).notNull(),
    trelloChecklistId: varchar("trello_checklist_id", { length: 255 }),
    itemsSynced: integer("items_synced").default(0),
    syncedAt: timestamp("synced_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  table => [
    uniqueIndex("atis_checklist_sync_card_unique").on(table.trelloCardId),
  ],
);

export const atisChatbotConversations = pgTable(
  "atis_chatbot_conversations",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    cardId: integer("card_id").notNull(),
    commentId: integer("comment_id"),
    platform: varchar("platform", { length: 20 }).notNull(),
    url: varchar("url", { length: 500 }).notNull(),
    title: varchar("title", { length: 500 }),
    messagesJson: text("messages_json"),
    fullContent: text("full_content"),
    extractedAt: timestamp("extracted_at").defaultNow(),
  },
  table => [
    uniqueIndex("atis_chatbot_conversations_url_unique").on(table.url),
    index("atis_chatbot_conversations_card_idx").on(table.cardId),
    index("atis_chatbot_conversations_platform_idx").on(table.platform),
  ],
);

export type AptlssPlan = typeof aptlssPlans.$inferSelect;
export type InsertAptlssPlan = typeof aptlssPlans.$inferInsert;
export type AptlssStep = typeof aptlssSteps.$inferSelect;
export type InsertAptlssStep = typeof aptlssSteps.$inferInsert;
export type CardState = typeof cardStates.$inferSelect;
export type InsertCardState = typeof cardStates.$inferInsert;
export type PriorityScore = typeof priorityScores.$inferSelect;
export type InsertPriorityScore = typeof priorityScores.$inferInsert;
export type AptlssOperationalPolicy =
  typeof aptlssOperationalPolicies.$inferSelect;
export type InsertAptlssOperationalPolicy =
  typeof aptlssOperationalPolicies.$inferInsert;
export type WorkerPerformanceSignal =
  typeof workerPerformanceSignals.$inferSelect;
export type InsertWorkerPerformanceSignal =
  typeof workerPerformanceSignals.$inferInsert;
export type WeeklyAnalysisSnapshot =
  typeof weeklyAnalysisSnapshots.$inferSelect;
export type InsertWeeklyAnalysisSnapshot =
  typeof weeklyAnalysisSnapshots.$inferInsert;
export type AutoFollowUpDraft = typeof autoFollowUpDrafts.$inferSelect;
export type InsertAutoFollowUpDraft = typeof autoFollowUpDrafts.$inferInsert;
export type DailyPlan = typeof dailyPlans.$inferSelect;
export type InsertDailyPlan = typeof dailyPlans.$inferInsert;
export type AptlssAuditLog = typeof aptlssAuditLog.$inferSelect;
export type InsertAptlssAuditLog = typeof aptlssAuditLog.$inferInsert;
export type AdminSyncLog = typeof adminSyncLog.$inferSelect;
export type InsertAdminSyncLog = typeof adminSyncLog.$inferInsert;
export type AptlssAssessment = typeof aptlssAssessments.$inferSelect;
export type InsertAptlssAssessment = typeof aptlssAssessments.$inferInsert;
export type AptlssAssessmentFeedback =
  typeof aptlssAssessmentFeedback.$inferSelect;
export type InsertAptlssAssessmentFeedback =
  typeof aptlssAssessmentFeedback.$inferInsert;
export type AptlssWaitingReason = typeof aptlssWaitingReasons.$inferSelect;
export type InsertAptlssWaitingReason =
  typeof aptlssWaitingReasons.$inferInsert;
export type DecisionOutcome = typeof decisionOutcomes.$inferSelect;
export type InsertDecisionOutcome = typeof decisionOutcomes.$inferInsert;
export type WorkspaceEvidenceItem = typeof workspaceEvidenceItems.$inferSelect;
export type InsertWorkspaceEvidenceItem =
  typeof workspaceEvidenceItems.$inferInsert;
export type WorkspaceEvidenceLink = typeof workspaceEvidenceLinks.$inferSelect;
export type InsertWorkspaceEvidenceLink =
  typeof workspaceEvidenceLinks.$inferInsert;
export type AptlssEvidenceRevision =
  typeof aptlssEvidenceRevisions.$inferSelect;
export type InsertAptlssEvidenceRevision =
  typeof aptlssEvidenceRevisions.$inferInsert;
export type AptlssEvidenceSubjectLink =
  typeof aptlssEvidenceSubjectLinks.$inferSelect;
export type InsertAptlssEvidenceSubjectLink =
  typeof aptlssEvidenceSubjectLinks.$inferInsert;
export type AptlssEvidenceConflict =
  typeof aptlssEvidenceConflicts.$inferSelect;
export type InsertAptlssEvidenceConflict =
  typeof aptlssEvidenceConflicts.$inferInsert;
export type AptlssVerificationFollowup =
  typeof aptlssVerificationFollowups.$inferSelect;
export type InsertAptlssVerificationFollowup =
  typeof aptlssVerificationFollowups.$inferInsert;
export type CommunicationEvidence = typeof communicationEvidence.$inferSelect;
export type InsertCommunicationEvidence =
  typeof communicationEvidence.$inferInsert;
export type ComplianceCardEvidence = typeof complianceCardEvidence.$inferSelect;
export type InsertComplianceCardEvidence =
  typeof complianceCardEvidence.$inferInsert;
export type ComplianceCommunicationEvidence =
  typeof complianceCommunicationEvidence.$inferSelect;
export type InsertComplianceCommunicationEvidence =
  typeof complianceCommunicationEvidence.$inferInsert;
export type ComplianceClarificationRequest =
  typeof complianceClarificationRequests.$inferSelect;
export type InsertComplianceClarificationRequest =
  typeof complianceClarificationRequests.$inferInsert;
export type TimeEntryEvent = typeof timeEntryEvents.$inferSelect;
export type InsertTimeEntryEvent = typeof timeEntryEvents.$inferInsert;
export type TimeDayReview = typeof timeDayReviews.$inferSelect;
export type InsertTimeDayReview = typeof timeDayReviews.$inferInsert;
export type TimeReconciliationItem =
  typeof timeReconciliationItems.$inferSelect;
export type InsertTimeReconciliationItem =
  typeof timeReconciliationItems.$inferInsert;
export type ScheduledJobRun = typeof scheduledJobRuns.$inferSelect;
export type InsertScheduledJobRun = typeof scheduledJobRuns.$inferInsert;
export type ScheduledJobLease = typeof scheduledJobLeases.$inferSelect;
export type InsertScheduledJobLease = typeof scheduledJobLeases.$inferInsert;
export type BrowserTabState = typeof browserTabStates.$inferSelect;
export type InsertBrowserTabState = typeof browserTabStates.$inferInsert;
export type BrowserTabDailyEvidence =
  typeof browserTabDailyEvidence.$inferSelect;
export type InsertBrowserTabDailyEvidence =
  typeof browserTabDailyEvidence.$inferInsert;
export type UnsignedMessageFlag = typeof unsignedMessageFlags.$inferSelect;
export type InsertUnsignedMessageFlag =
  typeof unsignedMessageFlags.$inferInsert;


export const revokedSessions = pgTable("revoked_sessions", {
  sessionHash: varchar("sessionHash", { length: 64 }).primaryKey(),
  revokedAt: timestamp("revokedAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
}, (table) => ({
  expiresAtIdx: index("revoked_sessions_expires_at_idx").on(table.expiresAt),
}));

export const workerInvitations = pgTable('worker_invitations', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  userId: integer('userId').notNull(),
  vaId: integer('vaId').notNull(),
  founderId: integer('founderId').notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  tokenHash: varchar('tokenHash', { length: 64 }).notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  sentAt: timestamp('sentAt'),
  acceptedAt: timestamp('acceptedAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => ({
  tokenHashUnique: uniqueIndex('worker_invitations_token_hash_unique').on(table.tokenHash),
  userStatusIdx: index('worker_invitations_user_status_idx').on(table.userId, table.acceptedAt, table.revokedAt),
  founderCreatedIdx: index('worker_invitations_founder_created_idx').on(table.founderId, table.createdAt),
}));

export const commitments = pgTable('commitments', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  workspaceOwnerId: integer('workspaceOwnerId').notNull(),
  assignedUserId: integer('assignedUserId'),
  createdByUserId: integer('createdByUserId').notNull(),
  sourceType: enumText('sourceType', ['manual', 'trello', 'gmail', 'google_drive', 'system']).notNull(),
  sourceId: varchar('sourceId', { length: 255 }),
  sourceUrl: varchar('sourceUrl', { length: 1024 }),
  title: varchar('title', { length: 500 }).notNull(),
  context: text('context'),
  dueAt: timestamp('dueAt').notNull(),
  status: enumText('status', ['open', 'completed', 'cancelled']).default('open').notNull(),
  completedAt: timestamp('completedAt'),
  cancelledAt: timestamp('cancelledAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex('commitments_workspace_source_unique').on(table.workspaceOwnerId, table.sourceType, table.sourceId),
  index('commitments_workspace_status_due_idx').on(table.workspaceOwnerId, table.status, table.dueAt),
  index('commitments_assignee_status_due_idx').on(table.assignedUserId, table.status, table.dueAt),
]);

export const reminderRules = pgTable('reminder_rules', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  workspaceOwnerId: integer('workspaceOwnerId').notNull(),
  createdByUserId: integer('createdByUserId').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  triggerType: enumText('triggerType', ['before_due', 'at_due', 'after_due', 'no_update', 'manual']).default('before_due').notNull(),
  offsetMinutes: integer('offsetMinutes').default(60).notNull(),
  channel: enumText('channel', ['in_app', 'email']).default('in_app').notNull(),
  requireApproval: boolean('requireApproval').default(true).notNull(),
  maxAttempts: integer('maxAttempts').default(1).notNull(),
  cooldownMinutes: integer('cooldownMinutes').default(60).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  index('reminder_rules_workspace_active_idx').on(table.workspaceOwnerId, table.active),
]);

export const reminderPolicies = pgTable('reminder_policies', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  userId: integer('userId').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  inAppEnabled: boolean('inAppEnabled').default(true).notNull(),
  emailEnabled: boolean('emailEnabled').default(false).notNull(),
  maxPerDay: integer('maxPerDay').default(3).notNull(),
  minIntervalMinutes: integer('minIntervalMinutes').default(60).notNull(),
  quietHoursStart: varchar('quietHoursStart', { length: 5 }).default('22:00').notNull(),
  quietHoursEnd: varchar('quietHoursEnd', { length: 5 }).default('08:00').notNull(),
  timezone: varchar('timezone', { length: 64 }).default('UTC').notNull(),
  allowWeekends: boolean('allowWeekends').default(false).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex('reminder_policies_user_unique').on(table.userId),
]);

export const reminderSchedules = pgTable('reminder_schedules', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  commitmentId: integer('commitmentId').notNull(),
  ruleId: integer('ruleId').notNull(),
  recipientUserId: integer('recipientUserId').notNull(),
  scheduledFor: timestamp('scheduledFor').notNull(),
  state: enumText('state', [
    'scheduled',
    'preparing',
    'draft_ready',
    'sending',
    'sent',
    'failed',
    'needs_review',
    'escalated',
    'skipped',
    'cancelled',
  ]).default('scheduled').notNull(),
  channel: enumText('channel', ['in_app', 'email']).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 64 }).notNull(),
  draftTitle: varchar('draftTitle', { length: 500 }),
  draftContent: text('draftContent'),
  policyReason: text('policyReason'),
  attemptCount: integer('attemptCount').default(0).notNull(),
  lastAttemptAt: timestamp('lastAttemptAt'),
  approvedAt: timestamp('approvedAt'),
  approvedByUserId: integer('approvedByUserId'),
  sentAt: timestamp('sentAt'),
  escalatedAt: timestamp('escalatedAt'),
  error: text('error'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex('reminder_schedules_idempotency_unique').on(table.idempotencyKey),
  index('reminder_schedules_due_state_idx').on(table.state, table.scheduledFor),
  index('reminder_schedules_recipient_state_idx').on(table.recipientUserId, table.state, table.scheduledFor),
  index('reminder_schedules_commitment_idx').on(table.commitmentId),
]);

export const reminderAuditEvents = pgTable('reminder_audit_events', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  workspaceOwnerId: integer('workspaceOwnerId').notNull(),
  commitmentId: integer('commitmentId'),
  scheduleId: integer('scheduleId'),
  actorUserId: integer('actorUserId'),
  eventType: varchar('eventType', { length: 64 }).notNull(),
  detailsJson: text('detailsJson'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, (table) => [
  index('reminder_audit_workspace_created_idx').on(table.workspaceOwnerId, table.createdAt),
  index('reminder_audit_commitment_created_idx').on(table.commitmentId, table.createdAt),
  index('reminder_audit_schedule_created_idx').on(table.scheduleId, table.createdAt),
]);

export const haiConnectorTokens = pgTable('hai_connector_tokens', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  workspaceOwnerId: integer('workspaceOwnerId').notNull(),
  createdByUserId: integer('createdByUserId').notNull(),
  label: varchar('label', { length: 128 }).default('HAI Worker Control').notNull(),
  tokenPrefix: varchar('tokenPrefix', { length: 24 }).notNull(),
  tokenHash: varchar('tokenHash', { length: 64 }).notNull(),
  scopes: varchar('scopes', { length: 255 }).default('worker_control:read').notNull(),
  lastUsedAt: timestamp('lastUsedAt'),
  expiresAt: timestamp('expiresAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().$onUpdateFn(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex('hai_connector_tokens_hash_unique').on(table.tokenHash),
  index('hai_connector_tokens_owner_active_idx').on(table.workspaceOwnerId, table.revokedAt, table.createdAt),
]);

export const founderDecisionDeadlines = pgTable("founder_decision_deadlines", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  stepId: integer("stepId").notNull(),
  dueAt: timestamp("dueAt"),
  source: varchar("source", { length: 1024 }).notNull(),
  recordedBy: varchar("recordedBy", { length: 64 }).notNull(),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
}, (table) => [
  index("founder_decision_deadlines_step_idx").on(table.stepId, table.id),
]);

export const maintenanceJobSettings = pgTable("maintenance_job_settings", {
  jobKey: varchar("jobKey", { length: 96 }).primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  intervalMinutes: integer("intervalMinutes").notNull(),
  lastScheduledAt: timestamp("lastScheduledAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
});

export const aptlssManagerState = pgTable("aptlss_manager_state", {
  vaId: integer("vaId").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  intervalMinutes: integer("intervalMinutes").notNull().default(5),
  mode: enumText("mode", ["shadow", "active"]).notNull().default("shadow"),
  policyRevision: integer("policyRevision").notNull().default(0),
  shadowStartedAt: timestamp("shadowStartedAt").defaultNow().notNull(),
  lastSuccessfulAt: timestamp("lastSuccessfulAt"),
  checkedAt: timestamp("checkedAt"),
  inputHash: varchar("inputHash", { length: 64 }),
  sourceHash: varchar("sourceHash", { length: 64 }),
  currentCheckId: integer("currentCheckId"),
  historyScopeHash: varchar("historyScopeHash", { length: 64 }),
  lastError: varchar("lastError", { length: 512 }),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
});

export const aptlssManagerUpdates = pgTable("aptlss_manager_updates", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  detail: text("detail").notNull(),
  interventionId: varchar("interventionId", { length: 256 }),
  reportKind: varchar("reportKind", { length: 24 }).default("update").notNull(),
  actionId: varchar("actionId", { length: 256 }),
  assessmentRunId: integer("assessmentRunId"),
  requestKey: varchar("requestKey", { length: 36 }),
  outcome: varchar("outcome", { length: 32 }),
  deadlineDate: varchar("deadlineDate", { length: 10 }),
  sourceEvidenceId: varchar("sourceEvidenceId", { length: 256 }),
  sourceDescription: varchar("sourceDescription", { length: 512 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("aptlss_manager_updates_worker_card_idx").on(table.vaId, table.cardId, table.createdAt),
  uniqueIndex("aptlss_manager_updates_request_unique").on(table.vaId, table.requestKey),
]);

export const aptlssManagerRuns = pgTable("aptlss_manager_runs", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  inputHash: varchar("inputHash", { length: 64 }).notNull(),
  trigger: varchar("trigger", { length: 32 }).notNull(),
  mode: enumText("mode", ["shadow", "active"]).notNull().default("shadow"),
  proposalHash: varchar("proposalHash", { length: 64 }),
  previousPlanJson: text("previousPlanJson"),
  appliedPlanHash: varchar("appliedPlanHash", { length: 64 }),
  snapshotJson: text("snapshotJson").notNull(),
  reviewDigest: varchar("reviewDigest", { length: 64 }).generatedAlwaysAs(sql`("snapshotJson"::jsonb ->> 'implementationDigest')`),
  reviewUrgent: boolean("reviewUrgent").generatedAlwaysAs(sql`("snapshotJson"::jsonb @> '{"interventions":[{"severity":"urgent"}]}'::jsonb)`),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("aptlss_manager_runs_worker_created_idx").on(table.vaId, table.createdAt, table.id),
  index("aptlss_manager_runs_proposal_idx").on(table.vaId, table.proposalHash, table.createdAt, table.id),
  index("aptlss_manager_runs_review_idx").on(table.vaId, table.reviewDigest, table.proposalHash, table.mode, table.createdAt, table.id, table.reviewUrgent),
]);

export const aptlssManagerChecks = pgTable("aptlss_manager_checks", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  runId: integer("runId").notNull(),
  inputHash: varchar("inputHash", { length: 64 }).notNull(),
  sourceHash: varchar("sourceHash", { length: 64 }).notNull(),
  baseSnapshotHash: varchar("baseSnapshotHash", { length: 64 }).notNull(),
  snapshotHash: varchar("snapshotHash", { length: 64 }).notNull(),
  snapshotPatchJson: text("snapshotPatchJson").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("aptlss_manager_checks_worker_idx").on(table.vaId, table.id),
  index("aptlss_manager_checks_run_idx").on(table.runId, table.id),
  foreignKey({ columns: [table.runId], foreignColumns: [aptlssManagerRuns.id], name: "manager_check_run_fk" }),
]);

export const aptlssManagerReviews = pgTable("aptlss_manager_reviews", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  runId: integer("runId").notNull(),
  proposalHash: varchar("proposalHash", { length: 64 }).notNull(),
  verdict: enumText("verdict", ["correct", "incorrect", "insufficient"]).notNull(),
  critical: boolean("critical").notNull().default(false),
  correction: text("correction").notNull(),
  source: text("source").notNull(),
  reviewerId: integer("reviewerId").notNull(),
  reviewedAt: timestamp("reviewedAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("aptlss_manager_review_run_unique").on(table.runId),
  index("aptlss_manager_review_worker_idx").on(table.vaId, table.reviewedAt),
  index("aptlss_manager_reviews_proposal_idx").on(table.vaId, table.proposalHash, table.runId),
  foreignKey({ columns: [table.runId], foreignColumns: [aptlssManagerRuns.id], name: "manager_review_run_fk" }),
]);

export const aptlssManagerControl = pgTable("aptlss_manager_control", {
  id: integer("id").primaryKey(),
  activeVaId: integer("activeVaId"),
  updatedAt: timestamp("updatedAt").defaultNow().$onUpdateFn(() => new Date()).notNull(),
});

export const aptlssManagerTrialEvents = pgTable("aptlss_manager_trial_events", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  trialKey: varchar("trialKey", { length: 64 }).notNull(),
  event: enumText("event", ["started", "closed"]).notNull(),
  afterRunId: integer("afterRunId").notNull(),
  implementationDigest: varchar("implementationDigest", { length: 64 }).notNull(),
  actorId: integer("actorId").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("aptlss_manager_trial_event_unique").on(table.vaId, table.trialKey, table.event),
  index("aptlss_manager_trial_worker_idx").on(table.vaId, table.id),
]);

export const aptlssManagerCorrections = pgTable("aptlss_manager_corrections", {
  id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
  vaId: integer("vaId").notNull(),
  reviewId: integer("reviewId").notNull(),
  scope: enumText("scope", ["card", "worker"]).notNull().default("card"),
  cardId: varchar("cardId", { length: 64 }),
  topic: varchar("topic", { length: 64 }).notNull(),
  correction: text("correction").notNull(),
  conditionsJson: text("conditionsJson").notNull(),
  evidenceJson: text("evidenceJson").notNull(),
  validFrom: timestamp("validFrom").notNull(),
  validUntil: timestamp("validUntil").notNull(),
  createdBy: integer("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  revokedAt: timestamp("revokedAt"),
  revokedBy: integer("revokedBy"),
  revocationReason: text("revocationReason"),
}, table => [
  uniqueIndex("aptlss_manager_correction_review_unique").on(table.reviewId),
  index("aptlss_manager_correction_scope_idx").on(table.vaId, table.scope, table.cardId, table.validUntil),
  foreignKey({ columns: [table.reviewId], foreignColumns: [aptlssManagerReviews.id], name: "manager_correction_review_fk" }),
]);

export const aptlssManagerQueue = pgTable(
  "aptlss_manager_queue",
  {
    vaId: integer("vaId").primaryKey(),
    state: enumText("state", ["idle", "pending", "leased", "failed"])
      .notNull()
      .default("idle"),
    generation: integer("generation").notNull().default(0),
    claimedGeneration: integer("claimedGeneration").notNull().default(0),
    priority: integer("priority").notNull().default(0),
    trigger: varchar("trigger", { length: 40 }).notNull().default("periodic"),
    availableAt: timestamp("availableAt", { precision: 3 }).notNull().defaultNow(),
    requestedAt: timestamp("requestedAt", { precision: 3 }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: varchar("leaseToken", { length: 64 }),
    leaseUntil: timestamp("leaseUntil", { precision: 3 }),
    lastError: varchar("lastError", { length: 255 }),
    completedAt: timestamp("completedAt", { precision: 3 }),
    updatedAt: timestamp("updatedAt", { precision: 3 })
      .notNull()
      .defaultNow(),
  },
  t => [
    index("manager_queue_ready_idx").on(t.state, t.availableAt, t.priority),
    index("manager_queue_lease_idx").on(t.state, t.leaseUntil),
  ]
);

export const aptlssManagerQueueEvents = pgTable(
  "aptlss_manager_queue_events",
  {
    eventHash: varchar("eventHash", { length: 64 }).primaryKey(),
    vaId: integer("vaId").notNull(),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  t => [index("manager_queue_event_worker_idx").on(t.vaId, t.createdAt)]
);

export const aptlssManagerQueueSlots = pgTable(
  "aptlss_manager_queue_slots",
  {
    id: integer("id").primaryKey(),
    vaId: integer("vaId"),
    token: varchar("token", { length: 64 }),
    leaseUntil: timestamp("leaseUntil", { precision: 3 }),
  }
);

export type WorkerInvitation = typeof workerInvitations.$inferSelect;
export type InsertWorkerInvitation = typeof workerInvitations.$inferInsert;
export type Commitment = typeof commitments.$inferSelect;
export type InsertCommitment = typeof commitments.$inferInsert;
export type ReminderRule = typeof reminderRules.$inferSelect;
export type InsertReminderRule = typeof reminderRules.$inferInsert;
export type ReminderPolicy = typeof reminderPolicies.$inferSelect;
export type InsertReminderPolicy = typeof reminderPolicies.$inferInsert;
export type ReminderSchedule = typeof reminderSchedules.$inferSelect;
export type InsertReminderSchedule = typeof reminderSchedules.$inferInsert;
export type ReminderAuditEvent = typeof reminderAuditEvents.$inferSelect;
export type InsertReminderAuditEvent = typeof reminderAuditEvents.$inferInsert;
export type HaiConnectorToken = typeof haiConnectorTokens.$inferSelect;
export type InsertHaiConnectorToken = typeof haiConnectorTokens.$inferInsert;
export type MaintenanceJobSetting = typeof maintenanceJobSettings.$inferSelect;
export type InsertMaintenanceJobSetting = typeof maintenanceJobSettings.$inferInsert;

// Explicit exports keep Drizzle migration metadata aware of additive feature enums.
export const pgFeatureEnum1 = pgEnum("enum_disposition_1i5lqtm", ["recorded","approved","rejected"]);
export const pgFeatureEnum2 = pgEnum("enum_sourcetype_sc6x9c", ["manual","trello","gmail","google_drive","system"]);
export const pgFeatureEnum3 = pgEnum("enum_status_80la47", ["open","completed","cancelled"]);
export const pgFeatureEnum4 = pgEnum("enum_triggertype_1e5pmd7", ["before_due","at_due","after_due","no_update","manual"]);
export const pgFeatureEnum5 = pgEnum("enum_channel_bw44qm", ["in_app","email"]);
export const pgFeatureEnum6 = pgEnum("enum_state_wxzr3j", ["scheduled","preparing","draft_ready","sending","sent","failed","needs_review","escalated","skipped","cancelled"]);
export const pgFeatureEnum7 = pgEnum("enum_mode_1k2zd19", ["shadow","active"]);
export const pgFeatureEnum8 = pgEnum("enum_verdict_19ukde9", ["correct","incorrect","insufficient"]);
export const pgFeatureEnum9 = pgEnum("enum_event_axqosm", ["started","closed"]);
export const pgFeatureEnum10 = pgEnum("enum_scope_hwjjq7", ["card","worker"]);
export const pgFeatureEnum11 = pgEnum("enum_state_iy851n", ["idle","pending","leased","failed"]);
