import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationHistory } from "../drizzle/schema.postgres";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("./db", () => ({ getDb: mocks.getDb }));

import {
  recordFounderDecisionAlertForStep,
  startFounderDecisionAlertWorker,
  stopFounderDecisionAlertWorker,
} from "./founderDecisionAlerts";

function queryBuilder(result: unknown): any {
  const builder: any = {
    from: vi.fn(() => builder),
    groupBy: vi.fn(() => builder),
    as: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    for: vi.fn(() => builder),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

describe("founder decision alert delivery lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retires the stale due-soon alert after the overdue transition even when that admin has disabled in-app alerts", async () => {
    const now = new Date("2026-09-26T12:00:00.000Z");
    const updateQuery = queryBuilder(undefined);
    const where = vi.fn(() => updateQuery);
    const set = vi.fn(() => updateQuery);
    updateQuery.where = where;
    const update = vi.fn(() => ({ set }));
    const insert = vi.fn(() => ({ values: vi.fn(() => queryBuilder(undefined)) }));
    const selectResults = [
      [{ id: 41, title: "Review the source" }],
      [{ id: 73, dueAt: new Date("2026-09-26T11:59:00.000Z") }],
      [{ id: 9, openId: "admin-9" }],
      [{ mode: "disabled", enabled: 0 }],
    ];
    const select = vi.fn(() => queryBuilder(selectResults.shift()));
    const tx = { select, update, insert };
    mocks.getDb.mockResolvedValue({ transaction: vi.fn(async callback => callback(tx)) });

    const created = await recordFounderDecisionAlertForStep(41, now);

    expect(created).toBe(0);
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(notificationHistory);
    expect(set).toHaveBeenCalledWith({ isRead: 1, readAt: now });
    expect(insert).not.toHaveBeenCalled();
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[3]);
    expect(where).toHaveBeenCalledOnce();
  });

  it("rescans on worker startup and retries after a transient database failure", async () => {
    vi.useFakeTimers();
    vi.stubEnv("FOUNDER_DECISION_ALERTS_ENABLED", "true");
    const db = { select: vi.fn(() => queryBuilder([])) };
    mocks.getDb.mockRejectedValueOnce(new Error("temporary database outage")).mockResolvedValue(db);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      startFounderDecisionAlertWorker();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.getDb).toHaveBeenCalledOnce();
      expect(db.select).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mocks.getDb).toHaveBeenCalledTimes(2);
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      stopFounderDecisionAlertWorker();
      logged.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});
