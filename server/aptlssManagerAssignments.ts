import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { taskAssignments, vaProfiles } from "../drizzle/schema.postgres";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const ASSIGNMENT_LIMIT = 250;
const ACTIVE_STATUSES = ["assigned", "in_progress", "blocked"] as const;

export type ManagerAssignmentReference = {
  cardId: string;
  checklistId: string | null;
  checkItemId: string | null;
};

export function parseManagerAssignmentReference(taskId: string): ManagerAssignmentReference | null {
  const parts = taskId.split(":");
  if (parts.length === 1 && parts[0] && parts[0].length <= 64) {
    return { cardId: parts[0], checklistId: null, checkItemId: null };
  }
  if (parts.length === 3 && parts.every(part => part.length > 0) && parts[0].length <= 64) {
    return { cardId: parts[0], checklistId: parts[1], checkItemId: parts[2] };
  }
  return null;
}

export async function readManagerAssignmentState(db: Db, userId: number) {
  const profiles = await db.select({ id: vaProfiles.id, founderId: vaProfiles.founderId, status: vaProfiles.status })
    .from(vaProfiles).where(eq(vaProfiles.userId, userId)).orderBy(vaProfiles.id);
  const activeProfiles = profiles.filter(candidate => candidate.status === "active");
  const profile = activeProfiles.length === 1 ? activeProfiles[0] : null;
  const assignments = profile
    ? await db.select({ taskId: taskAssignments.taskId, status: taskAssignments.status })
      .from(taskAssignments)
      .where(and(
        eq(taskAssignments.vaId, profile.id),
        eq(taskAssignments.founderId, profile.founderId),
        inArray(taskAssignments.status, [...ACTIVE_STATUSES]),
      ))
      .orderBy(taskAssignments.taskId)
      .limit(ASSIGNMENT_LIMIT + 1)
    : [];
  const identity = profiles.map(({ id, founderId, status }) => ({ id, founderId, status }));
  const assignmentIdentity = assignments.slice(0, ASSIGNMENT_LIMIT).map(({ taskId, status }) => ({ taskId, status }));
  const fingerprint = createHash("sha256").update(JSON.stringify({ identity, assignmentIdentity })).digest("hex");
  return {
    profile,
    assignments: assignments.slice(0, ASSIGNMENT_LIMIT),
    truncated: assignments.length > ASSIGNMENT_LIMIT,
    complete: !!profile && assignments.length <= ASSIGNMENT_LIMIT,
    fingerprint,
  };
}

export function assessManagerAssignmentCoverage(
  state: Awaited<ReturnType<typeof readManagerAssignmentState>>,
  plans: Array<{ cardId: string }>,
  steps: Array<{ id: number; cardId: string; trelloChecklistId: string | null; trelloCheckItemId: string | null }>,
) {
  const planIds = new Set(plans.map(plan => plan.cardId));
  const stepByChecklistItem = new Map<string, number>();
  for (const step of steps) {
    if (step.trelloChecklistId && step.trelloCheckItemId) {
      stepByChecklistItem.set(`${step.cardId}:${step.trelloChecklistId}:${step.trelloCheckItemId}`, step.id);
    }
  }
  const missingPlanCards = new Set<string>();
  const missingChecklistSteps = new Set<string>();
  const blockedCardIds = new Set<string>();
  const blockedStepIds = new Set<number>();
  for (const assignment of state.assignments) {
    const reference = parseManagerAssignmentReference(assignment.taskId);
    if (!reference || !planIds.has(reference.cardId)) {
      missingPlanCards.add(reference?.cardId ?? assignment.taskId);
      continue;
    }
    if (reference.checklistId && reference.checkItemId) {
      const stepId = stepByChecklistItem.get(`${reference.cardId}:${reference.checklistId}:${reference.checkItemId}`);
      if (!stepId) {
        missingChecklistSteps.add(assignment.taskId);
        continue;
      }
      if (assignment.status === "blocked") blockedStepIds.add(stepId);
    } else if (assignment.status === "blocked") {
      blockedCardIds.add(reference.cardId);
    }
  }
  const gapCount = missingPlanCards.size + missingChecklistSteps.size;
  return {
    complete: state.complete && gapCount === 0,
    missingPlanCount: missingPlanCards.size,
    missingStepCount: missingChecklistSteps.size,
    blockedCardIds,
    blockedStepIds,
  };
}
