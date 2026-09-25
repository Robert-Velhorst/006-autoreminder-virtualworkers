import { and, desc, eq, like } from "drizzle-orm";
import { aptlssPlans, aptlssSteps, decisionOutcomes, notificationHistory } from "../drizzle/schema";
import { getDb } from "./db";
import { enqueueManagerTask } from "./aptlssManagerQueue";

export class DecisionOutcomeError extends Error {}

export async function recordDecisionOutcome({
  vaId,
  stepId,
  disposition,
  outcome,
  resolvedBy,
}: {
  vaId: number;
  stepId: number;
  disposition: "approved" | "rejected";
  outcome: string;
  resolvedBy: string;
}) {
  const db = await getDb();
  if (!db) throw new DecisionOutcomeError("Database unavailable");

  return db.transaction(async (tx) => {
    const [step] = await tx
      .select()
      .from(aptlssSteps)
      .where(
        and(
          eq(aptlssSteps.id, stepId),
          eq(aptlssSteps.vaId, vaId),
          eq(aptlssSteps.requiresRobert, true),
          eq(aptlssSteps.status, "open"),
        ),
      )
      .limit(1)
      .for("update");

    if (!step) {
      throw new DecisionOutcomeError("This decision is no longer open.");
    }

    const [plan] = await tx
      .select()
      .from(aptlssPlans)
      .where(and(eq(aptlssPlans.vaId, vaId), eq(aptlssPlans.cardId, step.cardId)))
      .orderBy(desc(aptlssPlans.generatedAt))
      .limit(1);

    const resolvedAt = new Date();
    const [created] = await tx
      .insert(decisionOutcomes)
      .values({
        vaId,
        stepId: step.id,
        cardId: step.cardId,
        cardName: plan?.cardName ?? step.cardId,
        cardUrl: plan?.cardUrl ?? `https://trello.com/c/${step.cardId}`,
        boardName: plan?.boardName ?? "",
        listName: plan?.listName ?? "",
        decisionPrompt: step.title,
        recommendedDecision: step.recommendedDecision,
        disposition,
        outcome,
        resolvedBy,
        resolvedAt,
      })
      .$returningId();

    await tx
      .update(aptlssSteps)
      .set({
        status: "complete",
        completedAt: resolvedAt,
      })
      .where(eq(aptlssSteps.id, step.id));

    await tx.update(notificationHistory).set({ isRead: 1, readAt: resolvedAt })
      .where(and(like(notificationHistory.taskId, `founder-decision:${step.id}:%`), eq(notificationHistory.isRead, 0)));

    const reassessment = await enqueueManagerTask(tx, {
      vaId,
      eventKey: `founder-decision:${created.id}`,
      trigger: "decision_outcome",
      urgent: true,
    });

    return { id: created.id, cardId: step.cardId, resolvedAt, reassessmentQueued: reassessment.accepted };
  });
}

export async function getDecisionHistory(vaId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select({
      id: decisionOutcomes.id,
      cardName: decisionOutcomes.cardName,
      outcome: decisionOutcomes.outcome,
      resolvedAt: decisionOutcomes.resolvedAt,
    })
    .from(decisionOutcomes)
    .where(eq(decisionOutcomes.vaId, vaId))
    .orderBy(desc(decisionOutcomes.resolvedAt))
    .limit(limit);
}
