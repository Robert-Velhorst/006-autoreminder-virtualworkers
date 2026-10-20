import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import handoffRoutes from "./routes/handoff";
import communicationRoutes from "./routes/communication";
import metricsRoutes from "./routes/metrics";
import notificationHistoryRoutes from "./routes/notification-history";
import { getRequestBodyLimit, securityHeaders } from "./middleware/security";

describe("HTTP security defaults", () => {
  it("uses a bounded request body by default and accepts an explicit override", () => {
    expect(getRequestBodyLimit({} as NodeJS.ProcessEnv)).toBe("2mb");
    expect(getRequestBodyLimit({ REQUEST_BODY_LIMIT: "4mb" } as NodeJS.ProcessEnv)).toBe("4mb");
    expect(getRequestBodyLimit({ REQUEST_BODY_LIMIT: "unbounded" } as NodeJS.ProcessEnv)).toBe("2mb");
  });

  it("sets baseline browser security headers", async () => {
    const app = express();
    app.use(securityHeaders);
    app.get("/", (_req, res) => res.json({ ok: true }));

    const response = await request(app).get("/").expect(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["permissions-policy"]).toContain("camera=()");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["origin-agent-cluster"]).toBe("?1");
    expect(response.headers["x-dns-prefetch-control"]).toBe("off");
  });

  it("does not disclose the Express implementation in production responses", () => {
    const serverEntry = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    expect(serverEntry).toContain('app.disable("x-powered-by");');
  });

  it("sets HSTS only when the request arrived over HTTPS", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use(securityHeaders);
    app.get("/", (_req, res) => res.json({ ok: true }));

    const insecure = await request(app).get("/").expect(200);
    expect(insecure.headers["strict-transport-security"]).toBeUndefined();

    const secure = await request(app).get("/").set("X-Forwarded-Proto", "https").expect(200);
    expect(secure.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("rejects unauthenticated legacy worker mutations", async () => {
    const app = express();
    app.use(express.json());
    app.use("/handoff", handoffRoutes);
    app.use("/communication", communicationRoutes);

    await request(app).post("/handoff/notes").send({ taskId: "card", workerId: 1, notes: "note" }).expect(401);
    await request(app).post("/communication/ask-founder").send({ taskId: "card", workerId: 1, question: "?" }).expect(401);
  });

  it("does not let root-mounted metrics routes intercept unrelated API paths", async () => {
    const app = express();
    app.use(metricsRoutes);
    app.get("/trpc/auth.me", (_req, res) => res.json({ reached: true }));

    await request(app).get("/trpc/auth.me").expect(200, { reached: true });
    await request(app).get("/metrics/performance").expect(401, { error: "Unauthorized" });
  });

  it("prevents workers from triggering the global digest delivery run", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 42, openId: "worker-42", role: "worker" };
      next();
    });
    app.use("/notifications", notificationHistoryRoutes);

    await request(app).post("/notifications/trigger-digest").expect(403);
  });
});
