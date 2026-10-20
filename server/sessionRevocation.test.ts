import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { COOKIE_NAME } from "../shared/const";

const mocks = vi.hoisted(() => ({
  isSessionRevoked: vi.fn(),
  getUserByOpenId: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock("./db", () => mocks);

const originalEnvironment = { ...process.env };
let sdk: typeof import("./_core/sdk")["sdk"];

beforeEach(async () => {
  process.env.JWT_SECRET = "test-session-secret-with-at-least-32-characters";
  delete process.env.LOCAL_AUTH_BYPASS;
  mocks.isSessionRevoked.mockReset();
  mocks.getUserByOpenId.mockReset();
  mocks.upsertUser.mockReset();
  ({ sdk } = await import("./_core/sdk"));
});

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
});

describe("session revocation", () => {
  it("rejects a valid signed cookie after its session id has been revoked", async () => {
    const token = await sdk.createSessionToken("worker-1", { name: "Worker", expiresInMs: 60_000 });
    const session = await sdk.verifySession(token);
    expect(session).not.toBeNull();
    mocks.isSessionRevoked.mockResolvedValue(true);
    const request = {
      protocol: "https",
      hostname: "dashboard.example",
      headers: { cookie: `${COOKIE_NAME}=${token}` },
      socket: { remoteAddress: "203.0.113.10" },
    } as unknown as Request;

    await expect(sdk.authenticateRequest(request)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.isSessionRevoked).toHaveBeenCalledWith(session!.sessionId);
    expect(mocks.getUserByOpenId).not.toHaveBeenCalled();
  });

  it("continues authentication for an unrevoked session", async () => {
    const token = await sdk.createSessionToken("worker-1", { name: "Worker", expiresInMs: 60_000 });
    const user = {
      id: 1,
      openId: "worker-1",
      name: "Worker",
      email: null,
      loginMethod: "local",
      role: "worker",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };
    mocks.isSessionRevoked.mockResolvedValue(false);
    mocks.getUserByOpenId.mockResolvedValue(user);
    const request = {
      protocol: "https",
      hostname: "dashboard.example",
      headers: { cookie: `${COOKIE_NAME}=${token}` },
      socket: { remoteAddress: "203.0.113.10" },
    } as unknown as Request;

    await expect(sdk.authenticateRequest(request)).resolves.toEqual(user);
    expect(mocks.isSessionRevoked).toHaveBeenCalledOnce();
  });
});
