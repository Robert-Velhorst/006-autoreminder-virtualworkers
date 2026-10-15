import { eq } from "drizzle-orm";
import { users, userWorkingHours, vaProfiles, type User } from "../drizzle/schema.postgres";
import { getDb } from "./db";

export type WorkerBreak = {
  name: string;
  startTime: string;
  durationMinutes: number;
};

export type WorkerOperatorContext = {
  userId: number;
  profileId: number | null;
  founderId: number | null;
  trelloMemberId: string | null;
  displayName: string;
  founderName: string;
  timezone: string;
  workStartTime: string;
  workEndTime: string;
  workingDays: number[];
  breaks: WorkerBreak[];
};

function hourTime(hour: number | null | undefined, minute = 0) {
  const safeHour = Math.min(23, Math.max(0, Math.round(hour ?? 0)));
  const safeMinute = Math.min(59, Math.max(0, Math.round(minute)));
  return `${String(safeHour).padStart(2, "0")}:${String(safeMinute).padStart(2, "0")}`;
}

function parseWorkingDays(value: string | null | undefined) {
  const days = (value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  return days.length ? Array.from(new Set(days)) : [1, 2, 3, 4, 5];
}

function addBreak(
  target: WorkerBreak[],
  name: string,
  time: string | null | undefined,
  duration: number | null | undefined,
) {
  if (!time || !/^\d{2}:\d{2}$/.test(time) || !duration || duration < 5) return;
  target.push({ name, startTime: time, durationMinutes: Math.min(240, Math.round(duration)) });
}

function missingTable(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "ER_NO_SUCH_TABLE";
}

export async function resolveWorkerOperatorContext(user: User): Promise<WorkerOperatorContext> {
  const db = await getDb();
  const fallbackName = user.name?.trim() || "Worker";
  if (!db) {
    return {
      userId: user.id,
      profileId: null,
      founderId: null,
      trelloMemberId: null,
      displayName: fallbackName,
      founderName: "Founder",
      timezone: "UTC",
      workStartTime: "09:00",
      workEndTime: "18:00",
      workingDays: [1, 2, 3, 4, 5],
      breaks: [],
    };
  }

  const [profileRows, hoursRows] = await Promise.all([
    db.select().from(vaProfiles).where(eq(vaProfiles.userId, user.id)).limit(1)
      .catch((error) => {
        if (missingTable(error)) return [];
        throw error;
      }),
    db.select().from(userWorkingHours).where(eq(userWorkingHours.userId, user.id)).limit(1)
      .catch((error) => {
        if (missingTable(error)) return [];
        throw error;
      }),
  ]);
  const profile = profileRows[0] ?? null;
  const hours = hoursRows[0] ?? null;
  const founder = profile
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, profile.founderId)).limit(1))[0]
    : null;

  const breaks: WorkerBreak[] = [];
  if (hours?.enableBreaks) {
    addBreak(breaks, "Breakfast", hours.breakfastTime, hours.breakfastDuration);
    addBreak(breaks, "Lunch", hours.lunchTime, hours.lunchDuration);
    addBreak(breaks, "Dinner", hours.dinnerTime, hours.dinnerDuration);
  } else if (profile) {
    addBreak(breaks, "Breakfast", profile.breakfastTime == null ? null : hourTime(profile.breakfastTime), profile.breakfastDuration);
    addBreak(breaks, "Lunch", profile.lunchTime == null ? null : hourTime(profile.lunchTime), profile.lunchDuration);
    addBreak(breaks, "Dinner", profile.dinnerTime == null ? null : hourTime(profile.dinnerTime), profile.dinnerDuration);
  }

  return {
    userId: user.id,
    profileId: profile?.id ?? null,
    founderId: profile?.founderId ?? null,
    trelloMemberId: profile?.trelloMemberId?.trim() || null,
    displayName: profile?.name?.trim() || fallbackName,
    founderName: founder?.name?.trim() || "Founder",
    timezone: hours?.timezone || profile?.timezone || "UTC",
    workStartTime: hours
      ? hourTime(hours.workStartHour, hours.workStartMinute)
      : hourTime(profile?.workStartHour ?? 9),
    workEndTime: hours
      ? hourTime(hours.workEndHour, hours.workEndMinute)
      : hourTime(profile?.workEndHour ?? 18),
    workingDays: parseWorkingDays(hours?.workingDays || profile?.workingDays),
    breaks,
  };
}

export async function resolveWorkerOperatorContextById(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is required to resolve worker context");
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.role !== "worker") throw new Error("Worker profile not found");
  return resolveWorkerOperatorContext(user);
}
