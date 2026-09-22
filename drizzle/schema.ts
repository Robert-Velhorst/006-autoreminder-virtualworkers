import { int, mysqlEnum, mysqlTable, text, longtext, mediumtext, timestamp, varchar, decimal, boolean, date, uniqueIndex, index, foreignKey } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Unique identifier — for local auth this is the username/email, kept as openId for compatibility. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin", "worker"]).default("user").notNull(),
  /** bcrypt hash of the user's password (local auth only) */
  passwordHash: varchar("passwordHash", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Generation history tables
export const generationJobs = mysqlTable('generation_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  totalCards: int('totalCards').notNull(),
  completedCards: int('completedCards').notNull().default(0),
  failedCards: int('failedCards').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull(),
  settings: text('settings'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
  createdBy: varchar('createdBy', { length: 64 }).notNull(),
});

export const generationItems = mysqlTable('generation_items', {
  id: varchar('id', { length: 64 }).primaryKey(),
  jobId: varchar('jobId', { length: 64 }).notNull(),
  cardId: varchar('cardId', { length: 64 }).notNull(),
  cardName: text('cardName').notNull(),
  boardName: varchar('boardName', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull(),
  attempts: int('attempts').notNull().default(0),
  maxAttempts: int('maxAttempts').notNull().default(3),
  error: text('error'),
  result: text('result'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export type GenerationJob = typeof generationJobs.$inferSelect;
export type InsertGenerationJob = typeof generationJobs.$inferInsert;
export type GenerationItem = typeof generationItems.$inferSelect;
export type InsertGenerationItem = typeof generationItems.$inferInsert;

// Scheduled jobs table
export const scheduledJobs = mysqlTable('scheduled_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  cardIds: text('cardIds').notNull(), // JSON string array
  scheduledTime: timestamp('scheduledTime').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending, running, completed, failed, cancelled
  settings: text('settings').notNull(), // JSON string
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
  error: text('error'),
  createdBy: varchar('createdBy', { length: 64 }).notNull(),
});

export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type InsertScheduledJob = typeof scheduledJobs.$inferInsert;

// User working hours settings table
export const userWorkingHours = mysqlTable('user_working_hours', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('userId').notNull(), // References users.id
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(), // References users.openId for easier lookup
  workStartHour: int('workStartHour').notNull().default(9), // 0-23
  workStartMinute: int('workStartMinute').notNull().default(0), // 0-59
  workEndHour: int('workEndHour').notNull().default(18), // 0-23
  workEndMinute: int('workEndMinute').notNull().default(0), // 0-59
  breakfastTime: varchar('breakfastTime', { length: 5 }).default('09:00'), // HH:MM format
  breakfastDuration: int('breakfastDuration').notNull().default(45), // minutes
  lunchTime: varchar('lunchTime', { length: 5 }).default('15:00'), // HH:MM format
  lunchDuration: int('lunchDuration').notNull().default(45), // minutes
  dinnerTime: varchar('dinnerTime', { length: 5 }).default('20:00'), // HH:MM format
  dinnerDuration: int('dinnerDuration').notNull().default(120), // minutes
  enableBreaks: int('enableBreaks').notNull().default(1), // 0=false, 1=true (MySQL doesn't have boolean)
  shortBreakInterval: int('shortBreakInterval').notNull().default(120), // minutes of work before short break
  shortBreakDuration: int('shortBreakDuration').notNull().default(10), // minutes
  longBreakInterval: int('longBreakInterval').notNull().default(240), // minutes of work before long break
  longBreakDuration: int('longBreakDuration').notNull().default(30), // minutes
  // Working days configuration
  workingDays: varchar('workingDays', { length: 50 }).notNull().default('1,2,3,4,5'), // Comma-separated: 0=Sun, 1=Mon, ..., 6=Sat
  // Timezone support
  timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'), // IANA timezone (e.g., 'America/New_York', 'Europe/Amsterdam')
  // Weekly hours target (for scheduling optimization)
  weeklyHoursMin: int('weeklyHoursMin').notNull().default(40), // Minimum target hours per week
  weeklyHoursMax: int('weeklyHoursMax').notNull().default(45), // Maximum target hours per week
  // Daily hours flexibility (allows scheduling to vary day-to-day)
  dailyHoursMin: decimal('dailyHoursMin', { precision: 4, scale: 2 }).notNull().default('8.00'), // Minimum hours per day (e.g., 9.5)
  dailyHoursMax: decimal('dailyHoursMax', { precision: 4, scale: 2 }).notNull().default('9.00'), // Maximum hours per day (e.g., 11.5)
  // Holiday integration
  country: varchar('country', { length: 2 }).notNull().default('US'), // ISO 3166-1 alpha-2 country code for holidays
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export type UserWorkingHours = typeof userWorkingHours.$inferSelect;
export type InsertUserWorkingHours = typeof userWorkingHours.$inferInsert;

// Holidays table for country-specific holidays
export const holidays = mysqlTable('holidays', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 255 }).notNull(),
  date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD format
  name: varchar('name', { length: 255 }).notNull(),
  country: varchar('country', { length: 2 }).notNull(), // ISO 3166-1 alpha-2 country code
  isActive: int('isActive').notNull().default(1), // 0=disabled, 1=enabled
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

export type Holiday = typeof holidays.$inferSelect;
export type InsertHoliday = typeof holidays.$inferInsert;

// Trello data cache tables
export const trelloCacheMetadata = mysqlTable('trello_cache_metadata', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  cacheKey: varchar('cacheKey', { length: 255 }).notNull(), // e.g., 'boards', 'tasks', 'cards:{boardId}'
  lastFetched: timestamp('lastFetched').defaultNow().notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  ttlSeconds: int('ttlSeconds').notNull().default(300), // 5 minutes default
  hitCount: int('hitCount').notNull().default(0),
  missCount: int('missCount').notNull().default(0),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export const trelloCachedTasks = mysqlTable('trello_cached_tasks', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  taskData: mediumtext('taskData').notNull(), // JSON serialized schedule response
  cachedAt: timestamp('cachedAt').defaultNow().notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
});

export const trelloCachedBoards = mysqlTable('trello_cached_boards', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  boardId: varchar('boardId', { length: 64 }).notNull(),
  boardData: text('boardData').notNull(), // JSON serialized board data
  cachedAt: timestamp('cachedAt').defaultNow().notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
});

export const trelloCachedCards = mysqlTable('trello_cached_cards', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  boardId: varchar('boardId', { length: 64 }).notNull(),
  cardId: varchar('cardId', { length: 64 }).notNull(),
  cardData: text('cardData').notNull(), // JSON serialized card data
  cachedAt: timestamp('cachedAt').defaultNow().notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
});

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
export const vaProfiles = mysqlTable('va_profiles', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(), // References users.id (the VA's user account)
  founderId: int('founderId').notNull(), // References users.id (the founder who manages this VA)
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 320 }),
  timezone: varchar('timezone', { length: 50 }).notNull().default('Asia/Manila'), // Default to Philippines
  skills: text('skills'), // JSON array of skills
  hourlyRate: int('hourlyRate'), // In cents
  currency: varchar('currency', { length: 3 }).default('USD'),
  workStartHour: int('workStartHour').notNull().default(9),
  workEndHour: int('workEndHour').notNull().default(18),
  workingDays: varchar('workingDays', { length: 50 }).notNull().default('1,2,3,4,5'),
  // Meal times (stored as hour in 24h format, e.g., 12 = 12:00 PM)
  breakfastTime: int('breakfastTime'), // Optional breakfast break
  breakfastDuration: int('breakfastDuration').default(0), // In minutes
  lunchTime: int('lunchTime').default(12), // Default 12:00 PM
  lunchDuration: int('lunchDuration').default(60), // Default 1 hour
  dinnerTime: int('dinnerTime'), // Optional dinner break
  dinnerDuration: int('dinnerDuration').default(0), // In minutes
  status: mysqlEnum('status', ['active', 'inactive', 'on_leave']).default('active').notNull(),
  trelloMemberId: varchar('trelloMemberId', { length: 64 }),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export const workerInvitations = mysqlTable('worker_invitations', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  vaId: int('vaId').notNull(),
  founderId: int('founderId').notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  tokenHash: varchar('tokenHash', { length: 64 }).notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  sentAt: timestamp('sentAt'),
  acceptedAt: timestamp('acceptedAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tokenHashUnique: uniqueIndex('worker_invitations_token_hash_unique').on(table.tokenHash),
  userStatusIdx: index('worker_invitations_user_status_idx').on(table.userId, table.acceptedAt, table.revokedAt),
  founderCreatedIdx: index('worker_invitations_founder_created_idx').on(table.founderId, table.createdAt),
}));

export type WorkerInvitation = typeof workerInvitations.$inferSelect;
export type InsertWorkerInvitation = typeof workerInvitations.$inferInsert;

// Task assignments linking tasks to VAs
export const taskAssignments = mysqlTable('task_assignments', {
  id: int('id').primaryKey().autoincrement(),
  taskId: varchar('taskId', { length: 128 }).notNull(), // Composite: cardId:checklistId:checkItemId
  vaId: int('vaId').notNull(), // References vaProfiles.id
  founderId: int('founderId').notNull(), // References users.id
  assignedAt: timestamp('assignedAt').defaultNow().notNull(),
  startTime: timestamp('startTime'),
  endTime: timestamp('endTime'),
  assignedBy: int('assignedBy').notNull(), // References users.id (who assigned)
  status: mysqlEnum('status', ['assigned', 'in_progress', 'completed', 'blocked']).default('assigned').notNull(),
  notes: text('notes'),
  handoffNotes: text('handoffNotes'),
  lastWorkedAt: timestamp('lastWorkedAt'),
  decisionLog: text('decisionLog'), // JSON array of decisions
  externalLinks: text('externalLinks'), // JSON array of external links
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Shift schedules for handoffs
export const shiftSchedules = mysqlTable('shift_schedules', {
  id: int('id').primaryKey().autoincrement(),
  vaId: int('vaId').notNull(),
  founderId: int('founderId').notNull(),
  dayOfWeek: int('dayOfWeek').notNull(), // 0 = Sunday, 1 = Monday, etc.
  shiftStart: varchar('shiftStart', { length: 5 }).notNull(), // "09:00"
  shiftEnd: varchar('shiftEnd', { length: 5 }).notNull(), // "17:00"
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Task dependencies
export const taskDependencies = mysqlTable('task_dependencies', {
  id: int('id').primaryKey().autoincrement(),
  taskId: varchar('taskId', { length: 128 }).notNull(), // The task that is blocked
  blockedByTaskId: varchar('blockedByTaskId', { length: 128 }).notNull(), // The task that blocks it
  founderId: int('founderId').notNull(),
  dependencyType: mysqlEnum('dependencyType', ['finish_to_start', 'start_to_start', 'finish_to_finish']).default('finish_to_start').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Founder priority overrides
export const founderPriorityOverrides = mysqlTable('founder_priority_overrides', {
  id: int('id').primaryKey().autoincrement(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  founderId: int('founderId').notNull(),
  priority: mysqlEnum('priority', ['normal', 'high', 'urgent', 'drop_everything']).default('normal').notNull(),
  reason: text('reason'),
  expiresAt: timestamp('expiresAt'), // Optional expiry for temporary priorities
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Client/Project context
export const clients = mysqlTable('clients', {
  id: int('id').primaryKey().autoincrement(),
  founderId: int('founderId').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  priority: mysqlEnum('priority', ['standard', 'priority', 'vip']).default('standard').notNull(),
  trelloBoardIds: text('trelloBoardIds'), // JSON array of associated board IDs
  contactEmail: varchar('contactEmail', { length: 320 }),
  notes: text('notes'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Communication/Decision log
export const communicationLog = mysqlTable('communication_log', {
  id: int('id').primaryKey().autoincrement(),
  taskId: varchar('taskId', { length: 128 }),
  fromUserId: int('fromUserId').notNull(), // VA or Founder
  toUserId: int('toUserId'), // Can be null for general notes
  messageType: mysqlEnum('messageType', ['question', 'decision', 'update', 'handoff', 'feedback']).notNull(),
  message: text('message').notNull(),
  context: text('context'), // JSON with task context
  isRead: int('isRead').notNull().default(0),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Daily briefings
export const dailyBriefings = mysqlTable('daily_briefings', {
  id: int('id').primaryKey().autoincrement(),
  vaId: int('vaId').notNull(),
  founderId: int('founderId').notNull(),
  briefingDate: varchar('briefingDate', { length: 10 }).notNull(), // YYYY-MM-DD
  briefingType: mysqlEnum('briefingType', ['morning', 'end_of_day', 'weekly']).notNull(),
  content: text('content').notNull(), // JSON with briefing data
  sentAt: timestamp('sentAt'),
  sentTo: varchar('sentTo', { length: 320 }), // Email address
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Quality checkpoints / Review queue
export const reviewQueue = mysqlTable('review_queue', {
  id: int('id').primaryKey().autoincrement(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  vaId: int('vaId').notNull(),
  founderId: int('founderId').notNull(),
  status: mysqlEnum('status', ['pending_review', 'approved', 'needs_revision', 'rejected']).default('pending_review').notNull(),
  submittedAt: timestamp('submittedAt').defaultNow().notNull(),
  reviewedAt: timestamp('reviewedAt'),
  feedback: text('feedback'),
  revisionCount: int('revisionCount').notNull().default(0),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Time tracking entries
export const timeEntries = mysqlTable('time_entries', {
  id: int('id').primaryKey().autoincrement(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  vaId: int('vaId').notNull(),
  founderId: int('founderId').notNull(),
  cardId: varchar('cardId', { length: 64 }),
  cardName: varchar('cardName', { length: 512 }),
  cardUrl: varchar('cardUrl', { length: 1024 }),
  boardName: varchar('boardName', { length: 256 }).default('Unknown Board'),
  listName: varchar('listName', { length: 256 }).default('Unknown'),
  startTime: timestamp('startTime').notNull(),
  endTime: timestamp('endTime'),
  durationMinutes: int('durationMinutes'),
  durationSeconds: int('durationSeconds'),
  notes: text('notes'),
  source: varchar('source', { length: 32 }).notNull().default('legacy'),
  category: varchar('category', { length: 32 }).notNull().default('client_work'),
  planDateKey: varchar('planDateKey', { length: 16 }),
  planBlockId: varchar('planBlockId', { length: 128 }),
  aptlssStepId: int('aptlssStepId'),
  isVoided: boolean('isVoided').notNull().default(false),
  voidedAt: timestamp('voidedAt'),
  voidReason: text('voidReason'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index('time_entries_period_idx').on(table.startTime, table.endTime),
  index('va_time_entries_period_idx').on(table.vaId, table.startTime, table.endTime),
  index('time_entries_plan_block_idx').on(table.planDateKey, table.planBlockId),
  index('time_entries_step_idx').on(table.aptlssStepId),
]);

// Payment cycles — each 2-week pay period per founder
export const paymentCycles = mysqlTable("payment_cycles", {
  id: int("id").autoincrement().primaryKey(),
  founderId: int("founderId").notNull(),
  cycleStart: date("cycleStart").notNull(),
  cycleEnd: date("cycleEnd").notNull(),
  baseAmount: decimal("baseAmount", { precision: 8, scale: 2 }).notNull().default("90.00"),
  isPaid: boolean("isPaid").notNull().default(false),
  paidAt: timestamp("paidAt"),
  paidBy: varchar("paidBy", { length: 64 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Weekly merit/demerit log per worker
export const weeklyPayLog = mysqlTable("weekly_pay_log", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  founderId: int("founderId").notNull(),
  weekStart: date("weekStart").notNull(),
  weekEnd: date("weekEnd").notNull(),
  paymentCycleId: int("paymentCycleId"),
  baseAmount: decimal("baseAmount", { precision: 8, scale: 2 }).notNull().default("90.00"),
  meritM1: decimal("meritM1", { precision: 8, scale: 2 }).notNull().default("0.00"),
  meritM2: decimal("meritM2", { precision: 8, scale: 2 }).notNull().default("0.00"),
  meritM3: decimal("meritM3", { precision: 8, scale: 2 }).notNull().default("0.00"),
  meritStreak: decimal("meritStreak", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD1: decimal("demeritD1", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD2: decimal("demeritD2", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD3: decimal("demeritD3", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD4: decimal("demeritD4", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD5: decimal("demeritD5", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD6: decimal("demeritD6", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD7: decimal("demeritD7", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD8: decimal("demeritD8", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD9: decimal("demeritD9", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD10: decimal("demeritD10", { precision: 8, scale: 2 }).notNull().default("0.00"),
  demeritD11: decimal("demeritD11", { precision: 8, scale: 2 }).notNull().default("0.00"),
  totalMerits: decimal("totalMerits", { precision: 8, scale: 2 }).notNull().default("0.00"),
  totalDemerits: decimal("totalDemerits", { precision: 8, scale: 2 }).notNull().default("0.00"),
  projectedPay: decimal("projectedPay", { precision: 8, scale: 2 }).notNull().default("90.00"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Daily triage state per worker
export const dailyTriageState = mysqlTable("daily_triage_state", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  triageDate: date("triageDate").notNull(),
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
  currentView: varchar("currentView", { length: 32 }).notNull().default("overview"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('va_triage_date_idx').on(table.vaId, table.triageDate)
]);

// Sunday checklist state per worker
export const sundayChecklist = mysqlTable("sunday_checklist", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  sundayDate: date("sundayDate").notNull(),
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
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('va_sunday_date_idx').on(table.vaId, table.sundayDate)
]);

// Tracks daily due date assignment per worker
export const dailyDueDateAssignments = mysqlTable("daily_due_date_assignments", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  date: date("date").notNull(),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex('va_due_date_assign_idx').on(table.vaId, table.cardId, table.date)
]);

// Tracks daily Trello card update per worker
export const dailyCardUpdates = mysqlTable("daily_card_updates", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  date: date("date").notNull(),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex('va_card_update_idx').on(table.vaId, table.cardId, table.date)
]);

// Tracks ON-HOLD checks per worker
export const onHoldDailyChecks = mysqlTable("on_hold_daily_checks", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  date: date("date").notNull(),
  checked: boolean("checked").notNull().default(false),
  checkedAt: timestamp("checkedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex('va_on_hold_check_idx').on(table.vaId, table.cardId, table.date)
]);

// Tracks update streaks per worker
export const dailyUpdateStreak = mysqlTable("daily_update_streak", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  streakDate: date("streakDate").notNull(),
  completedBeforeDeadline: boolean("completedBeforeDeadline").notNull().default(false),
  completedAt: timestamp("completedAt"),
  doingCardCount: int("doingCardCount").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex('va_streak_date_idx').on(table.vaId, table.streakDate)
]);

// App settings per worker (or global if vaId is null)
export const appSettings = mysqlTable("app_settings", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId"),
  key: varchar("key", { length: 128 }).notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Daily compliance snapshot per worker
export const dailyComplianceSnapshots = mysqlTable("daily_compliance_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  founderId: int("founderId").notNull(),
  snapshotDate: date("snapshotDate").notNull(),
  onHoldTotal: int("onHoldTotal").notNull().default(0),
  onHoldReviewed: int("onHoldReviewed").notNull().default(0),
  onHoldMissedCards: text("onHoldMissedCards"),
  doingTotal: int("doingTotal").notNull().default(0),
  doingUpdated: int("doingUpdated").notNull().default(0),
  doingMissedCards: text("doingMissedCards"),
  messageTotal: int("messageTotal").notNull().default(0),
  messageReplied: int("messageReplied").notNull().default(0),
  messageMissed: int("messageMissed").notNull().default(0),
  messageNeedsClarification: int("messageNeedsClarification").notNull().default(0),
  emailTotal: int("emailTotal").notNull().default(0),
  emailCompleted: int("emailCompleted").notNull().default(0),
  emailMissed: int("emailMissed").notNull().default(0),
  emailNeedsClarification: int("emailNeedsClarification").notNull().default(0),
  clarificationOpen: int("clarificationOpen").notNull().default(0),
  trackedSeconds: int("trackedSeconds").notNull().default(0),
  scheduledTargetSeconds: int("scheduledTargetSeconds").notNull().default(0),
  overtimeSeconds: int("overtimeSeconds").notNull().default(0),
  timeEntryCount: int("timeEntryCount").notNull().default(0),
  d1Instances: int("d1Instances").notNull().default(0),
  estimatedPenalty: decimal("estimatedPenalty", { precision: 8, scale: 2 }).notNull().default("0.00"),
  source: varchar("source", { length: 16 }).notNull().default("auto"),
  weeklyPayLogId: int("weeklyPayLogId"),
  required: boolean("required").notNull().default(true),
  verificationStatus: varchar("verificationStatus", { length: 24 }).notNull().default("unverified"),
  verificationMethod: varchar("verificationMethod", { length: 255 }),
  verificationCutoffAt: timestamp("verificationCutoffAt"),
  verifiedAt: timestamp("verifiedAt"),
  evidenceCount: int("evidenceCount").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('va_compliance_snapshot_idx').on(table.vaId, table.snapshotDate)
]);

// Tracks Trello comment threads per worker
export const replyThreads = mysqlTable("reply_threads", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  source: mysqlEnum("source", ["trello", "upwork"]).notNull().default("trello"),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  boardName: varchar("boardName", { length: 256 }).notNull().default(""),
  listName: varchar("listName", { length: 256 }).notNull().default(""),
  lastNonWorkerMsgAt: timestamp("lastNonWorkerMsgAt").notNull(),
  lastNonWorkerAuthor: varchar("lastNonWorkerAuthor", { length: 256 }).notNull().default(""),
  lastNonWorkerText: text("lastNonWorkerText"),
  lastWorkerReplyAt: timestamp("lastWorkerReplyAt"),
  status: mysqlEnum("status", ["pending", "replied", "overdue", "inactive"]).notNull().default("pending"),
  demerited: boolean("demerited").notNull().default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('va_reply_thread_idx').on(table.vaId, table.cardId, table.source)
]);

// Tracks vague replies per worker
export const vagueReplyFlags = mysqlTable("vague_reply_flags", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  source: mysqlEnum("source", ["trello", "upwork"]).notNull().default("trello"),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  actionId: varchar("actionId", { length: 64 }).notNull().unique(),
  messageText: text("messageText").notNull(),
  flaggedAt: timestamp("flaggedAt").notNull(),
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: mysqlEnum("resolvedBy", ["manual", "auto_demerit"]),
  demeritIssued: boolean("demeritIssued").notNull().default(false),
  demeritIssuedAt: timestamp("demeritIssuedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Tracks unsigned messages per worker
export const unsignedMessageFlags = mysqlTable("unsigned_message_flags", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  source: mysqlEnum("source", ["trello", "upwork"]).notNull().default("trello"),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  actionId: varchar("actionId", { length: 64 }).notNull().unique(),
  messageText: text("messageText").notNull(),
  flaggedAt: timestamp("flaggedAt").notNull(),
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: mysqlEnum("resolvedBy", ["manual", "auto_demerit"]),
  resolutionNote: text("resolutionNote"),
  demeritIssued: boolean("demeritIssued").notNull().default(false),
  demeritIssuedAt: timestamp("demeritIssuedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Gmail email tasks per worker
export const emailTasks = mysqlTable("email_tasks", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  gmailMessageId: varchar("gmailMessageId", { length: 128 }).notNull().unique(),
  gmailThreadId: varchar("gmailThreadId", { length: 128 }).notNull(),
  subject: varchar("subject", { length: 1024 }).notNull().default("(no subject)"),
  fromAddress: varchar("fromAddress", { length: 320 }).notNull().default(""),
  fromName: varchar("fromName", { length: 256 }).notNull().default(""),
  snippet: text("snippet"),
  receivedAt: timestamp("receivedAt").notNull(),
  category: mysqlEnum("category", ["financial", "non_financial"]).notNull().default("non_financial"),
  status: mysqlEnum("status", ["pending", "processed", "archived"]).notNull().default("pending"),
  deadlineAt: timestamp("deadlineAt"),
  trelloCardId: varchar("trelloCardId", { length: 64 }),
  trelloCardName: varchar("trelloCardName", { length: 512 }),
  trelloCardUrl: varchar("trelloCardUrl", { length: 1024 }),
  suggestedNextAction: text("suggestedNextAction"),
  llmSummary: text("llmSummary"),
  processedAt: timestamp("processedAt"),
  archivedAt: timestamp("archivedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("email_tasks_va_status_received_idx").on(table.vaId, table.status, table.receivedAt),
  index("email_tasks_va_trello_card_idx").on(table.vaId, table.trelloCardId),
]);

// Card snoozes per worker
export const cardSnoozes = mysqlTable("card_snoozes", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  snoozedAt: timestamp("snoozedAt").defaultNow().notNull(),
  snoozedUntil: date("snoozedUntil").notNull(),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Handoff notes
export const handoffNotes = mysqlTable('handoff_notes', {
  id: int('id').primaryKey().autoincrement(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  fromVaId: int('fromVaId').notNull(),
  toVaId: int('toVaId'),
  founderId: int('founderId').notNull(),
  whereLeftOff: text('whereLeftOff').notNull(),
  nextSteps: text('nextSteps'),
  blockers: text('blockers'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Export types
export type VAProfile = typeof vaProfiles.$inferSelect;
export type InsertVAProfile = typeof vaProfiles.$inferInsert;
export type TaskAssignment = typeof taskAssignments.$inferSelect;
export type InsertTaskAssignment = typeof taskAssignments.$inferInsert;
export type TaskDependency = typeof taskDependencies.$inferSelect;
export type InsertTaskDependency = typeof taskDependencies.$inferInsert;
export type FounderPriorityOverride = typeof founderPriorityOverrides.$inferSelect;
export type InsertFounderPriorityOverride = typeof founderPriorityOverrides.$inferInsert;
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
export type DailyDueDateAssignment = typeof dailyDueDateAssignments.$inferSelect;
export type DailyCardUpdate = typeof dailyCardUpdates.$inferSelect;
export type OnHoldDailyCheck = typeof onHoldDailyChecks.$inferSelect;
export type DailyUpdateStreak = typeof dailyUpdateStreak.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type DailyComplianceSnapshot = typeof dailyComplianceSnapshots.$inferSelect;
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
export const atisWorkspaces = mysqlTable('atis_workspaces', {
  id: int('id').primaryKey().autoincrement(),
  trelloId: varchar('trelloId', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  displayName: varchar('displayName', { length: 255 }),
  url: varchar('url', { length: 512 }),
  boardCount: int('boardCount').default(0),
  lastSyncedAt: timestamp('lastSyncedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Trello boards
export const atisBoards = mysqlTable('atis_boards', {
  id: int('id').primaryKey().autoincrement(),
  trelloId: varchar('trelloId', { length: 64 }).notNull().unique(),
  workspaceId: int('workspaceId'), // References atisWorkspaces.id (nullable for personal boards)
  workspaceTrelloId: varchar('workspaceTrelloId', { length: 64 }),
  name: varchar('name', { length: 255 }).notNull(),
  url: varchar('url', { length: 512 }),
  isOpen: int('isOpen').default(1), // 1=open, 0=closed
  cardCount: int('cardCount').default(0),
  lastSyncedAt: timestamp('lastSyncedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Trello cards with full data
export const atisCards = mysqlTable('atis_cards', {
  id: int('id').primaryKey().autoincrement(),
  trelloId: varchar('trelloId', { length: 64 }).notNull().unique(),
  boardId: int('boardId').notNull(), // References atisBoards.id
  boardTrelloId: varchar('boardTrelloId', { length: 64 }).notNull(),
  listName: varchar('listName', { length: 255 }),
  listId: varchar('listId', { length: 64 }),
  name: varchar('name', { length: 512 }).notNull(),
  description: text('description'),
  url: varchar('url', { length: 512 }),
  dueDate: timestamp('dueDate'),
  dueComplete: int('dueComplete').default(0),
  isArchived: int('isArchived').default(0),
  isClosed: int('isClosed').default(0),
  labels: text('labels'), // JSON array of labels
  memberIds: text('memberIds'), // JSON array of assigned member IDs
  checklistCount: int('checklistCount').default(0),
  attachmentCount: int('attachmentCount').default(0),
  commentCount: int('commentCount').default(0),
  rawData: text('rawData'), // Full JSON from Trello API
  lastSyncedAt: timestamp('lastSyncedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export const atisChecklistCompletion = mysqlTable('atis_checklist_completion', {
  id: int('id').primaryKey().autoincrement(),
  cardId: int('card_id').notNull(),
  stepIndex: int('step_index').notNull(),
  userId: int('user_id').notNull(),
  completedAt: timestamp('completed_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('card_step_user_unique').on(table.cardId, table.stepIndex, table.userId),
  index('atis_checklist_user_completed_idx').on(table.userId, table.completedAt),
]);

// Attachments with extracted content
export const atisAttachments = mysqlTable('atis_attachments', {
  id: int('id').primaryKey().autoincrement(),
  trelloId: varchar('trelloId', { length: 64 }).notNull(),
  cardId: int('cardId').notNull(), // References atisCards.id
  cardTrelloId: varchar('cardTrelloId', { length: 64 }).notNull(),
  filename: varchar('filename', { length: 512 }),
  mimeType: varchar('mimeType', { length: 128 }),
  fileType: varchar('fileType', { length: 32 }), // pdf, docx, xlsx, image, link, email, other
  url: varchar('url', { length: 1024 }),
  bytes: int('bytes'),
  // Extraction status and content
  extractionStatus: mysqlEnum('extractionStatus', ['pending', 'processing', 'success', 'failed', 'unreadable']).default('pending').notNull(),
  extractedContent: text('extractedContent'), // Extracted text/description
  extractionError: text('extractionError'),
  extractedAt: timestamp('extractedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Comments from Trello cards
export const atisComments = mysqlTable('atis_comments', {
  id: int('id').primaryKey().autoincrement(),
  trelloId: varchar('trelloId', { length: 64 }).notNull(),
  cardId: int('cardId').notNull(), // References atisCards.id
  cardTrelloId: varchar('cardTrelloId', { length: 64 }).notNull(),
  authorId: varchar('authorId', { length: 64 }),
  authorName: varchar('authorName', { length: 255 }),
  text: text('text').notNull(),
  commentDate: timestamp('commentDate'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// AI-generated understanding of each card
export const atisCardUnderstanding = mysqlTable('atis_card_understanding', {
  id: int('id').primaryKey().autoincrement(),
  cardId: int('cardId').notNull().unique(), // References atisCards.id
  cardTrelloId: varchar('cardTrelloId', { length: 64 }).notNull().unique(),
  // Core understanding
  goal: text('goal'), // What is this card trying to achieve?
  deliverable: text('deliverable'), // What tangible output marks completion?
  taskType: varchar('taskType', { length: 64 }), // communication, research, creation, meeting, review, admin, etc.
  // Extracted entities
  entities: text('entities'), // JSON: {people: [], organizations: [], cases: [], systems: [], documents: []}
  // Timing
  deadlines: text('deadlines'), // JSON: [{date, source, description}]
  estimatedMinutes: int('estimatedMinutes'),
  // Dependencies and relationships
  dependencies: text('dependencies'), // JSON: What must happen before this?
  produces: text('produces'), // JSON: What does completing this enable?
  // Classification
  domain: varchar('domain', { length: 128 }), // Area of work
  complexity: mysqlEnum('complexity', ['simple', 'medium', 'complex']).default('medium'),
  // Quality assessment
  clarityScore: int('clarityScore'), // 1-10, how clear is what needs to be done?
  missingInfo: text('missingInfo'), // What's unclear or would help to know?
  confidenceScore: int('confidenceScore'), // 1-100, AI confidence in understanding
  // APTLSS Checklist - AI-generated steps to complete the task
  aptlssChecklist: text('aptlssChecklist'), // JSON array of checklist items
  // Status
  status: mysqlEnum('status', ['pending', 'processing', 'complete', 'needs_review', 'insufficient_info']).default('pending').notNull(),
  generatedAt: timestamp('generatedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Ingestion job tracking
export const atisIngestionJobs = mysqlTable('atis_ingestion_jobs', {
  id: int('id').primaryKey().autoincrement(),
  jobType: mysqlEnum('jobType', ['full_sync', 'incremental', 'workspace', 'board', 'card']).notNull(),
  status: mysqlEnum('status', ['pending', 'running', 'completed', 'failed']).default('pending').notNull(),
  targetId: varchar('targetId', { length: 64 }), // Trello ID of target (workspace, board, or card)
  totalItems: int('totalItems').default(0),
  processedItems: int('processedItems').default(0),
  failedItems: int('failedItems').default(0),
  errorLog: text('errorLog'), // JSON array of errors
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
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
export type InsertATISCardUnderstanding = typeof atisCardUnderstanding.$inferInsert;
export type ATISIngestionJob = typeof atisIngestionJobs.$inferSelect;
export type InsertATISIngestionJob = typeof atisIngestionJobs.$inferInsert;


// User notification preferences
export const userNotificationPreferences = mysqlTable('user_notification_preferences', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull().unique(),
  
  // Notification mode: 'disabled' | 'daily_digest' | 'priority_only'
  notificationMode: mysqlEnum('notificationMode', ['disabled', 'daily_digest', 'priority_only']).default('priority_only').notNull(),
  
  // Daily digest settings
  digestTime: varchar('digestTime', { length: 5 }).default('08:00').notNull(), // HH:MM format
  digestTimezone: varchar('digestTimezone', { length: 50 }).default('Europe/Amsterdam').notNull(),
  
  // Priority only settings - what counts as "urgent"
  urgentThresholdHours: int('urgentThresholdHours').default(24).notNull(), // Tasks due within X hours are urgent
  
  // Email notification settings
  emailEnabled: int('emailEnabled').default(1).notNull(), // 0=false, 1=true
  emailAddress: varchar('emailAddress', { length: 320 }),
  
  // In-app notification settings
  inAppEnabled: int('inAppEnabled').default(1).notNull(),
  
  // Last digest sent timestamp
  lastDigestSent: timestamp('lastDigestSent'),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export type UserNotificationPreferences = typeof userNotificationPreferences.$inferSelect;
export type InsertUserNotificationPreferences = typeof userNotificationPreferences.$inferInsert;


// Notification history for tracking sent notifications
export const notificationHistory = mysqlTable('notification_history', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Notification details
  title: varchar('title', { length: 500 }).notNull(),
  content: text('content').notNull(),
  notificationType: mysqlEnum('notificationType', [
    'task_assigned',
    'task_due_soon', 
    'task_overdue',
    'task_completed',
    'daily_digest',
    'general'
  ]).notNull(),
  
  // Related task info (optional)
  taskId: varchar('taskId', { length: 128 }),
  taskName: varchar('taskName', { length: 500 }),
  dueDate: timestamp('dueDate'),
  
  // Delivery status
  channel: mysqlEnum('channel', ['in_app', 'email', 'both']).notNull(),
  deliveryStatus: mysqlEnum('deliveryStatus', ['pending', 'sent', 'failed', 'queued_for_digest']).default('pending').notNull(),
  deliveredAt: timestamp('deliveredAt'),
  
  // Read status for in-app notifications
  isRead: int('isRead').default(0).notNull(), // 0=unread, 1=read
  readAt: timestamp('readAt'),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

export type NotificationHistory = typeof notificationHistory.$inferSelect;
export type InsertNotificationHistory = typeof notificationHistory.$inferInsert;

// Digest job tracking
export const digestJobs = mysqlTable('digest_jobs', {
  id: int('id').primaryKey().autoincrement(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  scheduledFor: timestamp('scheduledFor').notNull(),
  status: mysqlEnum('status', ['pending', 'processing', 'completed', 'failed']).default('pending').notNull(),
  notificationCount: int('notificationCount').default(0).notNull(),
  error: text('error'),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

export type DigestJob = typeof digestJobs.$inferSelect;
export type InsertDigestJob = typeof digestJobs.$inferInsert;

// Durable reminder orchestration. These tables form one auditable path from a
// source commitment through policy review, delivery, escalation, and closure.
export const commitments = mysqlTable('commitments', {
  id: int('id').primaryKey().autoincrement(),
  workspaceOwnerId: int('workspaceOwnerId').notNull(),
  assignedUserId: int('assignedUserId'),
  createdByUserId: int('createdByUserId').notNull(),
  sourceType: mysqlEnum('sourceType', ['manual', 'trello', 'gmail', 'google_drive', 'system']).notNull(),
  sourceId: varchar('sourceId', { length: 255 }),
  sourceUrl: varchar('sourceUrl', { length: 1024 }),
  title: varchar('title', { length: 500 }).notNull(),
  context: text('context'),
  dueAt: timestamp('dueAt').notNull(),
  status: mysqlEnum('status', ['open', 'completed', 'cancelled']).default('open').notNull(),
  completedAt: timestamp('completedAt'),
  cancelledAt: timestamp('cancelledAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('commitments_workspace_source_unique').on(table.workspaceOwnerId, table.sourceType, table.sourceId),
  index('commitments_workspace_status_due_idx').on(table.workspaceOwnerId, table.status, table.dueAt),
  index('commitments_assignee_status_due_idx').on(table.assignedUserId, table.status, table.dueAt),
]);

export const reminderRules = mysqlTable('reminder_rules', {
  id: int('id').primaryKey().autoincrement(),
  workspaceOwnerId: int('workspaceOwnerId').notNull(),
  createdByUserId: int('createdByUserId').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  triggerType: mysqlEnum('triggerType', ['before_due', 'at_due', 'after_due', 'no_update', 'manual']).default('before_due').notNull(),
  offsetMinutes: int('offsetMinutes').default(60).notNull(),
  channel: mysqlEnum('channel', ['in_app', 'email']).default('in_app').notNull(),
  requireApproval: boolean('requireApproval').default(true).notNull(),
  maxAttempts: int('maxAttempts').default(1).notNull(),
  cooldownMinutes: int('cooldownMinutes').default(60).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index('reminder_rules_workspace_active_idx').on(table.workspaceOwnerId, table.active),
]);

export const reminderPolicies = mysqlTable('reminder_policies', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('userId').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  inAppEnabled: boolean('inAppEnabled').default(true).notNull(),
  emailEnabled: boolean('emailEnabled').default(false).notNull(),
  maxPerDay: int('maxPerDay').default(3).notNull(),
  minIntervalMinutes: int('minIntervalMinutes').default(60).notNull(),
  quietHoursStart: varchar('quietHoursStart', { length: 5 }).default('22:00').notNull(),
  quietHoursEnd: varchar('quietHoursEnd', { length: 5 }).default('08:00').notNull(),
  timezone: varchar('timezone', { length: 64 }).default('UTC').notNull(),
  allowWeekends: boolean('allowWeekends').default(false).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('reminder_policies_user_unique').on(table.userId),
]);

export const reminderSchedules = mysqlTable('reminder_schedules', {
  id: int('id').primaryKey().autoincrement(),
  commitmentId: int('commitmentId').notNull(),
  ruleId: int('ruleId').notNull(),
  recipientUserId: int('recipientUserId').notNull(),
  scheduledFor: timestamp('scheduledFor').notNull(),
  state: mysqlEnum('state', [
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
  channel: mysqlEnum('channel', ['in_app', 'email']).notNull(),
  idempotencyKey: varchar('idempotencyKey', { length: 64 }).notNull(),
  draftTitle: varchar('draftTitle', { length: 500 }),
  draftContent: text('draftContent'),
  policyReason: text('policyReason'),
  attemptCount: int('attemptCount').default(0).notNull(),
  lastAttemptAt: timestamp('lastAttemptAt'),
  approvedAt: timestamp('approvedAt'),
  approvedByUserId: int('approvedByUserId'),
  sentAt: timestamp('sentAt'),
  escalatedAt: timestamp('escalatedAt'),
  error: text('error'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('reminder_schedules_idempotency_unique').on(table.idempotencyKey),
  index('reminder_schedules_due_state_idx').on(table.state, table.scheduledFor),
  index('reminder_schedules_recipient_state_idx').on(table.recipientUserId, table.state, table.scheduledFor),
  index('reminder_schedules_commitment_idx').on(table.commitmentId),
]);

export const reminderAuditEvents = mysqlTable('reminder_audit_events', {
  id: int('id').primaryKey().autoincrement(),
  workspaceOwnerId: int('workspaceOwnerId').notNull(),
  commitmentId: int('commitmentId'),
  scheduleId: int('scheduleId'),
  actorUserId: int('actorUserId'),
  eventType: varchar('eventType', { length: 64 }).notNull(),
  detailsJson: longtext('detailsJson'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, (table) => [
  index('reminder_audit_workspace_created_idx').on(table.workspaceOwnerId, table.createdAt),
  index('reminder_audit_commitment_created_idx').on(table.commitmentId, table.createdAt),
  index('reminder_audit_schedule_created_idx').on(table.scheduleId, table.createdAt),
]);

// Revocable, read-only credentials for HAI to consume the owner-scoped worker
// control feed. Only a SHA-256 digest and a display prefix are persisted.
export const haiConnectorTokens = mysqlTable('hai_connector_tokens', {
  id: int('id').primaryKey().autoincrement(),
  workspaceOwnerId: int('workspaceOwnerId').notNull(),
  createdByUserId: int('createdByUserId').notNull(),
  label: varchar('label', { length: 128 }).default('HAI Worker Control').notNull(),
  tokenPrefix: varchar('tokenPrefix', { length: 24 }).notNull(),
  tokenHash: varchar('tokenHash', { length: 64 }).notNull(),
  scopes: varchar('scopes', { length: 255 }).default('worker_control:read').notNull(),
  lastUsedAt: timestamp('lastUsedAt'),
  expiresAt: timestamp('expiresAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('hai_connector_tokens_hash_unique').on(table.tokenHash),
  index('hai_connector_tokens_owner_active_idx').on(table.workspaceOwnerId, table.revokedAt, table.createdAt),
]);

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


// ============================================
// TRELLO CHATBOT TABLES
// ============================================

// Registered webhooks for chatbot
export const chatbotWebhooks = mysqlTable('chatbot_webhooks', {
  id: int('id').primaryKey().autoincrement(),
  trelloWebhookId: varchar('trelloWebhookId', { length: 64 }).notNull().unique(),
  modelId: varchar('modelId', { length: 64 }).notNull(), // Board or workspace ID
  modelType: mysqlEnum('modelType', ['board', 'workspace']).default('board').notNull(),
  description: varchar('description', { length: 255 }),
  callbackUrl: varchar('callbackUrl', { length: 512 }).notNull(),
  isActive: int('isActive').default(1).notNull(), // 0=inactive, 1=active
  lastEventAt: timestamp('lastEventAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Chatbot conversation history
export const chatbotConversations = mysqlTable('chatbot_conversations', {
  id: int('id').primaryKey().autoincrement(),
  cardTrelloId: varchar('cardTrelloId', { length: 64 }).notNull(),
  cardName: varchar('cardName', { length: 500 }),
  boardTrelloId: varchar('boardTrelloId', { length: 64 }),
  
  // Command details
  command: varchar('command', { length: 50 }).notNull(), // status, checkin, remind, etc.
  commandArgs: text('commandArgs'), // JSON array of arguments
  
  // Author info
  authorTrelloId: varchar('authorTrelloId', { length: 64 }),
  authorName: varchar('authorName', { length: 255 }),
  
  // Comment IDs
  incomingCommentId: varchar('incomingCommentId', { length: 64 }),
  responseCommentId: varchar('responseCommentId', { length: 64 }),
  
  // Response details
  responseText: text('responseText'),
  responseStatus: mysqlEnum('responseStatus', ['success', 'failed', 'pending']).default('pending').notNull(),
  responseError: text('responseError'),
  
  // Timing
  receivedAt: timestamp('receivedAt').defaultNow().notNull(),
  respondedAt: timestamp('respondedAt'),
  responseTimeMs: int('responseTimeMs'), // How long it took to respond
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Worker check-in responses (when workers reply to bot check-ins)
export const chatbotCheckinResponses = mysqlTable('chatbot_checkin_responses', {
  id: int('id').primaryKey().autoincrement(),
  conversationId: int('conversationId').notNull(), // References chatbotConversations.id
  cardTrelloId: varchar('cardTrelloId', { length: 64 }).notNull(),
  
  // Worker info
  workerTrelloId: varchar('workerTrelloId', { length: 64 }),
  workerName: varchar('workerName', { length: 255 }),
  workerId: int('workerId'), // References vaProfiles.id if matched
  
  // Response content
  responseCommentId: varchar('responseCommentId', { length: 64 }),
  responseText: text('responseText'),
  
  // Parsed response data
  reportedProgress: text('reportedProgress'), // What they said they accomplished
  reportedBlockers: text('reportedBlockers'), // Any blockers mentioned
  estimatedCompletion: varchar('estimatedCompletion', { length: 100 }), // ETA if provided
  
  // Timing
  checkinSentAt: timestamp('checkinSentAt').notNull(),
  responseReceivedAt: timestamp('responseReceivedAt').notNull(),
  responseTimeMinutes: int('responseTimeMinutes'), // How long worker took to respond
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Chatbot analytics aggregates (daily rollups)
export const chatbotAnalytics = mysqlTable('chatbot_analytics', {
  id: int('id').primaryKey().autoincrement(),
  date: timestamp('date').notNull(),
  
  // Command counts
  totalCommands: int('totalCommands').default(0).notNull(),
  statusCommands: int('statusCommands').default(0).notNull(),
  checkinCommands: int('checkinCommands').default(0).notNull(),
  remindCommands: int('remindCommands').default(0).notNull(),
  timeCommands: int('timeCommands').default(0).notNull(),
  progressCommands: int('progressCommands').default(0).notNull(),
  helpCommands: int('helpCommands').default(0).notNull(),
  unknownCommands: int('unknownCommands').default(0).notNull(),
  
  // Response metrics
  successfulResponses: int('successfulResponses').default(0).notNull(),
  failedResponses: int('failedResponses').default(0).notNull(),
  avgResponseTimeMs: int('avgResponseTimeMs'),
  
  // Check-in metrics
  checkinsSent: int('checkinsSent').default(0).notNull(),
  checkinsResponded: int('checkinsResponded').default(0).notNull(),
  avgCheckinResponseMinutes: int('avgCheckinResponseMinutes'),
  
  // Worker engagement
  uniqueWorkers: int('uniqueWorkers').default(0).notNull(),
  uniqueCards: int('uniqueCards').default(0).notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export type ChatbotWebhook = typeof chatbotWebhooks.$inferSelect;
export type InsertChatbotWebhook = typeof chatbotWebhooks.$inferInsert;
export type ChatbotConversation = typeof chatbotConversations.$inferSelect;
export type InsertChatbotConversation = typeof chatbotConversations.$inferInsert;
export type ChatbotCheckinResponse = typeof chatbotCheckinResponses.$inferSelect;
export type InsertChatbotCheckinResponse = typeof chatbotCheckinResponses.$inferInsert;
export type ChatbotAnalytics = typeof chatbotAnalytics.$inferSelect;
export type InsertChatbotAnalytics = typeof chatbotAnalytics.$inferInsert;

// Interview System Tables (ATIS Phases 1-10)
export const interviewSessions = mysqlTable('interview_sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  cardId: varchar('cardId', { length: 64 }).notNull(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Interview state
  status: mysqlEnum('status', ['active', 'completed', 'abandoned']).notNull().default('active'),
  currentPhase: int('currentPhase').notNull().default(1), // ATIS phases 1-10
  currentQuestion: int('currentQuestion').notNull().default(0),
  
  // Pre-analysis results
  preAnalysisSummary: text('preAnalysisSummary'),
  
  // Interview progress
  questionsAsked: int('questionsAsked').notNull().default(0),
  responsesProvided: int('responsesProvided').notNull().default(0),
  overallConfidence: int('overallConfidence').notNull().default(0), // 0-100
  
  // Session data (JSON)
  sessionData: text('sessionData'), // JSON serialized interview state
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
  completedAt: timestamp('completedAt'),
});

export const interviewHistory = mysqlTable('interview_history', {
  id: varchar('id', { length: 64 }).primaryKey(),
  sessionId: varchar('sessionId', { length: 64 }).notNull(),
  cardId: varchar('cardId', { length: 64 }).notNull(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Question and response
  phase: int('phase').notNull(), // Which ATIS phase
  questionNumber: int('questionNumber').notNull(),
  question: text('question').notNull(),
  response: text('response').notNull(),
  
  // Validation results
  isValid: int('isValid').notNull(), // 0=false, 1=true
  validationScore: int('validationScore').notNull().default(0), // 0-100
  validationNotes: text('validationNotes'),
  
  // Confidence tracking
  confidenceScore: int('confidenceScore').notNull().default(0), // 0-100
  requiresEscalation: int('requiresEscalation').notNull().default(0), // 0=false, 1=true
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

export const interviewResults = mysqlTable('interview_results', {
  id: varchar('id', { length: 64 }).primaryKey(),
  sessionId: varchar('sessionId', { length: 64 }).notNull(),
  cardId: varchar('cardId', { length: 64 }).notNull(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Final results from all phases
  finalGoal: text('finalGoal'),
  finalDeliverable: text('finalDeliverable'),
  finalAPTLSSChecklist: text('finalAPTLSSChecklist'), // JSON
  
  // Confidence and quality metrics
  finalConfidence: int('finalConfidence').notNull().default(0), // 0-100
  clarityScore: int('clarityScore').notNull().default(0), // 0-100
  completenessScore: int('completenessScore').notNull().default(0), // 0-100
  
  // Execution plan
  executionPlan: text('executionPlan'), // JSON
  estimatedDuration: int('estimatedDuration'), // minutes
  
  // Quality metrics
  totalQuestionsAsked: int('totalQuestionsAsked').notNull().default(0),
  totalResponsesProvided: int('totalResponsesProvided').notNull().default(0),
  escalationsRequired: int('escalationsRequired').notNull().default(0),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  completedAt: timestamp('completedAt'),
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
export const taskScheduleHistory = mysqlTable('task_schedule_history', {
  id: varchar('id', { length: 64 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  founderId: int('founderId'),
  assignmentId: int('assignmentId'),
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
  source: mysqlEnum('source', ['manual', 'auto', 'batch', 'conflict_resolution']).default('manual').notNull(),
  
  // Conflict info
  hadConflicts: int('hadConflicts').default(0).notNull(), // 0=false, 1=true
  conflictDetails: text('conflictDetails'), // JSON array of conflicts
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Batch operations tracking
export const batchOperations = mysqlTable('batch_operations', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: varchar('userId', { length: 64 }).notNull(), // User openId
  
  // Operation details
  operationType: mysqlEnum('operationType', ['re_analyze', 'reschedule', 'conflict_resolution', 'optimization']).notNull(),
  description: varchar('description', { length: 255 }),
  
  // Task scope
  totalTasks: int('totalTasks').notNull(),
  completedTasks: int('completedTasks').notNull().default(0),
  failedTasks: int('failedTasks').notNull().default(0),
  
  // Progress tracking
  status: mysqlEnum('status', ['pending', 'running', 'completed', 'failed', 'cancelled']).default('pending').notNull(),
  progress: decimal('progress', { precision: 5, scale: 2 }).default('0.00').notNull(), // 0-100%
  currentTaskIndex: int('currentTaskIndex').default(0),
  currentTaskName: varchar('currentTaskName', { length: 255 }),
  
  // Timing
  estimatedTimeSeconds: int('estimatedTimeSeconds'),
  elapsedTimeSeconds: int('elapsedTimeSeconds').default(0),
  
  // Results
  results: text('results'), // JSON with operation results
  errorLog: text('errorLog'), // JSON array of errors
  
  // Metadata
  parameters: text('parameters'), // JSON with operation parameters
  
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Keyboard shortcuts configuration
export const keyboardShortcuts = mysqlTable('keyboard_shortcuts', {
  id: int('id').primaryKey().autoincrement(),
  userId: varchar('userId', { length: 64 }).notNull(), // User openId
  
  // Shortcut details
  shortcutKey: varchar('shortcutKey', { length: 50 }).notNull(), // e.g., 'Ctrl+D', 'Ctrl+R'
  action: varchar('action', { length: 100 }).notNull(), // e.g., 'open_calendar', 'batch_reanalyze'
  description: varchar('description', { length: 255 }),
  
  // Customization
  isCustom: int('isCustom').default(0).notNull(), // 0=default, 1=custom
  isEnabled: int('isEnabled').default(1).notNull(), // 0=disabled, 1=enabled
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
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
export const taskSubtasks = mysqlTable('task_subtasks', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(), // References tasks/cards
  userId: varchar('userId', { length: 64 }).notNull(), // User openId
  
  // Subtask details
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  estimatedHours: decimal('estimatedHours', { precision: 10, scale: 2 }),
  sequence: int('sequence').notNull().default(0), // Order in decomposition
  
  // Status tracking
  status: mysqlEnum('status', ['pending', 'in_progress', 'completed', 'blocked']).default('pending').notNull(),
  
  // Metadata
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Phase 3: Subtask Dependencies
export const subtaskDependencies = mysqlTable('subtask_dependencies', {
  id: varchar('id', { length: 36 }).primaryKey(),
  subtaskId: varchar('subtaskId', { length: 36 }).notNull(), // References taskSubtasks.id
  dependsOnSubtaskId: varchar('dependsOnSubtaskId', { length: 36 }).notNull(), // References taskSubtasks.id
  
  // Dependency type
  dependencyType: mysqlEnum('dependencyType', ['sequential', 'parallel', 'blocking']).default('sequential').notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Phase 3: Critical Path Analysis
export const criticalPathAnalysis = mysqlTable('critical_path_analysis', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Critical path data
  criticalPath: text('criticalPath').notNull(), // JSON array of subtask IDs
  totalDurationHours: decimal('totalDurationHours', { precision: 10, scale: 2 }).notNull(),
  parallelizationOpportunities: int('parallelizationOpportunities').default(0),
  
  // Analysis metadata
  analysisData: text('analysisData'), // JSON with detailed analysis
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Phase 4: Risk Assessment
export const taskRisks = mysqlTable('task_risks', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Risk details
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  category: mysqlEnum('category', ['technical', 'resource', 'schedule', 'external']).notNull(),
  
  // Risk scoring
  probability: int('probability').notNull(), // 1-10
  impact: int('impact').notNull(), // 1-10
  priority: int('priority').notNull(), // probability * impact
  
  // Status
  status: mysqlEnum('status', ['identified', 'mitigated', 'resolved']).default('identified').notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Phase 4: Risk Mitigations
export const riskMitigations = mysqlTable('risk_mitigations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  riskId: varchar('riskId', { length: 36 }).notNull(), // References taskRisks.id
  
  // Mitigation strategy
  strategy: varchar('strategy', { length: 255 }).notNull(),
  effort: varchar('effort', { length: 50 }), // e.g., 'low', 'medium', 'high'
  owner: varchar('owner', { length: 255 }),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Phase 5: Resource Requirements
export const taskResourceRequirements = mysqlTable('task_resource_requirements', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Resource type
  resourceType: mysqlEnum('resourceType', ['skill', 'tool', 'training']).notNull(),
  resourceName: varchar('resourceName', { length: 255 }).notNull(),
  
  // Proficiency level (for skills)
  proficiencyLevel: mysqlEnum('proficiencyLevel', ['beginner', 'intermediate', 'expert']),
  
  // Cost estimation
  estimatedCost: decimal('estimatedCost', { precision: 10, scale: 2 }),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Phase 6: Timeline Optimization
export const taskTimeline = mysqlTable('task_timeline', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Timeline data
  startDate: varchar('startDate', { length: 10 }), // YYYY-MM-DD
  endDate: varchar('endDate', { length: 10 }), // YYYY-MM-DD
  bufferDays: int('bufferDays').default(0),
  totalDays: int('totalDays'),
  
  // Optimization metadata
  optimizationData: text('optimizationData'), // JSON with optimization details
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Phase 6: Task Milestones
export const taskMilestones = mysqlTable('task_milestones', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  
  // Milestone details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  dueDate: varchar('dueDate', { length: 10 }).notNull(), // YYYY-MM-DD
  
  // Status
  status: mysqlEnum('status', ['pending', 'completed']).default('pending').notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Phase 7: QA Strategy
export const taskQAStrategy = mysqlTable('task_qa_strategy', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // QA strategy
  strategy: text('strategy').notNull(),
  testingPhases: text('testingPhases'), // JSON array of testing phases
  qualityMetrics: text('qualityMetrics'), // JSON with quality metrics
  acceptanceCriteria: text('acceptanceCriteria'), // JSON with acceptance criteria
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Phase 8: Documentation Requirements
export const taskDocumentationRequirements = mysqlTable('task_documentation_requirements', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Documentation details
  docType: varchar('docType', { length: 100 }).notNull(), // e.g., 'user_guide', 'api_docs', 'technical_spec'
  audience: varchar('audience', { length: 255 }), // e.g., 'end_users', 'developers', 'stakeholders'
  estimatedEffort: decimal('estimatedEffort', { precision: 10, scale: 2 }), // Hours
  
  // Content outline
  contentOutline: text('contentOutline'), // JSON with outline structure
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

// Phase 9: External Dependencies
export const taskExternalDependencies = mysqlTable('task_external_dependencies', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Dependency details
  dependencyType: mysqlEnum('dependencyType', ['approval', 'third_party', 'regulatory']).notNull(),
  description: text('description').notNull(),
  owner: varchar('owner', { length: 255 }),
  dueDate: varchar('dueDate', { length: 10 }), // YYYY-MM-DD
  
  // Status
  status: mysqlEnum('status', ['pending', 'completed']).default('pending').notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Phase 10: Execution Plan
export const taskExecutionPlan = mysqlTable('task_execution_plan', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Execution plan data
  roadmap: text('roadmap'), // JSON with step-by-step roadmap
  successMetrics: text('successMetrics'), // JSON with success metrics
  communicationPlan: text('communicationPlan'), // Communication strategy
  escalationPath: text('escalationPath'), // JSON with escalation procedures
  preExecutionChecklist: text('preExecutionChecklist'), // JSON with checklist items
  
  // Final APTLSS checklist
  aptlssChecklist: text('aptlssChecklist'), // JSON with final APTLSS checklist
  confidenceScore: decimal('confidenceScore', { precision: 5, scale: 2 }), // 0-100%
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// ATIS Analysis Session - tracks the overall analysis process
export const atisAnalysisSessions = mysqlTable('atis_analysis_sessions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  taskId: varchar('taskId', { length: 128 }).notNull(),
  userId: varchar('userId', { length: 64 }).notNull(),
  
  // Session tracking
  status: mysqlEnum('status', ['pending', 'in_progress', 'completed', 'failed']).default('pending').notNull(),
  currentPhase: int('currentPhase').default(3), // Current phase (3-10)
  
  // Progress tracking
  phasesCompleted: int('phasesCompleted').default(0),
  
  // Session data
  sessionData: text('sessionData'), // JSON with all phase results
  
  startedAt: timestamp('startedAt'),
  completedAt: timestamp('completedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Type exports
export type TaskSubtask = typeof taskSubtasks.$inferSelect;
export type InsertTaskSubtask = typeof taskSubtasks.$inferInsert;
export type SubtaskDependency = typeof subtaskDependencies.$inferSelect;
export type InsertSubtaskDependency = typeof subtaskDependencies.$inferInsert;
export type CriticalPathAnalysis = typeof criticalPathAnalysis.$inferSelect;
export type InsertCriticalPathAnalysis = typeof criticalPathAnalysis.$inferInsert;
export type TaskRisk = typeof taskRisks.$inferSelect;
export type InsertTaskRisk = typeof taskRisks.$inferInsert;
export type RiskMitigation = typeof riskMitigations.$inferSelect;
export type InsertRiskMitigation = typeof riskMitigations.$inferInsert;
export type TaskResourceRequirement = typeof taskResourceRequirements.$inferSelect;
export type InsertTaskResourceRequirement = typeof taskResourceRequirements.$inferInsert;
export type TaskTimeline = typeof taskTimeline.$inferSelect;
export type InsertTaskTimeline = typeof taskTimeline.$inferInsert;
export type TaskMilestone = typeof taskMilestones.$inferSelect;
export type InsertTaskMilestone = typeof taskMilestones.$inferInsert;
export type TaskQAStrategy = typeof taskQAStrategy.$inferSelect;
export type InsertTaskQAStrategy = typeof taskQAStrategy.$inferInsert;
export type TaskDocumentationRequirement = typeof taskDocumentationRequirements.$inferSelect;
export type InsertTaskDocumentationRequirement = typeof taskDocumentationRequirements.$inferInsert;
export type TaskExternalDependency = typeof taskExternalDependencies.$inferSelect;
export type InsertTaskExternalDependency = typeof taskExternalDependencies.$inferInsert;
export type TaskExecutionPlan = typeof taskExecutionPlan.$inferSelect;
export type InsertTaskExecutionPlan = typeof taskExecutionPlan.$inferInsert;
export type AtisAnalysisSession = typeof atisAnalysisSessions.$inferSelect;
export type InsertAtisAnalysisSession = typeof atisAnalysisSessions.$inferInsert;


// ============================================
// SCHEDULING SETTINGS TABLES
// ============================================

// Conflict detection settings per user
export const conflictDetectionSettings = mysqlTable('conflict_detection_settings', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Conflict detection configuration
  enabled: int('enabled').notNull().default(1), // 0=false, 1=true
  warningThresholdMinutes: int('warningThresholdMinutes').notNull().default(15),
  autoResolve: int('autoResolve').notNull().default(0), // 0=false, 1=true
  notifyOnConflict: int('notifyOnConflict').notNull().default(1), // 0=false, 1=true
  
  // Conflict types to detect (JSON)
  conflictTypes: text('conflictTypes').notNull().default('{"timeOverlap":true,"resourceConflict":true,"dependencyConflict":true}'),
  
  // Version tracking for sync
  version: int('version').notNull().default(1),
  lastModified: timestamp('lastModified').defaultNow().onUpdateNow().notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Batch operation defaults per user
export const batchOperationSettings = mysqlTable('batch_operation_settings', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Default operation settings
  defaultOperationType: varchar('defaultOperationType', { length: 50 }).notNull().default('re_analyze'),
  defaultPriority: varchar('defaultPriority', { length: 20 }).notNull().default('normal'),
  autoStartOnQueue: int('autoStartOnQueue').notNull().default(0), // 0=false, 1=true
  maxConcurrentOperations: int('maxConcurrentOperations').notNull().default(3),
  
  // Retry configuration
  retryFailedTasks: int('retryFailedTasks').notNull().default(1), // 0=false, 1=true
  maxRetries: int('maxRetries').notNull().default(2),
  
  // Notification settings
  notifyOnCompletion: int('notifyOnCompletion').notNull().default(1), // 0=false, 1=true
  notifyOnFailure: int('notifyOnFailure').notNull().default(1), // 0=false, 1=true
  
  // Version tracking for sync
  version: int('version').notNull().default(1),
  lastModified: timestamp('lastModified').defaultNow().onUpdateNow().notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Keyboard shortcuts per user
export const keyboardShortcutsSettings = mysqlTable('keyboard_shortcuts_settings', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Shortcuts data (JSON array)
  shortcuts: text('shortcuts').notNull().default('[]'),
  
  // Version tracking for sync
  version: int('version').notNull().default(1),
  lastModified: timestamp('lastModified').defaultNow().onUpdateNow().notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Performance metrics per user
export const performanceMetricsSettings = mysqlTable('performance_metrics_settings', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Metrics data
  totalOperations: int('totalOperations').notNull().default(0),
  successfulOperations: int('successfulOperations').notNull().default(0),
  failedOperations: int('failedOperations').notNull().default(0),
  averageExecutionTime: decimal('averageExecutionTime', { precision: 10, scale: 2 }).notNull().default('0.00'),
  averageTasksPerOperation: decimal('averageTasksPerOperation', { precision: 10, scale: 2 }).notNull().default('0.00'),
  conflictsDetected: int('conflictsDetected').notNull().default(0),
  conflictsResolved: int('conflictsResolved').notNull().default(0),
  
  // Trend data (JSON)
  trends: text('trends').notNull().default('{"successRate":0,"executionTimeTrend":"stable","operationsTrend":"stable"}'),
  
  // Version tracking for sync
  version: int('version').notNull().default(1),
  lastModified: timestamp('lastModified').defaultNow().onUpdateNow().notNull(),
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// Settings sync log for tracking changes
export const settingsSyncLog = mysqlTable('settings_sync_log', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('userId').notNull(),
  userOpenId: varchar('userOpenId', { length: 64 }).notNull(),
  
  // Sync details
  settingsType: varchar('settingsType', { length: 50 }).notNull(), // conflict_detection, batch_operation, keyboard_shortcuts, performance_metrics
  action: varchar('action', { length: 20 }).notNull(), // create, update, delete
  previousVersion: int('previousVersion'),
  newVersion: int('newVersion'),
  
  // Device/client info
  deviceId: varchar('deviceId', { length: 128 }),
  clientVersion: varchar('clientVersion', { length: 20 }),
  
  // Conflict resolution
  hadConflict: int('hadConflict').notNull().default(0), // 0=false, 1=true
  conflictResolution: varchar('conflictResolution', { length: 50 }), // merge, overwrite, keep_local
  
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

export type ConflictDetectionSettings = typeof conflictDetectionSettings.$inferSelect;
export type InsertConflictDetectionSettings = typeof conflictDetectionSettings.$inferInsert;
export type BatchOperationSettings = typeof batchOperationSettings.$inferSelect;
export type InsertBatchOperationSettings = typeof batchOperationSettings.$inferInsert;
export type KeyboardShortcutsSettings = typeof keyboardShortcutsSettings.$inferSelect;
export type InsertKeyboardShortcutsSettings = typeof keyboardShortcutsSettings.$inferInsert;
export type PerformanceMetricsSettings = typeof performanceMetricsSettings.$inferSelect;
export type InsertPerformanceMetricsSettings = typeof performanceMetricsSettings.$inferInsert;
export type SettingsSyncLog = typeof settingsSyncLog.$inferSelect;
export type InsertSettingsSyncLog = typeof settingsSyncLog.$inferInsert;


// ExecutionPlans table - stores execution plan metadata
export const executionPlans = mysqlTable('execution_plans', {
  id: varchar('id', { length: 255 }).primaryKey(),
  cardId: varchar('cardId', { length: 255 }).notNull(),
  userId: int('userId').notNull(),
  objective: text('objective').notNull(),
  inputs: text('inputs').notNull(), // JSON stringified
  outputs: text('outputs').notNull(), // JSON stringified
  stepsJson: text('stepsJson').notNull(), // JSON stringified
  iterationFlowsJson: text('iterationFlowsJson').notNull(), // JSON stringified
  totalEstimateMin: int('totalEstimateMin').notNull(),
  totalEstimateMax: int('totalEstimateMax').notNull(),
  generatedBy: mysqlEnum('generatedBy', ['manual', 'ai']).notNull().default('manual'),
  qualityScore: int('qualityScore').default(85), // 0-100 score from quality check
  validationStatus: mysqlEnum('validationStatus', ['initial', 'validated', 'needs_review', 'quality_check_failed']).default('initial'),
  qualityFeedback: text('qualityFeedback'), // Feedback from quality check
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// ExecutionPlanSteps table - stores individual step statuses
export const executionPlanSteps = mysqlTable('execution_plan_steps', {
  id: varchar('id', { length: 255 }).primaryKey(),
  executionPlanId: varchar('executionPlanId', { length: 255 }).notNull(),
  stepId: varchar('stepId', { length: 255 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  dependencies: text('dependencies').notNull(), // JSON stringified array
  parallelizable: int('parallelizable').notNull().default(0),
  timeEstimateMin: int('timeEstimateMin').notNull(),
  timeEstimateMax: int('timeEstimateMax').notNull(),
  risks: text('risks').notNull(), // JSON stringified array
  status: mysqlEnum('status', ['completed', 'in-progress', 'ready', 'blocked']).notNull().default('ready'),
  completedBy: varchar('completedBy', { length: 255 }),
  completedAt: timestamp('completedAt'),
  startedAt: timestamp('startedAt'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

// ExecutionPlanStatusHistory table - audit trail for status changes
export const executionPlanStatusHistory = mysqlTable('execution_plan_status_history', {
  id: varchar('id', { length: 255 }).primaryKey(),
  stepId: varchar('stepId', { length: 255 }).notNull(),
  executionPlanId: varchar('executionPlanId', { length: 255 }).notNull(),
  previousStatus: mysqlEnum('previousStatus', ['completed', 'in-progress', 'ready', 'blocked']).notNull(),
  newStatus: mysqlEnum('newStatus', ['completed', 'in-progress', 'ready', 'blocked']).notNull(),
  changedBy: int('changedBy').notNull(),
  reason: text('reason'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

export type ExecutionPlan = typeof executionPlans.$inferSelect;
export type InsertExecutionPlan = typeof executionPlans.$inferInsert;
export type ExecutionPlanStep = typeof executionPlanSteps.$inferSelect;
export type InsertExecutionPlanStep = typeof executionPlanSteps.$inferInsert;
export type ExecutionPlanStatusHistoryRecord = typeof executionPlanStatusHistory.$inferSelect;
export type InsertExecutionPlanStatusHistory = typeof executionPlanStatusHistory.$inferInsert;


// ─── ARES Configuration Tables ────────────────────────────────────────────────
// ARES = Automated Requirement Evaluation System
// Manages validation rules, thresholds, and strictness levels for goal validation

export const aresConfigurations = mysqlTable('ares_configurations', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: int('userId').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  strictnessLevel: mysqlEnum('strictnessLevel', ['lenient', 'moderate', 'strict']).default('moderate').notNull(),
  confidenceThreshold: int('confidenceThreshold').default(40).notNull(), // Minimum confidence % required
  enableVaguenessCheck: boolean('enableVaguenessCheck').default(true).notNull(),
  enableMeasurabilityCheck: boolean('enableMeasurabilityCheck').default(true).notNull(),
  enableTimelineCheck: boolean('enableTimelineCheck').default(true).notNull(),
  enableResourceCheck: boolean('enableResourceCheck').default(false).notNull(),
  enableDependencyCheck: boolean('enableDependencyCheck').default(false).notNull(),
  isDefault: boolean('isDefault').default(false).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export const aresValidationRules = mysqlTable('ares_validation_rules', {
  id: varchar('id', { length: 64 }).primaryKey(),
  configId: varchar('configId', { length: 64 }).notNull(),
  ruleType: mysqlEnum('ruleType', [
    'vagueness',
    'measurability',
    'timeline',
    'resources',
    'dependencies',
    'clarity',
    'specificity',
    'actionability'
  ]).notNull(),
  ruleName: varchar('ruleName', { length: 255 }).notNull(),
  description: text('description'),
  severity: mysqlEnum('severity', ['info', 'warning', 'error']).default('warning').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  threshold: int('threshold').default(50), // Percentage or score threshold
  customLogic: text('customLogic'), // JSON string for custom validation logic
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().onUpdateNow().notNull(),
});

export const aresValidationHistory = mysqlTable('ares_validation_history', {
  id: varchar('id', { length: 64 }).primaryKey(),
  configId: varchar('configId', { length: 64 }).notNull(),
  cardId: varchar('cardId', { length: 64 }).notNull(),
  cardName: text('cardName').notNull(),
  goalDefinition: text('goalDefinition'),
  confidenceScore: int('confidenceScore').notNull(),
  passed: boolean('passed').notNull(),
  failedRules: text('failedRules'), // JSON array of failed rule IDs
  warnings: text('warnings'), // JSON array of warnings
  validationDetails: text('validationDetails'), // JSON object with detailed results
  validatedAt: timestamp('validatedAt').defaultNow().notNull(),
  validatedBy: int('validatedBy').notNull(),
});

export type AresConfiguration = typeof aresConfigurations.$inferSelect;
export type InsertAresConfiguration = typeof aresConfigurations.$inferInsert;
export type AresValidationRule = typeof aresValidationRules.$inferSelect;
export type InsertAresValidationRule = typeof aresValidationRules.$inferInsert;
export type AresValidationHistoryRecord = typeof aresValidationHistory.$inferSelect;
export type InsertAresValidationHistory = typeof aresValidationHistory.$inferInsert;

// ─── APTLSS PLANS & STEPS (Merged from Manus Dashboard) ───

export const aptlssPlans = mysqlTable("aptlss_plans", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull(),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull(),
  boardName: varchar("boardName", { length: 256 }).notNull().default(""),
  listName: varchar("listName", { length: 256 }).notNull().default(""),
  planJson: text("planJson").notNull(),
  contextSnapshot: text("contextSnapshot"),
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('va_aptlss_plan_card_idx').on(table.vaId, table.cardId)
]);

export const aptlssSteps = mysqlTable("aptlss_steps", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  trelloChecklistId: varchar("trelloChecklistId", { length: 64 }),
  trelloCheckItemId: varchar("trelloCheckItemId", { length: 64 }),
  stepNumber: int("stepNumber").notNull(),
  title: varchar("title", { length: 1024 }).notNull(),
  estimatedMinutes: int("estimatedMinutes").notNull().default(15),
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
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("va_aptlss_step_card_idx").on(table.vaId, table.cardId),
]);

export const cardStates = mysqlTable("card_states", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  boardName: varchar("boardName", { length: 256 }).notNull().default(""),
  listName: varchar("listName", { length: 256 }).notNull().default(""),
  state: varchar("state", { length: 64 }).notNull().default("NEW_UNTRIAGED"),
  stateReason: text("stateReason"),
  daysSinceProgress: int("daysSinceProgress").notNull().default(0),
  hasUnansweredQuestion: boolean("hasUnansweredQuestion").notNull().default(false),
  isOverdue: boolean("isOverdue").notNull().default(false),
  checklistComplete: boolean("checklistComplete").notNull().default(false),
  hasFinalSummary: boolean("hasFinalSummary").notNull().default(false),
  calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('va_card_state_card_idx').on(table.vaId, table.cardId)
]);

export const priorityScores = mysqlTable("priority_scores", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  score: int("score").notNull().default(0),
  breakdown: text("breakdown"),
  tier: varchar("tier", { length: 16 }).notNull().default("MEDIUM"),
  estimatedRemainingMinutes: int("estimatedRemainingMinutes").notNull().default(0),
  openSteps: int("openSteps").notNull().default(0),
  completedSteps: int("completedSteps").notNull().default(0),
  calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex('va_priority_score_card_idx').on(table.vaId, table.cardId)
]);

export const aptlssOperationalPolicies = mysqlTable("aptlss_operational_policies", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  ruleKey: varchar("ruleKey", { length: 128 }).notNull(),
  label: varchar("label", { length: 256 }).notNull().default(""),
  description: text("description"),
  value: text("value").notNull().default("{}"),
  category: varchar("category", { length: 64 }).notNull().default("general"),
  enabled: int("enabled").notNull().default(1),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex('va_operational_policy_idx').on(table.vaId, table.ruleKey)
]);

export const workerPerformanceSignals = mysqlTable("worker_performance_signals", {
  id: int("id").autoincrement().primaryKey(),
  workerId: varchar("workerId", { length: 128 }).notNull(),
  workerName: varchar("workerName", { length: 256 }).notNull().default(""),
  weekKey: varchar("weekKey", { length: 16 }).notNull(),
  avgResponseTimeMinutes: int("avgResponseTimeMinutes").notNull().default(0),
  checklistItemsCompleted: int("checklistItemsCompleted").notNull().default(0),
  stalledCardsCount: int("stalledCardsCount").notNull().default(0),
  missedDeadlines: int("missedDeadlines").notNull().default(0),
  robertEscalationsCount: int("robertEscalationsCount").notNull().default(0),
  reworkCount: int("reworkCount").notNull().default(0),
  unclearHandovers: int("unclearHandovers").notNull().default(0),
  notes: text("notes"),
  calculatedAt: timestamp("calculatedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const weeklyAnalysisSnapshots = mysqlTable("weekly_analysis_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
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
}, (table) => [
  uniqueIndex('va_weekly_analysis_idx').on(table.vaId, table.weekKey)
]);

export const autoFollowUpDrafts = mysqlTable("auto_follow_up_drafts", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  draftMessage: text("draftMessage").notNull(),
  reason: varchar("reason", { length: 512 }).notNull().default(""),
  hoursSinceLastReply: int("hoursSinceLastReply").notNull().default(0),
  urgencyType: varchar("urgencyType", { length: 32 }).notNull().default("routine"),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const dailyPlans = mysqlTable("daily_plans", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  dateKey: varchar("dateKey", { length: 16 }).notNull(),
  scheduleJson: text("scheduleJson").notNull(),
  dailySummary: text("dailySummary"),
  topPriority: varchar("topPriority", { length: 512 }),
  totalScheduledMinutes: int("totalScheduledMinutes").notNull().default(0),
  robertItemsCount: int("robertItemsCount").notNull().default(0),
  autoGenerated: boolean("autoGenerated").notNull().default(true),
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex('va_daily_plan_idx').on(table.vaId, table.dateKey)
]);

export const aptlssAuditLog = mysqlTable("aptlss_audit_log", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  action: varchar("action", { length: 64 }).notNull(),
  description: text("description").notNull(),
  payload: text("payload"),
  confidenceScore: int("confidenceScore"),
  requiresApproval: boolean("requiresApproval").notNull().default(false),
  approved: boolean("approved"),
  source: varchar("source", { length: 32 }).notNull().default("maintenance_job"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const adminSyncLog = mysqlTable("admin_sync_log", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  syncType: varchar("syncType", { length: 32 }).notNull(),
  success: boolean("success").notNull(),
  cardsProcessed: int("cardsProcessed").notNull().default(0),
  actionsTaken: int("actionsTaken").notNull().default(0),
  cardsSkippedLowConfidence: int("cardsSkippedLowConfidence").notNull().default(0),
  errorMessage: text("errorMessage"),
  durationMs: int("durationMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Additive operator intelligence and evidence tables. These extend the
// developer platform without replacing its identity, scheduling, or APTLSS data.
export const aptlssAssessments = mysqlTable("aptlss_assessments", {
  id: int("id").autoincrement().primaryKey(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  engineVersion: varchar("engineVersion", { length: 32 }).notNull(),
  contextHash: varchar("contextHash", { length: 64 }).notNull(),
  trigger: varchar("trigger", { length: 32 }).notNull().default("manual"),
  primaryState: varchar("primaryState", { length: 64 }).notNull(),
  stateReason: text("stateReason").notNull(),
  secondarySignals: text("secondarySignals").notNull(),
  actionability: varchar("actionability", { length: 32 }).notNull(),
  priorityScore: int("priorityScore").notNull(),
  priorityTier: varchar("priorityTier", { length: 16 }).notNull(),
  priorityBreakdown: text("priorityBreakdown").notNull(),
  confidenceScore: int("confidenceScore").notNull(),
  confidenceBand: varchar("confidenceBand", { length: 16 }).notNull(),
  confidenceReason: text("confidenceReason").notNull(),
  evidenceCoverage: text("evidenceCoverage").notNull(),
  evidenceJson: text("evidenceJson").notNull(),
  intelligenceJson: text("intelligenceJson"),
  uncertaintiesJson: text("uncertaintiesJson").notNull(),
  recommendationsJson: text("recommendationsJson").notNull(),
  lastMeaningfulProgressAt: timestamp("lastMeaningfulProgressAt"),
  daysSinceMeaningfulProgress: int("daysSinceMeaningfulProgress").notNull().default(0),
  nextAssessmentAt: timestamp("nextAssessmentAt").notNull(),
  changeJson: text("changeJson").notNull(),
  evaluationCount: int("evaluationCount").notNull().default(1),
  assessedAt: timestamp("assessedAt").notNull(),
  lastEvaluatedAt: timestamp("lastEvaluatedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("aptlss_assessments_card_assessed_idx").on(table.cardId, table.assessedAt),
  index("aptlss_assessments_next_idx").on(table.nextAssessmentAt),
]);

export const aptlssAssessmentFeedback = mysqlTable("aptlss_assessment_feedback", {
  id: int("id").autoincrement().primaryKey(),
  assessmentId: int("assessmentId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  engineVersion: varchar("engineVersion", { length: 32 }).notNull(),
  predictedState: varchar("predictedState", { length: 64 }).notNull(),
  predictedConfidence: int("predictedConfidence").notNull(),
  verdict: mysqlEnum("verdict", ["accurate", "partial", "inaccurate"]).notNull(),
  correctedState: varchar("correctedState", { length: 64 }),
  note: text("note"),
  createdBy: varchar("createdBy", { length: 128 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("aptlss_assessment_feedback_assessment_idx").on(table.assessmentId),
  index("aptlss_assessment_feedback_card_created_idx").on(table.cardId, table.createdAt),
]);

export const aptlssWaitingReasons = mysqlTable("aptlss_waiting_reasons", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
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
  confidenceScore: int("confidenceScore").notNull(),
  confidenceReason: text("confidenceReason").notNull(),
  interpretationJson: text("interpretationJson").notNull(),
  interpreterVersion: varchar("interpreterVersion", { length: 32 }).notNull(),
  source: varchar("source", { length: 32 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  recordedBy: varchar("recordedBy", { length: 128 }).notNull(),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("aptlss_waiting_reasons_va_status_idx").on(table.vaId, table.status, table.createdAt),
  index("aptlss_waiting_reasons_card_status_idx").on(table.cardId, table.status, table.createdAt),
  index("aptlss_waiting_reasons_follow_up_idx").on(table.status, table.followUpAt),
]);

export const decisionOutcomes = mysqlTable("decision_outcomes", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  stepId: int("stepId").notNull().unique(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  cardName: varchar("cardName", { length: 512 }).notNull().default(""),
  cardUrl: varchar("cardUrl", { length: 1024 }).notNull().default(""),
  boardName: varchar("boardName", { length: 256 }).notNull().default(""),
  listName: varchar("listName", { length: 256 }).notNull().default(""),
  decisionPrompt: text("decisionPrompt").notNull(),
  recommendedDecision: text("recommendedDecision"),
  outcome: text("outcome").notNull(),
  resolvedBy: varchar("resolvedBy", { length: 64 }).notNull(),
  resolvedAt: timestamp("resolvedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("decision_outcomes_va_resolved_idx").on(table.vaId, table.resolvedAt),
]);

export const workspaceEvidenceItems = mysqlTable("workspace_evidence_items", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId"),
  source: mysqlEnum("source", ["gmail", "google_drive", "trello", "communication"]).notNull(),
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
  reviewStatus: mysqlEnum("reviewStatus", ["unreviewed", "linked", "not_work_related"]).notNull().default("unreviewed"),
  reviewedAt: timestamp("reviewedAt"),
  reviewedBy: varchar("reviewedBy", { length: 128 }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("workspace_evidence_va_source_id_unique").on(table.vaId, table.source, table.sourceId),
  index("workspace_evidence_va_source_modified_idx").on(table.vaId, table.source, table.modifiedAt),
  index("workspace_evidence_va_active_observed_idx").on(table.vaId, table.active, table.observedAt),
  index("workspace_evidence_va_review_idx").on(table.vaId, table.reviewStatus, table.modifiedAt),
]);

export const workspaceEvidenceLinks = mysqlTable("workspace_evidence_links", {
  id: int("id").autoincrement().primaryKey(),
  evidenceId: int("evidenceId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  relevanceScore: int("relevanceScore").notNull(),
  matchReason: varchar("matchReason", { length: 512 }).notNull(),
  linkMethod: mysqlEnum("linkMethod", ["automatic", "manual"]).notNull().default("automatic"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.evidenceId],
    foreignColumns: [workspaceEvidenceItems.id],
    name: "workspace_evidence_item_fk",
  }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("workspace_evidence_link_unique").on(table.evidenceId, table.cardId),
  index("workspace_evidence_card_relevance_idx").on(table.cardId, table.relevanceScore),
]);

export const communicationEvidence = mysqlTable("communication_evidence", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId"),
  channel: varchar("channel", { length: 64 }).notNull(),
  externalId: varchar("externalId", { length: 256 }).notNull(),
  threadId: varchar("threadId", { length: 256 }),
  direction: mysqlEnum("direction", ["inbound", "outbound", "system", "unknown"]).notNull().default("unknown"),
  sender: varchar("sender", { length: 512 }),
  recipientsJson: text("recipientsJson"),
  subject: varchar("subject", { length: 1024 }),
  summary: text("summary"),
  occurredAt: timestamp("occurredAt").notNull(),
  responseRequired: boolean("responseRequired").notNull().default(false),
  respondedAt: timestamp("respondedAt"),
  linkedCardId: varchar("linkedCardId", { length: 64 }),
  evidenceItemId: int("evidenceItemId"),
  metadataJson: text("metadataJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("communication_evidence_va_channel_external_unique").on(table.vaId, table.channel, table.externalId),
  index("communication_evidence_va_card_occurred_idx").on(table.vaId, table.linkedCardId, table.occurredAt),
  index("communication_evidence_va_response_idx").on(table.vaId, table.responseRequired, table.respondedAt),
]);

export const complianceCardEvidence = mysqlTable("compliance_card_evidence", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId"),
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
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("compliance_evidence_va_date_card_unique").on(table.vaId, table.snapshotDate, table.cardId),
  index("compliance_evidence_va_card_date_idx").on(table.vaId, table.cardId, table.snapshotDate),
  index("compliance_evidence_va_date_compliant_idx").on(table.vaId, table.snapshotDate, table.compliant),
]);

export const complianceCommunicationEvidence = mysqlTable("compliance_communication_evidence", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId"),
  snapshotDate: date("snapshotDate").notNull(),
  evidenceKey: varchar("evidenceKey", { length: 256 }).notNull(),
  kind: mysqlEnum("kind", ["message_response", "email_processing"]).notNull(),
  channel: varchar("channel", { length: 64 }).notNull(),
  externalId: varchar("externalId", { length: 256 }).notNull(),
  title: varchar("title", { length: 1024 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 1024 }),
  occurredAt: timestamp("occurredAt").notNull(),
  dueAt: timestamp("dueAt"),
  outcome: mysqlEnum("outcome", ["verified", "missed", "needs_clarification", "excluded"]).notNull(),
  evidenceType: varchar("evidenceType", { length: 64 }).notNull(),
  evidenceAt: timestamp("evidenceAt"),
  evidenceJson: text("evidenceJson").notNull(),
  verifiedAt: timestamp("verifiedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("compliance_comm_va_date_key_unique").on(table.vaId, table.snapshotDate, table.evidenceKey),
  index("compliance_comm_va_date_kind_outcome_idx").on(table.vaId, table.snapshotDate, table.kind, table.outcome),
  index("compliance_comm_va_external_idx").on(table.vaId, table.channel, table.externalId),
]);

export const complianceClarificationRequests = mysqlTable("compliance_clarification_requests", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId"),
  snapshotDate: date("snapshotDate").notNull(),
  evidenceKey: varchar("evidenceKey", { length: 256 }).notNull(),
  kind: mysqlEnum("kind", ["message_response", "email_processing"]).notNull(),
  channel: varchar("channel", { length: 64 }).notNull(),
  externalId: varchar("externalId", { length: 256 }).notNull(),
  title: varchar("title", { length: 1024 }).notNull(),
  question: text("question").notNull(),
  status: mysqlEnum("status", ["open", "resolved", "superseded"]).notNull().default("open"),
  resolution: mysqlEnum("resolution", ["completed", "not_completed", "not_required"]),
  response: text("response"),
  requestedAt: timestamp("requestedAt").defaultNow().notNull(),
  respondedAt: timestamp("respondedAt"),
  resolvedAt: timestamp("resolvedAt"),
  sourceJson: text("sourceJson").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("compliance_clarification_va_date_key_unique").on(table.vaId, table.snapshotDate, table.evidenceKey),
  index("compliance_clarification_va_status_requested_idx").on(table.vaId, table.status, table.requestedAt),
]);

export const timeEntryEvents = mysqlTable("time_entry_events", {
  id: int("id").autoincrement().primaryKey(),
  timeEntryId: int("timeEntryId").notNull(),
  eventType: varchar("eventType", { length: 32 }).notNull(),
  reason: text("reason"),
  beforeJson: text("beforeJson"),
  afterJson: text("afterJson"),
  metadataJson: text("metadataJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("time_entry_events_entry_created_idx").on(table.timeEntryId, table.createdAt),
  index("time_entry_events_type_created_idx").on(table.eventType, table.createdAt),
]);

export const timeDayReviews = mysqlTable("time_day_reviews", {
  id: int("id").autoincrement().primaryKey(),
  dateKey: varchar("dateKey", { length: 16 }).notNull().unique(),
  status: mysqlEnum("status", ["open", "needs_review", "locked"]).notNull().default("open"),
  overtimeReason: text("overtimeReason"),
  summaryJson: text("summaryJson"),
  lockedAt: timestamp("lockedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("time_day_reviews_status_date_idx").on(table.status, table.dateKey),
]);

export const timeReconciliationItems = mysqlTable("time_reconciliation_items", {
  id: int("id").autoincrement().primaryKey(),
  dateKey: varchar("dateKey", { length: 16 }).notNull(),
  fingerprint: varchar("fingerprint", { length: 256 }).notNull().unique(),
  type: varchar("type", { length: 48 }).notNull(),
  severity: mysqlEnum("severity", ["low", "medium", "high"]).notNull().default("medium"),
  status: mysqlEnum("status", ["open", "resolved", "dismissed", "superseded"]).notNull().default("open"),
  cardId: varchar("cardId", { length: 64 }),
  cardName: varchar("cardName", { length: 512 }),
  cardUrl: varchar("cardUrl", { length: 1024 }),
  boardName: varchar("boardName", { length: 256 }),
  listName: varchar("listName", { length: 256 }),
  timeEntryId: int("timeEntryId"),
  planBlockId: varchar("planBlockId", { length: 128 }),
  title: varchar("title", { length: 512 }).notNull(),
  detail: text("detail").notNull(),
  sourceJson: text("sourceJson").notNull(),
  resolution: text("resolution"),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("time_reconciliation_date_status_idx").on(table.dateKey, table.status),
  index("time_reconciliation_entry_idx").on(table.timeEntryId),
]);

export const scheduledJobRuns = mysqlTable("scheduled_job_runs", {
  id: int("id").autoincrement().primaryKey(),
  jobKey: varchar("jobKey", { length: 96 }).notNull(),
  trigger: mysqlEnum("trigger", ["cron", "external", "manual"]).notNull().default("cron"),
  status: mysqlEnum("status", ["running", "success", "error", "abandoned"]).notNull().default("running"),
  startedAt: timestamp("startedAt").notNull(),
  finishedAt: timestamp("finishedAt"),
  durationMs: int("durationMs"),
  recordsProcessed: int("recordsProcessed").notNull().default(0),
  detail: text("detail"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("scheduled_job_runs_job_started_idx").on(table.jobKey, table.startedAt),
  index("scheduled_job_runs_status_started_idx").on(table.status, table.startedAt),
]);

export const scheduledJobLeases = mysqlTable("scheduled_job_leases", {
  jobKey: varchar("jobKey", { length: 96 }).primaryKey(),
  ownerToken: varchar("ownerToken", { length: 64 }).notNull(),
  acquiredAt: timestamp("acquiredAt").notNull(),
  heartbeatAt: timestamp("heartbeatAt").notNull(),
  leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
}, (table) => [
  index("scheduled_job_leases_expiry_idx").on(table.leaseExpiresAt),
]);

export const maintenanceJobSettings = mysqlTable("maintenance_job_settings", {
  jobKey: varchar("jobKey", { length: 96 }).primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  intervalMinutes: int("intervalMinutes").notNull(),
  lastScheduledAt: timestamp("lastScheduledAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const browserTabStates = mysqlTable("browser_tab_states", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  collectorId: varchar("collectorId", { length: 128 }).notNull().unique(),
  collectorLabel: varchar("collectorLabel", { length: 128 }).notNull().default("Worker browser"),
  totalTabs: int("totalTabs").notNull().default(0),
  pinnedTabs: int("pinnedTabs").notNull().default(0),
  windowCount: int("windowCount").notNull().default(0),
  tabsJson: text("tabsJson").notNull(),
  capturedAt: timestamp("capturedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("browser_tab_states_va_captured_idx").on(table.vaId, table.capturedAt),
  index("browser_tab_states_captured_idx").on(table.capturedAt),
]);

export const browserTabDailyEvidence = mysqlTable("browser_tab_daily_evidence", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  snapshotDate: date("snapshotDate").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  totalTabs: int("totalTabs").notNull().default(0),
  actionableTabs: int("actionableTabs").notNull().default(0),
  allowedTabs: int("allowedTabs").notNull().default(0),
  compliant: boolean("compliant").notNull().default(false),
  source: varchar("source", { length: 32 }).notNull().default("auto"),
  evidenceJson: text("evidenceJson").notNull(),
  capturedAt: timestamp("capturedAt"),
  verifiedAt: timestamp("verifiedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  uniqueIndex("browser_tab_daily_va_date_idx").on(table.vaId, table.snapshotDate),
  index("browser_tab_daily_status_date_idx").on(table.status, table.snapshotDate),
]);

export type AptlssPlan = typeof aptlssPlans.$inferSelect;
export type InsertAptlssPlan = typeof aptlssPlans.$inferInsert;
export type AptlssStep = typeof aptlssSteps.$inferSelect;
export type InsertAptlssStep = typeof aptlssSteps.$inferInsert;
export type CardState = typeof cardStates.$inferSelect;
export type InsertCardState = typeof cardStates.$inferInsert;
export type PriorityScore = typeof priorityScores.$inferSelect;
export type InsertPriorityScore = typeof priorityScores.$inferInsert;
export type AptlssOperationalPolicy = typeof aptlssOperationalPolicies.$inferSelect;
export type InsertAptlssOperationalPolicy = typeof aptlssOperationalPolicies.$inferInsert;
export type WorkerPerformanceSignal = typeof workerPerformanceSignals.$inferSelect;
export type InsertWorkerPerformanceSignal = typeof workerPerformanceSignals.$inferInsert;
export type WeeklyAnalysisSnapshot = typeof weeklyAnalysisSnapshots.$inferSelect;
export type InsertWeeklyAnalysisSnapshot = typeof weeklyAnalysisSnapshots.$inferInsert;
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
export type AptlssAssessmentFeedback = typeof aptlssAssessmentFeedback.$inferSelect;
export type InsertAptlssAssessmentFeedback = typeof aptlssAssessmentFeedback.$inferInsert;
export type AptlssWaitingReason = typeof aptlssWaitingReasons.$inferSelect;
export type InsertAptlssWaitingReason = typeof aptlssWaitingReasons.$inferInsert;
export type DecisionOutcome = typeof decisionOutcomes.$inferSelect;
export type InsertDecisionOutcome = typeof decisionOutcomes.$inferInsert;
export type WorkspaceEvidenceItem = typeof workspaceEvidenceItems.$inferSelect;
export type InsertWorkspaceEvidenceItem = typeof workspaceEvidenceItems.$inferInsert;
export type WorkspaceEvidenceLink = typeof workspaceEvidenceLinks.$inferSelect;
export type InsertWorkspaceEvidenceLink = typeof workspaceEvidenceLinks.$inferInsert;
export type CommunicationEvidence = typeof communicationEvidence.$inferSelect;
export type InsertCommunicationEvidence = typeof communicationEvidence.$inferInsert;
export type ComplianceCardEvidence = typeof complianceCardEvidence.$inferSelect;
export type InsertComplianceCardEvidence = typeof complianceCardEvidence.$inferInsert;
export type ComplianceCommunicationEvidence = typeof complianceCommunicationEvidence.$inferSelect;
export type InsertComplianceCommunicationEvidence = typeof complianceCommunicationEvidence.$inferInsert;
export type ComplianceClarificationRequest = typeof complianceClarificationRequests.$inferSelect;
export type InsertComplianceClarificationRequest = typeof complianceClarificationRequests.$inferInsert;
export type TimeEntryEvent = typeof timeEntryEvents.$inferSelect;
export type InsertTimeEntryEvent = typeof timeEntryEvents.$inferInsert;
export type TimeDayReview = typeof timeDayReviews.$inferSelect;
export type InsertTimeDayReview = typeof timeDayReviews.$inferInsert;
export type TimeReconciliationItem = typeof timeReconciliationItems.$inferSelect;
export type InsertTimeReconciliationItem = typeof timeReconciliationItems.$inferInsert;
export type ScheduledJobRun = typeof scheduledJobRuns.$inferSelect;
export type InsertScheduledJobRun = typeof scheduledJobRuns.$inferInsert;
export type MaintenanceJobSetting = typeof maintenanceJobSettings.$inferSelect;
export type InsertMaintenanceJobSetting = typeof maintenanceJobSettings.$inferInsert;
export type ScheduledJobLease = typeof scheduledJobLeases.$inferSelect;
export type InsertScheduledJobLease = typeof scheduledJobLeases.$inferInsert;
export type BrowserTabState = typeof browserTabStates.$inferSelect;
export type InsertBrowserTabState = typeof browserTabStates.$inferInsert;
export type BrowserTabDailyEvidence = typeof browserTabDailyEvidence.$inferSelect;
export type InsertBrowserTabDailyEvidence = typeof browserTabDailyEvidence.$inferInsert;
export type UnsignedMessageFlag = typeof unsignedMessageFlags.$inferSelect;
export type InsertUnsignedMessageFlag = typeof unsignedMessageFlags.$inferInsert;

// ─── APTLSS PLANS & STEPS (Merged from Manus Dashboard) ───

export const aptlssManagerState = mysqlTable("aptlss_manager_state", {
  vaId: int("vaId").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  intervalMinutes: int("intervalMinutes").notNull().default(5),
  mode: mysqlEnum("mode", ["shadow", "active"]).notNull().default("shadow"),
  policyRevision: int("policyRevision").notNull().default(0),
  shadowStartedAt: timestamp("shadowStartedAt").defaultNow().notNull(),
  lastSuccessfulAt: timestamp("lastSuccessfulAt"),
  checkedAt: timestamp("checkedAt"),
  inputHash: varchar("inputHash", { length: 64 }),
  sourceHash: varchar("sourceHash", { length: 64 }),
  lastError: varchar("lastError", { length: 512 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const aptlssManagerUpdates = mysqlTable("aptlss_manager_updates", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }).notNull(),
  detail: text("detail").notNull(),
  interventionId: varchar("interventionId", { length: 256 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [index("aptlss_manager_updates_worker_card_idx").on(table.vaId, table.cardId, table.createdAt)]);

export const aptlssManagerRuns = mysqlTable("aptlss_manager_runs", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  inputHash: varchar("inputHash", { length: 64 }).notNull(),
  trigger: varchar("trigger", { length: 32 }).notNull(),
  mode: mysqlEnum("mode", ["shadow", "active"]).notNull().default("shadow"),
  proposalHash: varchar("proposalHash", { length: 64 }),
  previousPlanJson: longtext("previousPlanJson"),
  appliedPlanHash: varchar("appliedPlanHash", { length: 64 }),
  snapshotJson: longtext("snapshotJson").notNull(),
  reviewDigest: varchar("reviewDigest", { length: 64 }).generatedAlwaysAs(sql`JSON_UNQUOTE(JSON_EXTRACT(snapshotJson, '$.implementationDigest'))`, { mode: "virtual" }),
  reviewUrgent: boolean("reviewUrgent").generatedAlwaysAs(sql`COALESCE(JSON_CONTAINS(JSON_EXTRACT(snapshotJson, '$.interventions[*].severity'), '"urgent"'), 0)`, { mode: "virtual" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("aptlss_manager_runs_worker_created_idx").on(table.vaId, table.createdAt, table.id),
  index("aptlss_manager_runs_proposal_idx").on(table.vaId, table.proposalHash, table.createdAt, table.id),
  index("aptlss_manager_runs_review_idx").on(table.vaId, table.reviewDigest, table.proposalHash, table.mode, table.createdAt, table.id, table.reviewUrgent),
]);

export const aptlssManagerReviews = mysqlTable("aptlss_manager_reviews", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  runId: int("runId").notNull(),
  proposalHash: varchar("proposalHash", { length: 64 }).notNull(),
  verdict: mysqlEnum("verdict", ["correct", "incorrect", "insufficient"]).notNull(),
  critical: boolean("critical").notNull().default(false),
  correction: text("correction").notNull(),
  source: text("source").notNull(),
  reviewerId: int("reviewerId").notNull(),
  reviewedAt: timestamp("reviewedAt").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("aptlss_manager_review_run_unique").on(table.runId),
  index("aptlss_manager_review_worker_idx").on(table.vaId, table.reviewedAt),
  index("aptlss_manager_reviews_proposal_idx").on(table.vaId, table.proposalHash, table.runId),
  foreignKey({ columns: [table.runId], foreignColumns: [aptlssManagerRuns.id], name: "manager_review_run_fk" }),
]);

// One deployment-wide pilot lease serializes activation across application processes.
export const aptlssManagerControl = mysqlTable("aptlss_manager_control", {
  id: int("id").primaryKey(),
  activeVaId: int("activeVaId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Trial lifecycle events are appended; historical runs and reviews are never reset.
export const aptlssManagerTrialEvents = mysqlTable("aptlss_manager_trial_events", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  trialKey: varchar("trialKey", { length: 64 }).notNull(),
  event: mysqlEnum("event", ["started", "closed"]).notNull(),
  afterRunId: int("afterRunId").notNull(),
  implementationDigest: varchar("implementationDigest", { length: 64 }).notNull(),
  actorId: int("actorId").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("aptlss_manager_trial_event_unique").on(table.vaId, table.trialKey, table.event),
  index("aptlss_manager_trial_worker_idx").on(table.vaId, table.id),
]);

export const aptlssManagerCorrections = mysqlTable("aptlss_manager_corrections", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  reviewId: int("reviewId").notNull(),
  scope: mysqlEnum("scope", ["card", "worker"]).notNull().default("card"),
  cardId: varchar("cardId", { length: 64 }),
  topic: varchar("topic", { length: 64 }).notNull(),
  correction: text("correction").notNull(),
  conditionsJson: text("conditionsJson").notNull(),
  evidenceJson: longtext("evidenceJson").notNull(),
  validFrom: timestamp("validFrom").notNull(),
  validUntil: timestamp("validUntil").notNull(),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  revokedAt: timestamp("revokedAt"),
  revokedBy: int("revokedBy"),
  revocationReason: text("revocationReason"),
}, table => [
  uniqueIndex("aptlss_manager_correction_review_unique").on(table.reviewId),
  index("aptlss_manager_correction_scope_idx").on(table.vaId, table.scope, table.cardId, table.validUntil),
  foreignKey({ columns: [table.reviewId], foreignColumns: [aptlssManagerReviews.id], name: "manager_correction_review_fk" }),
]);

// The graph is additive: workspaceEvidenceItems remains the canonical retained source record.
export const aptlssEvidenceRevisions = mysqlTable("aptlss_evidence_revisions", {
  id: int("id").autoincrement().primaryKey(),
  evidenceId: int("evidenceId").notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  truthClass: mysqlEnum("truthClass", ["source_record", "worker_assertion", "system_inference"]).notNull(),
  summary: text("summary"),
  content: text("content"),
  metadataJson: text("metadataJson"),
  observedAt: timestamp("observedAt").notNull(),
  recordedBy: varchar("recordedBy", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.evidenceId],
    foreignColumns: [workspaceEvidenceItems.id],
    name: "aptlss_evidence_revision_item_fk",
  }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("aptlss_evidence_revision_hash_unique").on(table.evidenceId, table.contentHash),
  index("aptlss_evidence_revision_observed_idx").on(table.evidenceId, table.observedAt),
]);

export const aptlssEvidenceSubjectLinks = mysqlTable("aptlss_evidence_subject_links", {
  id: int("id").autoincrement().primaryKey(),
  evidenceId: int("evidenceId").notNull(),
  vaId: int("vaId").notNull(),
  subjectType: mysqlEnum("subjectType", ["card", "worker", "decision", "plan_block"]).notNull(),
  subjectId: varchar("subjectId", { length: 256 }).notNull(),
  relevanceScore: int("relevanceScore").notNull(),
  linkMethod: mysqlEnum("linkMethod", ["automatic", "manual", "confirmed"]).notNull().default("automatic"),
  matchReason: varchar("matchReason", { length: 512 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.evidenceId],
    foreignColumns: [workspaceEvidenceItems.id],
    name: "aptlss_evidence_subject_item_fk",
  }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("aptlss_evidence_subject_unique").on(table.evidenceId, table.vaId, table.subjectType, table.subjectId),
  index("aptlss_evidence_subject_lookup_idx").on(table.vaId, table.subjectType, table.subjectId, table.relevanceScore),
]);

export const aptlssEvidenceConflicts = mysqlTable("aptlss_evidence_conflicts", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  sourceEvidenceId: int("sourceEvidenceId").notNull(),
  assertedEvidenceId: int("assertedEvidenceId").notNull(),
  status: mysqlEnum("status", ["needs_verification", "consistent", "resolved", "dismissed"]).notNull().default("needs_verification"),
  resolution: text("resolution"),
  resolvedBy: varchar("resolvedBy", { length: 128 }),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
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

export const aptlssVerificationFollowups = mysqlTable("aptlss_verification_followups", {
  id: int("id").autoincrement().primaryKey(),
  vaId: int("vaId").notNull(),
  cardId: varchar("cardId", { length: 64 }),
  conflictId: int("conflictId"),
  title: varchar("title", { length: 512 }).notNull(),
  question: text("question").notNull(),
  status: mysqlEnum("status", ["open", "resolved", "superseded"]).notNull().default("open"),
  dueAt: timestamp("dueAt"),
  resolution: text("resolution"),
  resolvedBy: varchar("resolvedBy", { length: 128 }),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.conflictId],
    foreignColumns: [aptlssEvidenceConflicts.id],
    name: "aptlss_verification_followup_conflict_fk",
  }).onDelete("set null").onUpdate("cascade"),
  index("aptlss_verification_followup_va_status_idx").on(table.vaId, table.status, table.dueAt),
  index("aptlss_verification_followup_card_idx").on(table.cardId, table.status),
]);

export type AptlssEvidenceRevision = typeof aptlssEvidenceRevisions.$inferSelect;

export type InsertAptlssEvidenceRevision = typeof aptlssEvidenceRevisions.$inferInsert;

export type AptlssEvidenceSubjectLink = typeof aptlssEvidenceSubjectLinks.$inferSelect;

export type InsertAptlssEvidenceSubjectLink = typeof aptlssEvidenceSubjectLinks.$inferInsert;

export type AptlssEvidenceConflict = typeof aptlssEvidenceConflicts.$inferSelect;

export type InsertAptlssEvidenceConflict = typeof aptlssEvidenceConflicts.$inferInsert;

export type AptlssVerificationFollowup = typeof aptlssVerificationFollowups.$inferSelect;

export type InsertAptlssVerificationFollowup = typeof aptlssVerificationFollowups.$inferInsert;

export { aptlssManagerQueue, aptlssManagerQueueEvents, aptlssManagerQueueSlots } from "./aptlssManagerQueueSchema";
