import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  createConnection: vi.fn(),
  createPool: vi.fn(),
  drizzle: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({ default: {
  createConnection: driver.createConnection,
  createPool: driver.createPool,
} }));
vi.mock("drizzle-orm/mysql2", () => ({ drizzle: driver.drizzle }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("database initialization lifecycle", () => {
  let connection: { execute: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let pool: { getConnection: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  let database: { name: string };

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "mysql://test:test@127.0.0.1:33316/aptlss_test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    connection = { execute: vi.fn().mockResolvedValue([[], []]), end: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    pool = { getConnection: vi.fn().mockResolvedValue(connection), end: vi.fn().mockResolvedValue(undefined) };
    database = { name: "ready database" };
    driver.createConnection.mockReset().mockResolvedValue(connection);
    driver.createPool.mockReset().mockReturnValue(pool);
    driver.drizzle.mockReset().mockReturnValue(database);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("does not publish a database or create extra pools while initial schema readiness is pending", async () => {
    const blocked = deferred();
    connection.execute.mockImplementationOnce(() => blocked.promise.then(() => [[], []]));
    const { getDb } = await import("./db");
    const first = getDb();
    const second = getDb();
    const third = getDb();
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(driver.drizzle).not.toHaveBeenCalled();
    } finally {
      blocked.resolve();
      await Promise.allSettled([first, second, third]);
    }
    const instances = await Promise.all([first, second, third]);
    expect(instances.every(instance => instance === database)).toBe(true);
    expect(driver.drizzle).toHaveBeenCalledTimes(1);
    expect(driver.createPool).toHaveBeenCalledTimes(1);
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it("shares a failed connection attempt and retries on the next request without caching an unusable database", async () => {
    const failure = Object.assign(new Error("test connection refused"), { code: "ECONNREFUSED" });
    driver.createConnection.mockRejectedValueOnce(failure);
    pool.getConnection.mockRejectedValueOnce(failure);
    const { getDb } = await import("./db");
    expect(await Promise.all([getDb(), getDb()])).toEqual([null, null]);
    expect(driver.drizzle).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(await getDb()).toBe(database);
    expect(driver.createPool).toHaveBeenCalledTimes(2);
    expect(driver.drizzle).toHaveBeenCalledTimes(1);
  });

  it("does not cache partial schema initialization and retries all idempotent statements", async () => {
    connection.execute.mockRejectedValueOnce(new Error("test schema initialization failure"));
    const { getDb } = await import("./db");
    expect(await getDb()).toBeNull();
    expect(driver.drizzle).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(await getDb()).toBe(database);
    expect(connection.execute).toHaveBeenCalledTimes(5);
    expect(driver.drizzle).toHaveBeenCalledTimes(1);
  });

  it("reuses the ready database without repeating migrations or creating new connections", async () => {
    const { getDb } = await import("./db");
    expect(await getDb()).toBe(database);
    expect(await getDb()).toBe(database);
    expect(connection.execute).toHaveBeenCalledTimes(4);
    expect(driver.drizzle).toHaveBeenCalledTimes(1);
    expect(driver.createPool).toHaveBeenCalledTimes(1);
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
  });

  it("does not connect when DATABASE_URL is absent", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { getDb } = await import("./db");
    expect(await getDb()).toBeNull();
    expect(driver.createConnection).not.toHaveBeenCalled();
    expect(driver.createPool).not.toHaveBeenCalled();
    expect(driver.drizzle).not.toHaveBeenCalled();
  });

  it("does not open a MySQL pool for unsupported SQLite configuration", async () => {
    vi.stubEnv("DATABASE_URL", "sqlite://test-only");
    const { getDb } = await import("./db");
    expect(await getDb()).toBeNull();
    expect(driver.createPool).not.toHaveBeenCalled();
    expect(driver.createConnection).not.toHaveBeenCalled();
  });

  it("closes a shared pool once and allows an explicitly requested fresh initialization", async () => {
    const { getDb, closeDb } = await import("./db");
    await getDb();
    await Promise.all([closeDb(), closeDb()]);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(await getDb()).toBe(database);
    expect(driver.createPool).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenCalledTimes(8);
    await closeDb();
    expect(pool.end).toHaveBeenCalledTimes(2);
  });

  it("waits for pending readiness before closing, without leaking the resulting pool", async () => {
    const blocked = deferred();
    connection.execute.mockImplementationOnce(() => blocked.promise.then(() => [[], []]));
    const { getDb, closeDb } = await import("./db");
    const opening = getDb();
    const closing = closeDb();
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(pool.end).not.toHaveBeenCalled();
    } finally { blocked.resolve(); }
    await Promise.all([opening, closing]);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a closing pool for new callers", async () => {
    const { getDb, closeDb } = await import("./db");
    await getDb();
    const blocked = deferred();
    pool.end.mockImplementationOnce(() => blocked.promise);
    const closing = closeDb();
    const reopening = getDb();
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(driver.createPool).toHaveBeenCalledTimes(1);
    } finally { blocked.resolve(); }
    await Promise.all([closing, reopening]);
    expect(driver.createPool).toHaveBeenCalledTimes(2);
    await closeDb();
  });
});
