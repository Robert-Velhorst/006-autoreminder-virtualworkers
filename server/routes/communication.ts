import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { taskAssignments, vaProfiles } from "../../drizzle/schema";
import { getDb } from "../db";
import { requireAuthenticated, requestUser, resolveWorkerProfileId } from "../middleware/auth";
import { storeConversation } from "../services/chatbot-history";
import {
  isTrelloCommentAutomationEnabled,
  postTrelloComment,
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE,
} from "../services/trello-chatbot";
import { fetchAuthorizedTrelloCard, TrelloAccessError } from "../trelloCardAccess";

const router = Router();
router.use(requireAuthenticated);

router.post("/ask-founder", async (req, res) => {
  const { taskId, question } = req.body;
  const workerId = await resolveWorkerProfileId(req, req.body.workerId);
  if (!taskId || !workerId || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const db = await getDb();
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  try {
    const user = requestUser(req)!;
    const [worker] = await db.select().from(vaProfiles).where(eq(vaProfiles.id, workerId)).limit(1);
    if (!worker) return res.status(404).json({ error: "Worker profile not found" });

    const [assignment] = await db.select({ id: taskAssignments.id })
      .from(taskAssignments)
      .where(and(
        eq(taskAssignments.taskId, taskId),
        eq(taskAssignments.vaId, workerId),
      ))
      .limit(1);
    if (!assignment) {
      return res.status(404).json({ error: "Task is not assigned to this worker" });
    }

    await fetchAuthorizedTrelloCard(user, taskId, { fields: 'idMembers' });

    const normalizedQuestion = question.trim();
    const commentText = `**[Worker Question]**\n${worker.name} asked:\n"${normalizedQuestion}"`;

    if (!isTrelloCommentAutomationEnabled()) {
      return res.status(409).json({ success: false, error: TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE });
    }
    const posted = await postTrelloComment(taskId, commentText);

    await storeConversation({
      cardTrelloId: taskId,
      command: "ask_founder",
      responseText: normalizedQuestion,
      authorName: worker.name,
      responseStatus: posted ? "success" : "failed",
      receivedAt: new Date(),
      respondedAt: new Date(),
    });

    if (!posted) {
      return res.status(502).json({ success: false, error: "Trello did not accept the question" });
    }
    return res.json({ success: true });
  } catch (error) {
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
    const workerId = user.role === "admin" ? null : await resolveWorkerProfileId(req);
    if (user.role !== "admin" && !workerId) {
      return res.status(403).json({ error: "Worker profile not found" });
    }

    const [task] = await db.select().from(taskAssignments).where(workerId
      ? and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.vaId, workerId))
      : eq(taskAssignments.taskId, taskId)).limit(1);
    if (!task) return res.status(404).json({ error: "Task not found" });

    let logs: Array<Record<string, unknown>> = [];
    try {
      logs = task.decisionLog ? JSON.parse(task.decisionLog) : [];
      if (!Array.isArray(logs)) logs = [];
    } catch {
      logs = [];
    }

    logs.push({
      decision: decision.trim(),
      reasoning: typeof reasoning === "string" ? reasoning.trim() : "",
      author: user.name || user.openId,
      timestamp: new Date().toISOString(),
    });

    await db.update(taskAssignments)
      .set({ decisionLog: JSON.stringify(logs) })
      .where(eq(taskAssignments.id, task.id));

    return res.json({ success: true, logs });
  } catch (error) {
    console.error("Failed to save decision log:", error);
    return res.status(500).json({ error: "Failed to save decision log" });
  }
});

router.get("/decision-log/:taskId", async (req, res) => {
  const db = await getDb();
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  try {
    const user = requestUser(req)!;
    const workerId = user.role === "admin" ? null : await resolveWorkerProfileId(req);
    if (user.role !== "admin" && !workerId) {
      return res.status(403).json({ error: "Worker profile not found" });
    }

    const [task] = await db.select().from(taskAssignments).where(workerId
      ? and(eq(taskAssignments.taskId, req.params.taskId), eq(taskAssignments.vaId, workerId))
      : eq(taskAssignments.taskId, req.params.taskId)).limit(1);
    if (!task) return res.status(404).json({ error: "Task not found" });

    let logs: unknown[] = [];
    try {
      const parsed = task.decisionLog ? JSON.parse(task.decisionLog) : [];
      logs = Array.isArray(parsed) ? parsed : [];
    } catch {
      logs = [];
    }
    return res.json({ logs });
  } catch {
    return res.status(500).json({ error: "Failed to get decision log" });
  }
});

export default router;
