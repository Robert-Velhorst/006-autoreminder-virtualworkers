import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  activeWorkerIds: new Set<number>(),
  requireActiveWorkerProfile: vi.fn(),
  clearGoogleMailDeliveryConnection: vi.fn(),
  clearGoogleRefreshToken: vi.fn(),
  consumeGoogleOAuthState: vi.fn(),
  getGoogleMailDeliveryStatus: vi.fn(),
  saveGoogleOAuthState: vi.fn(),
  saveGoogleMailDeliveryConnection: vi.fn(),
  saveGoogleRefreshToken: vi.fn(),
}));

vi.mock("./middleware/auth", () => ({
  requireActiveWorkerProfile: routeMocks.requireActiveWorkerProfile,
}));

vi.mock("./googleEvidence", () => ({
  clearGoogleMailDeliveryConnection: routeMocks.clearGoogleMailDeliveryConnection,
  clearGoogleRefreshToken: routeMocks.clearGoogleRefreshToken,
  consumeGoogleOAuthState: routeMocks.consumeGoogleOAuthState,
  getGoogleMailDeliveryStatus: routeMocks.getGoogleMailDeliveryStatus,
  saveGoogleOAuthState: routeMocks.saveGoogleOAuthState,
  saveGoogleMailDeliveryConnection: routeMocks.saveGoogleMailDeliveryConnection,
  saveGoogleRefreshToken: routeMocks.saveGoogleRefreshToken,
}));

import googleEvidenceRoutes from "./googleEvidenceRoutes";

type TestUser = { id: number; role: "worker" | "admin" };

const envBefore = {
  jwtSecret: process.env.JWT_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  publicUrl: process.env.PUBLIC_URL,
  nodeEnv: process.env.NODE_ENV,
};

function appAs(user: TestUser | null, trustProxy = false) {
  const app = express();
  app.set("trust proxy", trustProxy ? 1 : false);
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, { user });
    next();
  });
  app.use("/api/google-evidence", googleEvidenceRoutes);
  return app;
}

function oauthCookie(response: request.Response, name: string) {
  const cookies = response.headers["set-cookie"] as string[] | undefined;
  const cookie = cookies?.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Expected ${name} cookie`);
  return cookie.split(";", 1)[0];
}

function oauthState(response: request.Response) {
  const location = response.headers.location;
  if (!location) throw new Error("Expected an OAuth redirect");
  const state = new URL(location).searchParams.get("state");
  if (!state) throw new Error("Expected state in OAuth redirect");
  return state;
}

function mockTokenExchange(refreshToken = "mock-refresh-token") {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
    access_token: "mock-access-token",
    refresh_token: refreshToken,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  routeMocks.activeWorkerIds.clear();
  routeMocks.requireActiveWorkerProfile.mockImplementation((req: Request & { user?: TestUser | null }, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role === "worker" && !routeMocks.activeWorkerIds.has(req.user.id)) {
      return res.status(403).json({ error: "An active worker profile is required" });
    }
    next();
  });
  routeMocks.clearGoogleMailDeliveryConnection.mockReset().mockResolvedValue(undefined);
  routeMocks.clearGoogleRefreshToken.mockReset().mockResolvedValue(undefined);
  routeMocks.consumeGoogleOAuthState.mockReset().mockResolvedValue(true);
  routeMocks.getGoogleMailDeliveryStatus.mockReset().mockResolvedValue({ connected: false });
  routeMocks.saveGoogleOAuthState.mockReset().mockResolvedValue(undefined);
  routeMocks.saveGoogleMailDeliveryConnection.mockReset().mockResolvedValue(undefined);
  routeMocks.saveGoogleRefreshToken.mockReset().mockResolvedValue(undefined);
  process.env.JWT_SECRET = "test-google-evidence-secret-that-is-long-enough";
  process.env.GOOGLE_CLIENT_ID = "mock-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "mock-google-client-secret";
  process.env.PUBLIC_URL = "https://dashboard.example.test";
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  for (const [key, value] of Object.entries({
    JWT_SECRET: envBefore.jwtSecret,
    GOOGLE_CLIENT_ID: envBefore.googleClientId,
    GOOGLE_CLIENT_SECRET: envBefore.googleClientSecret,
    PUBLIC_URL: envBefore.publicUrl,
    NODE_ENV: envBefore.nodeEnv,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google evidence OAuth route security", () => {
  describe.each([
    { purpose: "worker evidence", user: { id: 17, role: "worker" as const },
      path: "/api/google-evidence/connect", cookieName: "google_evidence_oauth" },
    { purpose: "admin mail delivery", user: { id: 99, role: "admin" as const },
      path: "/api/google-evidence/mail-delivery/connect", cookieName: "google_mail_delivery_oauth" },
  ])("$purpose OAuth cookie headers", ({ user, path, cookieName }) => {
    it.each([
      { scenario: "production behind a trusted HTTPS proxy", nodeEnv: "production", trustProxy: true, forwardedProto: "https", secure: true },
      { scenario: "production even when the request appears to be HTTP", nodeEnv: "production", trustProxy: false, forwardedProto: "http", secure: true },
      { scenario: "local development over HTTP", nodeEnv: "development", trustProxy: false, forwardedProto: "http", secure: false },
      { scenario: "development behind a trusted HTTPS proxy", nodeEnv: "development", trustProxy: true, forwardedProto: "https", secure: true },
      { scenario: "development ignoring an untrusted HTTPS forwarding header", nodeEnv: "development", trustProxy: false, forwardedProto: "https", secure: false },
    ])("preserves HttpOnly and protocol policy in $scenario", async ({ nodeEnv, trustProxy, forwardedProto, secure }) => {
      process.env.NODE_ENV = nodeEnv;
      if (user.role === "worker") routeMocks.activeWorkerIds.add(user.id);
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      const response = await request(appAs(user, trustProxy)).get(path).set("X-Forwarded-Proto", forwardedProto);
      expect(response.status).toBe(302);
      const cookies = response.headers["set-cookie"] as string[];
      expect(cookies).toHaveLength(1);
      const cookie = cookies[0];
      expect(cookie.startsWith(`${cookieName}=`)).toBe(true);
      expect(cookie).toMatch(/; HttpOnly(?:;|$)/);
      expect(/; Secure(?:;|$)/.test(cookie)).toBe(secure);
      expect(cookie).toMatch(/; SameSite=Lax(?:;|$)/);
      expect(cookie).toMatch(/; Path=\/(?:;|$)/);
      expect(cookie).toMatch(/; Max-Age=600(?:;|$)/);
      expect(new URL(response.headers.location).origin).toBe("https://accounts.google.com");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(routeMocks.saveGoogleOAuthState).toHaveBeenCalledOnce();
    });
  });

  it("requires an active worker before exposing worker or delivery OAuth routes", async () => {
    const anonymousApp = appAs(null);
    const anonymous = await request(anonymousApp).get("/api/google-evidence/connect");
    expect(anonymous.status).toBe(401);

    const inactiveApp = appAs({ id: 17, role: "worker" });
    const inactive = await request(inactiveApp).get("/api/google-evidence/connect");
    expect(inactive.status).toBe(403);
    expect(routeMocks.saveGoogleOAuthState).not.toHaveBeenCalled();

    const adminApp = appAs({ id: 99, role: "admin" });
    const adminWorkerConnect = await request(adminApp).get("/api/google-evidence/connect");
    expect(adminWorkerConnect.status).toBe(403);
  });

  it("rejects unauthenticated access across every Google evidence route before side effects", async () => {
    const app = appAs(null);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const attempts = [
      request(app).get("/api/google-evidence/connect"),
      request(app).get("/api/google-evidence/mail-delivery/status"),
      request(app).get("/api/google-evidence/mail-delivery/connect"),
      request(app).post("/api/google-evidence/mail-delivery/disconnect"),
      request(app).post("/api/google-evidence/disconnect"),
    ];

    for (const attempt of attempts) expect((await attempt).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeMocks.saveGoogleOAuthState).not.toHaveBeenCalled();
    expect(routeMocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(routeMocks.saveGoogleRefreshToken).not.toHaveBeenCalled();
    expect(routeMocks.saveGoogleMailDeliveryConnection).not.toHaveBeenCalled();
    expect(routeMocks.clearGoogleRefreshToken).not.toHaveBeenCalled();
    expect(routeMocks.clearGoogleMailDeliveryConnection).not.toHaveBeenCalled();
    expect(routeMocks.getGoogleMailDeliveryStatus).not.toHaveBeenCalled();
  });

  it.each([
    {
      purpose: "worker evidence",
      user: { id: 17, role: "worker" as const },
      startPath: "/api/google-evidence/connect",
      callbackPath: "/api/google-evidence/callback",
      cookieName: "google_evidence_oauth",
      redirect: "/worker/settings?google=error",
    },
    {
      purpose: "admin mail delivery",
      user: { id: 99, role: "admin" as const },
      startPath: "/api/google-evidence/mail-delivery/connect",
      callbackPath: "/api/google-evidence/mail-delivery/callback",
      cookieName: "google_mail_delivery_oauth",
      redirect: "/settings?gmailDelivery=error",
    },
  ])("clears stale $purpose OAuth cookies when the dashboard session expires", async ({ user, startPath, callbackPath, cookieName, redirect }) => {
    if (user.role === "worker") routeMocks.activeWorkerIds.add(user.id);
    const start = await request(appAs(user)).get(startPath);
    expect(start.status).toBe(302);
    const state = oauthState(start);
    const cookie = oauthCookie(start, cookieName);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const callback = await request(appAs(null)).get(callbackPath)
      .query({ code: "callback-code", state }).set("Cookie", cookie);
    const clearedCookie = (callback.headers["set-cookie"] as string[] | undefined)
      ?.find(value => value.startsWith(`${cookieName}=`));

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(redirect);
    expect(clearedCookie).toMatch(/Expires=/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeMocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(routeMocks.saveGoogleRefreshToken).not.toHaveBeenCalled();
    expect(routeMocks.saveGoogleMailDeliveryConnection).not.toHaveBeenCalled();
  });

  it("disconnects only the authenticated worker's Google connection", async () => {
    routeMocks.activeWorkerIds.add(17);
    const app = appAs({ id: 17, role: "worker" });

    const response = await request(app).post("/api/google-evidence/disconnect")
      .query({ workerId: 18, vaId: 18 });

    expect(response.status).toBe(200);
    expect(routeMocks.clearGoogleRefreshToken).toHaveBeenCalledTimes(1);
    expect(routeMocks.clearGoogleRefreshToken).toHaveBeenCalledWith(17);
    expect(routeMocks.clearGoogleRefreshToken).not.toHaveBeenCalledWith(18);
  });

  it("consumes worker state once and rejects a replay before another code exchange", async () => {
    routeMocks.activeWorkerIds.add(17);
    routeMocks.consumeGoogleOAuthState.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const app = appAs({ id: 17, role: "worker" });
    const start = await request(app).get("/api/google-evidence/connect");
    expect(start.status).toBe(302);
    const state = oauthState(start);
    const cookie = oauthCookie(start, "google_evidence_oauth");
    expect(start.headers["set-cookie"][0]).toMatch(/HttpOnly/i);
    expect(routeMocks.saveGoogleOAuthState).toHaveBeenCalledWith("worker", 17, expect.any(String), expect.any(Number));

    const fetchMock = mockTokenExchange();
    const first = await request(app).get("/api/google-evidence/callback")
      .query({ code: "first-code", state }).set("Cookie", cookie);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("/worker/settings?google=connected");
    expect(routeMocks.saveGoogleRefreshToken).toHaveBeenCalledTimes(1);
    expect(routeMocks.saveGoogleRefreshToken).toHaveBeenCalledWith(17, "mock-refresh-token");

    const replay = await request(app).get("/api/google-evidence/callback")
      .query({ code: "second-code", state }).set("Cookie", cookie);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe("/worker/settings?google=error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routeMocks.saveGoogleRefreshToken).toHaveBeenCalledTimes(1);
    expect(routeMocks.consumeGoogleOAuthState).toHaveBeenCalledTimes(2);
  });

  it("rejects callback state issued to another worker account", async () => {
    routeMocks.activeWorkerIds.add(17);
    routeMocks.activeWorkerIds.add(18);
    const ownerApp = appAs({ id: 17, role: "worker" });
    const start = await request(ownerApp).get("/api/google-evidence/connect");
    const state = oauthState(start);
    const cookie = oauthCookie(start, "google_evidence_oauth");
    const fetchMock = mockTokenExchange();

    const otherWorkerApp = appAs({ id: 18, role: "worker" });
    const callback = await request(otherWorkerApp).get("/api/google-evidence/callback")
      .query({ code: "injected-code", state }).set("Cookie", cookie);

    expect(callback.headers.location).toBe("/worker/settings?google=error");
    expect(routeMocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeMocks.saveGoogleRefreshToken).not.toHaveBeenCalled();
  });

  it("does not expose credential-bearing errors in callback logs or redirects", async () => {
    routeMocks.activeWorkerIds.add(17);
    const app = appAs({ id: 17, role: "worker" });
    const start = await request(app).get("/api/google-evidence/connect");
    const state = oauthState(start);
    const cookie = oauthCookie(start, "google_evidence_oauth");
    const refreshToken = "sentinel-refresh-token";
    const accessToken = "sentinel-access-token";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      refresh_token: refreshToken,
      access_token: accessToken,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    routeMocks.saveGoogleRefreshToken.mockRejectedValue(new Error(`database failure ${refreshToken} ${accessToken}`));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const callback = await request(app).get("/api/google-evidence/callback")
      .query({ code: "valid-code", state }).set("Cookie", cookie);
    const logged = JSON.stringify(errorLog.mock.calls, (_key, value) => value instanceof Error ? value.message : value);
    const output = `${callback.text}\n${callback.headers.location}\n${logged}`;

    expect(callback.headers.location).toBe("/worker/settings?google=error");
    expect(output).not.toContain(refreshToken);
    expect(output).not.toContain(accessToken);
  });

  it("requires a signed cookie and matching state on callback", async () => {
    routeMocks.activeWorkerIds.add(17);
    const app = appAs({ id: 17, role: "worker" });
    const fetchMock = mockTokenExchange();
    const callback = await request(app).get("/api/google-evidence/callback")
      .query({ code: "injected-code", state: "unsigned-state" });

    expect(callback.headers.location).toBe("/worker/settings?google=error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeMocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(routeMocks.saveGoogleRefreshToken).not.toHaveBeenCalled();
  });
});
