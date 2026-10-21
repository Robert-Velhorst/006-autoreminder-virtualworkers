import type { Request } from "express";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../shared/const";
import { users, vaProfiles } from "../drizzle/schema.postgres";
import { isSessionEpoch } from "./_core/sessionIdentity";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), revoked: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb, isSessionRevoked: mocks.revoked }));
vi.mock("./_core/env", () => ({ ENV: { cookieSecret: "synthetic-session-lifecycle-secret-at-least32", oAuthServerUrl: "", appId: "" } }));
import { sdk } from "./_core/sdk";

const secret = "synthetic-session-lifecycle-secret-at-least32";
let account: Record<string, unknown> | undefined;
let profiles: Array<{ id: number; status: string }>;
let lock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", secret);
  vi.stubEnv("SESSION_APP_ID", "va-dashboard");
  vi.stubEnv("LOCAL_AUTH_BYPASS", "false");
  account = { id: 7, openId: "worker", name: "Worker", role: "worker", sessionEpoch: "0" };
  profiles = [{ id: 21, status: "active" }];
  lock = vi.fn();
  const tx = { select: () => {
    let table: unknown;
    const query: any = {
      from: (source: unknown) => { table = source; return query; },
      where: () => query, limit: () => query, orderBy: () => query,
      for: (strength: string) => { lock(strength); return query; },
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(table === users ? account ? [account] : [] : table === vaProfiles ? profiles : []).then(resolve, reject),
    };
    return query;
  } };
  mocks.getDb.mockReset().mockResolvedValue({ select: tx.select, transaction: async (run: (tx: unknown) => unknown) => run(tx) });
  mocks.revoked.mockReset().mockResolvedValue(false);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function request(token: string) {
  return { headers: { cookie: `${COOKIE_NAME}=${token}` }, socket: {}, hostname: "dashboard.example" } as Request;
}
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({ openId: "worker", appId: "va-dashboard", name: "Worker", ...claims })
    .setProtectedHeader({ alg: "HS256" }).setJti("synthetic-jti").setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

describe("central worker session lifecycle", () => {
  it("preserves legacy sessions only on the original epoch-zero identity", async () => {
    const legacy = await token();
    await expect(sdk.authenticateRequest(request(legacy))).resolves.toBe(account);
    account = { ...account, id: 8, sessionEpoch: "1" };
    await expect(sdk.authenticateRequest(request(legacy))).rejects.toMatchObject({ statusCode: 403 });
  });
  it("binds new sessions to immutable UID and epoch and locks identity while signing", async () => {
    const signed = await sdk.createSessionToken("worker", { name: "Worker" });
    await expect(sdk.verifySession(signed)).resolves.toMatchObject({ userId: 7, sessionEpoch: "0" });
    expect(lock).toHaveBeenCalledWith("share");
    account = { ...account, sessionEpoch: "1" };
    await expect(sdk.authenticateRequest(request(signed))).rejects.toMatchObject({ statusCode: 403 });
    account = { ...account, id: 8, sessionEpoch: "0" };
    await expect(sdk.authenticateRequest(request(signed))).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each([[], [{ id: 21, status: "inactive" }], [{ id: 21, status: "on_leave" }],
    [{ id: 21, status: "active" }, { id: 22, status: "active" }]].map(rows => [rows]))(
    "denies minting and authentication without one canonical active profile (%j)", async rows => {
      profiles = rows;
      await expect(sdk.createSessionToken("worker", { name: "Worker" })).rejects.toMatchObject({ statusCode: 403 });
      await expect(sdk.authenticateRequest(request(await token()))).rejects.toMatchObject({ statusCode: 403 });
    });
  it("cannot revive old cookies by reactivating the profile", async () => {
    const signed = await sdk.createSessionToken("worker", { name: "Worker" });
    profiles[0].status = "inactive";
    account!.sessionEpoch = "1";
    await expect(sdk.authenticateRequest(request(signed))).rejects.toMatchObject({ statusCode: 403 });
    profiles[0].status = "active";
    account!.sessionEpoch = "2";
    await expect(sdk.authenticateRequest(request(signed))).rejects.toMatchObject({ statusCode: 403 });
    const fresh = await sdk.createSessionToken("worker", { name: "Worker" });
    await expect(sdk.authenticateRequest(request(fresh))).resolves.toBe(account);
  });
  it("rejects a stale pre-password-verification identity instead of signing its new epoch", async () => {
    account!.sessionEpoch = "1";
    await expect(sdk.createSessionToken("worker", { name: "Worker", expectedIdentity: { userId: 7, sessionEpoch: "0" } }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
  it("does not resurrect a missing account via OAuth", async () => {
    account = undefined;
    const oauth = vi.spyOn(sdk, "getUserInfoWithJwt");
    await expect(sdk.authenticateRequest(request(await token()))).rejects.toMatchObject({ statusCode: 403 });
    await expect(sdk.createSessionToken("worker", { name: "Worker" })).rejects.toMatchObject({ statusCode: 403 });
    expect(oauth).not.toHaveBeenCalled();
  });
  it("preserves administrator access without worker profiles and individual logout revocations", async () => {
    account!.role = "admin"; profiles = [];
    const signed = await sdk.createSessionToken("worker", { name: "Admin" });
    await expect(sdk.authenticateRequest(request(signed))).resolves.toBe(account);
    mocks.revoked.mockResolvedValue(true);
    await expect(sdk.authenticateRequest(request(signed))).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each([{ userId: 7 }, { sessionEpoch: "0" }, { userId: "7", sessionEpoch: "0" },
    { userId: 7, sessionEpoch: 0 }, { userId: 7, sessionEpoch: "00" }, { userId: 7, sessionEpoch: "-1" },
    { userId: 7, sessionEpoch: "9223372036854775808" }, { userId: null, sessionEpoch: null }])(
    "does not downgrade malformed new identity claims to legacy (%j)", async claims => {
      await expect(sdk.verifySession(await token(claims))).resolves.toBeNull();
    });
  it("fails closed when identity storage is unavailable", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(sdk.authenticateRequest(request(await token()))).rejects.toMatchObject({ name: "DatabaseUnavailableError" });
  });
  it("requires canonical, bounded bigint strings without JSON bigint values", () => {
    for (const value of ["0", "1", "9223372036854775807"]) expect(isSessionEpoch(value)).toBe(true);
    for (const value of [0, 1n, "01", "-1", "1.0", "9223372036854775808", " 1"]) expect(isSessionEpoch(value)).toBe(false);
  });
  it("applies the same active-worker boundary to nonproduction loopback bypass", async () => {
    vi.stubEnv("LOCAL_AUTH_BYPASS", "true"); vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOCAL_AUTH_BYPASS_OPEN_ID", "worker");
    profiles = [];
    const local = { headers: {}, socket: { remoteAddress: "127.0.0.1" }, hostname: "localhost" } as Request;
    await expect(sdk.authenticateRequest(local)).rejects.toMatchObject({ statusCode: 403 });
    account!.role = "admin";
    await expect(sdk.authenticateRequest(local)).resolves.toBe(account);
  });
  it("never honors local bypass in production even if startup validation were bypassed", async () => {
    vi.stubEnv("LOCAL_AUTH_BYPASS", "true"); vi.stubEnv("NODE_ENV", "production");
    account!.role = "admin";
    const local = { headers: {}, socket: { remoteAddress: "127.0.0.1" }, hostname: "localhost" } as Request;
    await expect(sdk.authenticateRequest(local)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
