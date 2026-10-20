import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn(), active: vi.fn(), card: vi.fn(), batch: vi.fn(), db: vi.fn(), fetch: vi.fn() }));
vi.mock("./atisOperations", async original => ({ ...await original<typeof import("./atisOperations")>(),
  startAtisOperation: mocks.start, getAtisOperation: mocks.get, getActiveAtisOperations: mocks.active,
}));
vi.mock("./db", () => ({ getDb: mocks.db }));
vi.mock("./services/atis-understanding", () => ({ processCardUnderstanding: mocks.card,
  processAllCardsUnderstanding: mocks.batch, getUnderstandingStats: vi.fn() }));
vi.mock("./utils/retry", () => ({ fetchWithRetry: mocks.fetch }));
vi.mock("./middleware/rate-limiter", () => ({ atisRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next() }));
import router from "./routes/atis";
import { AtisOperationRecoveryRequired, AtisOperationRequestConflict } from "./atisOperations";
import { ScheduledJobLeaseLostError } from "./scheduledJobRuntime";

const operation = { id: 12, kind: "understanding" as const, state: "running" as const };
function app(role?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (role) Object.assign(req, { user: { id: 2, role } }); next(); });
  app.use("/api/atis", router);
  return app;
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("TRELLO_API_KEY", "test-key"); vi.stubEnv("TRELLO_TOKEN", "test-token"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("ATIS start/poll HTTP contract", () => {
  it.each([undefined, "worker"])("keeps starts and status reads behind admin authentication (%s)", async role => {
    for (const path of ["/operations/active", "/operations/12"]) {
      expect((await request(app(role)).get(`/api/atis${path}`)).status).toBe(role ? 403 : 401);
    }
    expect((await request(app(role)).post("/api/atis/understanding/process").send({ cardId: 2 })).status).toBe(role ? 403 : 401);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled();
  });
  it.each([-1, 0, 1.5, "2", null])("rejects cardId %s before durable start", async cardId => {
    await request(app("admin")).post("/api/atis/understanding/process").send({ cardId }).expect(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("responds with durable operation identity without awaiting provider completion", async () => {
    mocks.start.mockResolvedValue(operation);
    const response = await request(app("admin")).post("/api/atis/understanding/process").send({ cardId: 3 });
    expect(response.status).toBe(202); expect(response.body).toEqual({ operation });
    expect(mocks.start.mock.calls[0][0]).toMatchObject({ kind: "understanding", ownerUserId: 2, request: { cardId: 3 } });
    expect(mocks.card).not.toHaveBeenCalled();
    const context = { signal: new AbortController().signal, assertOwnership: vi.fn(), runId: 12 };
    mocks.card.mockResolvedValue({ goal: "private" });
    expect(await mocks.start.mock.calls[0][1](context)).toEqual({ success: true, cardId: 3 });
    expect(mocks.card).toHaveBeenCalledWith(3, context);
  });
  it("passes scheduled context to batch processing and preserves count result", async () => {
    mocks.start.mockResolvedValue(operation);
    await request(app("admin")).post("/api/atis/understanding/process").send({ limit: 50 }).expect(202);
    mocks.batch.mockResolvedValue({ processed: 4, failed: 1 });
    const context = { signal: new AbortController().signal, assertOwnership: vi.fn() };
    expect(await mocks.start.mock.calls[0][1](context)).toEqual({ success: true, processed: 4, failed: 1 });
    expect(mocks.batch).toHaveBeenCalledWith(undefined, 50, context);
  });
  it.each(["recovery", "different request"])("returns an explicit not-started 409 for %s", async reason => {
    const op = { ...operation, state: reason === "recovery" ? "interrupted" as const : "running" as const };
    mocks.start.mockRejectedValue(reason === "recovery" ? new AtisOperationRecoveryRequired(op) : new AtisOperationRequestConflict(op));
    const response = await request(app("admin")).post("/api/atis/understanding/process").send({ cardId: 3, acknowledgeInterruptedOperationId: 12 });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ operation: op, requestedNotStarted: true });
    expect(mocks.start.mock.calls[0][0].acknowledgeInterruptedOperationId).toBe(12);
  });
  it("polling includes interruption, never starts work, and status failure is only HTTP 503", async () => {
    mocks.active.mockResolvedValue([{ ...operation, state: "interrupted" }]);
    const response = await request(app("admin")).get("/api/atis/operations/active").expect(200);
    expect(response.body.operations[0].state).toBe("interrupted");
    mocks.get.mockRejectedValue(new Error("private DB host"));
    const failed = await request(app("admin")).get("/api/atis/operations/12").expect(503);
    expect(failed.body.operation).toBeUndefined(); expect(JSON.stringify(failed.body)).not.toContain("private");
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.card).not.toHaveBeenCalled();
  });
  it("sync refuses any provider call after lease loss", async () => {
    mocks.start.mockResolvedValue({ ...operation, kind: "sync" });
    mocks.db.mockResolvedValue({ transaction: vi.fn() });
    await request(app("admin")).post("/api/atis/sync").send({}).expect(202);
    const context = { signal: new AbortController().signal, assertOwnership: vi.fn().mockRejectedValue(new ScheduledJobLeaseLostError()) };
    await expect(mocks.start.mock.calls[0][1](context)).rejects.toThrow(ScheduledJobLeaseLostError);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
