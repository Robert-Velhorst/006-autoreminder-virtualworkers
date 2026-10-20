import { describe, expect, it, vi } from "vitest";
import {
  managerQueueEventHash,
  queueEnqueued,
  queueClaimed,
  queueFinished,
  queueFailed,
  queueRetryDelay,
  retryQueueTransaction,
  type QueueState,
} from "./aptlssManagerQueue";

const now = new Date("2026-09-05T10:00:00Z");
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
  it.each([1213, 1205])(
    "retries rolled-back queue transactions for MySQL %s",
    async errno => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ cause: { errno } })
        .mockResolvedValue("committed");
      expect(await retryQueueTransaction(operation)).toBe("committed");
      expect(operation).toHaveBeenCalledTimes(2);
    }
  );
  it("bounds transaction retries and never retries ambiguous connection failures", async () => {
    const deadlock = vi.fn().mockRejectedValue({ code: "ER_LOCK_DEADLOCK" });
    await expect(retryQueueTransaction(deadlock)).rejects.toEqual({
      code: "ER_LOCK_DEADLOCK",
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
