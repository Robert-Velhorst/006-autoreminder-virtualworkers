import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createPool: vi.fn(), drizzle: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { constructor(...args: unknown[]) { return mocks.createPool(...args); } } }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); vi.restoreAllMocks(); });
describe("lazy database lifecycle", () => {
  it("does not confuse a configured but unavailable pool with a missing user", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/never_connect");
    mocks.createPool.mockImplementationOnce(() => { throw new Error("private-driver-failure"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = await import("./db");
    await expect(db.getUserByOpenId("fixture")).rejects.toMatchObject({ name: "DatabaseUnavailableError" });
  }, 20_000);
  it("creates one lazy pool, closes once, and supports reinitialization without migrations", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://unused:unused@localhost/never_connect");
    const pool = { on: vi.fn(), end: mocks.end.mockResolvedValue(undefined) };
    mocks.createPool.mockReturnValue(pool);
    mocks.drizzle.mockReturnValue({ identity: "db" });
    const db = await import("./db");
    const results = await Promise.all([db.getDb(), db.getDb()]);
    expect(results[0]).toBe(results[1]);
    expect(mocks.createPool).toHaveBeenCalledTimes(1);
    await Promise.all([db.closeDb(), db.closeDb()]);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    await db.getDb();
    expect(mocks.createPool).toHaveBeenCalledTimes(2);
    await db.closeDb();
  });
  it("does not create a pool without a URL or for unsupported SQLite", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const db = await import("./db");
    expect(await db.getDb()).toBeNull();
    vi.stubEnv("DATABASE_URL", "sqlite://unused");
    expect(await db.getDb()).toBeNull();
    expect(mocks.createPool).not.toHaveBeenCalled();
  });
  it("does not expose credentials when pool creation fails", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/never_connect");
    const error = Object.assign(new Error("postgresql://admin:private-password@db/dashboard"), {
      sqlMessage: "private-query-data",
    });
    mocks.createPool.mockImplementationOnce(() => { throw error; });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = await import("./db");
    expect(await db.getDb()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat()).not.toContain(error);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-password");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-query-data");
  });
  it("closes a partially initialized pool without logging its driver error", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/never_connect");
    const error = new Error("private-schema-driver-data");
    mocks.createPool.mockReturnValueOnce({ on: vi.fn(), end: mocks.end.mockResolvedValue(undefined) });
    mocks.drizzle.mockImplementationOnce(() => { throw error; });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = await import("./db");
    expect(await db.getDb()).toBeNull();
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat()).not.toContain(error);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-schema-driver-data");
  });
  it("preserves an upsert failure without logging user or query data", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/never_connect");
    const error = Object.assign(new Error("fixture-private-user@example.test"), {
      sql: "private-insert-query",
      parameters: ["private-driver-token"],
    });
    mocks.createPool.mockReturnValueOnce({ on: vi.fn(), end: mocks.end.mockResolvedValue(undefined) });
    mocks.drizzle.mockReturnValueOnce({
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockRejectedValue(error),
      }) }),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await import("./db");
    await expect(db.upsertUser({ openId: "private-fixture-user" })).rejects.toBe(error);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls.flat()).not.toContain(error);
    for (const value of ["fixture-private-user@example.test", "private-insert-query", "private-driver-token"]) {
      expect(JSON.stringify(logged.mock.calls)).not.toContain(value);
    }
    await db.closeDb();
  });
});
