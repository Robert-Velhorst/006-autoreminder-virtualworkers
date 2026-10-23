import { eq, and, lte } from "drizzle-orm";
import { createHash } from "crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { InsertUser, users } from "../drizzle/schema.postgres";
import * as schema from "../drizzle/schema.postgres";
import { ENV } from "./_core/env";
import { incrementWeeklyD1 } from './financialLedger';
import { assertFinancialFeaturesEnabled } from './financialAvailability';
import { DatabaseUnavailableError } from "./databaseAvailability";
import { requirePostgresDatabaseUrl } from "./db/databaseUrl";
import { hasRequiredPostgresSchema } from "./db/readiness";

let _db: NodePgDatabase<typeof schema> | null = null;
let _pool: Pool | null = null;
let _closing: Promise<void> | null = null;

export async function getDb() {
  if (_closing) await _closing;
  if (!_db && process.env.DATABASE_URL) {
    try {
      const databaseUrl = requirePostgresDatabaseUrl(process.env.DATABASE_URL, {
        requireVerifiedTls: process.env.NODE_ENV === "production",
      });
      _pool = new Pool({
        connectionString: databaseUrl,
        max: Number(process.env.DATABASE_POOL_MAX ?? 10),
        connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000),
        idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
        allowExitOnIdle: process.env.NODE_ENV !== "production",
      });
      // Driver diagnostics may include connection details or personal query data.
      _pool.on("error", () => console.warn("[Database] Unexpected idle PostgreSQL client error"));
      _db = drizzle(_pool, { schema });
    } catch {
      const pool = _pool;
      _pool = null;
      _db = null;
      if (pool) await pool.end().catch(() => undefined);
      console.warn("[Database] Failed to initialize PostgreSQL connection pool");
    }
  }
  return _db;
}

export async function isDatabaseReachable(): Promise<boolean> {
  await getDb();
  if (!_pool) return false;
  return hasRequiredPostgresSchema(_pool);
}

export async function closeDb(): Promise<void> {
  if (_closing) return _closing;
  const pool = _pool;
  _pool = null;
  _db = null;
  if (!pool) return;
  _closing = pool.end();
  try { await _closing; } finally { _closing = null; }
}
export const closeDatabase = closeDb;

function sessionHash(sessionId: string) {
  return createHash("sha256").update(sessionId).digest("hex");
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  const database = await getDb();
  if (!database) {
    if (process.env.DATABASE_URL || process.env.NODE_ENV === "production") throw new DatabaseUnavailableError();
    return false;
  }
  const [row] = await database.select({ sessionHash: schema.revokedSessions.sessionHash })
    .from(schema.revokedSessions).where(eq(schema.revokedSessions.sessionHash, sessionHash(sessionId))).limit(1);
  return Boolean(row);
}

export async function revokeSession(sessionId: string, expiresAt: Date): Promise<void> {
  const database = await getDb();
  if (!database) throw new DatabaseUnavailableError();
  await database.delete(schema.revokedSessions).where(lte(schema.revokedSessions.expiresAt, new Date()));
  await database.insert(schema.revokedSessions).values({ sessionHash: sessionHash(sessionId), expiresAt })
    .onConflictDoUpdate({ target: schema.revokedSessions.sessionHash, set: { expiresAt } });
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    if (process.env.DATABASE_URL || process.env.NODE_ENV === "production") throw new DatabaseUnavailableError();
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
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user");
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    if (process.env.DATABASE_URL || process.env.NODE_ENV === "production") throw new DatabaseUnavailableError();
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function incrementPayLogD1(
  workerUserId: number,
  dateKey: string,
  d1Count: number,
  eventKey?: string,
  beforeIncrement?: (tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<typeof getDb>>>['transaction']>[0]>[0]) => Promise<void>,
): Promise<{ id: number; projectedPay: number }> {
  assertFinancialFeaturesEnabled();
  const db = await getDb();
  if (!db) throw new DatabaseUnavailableError();
  const { log } = beforeIncrement
    ? await incrementWeeklyD1(db, workerUserId, dateKey, d1Count, eventKey, beforeIncrement)
    : await incrementWeeklyD1(db, workerUserId, dateKey, d1Count, eventKey);
  return { id: log.id, projectedPay: Number(log.projectedPay) };
}
