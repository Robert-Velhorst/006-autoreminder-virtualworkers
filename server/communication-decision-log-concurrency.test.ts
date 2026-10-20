import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskAssignments } from "../drizzle/schema.postgres";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./middleware/auth", () => ({
  requireAuthenticated: (_req: unknown, _res: unknown, next: () => void) => next(),
  requestUser: (req: { user?: unknown }) => req.user ?? null,
  resolveWorkerProfileId: vi.fn(async () => 7),
}));
vi.mock("./trelloCardAccess", () => ({
  fetchAuthorizedTrelloCard: vi.fn(),
  TrelloAccessError: class TrelloAccessError extends Error {},
}));
vi.mock("./services/trello-chatbot", () => ({
  isTrelloCommentAutomationEnabled: () => false,
  postTrelloComment: vi.fn(),
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE: "disabled",
}));
vi.mock("./services/chatbot-history", () => ({ storeConversation: vi.fn() }));

import communicationRoutes from "./routes/communication";

function makeDb() {
  const assignment = {
    id: 15,
    taskId: "shared-task",
    vaId: 7,
    decisionLog: null as string | null,
  };
  let assignmentLockTail: Promise<void> = Promise.resolve();
  let assignmentRowLockCount = 0;
  const db = {
    transaction: vi.fn(async <T>(callback: (transaction: any) => Promise<T>) => {
      const heldLocks: Array<() => void> = [];
      const tx = {
        select: vi.fn(() => {
          let table: unknown;
          const query: any = {
            from: vi.fn((value: unknown) => { table = value; return query; }),
            where: vi.fn(() => query),
            limit: vi.fn(() => query),
            for: vi.fn(async () => {
              if (table !== taskAssignments) return [];
              assignmentRowLockCount += 1;
              const previous = assignmentLockTail;
              let release!: () => void;
              assignmentLockTail = new Promise<void>(resolve => { release = resolve; });
              await previous;
              heldLocks.push(release);
              return [{ ...assignment }];
            }),
          };
          return query;
        }),
        update: vi.fn(() => {
          let values: { decisionLog?: string } = {};
          const query: any = {
            set: vi.fn((next: typeof values) => { values = next; return query; }),
            where: vi.fn(async () => {
              if (values.decisionLog !== undefined) assignment.decisionLog = values.decisionLog;
              return { rowCount: 1 };
            }),
          };
          return query;
        }),
      };
      try {
        return await callback(tx);
      } finally {
        heldLocks.reverse().forEach(release => release());
      }
    }),
  };
  return { db, assignment, getAssignmentRowLockCount: () => assignmentRowLockCount };
}

describe("communication decision log concurrency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains both decisions when the same worker submits concurrently", async () => {
    const { db, assignment, getAssignmentRowLockCount } = makeDb();
    mocks.getDb.mockResolvedValue(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker", name: "Worker" };
      next();
    });
    app.use("/communication", communicationRoutes);

    const [first, second] = await Promise.all([
      request(app).post("/communication/decision-log").send({ taskId: "shared-task", decision: "First" }),
      request(app).post("/communication/decision-log").send({ taskId: "shared-task", decision: "Second" }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(getAssignmentRowLockCount()).toBe(2);
    const retained = JSON.parse(assignment.decisionLog ?? "[]");
    expect(retained.map((item: { decision: string }) => item.decision).sort()).toEqual(["First", "Second"]);
  });
});
