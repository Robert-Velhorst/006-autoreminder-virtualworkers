import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatbotConversations, taskAssignments, users, vaProfiles } from "../../drizzle/schema.postgres";
import { matchesTimerWhere } from '../test/timerDatabase';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  fetchAuthorizedTrelloCard: vi.fn(),
  isTrelloCommentAutomationEnabled: vi.fn(),
  postTrelloComment: vi.fn(),
  storeConversation: vi.fn(),
  authenticate: vi.fn(),
}));
vi.mock('../_core/sdk', () => ({ sdk: { authenticateRequest: mocks.authenticate } }));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../trelloCardAccess", () => ({
  fetchAuthorizedTrelloCard: mocks.fetchAuthorizedTrelloCard,
  TrelloAccessError: class TrelloAccessError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("../services/trello-chatbot", () => ({
  isTrelloCommentAutomationEnabled: mocks.isTrelloCommentAutomationEnabled,
  postTrelloComment: mocks.postTrelloComment,
  TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE: "outbound comments disabled",
}));
vi.mock("../services/chatbot-history", () => ({ storeConversation: mocks.storeConversation }));

import communicationRoutes from "./communication";

function matches(row: Record<string, unknown>, condition: unknown) {
  return matchesTimerWhere(row, condition);
}

function createDb(
  assignmentTaskId = "case-1",
  failReservation = false,
  failOutcomePersistence: "throw" | "zero" | false = false,
) {
  const profile = { id: 7, userId: 42, founderId: 8, name: "Worker", status: "active", timezone: "UTC" };
  const assignment = { id: 11, taskId: assignmentTaskId, vaId: 7, founderId: 8, status: 'assigned' };
  const conversations: Array<Record<string, any>> = [];
  const accounts = [{ id: 42, role: 'worker', openId: 'worker-42', sessionEpoch: '1' }, { id: 8, role: 'admin', openId: 'founder-8', sessionEpoch: '1' }];
  let nextConversationId = 1;
  let transactionTail = Promise.resolve();

  const select = () => {
    let table: unknown;
    let condition: unknown;
    const rows = () => {
      if (table === vaProfiles) return matches(profile, condition) ? [profile] : [];
      if (table === taskAssignments) return matches(assignment, condition) ? [assignment] : [];
      if (table === users) return accounts
        .filter(row => matchesTimerWhere(row, condition));
      if (table === chatbotConversations) return conversations.filter(row => matches(row, condition));
      return [];
    };
    const query: any = {
      from: vi.fn((value: unknown) => { table = value; return query; }),
      where: vi.fn((value: unknown) => { condition = value; return query; }),
      limit: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      for: vi.fn(async () => rows()),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject),
    };
    return query;
  };

  const update = () => {
    let values: Record<string, unknown> = {};
    const query: any = {
      set: vi.fn((next: Record<string, unknown>) => { values = next; return query; }),
      where: vi.fn(async (condition: unknown) => {
        if (failOutcomePersistence === "throw" && values.responseStatus === "success") {
          throw new Error("delivery result storage unavailable");
        }
        if (failOutcomePersistence === "zero" && values.responseStatus === "success") return { rowCount: 0 };
        const row = conversations.find(candidate => matches(candidate, condition));
        if (row) Object.assign(row, values);
        return { rowCount: row ? 1 : 0 };
      }),
    };
    return query;
  };

  const tx = {
    execute: vi.fn(async () => ({ rows: [] })),
    select,
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, any>) => ({
        returning: vi.fn(async () => {
          if (failReservation) throw new Error("reservation storage unavailable");
          const created = { id: nextConversationId++, ...row };
          conversations.push(created);
          return [{ id: created.id }];
        }),
      })),
    })),
  };
  const db = {
    execute: tx.execute,
    select,
    update,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    }),
    conversations,
    profile, assignment, accounts,
  };
  return db;
}

function createApp(user: { id: number; openId: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use("/communication", communicationRoutes);
  return app;
}

describe("APTLSS external communication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTrelloCommentAutomationEnabled.mockReturnValue(true);
    mocks.fetchAuthorizedTrelloCard.mockResolvedValue({ id: "case-1", idMembers: ["worker-member"] });
    mocks.postTrelloComment.mockResolvedValue(true);
    mocks.storeConversation.mockResolvedValue(1);
    mocks.authenticate.mockResolvedValue({ id: 42, openId: 'worker-42', role: 'worker', sessionEpoch: '1' });
  });

  it.each(['offboarded', 'reassigned', 'session', 'revoked', 'identity', 'reservation', 'unavailable', 'unchanged'])
    ('revalidates %s after deferred sender readiness without replaying the reservation', async change => {
      const db = createDb();
      mocks.getDb.mockResolvedValue(db);
      let release!: () => void;
      const readiness = new Promise<void>(resolve => { release = resolve; });
      const dispatch = vi.fn();
      mocks.postTrelloComment.mockImplementation(async (_card, _text, beforeDispatch) => {
        await readiness;
        if (!await beforeDispatch()) return false;
        dispatch(); return true;
      });
      const app = createApp({ id: 42, openId: 'worker-42', role: 'worker', sessionEpoch: '1' } as any);
      const payload = { taskId: 'case-1', question: 'Please confirm.' };
      const pending = request(app).post('/communication/ask-founder').send(payload).then(response => response);
      await vi.waitFor(() => expect(mocks.postTrelloComment).toHaveBeenCalledOnce());
      if (change === 'offboarded') db.profile.status = 'inactive';
      if (change === 'reassigned') db.assignment.vaId = 99;
      if (change === 'session') db.accounts[0].sessionEpoch = '2';
      if (change === 'revoked') mocks.authenticate.mockRejectedValue(new Error('Revoked session'));
      if (change === 'identity') db.accounts[0].openId = 'recreated-worker';
      if (change === 'reservation') db.conversations[0].responseStatus = 'success';
      if (change === 'unavailable') db.transaction.mockRejectedValue(new Error('Unavailable'));
      release();
      const response = await pending;
      expect(response.status).toBe(change === 'unchanged' ? 200 : 409);
      expect(dispatch).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
      if (change !== 'unchanged') expect(response.body.deliveryStatus).toBe('not_sent');
      if (change === 'offboarded' || change === 'session' || change === 'identity') {
        expect(db.conversations[0].responseStatus).toBe('pending');
      }
      expect(db.conversations).toHaveLength(1);
    });

  it("does not post the same explicitly submitted worker question twice when the caller retries", async () => {
    const db = createDb();
    mocks.getDb.mockResolvedValue(db);
    mocks.postTrelloComment.mockImplementation(async () => {
      expect(db.conversations[0]).toMatchObject({
        command: "ask_founder",
        responseStatus: "pending",
        responseText: "Please confirm the filing deadline.",
      });
      return true;
    });
    const app = createApp({ id: 42, openId: "worker-42", role: "worker" });
    const payload = { taskId: "case-1", question: "Please confirm the filing deadline." };

    await request(app).post("/communication/ask-founder").send(payload).expect(200);
    await request(app).post("/communication/ask-founder").send(payload).expect(200, { success: true });

    expect(mocks.postTrelloComment).toHaveBeenCalledTimes(1);
    expect(mocks.storeConversation).not.toHaveBeenCalled();
    expect(db.conversations[0].responseStatus).toBe("success");
  });

  it("records an unconfirmed delivery before returning and refuses a duplicate retry", async () => {
    const db = createDb();
    mocks.getDb.mockResolvedValue(db);
    mocks.postTrelloComment.mockResolvedValue(false);
    const app = createApp({ id: 42, openId: "worker-42", role: "worker" });
    const payload = { taskId: "case-1", question: "Please confirm the filing deadline." };

    const first = await request(app).post("/communication/ask-founder").send(payload);
    const retry = await request(app).post("/communication/ask-founder").send(payload);

    expect(first.status).toBe(502);
    expect(first.body.deliveryStatus).toBe("unknown");
    expect(retry.status).toBe(409);
    expect(retry.body.deliveryStatus).toBe("unknown");

    expect(mocks.postTrelloComment).toHaveBeenCalledTimes(1);
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0].responseStatus).toBe("pending");
  });

  it.each([
    ["throws while saving", "throw"],
    ["reports no updated row", "zero"],
  ] as const)("reports unknown and refuses a resend if Trello accepts but persistence %s", async (_case, failure) => {
    const db = createDb("case-1", false, failure);
    mocks.getDb.mockResolvedValue(db);
    const app = createApp({ id: 42, openId: "worker-42", role: "worker" });
    const payload = { taskId: "case-1", question: "Please confirm the filing deadline." };

    const first = await request(app).post("/communication/ask-founder").send(payload);
    const retry = await request(app).post("/communication/ask-founder").send(payload);

    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({ success: false, deliveryStatus: "unknown" });
    expect(retry.status).toBe(409);
    expect(retry.body.deliveryStatus).toBe("unknown");
    expect(mocks.postTrelloComment).toHaveBeenCalledTimes(1);
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0].responseStatus).toBe("pending");
  });

  it("allows only one provider attempt while concurrent copies of a request are in flight", async () => {
    const db = createDb();
    mocks.getDb.mockResolvedValue(db);
    let resolveProvider!: (posted: boolean) => void;
    mocks.postTrelloComment.mockReturnValue(new Promise<boolean>(resolve => { resolveProvider = resolve; }));
    const app = createApp({ id: 42, openId: "worker-42", role: "worker" });
    const payload = { taskId: "case-1", question: "Please confirm the filing deadline." };
    const firstRequest = request(app).post("/communication/ask-founder").send(payload);
    const firstPromise = firstRequest.then(response => response);

    await vi.waitFor(() => expect(mocks.postTrelloComment).toHaveBeenCalledTimes(1));
    const retry = await request(app).post("/communication/ask-founder").send(payload);
    resolveProvider(true);
    const first = await firstPromise;

    expect(first.status).toBe(200);
    expect(retry.status).toBe(409);
    expect(retry.body.deliveryStatus).toBe("unknown");
    expect(mocks.postTrelloComment).toHaveBeenCalledTimes(1);
  });

  it("fails closed without sending if the durable reservation cannot be stored", async () => {
    const db = createDb("case-1", true);
    mocks.getDb.mockResolvedValue(db);
    const app = createApp({ id: 42, openId: "worker-42", role: "worker" });

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "case-1", question: "Please confirm the deadline." })
      .expect(500, { error: "Failed to process question" });

    expect(mocks.postTrelloComment).not.toHaveBeenCalled();
    expect(db.conversations).toHaveLength(0);
  });

  it("does not let a proposal-only payload trigger a send", async () => {
    mocks.getDb.mockResolvedValue(createDb());
    const app = createApp({ id: 42, openId: "worker-42", role: "worker" });

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "case-1", proposedMessage: "Please approve this draft" })
      .expect(400);

    expect(mocks.postTrelloComment).not.toHaveBeenCalled();
  });

  it("rejects an unassigned case and does not contact Trello", async () => {
    mocks.getDb.mockResolvedValue(createDb("another-case"));
    const app = createApp({ id: 42, openId: "worker-42", role: "worker" });

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "case-1", workerId: 99, question: "Please confirm the deadline." })
      .expect(404, { error: "Assigned task not found" });

    expect(mocks.fetchAuthorizedTrelloCard).not.toHaveBeenCalled();
    expect(mocks.postTrelloComment).not.toHaveBeenCalled();
  });

  it("rejects non-worker identities even when they submit an assigned worker id", async () => {
    mocks.getDb.mockResolvedValue(createDb());
    const app = createApp({ id: 99, openId: "admin-99", role: "admin" });

    await request(app)
      .post("/communication/ask-founder")
      .send({ taskId: "case-1", workerId: 7, question: "Please confirm the deadline." })
      .expect(403);

    expect(mocks.fetchAuthorizedTrelloCard).not.toHaveBeenCalled();
    expect(mocks.postTrelloComment).not.toHaveBeenCalled();
  });
});
