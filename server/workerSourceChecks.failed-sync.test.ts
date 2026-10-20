import { describe, expect, it } from "vitest";
import { assessWorkerSourceChecks } from "../shared/workerSourceChecks";
import { managerActionNeedsSourceVerification } from "./timerAccess";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const LAST_SUCCESS = new Date(NOW - 30_000).toISOString();
const FAILED_SYNC = "The latest sync failed.";

const googleSources = [
  { key: "gmail", label: "Gmail", action: "Open the original email" },
  { key: "google_drive", label: "Drive", action: "Open the original file" },
] as const;

describe("required Google source sync failures", () => {
  it.each(googleSources)("does not treat a failed $label sync as current", ({ key, action }) => {
    const provider = {
      enabled: true,
      lastSyncedAt: LAST_SUCCESS,
      intervalMinutes: 30,
      lastError: FAILED_SYNC,
    };
    const sourceInput = {
      sources: [{ key, count: 1 }],
      trelloCache: null,
      gmail: key === "gmail" ? provider : null,
      drive: key === "google_drive" ? provider : null,
      googleConnectionReady: true,
      now: NOW,
    };

    const check = assessWorkerSourceChecks(sourceInput).checks.find(item => item.key === key);
    expect(check).toMatchObject({ status: "unknown", checkedAt: LAST_SUCCESS });
    expect(check?.nextAction).toContain(action);

    expect(managerActionNeedsSourceVerification({
      sourceKeys: [key],
      hasUnverifiedEvidence: false,
      assessedAt: NOW - 10_000,
    }, {
      trelloCache: null,
      gmail: sourceInput.gmail,
      drive: sourceInput.drive,
      googleConnectionReady: true,
      now: NOW,
    })).toBe(true);
  });

  it("keeps Gmail-linked work blocked while a source conflict awaits review", () => {
    const gmail = {
      enabled: true,
      lastSyncedAt: LAST_SUCCESS,
      intervalMinutes: 30,
      lastError: null,
      sourceConflictPending: true,
    };
    const check = assessWorkerSourceChecks({
      sources: [{ key: "gmail", count: 1 }],
      trelloCache: null,
      gmail,
      drive: null,
      googleConnectionReady: true,
      now: NOW,
    }).checks.find(item => item.key === "gmail");

    expect(check).toMatchObject({ status: "unknown", checkedAt: LAST_SUCCESS });
    expect(check?.nextAction).toContain("Open the original email");
    expect(managerActionNeedsSourceVerification({
      sourceKeys: ["gmail"],
      hasUnverifiedEvidence: false,
      assessedAt: NOW - 10_000,
    }, {
      trelloCache: null,
      gmail,
      drive: null,
      googleConnectionReady: true,
      now: NOW,
    })).toBe(true);
  });

  it.each(googleSources)("keeps $label work blocked while Google connection readiness is unknown", ({ key }) => {
    const provider = {
      enabled: true,
      lastSyncedAt: LAST_SUCCESS,
      intervalMinutes: 30,
      lastError: null,
    };

    expect(managerActionNeedsSourceVerification({
      sourceKeys: [key],
      hasUnverifiedEvidence: false,
      assessedAt: NOW - 10_000,
    }, {
      trelloCache: null,
      gmail: key === "gmail" ? provider : null,
      drive: key === "google_drive" ? provider : null,
      googleConnectionReady: null,
      now: NOW,
    })).toBe(true);
  });

  it.each(googleSources)("allows a fresh $label sync after its prior error is cleared", ({ key }) => {
    const provider = {
      enabled: true,
      lastSyncedAt: LAST_SUCCESS,
      intervalMinutes: 30,
      lastError: null,
    };
    const check = assessWorkerSourceChecks({
      sources: [{ key, count: 1 }],
      trelloCache: null,
      gmail: key === "gmail" ? provider : null,
      drive: key === "google_drive" ? provider : null,
      googleConnectionReady: true,
      now: NOW,
    }).checks.find(item => item.key === key);

    expect(check).toMatchObject({ status: "current", checkedAt: LAST_SUCCESS, nextAction: null });
  });
});
