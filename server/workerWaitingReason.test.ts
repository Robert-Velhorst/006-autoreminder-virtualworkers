import { describe, expect, it } from "vitest";
import { bindWaitingReasonToOwnedCard, interpretWaitingReasonForWorker } from "./workerWaitingReason";

describe("worker waiting reason personalization", () => {
  const nowMs = new Date("2026-07-30T09:00:00.000Z").getTime();

  it("binds stored task identity to the worker-owned card rather than request labels", () => {
    const bound = bindWaitingReasonToOwnedCard({
      cardId: "foreign-card",
      cardName: "Forged task",
      cardUrl: "https://example.invalid/forged",
      boardName: "Forged board",
      listName: "DONE",
    }, {
      cardId: "owned-card",
      cardName: "Assigned task",
      cardUrl: "https://trello.com/c/owned-card",
      boardName: "Assigned board",
      listName: "TO DO",
    });

    expect(bound).toMatchObject({
      cardId: "owned-card",
      cardName: "Assigned task",
      cardUrl: "https://trello.com/c/owned-card",
      boardName: "Assigned board",
      listName: "TO DO",
    });
  });

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
