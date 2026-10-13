import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserTasks } = vi.hoisted(() => ({
  getUserTasks: vi.fn(),
}));

vi.mock("./db/scheduling", () => ({ getUserTasks }));

import batchOperationsRoutes from "./routes/batch-operations";

function appForWorker() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { user?: unknown }).user = {
      id: 42,
      openId: "worker-42",
      role: "worker",
    };
    next();
  });
  app.use("/batch-operations", batchOperationsRoutes);
  return app;
}

describe("batch operation route task ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an unassigned re-analysis before it creates a background job", async () => {
    getUserTasks.mockResolvedValue([{ taskId: "owned-card" }]);

    const response = await request(appForWorker())
      .post("/batch-operations/start")
      .send({ operationType: "re_analyze", taskIds: ["other-card"] })
      .expect(403);

    expect(response.body).toEqual({ error: "Every batch task must be assigned to your account" });
  });
});
