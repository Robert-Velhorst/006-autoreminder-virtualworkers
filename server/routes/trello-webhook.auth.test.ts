import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import trelloWebhookRoutes from "./trello-webhook";
import trelloWebhookBulkRoutes from "./trello-webhook-bulk";

function createApp(role?: "admin" | "worker") {
  const app = express();
  app.use(express.json());
  if (role) {
    app.use((req, _res, next) => {
      (req as any).user = { id: 1, role };
      next();
    });
  }
  app.use("/api/trello-webhook/bulk", trelloWebhookBulkRoutes);
  app.use("/api/trello-webhook", trelloWebhookRoutes);
  app.use("/api/chatbot", trelloWebhookRoutes);
  return app;
}

describe("AI settings authorization", () => {
  it("rejects unauthenticated reads and writes on both route aliases", async () => {
    const app = createApp();
    const paths = ["/api/trello-webhook/ai-settings", "/api/chatbot/ai-settings"];

    for (const path of paths) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).post(path).send({ provider: "ollama" })).status).toBe(401);
    }
  });

  it("rejects worker access before reading global settings", async () => {
    const response = await request(createApp("worker")).get("/api/trello-webhook/ai-settings");
    expect(response.status).toBe(403);
  });

  it("keeps the webhook health probe public but requires admin for registration", async () => {
    const app = createApp("worker");
    expect((await request(app).get("/api/trello-webhook/")).status).toBe(200);
    expect((await request(app).post("/api/trello-webhook/register").send({
      modelId: "12345678",
    })).status).toBe(403);
  });

  it("limits repeated Trello webhook registration attempts", async () => {
    const configKeys = [
      "TRELLO_API_KEY",
      "TRELLO_TOKEN",
      "TRELLO_WEBHOOK_CALLBACK_URL",
      "TRELLO_WEBHOOK_SECRET",
    ] as const;
    const previous = Object.fromEntries(configKeys.map(key => [key, process.env[key]]));
    const app = createApp("admin");
    for (const key of configKeys) delete process.env[key];

    try {
      const responses = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        responses.push(await request(app).post("/api/trello-webhook/register").send({
          modelId: "12345678",
        }));
      }

      expect(responses.slice(0, 10).every(response => response.status === 500)).toBe(true);
      expect(responses[10].status).toBe(429);
      expect(responses[10].body.error).toContain("Too many webhook registration attempts");
    } finally {
      for (const key of configKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it("rejects unsigned Trello callbacks before attempting persistence", async () => {
    const previousUrl = process.env.TRELLO_WEBHOOK_CALLBACK_URL;
    const previousSecret = process.env.TRELLO_WEBHOOK_SECRET;
    process.env.TRELLO_WEBHOOK_CALLBACK_URL = "https://va.example.com/api/trello-webhook";
    process.env.TRELLO_WEBHOOK_SECRET = "test-secret";
    try {
      const response = await request(createApp())
        .post("/api/trello-webhook")
        .send({ type: "updateCard", data: { card: { id: "card-1" } } });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Invalid Trello webhook signature");
    } finally {
      if (previousUrl === undefined) delete process.env.TRELLO_WEBHOOK_CALLBACK_URL;
      else process.env.TRELLO_WEBHOOK_CALLBACK_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.TRELLO_WEBHOOK_SECRET;
      else process.env.TRELLO_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("reports webhook configuration without requesting the configured callback URL", async () => {
    const keys = [
      "TRELLO_API_KEY",
      "TRELLO_TOKEN",
      "TRELLO_WEBHOOK_CALLBACK_URL",
      "TRELLO_WEBHOOK_SECRET",
    ] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.TRELLO_API_KEY = "test-key";
    process.env.TRELLO_TOKEN = "test-token";
    process.env.TRELLO_WEBHOOK_CALLBACK_URL = "https://va.example.com/api/trello-webhook";
    process.env.TRELLO_WEBHOOK_SECRET = "test-secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const response = await request(createApp("admin")).get("/api/trello-webhook/status");

      expect(response.status).toBe(200);
      expect(response.body.status.isConfigured).toBe(true);
      expect(response.body.status.isReachable).toBeNull();
      expect(response.body.status.recommendation).toContain("Live delivery has not been tested");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("restricts bulk webhook registration to admins", async () => {
    expect((await request(createApp()).post("/api/trello-webhook/bulk").send({ boardIds: ["12345678"] })).status).toBe(401);
    expect((await request(createApp("worker")).post("/api/trello-webhook/bulk").send({ boardIds: ["12345678"] })).status).toBe(403);
  });
});
