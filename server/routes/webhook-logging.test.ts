import { createHmac } from "node:crypto";
import { format } from "node:util";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), fetch: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocks.getDb }));
import bulkRoutes from "./trello-webhook-bulk";
import callbackRoutes from "./trello-webhook";

const callbackUrl = "https://dashboard.example/api/trello-webhook";
const privateDetail = "synthetic-private-query\r\nforged\x1b[2J";
const invalidIds = ["bad\r\nforged", "bad\x1b[2J", "bad\u2028forged", "bad\u2029forged"];

function app(role?: "admin" | "worker") {
  const instance = express().use(express.json({ verify: (req, _res, buffer) => {
    (req as typeof req & { rawBody: Buffer }).rawBody = Buffer.from(buffer);
  } }));
  if (role) instance.use((req, _res, next) => { (req as any).user = { id: 1, role }; next(); });
  return instance.use("/api/trello-webhook/bulk", bulkRoutes).use("/api/trello-webhook", callbackRoutes);
}

function expectFixedLogs() {
  const calls = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls];
  expect(calls.length).toBeGreaterThan(0);
  for (const args of calls) {
    expect(args).toHaveLength(1);
    expect(typeof args[0]).toBe("string");
    expect(format(...args)).not.toMatch(/[\r\n\x1b\u2028\u2029]/);
    expect(format(...args)).not.toContain("synthetic-private-query");
    expect(format(...args)).not.toContain("forged");
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getDb.mockResolvedValue(null);
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("TRELLO_API_KEY", "synthetic-key");
  vi.stubEnv("TRELLO_TOKEN", "synthetic-token");
  vi.stubEnv("TRELLO_WEBHOOK_SECRET", "synthetic-signing-secret");
  vi.stubEnv("TRELLO_WEBHOOK_CALLBACK_URL", callbackUrl);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("bulk webhook log boundary", () => {
  it.each(invalidIds)("keeps rejected ID %j out of logs without contacting Trello", async boardId => {
    const response = await request(app("admin")).post("/api/trello-webhook/bulk").send({ boardIds: [boardId] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: false,
      results: [{ boardId, success: false, error: "Trello webhook registration failed" }],
      summary: { total: 1, successful: 0, failed: 1 },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[TrelloWebhookBulk] Registration failed");
    expectFixedLogs();
  });

  it("keeps provider exceptions private while preserving partial success and persistence", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue({ query: { chatbotWebhooks: { findMany: vi.fn().mockResolvedValue([]) } },
      insert: () => ({ values }),
    });
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "hook-success" }) })
      .mockRejectedValueOnce(new Error(privateDetail));
    const response = await request(app("admin")).post("/api/trello-webhook/bulk").send({ boardIds: ["abcdefgh", "ijklmnop"] });
    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ total: 2, successful: 1, failed: 1 });
    expect(response.body.results).toEqual([
      { boardId: "abcdefgh", success: true, webhookId: "hook-success" },
      { boardId: "ijklmnop", success: false, error: "Trello webhook registration failed" },
    ]);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ modelId: "abcdefgh", trelloWebhookId: "hook-success", callbackUrl }));
    const [, options] = mocks.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ callbackURL: callbackUrl, idModel: "abcdefgh", description: "VA Dashboard Chatbot" });
    expectFixedLogs();
  });

  it("keeps insert exception parameters out of logs without changing the registration result", async () => {
    mocks.getDb.mockResolvedValue({ query: { chatbotWebhooks: { findMany: vi.fn().mockResolvedValue([]) } },
      insert: () => ({ values: vi.fn().mockRejectedValue(new Error(privateDetail)) }),
    });
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: "hook-success" }) });
    const response = await request(app("admin")).post("/api/trello-webhook/bulk").send({ boardIds: ["abcdefgh"] });
    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ total: 1, successful: 1, failed: 0 });
    expect(console.error).toHaveBeenCalledWith("[TrelloWebhookBulk] DB insert error");
    expectFixedLogs();
  });

  it("keeps initial storage failures private and preserves the outer error response", async () => {
    mocks.getDb.mockRejectedValue(new Error(privateDetail));
    const response = await request(app("admin")).post("/api/trello-webhook/bulk").send({ boardIds: ["abcdefgh"] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Failed to process bulk registration" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[TrelloWebhookBulk] Error");
    expectFixedLogs();
  });

  it("preserves existing-registration skip and provider already-exists handling", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue({ query: { chatbotWebhooks: { findMany: vi.fn().mockResolvedValue([{ modelId: "abcdefgh" }]) } },
      insert: () => ({ values }),
    });
    mocks.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => "webhook already exists" });
    const response = await request(app("admin")).post("/api/trello-webhook/bulk").send({ boardIds: ["abcdefgh", "ijklmnop"] });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      { boardId: "abcdefgh", success: true, webhookId: "already-registered" },
      { boardId: "ijklmnop", success: true, webhookId: "pre-existing" },
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ modelId: "ijklmnop" }));
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([undefined, "worker"] as const)("keeps bulk authorization for %s", async role => {
    const response = await request(app(role)).post("/api/trello-webhook/bulk").send({ boardIds: invalidIds });
    expect(response.status).toBe(role ? 403 : 401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

function signedDelivery(type: string, signed = true) {
  const body = JSON.stringify({ action: { id: "synthetic-action", type, data: { board: { id: "abcdefgh" } } }, model: { id: "abcdefgh" } });
  const signature = createHmac("sha1", "synthetic-signing-secret").update(body + callbackUrl).digest("base64");
  return request(app()).post("/api/trello-webhook").set("content-type", "application/json")
    .set("x-trello-webhook", signed ? signature : "invalid-signature").send(body);
}

describe("signed callback log boundary", () => {
  it.each(["updateCard", "unfamiliarType", ...invalidIds])("archives action type %j unchanged without logging it", async type => {
    const values = vi.fn().mockResolvedValue(undefined);
    mocks.getDb.mockResolvedValue({ transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      let statement = 0;
      return run({ execute: async () => ({ rows: ++statement <= 2 ? [{ id: 1 }] : [] }), insert: () => ({ values }) });
    } });
    const response = await signedDelivery(type);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ command: type }));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[TrelloWebhook] Received callback");
    expectFixedLogs();
  });

  it("does not log unverified delivery details or access storage", async () => {
    const response = await signedDelivery(invalidIds[0], false);
    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps callback storage exception details out of logs", async () => {
    mocks.getDb.mockRejectedValue(new Error(privateDetail));
    const response = await signedDelivery("updateCard");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Trello webhook processing failed" });
    expect(console.error).toHaveBeenCalledWith("[TrelloWebhook] Error processing callback");
    expectFixedLogs();
  });

  it.each(["transaction", "insert"])("keeps a %s rejection private for an oversized action type", async failure => {
    const type = "synthetic-private-query".repeat(8) + "\r\nforged";
    const values = vi.fn().mockRejectedValue(new Error(type));
    mocks.getDb.mockResolvedValue({ transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      if (failure === "transaction") throw new Error(type);
      let statement = 0;
      return run({ execute: async () => ({ rows: ++statement <= 2 ? [{ id: 1 }] : [] }), insert: () => ({ values }) });
    } });
    const response = await signedDelivery(type);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Trello webhook processing failed" });
    if (failure === "insert") expect(values).toHaveBeenCalledWith(expect.objectContaining({ command: type }));
    expectFixedLogs();
  });
});
