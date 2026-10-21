import { eq } from "drizzle-orm";
import { users, userWorkingHours, vaProfiles, type User } from "../drizzle/schema.postgres";
import { validateWorkerTimeZone } from "../shared/workerTime";
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
  return activeProfiles.length === 1 ? activeProfiles[0] : null;
}

export async function getActiveWorkerProfileResolution(
  userId: number,
  database?: Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">,
): Promise<{ profileId: number | null; ambiguous: boolean }> {
  const db = database ?? await getDb();
  if (!db) return { profileId: null, ambiguous: false };

  try {
    const profiles = await db
      .select({ id: vaProfiles.id, status: vaProfiles.status })
      .from(vaProfiles)
      .where(eq(vaProfiles.userId, userId))
      .orderBy(vaProfiles.id);
    const activeProfiles = profiles.filter(profile => profile.status === "active");
    return {
      profileId: activeProfiles.length === 1 ? activeProfiles[0].id : null,
      ambiguous: activeProfiles.length > 1,
    };
  } catch (error) {
    if (missingTable(error)) return { profileId: null, ambiguous: false };
    throw error;
  }
}

export async function getActiveWorkerProfileId(
  userId: number,
  database?: Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">,
): Promise<number | null> {
  return (await getActiveWorkerProfileResolution(userId, database)).profileId;
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
  // Profile defaults are persisted worker settings too; do not guess whether
  // they were manually saved by comparing them with schema defaults.
  const timezone = validateWorkerTimeZone(hours?.timezone ?? profile?.timezone ?? founderHours?.timezone);
  const founder = profile
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, profile.founderId)).limit(1))[0]
    : null;

  const breaks: WorkerBreak[] = [];
  if (hours) {
    if (hours.enableBreaks) {
      addBreak(breaks, "Breakfast", hours.breakfastTime, hours.breakfastDuration);
      addBreak(breaks, "Lunch", hours.lunchTime, hours.lunchDuration);
      addBreak(breaks, "Dinner", hours.dinnerTime, hours.dinnerDuration);
    }
  } else if (profile && (!founderHours || founderHours.enableBreaks)) {
    const profileTime = (value: number | null | undefined, fallback: string | null | undefined) =>
      value == null ? fallback : hourTime(value);
    addBreak(breaks, "Breakfast", profileTime(profile.breakfastTime, founderHours?.breakfastTime), profile.breakfastDuration ?? founderHours?.breakfastDuration);
    addBreak(breaks, "Lunch", profileTime(profile.lunchTime, founderHours?.lunchTime), profile.lunchDuration ?? founderHours?.lunchDuration);
    addBreak(breaks, "Dinner", profileTime(profile.dinnerTime, founderHours?.dinnerTime), profile.dinnerDuration ?? founderHours?.dinnerDuration);
  }

  return {
    userId: user.id,
    profileId: profile?.id ?? null,
    founderId: profile?.founderId ?? null,
    trelloMemberId: profile?.trelloMemberId?.trim() || null,
    displayName: profile?.name?.trim() || fallbackName,
    founderName: founder?.name?.trim() || "Founder",
    timezone,
    workStartTime: hourTime(hours?.workStartHour ?? profile?.workStartHour ?? founderHours?.workStartHour ?? 9,
      hours ? hours.workStartMinute : profile?.workStartHour != null ? 0 : founderHours?.workStartMinute ?? 0),
    workEndTime: hourTime(hours?.workEndHour ?? profile?.workEndHour ?? founderHours?.workEndHour ?? 18,
      hours ? hours.workEndMinute : profile?.workEndHour != null ? 0 : founderHours?.workEndMinute ?? 0),
    workingDays: parseWorkingDays(hours?.workingDays ?? profile?.workingDays ?? founderHours?.workingDays),
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
