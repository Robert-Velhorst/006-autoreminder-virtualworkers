import { eq, and } from "drizzle-orm";
import { drizzle as drizzleMySQL, type MySql2Database } from "drizzle-orm/mysql2";
import mysql2 from "mysql2/promise";
import { InsertUser, users } from "../drizzle/schema";
import * as schema from "../drizzle/schema";
import { ENV } from './_core/env';
import { parseDateKey } from "./utils/date-only";

let _db: MySql2Database<typeof schema> | null = null;
let _pool: mysql2.Pool | null = null;
let _initializing: Promise<MySql2Database<typeof schema> | null> | null = null;
let _closing: Promise<void> | null = null;

/**
 * Detect database type from CONNECTION_STRING
 * - mysql:// -> MySQL
 * - file:// or sqlite:// -> SQLite
 */
function detectDatabaseType(url: string): "mysql" | "sqlite" {
  if (url.startsWith("mysql://")) return "mysql";
  if (url.startsWith("file://") || url.startsWith("sqlite://")) return "sqlite";
  return "mysql"; // Default
}

/**
 * Run the legacy compatibility migrations on the pool's first ready connection.
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 */
async function runPendingMigrations(conn: mysql2.PoolConnection): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS \`ares_configurations\` (
        \`id\` varchar(64) NOT NULL,
        \`userId\` int NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`description\` text,
        \`strictnessLevel\` enum('lenient','moderate','strict') NOT NULL DEFAULT 'moderate',
        \`confidenceThreshold\` int NOT NULL DEFAULT 40,
        \`enableVaguenessCheck\` boolean NOT NULL DEFAULT true,
        \`enableMeasurabilityCheck\` boolean NOT NULL DEFAULT true,
        \`enableTimelineCheck\` boolean NOT NULL DEFAULT true,
        \`enableResourceCheck\` boolean NOT NULL DEFAULT false,
        \`enableDependencyCheck\` boolean NOT NULL DEFAULT false,
        \`isDefault\` boolean NOT NULL DEFAULT false,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`)
      )`,
      `CREATE TABLE IF NOT EXISTS \`ares_validation_rules\` (
        \`id\` varchar(64) NOT NULL,
        \`configId\` varchar(64) NOT NULL,
        \`ruleType\` enum('vagueness','measurability','timeline','resources','dependencies','clarity','specificity','actionability') NOT NULL,
        \`ruleName\` varchar(255) NOT NULL,
        \`description\` text,
        \`severity\` enum('info','warning','error') NOT NULL DEFAULT 'warning',
        \`enabled\` boolean NOT NULL DEFAULT true,
        \`threshold\` int DEFAULT 50,
        \`customLogic\` text,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`ares_rules_config_fk\` FOREIGN KEY (\`configId\`) REFERENCES \`ares_configurations\`(\`id\`)
      )`,
      `CREATE TABLE IF NOT EXISTS \`ares_validation_history\` (
        \`id\` varchar(64) NOT NULL,
        \`configId\` varchar(64) NOT NULL,
        \`cardId\` varchar(64) NOT NULL,
        \`cardName\` text NOT NULL,
        \`goalDefinition\` text,
        \`confidenceScore\` int NOT NULL,
        \`passed\` boolean NOT NULL,
        \`failedRules\` text,
        \`warnings\` text,
        \`validationDetails\` text,
        \`validatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`validatedBy\` int NOT NULL,
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`ares_history_config_fk\` FOREIGN KEY (\`configId\`) REFERENCES \`ares_configurations\`(\`id\`)
      )`,
      `CREATE TABLE IF NOT EXISTS \`atis_checklist_completion\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`card_id\` int NOT NULL,
        \`step_index\` int NOT NULL,
        \`user_id\` int NOT NULL,
        \`completed_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`card_step_user_unique\` (\`card_id\`, \`step_index\`, \`user_id\`)
      )`,
    ];

    for (const sql of statements) {
      await conn.execute(sql);
    }

    console.log("[Database] ARES tables ensured (migration applied)");
}

async function initializeDatabase(connectionUrl: string) {
  let pool: mysql2.Pool | null = null;
  try {
    pool = mysql2.createPool({ uri: connectionUrl, connectTimeout: 10_000 });
    const connection = await pool.getConnection();
    try {
      await runPendingMigrations(connection);
    } finally {
      connection.release();
    }
    const database = drizzleMySQL(pool, { schema, mode: "default" });
    _pool = pool;
    _db = database;
    console.log("[Database] Connected to MySQL");
    return database;
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    console.warn("[Database] Failed to initialize:", error);
    return null;
  }
}

// Every caller awaits the same initialization; no handle escapes before readiness.
export async function getDb(): Promise<MySql2Database<typeof schema> | null> {
  if (_closing) await _closing;
  if (_db) return _db;
  if (_initializing) return _initializing;
  const connectionUrl = process.env.DATABASE_URL;
  if (!connectionUrl) return null;
  if (detectDatabaseType(connectionUrl) === "sqlite") {
    console.warn("[Database] SQLite support is planned but not yet implemented. Please use MySQL.");
    return null;
  }
  _initializing = initializeDatabase(connectionUrl);
  try {
    return await _initializing;
  } finally {
    _initializing = null;
  }
}

/** Drain owned connections for process shutdown or isolated integration tests. */
export async function closeDb(): Promise<void> {
  if (_closing) return _closing;
  _closing = (async () => {
    await _initializing;
    const pool = _pool;
    _pool = null;
    _db = null;
    if (pool) await pool.end();
  })();
  try {
    await _closing;
  } finally {
    _closing = null;
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function incrementPayLogD1(vaId: number, dateEAT: string, d1Count: number): Promise<{ id: number | null; projectedPay: number }> {
  if (d1Count <= 0) return { id: null, projectedPay: 90 };
  const db = await getDb();
  if (!db) return { id: null, projectedPay: 90 };

  // Compute Monday of the week
  const d = new Date(dateEAT);
  const day = d.getDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  const weekStart = d.toISOString().slice(0, 10);
  
  const weekEndDate = new Date(d);
  weekEndDate.setDate(d.getDate() + 6);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);

  // Get founderId
  const profileRows = await db.select().from(schema.vaProfiles).where(eq(schema.vaProfiles.userId, vaId)).limit(1);
  const founderId = profileRows[0]?.founderId ?? 1;

  const existingRows = await db.select().from(schema.weeklyPayLog).where(
    and(eq(schema.weeklyPayLog.weekStart, parseDateKey(weekStart)), eq(schema.weeklyPayLog.vaId, vaId))
  ).limit(1);
  
  const existing = existingRows[0];
  const prev = existing ? Number(existing.demeritD1) : 0;
  const newD1 = prev + d1Count;

  // Compute projected pay after the increment (base $90 - total demerits + total merits)
  const totalDemerits = newD1 * 5
    + (existing ? (
      Number(existing.demeritD2) * 10 + Number(existing.demeritD3) * 5 + Number(existing.demeritD4) * 5
      + Number(existing.demeritD5) * 10 + Number(existing.demeritD6) * 5 + Number(existing.demeritD7) * 5
      + Number(existing.demeritD8) * 10 + Number(existing.demeritD9) * 15 + Number(existing.demeritD10) * 15
      + Number(existing.demeritD11) * 15
    ) : 0);
  const totalMerits = existing
    ? Number(existing.meritM1) * 5 + Number(existing.meritM2) * 7.5 + Number(existing.meritM3) * 1 + Number(existing.meritStreak) * 10
    : 0;
  const projectedPay = Math.max(0, 90 - totalDemerits + totalMerits);

  const values = {
    vaId,
    founderId,
    weekStart: parseDateKey(weekStart),
    weekEnd: parseDateKey(weekEnd),
    demeritD1: String(newD1),
    projectedPay: String(projectedPay),
    meritM1: existing ? existing.meritM1 : "0.00",
    meritM2: existing ? existing.meritM2 : "0.00",
    meritM3: existing ? existing.meritM3 : "0.00",
    meritStreak: existing ? existing.meritStreak : "0.00",
    demeritD2: existing ? existing.demeritD2 : "0.00",
    demeritD3: existing ? existing.demeritD3 : "0.00",
    demeritD4: existing ? existing.demeritD4 : "0.00",
    demeritD5: existing ? existing.demeritD5 : "0.00",
    demeritD6: existing ? existing.demeritD6 : "0.00",
    demeritD7: existing ? existing.demeritD7 : "0.00",
    demeritD8: existing ? existing.demeritD8 : "0.00",
    demeritD9: existing ? existing.demeritD9 : "0.00",
    demeritD10: existing ? existing.demeritD10 : "0.00",
    demeritD11: existing ? existing.demeritD11 : "0.00",
  };

  if (existing) {
    await db.update(schema.weeklyPayLog).set(values).where(eq(schema.weeklyPayLog.id, existing.id));
    return { id: existing.id, projectedPay };
  } else {
    const [result] = await db.insert(schema.weeklyPayLog).values(values);
    return { id: result.insertId, projectedPay };
  }
}
