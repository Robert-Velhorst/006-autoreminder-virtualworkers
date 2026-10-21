import { eq } from "drizzle-orm";
import { users, userNotificationPreferences } from "../../drizzle/schema.postgres";
import { getDb } from "../db";

export function hasPersistedEmailConsent(preferences: {
  emailEnabled?: number | null;
  notificationMode?: string | null;
} | null | undefined): boolean {
  return preferences?.emailEnabled === 1
    && ["daily_digest", "priority_only"].includes(preferences.notificationMode ?? "");
}

export async function hasRecipientEmailConsent(userId: number): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const db = await getDb();
  if (!db) return false;
  const [preferences] = await db.select({
    emailEnabled: userNotificationPreferences.emailEnabled,
    notificationMode: userNotificationPreferences.notificationMode,
  }).from(users).innerJoin(userNotificationPreferences,
    eq(users.openId, userNotificationPreferences.userOpenId))
    .where(eq(users.id, userId)).limit(1);
  return hasPersistedEmailConsent(preferences);
}
