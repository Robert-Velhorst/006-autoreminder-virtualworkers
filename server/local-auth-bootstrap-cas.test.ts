import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { users } from "../drizzle/schema.postgres";
import { COOKIE_NAME, ONE_YEAR_MS } from "../shared/const";
import { DATABASE_UNAVAILABLE_MESSAGE } from "./databaseAvailability";
import { PASSWORD_MIN_LENGTH } from "./passwordPolicy";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), createSessionToken: vi.fn(), hash: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./_core/sdk", () => ({ sdk: { createSessionToken: mocks.createSessionToken } }));
vi.mock("bcryptjs", () => ({ default: { hash: mocks.hash } }));
import localAuthRoutes from "./routes/local-auth";

const owner = { id: 71, openId: "synthetic-owner", name: "Synthetic Owner" };
const token = "synthetic-owner-bootstrap-token-24-plus";
const password = "synthetic-long-password";
const endpoint = "/api/auth/owner-bootstrap";
const app = express().use(express.json()).use("/api/auth", localAuthRoutes);

function database(returnedRows: Array<{ id: number }> = [{ id: owner.id }]) {
  const returning = vi.fn().mockResolvedValue(returnedRows);
  const whereUpdate = vi.fn((_condition: SQL) => ({ returning }));
  const set = vi.fn(() => ({ where: whereUpdate }));
  const update = vi.fn(() => ({ set }));
  const limit = vi.fn().mockResolvedValue([owner]);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));
  return { select, update, set, whereUpdate, returning, limit };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OWNER_BOOTSTRAP_OPEN_ID", owner.openId);
  vi.stubEnv("OWNER_BOOTSTRAP_TOKEN", token);
  mocks.hash.mockResolvedValue("synthetic-password-hash");
  mocks.createSessionToken.mockResolvedValue("synthetic-session");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function expectNoSession(response: { headers: Record<string, unknown> }) {
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(mocks.createSessionToken).not.toHaveBeenCalled();
}

describe("one-time owner bootstrap compare-and-set", () => {
  it("issues a session only after exactly one pending owner was updated", async () => {
    const db = database();
    mocks.getDb.mockResolvedValue(db);
    const response = await request(app).post(endpoint).send({ token, password });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, message: "Owner access configured" });
    expect(db.update).toHaveBeenCalledWith(users);
    expect(db.set).toHaveBeenCalledWith({ passwordHash: "synthetic-password-hash", loginMethod: "local", lastSignedIn: expect.any(Date) });
    const condition = new PgDialect().sqlToQuery(db.whereUpdate.mock.calls[0][0]);
    expect(condition.sql).toContain('"users"."id" = $1');
    expect(condition.sql).toContain('"users"."passwordHash" is null');
    expect(condition.params).toEqual([owner.id]);
    expect(db.returning).toHaveBeenCalledWith({ id: users.id });
    expect(mocks.hash).toHaveBeenCalledWith(password, 12);
    expect(mocks.createSessionToken).toHaveBeenCalledWith(owner.openId, { name: owner.name, expiresInMs: ONE_YEAR_MS });
    expect(db.returning.mock.invocationCallOrder[0]).toBeLessThan(mocks.createSessionToken.mock.invocationCallOrder[0]);
    expect(response.headers["set-cookie"]).toEqual([expect.stringContaining(`${COOKIE_NAME}=synthetic-session`)]);
  });

  it.each(["another request set the password", "owner was deleted"])("refuses a session when %s after lookup", async () => {
    const db = database([]);
    mocks.getDb.mockResolvedValue(db);
    const response = await request(app).post(endpoint).send({ token, password });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Owner setup is no longer available. No session was created." });
    expect(db.returning).toHaveBeenCalledOnce();
    expectNoSession(response);
  });

  it("rejects an unexpected multirow update instead of treating it as a winner", async () => {
    mocks.getDb.mockResolvedValue(database([{ id: 71 }, { id: 72 }]));
    const response = await request(app).post(endpoint).send({ token, password });
    expect(response.status).toBe(409);
    expectNoSession(response);
  });

  it("allows only one of two requests that both observed the passwordless owner to obtain a session", async () => {
    const db = database();
    let releaseLookups!: () => void;
    const bothLookedUp = new Promise<void>(resolve => { releaseLookups = resolve; });
    let lookups = 0;
    db.limit.mockImplementation(async () => {
      if (++lookups === 2) releaseLookups();
      await bothLookedUp;
      return [owner];
    });
    db.returning.mockResolvedValueOnce([{ id: owner.id }]).mockResolvedValueOnce([]);
    mocks.getDb.mockResolvedValue(db);
    const responses = await Promise.all([
      request(app).post(endpoint).send({ token, password }),
      request(app).post(endpoint).send({ token, password: `${password}-different` }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(db.returning).toHaveBeenCalledTimes(2);
    expect(mocks.createSessionToken).toHaveBeenCalledOnce();
    expect(responses.find(response => response.status === 409)!.headers["set-cookie"]).toBeUndefined();
    expect(responses.find(response => response.status === 200)!.headers["set-cookie"]).toHaveLength(1);
  });

  it("preserves password validation errors before any database lookup", async () => {
    const response = await request(app).post(endpoint).send({ token, password: "short" });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expectNoSession(response);
  });

  it.each(["wrong token", "missing owner", "disabled setup"])("preserves forbidden response for %s", async reason => {
    const db = database();
    if (reason === "missing owner") db.limit.mockResolvedValue([]);
    if (reason === "disabled setup") vi.stubEnv("OWNER_BOOTSTRAP_TOKEN", "");
    mocks.getDb.mockResolvedValue(db);
    const response = await request(app).post(endpoint).send({ token: reason === "wrong token" ? "wrong" : token, password });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Owner setup is unavailable or the setup token is invalid" });
    expect(db.update).not.toHaveBeenCalled();
    expectNoSession(response);
  });

  it.each(["lookup", "update connection", "update query"])("preserves database-unavailable errors during %s", async stage => {
    const db = database();
    mocks.getDb.mockResolvedValue(db);
    if (stage === "lookup") mocks.getDb.mockResolvedValue(null);
    if (stage === "update connection") mocks.getDb.mockResolvedValueOnce(db).mockResolvedValueOnce(null);
    if (stage === "update query") db.returning.mockRejectedValue(Object.assign(new Error("private-driver-detail"), { code: "ECONNRESET" }));
    const response = await request(app).post(endpoint).send({ token, password });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: DATABASE_UNAVAILABLE_MESSAGE });
    expect(response.headers["retry-after"]).toBe("5");
    expectNoSession(response);
  });

  it.each(["update", "session"])("preserves sanitized failure response when %s fails", async stage => {
    const db = database();
    mocks.getDb.mockResolvedValue(db);
    const failure = new Error("private-driver-or-signing-detail");
    if (stage === "update") db.returning.mockRejectedValue(failure);
    else mocks.createSessionToken.mockRejectedValue(failure);
    const response = await request(app).post(endpoint).send({ token, password });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Owner setup failed" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    if (stage === "update") expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });
});
