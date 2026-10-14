import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDatabaseReachable } from "../db";
import { isRedisAvailable } from "../services/redis";
import healthRoutes from "./health";

vi.mock("../db", () => ({ isDatabaseReachable: vi.fn() }));
vi.mock("../services/redis", () => ({ isRedisAvailable: vi.fn() }));

const app = express().use("/api/health", healthRoutes);

describe("health routes", () => {
  beforeEach(() => {
    vi.mocked(isDatabaseReachable).mockReset();
    vi.mocked(isRedisAvailable).mockReturnValue(false);
  });

  it("reports unhealthy and not ready when PostgreSQL cannot answer", async () => {
    vi.mocked(isDatabaseReachable).mockResolvedValue(false);

    const health = await request(app).get("/api/health/");
    const ready = await request(app).get("/api/health/ready");

    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({
      status: "unhealthy",
      database: "disconnected",
    });
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({
      ready: false,
      reason: "Database not available",
    });
  });

  it("reports healthy only after PostgreSQL responds", async () => {
    vi.mocked(isDatabaseReachable).mockResolvedValue(true);

    const health = await request(app).get("/api/health/");
    const ready = await request(app).get("/api/health/ready");

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: "healthy",
      database: "connected",
    });
    expect(ready.status).toBe(200);
    expect(ready.body.ready).toBe(true);
  });

  it("keeps liveness independent of PostgreSQL", async () => {
    vi.mocked(isDatabaseReachable).mockResolvedValue(false);

    const live = await request(app).get("/api/health/live");

    expect(live.status).toBe(200);
    expect(live.body.alive).toBe(true);
    expect(isDatabaseReachable).not.toHaveBeenCalled();
  });

  it("does not expose internal dependency errors in public probe responses", async () => {
    vi.mocked(isDatabaseReachable).mockRejectedValue(
      new Error("postgres://user:password@internal-db:5432/app")
    );

    const health = await request(app).get("/api/health/");
    const ready = await request(app).get("/api/health/ready");

    expect(health.status).toBe(503);
    expect(health.body.error).toBe("Health check failed");
    expect(ready.status).toBe(503);
    expect(ready.body.reason).toBe("Readiness check failed");
    expect(JSON.stringify([health.body, ready.body])).not.toContain("password");
    expect(JSON.stringify([health.body, ready.body])).not.toContain("internal-db");
  });
});
