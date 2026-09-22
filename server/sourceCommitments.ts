import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  commitments,
  reminderAuditEvents,
  reminderRules,
  reminderSchedules,
  type Commitment,
} from "../drizzle/schema";
import { getDb } from "./db";
import { getWorkerCards } from "./services/trello-manus";

type SourceType = "trello" | "gmail" | "google_drive" | "system";

export type SourceCommitmentInput = {
  workspaceOwnerId: number;
  assignedUserId: number;
  sourceType: SourceType;
  sourceId: string;
  sourceUrl?: string | null;
  title: string;
  context?: string | null;
  dueAt: Date;
  reminderOffsetMinutes?: number;
};

function insertId(result: unknown) {
  if (Array.isArray(result)) return Number((result[0] as { insertId?: unknown } | undefined)?.insertId ?? 0);
  return Number((result as { insertId?: unknown } | undefined)?.insertId ?? 0);
}

function clean(value: string, maximum: number) {
  return value.trim().slice(0, maximum);
}

function scheduleKey(workspaceOwnerId: number, commitmentId: number, dueAt: Date, offsetMinutes: number) {
  return createHash("sha256")
    .update(`${workspaceOwnerId}:${commitmentId}:source:${dueAt.toISOString()}:${offsetMinutes}`)
    .digest("hex");
}

function changed(existing: Commitment | undefined, input: SourceCommitmentInput) {
  if (!existing) return true;
  return Math.abs(existing.dueAt.getTime() - input.dueAt.getTime()) >= 60_000
    || existing.title !== input.title.trim()
    || (existing.context ?? "") !== (input.context?.trim() ?? "")
    || (existing.sourceUrl ?? "") !== (input.sourceUrl?.trim() ?? "");
}

export async function upsertSourceCommitment(input: SourceCommitmentInput) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable for source commitment sync");
  const sourceId = clean(input.sourceId, 255);
  const title = clean(input.title, 500);
  if (!sourceId || !title) throw new Error("Source commitment requires a source ID and title");
  if (Number.isNaN(input.dueAt.getTime())) throw new Error("Source commitment has an invalid deadline");
  const offsetMinutes = Math.min(43_200, Math.max(0, Math.round(input.reminderOffsetMinutes ?? 60)));

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(commitments).where(and(
      eq(commitments.workspaceOwnerId, input.workspaceOwnerId),
      eq(commitments.sourceType, input.sourceType),
      eq(commitments.sourceId, sourceId),
    )).limit(1);
    const sourceChanged = changed(existing, input);

    await tx.insert(commitments).values({
      workspaceOwnerId: input.workspaceOwnerId,
      assignedUserId: input.assignedUserId,
      createdByUserId: input.assignedUserId,
      sourceType: input.sourceType,
      sourceId,
      sourceUrl: input.sourceUrl?.trim().slice(0, 1_024) || null,
      title,
      context: input.context?.trim().slice(0, 8_000) || null,
      dueAt: input.dueAt,
    }).onDuplicateKeyUpdate({
      set: {
        assignedUserId: input.assignedUserId,
        sourceUrl: input.sourceUrl?.trim().slice(0, 1_024) || null,
        title,
        context: input.context?.trim().slice(0, 8_000) || null,
        dueAt: input.dueAt,
      },
    });

    const [commitment] = await tx.select().from(commitments).where(and(
      eq(commitments.workspaceOwnerId, input.workspaceOwnerId),
      eq(commitments.sourceType, input.sourceType),
      eq(commitments.sourceId, sourceId),
    )).limit(1);
    if (!commitment) throw new Error("Source commitment could not be persisted");
    if (commitment.status !== "open") {
      return { commitmentId: commitment.id, state: "terminal" as const, scheduleId: null };
    }

    const [latest] = await tx.select().from(reminderSchedules)
      .where(eq(reminderSchedules.commitmentId, commitment.id))
      .orderBy(desc(reminderSchedules.createdAt))
      .limit(1);
    const scheduledFor = new Date(input.dueAt.getTime() - offsetMinutes * 60_000);
    const idempotencyKey = scheduleKey(input.workspaceOwnerId, commitment.id, input.dueAt, offsetMinutes);

    if (latest?.state === "scheduled") {
      if (sourceChanged) {
        await tx.update(reminderRules).set({ offsetMinutes }).where(eq(reminderRules.id, latest.ruleId));
        await tx.update(reminderSchedules).set({ scheduledFor, idempotencyKey })
          .where(eq(reminderSchedules.id, latest.id));
        await tx.insert(reminderAuditEvents).values({
          workspaceOwnerId: input.workspaceOwnerId,
          commitmentId: commitment.id,
          scheduleId: latest.id,
          actorUserId: input.assignedUserId,
          eventType: "source_commitment_updated",
          detailsJson: JSON.stringify({ sourceType: input.sourceType, dueAt: input.dueAt.toISOString() }),
        });
      }
      return { commitmentId: commitment.id, state: sourceChanged ? "updated" as const : "unchanged" as const, scheduleId: latest.id };
    }

    if (latest && !["sent", "skipped", "cancelled"].includes(latest.state)) {
      return { commitmentId: commitment.id, state: "active_review" as const, scheduleId: latest.id };
    }
    if (latest?.state === "sent" && !sourceChanged) {
      return { commitmentId: commitment.id, state: "unchanged" as const, scheduleId: latest.id };
    }

    const ruleResult = await tx.insert(reminderRules).values({
      workspaceOwnerId: input.workspaceOwnerId,
      createdByUserId: input.assignedUserId,
      name: `Source deadline (${input.sourceType})`,
      triggerType: "before_due",
      offsetMinutes,
      channel: "in_app",
      requireApproval: false,
      maxAttempts: 1,
      cooldownMinutes: 60,
    });
    const ruleId = insertId(ruleResult);
    if (!ruleId) throw new Error("Source reminder rule could not be created");
    const scheduleResult = await tx.insert(reminderSchedules).values({
      commitmentId: commitment.id,
      ruleId,
      recipientUserId: input.assignedUserId,
      scheduledFor,
      state: "scheduled",
      channel: "in_app",
      idempotencyKey,
    });
    const scheduleId = insertId(scheduleResult);
    if (!scheduleId) throw new Error("Source reminder could not be scheduled");
    await tx.insert(reminderAuditEvents).values([
      {
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: commitment.id,
        actorUserId: input.assignedUserId,
        eventType: existing ? "source_commitment_reopened" : "source_commitment_created",
        detailsJson: JSON.stringify({ sourceType: input.sourceType, sourceId, dueAt: input.dueAt.toISOString() }),
      },
      {
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: commitment.id,
        scheduleId,
        actorUserId: input.assignedUserId,
        eventType: "source_reminder_scheduled",
        detailsJson: JSON.stringify({ channel: "in_app", scheduledFor: scheduledFor.toISOString() }),
      },
    ]);
    return { commitmentId: commitment.id, state: "created" as const, scheduleId };
  });
}

export async function syncWorkerTrelloCommitments(input: {
  userId: number;
  workspaceOwnerId: number;
  trelloMemberId: string | null;
}) {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!apiKey || !token) return { state: "blocked" as const, scanned: 0, scheduled: 0, reason: "Trello credentials are not configured" };
  if (!input.trelloMemberId?.trim()) return { state: "blocked" as const, scanned: 0, scheduled: 0, reason: "Worker Trello identity is not linked" };

  const cards = await getWorkerCards(apiKey, token, input.trelloMemberId);
  let scheduled = 0;
  for (const card of cards) {
    if (!card.due) continue;
    const dueAt = new Date(card.due);
    if (Number.isNaN(dueAt.getTime())) continue;
    const outcome = await upsertSourceCommitment({
      workspaceOwnerId: input.workspaceOwnerId,
      assignedUserId: input.userId,
      sourceType: "trello",
      sourceId: card.id,
      sourceUrl: card.url,
      title: card.name,
      context: [card.boardName, card.list?.name].filter(Boolean).join(" / ") || "Assigned Trello card",
      dueAt,
      reminderOffsetMinutes: 60,
    });
    if (outcome.state === "created" || outcome.state === "updated") scheduled++;
  }
  return { state: "synced" as const, scanned: cards.length, scheduled, reason: null };
}
