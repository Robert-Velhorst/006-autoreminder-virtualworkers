import { and, desc, eq } from "drizzle-orm";
import { aptlssPlans, aptlssSteps, decisionOutcomes } from "../drizzle/schema.postgres";
import { getDb } from "./db";

export class DecisionOutcomeError extends Error {}

export async function recordDecisionOutcome({
  vaId,
  stepId,
  outcome,
  resolvedBy,
}: {
  vaId: number;
  stepId: number;
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
      .limit(1);

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
        outcome,
        resolvedBy,
        resolvedAt,
      })
      .returning({ id: decisionOutcomes.id });

    await tx
      .update(aptlssSteps)
      .set({
        requiresRobert: false,
        status: "complete",
        completedAt: resolvedAt,
      })
      .where(eq(aptlssSteps.id, step.id));

    return { id: created.id, cardId: step.cardId, resolvedAt };
  });
}

export async function getDecisionHistory(vaId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(decisionOutcomes)
    .where(eq(decisionOutcomes.vaId, vaId))
    .orderBy(desc(decisionOutcomes.resolvedAt))
    .limit(limit);
}
