import { and, eq } from "drizzle-orm";
import { users, userNotificationPreferences } from "../../drizzle/schema.postgres";
import { getDb } from "../db";
import { getActiveWorkerProfileId } from "../workerOperatorContext";

export function hasPersistedEmailConsent(preferences: {
  emailEnabled?: number | null;
  notificationMode?: string | null;
} | null | undefined): boolean {
  return preferences?.emailEnabled === 1
    && ["daily_digest", "priority_only"].includes(preferences.notificationMode ?? "");
}

async function readConsentingRecipient(userId: number, requiredMode?: "daily_digest" | "priority_only") {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const db = await getDb();
  if (!db) return null;
  const [preferences] = await db.select({
    emailEnabled: userNotificationPreferences.emailEnabled,
    notificationMode: userNotificationPreferences.notificationMode,
    role: users.role,
    emailAddress: userNotificationPreferences.emailAddress,
    userEmail: users.email,
  }).from(users).innerJoin(userNotificationPreferences,
    and(eq(users.openId, userNotificationPreferences.userOpenId), eq(users.id, userNotificationPreferences.userId)))
    .where(eq(users.id, userId)).limit(1);
  if (!hasPersistedEmailConsent(preferences)
    || (requiredMode !== undefined && preferences?.notificationMode !== requiredMode)) return null;
  if (preferences.role === "worker") {
    if (await getActiveWorkerProfileId(userId, db) === null) return null;
  } else if (preferences.role !== "admin") return null;
  return preferences;
}

export async function hasRecipientEmailConsent(userId: number, requiredMode?: "daily_digest" | "priority_only"): Promise<boolean> {
  return await readConsentingRecipient(userId, requiredMode) !== null;
}

export async function getConsentingRecipientEmail(userId: number, requiredMode?: "daily_digest" | "priority_only"): Promise<string | null> {
  const recipient = await readConsentingRecipient(userId, requiredMode);
  return recipient?.emailAddress || recipient?.userEmail || null;
}
