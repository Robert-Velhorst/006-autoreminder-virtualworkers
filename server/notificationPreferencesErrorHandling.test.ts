import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));

import notificationPreferenceRoutes from "./routes/notification-preferences";

describe("notification preference failure responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not return an internal database error to an authenticated worker", async () => {
    mocks.getDb.mockResolvedValue({
      select: vi.fn(() => {
        throw new Error("ER_BAD_DB_ERROR: production schema is unavailable");
      }),
    });

    const app = express();
    app.use((req, _res, next) => {
      (req as typeof req & { user?: unknown }).user = { id: 7, openId: "worker-7", role: "worker" };
      next();
    });
    app.use("/notification-preferences", notificationPreferenceRoutes);

    const response = await request(app).get("/notification-preferences");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Unable to load notification preferences" });
    expect(response.text).not.toContain("ER_BAD_DB_ERROR");
  });
});
