import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), invoke: vi.fn(), text: vi.fn(), db: vi.fn() }));
vi.mock("../_core/llm", () => ({ getLLMModelStatus: mocks.status, invokeLLM: mocks.invoke, getLLMText: mocks.text }));
vi.mock("../db", () => ({ getDb: mocks.db }));
vi.mock("../services/trello-chatbot", () => ({ isTrelloCommentAutomationEnabled: vi.fn(), postTrelloComment: vi.fn(), sendScheduledCheckin: vi.fn(), TRELLO_COMMENT_AUTOMATION_DISABLED_MESSAGE: "Disabled" }));
import routes from "./trello-webhook";
const configuration = { provider: "codex-subscription", configured: true, model: "gpt-5.6-luna", managedBy: "local-bridge" };
function app(role?: "admin" | "worker") {
  const instance = express(); instance.use(express.json());
  if (role) instance.use((req, _res, next) => { (req as any).user = { id: 1, role }; next(); });
  instance.use("/api/trello-webhook", routes); instance.use("/api/chatbot", routes);
  return instance;
}
beforeEach(() => { vi.clearAllMocks(); mocks.status.mockResolvedValue(configuration); mocks.invoke.mockResolvedValue({ model: configuration.model }); mocks.text.mockReturnValue("Connection successful"); });
afterEach(() => vi.restoreAllMocks());
describe("admin subscription status HTTP compatibility", () => {
  it.each(["/api/trello-webhook", "/api/chatbot"])("denies anonymous and worker reads/tests/writes before any provider or DB work at %s", async prefix => {
    for (const [role, expected] of [[undefined, 401], ["worker", 403]] as const) {
      expect((await request(app(role)).get(`${prefix}/ai-settings`)).status).toBe(expected);
      expect((await request(app(role)).post(`${prefix}/test-ai`)).status).toBe(expected);
      expect((await request(app(role)).post(`${prefix}/ai-settings`).send({ apiKey: "synthetic-must-not-be-stored" })).status).toBe(expected);
    }
    expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });
  it("returns queue-only configuration without fabricating available or invoking inference", async () => {
    const response = await request(app("admin")).get("/api/trello-webhook/ai-settings");
    expect(response.status).toBe(200); expect(response.body).toEqual({ success: true, config: configuration });
    expect(response.body.config).not.toHaveProperty("available"); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
  });
  it("preserves offline bridge status separately from queue configuration", async () => {
    mocks.status.mockResolvedValue({ ...configuration, available: false });
    const response = await request(app("admin")).get("/api/chatbot/ai-settings");
    expect(response.body.config).toMatchObject({ configured: true, available: false });
    const check = await request(app("admin")).post("/api/chatbot/test-ai");
    expect(check.status).toBe(503); expect(check.body).toMatchObject({ success: false, provider: "codex-subscription" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("keeps writes disabled without storing or echoing credential input", async () => {
    const response = await request(app("admin")).post("/api/trello-webhook/ai-settings").send({ provider: "openai", apiKey: "synthetic-private-input" });
    expect(response.status).toBe(410); expect(response.body.error).toContain("fixed Codex subscription policy");
    expect(JSON.stringify(response.body)).not.toContain("synthetic-private-input"); expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("adapts explicit mocked inference success and sanitizes provider errors", async () => {
    const success = await request(app("admin")).post("/api/trello-webhook/test-ai");
    expect(success.status).toBe(200); expect(success.body).toMatchObject({ provider: "codex-subscription", model: configuration.model });
    mocks.invoke.mockRejectedValue(new Error("PRIVATE_PROVIDER_TOKEN_OR_PROMPT"));
    const failure = await request(app("admin")).post("/api/trello-webhook/test-ai");
    expect(failure.status).toBe(502); expect(failure.body).toEqual({ success: false, error: "Could not test the Codex subscription connection" });
    expect(JSON.stringify(failure.body)).not.toContain("PRIVATE_PROVIDER_TOKEN_OR_PROMPT"); expect(mocks.db).not.toHaveBeenCalled();
  });
  it("does not expose raw configuration errors", async () => {
    mocks.status.mockRejectedValue(new Error("PRIVATE_QUEUE_OR_AUTH_PATH"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request(app("admin")).get("/api/trello-webhook/ai-settings");
    expect(response.status).toBe(500); expect(response.body).toEqual({ error: "Could not load Codex subscription status" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_QUEUE_OR_AUTH_PATH");
  });
});
