import { describe, expect, it } from "vitest";
import { interpretWaitingReasonForWorker } from "./workerWaitingReason";

describe("worker waiting reason personalization", () => {
  const nowMs = new Date("2026-07-30T09:00:00.000Z").getTime();

  it("treats the current worker name as the internal actor", () => {
    const result = interpretWaitingReasonForWorker(
      "Amina still needs to upload the signed brief.",
      { nowMs },
      { workerName: "Amina", founderName: "Daan", timeZone: "Europe/Amsterdam" },
    );

    expect(result.waitingOn).toBe("worker");
    expect(result.waitingOnName).toBe("Amina");
    expect(result.nextAction).toContain("Amina");
    expect(result.nextAction).not.toContain("Joyce");
  });

  it("maps the worker's founder to the existing approval semantics", () => {
    const result = interpretWaitingReasonForWorker(
      "Waiting for Daan to approve the budget tomorrow.",
      { nowMs },
      { workerName: "Amina", founderName: "Daan", timeZone: "Europe/Amsterdam" },
    );

    expect(result.waitingOn).toBe("robert");
    expect(result.waitingOnName).toBe("Daan");
    expect(result.requiresRobert).toBe(true);
    expect(result.nextAction).toContain("Daan");
    expect(result.nextAction).not.toContain("Robert");
  });

  it("keeps legacy worker names readable without emitting a person-specific actor", () => {
    const result = interpretWaitingReasonForWorker(
      "Joyce still needs to upload the signed brief.",
      { nowMs },
      { workerName: "Amina", founderName: "Daan", timeZone: "Europe/Amsterdam" },
    );

    expect(result.waitingOn).toBe("worker");
    expect(result.waitingOnName).toBe("Amina");
    expect(result.nextAction).toContain("Amina");
    expect(result.nextAction).not.toContain("Joyce");
  });
});
