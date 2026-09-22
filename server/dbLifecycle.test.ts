import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createPool: vi.fn(), drizzle: vi.fn(), end: vi.fn() }));
vi.mock("mysql2/promise", () => ({ default: { createPool: mocks.createPool } }));
vi.mock("drizzle-orm/mysql2", () => ({ drizzle: mocks.drizzle }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });
describe("lazy database lifecycle", () => {
  it("creates one lazy pool, closes once, and supports reinitialization without migrations", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://unused:unused@localhost/never_connect");
    const pool = { end: mocks.end.mockResolvedValue(undefined) };
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
});
