import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

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
    expect(console.error).toHaveBeenCalledTimes(2);
    const logged = vi.mocked(console.error).mock.calls;
    expect(logged.flat()).not.toContain(internalError);
    expect(JSON.stringify(logged)).not.toContain("mysql://");
  });

  it("does not log driver messages or attached credentials when the readiness query fails", async () => {
    const internalError = Object.assign(
      new Error("mysql://admin:private-password@db/dashboard"),
      { sqlMessage: "private-query-data", token: "private-driver-token" }
    );
    mocks.getDb.mockResolvedValue({ execute: vi.fn().mockRejectedValue(internalError) });
    const app = express();
    app.use("/health", healthRoutes);

    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ ready: false, reason: "Readiness check failed" });
    const logged = vi.mocked(console.error).mock.calls;
    expect(logged).toHaveLength(1);
    expect(logged.flat()).not.toContain(internalError);
    for (const privateValue of ["private-password", "private-query-data", "private-driver-token"]) {
      expect(JSON.stringify(logged)).not.toContain(privateValue);
    }
  });
});
