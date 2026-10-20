import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { taskAssignments, userWorkingHours, users, vaProfiles } from "../drizzle/schema.postgres";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  fetchAuthorizedTrelloCard: vi.fn(),
  isTrelloCommentAutomationEnabled: vi.fn(),
  postTrelloComment: vi.fn(),
  storeConversation: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./trelloCardAccess", () => ({
  fetchAuthorizedTrelloCard: mocks.fetchAuthorizedTrelloCard,
  TrelloAccessError: class TrelloAccessError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("./services/trello-chatbot", () => ({
  isTrelloCommentAutomationEnabled: mocks.isTrelloCommentAutomationEnabled,
  postTrelloComment: mocks.postTrelloComment,
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE: "disabled",
}));
vi.mock("./services/chatbot-history", () => ({ storeConversation: mocks.storeConversation }));

import communicationRoutes from "./routes/communication";

const pgDialect = new PgDialect();

function assignmentRowsMatching(rows: Array<Record<string, unknown>>, condition: unknown) {
  if (!condition) return rows;
  const { sql, params } = pgDialect.sqlToQuery(condition as SQL);
  const comparisons = [...sql.matchAll(/"task_assignments"\."([^"]+)" = \$(\d+)/g)];
  return rows.filter(row => comparisons.every((comparison, index) => row[comparison[1]] === params[Number(comparison[2]) - 1]));
}

function mockDb(profiles: unknown[], assignments: Array<Record<string, unknown>> = []) {
  const assignmentConditions: unknown[] = [];
  const transactionUpdate = vi.fn().mockReturnValue({ rowCount: 1 });
  const conversationInsert = vi.fn();
  const conversationUpdate = vi.fn();
  const rowsFor = (table: unknown, condition: unknown) => {
    if (table === vaProfiles) return profiles;
    if (table === taskAssignments) return assignmentRowsMatching(assignments, condition);
    if (table === users) return [{ name: "Founder" }];
    if (table === userWorkingHours) return [];
    return [];
  };
  const select = (transactional: boolean) => vi.fn(() => {
    let table: unknown;
    let condition: unknown;
    const query: any = {
      from: vi.fn((value: unknown) => { table = value; return query; }),
      where: vi.fn((value: unknown) => {
        condition = value;
        if (table === taskAssignments) assignmentConditions.push(value);
        return query;
      }),
      limit: vi.fn(() => transactional ? query : Promise.resolve(rowsFor(table, condition))),
      orderBy: vi.fn(() => query),
      for: vi.fn(async () => rowsFor(table, condition)),
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(rowsFor(table, condition)).then(resolve, reject),
    };
    return query;
  });
  const db = {
    select: select(false),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        conversationInsert(value);
        return { returning: vi.fn(async () => [{ id: 10 }]) };
      }),
    })),
    update: vi.fn(() => {
      const query: any = {
        set: vi.fn((value: unknown) => { conversationUpdate(value); return query; }),
        where: vi.fn(async () => transactionUpdate()),
      };
      return query;
    }),
    transaction: vi.fn(async (callback: (transaction: any) => Promise<unknown>) => callback({
      select: select(true),
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
          conversationInsert(value);
          return { returning: vi.fn(async () => [{ id: 10 }]) };
        }),
      })),
      update: vi.fn(() => {
        const query: any = {
          set: vi.fn(() => query),
          where: vi.fn(async () => transactionUpdate()),
        };
        return query;
      }),
    })),
  };
  return { db, assignmentConditions, transactionUpdate, conversationInsert, conversationUpdate };
}

describe("communication ask-founder authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTrelloCommentAutomationEnabled.mockReturnValue(false);
    mocks.postTrelloComment.mockResolvedValue(true);
    mocks.storeConversation.mockResolvedValue(undefined);
  });

  it("rejects an unassigned worker before it reads or comments on the Trello card", async () => {
    const { db } = mockDb([
      { id: 7, userId: 42, founderId: 8, name: "Worker", status: "active", timezone: "UTC" },
    ]);
    mocks.getDb.mockResolvedValue(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker" };
      next();
    });
    app.use("/communication", communicationRoutes);

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "card-not-assigned", question: "Can you clarify this?" })
      .expect(404, { error: "Task is not assigned to this worker" });

    expect(mocks.fetchAuthorizedTrelloCard).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous worker profile before assignment lookup or Trello access", async () => {
    const { db } = mockDb([
      { id: 7, userId: 42, founderId: 8, name: "Worker A", status: "active", timezone: "UTC" },
      { id: 9, userId: 42, founderId: 10, name: "Worker B", status: "active", timezone: "UTC" },
    ]);
    mocks.getDb.mockResolvedValue(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker" };
      next();
    });
    app.use("/communication", communicationRoutes);

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "case-card", question: "Can you clarify this?" })
      .expect(403, { error: "Worker profile is missing or ambiguous; ask an administrator to resolve it." });

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAuthorizedTrelloCard).not.toHaveBeenCalled();
  });

  it("does not let an admin publish a Trello question under a worker's identity", async () => {
    const { db } = mockDb([
      { id: 7, userId: 42, founderId: 8, name: "Worker", status: "active", timezone: "UTC" },
    ], [{ id: 1, taskId: "assigned-card", vaId: 7 }]);
    mocks.getDb.mockResolvedValue(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 99, openId: "admin-99", role: "admin" };
      next();
    });
    app.use("/communication", communicationRoutes);

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "assigned-card", workerId: 7, question: "Can you clarify this?" })
      .expect(403, { error: "Only the assigned worker can send a question to the founder." });

    expect(db.select).not.toHaveBeenCalled();
    expect(mocks.fetchAuthorizedTrelloCard).not.toHaveBeenCalled();
  });

  it("does not publish a worker question while outbound comments are disabled", async () => {
    const { db } = mockDb([
      { id: 7, userId: 42, founderId: 8, name: "Worker", status: "active", timezone: "UTC" },
    ], [{ id: 1, taskId: "assigned-card", vaId: 7 }]);
    mocks.getDb.mockResolvedValue(db);
    mocks.fetchAuthorizedTrelloCard.mockResolvedValue({ id: "assigned-card", idMembers: [] });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker" };
      next();
    });
    app.use("/communication", communicationRoutes);

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "assigned-card", question: "Can you clarify this?" })
      .expect(409, { success: false, error: "disabled" });

    expect(mocks.fetchAuthorizedTrelloCard).toHaveBeenCalledOnce();
    expect(mocks.postTrelloComment).not.toHaveBeenCalled();
    expect(mocks.storeConversation).not.toHaveBeenCalled();
  });

  it("publishes only the authenticated worker's assigned question after the outbound gate is enabled", async () => {
    mocks.isTrelloCommentAutomationEnabled.mockReturnValue(true);
    const { db, conversationInsert, conversationUpdate } = mockDb([
      { id: 7, userId: 42, founderId: 8, name: "Worker", status: "active", timezone: "UTC" },
    ], [{ id: 1, taskId: "assigned-card", vaId: 7 }]);
    mocks.getDb.mockResolvedValue(db);
    mocks.fetchAuthorizedTrelloCard.mockResolvedValue({ id: "assigned-card", idMembers: [] });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker" };
      next();
    });
    app.use("/communication", communicationRoutes);

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "assigned-card", question: "  Can you clarify this?  " })
      .expect(200, { success: true });

    expect(mocks.postTrelloComment).toHaveBeenCalledWith(
      "assigned-card",
      '**[Worker Question]**\nWorker asked:\n"Can you clarify this?"',
    );
    expect(conversationInsert).toHaveBeenCalledWith(expect.objectContaining({
      cardTrelloId: "assigned-card",
      command: "ask_founder",
      responseStatus: "pending",
      responseText: "Can you clarify this?",
      authorName: "Worker",
    }));
    expect(conversationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      responseStatus: "success",
      respondedAt: expect.any(Date),
      responseTimeMs: expect.any(Number),
    }));
    expect(mocks.storeConversation).not.toHaveBeenCalled();
  });
});

describe("communication decision-log authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not disclose another worker's decision log when their workerId is supplied", async () => {
    const taskId = "another-workers-card";
    const { db, assignmentConditions } = mockDb(
      [{ id: 7, userId: 42, founderId: 8, name: "Worker A", status: "active", timezone: "UTC" }],
      [{ id: 15, taskId, vaId: 9, decisionLog: JSON.stringify([{ decision: "Private to worker B" }]) }],
    );
    mocks.getDb.mockResolvedValue(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker" };
      next();
    });
    app.use("/communication", communicationRoutes);

    await request(app)
      .get(`/communication/decision-log/${taskId}?workerId=9`)
      .expect(404, { error: "Task not found" });

    expect(assignmentConditions).toHaveLength(1);
    const { sql, params } = pgDialect.sqlToQuery(assignmentConditions[0] as SQL);
    expect(sql).toMatch(/"task_assignments"\."vaId" = \$\d+/);
    expect(params).toEqual([taskId, 7]);
  });

  it("does not append a decision to another worker's assignment when their workerId is supplied", async () => {
    const taskId = "another-workers-card";
    const { db, assignmentConditions, transactionUpdate } = mockDb(
      [{ id: 7, userId: 42, founderId: 8, name: "Worker A", status: "active", timezone: "UTC" }],
      [{ id: 15, taskId, vaId: 9, decisionLog: "[]" }],
    );
    mocks.getDb.mockResolvedValue(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker" };
      next();
    });
    app.use("/communication", communicationRoutes);

    await request(app)
      .post("/communication/decision-log")
      .send({ taskId, workerId: 9, decision: "Unauthorized change" })
      .expect(404, { error: "Task not found" });

    expect(assignmentConditions).toHaveLength(1);
    const { sql, params } = pgDialect.sqlToQuery(assignmentConditions[0] as SQL);
    expect(sql).toMatch(/"task_assignments"\."vaId" = \$\d+/);
    expect(params).toEqual([taskId, 7]);
    expect(transactionUpdate).not.toHaveBeenCalled();
  });
});
