/**
 * DB helpers for the APTLSS operational engine:
 *   - aptlss_steps  (atomic work units synced with Trello checklist items)
 *   - card_states   (state machine per Trello card)
 *   - priority_scores (calculated priority per card)
 */
import { getDb } from "./db";
import {
  aptlssSteps,
  cardStates,
  priorityScores,
  AptlssStep,
  InsertAptlssStep,
  CardState,
  InsertCardState,
  PriorityScore,
  InsertPriorityScore,
} from "../drizzle/schema";
import { eq, and, inArray, desc, sql } from "drizzle-orm";

// ─── aptlss_steps ─────────────────────────────────────────────────────────────

/** Upsert a batch of steps for a card (replaces all non-manual, non-completed steps). */
export async function upsertAptlssSteps(
  vaId: number,
  cardId: string,
  newSteps: InsertAptlssStep[]
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Load existing steps to preserve manual and completed ones
  const existing: AptlssStep[] = await db
    .select()
    .from(aptlssSteps)
    .where(and(eq(aptlssSteps.cardId, cardId), eq(aptlssSteps.vaId, vaId)));

  const manualOrDone = existing.filter(
    (s) => s.isManual || s.status === "complete"
  );
  const manualOrDoneCheckItemIds = new Set(
    manualOrDone.map((s) => s.trelloCheckItemId).filter(Boolean)
  );

  // Mark existing AI-generated open steps as obsolete
  const aiOpenIds = existing
    .filter((s) => !s.isManual && s.status === "open")
    .map((s) => s.id);
  if (aiOpenIds.length > 0) {
    await db
      .update(aptlssSteps)
      .set({ status: "obsolete" })
      .where(
        and(
          eq(aptlssSteps.cardId, cardId),
          eq(aptlssSteps.vaId, vaId),
          inArray(aptlssSteps.id, aiOpenIds)
        )
      );
  }

  // Insert new steps (skip if trelloCheckItemId already exists as manual/done)
  const toInsert = newSteps.filter(
    (s) =>
      !s.trelloCheckItemId ||
      !manualOrDoneCheckItemIds.has(s.trelloCheckItemId)
  );
  if (toInsert.length > 0) {
    await db.insert(aptlssSteps).values(toInsert);
  }
}

/** Get all open (non-obsolete) steps for a card, ordered by stepNumber. */
export async function getOpenStepsForCard(vaId: number, cardId: string): Promise<AptlssStep[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(aptlssSteps)
    .where(
      and(
        eq(aptlssSteps.cardId, cardId),
        eq(aptlssSteps.vaId, vaId),
        sql`${aptlssSteps.status} != 'obsolete'`
      )
    )
    .orderBy(aptlssSteps.stepNumber);
}

/** Get open steps for a group of cards in one worker-scoped query. */
export async function getOpenStepsForCards(vaId: number, cardIds: string[]): Promise<AptlssStep[]> {
  const db = await getDb();
  if (!db || cardIds.length === 0) return [];
  return db
    .select()
    .from(aptlssSteps)
    .where(and(
      eq(aptlssSteps.vaId, vaId),
      inArray(aptlssSteps.cardId, cardIds),
      sql`${aptlssSteps.status} != 'obsolete'`,
    ))
    .orderBy(aptlssSteps.cardId, aptlssSteps.stepNumber);
}

/** Get all manual (human-added) steps for a card — used to preserve them during checklist sync. */
export async function getManualStepsForCard(vaId: number, cardId: string): Promise<AptlssStep[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(aptlssSteps)
    .where(
      and(
        eq(aptlssSteps.cardId, cardId),
        eq(aptlssSteps.vaId, vaId),
        eq(aptlssSteps.isManual, true)
      )
    );
}

/** Get all open steps requiring Founder across all cards (optionally filtered by worker). */
export async function getAllFounderDecisionSteps(vaId?: number): Promise<AptlssStep[]> {
  const db = await getDb();
  if (!db) return [];
  const filters = [
    eq(aptlssSteps.requiresRobert, true),
    eq(aptlssSteps.status, "open")
  ];
  if (vaId !== undefined) {
    filters.push(eq(aptlssSteps.vaId, vaId));
  }
  return db
    .select()
    .from(aptlssSteps)
    .where(and(...filters))
    .orderBy(desc(aptlssSteps.createdAt));
}

/** Mark a step as complete by its Trello check-item ID. */
export async function completeStepByCheckItemId(
  trelloCheckItemId: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(aptlssSteps)
    .set({ status: "complete", completedAt: new Date() })
    .where(eq(aptlssSteps.trelloCheckItemId, trelloCheckItemId));
}

/** Mark a step as open (unchecked) by its Trello check-item ID. */
export async function uncompleteStepByCheckItemId(
  trelloCheckItemId: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(aptlssSteps)
    .set({ status: "open", completedAt: null })
    .where(eq(aptlssSteps.trelloCheckItemId, trelloCheckItemId));
}

function affectedRows(result: unknown): number {
  const value = Array.isArray(result) ? result[0] : result;
  return Number((value as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0);
}

/** Update a Trello-backed step only when it belongs to the active worker. */
export async function setStepCompletionForWorker(
  vaId: number,
  trelloCheckItemId: string,
  complete: boolean,
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db
    .update(aptlssSteps)
    .set({
      status: complete ? "complete" : "open",
      completedAt: complete ? new Date() : null,
    })
    .where(and(
      eq(aptlssSteps.vaId, vaId),
      eq(aptlssSteps.trelloCheckItemId, trelloCheckItemId),
    ));
  return affectedRows(result) === 1;
}

/** Mark a Founder-required step as resolved (removes from Decision Queue). */
export async function resolveFounderStep(stepId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(aptlssSteps)
    .set({ requiresRobert: false, status: "complete", completedAt: new Date() })
    .where(eq(aptlssSteps.id, stepId));
}

/** Resolve a Founder-required step only when it belongs to the active worker. */
export async function resolveFounderStepForWorker(
  vaId: number,
  stepId: number,
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db
    .update(aptlssSteps)
    .set({ requiresRobert: false, status: "complete", completedAt: new Date() })
    .where(and(
      eq(aptlssSteps.id, stepId),
      eq(aptlssSteps.vaId, vaId),
      eq(aptlssSteps.requiresRobert, true),
      eq(aptlssSteps.status, "open"),
    ));
  return affectedRows(result) === 1;
}

/** Get progress summary for a card: { total, completed, openFounder, openBlocked, estimatedRemainingMinutes } */
export async function getCardStepProgress(vaId: number, cardId: string) {
  const steps = await getOpenStepsForCard(vaId, cardId);
  const total = steps.filter((s) => s.status !== "obsolete").length;
  const completed = steps.filter((s) => s.status === "complete").length;
  const openSteps = steps.filter((s) => s.status === "open");
  const openFounder = openSteps.filter((s) => s.requiresRobert).length;
  const openBlocked = openSteps.filter((s) => !!s.blockedBy).length;
  const estimatedRemainingMinutes = openSteps.reduce(
    (sum, s) => sum + (s.estimatedMinutes ?? 15),
    0
  );
  return { total, completed, openFounder, openBlocked, estimatedRemainingMinutes };
}

// ─── card_states ──────────────────────────────────────────────────────────────

/** Upsert the computed state for a card. */
export async function upsertCardState(state: InsertCardState): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(cardStates).values(state).onDuplicateKeyUpdate({
    set: {
      cardName: state.cardName ?? "",
      boardName: state.boardName ?? "",
      listName: state.listName ?? "",
      state: state.state ?? "NEW_UNTRIAGED",
      stateReason: state.stateReason ?? null,
      daysSinceProgress: state.daysSinceProgress ?? 0,
      hasUnansweredQuestion: state.hasUnansweredQuestion ?? false,
      isOverdue: state.isOverdue ?? false,
      checklistComplete: state.checklistComplete ?? false,
      hasFinalSummary: state.hasFinalSummary ?? false,
      calculatedAt: state.calculatedAt ?? new Date(),
      updatedAt: new Date(),
    },
  });
}

/** Get the current state for a card (null if never computed). */
export async function getCardState(vaId: number, cardId: string): Promise<CardState | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(cardStates)
    .where(and(eq(cardStates.cardId, cardId), eq(cardStates.vaId, vaId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Get all card states for a worker. */
export async function getAllCardStates(vaId: number): Promise<CardState[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(cardStates).where(eq(cardStates.vaId, vaId)).orderBy(desc(cardStates.calculatedAt));
}

// ─── priority_scores ──────────────────────────────────────────────────────────

/** Upsert the priority score for a card. */
export async function upsertPriorityScore(
  score: InsertPriorityScore
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(priorityScores).values(score).onDuplicateKeyUpdate({
    set: {
      cardName: score.cardName ?? "",
      score: score.score ?? 0,
      breakdown: score.breakdown ?? null,
      tier: score.tier ?? "MEDIUM",
      estimatedRemainingMinutes: score.estimatedRemainingMinutes ?? 0,
      openSteps: score.openSteps ?? 0,
      completedSteps: score.completedSteps ?? 0,
      calculatedAt: score.calculatedAt ?? new Date(),
      updatedAt: new Date(),
    },
  });
}

/** Get the priority score for a card (null if never computed). */
export async function getPriorityScore(vaId: number, cardId: string): Promise<PriorityScore | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(priorityScores)
    .where(and(eq(priorityScores.cardId, cardId), eq(priorityScores.vaId, vaId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Get all priority scores for a worker, ordered by score descending. */
export async function getAllPriorityScores(vaId: number): Promise<PriorityScore[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(priorityScores)
    .where(eq(priorityScores.vaId, vaId))
    .orderBy(desc(priorityScores.score));
}

/** Count how many OTHER cards have this card's ID in their dependsOnCards JSON field. */
export async function countDependentCards(vaId: number, cardId: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .selectDistinct({ depCardId: aptlssSteps.cardId })
    .from(aptlssSteps)
    .where(
      and(
        eq(aptlssSteps.vaId, vaId),
        sql`${aptlssSteps.dependsOnCards} LIKE ${`%"${cardId}"%`}`,
        sql`${aptlssSteps.cardId} != ${cardId}`,
        sql`${aptlssSteps.status} != 'obsolete'`
      )
    );
  return rows.length;
}

/** Get all card states where state = NEEDS_RESTRUCTURING for a worker. */
export async function getNeedsRepairCards(vaId: number): Promise<CardState[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(cardStates)
    .where(and(eq(cardStates.state, "NEEDS_RESTRUCTURING"), eq(cardStates.vaId, vaId)))
    .orderBy(desc(cardStates.calculatedAt));
}

/** Get all card states where state = READY_FOR_DONE for a worker. */
export async function getReadyForDoneCards(vaId: number): Promise<CardState[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(cardStates)
    .where(and(eq(cardStates.state, "READY_FOR_DONE"), eq(cardStates.vaId, vaId)))
    .orderBy(desc(cardStates.calculatedAt));
}
