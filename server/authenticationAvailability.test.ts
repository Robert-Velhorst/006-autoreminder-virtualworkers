import express from "express";
import { rateLimit } from "express-rate-limit";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import bcrypt from "bcryptjs";
import { ForbiddenError } from "../shared/_core/errors";
import { DatabaseUnavailableError, isDatabaseUnavailable } from "./databaseAvailability";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), getUser: vi.fn(), upsert: vi.fn(), getDb: vi.fn(), createToken: vi.fn() }));
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticate, createSessionToken: mocks.createToken } }));
vi.mock("./db", () => ({ getUserByOpenId: mocks.getUser, upsertUser: mocks.upsert, getDb: mocks.getDb }));
import { attachRequestAuthentication } from "./_core/requestAuthentication";
import { createContext } from "./_core/context";
import localAuthRoutes from "./routes/local-auth";

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const unavailable = () => Object.assign(new Error("private-driver-query"), { cause: Object.assign(new Error("private-db-password"), { code: "ECONNREFUSED" }) });

async function serve(run: (base: string, action: ReturnType<typeof vi.fn>) => Promise<void>) {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 1000, legacyHeaders: false }));
  const action = vi.fn();
  app.use(express.json());
  app.use("/api", attachRequestAuthentication);
  app.use("/api/auth", localAuthRoutes);
  app.post("/api/write", (_req, res) => { action(); res.json({ success: true }); });
  const t = initTRPC.context<Awaited<ReturnType<typeof createContext>>>().create({ transformer: superjson });
  app.use("/api/trpc", createExpressMiddleware({
    router: t.router({ "auth.me": t.procedure.query(({ ctx }) => ctx.user) }), createContext,
  }));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try { await run(`http://127.0.0.1:${port}`, action); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("database availability classification", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "PROTOCOL_CONNECTION_LOST", "ER_SERVER_SHUTDOWN", "ER_ACCESS_DENIED_ERROR"])("recognizes wrapped driver code %s", code => {
    expect(isDatabaseUnavailable({ cause: { cause: { code } } })).toBe(true);
  });
  it("handles explicit pool unavailability, cycles and unrelated query failures", () => {
    expect(isDatabaseUnavailable(new DatabaseUnavailableError())).toBe(true);
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
    for (const error of [cyclic, null, "ECONNREFUSED", new Error("ECONNREFUSED"), { code: "ER_PARSE_ERROR" }, { code: "ER_DUP_ENTRY" }, { code: "ER_LOCK_DEADLOCK" }]) {
      expect(isDatabaseUnavailable(error)).toBe(false);
    }
  });
});

describe("authentication during infrastructure outages", () => {
  it.each([unavailable(), new Error("unexpected-private-authentication-failure")])("does not turn an operational auth failure into a successful null session", async error => {
    mocks.authenticate.mockRejectedValue(error);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await serve(async base => {
      for (const path of ["/api/trpc/auth.me", "/api/trpc/auth.me?batch=1"]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(503);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("retry-after")).toBe("5");
        const body = await response.text();
        expect(body).toContain("SERVICE_UNAVAILABLE");
        expect(body).not.toMatch(/private|SELECT|passwordHash/);
      }
    });
  });
  it("does not execute writes or change cookies when verification is unavailable", async () => {
    mocks.authenticate.mockRejectedValue(unavailable());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await serve(async (base, action) => {
      const response = await fetch(base + "/api/write", { method: "POST" });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(action).not.toHaveBeenCalled();
    });
  });
  it("keeps an actually invalid session unauthenticated without pretending there is an outage", async () => {
    mocks.authenticate.mockRejectedValue(ForbiddenError("Invalid session cookie"));
    await serve(async base => {
      const response = await fetch(base + "/api/trpc/auth.me");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(superjson.deserialize(body.result.data)).toBeNull();
      expect(response.headers.get("retry-after")).toBeNull();
    });
  });
  it("reports database errors during password lookup without signing in or exposing driver data", async () => {
    mocks.authenticate.mockRejectedValue(ForbiddenError("Invalid session cookie"));
    mocks.getUser.mockRejectedValue(unavailable());
    await serve(async base => {
      const response = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "fixture", password: "fixture-password-only" }) });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.text()).not.toMatch(/private|fixture-password|passwordHash/);
      expect(mocks.createToken).not.toHaveBeenCalled();
    });
  });
  it("keeps incorrect credentials a 401 when the database responds normally", async () => {
    mocks.authenticate.mockRejectedValue(ForbiddenError("Invalid session cookie"));
    mocks.getUser.mockResolvedValue(undefined);
    await serve(async base => {
      const response = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "fixture", password: "fixture-password-only" }) });
      expect(response.status).toBe(401);
      expect(mocks.createToken).not.toHaveBeenCalled();
    });
  });
  it("does not issue a session when the database fails after correct password verification", async () => {
    mocks.authenticate.mockRejectedValue(ForbiddenError("Invalid session cookie"));
    mocks.getUser.mockResolvedValue({ id: 7, sessionEpoch: "1", openId: "fixture", name: "Fixture", passwordHash: bcrypt.hashSync("fixture-password-only", 4) });
    mocks.upsert.mockRejectedValue(unavailable());
    await serve(async base => {
      const response = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "fixture", password: "fixture-password-only" }) });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(mocks.createToken).not.toHaveBeenCalled();
    });
  });
  it("fails closed in standalone tRPC context creation too", async () => {
    mocks.authenticate.mockRejectedValue(unavailable());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = { setHeader: vi.fn() };
    await expect(createContext({ req: {} as any, res: res as any, info: {} as any })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "5");
  });
});
