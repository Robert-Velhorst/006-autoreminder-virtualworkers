import { and, desc, eq } from "drizzle-orm";
import { aptlssWaitingReasons, type AptlssWaitingReason } from "../drizzle/schema.postgres";
import { getDb } from "./db";
import type { AptlssWaitingSignal, WaitingReasonInterpretation } from "./aptlssWaitingReason";

export class WaitingReasonError extends Error {}

export type HydratedWaitingReason = AptlssWaitingReason & {
  interpretationValue: WaitingReasonInterpretation;
};

function parseInterpretation(value: string): WaitingReasonInterpretation | null {
  try {
    return JSON.parse(value) as WaitingReasonInterpretation;
  } catch {
    return null;
  }
}

export function hydrateWaitingReason(row: AptlssWaitingReason): HydratedWaitingReason | null {
  const interpretationValue = parseInterpretation(row.interpretationJson);
  return interpretationValue ? { ...row, interpretationValue } : null;
}

export function toAptlssWaitingSignal(row: HydratedWaitingReason): AptlssWaitingSignal {
  return {
    ...row.interpretationValue,
    reasonId: row.id,
    recordedAt: row.createdAt.toISOString(),
  };
}

export async function recordAptlssWaitingReason({
  vaId,
  cardId,
  cardName,
  cardUrl,
  boardName,
  listName,
  interpretation,
  recordedBy,
}: {
  vaId: number;
  cardId: string;
  cardName: string;
  cardUrl: string;
  boardName: string;
  listName: string;
  interpretation: WaitingReasonInterpretation;
  recordedBy: string;
}): Promise<HydratedWaitingReason> {
  const db = await getDb();
  if (!db) throw new WaitingReasonError("Database unavailable");
  const rawReason = interpretation.rawReason.trim();
  if (!rawReason) throw new WaitingReasonError("Waiting reason cannot be empty");

  return db.transaction(async (tx) => {
    const createdAt = new Date();
    await tx
      .update(aptlssWaitingReasons)
      .set({ status: "superseded", resolvedAt: createdAt })
      .where(and(
        eq(aptlssWaitingReasons.vaId, vaId),
        eq(aptlssWaitingReasons.cardId, cardId),
        eq(aptlssWaitingReasons.status, "active"),
      ));

    const [created] = await tx
      .insert(aptlssWaitingReasons)
      .values({
        vaId,
        cardId,
        cardName,
        cardUrl,
        boardName,
        listName,
        rawReason,
        category: interpretation.category,
        waitingOn: interpretation.waitingOn,
        waitingOnName: interpretation.waitingOnName,
        requestedItem: interpretation.requestedItem,
        nextAction: interpretation.nextAction,
        nextStepType: interpretation.nextStepType,
        followUpAt: interpretation.followUpAt ? new Date(interpretation.followUpAt) : null,
        followUpSource: interpretation.followUpSource,
        urgency: interpretation.urgency,
        requiresRobert: interpretation.requiresRobert,
        confidenceScore: interpretation.confidenceScore,
        confidenceReason: interpretation.confidenceReason,
        interpretationJson: JSON.stringify(interpretation),
        interpreterVersion: interpretation.interpreterVersion,
        source: interpretation.source,
        status: "active",
        recordedBy,
        createdAt,
      })
      .returning({ id: aptlssWaitingReasons.id });
    if (!created?.id) throw new WaitingReasonError("Waiting reason could not be recorded");

    return {
      id: created.id,
      vaId,
      cardId,
      cardName,
      cardUrl,
      boardName,
      listName,
      rawReason,
      category: interpretation.category,
      waitingOn: interpretation.waitingOn,
      waitingOnName: interpretation.waitingOnName,
      requestedItem: interpretation.requestedItem,
      nextAction: interpretation.nextAction,
      nextStepType: interpretation.nextStepType,
      followUpAt: interpretation.followUpAt ? new Date(interpretation.followUpAt) : null,
      followUpSource: interpretation.followUpSource,
      urgency: interpretation.urgency,
      requiresRobert: interpretation.requiresRobert,
      confidenceScore: interpretation.confidenceScore,
      confidenceReason: interpretation.confidenceReason,
      interpretationJson: JSON.stringify(interpretation),
      interpreterVersion: interpretation.interpreterVersion,
      source: interpretation.source,
      status: "active",
      recordedBy,
      resolvedAt: null,
      createdAt,
      interpretationValue: interpretation,
    };
  });
}

export async function getActiveWaitingReason(vaId: number, cardId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(aptlssWaitingReasons)
    .where(and(
      eq(aptlssWaitingReasons.vaId, vaId),
      eq(aptlssWaitingReasons.cardId, cardId),
      eq(aptlssWaitingReasons.status, "active"),
    ))
    .orderBy(desc(aptlssWaitingReasons.createdAt), desc(aptlssWaitingReasons.id))
    .limit(1);
  return rows[0] ? hydrateWaitingReason(rows[0]) : null;
}

export async function getActiveWaitingReasons(vaId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(aptlssWaitingReasons)
    .where(and(eq(aptlssWaitingReasons.vaId, vaId), eq(aptlssWaitingReasons.status, "active")))
    .orderBy(desc(aptlssWaitingReasons.createdAt), desc(aptlssWaitingReasons.id));
  const latest = new Map<string, HydratedWaitingReason>();
  for (const row of rows) {
    if (latest.has(row.cardId)) continue;
    const hydrated = hydrateWaitingReason(row);
    if (hydrated) latest.set(row.cardId, hydrated);
  }
  return Array.from(latest.values());
}

export async function getWaitingReasonHistory(vaId: number, cardId: string, limit = 20) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(aptlssWaitingReasons)
    .where(and(eq(aptlssWaitingReasons.vaId, vaId), eq(aptlssWaitingReasons.cardId, cardId)))
    .orderBy(desc(aptlssWaitingReasons.createdAt), desc(aptlssWaitingReasons.id))
    .limit(Math.max(1, Math.min(100, limit)));
  return rows.flatMap((row) => {
    const hydrated = hydrateWaitingReason(row);
    return hydrated ? [hydrated] : [];
  });
}

export async function resolveAptlssWaitingReason(vaId: number, cardId: string) {
  const db = await getDb();
  if (!db) throw new WaitingReasonError("Database unavailable");
  const resolvedAt = new Date();
  await db
    .update(aptlssWaitingReasons)
    .set({ status: "resolved", resolvedAt })
    .where(and(
      eq(aptlssWaitingReasons.vaId, vaId),
      eq(aptlssWaitingReasons.cardId, cardId),
      eq(aptlssWaitingReasons.status, "active"),
    ));
  return { cardId, resolvedAt };
}
