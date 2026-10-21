import { Router } from "express";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatbotConversations, taskAssignments, vaProfiles } from "../../drizzle/schema.postgres";
import { getDb } from "../db";
import { requireAuthenticated, requestUser, resolveWorkerProfileId } from "../middleware/auth";
import {
  isTrelloCommentAutomationEnabled,
  postTrelloComment,
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE,
} from "../services/trello-chatbot";
import { fetchAuthorizedTrelloCard, TrelloAccessError } from "../trelloCardAccess";
import { AssignmentError, assignmentFailure } from "../taskAssignmentMutation";
import { withLockedAssignment } from "../taskAssignmentService";

const router = Router();
router.use(requireAuthenticated);

const WORKER_QUESTION_IDEMPOTENCY_VERSION = "worker-question-v1";

function workerQuestionKey(userId: number, workerId: number, taskId: string, question: string) {
  return createHash("sha256")
    .update(JSON.stringify([WORKER_QUESTION_IDEMPOTENCY_VERSION, userId, workerId, taskId, question]))
    .digest("hex");
}

function affectedRows(result: unknown) {
  return Number((result as { rowCount?: number | null } | undefined)?.rowCount ?? 0);
}

router.post("/ask-founder", async (req, res) => {
  const user = requestUser(req)!;
  if (user.role !== "worker") {
    return res.status(403).json({ error: "Only the assigned worker can send a question to the founder." });
  }

  const { taskId, question } = req.body;
  if (typeof taskId !== "string" || !taskId.trim() || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const workerId = await resolveWorkerProfileId(req);
  if (!workerId) {
    return res.status(403).json({ error: "Worker profile is missing or ambiguous; ask an administrator to resolve it." });
  }

  const db = await getDb();
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  try {
    const worker = await withLockedAssignment(db, user, taskId, async (_tx, _assignment, context) => {
      if (context.profile.id !== workerId) throw new AssignmentError(409, "Worker ownership changed");
      return context.profile;
    });
    const cardId = taskId.split(':')[0];
    await fetchAuthorizedTrelloCard(user, cardId, { fields: 'idMembers' });

    const normalizedQuestion = question.trim();
    const commentText = `**[Worker Question]**\n${worker.name} asked:\n"${normalizedQuestion}"`;

    if (!isTrelloCommentAutomationEnabled()) {
      return res.status(409).json({ success: false, error: TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE });
    }
    const requestKey = workerQuestionKey(user.id, workerId, taskId, normalizedQuestion);
    const requestArgs = JSON.stringify([WORKER_QUESTION_IDEMPOTENCY_VERSION, requestKey]);
    const receivedAt = new Date();
    const reservation = await withLockedAssignment(db, user, taskId, async (tx, _assignment, context) => {
      if (context.profile.id !== workerId) throw new AssignmentError(409, "Worker ownership changed");
      const [existing] = await tx.select({
        id: chatbotConversations.id,
        responseStatus: chatbotConversations.responseStatus,
        responseText: chatbotConversations.responseText,
      })
        .from(chatbotConversations)
        .where(and(
          eq(chatbotConversations.cardTrelloId, cardId),
          eq(chatbotConversations.command, "ask_founder"),
          eq(chatbotConversations.commandArgs, requestArgs),
        ))
        .limit(1)
        .for("update");

      if (existing) {
        if (existing.responseText !== normalizedQuestion) return { kind: "key-conflict" as const };
        if (existing.responseStatus === "success") return { kind: "already-sent" as const };
        return { kind: "uncertain" as const };
      }

      const [created] = await tx.insert(chatbotConversations).values({
        cardTrelloId: cardId,
        command: "ask_founder",
        commandArgs: requestArgs,
        authorName: context.profile.name,
        responseText: normalizedQuestion,
        responseStatus: "pending",
        receivedAt,
      }).returning({ id: chatbotConversations.id });

      if (!created?.id) throw new Error("Could not reserve the outbound question");
      return { kind: "reserved" as const, conversationId: created.id };
    });

    if (reservation.kind === "key-conflict") {
      return res.status(409).json({ success: false, error: "This question request conflicts with an existing send record." });
    }
    if (reservation.kind === "already-sent") {
      return res.json({ success: true });
    }
    if (reservation.kind === "uncertain") {
      return res.status(409).json({
        success: false,
        deliveryStatus: "unknown",
        error: "This question may already have been sent. Check the Trello card before taking further action.",
      });
    }

    let posted = false;
    try {
      posted = await postTrelloComment(cardId, commentText);
    } catch (error) {
      console.error("[Communication] Trello question delivery could not be confirmed:", error);
    }
    if (!posted) {
      return res.status(502).json({
        success: false,
        deliveryStatus: "unknown",
        error: "Trello did not confirm whether the question was delivered. Check the card before trying again.",
      });
    }

    const respondedAt = new Date();
    try {
      const result = await db.update(chatbotConversations)
        .set({
          responseStatus: "success",
          respondedAt,
          responseTimeMs: Math.max(0, respondedAt.getTime() - receivedAt.getTime()),
        })
        .where(eq(chatbotConversations.id, reservation.conversationId));
      if (affectedRows(result) !== 1) throw new Error("Delivery result was not recorded");
    } catch (error) {
      console.error("[Communication] Trello accepted the worker question but its delivery result could not be saved:", error);
      return res.status(502).json({
        success: false,
        deliveryStatus: "unknown",
        error: "Trello accepted the question, but the dashboard could not record the result. Check the card before trying again.",
      });
    }

    return res.json({ success: true });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    console.error("[Communication] Error processing ask-founder:", error);
    if (error instanceof TrelloAccessError) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: "Failed to process question" });
  }
});

router.post("/decision-log", async (req, res) => {
  const { taskId, decision, reasoning } = req.body;
  if (!taskId || typeof decision !== "string" || !decision.trim()) {
    return res.status(400).json({ error: "Task and decision are required" });
  }

  const db = await getDb();
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  try {
    const user = requestUser(req)!;
    const logs = await withLockedAssignment(db, user, taskId, async (tx, task, context) => {
      let currentLogs: Array<Record<string, unknown>> = [];
      try {
        currentLogs = task.decisionLog ? JSON.parse(task.decisionLog) : [];
        if (!Array.isArray(currentLogs)) currentLogs = [];
      } catch {
        currentLogs = [];
      }

      currentLogs.push({
        decision: decision.trim(),
        reasoning: typeof reasoning === "string" ? reasoning.trim() : "",
        author: context.actor.name || context.actor.openId,
        timestamp: new Date().toISOString(),
      });

      await tx.update(taskAssignments)
        .set({ decisionLog: JSON.stringify(currentLogs) })
        .where(eq(taskAssignments.id, task.id));
      return currentLogs;
    });
    if (!logs) return res.status(404).json({ error: "Task not found" });

    return res.json({ success: true, logs });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    console.error("Failed to save decision log:", error);
    return res.status(500).json({ error: "Failed to save decision log" });
  }
});

router.get("/decision-log/:taskId", async (req, res) => {
  const db = await getDb();
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  try {
    const user = requestUser(req)!;
    const logs = await withLockedAssignment(db, user, req.params.taskId, async (_tx, task) => {
      try {
        const parsed = task.decisionLog ? JSON.parse(task.decisionLog) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    });
    return res.json({ logs });
  } catch (error) {
    const failure = assignmentFailure(error);
    if (failure) return res.status(failure.status).json({ error: failure.error });
    return res.status(500).json({ error: "Failed to get decision log" });
  }
});

export default router;
