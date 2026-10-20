import { and, desc, eq, like, lte, sql } from "drizzle-orm";
import { aptlssSteps, founderDecisionDeadlines, notificationHistory, userNotificationPreferences, users } from "../drizzle/schema.postgres";
import { getDb } from "./db";
import { createNonOverlappingRunner } from "./services/non-overlapping-runner";

const DAY_MS = 24 * 60 * 60_000;
const ALERT_PREFIX = "founder-decision:";
type AlertStage = "due_soon" | "overdue";

export function founderDecisionAlertStage(dueAt: Date | null, now: Date): AlertStage | null {
  if (!dueAt) return null;
  if (dueAt.getTime() <= now.getTime()) return "overdue";
  return dueAt.getTime() - now.getTime() <= DAY_MS ? "due_soon" : null;
}

export async function recordFounderDecisionAlertForStep(stepId: number, now = new Date()) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db.transaction(async tx => {
    const [step] = await tx.select({ id: aptlssSteps.id, title: aptlssSteps.title })
      .from(aptlssSteps)
      .where(and(eq(aptlssSteps.id, stepId), eq(aptlssSteps.requiresRobert, true), eq(aptlssSteps.status, "open")))
      .limit(1).for("update");
    if (!step) return 0;
    const [revision] = await tx.select().from(founderDecisionDeadlines)
      .where(eq(founderDecisionDeadlines.stepId, stepId))
      .orderBy(desc(founderDecisionDeadlines.id)).limit(1);
    const stage = founderDecisionAlertStage(revision?.dueAt ?? null, now);
    if (!stage || !revision?.dueAt) return 0;
    const taskId = `${ALERT_PREFIX}${stepId}:${revision.id}:${stage}`;
    const admins = await tx.select({ id: users.id, openId: users.openId })
      .from(users).where(eq(users.role, "admin"));
    let created = 0;
    for (const admin of admins) {
      if (stage === "overdue") {
        await tx.update(notificationHistory).set({ isRead: 1, readAt: now }).where(and(
          eq(notificationHistory.userOpenId, admin.openId), eq(notificationHistory.isRead, 0),
          like(notificationHistory.taskId, `${ALERT_PREFIX}${stepId}:%:due_soon`),
        ));
      }
      const [prefs] = await tx.select({ mode: userNotificationPreferences.notificationMode, enabled: userNotificationPreferences.inAppEnabled })
        .from(userNotificationPreferences)
        .where(eq(userNotificationPreferences.userOpenId, admin.openId)).limit(1);
      if (prefs?.mode === "disabled" || prefs?.enabled === 0) continue;
      const [existing] = await tx.select({ id: notificationHistory.id }).from(notificationHistory)
        .where(and(eq(notificationHistory.userOpenId, admin.openId), eq(notificationHistory.taskId, taskId))).limit(1);
      if (existing) continue;
      await tx.insert(notificationHistory).values({
        userId: admin.id,
        userOpenId: admin.openId,
        title: stage === "overdue" ? "Founder decision overdue" : "Founder decision due soon",
        content: `A decision is needed: ${step.title}. Open the founder decision inbox and check the source.`,
        notificationType: stage === "overdue" ? "task_overdue" : "task_due_soon",
        taskId,
        dueDate: revision.dueAt,
        channel: "in_app",
        deliveryStatus: "sent",
        deliveredAt: now,
      });
      created++;
    }
    return created;
  });
}

export async function processFounderDecisionAlerts(now = new Date()) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const latest = db.select({
    stepId: founderDecisionDeadlines.stepId,
    revisionId: sql<number>`max(${founderDecisionDeadlines.id})`.as("revisionId"),
  }).from(founderDecisionDeadlines).groupBy(founderDecisionDeadlines.stepId).as("latest_deadline");
  const candidates = await db.select({ stepId: aptlssSteps.id })
    .from(aptlssSteps)
    .innerJoin(latest, eq(latest.stepId, aptlssSteps.id))
    .innerJoin(founderDecisionDeadlines, eq(founderDecisionDeadlines.id, latest.revisionId))
    .where(and(eq(aptlssSteps.requiresRobert, true), eq(aptlssSteps.status, "open"),
      lte(founderDecisionDeadlines.dueAt, new Date(now.getTime() + DAY_MS))));
  let created = 0;
  for (const candidate of candidates) created += await recordFounderDecisionAlertForStep(candidate.stepId, now);
  return { checked: candidates.length, created };
}

let alertTimer: NodeJS.Timeout | null = null;

export function startFounderDecisionAlertWorker() {
  if (alertTimer || process.env.FOUNDER_DECISION_ALERTS_ENABLED === "false") return;
  const run = createNonOverlappingRunner(async () => {
    try { await processFounderDecisionAlerts(); }
    catch (error) { console.error("[FounderDecisionAlerts] Tick failed:", error); }
  });
  void run();
  alertTimer = setInterval(() => void run(), 60_000);
  alertTimer.unref?.();
}

export function stopFounderDecisionAlertWorker() {
  if (!alertTimer) return;
  clearInterval(alertTimer);
  alertTimer = null;
}
