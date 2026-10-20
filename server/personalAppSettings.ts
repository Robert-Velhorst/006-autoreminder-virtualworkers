import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { appSettings } from "../drizzle/schema.postgres";
import { getDb } from "./db";

type PersonalSetting = "reply_monitor_badge_enabled" | "daily_hour_goal" | "daily_schedule";
type SettingsReader = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

export function personalSettingKey(vaId: number, key: PersonalSetting) {
  if (!Number.isSafeInteger(vaId) || vaId <= 0) throw new TRPCError({ code: "FORBIDDEN", message: "A valid account identity is required" });
  return `${key}:${vaId}`;
}

function unverifiedSetting(): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Retained setting ownership is unverified. Review the historical data or explicitly save a new personal setting." });
}

export async function readPersonalSetting(vaId: number, key: PersonalSetting, reader?: SettingsReader, forUpdate = false): Promise<string | null> {
  const scopedKey = personalSettingKey(vaId, key);
  const db = reader ?? await getDb();
  if (!db) return null;
  const query = db.select({ id: appSettings.id, vaId: appSettings.vaId, key: appSettings.key, value: appSettings.value })
    .from(appSettings).where(inArray(appSettings.key, [scopedKey, key])).limit(3);
  const rows = await (forUpdate ? query.for("update") : query);
  const scoped = rows.filter(row => row.key === scopedKey);
  if (scoped.length > 1 || (scoped.length === 1 && scoped[0].vaId !== vaId)) unverifiedSetting();
  if (scoped.length === 1) return scoped[0].value;
  // Historical key-only upserts could replace value without changing vaId.
  // Even matching legacy ownership is insufficient provenance.
  if (rows.length) unverifiedSetting();
  return null;
}

export async function writePersonalSetting(vaId: number, key: PersonalSetting, value: string) {
  const scopedKey = personalSettingKey(vaId, key);
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  const updated = await db.insert(appSettings).values({ vaId, key: scopedKey, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value }, setWhere: eq(appSettings.vaId, vaId) })
    .returning({ id: appSettings.id });
  if (updated.length !== 1) unverifiedSetting();
}
