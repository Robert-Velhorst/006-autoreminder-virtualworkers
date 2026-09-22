import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  fetchAuthorizedTrelloCard: vi.fn(),
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
  isTrelloCommentAutomationEnabled: () => false,
  postTrelloComment: vi.fn(),
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE: "disabled",
}));
vi.mock("./services/chatbot-history", () => ({ storeConversation: vi.fn() }));

import communicationRoutes from "./routes/communication";

function mockDbSelects(...rows: unknown[][]) {
  return {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn().mockResolvedValue(rows.shift() ?? []),
      };
      query.from.mockReturnValue(query);
      query.where.mockReturnValue(query);
      return query;
    }),
  };
}

describe("communication ask-founder authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unassigned worker before it reads or comments on the Trello card", async () => {
    // resolveWorkerProfileId, worker lookup, then the assignment check.
    mocks.getDb.mockResolvedValue(mockDbSelects([{ id: 7 }], [{ id: 7, name: "Worker" }], []));
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
});
