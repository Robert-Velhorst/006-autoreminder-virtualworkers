import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  commitments,
  reminderAuditEvents,
  reminderRules,
  reminderSchedules,
  type Commitment,
} from "../drizzle/schema.postgres";
import { getDb } from "./db";
import { ScheduledJobLeaseLostError, type ScheduledJobContext, type ScheduledJobOwnershipReader } from "./scheduledJobRuntime";
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


function clean(value: string, maximum: number) {
  return value.trim().slice(0, maximum);
}

function scheduleKey(workspaceOwnerId: number, commitmentId: number, assignedUserId: number, dueAt: Date, offsetMinutes: number) {
  return createHash("sha256")
    .update(`${workspaceOwnerId}:${commitmentId}:${assignedUserId}:source:${dueAt.toISOString()}:${offsetMinutes}`)
    .digest("hex");
}

function changed(existing: Commitment | undefined, input: SourceCommitmentInput) {
  if (!existing) return true;
  return Math.abs(existing.dueAt.getTime() - input.dueAt.getTime()) >= 60_000
    || existing.title !== input.title.trim()
    || (existing.context ?? "") !== (input.context?.trim() ?? "")
    || (existing.sourceUrl ?? "") !== (input.sourceUrl?.trim() ?? "");
}

async function checkpoint(context?: ScheduledJobContext, reader?: ScheduledJobOwnershipReader) {
  if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
  await context?.assertOwnership(reader);
  if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
}

export async function upsertSourceCommitment(input: SourceCommitmentInput, context?: ScheduledJobContext) {
  await checkpoint(context);
  const db = await getDb();
  await checkpoint(context);
  if (!db) throw new Error("Database unavailable for source commitment sync");
  const sourceId = clean(input.sourceId, 255);
  const title = clean(input.title, 500);
  if (!sourceId || !title) throw new Error("Source commitment requires a source ID and title");
  if (Number.isNaN(input.dueAt.getTime())) throw new Error("Source commitment has an invalid deadline");
  const offsetMinutes = Math.min(43_200, Math.max(0, Math.round(input.reminderOffsetMinutes ?? 60)));

  const outcome = await db.transaction(async (tx) => {
    await checkpoint(context, tx);
    const [existing] = await tx.select().from(commitments).where(and(
      eq(commitments.workspaceOwnerId, input.workspaceOwnerId),
      eq(commitments.sourceType, input.sourceType),
      eq(commitments.sourceId, sourceId),
    )).limit(1).for("update");
    await checkpoint(context, tx);
    const detailsChanged = changed(existing, input);
    const assignmentChanged = Boolean(existing && existing.assignedUserId !== input.assignedUserId);
    const sourceChanged = detailsChanged || assignmentChanged;

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
    }).onConflictDoUpdate({
      target: [commitments.workspaceOwnerId, commitments.sourceType, commitments.sourceId],
      set: {
        assignedUserId: input.assignedUserId,
        sourceUrl: input.sourceUrl?.trim().slice(0, 1_024) || null,
        title,
        context: input.context?.trim().slice(0, 8_000) || null,
        dueAt: input.dueAt,
      },
    });
    await checkpoint(context, tx);

    const [commitment] = await tx.select().from(commitments).where(and(
      eq(commitments.workspaceOwnerId, input.workspaceOwnerId),
      eq(commitments.sourceType, input.sourceType),
      eq(commitments.sourceId, sourceId),
    )).limit(1).for("update");
    await checkpoint(context, tx);
    if (!commitment) throw new Error("Source commitment could not be persisted");
    const assignedUserId = commitment.assignedUserId;
    if (assignedUserId === null) throw new Error("Source commitment has no assigned worker");
    if (commitment.status !== "open") {
      return { commitmentId: commitment.id, state: "terminal" as const, scheduleId: null };
    }

    const [latest] = await tx.select().from(reminderSchedules)
      .where(eq(reminderSchedules.commitmentId, commitment.id))
      .orderBy(desc(reminderSchedules.createdAt), desc(reminderSchedules.id))
      .limit(1)
      .for("update");
    await checkpoint(context, tx);
    const scheduledFor = new Date(input.dueAt.getTime() - offsetMinutes * 60_000);
    const idempotencyKey = scheduleKey(input.workspaceOwnerId, commitment.id, assignedUserId, input.dueAt, offsetMinutes);

    if (latest?.state === "scheduled") {
      const scheduleNeedsUpdate = sourceChanged || latest.recipientUserId !== assignedUserId;
      if (scheduleNeedsUpdate) {
        await tx.update(reminderRules).set({ offsetMinutes }).where(eq(reminderRules.id, latest.ruleId));
        await checkpoint(context, tx);
        await tx.update(reminderSchedules).set({
          recipientUserId: assignedUserId,
          scheduledFor,
          idempotencyKey,
        })
          .where(eq(reminderSchedules.id, latest.id));
        await checkpoint(context, tx);
        await tx.insert(reminderAuditEvents).values({
          workspaceOwnerId: input.workspaceOwnerId,
          commitmentId: commitment.id,
          scheduleId: latest.id,
          actorUserId: input.assignedUserId,
          eventType: assignmentChanged ? "source_commitment_reassigned" : "source_commitment_updated",
          detailsJson: JSON.stringify({
            sourceType: input.sourceType,
            dueAt: input.dueAt.toISOString(),
            ...(assignmentChanged ? { previousAssigneeId: existing?.assignedUserId, assignedUserId: commitment.assignedUserId } : {}),
          }),
        });
      }
      await checkpoint(context, tx);
      return { commitmentId: commitment.id, state: scheduleNeedsUpdate ? "updated" as const : "unchanged" as const, scheduleId: latest.id };
    }

    if (latest && !["sent", "skipped", "cancelled"].includes(latest.state)) {
      if (assignmentChanged || latest.recipientUserId !== assignedUserId) {
        await tx.update(reminderRules).set({ offsetMinutes }).where(eq(reminderRules.id, latest.ruleId));
        await checkpoint(context, tx);
        await tx.update(reminderSchedules).set({
          recipientUserId: assignedUserId,
          scheduledFor,
          state: "scheduled",
          draftTitle: null,
          draftContent: null,
          approvedAt: null,
          approvedByUserId: null,
          lastAttemptAt: null,
          error: null,
          policyReason: "Assignment changed. The reminder was returned for the current worker to review.",
          idempotencyKey,
        }).where(eq(reminderSchedules.id, latest.id));
        await checkpoint(context, tx);
        await tx.insert(reminderAuditEvents).values({
          workspaceOwnerId: input.workspaceOwnerId,
          commitmentId: commitment.id,
          scheduleId: latest.id,
          actorUserId: input.assignedUserId,
          eventType: "source_commitment_reassigned",
          detailsJson: JSON.stringify({
            sourceType: input.sourceType,
            previousAssigneeId: existing?.assignedUserId,
            assignedUserId: commitment.assignedUserId,
          }),
        });
        await checkpoint(context, tx);
        return { commitmentId: commitment.id, state: "updated" as const, scheduleId: latest.id };
      }
      return { commitmentId: commitment.id, state: "active_review" as const, scheduleId: latest.id };
    }
    if (latest && ["sent", "skipped", "cancelled"].includes(latest.state) && !sourceChanged) {
      return {
        commitmentId: commitment.id,
        state: sourceChanged ? "updated" as const : "unchanged" as const,
        scheduleId: latest.id,
      };
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
    }).returning({ id: reminderRules.id });
    const ruleId = ruleResult[0]?.id ?? 0;
    await checkpoint(context, tx);
    if (!ruleId) throw new Error("Source reminder rule could not be created");
    const scheduleResult = await tx.insert(reminderSchedules).values({
      commitmentId: commitment.id,
      ruleId,
      recipientUserId: input.assignedUserId,
      scheduledFor,
      state: "scheduled",
      channel: "in_app",
      idempotencyKey,
    }).returning({ id: reminderSchedules.id });
    const scheduleId = scheduleResult[0]?.id ?? 0;
    await checkpoint(context, tx);
    if (!scheduleId) throw new Error("Source reminder could not be scheduled");
    await tx.insert(reminderAuditEvents).values([
      {
        workspaceOwnerId: input.workspaceOwnerId,
        commitmentId: commitment.id,
        actorUserId: input.assignedUserId,
        eventType: assignmentChanged
          ? "source_commitment_reassigned"
          : existing ? "source_commitment_reopened" : "source_commitment_created",
        detailsJson: JSON.stringify({
          sourceType: input.sourceType,
          sourceId,
          dueAt: input.dueAt.toISOString(),
          ...(assignmentChanged ? { previousAssigneeId: existing?.assignedUserId, assignedUserId } : {}),
        }),
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
    await checkpoint(context, tx);
    return { commitmentId: commitment.id, state: "created" as const, scheduleId };
  });
  await checkpoint(context);
  return outcome;
}

export async function syncWorkerTrelloCommitments(input: {
  userId: number;
  workspaceOwnerId: number;
  trelloMemberId: string | null;
  context?: ScheduledJobContext;
}) {
  await checkpoint(input.context);
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!apiKey || !token) return { state: "blocked" as const, scanned: 0, scheduled: 0, reason: "Trello credentials are not configured" };
  if (!input.trelloMemberId?.trim()) return { state: "blocked" as const, scanned: 0, scheduled: 0, reason: "Worker Trello identity is not linked" };

  const cards = await getWorkerCards(apiKey, token, input.trelloMemberId);
  await checkpoint(input.context);
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
    }, input.context);
    await checkpoint(input.context);
    if (outcome.state === "created" || outcome.state === "updated") scheduled++;
  }
  await checkpoint(input.context);
  return { state: "synced" as const, scanned: cards.length, scheduled, reason: null };
}
