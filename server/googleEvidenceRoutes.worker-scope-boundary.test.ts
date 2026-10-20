import { googlePkceChallenge } from "./googleEvidenceRoutes";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
  requireActiveWorkerProfile: mocks.requireActiveWorkerProfile,
}));

vi.mock("./googleEvidence", () => ({
  clearGoogleMailDeliveryConnection: mocks.clearGoogleMailDeliveryConnection,
  clearGoogleRefreshToken: mocks.clearGoogleRefreshToken,
  consumeGoogleOAuthState: mocks.consumeGoogleOAuthState,
  getGoogleMailDeliveryStatus: mocks.getGoogleMailDeliveryStatus,
  saveGoogleOAuthState: mocks.saveGoogleOAuthState,
  saveGoogleMailDeliveryConnection: mocks.saveGoogleMailDeliveryConnection,
  saveGoogleRefreshToken: mocks.saveGoogleRefreshToken,
}));

import googleEvidenceRoutes from "./googleEvidenceRoutes";

type TestUser = { id: number; role: string };

const originalEnv = {
  jwtSecret: process.env.JWT_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  publicUrl: process.env.PUBLIC_URL,
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL,
  trelloWebhookCallbackUrl: process.env.TRELLO_WEBHOOK_CALLBACK_URL,
  nodeEnv: process.env.NODE_ENV,
};

function appAs(user: TestUser | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, { user });
    next();
  });
  app.use("/api/google-evidence", googleEvidenceRoutes);
  return app;
}

function cookieFrom(response: request.Response, name: string) {
  const values = response.headers["set-cookie"] as string[] | undefined;
  const value = values?.find(cookie => cookie.startsWith(`${name}=`));
  if (!value) throw new Error(`Expected ${name} cookie`);
  return value.split(";", 1)[0];
}

function stateFrom(response: request.Response) {
  const location = response.headers.location;
  if (!location) throw new Error("Expected an OAuth redirect");
  const state = new URL(location).searchParams.get("state");
  if (!state) throw new Error("Expected signed OAuth state");
  return state;
}

function cookiePayload<T>(cookie: string): T {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  const payload = value.split(".", 1)[0];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}

function mockGoogleFetch(userInfo = { email: "owner@example.test", email_verified: true }) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return new Response(JSON.stringify(userInfo), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mocks.activeWorkerIds.clear();
  mocks.requireActiveWorkerProfile.mockImplementation((req: Request & { user?: TestUser | null }, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role === "worker" && !mocks.activeWorkerIds.has(req.user.id)) {
      return res.status(403).json({ error: "An active worker profile is required" });
    }
    next();
  });
  mocks.clearGoogleMailDeliveryConnection.mockReset().mockResolvedValue(undefined);
  mocks.clearGoogleRefreshToken.mockReset().mockResolvedValue(undefined);
  mocks.consumeGoogleOAuthState.mockReset().mockResolvedValue(true);
  mocks.getGoogleMailDeliveryStatus.mockReset().mockResolvedValue({ connected: false });
  mocks.saveGoogleOAuthState.mockReset().mockResolvedValue(undefined);
  mocks.saveGoogleMailDeliveryConnection.mockReset().mockResolvedValue(undefined);
  mocks.saveGoogleRefreshToken.mockReset().mockResolvedValue(undefined);
  process.env.JWT_SECRET = "worker-boundary-test-secret-long-enough-to-sign";
  process.env.GOOGLE_CLIENT_ID = "mock-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "mock-google-client-secret";
  process.env.PUBLIC_URL = "https://dashboard.example.test";
  delete process.env.WEBHOOK_BASE_URL;
  delete process.env.TRELLO_WEBHOOK_CALLBACK_URL;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  for (const [key, value] of Object.entries({
    JWT_SECRET: originalEnv.jwtSecret,
    GOOGLE_CLIENT_ID: originalEnv.googleClientId,
    GOOGLE_CLIENT_SECRET: originalEnv.googleClientSecret,
    PUBLIC_URL: originalEnv.publicUrl,
    WEBHOOK_BASE_URL: originalEnv.webhookBaseUrl,
    TRELLO_WEBHOOK_CALLBACK_URL: originalEnv.trelloWebhookCallbackUrl,
    NODE_ENV: originalEnv.nodeEnv,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google evidence route worker-scope boundary", () => {
  it("denies anonymous, inactive-worker, and wrong-role access without Google side effects", async () => {
    const fetchMock = mockGoogleFetch();
    const anonymous = appAs(null);
    for (const response of [
      await request(anonymous).get("/api/google-evidence/connect"),
      await request(anonymous).post("/api/google-evidence/disconnect"),
      await request(anonymous).get("/api/google-evidence/mail-delivery/status"),
      await request(anonymous).get("/api/google-evidence/mail-delivery/connect"),
      await request(anonymous).post("/api/google-evidence/mail-delivery/disconnect"),
    ]) expect(response.status).toBe(401);

    const anonymousCallback = await request(anonymous).get("/api/google-evidence/callback")
      .query({ code: "injected-code", state: "forged" });
    const anonymousMailCallback = await request(anonymous).get("/api/google-evidence/mail-delivery/callback")
      .query({ code: "injected-code", state: "forged" });
    expect(anonymousCallback.headers.location).toBe("/worker/settings?google=error");
    expect(anonymousMailCallback.headers.location).toBe("/settings?gmailDelivery=error");

    const inactiveWorker = await request(appAs({ id: 17, role: "worker" }))
      .get("/api/google-evidence/connect");
    expect(inactiveWorker.status).toBe(403);

    const admin = appAs({ id: 99, role: "admin" });
    expect((await request(admin).get("/api/google-evidence/connect")).status).toBe(403);
    expect((await request(admin).post("/api/google-evidence/disconnect")).status).toBe(403);

    const worker = appAs({ id: 17, role: "worker" });
    mocks.activeWorkerIds.add(17);
    expect((await request(worker).get("/api/google-evidence/mail-delivery/status")).status).toBe(403);
    expect((await request(worker).get("/api/google-evidence/mail-delivery/connect")).status).toBe(403);
    expect((await request(worker).post("/api/google-evidence/mail-delivery/disconnect")).status).toBe(403);
    const wrongRoleMailCallback = await request(worker).get("/api/google-evidence/mail-delivery/callback")
      .query({ code: "injected-code", state: "forged" });
    expect(wrongRoleMailCallback.headers.location).toBe("/settings?gmailDelivery=error");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.saveGoogleOAuthState).not.toHaveBeenCalled();
    expect(mocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(mocks.saveGoogleRefreshToken).not.toHaveBeenCalled();
    expect(mocks.saveGoogleMailDeliveryConnection).not.toHaveBeenCalled();
    expect(mocks.clearGoogleRefreshToken).not.toHaveBeenCalled();
    expect(mocks.clearGoogleMailDeliveryConnection).not.toHaveBeenCalled();
    expect(mocks.getGoogleMailDeliveryStatus).not.toHaveBeenCalled();
  });

  it("requires a configured callback origin in production instead of trusting request headers", async () => {
    mocks.activeWorkerIds.add(17);
    delete process.env.PUBLIC_URL;
    process.env.NODE_ENV = "production";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await request(appAs({ id: 17, role: "worker" }))
      .get("/api/google-evidence/connect")
      .set("Host", "attacker.example")
      .set("X-Forwarded-Host", "attacker.example")
      .set("X-Forwarded-Proto", "http");

    expect(response.status).toBe(500);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(mocks.saveGoogleOAuthState).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith("[GoogleEvidence] Unable to start OAuth");
  });

  it("disconnects only the authenticated worker even when another worker ID is supplied", async () => {
    mocks.activeWorkerIds.add(17);
    const response = await request(appAs({ id: 17, role: "worker" }))
      .post("/api/google-evidence/disconnect")
      .query({ workerId: 18, vaId: 18, userId: 18 })
      .send({ workerId: 18, vaId: 18, userId: 18 });

    expect(response.status).toBe(200);
    expect(mocks.clearGoogleRefreshToken).toHaveBeenCalledTimes(1);
    expect(mocks.clearGoogleRefreshToken).toHaveBeenCalledWith(17);
    expect(mocks.clearGoogleRefreshToken).not.toHaveBeenCalledWith(18);
  });

  it("binds worker OAuth state, PKCE exchange, and token persistence to the initiating worker", async () => {
    mocks.activeWorkerIds.add(17);
    mocks.activeWorkerIds.add(18);
    mocks.consumeGoogleOAuthState.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const start = await request(appAs({ id: 17, role: "worker" }))
      .get("/api/google-evidence/connect")
      .query({ workerId: 18, vaId: 18, userId: 18 })
      .set("Host", "attacker.example")
      .set("X-Forwarded-Host", "attacker.example")
      .set("X-Forwarded-Proto", "http");
    expect(start.status).toBe(302);
    const state = stateFrom(start);
    const cookie = cookieFrom(start, "google_evidence_oauth");
    const payload = cookiePayload<{ vaId: number; state: string; nonce: string; expiresAt: number; codeVerifier: string }>(cookie);
    expect(payload.vaId).toBe(17);
    expect(payload.state).toBe(state);
    expect(payload.codeVerifier).toBeTruthy();
    const authorization = new URL(start.headers.location);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://dashboard.example.test/api/google-evidence/callback",
    );
    expect(authorization.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ].sort());
    expect(authorization.searchParams.has("include_granted_scopes")).toBe(false);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(
      googlePkceChallenge(payload.codeVerifier),
    );
    expect(mocks.saveGoogleOAuthState).toHaveBeenCalledWith("worker", 17, payload.nonce, payload.expiresAt);

    const fetchMock = mockGoogleFetch();
    const ownerApp = appAs({ id: 17, role: "worker" });
    const wrongRoleCallback = await request(appAs({ id: 99, role: "admin" }))
      .get("/api/google-evidence/callback")
      .query({ code: "injected-code", state })
      .set("Cookie", cookie);
    expect(wrongRoleCallback.headers.location).toBe("/worker/settings?google=error");
    expect(mocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const [encodedState, signature] = state.split(".");
    const tamperedState = `${encodedState}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const tamperedCallback = await request(ownerApp).get("/api/google-evidence/callback")
      .query({ code: "injected-code", state: tamperedState })
      .set("Cookie", cookie);
    expect(tamperedCallback.headers.location).toBe("/worker/settings?google=error");
    expect(mocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const crossWorkerCallback = await request(appAs({ id: 18, role: "worker" }))
      .get("/api/google-evidence/callback")
      .query({ code: "injected-code", state })
      .set("Cookie", cookie);
    expect(crossWorkerCallback.headers.location).toBe("/worker/settings?google=error");
    expect(mocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.saveGoogleRefreshToken).not.toHaveBeenCalled();

    const ownerCallback = await request(ownerApp).get("/api/google-evidence/callback")
      .query({ code: "owner-code", state })
      .set("Cookie", cookie)
      .set("Host", "attacker.example")
      .set("X-Forwarded-Host", "attacker.example")
      .set("X-Forwarded-Proto", "http");
    expect(ownerCallback.headers.location).toBe("/worker/settings?google=connected");
    expect(mocks.consumeGoogleOAuthState).toHaveBeenCalledTimes(1);
    expect(mocks.consumeGoogleOAuthState).toHaveBeenCalledWith("worker", 17, payload.nonce, payload.expiresAt);
    expect(mocks.saveGoogleRefreshToken).toHaveBeenCalledTimes(1);
    expect(mocks.saveGoogleRefreshToken).toHaveBeenCalledWith(17, "mock-refresh-token");

    const tokenRequest = fetchMock.mock.calls[0];
    expect(String(tokenRequest[0])).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String((tokenRequest[1] as RequestInit).body));
    expect(body.get("code")).toBe("owner-code");
    expect(body.get("redirect_uri")).toBe("https://dashboard.example.test/api/google-evidence/callback");
    expect(body.get("code_verifier")).toBe(payload.codeVerifier);

    const replay = await request(ownerApp).get("/api/google-evidence/callback")
      .query({ code: "replay-code", state })
      .set("Cookie", cookie);
    expect(replay.headers.location).toBe("/worker/settings?google=error");
    expect(mocks.consumeGoogleOAuthState).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.saveGoogleRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("keeps delivery status and OAuth connection admin-only and binds callbacks to that admin", async () => {
    mocks.activeWorkerIds.add(17);
    const workerStatus = await request(appAs({ id: 17, role: "worker" }))
      .get("/api/google-evidence/mail-delivery/status");
    expect(workerStatus.status).toBe(403);
    expect(mocks.getGoogleMailDeliveryStatus).not.toHaveBeenCalled();

    const adminApp = appAs({ id: 99, role: "admin" });
    const status = await request(adminApp).get("/api/google-evidence/mail-delivery/status");
    expect(status.status).toBe(200);
    expect(mocks.getGoogleMailDeliveryStatus).toHaveBeenCalledTimes(1);

    const start = await request(adminApp).get("/api/google-evidence/mail-delivery/connect")
      .query({ userId: 100 })
      .set("Host", "attacker.example")
      .set("X-Forwarded-Host", "attacker.example")
      .set("X-Forwarded-Proto", "http");
    expect(start.status).toBe(302);
    const state = stateFrom(start);
    const cookie = cookieFrom(start, "google_mail_delivery_oauth");
    const payload = cookiePayload<{ userId: number; state: string; nonce: string; expiresAt: number }>(cookie);
    expect(payload.userId).toBe(99);
    expect(payload.state).toBe(state);
    const authorization = new URL(start.headers.location);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://dashboard.example.test/api/google-evidence/mail-delivery/callback",
    );
    expect(authorization.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "https://www.googleapis.com/auth/gmail.send",
      "openid",
    ].sort());
    expect(authorization.searchParams.has("include_granted_scopes")).toBe(false);
    expect(mocks.saveGoogleOAuthState).toHaveBeenCalledWith("mail-delivery", 99, payload.nonce, payload.expiresAt);

    const fetchMock = mockGoogleFetch();
    const workerCallback = await request(appAs({ id: 17, role: "worker" }))
      .get("/api/google-evidence/mail-delivery/callback")
      .query({ code: "injected-code", state })
      .set("Cookie", cookie);
    expect(workerCallback.headers.location).toBe("/settings?gmailDelivery=error");
    expect(mocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const otherAdminCallback = await request(appAs({ id: 100, role: "admin" }))
      .get("/api/google-evidence/mail-delivery/callback")
      .query({ code: "injected-code", state })
      .set("Cookie", cookie);
    expect(otherAdminCallback.headers.location).toBe("/settings?gmailDelivery=error");
    expect(mocks.consumeGoogleOAuthState).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.saveGoogleMailDeliveryConnection).not.toHaveBeenCalled();

    const ownerCallback = await request(adminApp).get("/api/google-evidence/mail-delivery/callback")
      .query({ code: "owner-code", state })
      .set("Cookie", cookie)
      .set("Host", "attacker.example")
      .set("X-Forwarded-Host", "attacker.example")
      .set("X-Forwarded-Proto", "http");
    expect(ownerCallback.headers.location).toBe("/settings?gmailDelivery=connected");
    expect(mocks.consumeGoogleOAuthState).toHaveBeenCalledWith("mail-delivery", 99, payload.nonce, payload.expiresAt);
    expect(mocks.saveGoogleMailDeliveryConnection).toHaveBeenCalledWith("mock-refresh-token", "owner@example.test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const userInfoRequest = fetchMock.mock.calls.find(([input]) =>
      String(input) === "https://openidconnect.googleapis.com/v1/userinfo",
    );
    expect(userInfoRequest?.[1]?.method ?? "GET").toBe("GET");
    expect(new Headers(userInfoRequest?.[1]?.headers).get("authorization")).toBe("Bearer mock-access-token");
    expect(`${ownerCallback.text}\n${ownerCallback.headers.location}`).not.toContain("mock-refresh-token");
    expect(`${ownerCallback.text}\n${ownerCallback.headers.location}`).not.toContain("mock-access-token");
  });

  it("does not save the Gmail send credential when Google does not verify the account email", async () => {
    const adminApp = appAs({ id: 99, role: "admin" });
    const start = await request(adminApp).get("/api/google-evidence/mail-delivery/connect");
    const state = stateFrom(start);
    const cookie = cookieFrom(start, "google_mail_delivery_oauth");
    mockGoogleFetch({ email: "unverified@example.test", email_verified: false });

    const callback = await request(adminApp).get("/api/google-evidence/mail-delivery/callback")
      .query({ code: "owner-code", state })
      .set("Cookie", cookie);

    expect(callback.headers.location).toBe("/settings?gmailDelivery=error");
    expect(mocks.saveGoogleMailDeliveryConnection).not.toHaveBeenCalled();
  });
});

 it("uses the RFC7636 S256 vector and rejects noncanonical PKCE values", () => {
  expect(googlePkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  for (const nonce of ["password", "!".repeat(64), "_".repeat(43), "a".repeat(129)]) {
    expect(() => googlePkceChallenge(nonce)).toThrow("Invalid PKCE nonce");
  }
});
