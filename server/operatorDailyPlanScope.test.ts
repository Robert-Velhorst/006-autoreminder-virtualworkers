import { describe, expect, it } from "vitest";
import {
  assertOperatorDailyPlanReferencesInScope,
  OperatorDailyPlanScopeError,
  type OperatorDailyPlanPayload,
} from "./operatorDailyPlan";

const plan: OperatorDailyPlanPayload = {
  version: 2,
  dateKey: "2026-09-25",
  generatedAt: "2026-09-25T08:00:00.000Z",
  blocks: [{
    id: "block-1",
    startTime: "09:00",
    endTime: "09:30",
    cardId: "own-card",
    cardName: "Own task",
    cardUrl: null,
    boardName: "Board",
    listName: "TO DO",
    action: "Check the cited record",
    stepIds: [10],
    priority: "HIGH",
    score: 70,
    state: "NEW",
    status: "planned",
    notes: "",
    flags: [],
  }],
  robertItems: [],
  unscheduledCards: [],
  planHealth: { confidence: 60, scheduledMinutes: 30, availableMinutes: 540, overlaps: 0, gaps: 510 },
  constraints: { startTime: "09:00", endTime: "18:00", breaks: [] },
  auditTrail: [],
};

describe("operator daily-plan reference ownership", () => {
  it("accepts cards and steps belonging to the requesting worker", () => {
    expect(() => assertOperatorDailyPlanReferencesInScope(
      plan,
      new Set(["own-card"]),
      new Map([[10, "own-card"]]),
    )).not.toThrow();
  });

  it("rejects a card reference outside the worker queue", () => {
    const foreignCardPlan = { ...plan, blocks: [{ ...plan.blocks[0], cardId: "other-card" }] };
    expect(() => assertOperatorDailyPlanReferencesInScope(
      foreignCardPlan,
      new Set(["own-card"]),
      new Map([[10, "own-card"]]),
    )).toThrow(OperatorDailyPlanScopeError);
  });

  it("rejects a foreign or mismatched step even when the card is owned", () => {
    const foreignStepPlan = { ...plan, blocks: [{ ...plan.blocks[0], stepIds: [20] }] };
    expect(() => assertOperatorDailyPlanReferencesInScope(
      foreignStepPlan,
      new Set(["own-card"]),
      new Map([[20, "other-card"]]),
    )).toThrow(OperatorDailyPlanScopeError);
  });

  it("checks card references in founder-decision and unscheduled entries too", () => {
    const withForeignDecision = {
      ...plan,
      robertItems: [{ stepId: 20, cardId: "other-card", cardName: "Other task", decision: "Review" }],
    };
    const withForeignUnscheduled = {
      ...plan,
      unscheduledCards: [{ cardId: "other-card", cardName: "Other task", reason: "No time" }],
    };
    const ownedSteps = new Map([[10, "own-card"], [20, "other-card"]]);

    expect(() => assertOperatorDailyPlanReferencesInScope(withForeignDecision, new Set(["own-card"]), ownedSteps))
      .toThrow(OperatorDailyPlanScopeError);
    expect(() => assertOperatorDailyPlanReferencesInScope(withForeignUnscheduled, new Set(["own-card"]), ownedSteps))
      .toThrow(OperatorDailyPlanScopeError);
  });
});
