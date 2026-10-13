import { describe, expect, it } from "vitest";
import { describeWorkerIntegrationSync } from "../shared/workerIntegrationStatus";

describe("worker integration sync status", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");

  it("distinguishes paused and never-synced sources", () => {
    expect(describeWorkerIntegrationSync({ enabled: false, intervalMinutes: 60, lastSyncedAt: null, lastError: null }, now).label)
      .toBe("Paused");
    expect(describeWorkerIntegrationSync({ enabled: true, intervalMinutes: 60, lastSyncedAt: null, lastError: null }, now).label)
      .toBe("Never synced");
  });

  it("keeps a failed sync visible even when an older successful sync exists", () => {
    expect(describeWorkerIntegrationSync({
      enabled: true,
      intervalMinutes: 60,
      lastSyncedAt: "2026-09-25T11:55:00.000Z",
      lastError: "Google access was rejected. Reconnect the Google credentials.",
    }, now)).toEqual({
      label: "Needs attention",
      detail: "Google access was rejected. Reconnect the Google credentials.",
      tone: "critical",
    });
  });

  it("reports due and current syncs from each source's own interval", () => {
    expect(describeWorkerIntegrationSync({
      enabled: true, intervalMinutes: 30, lastSyncedAt: "2026-09-25T11:29:59.000Z", lastError: null,
    }, now).label).toBe("Check due");
    expect(describeWorkerIntegrationSync({
      enabled: true, intervalMinutes: 60, lastSyncedAt: "2026-09-25T11:30:00.000Z", lastError: null,
    }, now).label).toBe("Up to date");
  });

  it("does not call malformed or future timestamps fresh", () => {
    for (const lastSyncedAt of ["not-a-date", "2026-09-25T12:10:00.000Z"]) {
      expect(describeWorkerIntegrationSync({
        enabled: true, intervalMinutes: 60, lastSyncedAt, lastError: null,
      }, now).label).toBe("Time unknown");
    }
  });
});
