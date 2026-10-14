import { eq, and } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { InsertUser, users } from "../drizzle/schema.postgres";
import * as schema from "../drizzle/schema.postgres";
import { ENV } from "./_core/env";
import { parseDateKey } from "./utils/date-only";
import { requirePostgresDatabaseUrl } from "./db/databaseUrl";
import { hasRequiredPostgresSchema } from "./db/readiness";

let _db: NodePgDatabase<typeof schema> | null = null;
let _pool: Pool | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const databaseUrl = requirePostgresDatabaseUrl(process.env.DATABASE_URL, {
        requireVerifiedTls: process.env.NODE_ENV === "production",
      });

      _pool = new Pool({
        connectionString: databaseUrl,
        max: Number(process.env.DATABASE_POOL_MAX ?? 10),
        connectionTimeoutMillis: Number(
          process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000
        ),
        idleTimeoutMillis: Number(
          process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000
        ),
        allowExitOnIdle: process.env.NODE_ENV !== "production",
      });
      _pool.on("error", error => {
        console.error(
          "[Database] Unexpected idle PostgreSQL client error:",
          error
        );
      });
      _db = drizzle(_pool, { schema });
      console.log("[Database] PostgreSQL pool initialized");
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      await _pool?.end().catch(() => {});
      _pool = null;
      _db = null;
    }
  }
  return _db;
}

export async function isDatabaseReachable(): Promise<boolean> {
  await getDb();
  if (!_pool) return false;
  return hasRequiredPostgresSchema(_pool);
}

export async function closeDatabase(): Promise<void> {
  const pool = _pool;
  _pool = null;
  _db = null;
  await pool?.end();
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

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function incrementPayLogD1(
  vaId: number,
  dateEAT: string,
  d1Count: number
): Promise<{ id: number | null; projectedPay: number }> {
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
  const profileRows = await db
    .select()
    .from(schema.vaProfiles)
    .where(eq(schema.vaProfiles.userId, vaId))
    .limit(1);
  const founderId = profileRows[0]?.founderId ?? 1;

  const existingRows = await db
    .select()
    .from(schema.weeklyPayLog)
    .where(
      and(
        eq(schema.weeklyPayLog.weekStart, parseDateKey(weekStart)),
        eq(schema.weeklyPayLog.vaId, vaId)
      )
    )
    .limit(1);

  const existing = existingRows[0];
  const prev = existing ? Number(existing.demeritD1) : 0;
  const newD1 = prev + d1Count;

  // Compute projected pay after the increment (base $90 - total demerits + total merits)
  const totalDemerits =
    newD1 * 5 +
    (existing
      ? Number(existing.demeritD2) * 10 +
        Number(existing.demeritD3) * 5 +
        Number(existing.demeritD4) * 5 +
        Number(existing.demeritD5) * 10 +
        Number(existing.demeritD6) * 5 +
        Number(existing.demeritD7) * 5 +
        Number(existing.demeritD8) * 10 +
        Number(existing.demeritD9) * 15 +
        Number(existing.demeritD10) * 15 +
        Number(existing.demeritD11) * 15
      : 0);
  const totalMerits = existing
    ? Number(existing.meritM1) * 5 +
      Number(existing.meritM2) * 7.5 +
      Number(existing.meritM3) * 1 +
      Number(existing.meritStreak) * 10
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
    await db
      .update(schema.weeklyPayLog)
      .set(values)
      .where(eq(schema.weeklyPayLog.id, existing.id));
    return { id: existing.id, projectedPay };
  } else {
    const [result] = await db
      .insert(schema.weeklyPayLog)
      .values(values)
      .returning({ id: schema.weeklyPayLog.id });
    return { id: result?.id ?? null, projectedPay };
  }
}
