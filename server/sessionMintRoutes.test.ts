import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { users, vaProfiles } from "../drizzle/schema.postgres";

const controls = vi.hoisted(() => ({ account: {} as any, profiles: [] as any[], getDb: vi.fn(), onUserRead: vi.fn(), onProfileRead: vi.fn() }));
vi.mock("./db", () => ({
  getDb: controls.getDb,
  getUserByOpenId: async () => ({ ...controls.account }),
  upsertUser: async () => undefined,
  isSessionRevoked: async () => false,
}));
vi.mock("./_core/env", () => ({ ENV: { cookieSecret: "x".repeat(48), oAuthServerUrl: "", appId: "" } }));
import routes from "./routes/local-auth";
import { sdk } from "./_core/sdk";

beforeEach(() => {
  vi.stubEnv("LOCAL_AUTH_BYPASS", "false");
  vi.stubEnv("SESSION_APP_ID", "va-dashboard");
  controls.account = { id: 7, openId: "worker", name: "Worker", role: "worker", passwordHash: "synthetic-hash", sessionEpoch: "1" };
  controls.profiles = [{ id: 21, userId: 7, trelloMemberId: "member", status: "active" }];
  controls.onUserRead.mockReset(); controls.onProfileRead.mockReset();
  const tx = { select: () => {
    let source: unknown;
    const query: any = { from: (table: unknown) => { source = table; return query; }, where: () => query,
      limit: () => query, orderBy: () => query, for: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve().then(() => {
        if (source === users) { controls.onUserRead(); return [{ ...controls.account }]; }
        if (source === vaProfiles) { controls.onProfileRead(); return controls.profiles.map(row => ({ ...row })); }
        return [];
      }).then(resolve) };
    return query;
  } };
  controls.getDb.mockResolvedValue({ select: tx.select, transaction: async (run: (tx: unknown) => unknown) => run(tx) });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const app = express().use(express.json()).use("/api/auth", routes);

describe("password login identity fencing", () => {
  it.each(["password rotation", "delete/recreate", "offboarding"])(
    "does not mint a new session from an old password verification after %s", async transition => {
      let entered!: () => void;
      let release!: () => void;
      const comparing = new Promise<void>(resolve => { entered = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(bcrypt, "compare").mockImplementation((async () => { entered(); await resume; return true; }) as any);
      const response = request(app).post("/api/auth/login").send({ username: "worker", password: "synthetic-long-password" }).then(value => value);
      await comparing;
      if (transition === "delete/recreate") controls.account.id = 8;
      else controls.account.sessionEpoch = "2";
      if (transition === "offboarding") controls.profiles[0].status = "inactive";
      release();
      const denied = await response;
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: 'Account access changed. Sign in again or contact your manager.' });
      expect(denied.headers["set-cookie"]).toBeUndefined();
    });
  it("mints a UID/epoch-bound cookie after an unchanged password verification", async () => {
    vi.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
    const response = await request(app).post("/api/auth/login").send({ username: "worker", password: "synthetic-long-password" });
    expect(response.status).toBe(200);
    const cookie = response.headers["set-cookie"][0].split(";")[0].split("=")[1];
    expect(await sdk.verifySession(decodeURIComponent(cookie))).toMatchObject({ userId: 7, sessionEpoch: "1" });
  });
});

describe("Trello login linkage fencing", () => {
  beforeEach(() => {
    vi.stubEnv("TRELLO_LOGIN_API_KEY", "synthetic-public-client-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "member", username: "worker", fullName: "Worker" }) }));
  });
  it("rechecks a stale profile match even if the subsequent account read sees a new epoch", async () => {
    controls.onUserRead.mockImplementationOnce(() => {
      controls.account.sessionEpoch = "2";
      controls.profiles = [];
    });
    const response = await request(app).post("/api/auth/trello/login-token").send({ token: "synthetic-token" });
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
  it("fences a later epoch change after fresh linkage was verified", async () => {
    controls.onProfileRead.mockImplementationOnce(() => {}).mockImplementationOnce(() => { controls.account.sessionEpoch = "2"; });
    const response = await request(app).post("/api/auth/trello/login-token").send({ token: "synthetic-token" });
    expect(response.status).not.toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
  it("preserves successful Trello login with fresh canonical linkage", async () => {
    const response = await request(app).post("/api/auth/trello/login-token").send({ token: "synthetic-token" });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toHaveLength(1);
  });
});
