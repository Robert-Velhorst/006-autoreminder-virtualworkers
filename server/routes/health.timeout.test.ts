import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ isDatabaseReachable: vi.fn() }));
vi.mock("../services/redis", () => ({ isRedisAvailable: () => true }));
import {
  createBoundedHealthProbe,
  createHealthRouter,
  HEALTH_PROBE_TIMEOUT_MS,
} from "./health";

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded health dependency probes", () => {
  it("bounds a never-settling probe and retains only one underlying call and timer", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const dependency = vi.fn(() => new Promise<boolean>(() => {}));
    const probe = createBoundedHealthProbe(dependency);
    const first = probe();
    expect(probe()).toBe(first);
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - 1);
    expect(dependency).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    expect(timer.mock.results[0].value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe(false);
    for (let i = 0; i < 100; i++) {
      expect(probe()).toBe(first);
      expect(await probe()).toBe(false);
    }
    expect(dependency).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(timer).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "clears the timer after early settlement with %s and starts a fresh probe",
    async healthy => {
      vi.useFakeTimers();
      const dependency = vi
        .fn()
        .mockResolvedValueOnce(healthy)
        .mockResolvedValueOnce(true);
      const probe = createBoundedHealthProbe(dependency);
      expect(await probe()).toBe(healthy);
      expect(vi.getTimerCount()).toBe(0);
      expect(await probe()).toBe(true);
      expect(dependency).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("cleans up rejection and synchronous throw without caching a failed probe", async () => {
    vi.useFakeTimers();
    const failure = new Error("private driver detail");
    const dependency = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValueOnce(true);
    const probe = createBoundedHealthProbe(dependency);
    await expect(probe()).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    await expect(probe()).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    expect(await probe()).toBe(true);
  });

  it.each(["resolve", "reject"] as const)(
    "recovers after a timed-out underlying call eventually %ss",
    async outcome => {
      vi.useFakeTimers();
      const underlying = deferred();
      const dependency = vi
        .fn()
        .mockReturnValueOnce(underlying.promise)
        .mockResolvedValueOnce(true);
      const probe = createBoundedHealthProbe(dependency);
      const expired = probe();
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);
      expect(await expired).toBe(false);
      if (outcome === "resolve") underlying.resolve(true);
      else underlying.reject(new Error("late private failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await expired).toBe(false);
      expect(await probe()).toBe(true);
      expect(dependency).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([0, -1, NaN, Infinity, HEALTH_PROBE_TIMEOUT_MS + 1])(
    "rejects invalid timeout %s",
    timeout => {
      expect(() => createBoundedHealthProbe(vi.fn(), timeout)).toThrow(
        "Health probe timeout"
      );
    }
  );
});

describe("health router timeout responses", () => {
  it("answers liveness before pending health/readiness settle without starting another dependency call", async () => {
    const underlying = deferred();
    const dependency = vi.fn(() => underlying.promise);
    let entered = 0;
    let markEntered!: () => void;
    const bothEntered = new Promise<void>(resolve => {
      markEntered = resolve;
    });
    const app = express();
    app.use((req, _res, next) => {
      next();
      if (req.path !== "/health/live" && ++entered === 2) markEntered();
    });
    app.use("/health", createHealthRouter({ databaseProbe: dependency }));
    let completed = 0;
    const health = request(app)
      .get("/health")
      .then(response => {
        completed++;
        return response;
      });
    const ready = request(app)
      .get("/health/ready")
      .then(response => {
        completed++;
        return response;
      });
    try {
      await bothEntered;
      const live = await request(app).get("/health/live").timeout(2000);
      expect(live.status).toBe(200);
      expect(live.body.alive).toBe(true);
      expect(completed).toBe(0);
      expect(dependency).toHaveBeenCalledOnce();
    } finally {
      underlying.resolve(true);
      const responses = await Promise.all([health, ready]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
    }
  });

  it("shares a hung dependency across health/readiness, keeps liveness available and recovers", async () => {
    const underlying = deferred();
    const dependency = vi
      .fn()
      .mockReturnValueOnce(underlying.promise)
      .mockResolvedValue(true);
    const app = express().use(
      "/health",
      createHealthRouter({ databaseProbe: dependency, timeoutMs: 20 })
    );
    const [health, ready, live] = await Promise.all([
      request(app).get("/health").timeout(2000),
      request(app).get("/health/ready").timeout(2000),
      request(app).get("/health/live").timeout(2000),
    ]);
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({
      status: "unhealthy",
      database: "disconnected",
    });
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({
      ready: false,
      reason: "Database not available",
    });
    expect(live.status).toBe(200);
    expect(live.body.alive).toBe(true);
    expect(dependency).toHaveBeenCalledOnce();
    expect((await request(app).get("/health/ready")).status).toBe(503);
    expect(dependency).toHaveBeenCalledOnce();
    underlying.resolve(true);
    await underlying.promise;
    const recovered = await request(app).get("/health/ready");
    expect(recovered.status).toBe(200);
    expect(recovered.body.ready).toBe(true);
    expect(dependency).toHaveBeenCalledTimes(2);
  });

  it("preserves sanitized rejection bodies and logs, without caching the error", async () => {
    const failure = new Error("postgres://private:password@internal-db/app");
    const dependency = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express().use(
      "/health",
      createHealthRouter({ databaseProbe: dependency })
    );
    const health = await request(app).get("/health");
    const ready = await request(app).get("/health/ready");
    expect(health.status).toBe(503);
    expect(health.body.error).toBe("Health check failed");
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({
      ready: false,
      reason: "Readiness check failed",
    });
    expect(log.mock.calls).toEqual([
      ["[Health] Health check failed"],
      ["[Health] Readiness check failed"],
    ]);
    expect(
      JSON.stringify([health.body, ready.body, log.mock.calls])
    ).not.toMatch(/password|internal-db/);
    expect((await request(app).get("/health/ready")).status).toBe(200);
  });
});
