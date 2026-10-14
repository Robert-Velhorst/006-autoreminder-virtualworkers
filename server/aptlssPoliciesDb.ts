/**
 * DB helpers for APTLSS operational policies, auto-follow-up drafts,
 * worker performance signals, and weekly analysis snapshots.
 */
import { getDb } from "./db";
import {
  aptlssOperationalPolicies,
  autoFollowUpDrafts,
  workerPerformanceSignals,
  weeklyAnalysisSnapshots,
  type AptlssOperationalPolicy,
  type AutoFollowUpDraft,
  type WorkerPerformanceSignal,
  type WeeklyAnalysisSnapshot,
} from "../drizzle/schema.postgres";
import { eq, desc, and } from "drizzle-orm";

// ─── Operational Policies ────────────────────────────────────────────────────

/** Default policies seeded on first load */
const DEFAULT_POLICIES: Omit<AptlssOperationalPolicy, "id" | "vaId" | "createdAt" | "updatedAt">[] = [
  { ruleKey: "stall_threshold_days", label: "Stall Threshold (days)", description: "Number of days in DOING with no checklist progress before a card is marked STALLED.", value: "5", category: "stall", enabled: 1 },
  { ruleKey: "follow_up_hours_routine", label: "Routine Follow-up Delay (hours)", description: "Hours before drafting a follow-up for external parties who have not replied.", value: "24", category: "follow_up", enabled: 1 },
  { ruleKey: "follow_up_hours_urgent", label: "Urgent Follow-up Delay (hours)", description: "Hours before drafting a follow-up for active developer jobs with no reply.", value: "24", category: "follow_up", enabled: 1 },
  { ruleKey: "follow_up_hours_legal", label: "Legal/Formal Follow-up Delay (hours)", description: "Hours before drafting a formal reminder for legal/official matters.", value: "72", category: "follow_up", enabled: 1 },
  { ruleKey: "escalate_blocked_days", label: "Escalate Blocked After (days)", description: "Number of days a card can be blocked before escalating to Robert.", value: "3", category: "escalation", enabled: 1 },
  { ruleKey: "escalate_missed_deadlines", label: "Escalate After Missed Deadlines", description: "Number of missed deadlines by a freelancer before escalating to Robert.", value: "2", category: "escalation", enabled: 1 },
  { ruleKey: "autopilot_level", label: "Autopilot Level (0–5)", description: "0=Read only, 1=Internal Trello actions, 2=Internal execution support, 3=Draft external comms, 4=Send low-risk follow-ups, 5=Full operational automation.", value: "2", category: "autopilot", enabled: 1 },
  { ruleKey: "done_gate_require_summary", label: "Done Gate: Require Final Summary", description: "Block Done if no final summary comment exists on the card.", value: "true", category: "done_gate", enabled: 1 },
  { ruleKey: "done_gate_require_checklist_complete", label: "Done Gate: Require Checklist Complete", description: "Block Done if any APTLSS checklist item is still open.", value: "true", category: "done_gate", enabled: 1 },
  { ruleKey: "done_gate_require_no_unanswered", label: "Done Gate: Require No Unanswered Questions", description: "Block Done if there is an unanswered question in the card comments.", value: "true", category: "done_gate", enabled: 1 },
  { ruleKey: "confidence_auto_proceed_threshold", label: "Confidence Auto-Proceed Threshold (%)", description: "Plans with confidence above this threshold may proceed automatically.", value: "85", category: "scheduling", enabled: 1 },
  { ruleKey: "confidence_flag_threshold", label: "Confidence Flag-for-Review Threshold (%)", description: "Plans with confidence below this threshold are flagged for Joyce review.", value: "65", category: "scheduling", enabled: 1 },
];

export async function getAllPolicies(vaId: number): Promise<AptlssOperationalPolicy[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(aptlssOperationalPolicies)
    .where(eq(aptlssOperationalPolicies.vaId, vaId))
    .orderBy(aptlssOperationalPolicies.category, aptlssOperationalPolicies.ruleKey);
  if (rows.length === 0) {
    for (const policy of DEFAULT_POLICIES) {
      await db.insert(aptlssOperationalPolicies).values({
        ...policy,
        vaId,
      } as AptlssOperationalPolicy).onConflictDoUpdate({
        target: [aptlssOperationalPolicies.vaId, aptlssOperationalPolicies.ruleKey],
        set: { label: policy.label },
      });
    }
    return db.select().from(aptlssOperationalPolicies)
      .where(eq(aptlssOperationalPolicies.vaId, vaId))
      .orderBy(aptlssOperationalPolicies.category, aptlssOperationalPolicies.ruleKey);
  }
  return rows;
}

export async function getPolicyByKey(vaId: number, ruleKey: string): Promise<AptlssOperationalPolicy | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(aptlssOperationalPolicies)
    .where(and(eq(aptlssOperationalPolicies.ruleKey, ruleKey), eq(aptlssOperationalPolicies.vaId, vaId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPolicyValue(vaId: number, ruleKey: string, fallback: string): Promise<string> {
  const row = await getPolicyByKey(vaId, ruleKey);
  return row?.value ?? fallback;
}

export async function upsertPolicy(vaId: number, ruleKey: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(aptlssOperationalPolicies)
    .values({ vaId, ruleKey, value, label: ruleKey, category: "general", enabled: 1 } as AptlssOperationalPolicy)
    .onConflictDoUpdate({
      target: [aptlssOperationalPolicies.vaId, aptlssOperationalPolicies.ruleKey],
      set: { value },
    });
}

export async function setPolicyEnabled(vaId: number, ruleKey: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(aptlssOperationalPolicies)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(and(eq(aptlssOperationalPolicies.ruleKey, ruleKey), eq(aptlssOperationalPolicies.vaId, vaId)));
}

// ─── Auto Follow-Up Drafts ───────────────────────────────────────────────────

export async function getPendingFollowUpDrafts(vaId: number): Promise<AutoFollowUpDraft[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(autoFollowUpDrafts)
    .where(and(eq(autoFollowUpDrafts.status, "pending"), eq(autoFollowUpDrafts.vaId, vaId)))
    .orderBy(desc(autoFollowUpDrafts.createdAt));
}

export async function getAllFollowUpDrafts(vaId: number): Promise<AutoFollowUpDraft[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(autoFollowUpDrafts)
    .where(eq(autoFollowUpDrafts.vaId, vaId))
    .orderBy(desc(autoFollowUpDrafts.createdAt))
    .limit(50);
}

export async function upsertFollowUpDraft(draft: Omit<AutoFollowUpDraft, "id" | "createdAt" | "updatedAt">): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(autoFollowUpDrafts)
    .where(and(eq(autoFollowUpDrafts.cardId, draft.cardId), eq(autoFollowUpDrafts.status, "pending"), eq(autoFollowUpDrafts.vaId, draft.vaId)))
    .limit(1);
  if (existing.length > 0) {
    await db.update(autoFollowUpDrafts)
      .set({ draftMessage: draft.draftMessage, reason: draft.reason, hoursSinceLastReply: draft.hoursSinceLastReply, urgencyType: draft.urgencyType, updatedAt: new Date() })
      .where(eq(autoFollowUpDrafts.id, existing[0].id));
  } else {
    await db.insert(autoFollowUpDrafts).values(draft as AutoFollowUpDraft);
  }
}

export async function getFollowUpDraftById(id: number): Promise<AutoFollowUpDraft | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(autoFollowUpDrafts).where(eq(autoFollowUpDrafts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function markFollowUpDraftSent(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(autoFollowUpDrafts).set({ status: "sent", updatedAt: new Date() }).where(eq(autoFollowUpDrafts.id, id));
}

export async function dismissFollowUpDraft(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(autoFollowUpDrafts).set({ status: "dismissed", updatedAt: new Date() }).where(eq(autoFollowUpDrafts.id, id));
}

// ─── Worker Performance Signals ──────────────────────────────────────────────

export async function getAllWorkerPerformance(): Promise<WorkerPerformanceSignal[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(workerPerformanceSignals).orderBy(desc(workerPerformanceSignals.weekKey), workerPerformanceSignals.workerName);
}

export async function upsertWorkerPerformance(signal: Omit<WorkerPerformanceSignal, "id" | "createdAt" | "updatedAt">): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(workerPerformanceSignals)
    .where(and(eq(workerPerformanceSignals.workerId, signal.workerId), eq(workerPerformanceSignals.weekKey, signal.weekKey)))
    .limit(1);
  if (existing.length > 0) {
    await db.update(workerPerformanceSignals).set({ ...signal, updatedAt: new Date() }).where(eq(workerPerformanceSignals.id, existing[0].id));
  } else {
    await db.insert(workerPerformanceSignals).values(signal as WorkerPerformanceSignal);
  }
}

// ─── Weekly Analysis Snapshots ───────────────────────────────────────────────

export async function getLatestWeeklyAnalysis(vaId: number): Promise<WeeklyAnalysisSnapshot | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(weeklyAnalysisSnapshots)
    .where(eq(weeklyAnalysisSnapshots.vaId, vaId))
    .orderBy(desc(weeklyAnalysisSnapshots.generatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWeeklyAnalysisByKey(vaId: number, weekKey: string): Promise<WeeklyAnalysisSnapshot | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(weeklyAnalysisSnapshots)
    .where(and(eq(weeklyAnalysisSnapshots.weekKey, weekKey), eq(weeklyAnalysisSnapshots.vaId, vaId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertWeeklyAnalysis(snapshot: Omit<WeeklyAnalysisSnapshot, "id" | "createdAt" | "generatedAt">): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await getWeeklyAnalysisByKey(snapshot.vaId, snapshot.weekKey);
  if (existing) {
    await db.update(weeklyAnalysisSnapshots).set({ ...snapshot }).where(and(eq(weeklyAnalysisSnapshots.weekKey, snapshot.weekKey), eq(weeklyAnalysisSnapshots.vaId, snapshot.vaId)));
  } else {
    await db.insert(weeklyAnalysisSnapshots).values(snapshot as WeeklyAnalysisSnapshot);
  }
}

export async function getRecentWeeklyAnalyses(vaId: number, limit = 8): Promise<WeeklyAnalysisSnapshot[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(weeklyAnalysisSnapshots)
    .where(eq(weeklyAnalysisSnapshots.vaId, vaId))
    .orderBy(desc(weeklyAnalysisSnapshots.generatedAt))
    .limit(limit);
}

// ─── Autopilot Level Helper (Item 17) ────────────────────────────────────────
/**
 * Returns the current autopilot level (0–5).
 * 0 = read-only, 1 = internal Trello actions, 2 = internal execution support,
 * 3 = draft external comms, 4 = send low-risk follow-ups, 5 = full automation.
 */
export async function getAutopilotLevel(vaId: number): Promise<number> {
  const val = await getPolicyValue(vaId, "autopilot_level", "2");
  const n = parseInt(val, 10);
  return isNaN(n) ? 2 : Math.max(0, Math.min(5, n));
}
