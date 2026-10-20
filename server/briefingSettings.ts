import { eq } from "drizzle-orm";
import { z } from "zod";
import { appSettings } from "../drizzle/schema";
import { getDb } from "./db";

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const briefingSettingsSchema = z.object({
  morningBriefingEnabled: z.boolean(),
  morningBriefingTime: clockTime,
  eodReportEnabled: z.boolean(),
  eodReportTime: clockTime,
});

export type BriefingSettings = z.infer<typeof briefingSettingsSchema>;

export const BRIEFING_SETTINGS_DEFAULTS: BriefingSettings = {
  morningBriefingEnabled: true,
  morningBriefingTime: "08:00",
  eodReportEnabled: true,
  eodReportTime: "18:00",
};

export class BriefingSettingsValidationError extends Error {}

export function briefingSettingsKey(founderId: number) {
  return `briefingSettings:${founderId}`;
}

export function normalizeBriefingSettings(value: unknown): BriefingSettings {
  if (typeof value === "string") {
    try {
      return normalizeBriefingSettings(JSON.parse(value));
    } catch {
      return BRIEFING_SETTINGS_DEFAULTS;
    }
  }

  const parsed = briefingSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : BRIEFING_SETTINGS_DEFAULTS;
}

export function validateBriefingSettings(value: unknown): BriefingSettings {
  const parsed = briefingSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new BriefingSettingsValidationError(
      "Briefing settings require enabled flags and valid HH:MM times.",
    );
  }
  return parsed.data;
}

export function shouldRunBriefingAt(time: string, localHour: number, localMinute: number) {
  const [hour, minute] = time.split(":").map(Number);
  return hour === localHour && minute === localMinute;
}

export async function getBriefingSettings(founderId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, briefingSettingsKey(founderId)))
    .limit(1);

  return normalizeBriefingSettings(row?.value ?? null);
}

export async function saveBriefingSettings(founderId: number, value: unknown) {
  const settings = validateBriefingSettings(value);
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  await db.insert(appSettings).values({
    vaId: null,
    key: briefingSettingsKey(founderId),
    value: JSON.stringify(settings),
  }).onDuplicateKeyUpdate({
    set: { value: JSON.stringify(settings), vaId: null },
  });

  return settings;
}
