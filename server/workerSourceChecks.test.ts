import { describe, expect, it } from "vitest";
import { assessWorkerSourceChecks, type WorkerSourceCheckInput } from "../shared/workerSourceChecks";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function input(overrides: Partial<WorkerSourceCheckInput> = {}): WorkerSourceCheckInput {
  return {
    sources: [{ key: "trello", count: 1 }, { key: "gmail", count: 1 }],
    trelloCache: { cachedAt: "2026-09-23T11:55:00Z", expiresAt: "2026-09-23T12:05:00Z" },
    gmail: { enabled: true, lastSyncedAt: "2026-09-23T11:40:00Z", intervalMinutes: 30 },
    drive: null,
    googleConnectionReady: true,
    now: NOW,
    ...overrides,
  };
}

describe("assessWorkerSourceChecks", () => {
  it("distinguishes a valid Trello cache from the last successful worker Gmail sync", () => {
    const checks = assessWorkerSourceChecks(input()).checks;
    expect(checks.map(check => [check.key, check.status])).toEqual([["trello", "current"], ["gmail", "current"]]);
    expect(checks[0].checkedLabel).toBe("Cached copy saved");
    expect(checks[1].checkedLabel).toBe("Worker account last synced");
  });

  it("marks an expired Trello copy overdue even when the saved timestamp is recent", () => {
    const { checks } = assessWorkerSourceChecks(input({
      trelloCache: { cachedAt: "2026-09-23T11:50:00Z", expiresAt: "2026-09-23T11:55:00Z" },
    }));
    expect(checks[0].status).toBe("overdue");
    expect(checks[0].nextAction).toContain("original Trello card");
  });

  it("marks a Trello copy overdue at the exact expiry instant", () => {
    const { checks } = assessWorkerSourceChecks(input({
      trelloCache: { cachedAt: "2026-09-23T11:55:00Z", expiresAt: "2026-09-23T12:00:00Z" },
    }));

    expect(checks[0].status).toBe("overdue");
  });

  it("does not claim a successful Google check from linked evidence alone", () => {
    const { checks } = assessWorkerSourceChecks(input({ gmail: null, trelloCache: null }));
    expect(checks.map(check => check.status)).toEqual(["unknown", "unknown"]);
    expect(checks[1].checkedAt).toBeNull();
  });

  it("flags an overdue or disabled connector while retaining its last successful time", () => {
    const overdue = assessWorkerSourceChecks(input({
      gmail: { enabled: true, lastSyncedAt: "2026-09-23T10:00:00Z", intervalMinutes: 30 },
    })).checks[1];
    const disabled = assessWorkerSourceChecks(input({
      gmail: { enabled: false, lastSyncedAt: "2026-09-23T11:40:00Z", intervalMinutes: 30 },
    })).checks[1];
    expect(overdue.status).toBe("overdue");
    expect(disabled.status).toBe("disabled");
    expect(disabled.checkedAt).toBe("2026-09-23T11:40:00.000Z");
  });

  it("does not use a fresh sync from one Google provider to satisfy another linked provider", () => {
    const driveRequired = assessWorkerSourceChecks(input({
      sources: [{ key: "google_drive", count: 1 }],
      gmail: { enabled: true, lastSyncedAt: "2026-09-23T11:55:00Z", intervalMinutes: 30 },
      drive: { enabled: true, lastSyncedAt: "2026-09-23T10:00:00Z", intervalMinutes: 30 },
    })).checks.find(check => check.key === "google_drive");
    const gmailRequired = assessWorkerSourceChecks(input({
      sources: [{ key: "gmail", count: 1 }],
      gmail: { enabled: true, lastSyncedAt: "2026-09-23T10:00:00Z", intervalMinutes: 30 },
      drive: { enabled: true, lastSyncedAt: "2026-09-23T11:55:00Z", intervalMinutes: 30 },
    })).checks.find(check => check.key === "gmail");

    expect(driveRequired).toMatchObject({
      status: "overdue",
      checkedAt: "2026-09-23T10:00:00.000Z",
    });
    expect(gmailRequired).toMatchObject({
      status: "overdue",
      checkedAt: "2026-09-23T10:00:00.000Z",
    });
  });

  it("does not report a recent sync as currently usable after the Google connection is lost", () => {
    const gmail = assessWorkerSourceChecks(input({ googleConnectionReady: false })).checks[1];
    expect(gmail.status).toBe("disconnected");
    expect(gmail.checkedAt).toBe("2026-09-23T11:40:00.000Z");
    expect(gmail.nextAction).toContain("original email");
  });

  it.each(["gmail", "google_drive"] as const)("does not mark %s current when Google connection readiness is unknown", key => {
    const check = assessWorkerSourceChecks(input({
      sources: [{ key, count: 1 }],
      gmail: key === "gmail"
        ? { enabled: true, lastSyncedAt: "2026-09-23T11:55:00Z", intervalMinutes: 30 }
        : null,
      drive: key === "google_drive"
        ? { enabled: true, lastSyncedAt: "2026-09-23T11:55:00Z", intervalMinutes: 30 }
        : null,
      googleConnectionReady: null,
    })).checks.find(item => item.key === key);

    expect(check).toMatchObject({
      status: "unknown",
      checkedAt: "2026-09-23T11:55:00.000Z",
    });
    expect(check?.nextAction).toContain(key === "gmail" ? "original email" : "original file");
  });

  it("does not trust a Trello cache whose expiry predates its saved copy", () => {
    const trello = assessWorkerSourceChecks(input({
      trelloCache: { cachedAt: "2026-09-23T11:55:00Z", expiresAt: "2026-09-23T11:54:00Z" },
    })).checks[0];
    expect(trello.status).toBe("unknown");
  });

  it("reports missing task links without treating every unlinked provider as a failure", () => {
    const result = assessWorkerSourceChecks(input({ sources: [{ key: "trello", count: 1 }] }));
    expect(result.checks).toHaveLength(1);
    expect(result.coverageGap).toContain("No email, file or conversation");
  });

  it("rejects a future sync timestamp and provides a manual check for messages", () => {
    const result = assessWorkerSourceChecks(input({
      sources: [{ key: "communication", count: 2 }, { key: "gmail", count: 1 }],
      gmail: { enabled: true, lastSyncedAt: "2026-09-24T12:00:00Z", intervalMinutes: 30 },
    }));
    expect(result.checks.find(check => check.key === "gmail")?.status).toBe("unknown");
    expect(result.checks.find(check => check.key === "communication")?.nextAction).toContain("linked conversation");
    expect(result.coverageGap).toBeNull();
  });
});
