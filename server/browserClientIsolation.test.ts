import express from "express";
import { rateLimit } from "express-rate-limit";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { isolatedBrowserClientAddress } from "../e2e/isolated-browser-client";

describe("isolated acceptance browser clients", () => {
  it("keeps rate limits effective without consuming another scenario's budget", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(rateLimit({ windowMs: 60_000, limit: 2 }));
    app.get("/probe", (_req, res) => res.sendStatus(200));
    const first = isolatedBrowserClientAddress(0, 1);
    const next = isolatedBrowserClientAddress(0, 2);
    const restartedWorker = isolatedBrowserClientAddress(1, 1);
    for (let index = 0; index < 2; index++) {
      expect((await request(app).get("/probe").set("X-Forwarded-For", first)).status).toBe(200);
    }
    expect((await request(app).get("/probe").set("X-Forwarded-For", first)).status).toBe(429);
    expect((await request(app).get("/probe").set("X-Forwarded-For", next)).status).toBe(200);
    expect((await request(app).get("/probe").set("X-Forwarded-For", restartedWorker)).status).toBe(200);
  });

  it.each([[-1, 1], [128, 1], [0, 0], [0, 1024], [0.5, 1]])("rejects an ambiguous client identity %s/%s", (worker, sequence) => {
    expect(() => isolatedBrowserClientAddress(worker, sequence)).toThrow(/fixture range/);
  });
});
