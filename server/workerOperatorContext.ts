import { eq } from "drizzle-orm";
import { users, userWorkingHours, vaProfiles, type User } from "../drizzle/schema";
import { getDb } from "./db";
import { normalizeBreakLabel } from "./dailySchedule";

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
  weeklyHoursMin: number;
  weeklyHoursMax: number;
  dailyHoursMin: number;
  dailyHoursMax: number;
};

export const DEFAULT_WORKER_HOUR_TARGETS = {
  weeklyHoursMin: 55,
  weeklyHoursMax: 60,
  dailyHoursMin: 9.5,
  dailyHoursMax: 11.5,
} as const;

type WorkerHourTargetInput = {
  weeklyHoursMin?: unknown;
  weeklyHoursMax?: unknown;
  dailyHoursMin?: unknown;
  dailyHoursMax?: unknown;
};

export function workerHourTargetsFromSettings(input: WorkerHourTargetInput | null | undefined) {
  const weeklyHoursMin = Number(input?.weeklyHoursMin);
  const weeklyHoursMax = Number(input?.weeklyHoursMax);
  const dailyHoursMin = Number(input?.dailyHoursMin);
  const dailyHoursMax = Number(input?.dailyHoursMax);
  if (!Number.isFinite(weeklyHoursMin) || !Number.isFinite(weeklyHoursMax)
    || weeklyHoursMin < 1 || weeklyHoursMax > 168 || weeklyHoursMin > weeklyHoursMax
    || !Number.isFinite(dailyHoursMin) || !Number.isFinite(dailyHoursMax)
    || dailyHoursMin < 0.5 || dailyHoursMax > 16 || dailyHoursMin > dailyHoursMax) {
    return DEFAULT_WORKER_HOUR_TARGETS;
  }
  return { weeklyHoursMin, weeklyHoursMax, dailyHoursMin, dailyHoursMax };
}

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
  target.push({
    name: normalizeBreakLabel(name, time),
    startTime: time,
    durationMinutes: Math.min(240, Math.round(duration)),
  });
}

function missingTable(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "ER_NO_SUCH_TABLE";
}

export function selectWorkerProfile<T extends { status: string }>(profiles: readonly T[]): T | null {
  const activeProfiles = profiles.filter((profile) => profile.status === "active");
  if (activeProfiles.length === 1) return activeProfiles[0];
  return activeProfiles.length === 0 && profiles.length === 1 ? profiles[0] : null;
}

export async function resolveWorkerOperatorContext(user: User, database?: NonNullable<Awaited<ReturnType<typeof getDb>>>): Promise<WorkerOperatorContext> {
  const db = database ?? await getDb();
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
      ...DEFAULT_WORKER_HOUR_TARGETS,
    };
  }

  const [profileRows, hoursRows] = await Promise.all([
    db.select().from(vaProfiles).where(eq(vaProfiles.userId, user.id)).orderBy(vaProfiles.id)
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
  const profile = selectWorkerProfile(profileRows);
  const hours = hoursRows[0] ?? null;
  const founderHours = profile && !hours
    ? (await db.select().from(userWorkingHours).where(eq(userWorkingHours.userId, profile.founderId)).limit(1))[0] ?? null
    : null;
  const effectiveHours = hours ?? founderHours;
  const founder = profile
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, profile.founderId)).limit(1))[0]
    : null;

  const breaks: WorkerBreak[] = [];
  if (effectiveHours?.enableBreaks) {
    addBreak(breaks, "Breakfast", effectiveHours.breakfastTime, effectiveHours.breakfastDuration);
    addBreak(breaks, "Lunch", effectiveHours.lunchTime, effectiveHours.lunchDuration);
    addBreak(breaks, "Dinner", effectiveHours.dinnerTime, effectiveHours.dinnerDuration);
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
    timezone: effectiveHours?.timezone || profile?.timezone || "UTC",
    workStartTime: effectiveHours
      ? hourTime(effectiveHours.workStartHour, effectiveHours.workStartMinute)
      : hourTime(profile?.workStartHour ?? 9),
    workEndTime: effectiveHours
      ? hourTime(effectiveHours.workEndHour, effectiveHours.workEndMinute)
      : hourTime(profile?.workEndHour ?? 18),
    workingDays: parseWorkingDays(effectiveHours?.workingDays || profile?.workingDays),
    breaks,
    ...workerHourTargetsFromSettings(effectiveHours),
  };
}

export async function resolveWorkerOperatorContextById(userId: number, database?: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  const db = database ?? await getDb();
  if (!db) throw new Error("Database is required to resolve worker context");
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.role !== "worker") throw new Error("Worker profile not found");
  return resolveWorkerOperatorContext(user, db);
}
