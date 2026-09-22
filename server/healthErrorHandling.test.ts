import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  isRedisAvailable: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./services/redis", () => ({ isRedisAvailable: mocks.isRedisAvailable }));

import healthRoutes from "./routes/health";

describe("public health failure responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRedisAvailable.mockReturnValue(true);
  });

  it("does not reveal a database connection error through health probes", async () => {
    const internalError = new Error("ER_ACCESS_DENIED_ERROR: mysql://admin:secret@db/dashboard");
    mocks.getDb.mockRejectedValue(internalError);

    const app = express();
    app.use("/health", healthRoutes);

    const [health, ready] = await Promise.all([
      request(app).get("/health"),
      request(app).get("/health/ready"),
    ]);

    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ status: "unhealthy", error: "Health check failed" });
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ ready: false, reason: "Readiness check failed" });
    expect(JSON.stringify([health.body, ready.body])).not.toContain("ER_ACCESS_DENIED_ERROR");
  });
});
