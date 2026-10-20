import {
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const aptlssManagerQueue = mysqlTable(
  "aptlss_manager_queue",
  {
    vaId: int("vaId").primaryKey(),
    state: mysqlEnum("state", ["idle", "pending", "leased", "failed"])
      .notNull()
      .default("idle"),
    generation: int("generation").notNull().default(0),
    claimedGeneration: int("claimedGeneration").notNull().default(0),
    priority: int("priority").notNull().default(0),
    trigger: varchar("trigger", { length: 40 }).notNull().default("periodic"),
    availableAt: timestamp("availableAt", { fsp: 3 }).notNull().defaultNow(),
    requestedAt: timestamp("requestedAt", { fsp: 3 }).notNull().defaultNow(),
    attempts: int("attempts").notNull().default(0),
    leaseToken: varchar("leaseToken", { length: 64 }),
    leaseUntil: timestamp("leaseUntil", { fsp: 3 }),
    lastError: varchar("lastError", { length: 255 }),
    completedAt: timestamp("completedAt", { fsp: 3 }),
    updatedAt: timestamp("updatedAt", { fsp: 3 })
      .notNull()
      .defaultNow(),
  },
  t => [
    index("manager_queue_ready_idx").on(t.state, t.availableAt, t.priority),
    index("manager_queue_lease_idx").on(t.state, t.leaseUntil),
  ]
);

export const aptlssManagerQueueEvents = mysqlTable(
  "aptlss_manager_queue_events",
  {
    eventHash: varchar("eventHash", { length: 64 }).primaryKey(),
    vaId: int("vaId").notNull(),
    createdAt: timestamp("createdAt", { fsp: 3 }).notNull().defaultNow(),
  },
  t => [index("manager_queue_event_worker_idx").on(t.vaId, t.createdAt)]
);

export const aptlssManagerQueueSlots = mysqlTable(
  "aptlss_manager_queue_slots",
  {
    id: int("id").primaryKey(),
    vaId: int("vaId"),
    token: varchar("token", { length: 64 }),
    leaseUntil: timestamp("leaseUntil", { fsp: 3 }),
  }
);
