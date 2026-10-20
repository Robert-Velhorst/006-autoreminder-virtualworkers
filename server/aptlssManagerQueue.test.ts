import { afterEach, describe, expect, it, vi } from "vitest";
import {
  managerQueueEventHash,
  queueEnqueued,
  queueClaimed,
  queueFinished,
  queueFailed,
  queueRetryDelay,
  retryQueueTransaction,
  type QueueState,
  createManagerQueueRunner,
  type ManagerQueueDatabase,
} from "./aptlssManagerQueue";

const now = new Date("2026-09-05T10:00:00Z");

describe("manager queue loop observations", () => {
  let runner: ReturnType<typeof createManagerQueueRunner> | undefined;
  afterEach(async () => { await runner?.stop(); runner = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); });
  const setup = () => {
    vi.stubEnv("APTLSS_MANAGER_PILOT_WORKER_IDS", "2");
    vi.stubEnv("APTLSS_MANAGER_SHADOW_ONLY", "true");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const failures = { poll: false, fallback: false };
    const select = () => {
      const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain,
        leftJoin: () => chain, limit: () => chain, for: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve([]).then(resolve, reject),
      };
      return chain;
    };
    const db = {
      select: () => { if (failures.fallback) throw new Error("private fallback failure"); return select(); },
      transaction: async (work: any) => {
        if (failures.poll) throw new Error("private poll failure");
        return work({ select, execute: async () => ({ rows: [{ nowMs: Date.now() }] }) });
      },
    } as unknown as ManagerQueueDatabase;
    runner = createManagerQueueRunner({ db, execute: vi.fn(), concurrency: 1 });
    return failures;
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  it("does not equate configured or one-off checks with a running loop", async () => {
    setup();
    expect(runner!.getStatus()).toMatchObject({ started: false, healthy: false, observed: false });
    await runner!.drain();
    expect(runner!.getStatus()).toMatchObject({ started: false, healthy: false, observed: false });
    await runner!.pollFallback();
    expect(runner!.getStatus()).toMatchObject({ started: false, observed: true });
  });
  it("requires successful queue and fallback reads and expires stale observations", async () => {
    setup(); runner!.start(); await settle();
    expect(runner!.getStatus()).toMatchObject({ started: true, healthy: true, failed: false, observed: true });
    vi.setSystemTime(new Date(now.getTime() + 10_001));
    expect(runner!.getStatus().healthy).toBe(false);
    await runner!.drain();
    expect(runner!.getStatus().healthy).toBe(true);
    vi.setSystemTime(new Date(now.getTime() + 120_001)); await runner!.drain();
    expect(runner!.getStatus().healthy).toBe(false);
    await runner!.pollFallback();
    expect(runner!.getStatus().healthy).toBe(true);
    await runner!.stop(); expect(runner!.getStatus().started).toBe(false);
  });
  it("does not let a successful poll hide a failed fallback, and recovers after both succeed", async () => {
    const failures = setup(); runner!.start(); await settle();
    failures.fallback = true;
    await expect(runner!.pollFallback()).rejects.toThrow(); await runner!.drain();
    expect(runner!.getStatus()).toMatchObject({ healthy: false, failed: true });
    failures.fallback = false; await runner!.pollFallback();
    expect(runner!.getStatus()).toMatchObject({ healthy: true, failed: false });
    failures.poll = true; await runner!.drain();
    expect(runner!.getStatus()).toMatchObject({ healthy: false, failed: true });
    await runner!.pollFallback(); expect(runner!.getStatus().failed).toBe(true);
    failures.poll = false; await runner!.drain();
    expect(runner!.getStatus()).toMatchObject({ healthy: true, failed: false });
  });
  it("does not accept future-dated observations after clock rollback", async () => {
    setup(); runner!.start(); await settle();
    vi.setSystemTime(new Date(now.getTime() - 1));
    expect(runner!.getStatus().healthy).toBe(false);
  });
});
const state = (patch: Partial<QueueState> = {}): QueueState => ({
  state: "idle",
  generation: 0,
  claimedGeneration: 0,
  priority: 0,
  trigger: "periodic",
  availableAt: now,
  requestedAt: now,
  attempts: 0,
  leaseToken: null,
  leaseUntil: null,
  lastError: null,
  completedAt: null,
  ...patch,
});

describe("durable manager queue transitions", () => {
  it.each(["40P01", "40001", "55P03"])(
    "retries rolled-back queue transactions for PostgreSQL %s",
    async code => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ cause: { code } })
        .mockResolvedValue("committed");
      expect(await retryQueueTransaction(operation)).toBe("committed");
      expect(operation).toHaveBeenCalledTimes(2);
    }
  );
  it("bounds transaction retries and never retries ambiguous connection failures", async () => {
    const deadlock = vi.fn().mockRejectedValue({ code: "40P01" });
    await expect(retryQueueTransaction(deadlock)).rejects.toEqual({
      code: "40P01",
    });
    expect(deadlock).toHaveBeenCalledTimes(3);
    const disconnected = vi.fn().mockRejectedValue({ code: "ECONNRESET" });
    await expect(retryQueueTransaction(disconnected)).rejects.toEqual({
      code: "ECONNRESET",
    });
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
  it("hashes event identities without retaining provider content and isolates workers", () => {
    expect(managerQueueEventHash(1, "source_ingested", "revision:abc")).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(managerQueueEventHash(1, "source_ingested", "revision:abc")).toBe(
      managerQueueEventHash(1, "source_ingested", "revision:abc")
    );
    expect(
      managerQueueEventHash(2, "source_ingested", "revision:abc")
    ).not.toBe(managerQueueEventHash(1, "source_ingested", "revision:abc"));
  });
  it.each([0, -1, 1.2, NaN])("rejects invalid worker identity %s", vaId =>
    expect(() => managerQueueEventHash(vaId, "periodic", "x")).toThrow()
  );
  it("coalesces pending events while preserving the earliest queue age and urgency", () => {
    const first = queueEnqueued(
      state(),
      { trigger: "conflict", urgent: true },
      now
    );
    const next = queueEnqueued(
      first,
      { trigger: "source_ingested" },
      new Date(now.getTime() + 1000)
    );
    expect(next).toMatchObject({
      state: "pending",
      generation: 2,
      priority: 100,
      trigger: "conflict",
      requestedAt: now,
      availableAt: now,
    });
  });
  it("does not lose a dirty generation that arrives while a lease is running", () => {
    const claimed = queueClaimed(
      queueEnqueued(state(), { trigger: "source_ingested" }, now),
      "owner",
      now,
      60000
    );
    const dirty = queueEnqueued(
      claimed,
      { trigger: "worker_update", urgent: true },
      new Date(now.getTime() + 1000)
    );
    expect(dirty).toMatchObject({
      state: "leased",
      leaseToken: "owner",
      generation: 2,
      claimedGeneration: 1,
      priority: 100,
    });
    expect(queueFinished(dirty, now)).toMatchObject({
      state: "pending",
      generation: 2,
      leaseToken: null,
      priority: 100,
    });
  });
  it("resets consumed urgency so ordinary subsequent work cannot inherit it", () => {
    const claimed = queueClaimed(
      queueEnqueued(state(), { trigger: "conflict", urgent: true }, now),
      "owner",
      now,
      60000
    );
    expect(claimed.priority).toBe(100);
    const dirty = queueEnqueued(claimed, { trigger: "source_ingested" }, now);
    expect(queueFinished(dirty, now)).toMatchObject({
      priority: 0,
      trigger: "source_ingested",
      state: "pending",
    });
  });
  it("marks only the claimed generation complete and clears its lease", () => {
    const claimed = queueClaimed(
      queueEnqueued(state(), { trigger: "manual" }, now),
      "owner",
      now,
      60000
    );
    expect(queueFinished(claimed, now)).toMatchObject({
      state: "idle",
      leaseToken: null,
      leaseUntil: null,
      completedAt: now,
      attempts: 0,
    });
  });
  it("retries failure with bounded backoff and a non-sensitive error", () => {
    const claimed = queueClaimed(
      queueEnqueued(state(), { trigger: "manual" }, now),
      "owner",
      now,
      60000
    );
    expect(queueFailed(claimed, now)).toMatchObject({
      state: "pending",
      attempts: 1,
      leaseToken: null,
      lastError: "Manager assessment failed; a retry is scheduled.",
    });
    expect(queueFailed(claimed, now).availableAt.getTime()).toBe(
      now.getTime() + queueRetryDelay(1)
    );
  });
  it("retains urgency when a failed or expired lease has no newer events", () => {
    const claimed = queueClaimed(
      queueEnqueued(state(), { trigger: "conflict", urgent: true }, now),
      "owner",
      now,
      60000
    );
    expect(queueFailed(claimed, now).priority).toBe(100);
  });
  it("retains exhausted jobs visibly rather than deleting or retrying forever", () => {
    const exhausted = queueFailed(
      state({
        state: "leased",
        attempts: 5,
        generation: 1,
        claimedGeneration: 1,
      }),
      now
    );
    expect(exhausted).toMatchObject({ state: "failed", attempts: 5 });
    expect(exhausted.lastError).toMatch(/exhausted/);
  });
  it("a new real event revives an exhausted job and resets attempts", () => {
    expect(
      queueEnqueued(
        state({ state: "failed", attempts: 5 }),
        { trigger: "worker_update" },
        now
      )
    ).toMatchObject({ state: "pending", attempts: 0, generation: 1 });
  });
  it("newer dirty evidence gets a fresh attempt after an older assessment fails", () => {
    expect(
      queueFailed(
        state({
          state: "leased",
          attempts: 5,
          generation: 3,
          claimedGeneration: 2,
          priority: 100,
        }),
        now
      )
    ).toMatchObject({
      state: "pending",
      attempts: 0,
      priority: 100,
      availableAt: now,
    });
  });
  it.each([1, 2, 3, 4, 5, 99])("bounds retry delay for attempt %s", attempt => {
    expect(queueRetryDelay(attempt)).toBeGreaterThanOrEqual(1000);
    expect(queueRetryDelay(attempt)).toBeLessThanOrEqual(300000);
  });
  it("does not mutate the prior durable row", () => {
    const before = state();
    const copy = structuredClone(before);
    queueEnqueued(before, { trigger: "conflict", urgent: true }, now);
    expect(before).toEqual(copy);
  });
});
