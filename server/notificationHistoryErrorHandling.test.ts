import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));

import notificationHistoryRoutes from "./routes/notification-history";

describe("notification history failure responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not expose an internal database failure to an authenticated browser", async () => {
    mocks.getDb.mockResolvedValue({
      select: vi.fn(() => {
        throw new Error("ER_ACCESS_DENIED_ERROR: database password rejected");
      }),
    });

    const app = express();
    app.use((req, _res, next) => {
      (req as typeof req & { user?: unknown }).user = { id: 7, openId: "worker-7", role: "worker" };
      next();
    });
    app.use("/notifications", notificationHistoryRoutes);

    const response = await request(app).get("/notifications");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Unable to load notification history" });
    expect(response.text).not.toContain("ER_ACCESS_DENIED_ERROR");
  });
});
